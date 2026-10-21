/**
 * Looks a verified token subject up in tenancy and returns an Actor.
 *
 * This runs before an actor is known, so it cannot use withActor. It runs as
 * the connecting role, reads tenancy.users (no RLS) and tenancy.memberships
 * (RLS, but the connecting role either bypasses it or has the own_memberships
 * policy satisfied once app.user_id is set). To keep it correct under both,
 * the membership read happens inside a transaction that has set app.user_id
 * to the user just found.
 *
 * The interface is small so tests can supply a scripted store.
 */

import type { PgPoolLike } from "../runs/db-postgres";
import type { Actor, ActorMembership, ActorRole, ActorScope } from "../db/with-actor";

export interface ActorStore {
  /** Null when no tenancy.users row has this auth_subject. */
  findByAuthSubject(authSubject: string): Promise<Actor | null>;
  /** Best effort. Throttled by the caller. */
  touchLastSeen(userId: string): Promise<void>;
}

interface UserRow {
  id: string;
  auth_subject: string;
  email: string;
  display_name: string | null;
  disabled_at: string | null;
}

interface MembershipRow {
  firm_id: string;
  firm_slug: string;
  firm_name: string;
  client_id: string | null;
  scope: ActorScope;
  role: ActorRole;
}

export class DisabledUserError extends Error {
  constructor(readonly userId: string) {
    super("user is disabled");
    this.name = "DisabledUserError";
  }
}

export function createPgActorStore(pool: PgPoolLike): ActorStore {
  return {
    async findByAuthSubject(authSubject) {
      const client = await pool.connect();
      try {
        const users = await client.query<UserRow>(
          `select id, auth_subject, email, display_name, disabled_at
             from tenancy.users
            where auth_subject = $1`,
          [authSubject],
        );
        const user = users.rows[0];
        if (!user) return null;
        if (user.disabled_at) throw new DisabledUserError(user.id);

        await client.query("begin");
        try {
          await client.query("select set_config('app.user_id', $1, true), set_config('app.run_id', '', true)", [user.id]);
          const ms = await client.query<MembershipRow>(
            `select m.firm_id, f.slug as firm_slug, f.name as firm_name, m.client_id, m.scope, m.role
               from tenancy.memberships m
               join tenancy.firms f on f.id = m.firm_id
              where m.user_id = $1
                and m.revoked_at is null
                and f.archived_at is null
              order by m.scope, f.name, m.granted_at`,
            [user.id],
          );
          await client.query("commit");
          const memberships: ActorMembership[] = ms.rows.map((r) => ({
            firmId: r.firm_id,
            firmSlug: r.firm_slug,
            firmName: r.firm_name,
            clientId: r.client_id,
            scope: r.scope,
            role: r.role,
          }));
          return {
            userId: user.id,
            authSubject: user.auth_subject,
            email: user.email,
            displayName: user.display_name,
            memberships,
          };
        } catch (err) {
          await client.query("rollback").catch(() => undefined);
          throw err;
        }
      } finally {
        client.release();
      }
    },

    async touchLastSeen(userId) {
      const client = await pool.connect();
      try {
        await client.query("update tenancy.users set last_seen_at = now() where id = $1", [userId]);
      } finally {
        client.release();
      }
    },
  };
}
