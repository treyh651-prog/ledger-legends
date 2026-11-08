/**
 * The one place outside the run framework that turns a just-applied run's
 * own written rows into an email. Every run file this feature touches
 * still carries its own "SENDS. None." doc comment and that stays true --
 * nothing inside PRAC-NUDGE-REQUESTS, SUB-RAISE-REQUESTS, or
 * PRAC-ESCALATE-OVERDUE makes an external call. This module is called by
 * the two places a run's apply() actually runs (server/api/runs.ts for an
 * interactive trigger, server/sched/runner.ts for a scheduled one), after
 * the run has already committed, the same way dispatchOnboardingContinuation
 * already calls out to Netlify from server/api/runs.ts rather than from
 * inside a run.
 *
 * Client-facing notification types (document_request_nudge,
 * substantiation_request_raised) are gated by
 * tenancy.notification_preferences -- opt in, absence means off, per
 * docs/09's D4 compliance framing. PRAC-ESCALATE-OVERDUE never reaches a
 * client, so it carries no such gate; it goes straight to the assignee,
 * lead, or partner the escalation row itself names, or to every owner and
 * manager on the firm when the row names no single person (rung at_risk).
 */

import type { PgPoolLike } from "../runs/db-postgres";
import type { EmailSender } from "../email";
import { firmMembers } from "../auth/actor-store";

/**
 * The handful of fields this module actually reads, satisfied by both the
 * raw RunOutcome<Proposal> the scheduler's own execute() call returns and
 * the RunOutcomeDto the HTTP trigger route already built for its response
 * body -- proposals on the Dto went through toJsonValue(), but every field
 * this module reads off a proposal (kind, table, rowId, row.recipientId,
 * row.recipientRole, row.daysOverdue) is already JSON-safe and survives
 * that conversion unchanged.
 */
export interface NotifiableOutcome {
  status: string;
  runType: string;
  proposals: ReadonlyArray<Record<string, unknown>>;
}

const CLIENT_FACING_TYPES = new Set(["PRAC-NUDGE-REQUESTS", "SUB-RAISE-REQUESTS"]);
const RUN_TO_NOTIFICATION_TYPE: Record<string, "document_request_nudge" | "substantiation_request_raised"> = {
  "PRAC-NUDGE-REQUESTS": "document_request_nudge",
  "SUB-RAISE-REQUESTS": "substantiation_request_raised",
};

export interface NotifyDeps {
  pool: PgPoolLike;
  email: EmailSender;
}

/** The one entry point both call sites use. Safe to call for any run type -- it is a no-op for anything it does not recognize. */
export async function notifyAfterRun(deps: NotifyDeps, outcome: NotifiableOutcome, firmId: string, clientId: string): Promise<void> {
  if (!CLIENT_FACING_TYPES.has(outcome.runType) && outcome.runType !== "PRAC-ESCALATE-OVERDUE") return;
  if (outcome.status !== "completed" && outcome.status !== "completed_with_skips") return;
  const proposals = outcome.proposals;
  if (proposals.length === 0) return;

  const clientName = await clientNameOf(deps.pool, clientId);
  if (CLIENT_FACING_TYPES.has(outcome.runType)) {
    await notifyClientFacing(deps, firmId, clientId, clientName, outcome.runType, proposals.length);
    return;
  }
  await notifyEscalations(deps, firmId, clientName, proposals);
}

async function clientNameOf(pool: PgPoolLike, clientId: string): Promise<string> {
  const client = await pool.connect();
  try {
    const r = await client.query<{ name: string }>(`select name from tenancy.clients where id = $1`, [clientId]);
    return r.rows[0]?.name ?? "your client";
  } finally {
    client.release();
  }
}

async function preferenceEnabled(pool: PgPoolLike, firmId: string, clientId: string, notificationType: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    const r = await client.query<{ enabled: boolean }>(
      `select enabled from tenancy.notification_preferences where firm_id = $1 and client_id = $2 and notification_type = $3`,
      [firmId, clientId, notificationType],
    );
    return r.rows[0]?.enabled ?? false;
  } finally {
    client.release();
  }
}

async function clientPortalRecipients(pool: PgPoolLike, firmId: string, clientId: string): Promise<Array<{ email: string; displayName: string | null }>> {
  const client = await pool.connect();
  try {
    const r = await client.query<{ email: string; displayName: string | null }>(
      `select u.email, u.display_name as "displayName"
         from tenancy.memberships m
         join tenancy.users u on u.id = m.user_id
        where m.firm_id = $1 and m.client_id = $2 and m.scope = 'client' and m.revoked_at is null and u.disabled_at is null`,
      [firmId, clientId],
    );
    return r.rows;
  } finally {
    client.release();
  }
}

async function userEmail(pool: PgPoolLike, userId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    const r = await client.query<{ email: string }>(`select email from tenancy.users where id = $1 and disabled_at is null`, [userId]);
    return r.rows[0]?.email ?? null;
  } finally {
    client.release();
  }
}

async function notifyClientFacing(deps: NotifyDeps, firmId: string, clientId: string, clientName: string, runType: string, count: number): Promise<void> {
  const notificationType = RUN_TO_NOTIFICATION_TYPE[runType];
  if (!(await preferenceEnabled(deps.pool, firmId, clientId, notificationType))) return;
  const recipients = await clientPortalRecipients(deps.pool, firmId, clientId);
  if (recipients.length === 0) return;

  const { subject, text } =
    notificationType === "document_request_nudge"
      ? {
          subject: `${clientName}: a document request is due for a check`,
          text: `${count === 1 ? "A request is" : `${count} requests are`} open and due for a check on your Ledger Legends portal. Sign in to see what's needed.`,
        }
      : {
          subject: `${clientName}: ${count === 1 ? "a document request was" : `${count} document requests were`} raised`,
          text: `${count === 1 ? "A new document request has" : `${count} new document requests have`} been added to your Ledger Legends portal. Sign in to see what's needed.`,
        };

  for (const r of recipients) {
    await deps.email.send({ to: r.email, subject, text });
  }
}

async function notifyEscalations(deps: NotifyDeps, firmId: string, clientName: string, proposals: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  const escalationRows = proposals
    .filter((p) => p.kind === "row_insert" && p.table === "practice_escalations")
    .map((p) => p.row as { recipientId: string | null; recipientRole: string; rung: string; daysOverdue: number });

  const toFirmLeadership = escalationRows.some((r) => r.recipientRole === "firm");
  const directRecipients = new Map<string, { daysOverdue: number; rung: string }>();
  for (const r of escalationRows) {
    if (r.recipientId !== null) directRecipients.set(r.recipientId, { daysOverdue: r.daysOverdue, rung: r.rung });
  }

  for (const [userId, info] of directRecipients) {
    const email = await userEmail(deps.pool, userId);
    if (!email) continue;
    await deps.email.send({
      to: email,
      subject: `${clientName}: an overdue task reached your rung`,
      text: `A task for ${clientName} is ${info.daysOverdue} day${info.daysOverdue === 1 ? "" : "s"} overdue and has escalated to you. Check the board.`,
    });
  }

  if (toFirmLeadership) {
    const members = await firmMembers(deps.pool, firmId);
    const leadership = members.filter((m) => m.role === "owner" || m.role === "manager");
    for (const m of leadership) {
      await deps.email.send({
        to: m.email,
        subject: `${clientName}: a task is now at risk`,
        text: `A task for ${clientName} has run past every escalation rung with no response and is now flagged at risk. Check the board.`,
      });
    }
  }
}
