/**
 * PRAC-GENERATE-TASKS. Build the standard workload for a client and a period.
 *
 * Spec: docs/02-run-specifications.md Module 9 PRAC-GENERATE-TASKS.
 *
 * What the run does. It reads the client's task catalog, which holds the
 * checklists, the dated deadlines, and the gate targets the firm commits to
 * every period, and it writes one task per catalog code per period. Due dates
 * are the catalog offset counted from period end, shifted forward off a weekend
 * onto the Monday. A task whose predecessor is not complete is created blocked
 * rather than open, so nobody starts work that cannot be finished.
 *
 * Idempotency. The task id is derived from the client, the period start, and
 * the catalog code, so the second execution finds every row already there and
 * reports task exists. That is what makes this safe to schedule daily rather
 * than once a month, which matters because a client onboarded on the fifteenth
 * should still get the period's workload.
 *
 * Scope. One client per execution, which is how every run in this codebase is
 * shaped and what the frozen scope requires. The orchestrator loops the live
 * clients and calls this once each, so the brief's every live client and every
 * period is satisfied by the caller rather than by a second scope shape inside
 * the run. See NOTES.md entry 115.
 *
 * Locked periods. A period that is closed gets no new work, because a task
 * about a closed period is noise assigned to a person. The skip names the lock.
 *
 * Assignment. Preparer work goes to the client's preparer and review work to
 * the engagement lead, per doc 02 rule 5. A member unavailable for the whole
 * period leaves the task unassigned rather than assigned to somebody who cannot
 * do it, and the assignment reason says so in words.
 *
 * SENDS. None. This run writes task rows. Nothing is transmitted.
 *
 * CONSTRAINT. No model, no score, no string distance. Due dates are integer day
 * arithmetic and assignments are stored member ids.
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
import { addDays, isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { PracticeStateRow, PracticeTaskCatalogRow, PracticeTaskRow } from "../tables";
import { ZERO } from "./close-shared";
import { changedFieldsOf } from "./rpt-shared";
import {
  byCatalogCode,
  frequencyLandsIn,
  isLiveClient,
  loadPracticeData,
  shiftToBusinessDay,
  type PracticeData,
} from "./prc-shared";
import { periodWindow } from "./per-shared";

export const generateWorkScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type GenerateWorkScope = z.infer<typeof generateWorkScopeSchema>;

/** The comparable content of one generated task. */
interface TaskContent {
  periodStart: string;
  periodEnd: string;
  catalogCode: string;
  title: string;
  kind: PracticeTaskCatalogRow["kind"];
  role: PracticeTaskCatalogRow["role"];
  gateCode: string | null;
  dueDate: string;
  state: "open" | "blocked";
  blockedByCode: string | null;
  assigneeId: Ulid | null;
  assignmentReason: string;
}

export const prcGenerateWork: Run<GenerateWorkScope, Proposal> = {
  type: "PRAC-GENERATE-TASKS",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:practice-work:${scope.period.slice(0, 7)}`,
  scopeSchema: generateWorkScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<GenerateWorkScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadPracticeData(tx, ctx.firmId, scope.clientId, scope.period);
    const due = dueCatalog(data, window.periodStart);
    const candidateIds = due.map((c) => c.id);
    const versions = [
      { id: "PRAC-GENERATE-TASKS", version: 1 },
      ...due.map((c) => ({ id: c.id, version: c.version })),
      ...data.tasks
        .filter((t) => t.periodStart === window.periodStart)
        .map((t) => ({ id: t.id, version: t.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // The period is in the hash. Two periods generate two workloads and must
      // never deduplicate into one.
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds,
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
    const due = dueCatalog(data, window.periodStart);

    /*
     * A client the firm is not serving gets no workload. Doc 02 rule 7. The
     * skip is one row for the client rather than one per catalog code, because
     * the reason is about the client and repeating it forty times buries it.
     */
    if (!isLiveClient(data.state)) {
      skips.push({
        rowId: frozen.clientId,
        reason: "out_of_scope_engagement",
        detail: `client_not_active, stage is ${data.state === null ? "unknown" : data.state.stage}`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const locked = isLockedDay(data.close.locks, window.periodEnd);
    const taskById = new Map<string, PracticeTaskRow>(data.tasks.map((t) => [t.id, t]));
    const completedCodes = new Set(
      data.tasks
        .filter((t) => t.periodStart === window.periodStart && t.state === "complete")
        .map((t) => t.catalogCode),
    );

    for (const catalog of due) {
      const rowId = taskIdOf(frozen.clientId, window.periodStart, catalog.catalogCode);

      if (locked) {
        skips.push({
          rowId,
          reason: "locked_period",
          detail: `period ending ${window.periodEnd} is locked, so ${catalog.catalogCode} was not generated`,
        });
        continue;
      }

      const prior = taskById.get(rowId);
      if (prior !== undefined && prior.manualOverride) {
        skips.push({
          rowId,
          reason: "manual_override",
          detail: `task ${catalog.catalogCode} carries manual_override`,
        });
        continue;
      }

      const content = contentFor(catalog, data.state, window.periodStart, window.periodEnd, completedCodes);

      if (prior === undefined) {
        proposals.push(insertTask(frozen, rowId, content));
        continue;
      }

      /*
       * A task somebody has already worked stands. Doc 02 rule 4. Rewriting the
       * due date or the assignee of a task with comments and time on it would
       * erase a decision a person made after the last generation.
       */
      if (prior.state === "complete" || prior.commentCount > 0 || prior.timeEntryCount > 0) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `task_exists and is in progress for ${catalog.catalogCode}`,
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
          detail: `task_exists for ${catalog.catalogCode} in ${window.periodStart}`,
        });
        continue;
      }
      // A due date that moved resets the day it was set from, which is what the
      // escalation ladder keys on. The escalation run reads that field and logs
      // the reset, so the two runs agree on when the clock restarted.
      if (changed.after.dueDate !== undefined) {
        changed.after.dueDateSetOn = window.periodEnd;
        changed.before.dueDateSetOn = prior.dueDateSetOn;
      }
      proposals.push({
        kind: "field_write",
        table: "practice_tasks",
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
      runType: "PRAC-GENERATE-TASKS",
      runVersion: 1,
    });
  },

  /** Field moves revert. A generated task stands, because people work on them. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function taskIdOf(clientId: Ulid, periodStart: string, catalogCode: string): Ulid {
  return derivedId(`${clientId}:${periodStart}:${catalogCode}`, "prc-generate-work", 0);
}

/** The catalog rows whose frequency lands in this period, in a fixed order. */
export function dueCatalog(
  data: PracticeData,
  periodStart: string,
): PracticeTaskCatalogRow[] {
  return data.catalog
    .filter((c) => c.isActive && !c.manualOverride)
    .filter((c) => frequencyLandsIn(c.frequency, periodStart))
    .sort(byCatalogCode);
}

function contentFor(
  catalog: PracticeTaskCatalogRow,
  state: PracticeStateRow | null,
  periodStart: string,
  periodEnd: string,
  completedCodes: ReadonlySet<string>,
): TaskContent {
  // The offset is counted from period end, then shifted off a weekend. Doc 02
  // rule 3 gives no holiday calendar, so Monday is the only shift there is.
  const dueDate = shiftToBusinessDay(addDays(periodEnd, catalog.dueOffsetDays));

  /*
   * Doc 02 rule 4. A predecessor that is not complete blocks the task. Blocked
   * is a real state rather than a comment, because the escalation run escalates
   * a blocked task against the blocking predecessor's owner and needs to know.
   */
  const blocked =
    catalog.predecessorCode !== null && !completedCodes.has(catalog.predecessorCode);

  const assignment = assignmentFor(catalog, state, periodStart);

  return {
    periodStart,
    periodEnd,
    catalogCode: catalog.catalogCode,
    title: catalog.title,
    kind: catalog.kind,
    role: catalog.role,
    gateCode: catalog.gateCode,
    dueDate,
    state: blocked ? "blocked" : "open",
    blockedByCode: blocked ? catalog.predecessorCode : null,
    assigneeId: assignment.assigneeId,
    assignmentReason: assignment.reason,
  };
}

/**
 * Who the work goes to.
 *
 * Preparer work to the preparer, review work to the lead. A member unavailable
 * for the whole period leaves the task unassigned with the reason recorded,
 * rather than assigned to somebody who is not there, which would show as work
 * in progress that nobody is doing.
 */
function assignmentFor(
  catalog: PracticeTaskCatalogRow,
  state: PracticeStateRow | null,
  periodStart: string,
): { assigneeId: Ulid | null; reason: string } {
  if (state === null) {
    return { assigneeId: null, reason: "No practice state row, so no roster to assign from." };
  }
  const candidate = catalog.role === "reviewer" ? state.leadId : state.preparerId;
  if (candidate === null) {
    return {
      assigneeId: null,
      reason: `No ${catalog.role} on the roster for ${periodStart}, so the task is unassigned.`,
    };
  }
  if (state.unavailableMemberIds.includes(candidate)) {
    return {
      assigneeId: null,
      reason: `The ${catalog.role} is unavailable for the whole period, so the task is unassigned.`,
    };
  }
  return {
    assigneeId: candidate,
    reason: `Assigned to the ${catalog.role} of record for this client.`,
  };
}

function insertTask(
  frozen: FrozenScope<GenerateWorkScope>,
  rowId: Ulid,
  content: TaskContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "practice_tasks",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      ...content,
      dueDateSetOn: content.periodEnd,
      escalationRung: "none",
      lastEscalatedOn: null,
      commentCount: 0,
      timeEntryCount: 0,
      completedOn: null,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}
