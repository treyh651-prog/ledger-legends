/**
 * PRAC-ESCALATE-OVERDUE. Walk the escalation ladder on work that has slipped,
 * and tell each firm member what they are carrying.
 *
 * Spec: docs/02-run-specifications.md Module 9 PRAC-ESCALATE-OVERDUE.
 *
 * What the run does. For every task past its due date it computes the days
 * overdue, resolves the highest rung that age has reached, and writes one
 * append only escalation row for every rung between the one already fired and
 * that one. Then it surfaces one workload notice per firm member holding
 * overdue work, with the count and the oldest item, so a person opens one row
 * rather than counting a list.
 *
 * Each rung fires exactly once per task per due date. That is the invariant the
 * whole run exists to hold. The rung already reached is stored on the task, so
 * ten consecutive daily executions against one task that stays overdue produce
 * exactly four escalation rows, one for the assignee, one for the lead, one for
 * the partner, and one at risk flag, and nothing on the other six days.
 *
 * A due date that moves resets the ladder. Doc 02 rule 3. The reset is itself
 * logged, with the old date and the new one on the row, because a due date that
 * quietly slid is the single most common way a deadline gets missed without
 * anybody noticing.
 *
 * A blocked task escalates against the blocking predecessor's owner rather than
 * against its own assignee, because the assignee cannot start. An assignee who
 * is out of office skips the assignee rung and the lead rung fires first, since
 * a notification to somebody on leave is not a notification.
 *
 * SENDS. None. An escalation is a row that names a recipient and a reason. A
 * workload notice is a row that names a count. Nothing here transmits anything,
 * and no row in this module carries an address or a message body.
 *
 * Append only. Escalation rows are never updated and never deleted. There is no
 * field write path to that table anywhere in the codebase, which is why the
 * apply writer has an insert case for it and no write case.
 *
 * Locked periods. A task about a locked period still escalates, because the
 * work is the firm's own and closing a period does not finish it. What is
 * skipped is a paused engagement, which is a different question.
 *
 * CONSTRAINT. No model, no score, no string distance. A rung is one integer
 * compared against another.
 */

import { z } from "zod";
import {
  isFieldWrite,
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import {
  applyProposals,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  requireTx,
} from "../apply-writer";
import { dayGap } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { PracticeStateRow, PracticeTaskRow, WorkloadNoticeRow } from "../tables";
import { ZERO } from "./close-shared";
import { changedFieldsOf } from "./rpt-shared";
import {
  ladderFor,
  loadPracticeData,
  recipientFor,
  rungFor,
  rungsToFire,
  type Ladder,
  type PracticeData,
} from "./prc-shared";
import { periodWindow } from "./per-shared";

export const escalateOverdueScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  /** The day the ladder is measured against. Defaults to the period end. */
  asOfDate: z.string().min(10).optional(),
});

export type EscalateOverdueScope = z.infer<typeof escalateOverdueScopeSchema>;

export const prcEscalateOverdue: Run<EscalateOverdueScope, Proposal> = {
  type: "PRAC-ESCALATE-OVERDUE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:escalate:${scope.period.slice(0, 7)}`,
  scopeSchema: escalateOverdueScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<EscalateOverdueScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadPracticeData(tx, ctx.firmId, scope.clientId, scope.period);
    const asOf = scope.asOfDate ?? window.periodEnd;
    const overdue = overdueTasks(data, asOf);
    const candidateIds = overdue.map((t) => t.id);
    const versions = [
      { id: "PRAC-ESCALATE-OVERDUE", version: 1 },
      ...overdue.map((t) => ({ id: t.id, version: t.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // The period and the as of day are both in the hash. Escalating the same
      // task on two different days is two scopes, which is the point.
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds: [...candidateIds, `AS-OF:${asOf}`],
        versions,
      }),
      versions,
      overriddenIds: data.tasks.filter((t) => t.manualOverride).map((t) => t.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const data = await loadPracticeData(tx, frozen.firmId, frozen.clientId, frozen.input.period);
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const asOf = frozen.input.asOfDate ?? window.periodEnd;
    const state = data.state;
    const ladder = ladderFor(state);

    /*
     * Doc 02 rule 7. A paused engagement escalates nothing. The firm agreed to
     * stop, and a ladder that keeps climbing through a pause manufactures
     * urgency about work nobody is supposed to be doing.
     */
    if (state !== null && state.engagementPaused) {
      skips.push({
        rowId: frozen.clientId,
        reason: "out_of_scope_engagement",
        detail: "engagement_paused, so no rung fired",
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const byCode = new Map<string, PracticeTaskRow>(
      data.tasks
        .filter((t) => t.periodStart === window.periodStart)
        .map((t) => [t.catalogCode, t]),
    );
    // Per member tallies, built as the ladder walks so there is one pass.
    const tallies = new Map<string, Tally>();
    let ordinal = 0;

    for (const task of overdueTasks(data, asOf)) {
      if (task.manualOverride) {
        skips.push({
          rowId: task.id,
          reason: "manual_override",
          detail: `task ${task.catalogCode} carries manual_override`,
        });
        continue;
      }

      const daysOverdue = dayGap(task.dueDate, asOf);

      /*
       * Doc 02 rule 3. A due date that moved after the last escalation resets
       * the ladder, and the reset itself is a row so the slide is visible. The
       * test is the day the due date was set against the day the last rung
       * fired.
       */
      if (task.lastEscalatedOn !== null && task.dueDateSetOn > task.lastEscalatedOn) {
        ordinal += 1;
        proposals.push(
          insertEscalation(frozen, ordinal, {
            taskId: task.id,
            asOfDate: asOf,
            dueDate: task.dueDate,
            daysOverdue,
            rung: "due_date_reset",
            recipientId: state === null ? null : state.leadId,
            recipientRole: "lead",
            priorRung: task.escalationRung,
            reason:
              `The due date on ${task.catalogCode} moved to ${task.dueDate} on ` +
              `${task.dueDateSetOn}, after the last escalation on ${task.lastEscalatedOn}. ` +
              `The ladder resets.`,
            resetFromDueDate: task.lastEscalatedOn,
            resetToDueDate: task.dueDate,
          }),
        );
        proposals.push({
          kind: "field_write",
          table: "practice_tasks",
          rowId: task.id,
          before: { escalationRung: task.escalationRung, lastEscalatedOn: task.lastEscalatedOn },
          after: { escalationRung: "none", lastEscalatedOn: asOf },
          provenance: { cascadeLevel: null },
        });
        continue;
      }

      const reached = rungFor(daysOverdue, ladder);
      const fired = rungsToFire(task.escalationRung, reached);
      if (fired.length === 0) {
        skips.push({
          rowId: task.id,
          reason: "already_applied",
          detail:
            daysOverdue < ladder.assignee
              ? `not_overdue enough for ${task.catalogCode}, ${daysOverdue} days`
              : `rung_already_fired for ${task.catalogCode} at ${task.escalationRung}`,
        });
        tally(tallies, task, state, daysOverdue);
        continue;
      }

      for (const rung of fired) {
        const target = escalationTargetFor(rung, task, state, byCode);
        ordinal += 1;
        proposals.push(
          insertEscalation(frozen, ordinal, {
            taskId: task.id,
            asOfDate: asOf,
            dueDate: task.dueDate,
            daysOverdue,
            rung,
            recipientId: target.recipientId,
            recipientRole: target.role,
            priorRung: task.escalationRung,
            reason: target.reason,
            resetFromDueDate: null,
            resetToDueDate: null,
          }),
        );
      }

      proposals.push({
        kind: "field_write",
        table: "practice_tasks",
        rowId: task.id,
        before: { escalationRung: task.escalationRung, lastEscalatedOn: task.lastEscalatedOn },
        after: { escalationRung: reached, lastEscalatedOn: asOf },
        provenance: { cascadeLevel: null },
      });
      tally(tallies, task, state, daysOverdue);
    }

    /*
     * One workload notice per firm member. Doc 02 rule 6 and the brief. The row
     * carries the count and the oldest overdue item, which is the pair a person
     * actually needs to decide what to do first.
     */
    const noticeById = new Map<string, WorkloadNoticeRow>(
      data.notices.map((n) => [n.id, n]),
    );
    const memberIds = [...tallies.keys()].sort();
    for (const memberId of memberIds) {
      const entry = tallies.get(memberId);
      if (entry === undefined) continue;
      const rowId = noticeIdOf(frozen.clientId, asOf, memberId);
      const content = {
        asOfDate: asOf,
        memberId,
        memberRole: entry.role,
        overdueCount: entry.count,
        oldestDueDate: entry.oldestDueDate,
        oldestTaskId: entry.oldestTaskId,
        maxDaysOverdue: entry.maxDaysOverdue,
        detail:
          `${entry.count} overdue items as of ${asOf}. The oldest is ` +
          `${entry.oldestTaskId ?? "none"} due ${entry.oldestDueDate ?? "none"}, ` +
          `${entry.maxDaysOverdue} days past.`,
      };
      const prior = noticeById.get(rowId);
      if (prior === undefined) {
        proposals.push({
          kind: "row_insert",
          table: "workload_notices",
          rowId,
          row: {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            version: 1,
            ...content,
            createdByRunId: RUN_ID_PLACEHOLDER,
            createdAt: NOW_PLACEHOLDER,
            manualOverride: false,
          },
          provenance: { cascadeLevel: null },
        });
        continue;
      }
      if (prior.manualOverride) {
        skips.push({
          rowId,
          reason: "manual_override",
          detail: `workload notice for ${memberId} carries manual_override`,
        });
        continue;
      }
      const changed = changedFieldsOf(
        prior as unknown as Record<string, unknown>,
        content as unknown as Record<string, unknown>,
      );
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `notice_unchanged for ${memberId} at ${asOf}`,
        });
        continue;
      }
      proposals.push({
        kind: "field_write",
        table: "workload_notices",
        rowId,
        before: changed.before,
        after: changed.after,
        provenance: { cascadeLevel: null },
      });
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "PRAC-ESCALATE-OVERDUE",
      runVersion: 1,
    });
  },

  /**
   * The rung on the task reverts. The escalation rows do not, because the
   * escalation table is append only and an undo that erased the history would
   * make the invariant unprovable.
   */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

interface Tally {
  role: WorkloadNoticeRow["memberRole"];
  count: number;
  oldestDueDate: string | null;
  oldestTaskId: Ulid | null;
  maxDaysOverdue: number;
}

export function noticeIdOf(clientId: Ulid, asOf: string, memberId: string): Ulid {
  return derivedId(`${clientId}:${asOf}:${memberId}`, "prc-workload-notice", 0);
}

export function escalationIdOf(clientId: Ulid, asOf: string, ordinal: number): Ulid {
  return derivedId(`${clientId}:${asOf}`, "prc-escalation", ordinal);
}

/**
 * Overdue tasks, ordered by doc 02 rule 8: days overdue descending, then task
 * id ascending. Client name is the outer key in the spec, and one execution
 * covers one client, so it drops out here.
 */
export function overdueTasks(data: PracticeData, asOf: string): PracticeTaskRow[] {
  return data.tasks
    .filter((t) => t.state !== "complete")
    .filter((t) => t.dueDate < asOf)
    .sort((a, b) => {
      const da = dayGap(a.dueDate, asOf);
      const db = dayGap(b.dueDate, asOf);
      if (da !== db) return db - da;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * Who a rung reaches, with the two doc 02 exceptions applied.
 *
 * A blocked task escalates against the owner of the blocking predecessor. An
 * assignee who is out of office does not get the assignee rung, and the reason
 * string says why rather than leaving a recipient of nobody unexplained.
 */
function escalationTargetFor(
  rung: "assignee" | "lead" | "partner" | "at_risk",
  task: PracticeTaskRow,
  state: PracticeStateRow | null,
  byCode: ReadonlyMap<string, PracticeTaskRow>,
): { recipientId: Ulid | null; role: WorkloadNoticeRow["memberRole"] | "predecessor_owner"; reason: string } {
  if (rung === "assignee" && task.state === "blocked" && task.blockedByCode !== null) {
    const predecessor = byCode.get(task.blockedByCode);
    return {
      recipientId: predecessor === undefined ? null : predecessor.assigneeId,
      role: "predecessor_owner",
      reason:
        `${task.catalogCode} is blocked by ${task.blockedByCode}, so the rung ` +
        `goes to the owner of the blocking task rather than to an assignee who cannot start.`,
    };
  }
  if (
    rung === "assignee" &&
    task.assigneeId !== null &&
    state !== null &&
    state.outOfOfficeMemberIds.includes(task.assigneeId)
  ) {
    return {
      recipientId: state.leadId,
      role: "lead",
      reason:
        `The assignee of ${task.catalogCode} is out of office, so the assignee ` +
        `rung is skipped and the lead rung fires first.`,
    };
  }
  const target = recipientFor(rung, task, state);
  return {
    recipientId: target.recipientId,
    role: target.role,
    reason: `${task.catalogCode} is past its due date of ${task.dueDate}. Rung ${rung}.`,
  };
}

function tally(
  tallies: Map<string, Tally>,
  task: PracticeTaskRow,
  state: PracticeStateRow | null,
  daysOverdue: number,
): void {
  // Unassigned work still needs an owner on a notice, so it lands on the lead
  // and, failing that, on the firm. Work nobody is counted for is work nobody
  // does.
  const memberId =
    task.assigneeId ?? (state === null ? null : state.leadId) ?? "UNASSIGNED";
  const role: WorkloadNoticeRow["memberRole"] =
    task.assigneeId !== null ? "assignee" : state === null ? "firm" : "lead";
  const prior = tallies.get(memberId);
  if (prior === undefined) {
    tallies.set(memberId, {
      role,
      count: 1,
      oldestDueDate: task.dueDate,
      oldestTaskId: task.id,
      maxDaysOverdue: daysOverdue,
    });
    return;
  }
  prior.count += 1;
  if (prior.oldestDueDate === null || task.dueDate < prior.oldestDueDate) {
    prior.oldestDueDate = task.dueDate;
    prior.oldestTaskId = task.id;
  }
  if (daysOverdue > prior.maxDaysOverdue) prior.maxDaysOverdue = daysOverdue;
}

interface EscalationContent {
  taskId: Ulid;
  asOfDate: string;
  dueDate: string;
  daysOverdue: number;
  rung: "assignee" | "lead" | "partner" | "at_risk" | "due_date_reset";
  recipientId: Ulid | null;
  recipientRole: "assignee" | "lead" | "partner" | "firm" | "predecessor_owner";
  priorRung: PracticeTaskRow["escalationRung"];
  reason: string;
  resetFromDueDate: string | null;
  resetToDueDate: string | null;
}

function insertEscalation(
  frozen: FrozenScope<EscalateOverdueScope>,
  ordinal: number,
  content: EscalationContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "practice_escalations",
    rowId: escalationIdOf(frozen.clientId, content.asOfDate, ordinal),
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      ...content,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

export type { Ladder };
