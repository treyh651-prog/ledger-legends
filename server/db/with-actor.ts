/**
 * Actor scoped database access for the interface.
 *
 * Every interface query runs inside a transaction that has told Postgres who
 * the actor is. Migration 0001 reads `app.user_id` through
 * tenancy.current_actor(), and every row level security policy since then is
 * written in terms of that. The runs path (server/runs/db-postgres.ts) sets
 * the same key on its own transactions; this is the equivalent for request
 * handlers, which have a user and no run.
 *
 * Two things to know:
 *
 * 1. `set_config(..., true)` is transaction local. That is what makes this
 *    safe behind the Supabase transaction pooler: the connection goes back to
 *    the pool with nothing left on it.
 *
 * 2. Row level security only applies to roles that do not bypass it. On
 *    Supabase the postgres role has BYPASSRLS, so a server connecting as
 *    postgres runs every policy as a no op. When APP_DB_ROLE is set, the
 *    transaction switches to that role first (`set local role`, also
 *    transaction local), and the policies become real. Migration 0023 makes
 *    app_web usable for this. When APP_DB_ROLE is unset the server logs that
 *    fact once at startup and the API's own membership checks are the only
 *    enforcement.
 */

import type { PgClientLike, PgPoolLike } from "../runs/db-postgres";

export type ActorScope = "firm" | "client";

/** tenancy.memberships.role, constraint mem_role in migration 0001. */
export type ActorRole = "owner" | "manager" | "preparer" | "reviewer" | "client_user" | "read_only";

export const ACTOR_ROLES: readonly ActorRole[] = ["owner", "manager", "preparer", "reviewer", "client_user", "read_only"];

/** Roles a firm scoped membership may carry. */
export const FIRM_ROLES: readonly ActorRole[] = ["owner", "manager", "preparer", "reviewer", "read_only"];

/** Roles a client scoped membership may carry. */
export const CLIENT_ROLES: readonly ActorRole[] = ["client_user", "read_only"];

/** Firm roles allowed to create and revoke invitations. */
export const INVITER_ROLES: readonly ActorRole[] = ["owner", "manager"];

export interface ActorMembership {
  firmId: string;
  firmSlug: string;
  firmName: string;
  clientId: string | null;
  scope: ActorScope;
  role: ActorRole;
}

export interface Actor {
  /** tenancy.users.id */
  userId: string;
  /** auth.users.id from the token `sub` claim */
  authSubject: string;
  email: string;
  displayName: string | null;
  memberships: ActorMembership[];
}

export interface ActorTx {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

export interface WithActorOptions {
  /** Role to `set local role` to at the start of the transaction. */
  dbRole?: string | null;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

export function resolveDbRole(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.APP_DB_ROLE?.trim();
  if (!raw) return null;
  if (!ROLE_NAME.test(raw)) {
    throw new Error(`APP_DB_ROLE must be a plain lowercase identifier, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function wrap(client: PgClientLike): ActorTx {
  return {
    async query<R>(sql: string, params: unknown[] = []): Promise<R[]> {
      const res = await client.query<R>(sql, params);
      return res.rows;
    },
  };
}

/**
 * Run `fn` inside a transaction scoped to `actor`. Commits on success, rolls
 * back on any throw, releases the connection either way.
 */
export async function withActor<T>(
  pool: PgPoolLike,
  actor: Pick<Actor, "userId">,
  fn: (tx: ActorTx) => Promise<T>,
  opts: WithActorOptions = {},
): Promise<T> {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("begin");
    began = true;
    if (opts.dbRole) {
      // Role names cannot be bound as parameters. resolveDbRole validated it.
      await client.query(`set local role ${opts.dbRole}`);
    }
    await client.query("select set_config('app.user_id', $1, true), set_config('app.run_id', '', true)", [
      actor.userId,
    ]);
    const out = await fn(wrap(client));
    await client.query("commit");
    began = false;
    return out;
  } catch (err) {
    if (began) {
      try {
        await client.query("rollback");
      } catch {
        // The original error is the one worth reporting.
      }
    }
    throw err;
  } finally {
    client.release();
  }
}
