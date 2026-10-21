/**
 * Invitations.
 *
 * An invitation is not its own table. It is a tenancy.users row (created
 * when the firm invites someone, pointing at the Supabase auth user through
 * auth_subject) plus a tenancy.memberships row that says what they may
 * reach. Accepting the invitation is the person setting a password or
 * following the link; the first authenticated request stamps last_seen_at,
 * which is what the list shows as "accepted".
 *
 * Revoking sets revoked_at on the membership. When that leaves the user with
 * no active membership anywhere, the user row is disabled and the auth user
 * is banned so a refresh token cannot bring them back. An access token still
 * in a browser dies at the next request because the actor middleware reads
 * disabled_at and revoked_at on every resolve.
 *
 * All tenancy writes run inside withActor, so current_actor() is the firm
 * user doing the inviting and the membership policies apply.
 */

import {
  CLIENT_ROLES,
  FIRM_ROLES,
  INVITER_ROLES,
  withActor,
  type Actor,
  type ActorMembership,
  type ActorRole,
  type ActorScope,
  type ActorTx,
  type WithActorOptions,
} from "../db/with-actor";
import type { PgPoolLike } from "../runs/db-postgres";
import type { AuthAdmin } from "./auth-admin";

export interface InvitationInput {
  email: string;
  displayName?: string | null;
  scope: ActorScope;
  role: ActorRole;
  clientId?: string | null;
}

export interface InvitationRow {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string | null;
  scope: ActorScope;
  role: ActorRole;
  clientId: string | null;
  clientName: string | null;
  grantedAt: string;
  grantedBy: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  disabledAt: string | null;
}

export interface InviteResult {
  membershipId: string;
  userId: string;
  authSubject: string;
  /** False when the email already had a login and no invitation email went out. */
  emailSent: boolean;
}

export class InvitationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvitationError";
  }
}

export interface InvitationDeps {
  pool: PgPoolLike;
  authAdmin: AuthAdmin;
  /** Where the invitation email sends the person. */
  appOrigin: string;
  actorOpts?: WithActorOptions;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateInvitation(input: unknown): InvitationInput {
  if (!input || typeof input !== "object") throw new InvitationError(400, "invitations.bad_request", "Body must be an object.");
  const b = input as Record<string, unknown>;
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) throw new InvitationError(400, "invitations.bad_email", "A valid email address is required.");
  const displayName = typeof b.displayName === "string" && b.displayName.trim() ? b.displayName.trim().slice(0, 120) : null;
  const scope = b.scope;
  if (scope !== "firm" && scope !== "client") throw new InvitationError(400, "invitations.bad_scope", "scope must be firm or client.");
  const role = b.role as ActorRole;
  const allowed = scope === "firm" ? FIRM_ROLES : CLIENT_ROLES;
  if (!allowed.includes(role)) {
    throw new InvitationError(400, "invitations.bad_role", `role must be one of ${allowed.join(", ")} for a ${scope} invitation.`);
  }
  const clientId = typeof b.clientId === "string" && b.clientId.trim() ? b.clientId.trim() : null;
  if (scope === "client" && (!clientId || !UUID.test(clientId))) {
    throw new InvitationError(400, "invitations.bad_client", "A client invitation needs a clientId.");
  }
  if (scope === "firm" && clientId) throw new InvitationError(400, "invitations.bad_client", "A firm invitation does not take a clientId.");
  return { email, displayName, scope, role, clientId: scope === "client" ? clientId : null };
}

export function assertCanInvite(firm: ActorMembership): void {
  if (!INVITER_ROLES.includes(firm.role)) {
    throw new InvitationError(403, "invitations.forbidden", "Only a firm owner or manager can manage invitations.");
  }
}

export async function listInvitations(deps: InvitationDeps, actor: Actor, firm: ActorMembership): Promise<InvitationRow[]> {
  return withActor(
    deps.pool,
    actor,
    (tx) =>
      tx.query<InvitationRow>(
        `select m.id as "membershipId", u.id as "userId", u.email, u.display_name as "displayName",
                m.scope, m.role, m.client_id as "clientId", c.name as "clientName",
                m.granted_at as "grantedAt", m.granted_by as "grantedBy", m.revoked_at as "revokedAt",
                u.last_seen_at as "lastSeenAt", u.disabled_at as "disabledAt"
           from tenancy.memberships m
           join tenancy.users u on u.id = m.user_id
           left join tenancy.clients c on c.id = m.client_id
          where m.firm_id = $1
          order by m.revoked_at is not null, m.granted_at desc`,
        [firm.firmId],
      ),
    deps.actorOpts,
  );
}

export async function createInvitation(
  deps: InvitationDeps,
  actor: Actor,
  firm: ActorMembership,
  input: InvitationInput,
): Promise<InviteResult> {
  assertCanInvite(firm);

  // Checks that need the database but not the auth server come first, so a
  // bad request does not create an auth user.
  const existing = await withActor(
    deps.pool,
    actor,
    async (tx) => {
      if (input.scope === "client") {
        const rows = await tx.query<{ id: string }>(`select id from tenancy.clients where id = $1 and firm_id = $2`, [
          input.clientId,
          firm.firmId,
        ]);
        if (rows.length === 0) throw new InvitationError(404, "invitations.no_client", "No such client in this firm.");
      }
      const users = await tx.query<{ id: string; auth_subject: string; disabled_at: string | null }>(
        `select id, auth_subject, disabled_at from tenancy.users where lower(email) = $1`,
        [input.email],
      );
      return users[0] ?? null;
    },
    deps.actorOpts,
  );

  let authSubject: string;
  let emailSent: boolean;
  if (existing) {
    if (existing.disabled_at) {
      throw new InvitationError(409, "invitations.disabled", "That person was removed. Ask an operator to restore the login before inviting again.");
    }
    authSubject = existing.auth_subject;
    emailSent = false;
  } else {
    const r = await deps.authAdmin.inviteByEmail(input.email, {
      redirectTo: `${deps.appOrigin}/auth/callback`,
      displayName: input.displayName ?? null,
    });
    authSubject = r.authSubject;
    emailSent = !r.existed;
  }

  return withActor(
    deps.pool,
    actor,
    async (tx) => {
      const userId = await upsertUser(tx, { authSubject, email: input.email, displayName: input.displayName ?? null, invitedBy: actor.userId });
      const dup = await tx.query<{ id: string }>(
        `select id from tenancy.memberships
          where user_id = $1 and firm_id = $2 and scope = $3 and client_id is not distinct from $4 and revoked_at is null`,
        [userId, firm.firmId, input.scope, input.clientId],
      );
      if (dup.length > 0) throw new InvitationError(409, "invitations.already_member", "That person already has this access.");
      const ins = await tx.query<{ id: string }>(
        `insert into tenancy.memberships (user_id, firm_id, client_id, scope, role, granted_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [userId, firm.firmId, input.clientId, input.scope, input.role, actor.userId],
      );
      return { membershipId: ins[0].id, userId, authSubject, emailSent };
    },
    deps.actorOpts,
  );
}

async function upsertUser(
  tx: ActorTx,
  u: { authSubject: string; email: string; displayName: string | null; invitedBy: string },
): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `insert into tenancy.users (auth_subject, email, display_name, invited_by)
     values ($1, $2, $3, $4)
     on conflict (auth_subject) do update set email = excluded.email
     returning id`,
    [u.authSubject, u.email, u.displayName, u.invitedBy],
  );
  return rows[0].id;
}

export interface RevokeResult {
  membershipId: string;
  userId: string;
  /** True when this was the user's last active membership and the login was disabled. */
  loginDisabled: boolean;
}

export async function revokeInvitation(
  deps: InvitationDeps,
  actor: Actor,
  firm: ActorMembership,
  membershipId: string,
): Promise<RevokeResult> {
  assertCanInvite(firm);
  if (!UUID.test(membershipId)) throw new InvitationError(404, "invitations.not_found", "No such membership.");

  const out = await withActor(
    deps.pool,
    actor,
    async (tx) => {
      const rows = await tx.query<{ id: string; user_id: string; role: ActorRole; scope: ActorScope; revoked_at: string | null }>(
        `select id, user_id, role, scope, revoked_at from tenancy.memberships where id = $1 and firm_id = $2`,
        [membershipId, firm.firmId],
      );
      const m = rows[0];
      if (!m) throw new InvitationError(404, "invitations.not_found", "No such membership.");
      if (m.revoked_at) throw new InvitationError(409, "invitations.already_revoked", "That access was already revoked.");
      if (m.user_id === actor.userId) throw new InvitationError(409, "invitations.self", "You cannot revoke your own access.");
      if (m.scope === "firm" && m.role === "owner") {
        const owners = await tx.query<{ n: string }>(
          `select count(*)::text as n from tenancy.memberships
            where firm_id = $1 and scope = 'firm' and role = 'owner' and revoked_at is null`,
          [firm.firmId],
        );
        if (Number(owners[0]?.n ?? "0") <= 1) {
          throw new InvitationError(409, "invitations.last_owner", "A firm must keep at least one owner.");
        }
      }
      await tx.query(`update tenancy.memberships set revoked_at = now(), revoked_by = $2 where id = $1`, [membershipId, actor.userId]);
      const remaining = await tx.query<{ n: string }>(
        `select count(*)::text as n from tenancy.memberships where user_id = $1 and revoked_at is null`,
        [m.user_id],
      );
      const last = Number(remaining[0]?.n ?? "0") === 0;
      let authSubject: string | null = null;
      if (last) {
        const u = await tx.query<{ auth_subject: string }>(
          `update tenancy.users set disabled_at = now() where id = $1 and disabled_at is null returning auth_subject`,
          [m.user_id],
        );
        authSubject = u[0]?.auth_subject ?? null;
      }
      return { membershipId, userId: m.user_id, last, authSubject };
    },
    deps.actorOpts,
  );

  if (out.last && out.authSubject) {
    // After the commit. If the ban fails the membership is still revoked and
    // the user row disabled, which is what the middleware reads, so the
    // person is out either way; the ban only closes the refresh token.
    await deps.authAdmin.ban(out.authSubject);
  }
  return { membershipId: out.membershipId, userId: out.userId, loginDisabled: out.last };
}
