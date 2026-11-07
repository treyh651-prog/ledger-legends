/**
 * Self service access requests.
 *
 * Every account in this app used to come from an invitation: a firm admin
 * names an email, the person accepts. That leaves no path for a client to
 * ask for access on their own, and it is the reason the earlier security
 * audit flagged "public sign up is enabled" as a finding -- an account
 * created outside the invitation flow could authenticate but could not
 * reach anything (requireUser refuses any subject with no tenancy.users
 * row), a dead end for the person and worth nothing to anyone.
 *
 * This module is the other door: a person signs up with Supabase directly
 * (now allowed, by the firm's own choice, in the Supabase dashboard), then
 * tells a specific firm who they are and asks for access. The firm sees it
 * on a queue and decides, same as it always decided an invitation's role
 * and reach, just initiated the other way. Firm staff stay invitation only;
 * this exists for CLIENT_ROLES, granted at a real client the firm picks,
 * never derived from anything the requester typed.
 *
 * tenancy.access_requests has no actor at submission time, so the insert
 * cannot run inside withActor the way every other tenancy write in this
 * engagement does -- there is no tenancy.users row yet for current_actor()
 * to resolve. withRequester below is the one deliberate exception: it
 * verifies the bearer token itself (requireToken already did this on the
 * route, this just carries the verified subject into the transaction) and
 * sets app.requesting_subject, which migration 0070's RLS policies are
 * written against, the same way every other policy in this schema is
 * written against app.user_id. Approving or rejecting a request is firm
 * business as usual and runs inside withActor like everything else here.
 */

import {
  withActor,
  type Actor,
  type ActorMembership,
  type ActorRole,
  type ActorTx,
  type WithActorOptions,
  CLIENT_ROLES,
} from "../db/with-actor";
import type { PgClientLike, PgPoolLike } from "../runs/db-postgres";
import { assertCanInvite, upsertUser } from "./invitations";

export interface AccessRequestInput {
  firmSlug: string;
  requestedClientName: string;
  message: string | null;
}

export interface AccessRequestRow {
  id: string;
  firmId: string;
  firmName: string;
  requestedClientName: string;
  message: string | null;
  email: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
  rejectionReason: string | null;
}

export class AccessRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AccessRequestError";
  }
}

export interface AccessRequestDeps {
  pool: PgPoolLike;
  actorOpts?: WithActorOptions;
}

const SLUG = /^[a-z0-9-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateAccessRequestInput(input: unknown): AccessRequestInput {
  if (!input || typeof input !== "object") throw new AccessRequestError(400, "access_requests.bad_request", "Body must be an object.");
  const b = input as Record<string, unknown>;
  const firmSlug = typeof b.firmSlug === "string" ? b.firmSlug.trim().toLowerCase() : "";
  if (!SLUG.test(firmSlug)) throw new AccessRequestError(400, "access_requests.bad_slug", "Enter the sign up code your firm gave you.");
  const requestedClientName = typeof b.requestedClientName === "string" ? b.requestedClientName.trim().slice(0, 200) : "";
  if (!requestedClientName) throw new AccessRequestError(400, "access_requests.bad_client_name", "Tell the firm which business this is for.");
  const message = typeof b.message === "string" && b.message.trim() ? b.message.trim().slice(0, 1000) : null;
  return { firmSlug, requestedClientName, message };
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
 * The one write in this schema that runs before an actor exists. Mirrors
 * withActor's own shape (begin, optional role switch, work, commit/rollback,
 * release) but sets app.requesting_subject instead of app.user_id, because
 * there is no tenancy.users row for the subject yet.
 */
async function withRequester<T>(pool: PgPoolLike, dbRole: string | null | undefined, subject: string, fn: (tx: ActorTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("begin");
    began = true;
    if (dbRole) await client.query(`set local role ${dbRole}`);
    await client.query("select set_config('app.requesting_subject', $1, true)", [subject]);
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

function rowOf(firmId: string, firmName: string, r: {
  id: string;
  email: string;
  requested_client_name: string;
  message: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
  rejection_reason: string | null;
}): AccessRequestRow {
  return {
    id: r.id,
    firmId,
    firmName,
    requestedClientName: r.requested_client_name,
    message: r.message,
    email: r.email,
    status: r.status as AccessRequestRow["status"],
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    rejectionReason: r.rejection_reason,
  };
}

export async function submitAccessRequest(
  deps: AccessRequestDeps,
  verified: { subject: string; email: string },
  input: AccessRequestInput,
): Promise<AccessRequestRow> {
  return withRequester(deps.pool, deps.actorOpts?.dbRole, verified.subject, async (tx) => {
    const firms = await tx.query<{ id: string; name: string }>(`select id, name from tenancy.firms where slug = $1 and archived_at is null`, [
      input.firmSlug,
    ]);
    const firm = firms[0];
    if (!firm) throw new AccessRequestError(404, "access_requests.no_firm", "No firm uses that sign up code.");
    const dup = await tx.query<{ id: string }>(
      `select id from tenancy.access_requests where auth_subject = $1 and firm_id = $2 and status = 'pending'`,
      [verified.subject, firm.id],
    );
    if (dup.length > 0) throw new AccessRequestError(409, "access_requests.already_pending", "You already have a pending request with this firm.");
    const rows = await tx.query<{
      id: string;
      email: string;
      requested_client_name: string;
      message: string | null;
      status: string;
      created_at: string;
      resolved_at: string | null;
      rejection_reason: string | null;
    }>(
      `insert into tenancy.access_requests (auth_subject, email, firm_id, requested_client_name, message)
       values ($1, $2, $3, $4, $5)
       returning id, email, requested_client_name, message, status, created_at, resolved_at, rejection_reason`,
      [verified.subject, verified.email, firm.id, input.requestedClientName, input.message],
    );
    return rowOf(firm.id, firm.name, rows[0]);
  });
}

export async function myAccessRequests(deps: AccessRequestDeps, verified: { subject: string }): Promise<AccessRequestRow[]> {
  return withRequester(deps.pool, deps.actorOpts?.dbRole, verified.subject, (tx) =>
    tx
      .query<{
        id: string;
        firm_id: string;
        firm_name: string;
        email: string;
        requested_client_name: string;
        message: string | null;
        status: string;
        created_at: string;
        resolved_at: string | null;
        rejection_reason: string | null;
      }>(
        `select ar.id, ar.firm_id, f.name as firm_name, ar.email, ar.requested_client_name, ar.message,
                ar.status, ar.created_at, ar.resolved_at, ar.rejection_reason
           from tenancy.access_requests ar
           join tenancy.firms f on f.id = ar.firm_id
          where ar.auth_subject = $1
          order by ar.created_at desc`,
        [verified.subject],
      )
      .then((rows) => rows.map((r) => rowOf(r.firm_id, r.firm_name, r))),
  );
}

export async function listAccessRequests(deps: AccessRequestDeps, actor: Actor, firm: ActorMembership): Promise<AccessRequestRow[]> {
  const rows = await withActor(
    deps.pool,
    actor,
    (tx) =>
      tx.query<{
        id: string;
        email: string;
        requested_client_name: string;
        message: string | null;
        status: string;
        created_at: string;
        resolved_at: string | null;
        rejection_reason: string | null;
      }>(
        `select id, email, requested_client_name, message, status, created_at, resolved_at, rejection_reason
           from tenancy.access_requests
          where firm_id = $1
          order by status <> 'pending', created_at desc`,
        [firm.firmId],
      ),
    deps.actorOpts,
  );
  return rows.map((r) => rowOf(firm.firmId, firm.firmName, r));
}

export interface ApproveAccessRequestInput {
  clientId: string;
  role?: string;
}

export interface ApproveAccessRequestResult {
  membershipId: string;
  userId: string;
}

export async function approveAccessRequest(
  deps: AccessRequestDeps,
  actor: Actor,
  firm: ActorMembership,
  requestId: string,
  input: ApproveAccessRequestInput,
): Promise<ApproveAccessRequestResult> {
  assertCanInvite(firm);
  if (!UUID.test(requestId)) throw new AccessRequestError(404, "access_requests.not_found", "No such request.");
  if (!UUID.test(input.clientId)) throw new AccessRequestError(404, "access_requests.no_client", "No such client in this firm.");
  const roleInput = input.role ?? "client_user";
  if (!CLIENT_ROLES.includes(roleInput as ActorRole)) {
    throw new AccessRequestError(400, "access_requests.bad_role", `role must be one of ${CLIENT_ROLES.join(", ")}.`);
  }
  const role = roleInput as ActorRole;

  return withActor(
    deps.pool,
    actor,
    async (tx) => {
      const reqs = await tx.query<{ id: string; auth_subject: string; email: string; status: string }>(
        `select id, auth_subject, email, status from tenancy.access_requests where id = $1 and firm_id = $2`,
        [requestId, firm.firmId],
      );
      const r = reqs[0];
      if (!r) throw new AccessRequestError(404, "access_requests.not_found", "No such request.");
      if (r.status !== "pending") throw new AccessRequestError(409, "access_requests.already_resolved", "That request was already resolved.");
      const clients = await tx.query<{ id: string }>(`select id from tenancy.clients where id = $1 and firm_id = $2`, [input.clientId, firm.firmId]);
      if (clients.length === 0) throw new AccessRequestError(404, "access_requests.no_client", "No such client in this firm.");

      const userId = await upsertUser(tx, { authSubject: r.auth_subject, email: r.email, displayName: null, invitedBy: null });
      const dup = await tx.query<{ id: string }>(
        `select id from tenancy.memberships
           where user_id = $1 and firm_id = $2 and scope = 'client' and client_id = $3 and revoked_at is null`,
        [userId, firm.firmId, input.clientId],
      );
      if (dup.length > 0) throw new AccessRequestError(409, "access_requests.already_member", "That person already has this access.");
      const ins = await tx.query<{ id: string }>(
        `insert into tenancy.memberships (user_id, firm_id, client_id, scope, role, granted_by)
         values ($1, $2, $3, 'client', $4, $5) returning id`,
        [userId, firm.firmId, input.clientId, role, actor.userId],
      );
      await tx.query(
        `update tenancy.access_requests set status = 'approved', resolved_at = now(), resolved_by = $2, resulting_membership_id = $3 where id = $1`,
        [requestId, actor.userId, ins[0].id],
      );
      return { membershipId: ins[0].id, userId };
    },
    deps.actorOpts,
  );
}

export async function rejectAccessRequest(
  deps: AccessRequestDeps,
  actor: Actor,
  firm: ActorMembership,
  requestId: string,
  reason: string,
): Promise<{ id: string }> {
  assertCanInvite(firm);
  if (!UUID.test(requestId)) throw new AccessRequestError(404, "access_requests.not_found", "No such request.");
  const trimmedReason = reason.trim().slice(0, 1000);
  if (!trimmedReason) throw new AccessRequestError(400, "access_requests.bad_reason", "A reason is required.");

  return withActor(
    deps.pool,
    actor,
    async (tx) => {
      const reqs = await tx.query<{ id: string; status: string }>(`select id, status from tenancy.access_requests where id = $1 and firm_id = $2`, [
        requestId,
        firm.firmId,
      ]);
      const r = reqs[0];
      if (!r) throw new AccessRequestError(404, "access_requests.not_found", "No such request.");
      if (r.status !== "pending") throw new AccessRequestError(409, "access_requests.already_resolved", "That request was already resolved.");
      await tx.query(
        `update tenancy.access_requests set status = 'rejected', resolved_at = now(), resolved_by = $2, rejection_reason = $3 where id = $1`,
        [requestId, actor.userId, trimmedReason],
      );
      return { id: requestId };
    },
    deps.actorOpts,
  );
}

/** Public: a firm's name by the code it hands out to prospective clients. No auth, same as the X-Firm header's own slug lookup. */
export async function lookupFirmBySlug(pool: PgPoolLike, slug: string): Promise<{ id: string; name: string; slug: string } | null> {
  const client = await pool.connect();
  try {
    const r = await client.query<{ id: string; name: string; slug: string }>(`select id, name, slug from tenancy.firms where slug = $1 and archived_at is null`, [
      slug,
    ]);
    return r.rows[0] ?? null;
  } finally {
    client.release();
  }
}
