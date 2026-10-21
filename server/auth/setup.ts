/**
 * Wires the auth pieces from the process environment.
 *
 * Required when RUN_DB is postgres (the only mode a deployed server runs in):
 *   SUPABASE_URL               project URL
 *   SUPABASE_ANON_KEY          public key, handed to the browser and used for
 *                              the legacy token path
 *   SUPABASE_SERVICE_ROLE_KEY  admin key for invitations, server only
 *   APP_ORIGIN                 where the browser loads the app from, used for
 *                              CORS and for the redirect in invitation emails
 * Optional:
 *   APP_DB_ROLE                role for `set local role` inside actor
 *                              transactions, app_web once 0023 is applied
 *
 * Nothing here reads a value and prints it. Missing values are reported by
 * name only.
 */

import { getPool } from "../db/pool";
import { resolveDbRole, type WithActorOptions } from "../db/with-actor";
import type { PgPoolLike } from "../runs/db-postgres";
import { createPgActorStore, type ActorStore } from "./actor-store";
import { createSupabaseAuthAdmin, readAuthAdminEnv, type AuthAdmin } from "./auth-admin";
import { createActorMiddleware, type ActorMiddleware } from "./middleware";
import { createTokenVerifier, readSupabaseEnv, type TokenVerifier } from "./jwt";

export interface AuthRuntime {
  pool: PgPoolLike;
  verifier: TokenVerifier;
  store: ActorStore;
  authAdmin: AuthAdmin;
  middleware: ActorMiddleware;
  actorOpts: WithActorOptions;
  appOrigin: string;
  /** What the browser needs to start a Supabase session. Public values only. */
  browserConfig: { supabaseUrl: string; anonKey: string };
  /** Human readable lines for the startup log. */
  notes: string[];
}

export function readAppOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.APP_ORIGIN?.trim().replace(/\/+$/, "");
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("APP_ORIGIN must be an absolute http(s) URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("APP_ORIGIN must be an absolute http(s) URL");
  return u.origin;
}

export function buildAuthRuntime(env: NodeJS.ProcessEnv = process.env): AuthRuntime {
  const missing: string[] = [];
  const sb = readSupabaseEnv(env);
  if (!sb) missing.push("SUPABASE_URL", "SUPABASE_ANON_KEY");
  const admin = readAuthAdminEnv(env);
  if (!admin) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  const appOrigin = readAppOrigin(env);
  if (!appOrigin) missing.push("APP_ORIGIN");
  if (!sb || !admin || !appOrigin) {
    throw new Error(`auth is not configured, set ${Array.from(new Set(missing)).join(", ")}`);
  }

  const pool = getPool();
  const dbRole = resolveDbRole(env);
  const actorOpts: WithActorOptions = { dbRole };
  const verifier = createTokenVerifier({ supabaseUrl: sb.supabaseUrl, anonKey: sb.anonKey });
  const store = createPgActorStore(pool);
  const authAdmin = createSupabaseAuthAdmin(admin);
  const middleware = createActorMiddleware({
    verifier,
    store,
    clientFirm: async (clientId) => {
      const client = await pool.connect();
      try {
        const r = await client.query<{ firm_id: string }>(`select firm_id from tenancy.clients where id = $1`, [clientId]);
        return r.rows[0]?.firm_id ?? null;
      } finally {
        client.release();
      }
    },
  });

  const notes = [
    `tokens verified against ${sb.supabaseUrl}/auth/v1 (JWKS, with auth server fallback for HS256 tokens)`,
    dbRole
      ? `actor transactions run as ${dbRole}, row level security applies`
      : "APP_DB_ROLE is not set, actor transactions run as the connection role; if that role bypasses row level security the API's membership checks are the only enforcement",
    `browser origin ${appOrigin}`,
  ];

  return {
    pool,
    verifier,
    store,
    authAdmin,
    middleware,
    actorOpts,
    appOrigin,
    browserConfig: { supabaseUrl: sb.supabaseUrl, anonKey: sb.anonKey },
    notes,
  };
}
