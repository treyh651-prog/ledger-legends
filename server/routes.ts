import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { Server } from "node:http";
import rateLimit from "express-rate-limit";
import { resolveRunDb, type ResolvedRunDb } from "./db/run-db";
import { schedulerStatus } from "./sched/status";
import type { AuthRuntime } from "./auth/setup";
import { authErrorHandler, refuse } from "./auth/middleware";
import {
  InvitationError,
  createInvitation,
  listInvitations,
  revokeInvitation,
  validateInvitation,
  type InvitationDeps,
} from "./auth/invitations";
import { AuthAdminError } from "./auth/auth-admin";
import type { Pool } from "pg";
import { PostgresEntitlementSource } from "./entitlement";
import { createApiRouter, RunDbEntitlementSource } from "./api/router";
import { apiErrorHandler } from "./api/errors";
import { buildDevActor, devActorEnabled, DEV_ACTOR, DEV_FIRM_ID, DEV_USER_ID, type DevActorRuntime } from "./api/dev-actor";
import { firmMembers } from "./auth/actor-store";
import { createMemoryStorage, createSupabaseStorage, readStorageEnv } from "./storage/document-storage";

/**
 * Routes.
 *
 * Two kinds. Public routes, which carry no actor and say only things that
 * are already public (is auth configured, and with which project URL and
 * anon key). Guarded routes, which sit behind the actor middleware and reach
 * the database only inside withActor.
 *
 * The scheduler status route used to read SCHEDULER_FIRM_ID from the
 * environment because the server had no notion of who was asking. It now has
 * one: the firm is the actor's firm, selected by membership, and the actor
 * is the signed in user. The environment pair is still what the Trigger.dev
 * tasks run as, and is no longer consulted here.
 */

export interface RouteDeps {
  runDb: ResolvedRunDb;
  /** Null when the server runs without auth (memory mode on a developer machine). */
  auth: AuthRuntime | null;
  /** The development actor, when startup decided it is allowed. NOTES 221. */
  devActor?: DevActorRuntime | null;
}

/** Tight limit for routes that do work on behalf of an unauthenticated caller. */
/**
 * serverless-http sets req.ip itself (lib/request.js), from a shape Netlify's
 * event does not carry, so it is always undefined on Netlify even with
 * `trust proxy` set; express-rate-limit's own IP lookup then throws
 * ERR_ERL_UNDEFINED_IP_ADDRESS and, worse, every caller silently shares one
 * bucket rather than being limited per address. X-Forwarded-For is present on
 * every request that reaches a function (Netlify's own edge sets it), so
 * reading it directly sidesteps req.ip entirely. The traditional server path
 * still has a real req.ip from Node, which this falls back to.
 */
function clientKey(req: { ip?: string; headers: Record<string, unknown> }): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : typeof forwarded === "string" ? forwarded.split(",")[0] : null;
  return (first ?? req.ip ?? "unknown").trim();
}

export const publicLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: clientKey,
  message: { error: { code: "rate_limited", message: "Too many requests. Slow down." } },
});

/** Looser limit for the authenticated API. Per address, which is what we have before the token is read. */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: clientKey,
  message: { error: { code: "rate_limited", message: "Too many requests. Slow down." } },
});

const noAuth: RequestHandler = (_req, res) => {
  refuse(res, 503, "auth.unavailable", "This server is running without sign in. Set the Supabase variables to enable it.");
};

export async function registerRoutes(httpServer: Server, app: Express, deps?: RouteDeps): Promise<Server> {
  const runDb = deps?.runDb ?? resolveRunDb();
  const auth = deps?.auth ?? null;
  const devActor =
    deps?.devActor !== undefined
      ? deps.devActor
      : !auth && devActorEnabled(process.env, runDb.kind)
        ? buildDevActor(runDb.db)
        : null;

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // What the browser needs to start a session. Public by design: the anon key
  // is the key Supabase expects browsers to hold, and row level security on
  // the Supabase side is what protects data from it. This server does not use
  // PostgREST, so the anon key reaches no table here.
  app.get("/api/auth/config", publicLimiter, (_req, res) => {
    if (!auth) {
      res.json({
        configured: false,
        reason: devActor
          ? "sign in is off, the development actor answers as the firm owner"
          : "sign in is off, this server runs without Supabase auth",
        developmentActor: devActor !== null,
      });
      return;
    }
    res.json({ configured: true, supabaseUrl: auth.browserConfig.supabaseUrl, anonKey: auth.browserConfig.anonKey });
  });

  app.use("/api", apiLimiter);

  if (!auth && !devActor) {
    app.use("/api", (req, res, next) => {
      if (req.path === "/auth/config") return next();
      noAuth(req, res, next);
    });
    return httpServer;
  }

  if (!auth && devActor) {
    // Memory mode with the development actor. The same guards as production,
    // fed by a token every request is assumed to carry.
    app.use("/api", devActor.assumeToken);
    app.get("/api/auth/me", devActor.middleware.requireUser, (req, res) => {
      const a = req.actor!;
      res.json({ userId: a.userId, email: a.email, displayName: a.displayName, memberships: a.memberships, development: true });
    });
    app.use(
      "/api",
      createApiRouter({
        db: runDb.db,
        guards: devActor.middleware,
        // Memory storage, development only. Bytes vanish with the process and the screens say so.
        storage: createMemoryStorage(),
        entitlements: new RunDbEntitlementSource(runDb.db, DEV_USER_ID, DEV_FIRM_ID),
        members: async () => [{ userId: DEV_USER_ID, displayName: DEV_ACTOR.displayName ?? DEV_ACTOR.email, email: DEV_ACTOR.email, role: "owner" }],
      }),
    );
    app.use("/api", (_req, res) => {
      res.status(404).json({ error: { code: "not_found", message: "No such route." } });
    });
    app.use(authErrorHandler);
    app.use(apiErrorHandler);
    return httpServer;
  }
  if (!auth) return httpServer;

  const { requireUser, requireFirm } = auth.middleware;
  // Supabase Storage when the two values are present; otherwise uploads answer
  // 501 naming the missing settings. Never a memory store against Postgres.
  const storageEnv = readStorageEnv();
  const documentStorage = storageEnv ? createSupabaseStorage(storageEnv) : null;
  console.log(documentStorage ? `document storage: supabase bucket ${documentStorage.bucket}` : "document storage: not configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)");
  const inv: InvitationDeps = { pool: auth.pool, authAdmin: auth.authAdmin, appOrigin: auth.appOrigin, actorOpts: auth.actorOpts };

  app.get("/api/auth/me", requireUser, (req, res) => {
    const a = req.actor!;
    res.json({
      userId: a.userId,
      email: a.email,
      displayName: a.displayName,
      memberships: a.memberships,
    });
  });

  app.use(
    "/api",
    createApiRouter({
      db: runDb.db,
      guards: auth.middleware,
      storage: documentStorage,
      entitlements: new PostgresEntitlementSource(auth.pool as Pool),
      members: (firmId) => firmMembers(auth.pool, firmId),
    }),
  );

  app.get("/api/sched/status", requireFirm, async (req, res, next) => {
    try {
      const status = await schedulerStatus(runDb.db, { firmId: req.firm!.firmId, userId: req.actor!.userId }, new Date());
      res.json({ configured: true, status });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/invitations", requireFirm, async (req, res, next) => {
    try {
      res.json({ invitations: await listInvitations(inv, req.actor!, req.firm!) });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/invitations", requireFirm, async (req, res, next) => {
    try {
      const input = validateInvitation(req.body);
      const out = await createInvitation(inv, req.actor!, req.firm!, input);
      res.status(201).json(out);
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/invitations/:membershipId", requireFirm, async (req, res, next) => {
    try {
      res.json(await revokeInvitation(inv, req.actor!, req.firm!, String(req.params.membershipId)));
    } catch (err) {
      next(err);
    }
  });

  // Anything else under /api that reached here is not a route. Say so in the
  // same shape as everything else, after the guards have had their say.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "No such route." } });
  });

  app.use(authErrorHandler);
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof InvitationError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof AuthAdminError) {
      res.status(502).json({ error: { code: `auth_admin.${err.code}`, message: "The sign in service refused the request." } });
      return;
    }
    next(err);
  });
  app.use(apiErrorHandler);

  return httpServer;
}
