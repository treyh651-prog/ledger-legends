/**
 * Fixtures for the module 10 practice management tests.
 *
 * The base is the close fixture again, because loadPracticeData reads the close
 * data set for the period and the period lock rows live there. On top of it this
 * file adds the practice facts doc 02 module 10 needs and nothing in tenancy
 * carries: the client's stage, its service frequency, its roster, its escalation
 * ladder, and the catalog of standard work.
 *
 * The catalog is four rows, one per shape the generator has to handle.
 *
 * BANKREC     a checklist item due five days after period end, preparer work.
 * TIEOUT      a checklist item that depends on BANKREC, so the blocked path has
 *             a subject without a test having to invent one.
 * REVIEW      reviewer work, so the assignment split between preparer and lead
 *             is exercised by the base fixture rather than by an override.
 * ANNUAL1099  annual frequency, so a January period generates three rows and a
 *             December period generates four.
 *
 * The period is January 2026, the same window every other module uses, so one
 * client can be followed through the whole story without switching calendars.
 */

import { MemoryRunDb } from "../db-memory";
import type { Proposal, Run } from "../contract";
import { execute, type ExecuteOptions, type RunOutcome } from "../execute";
import type {
  PracticeEscalationRow,
  PracticeStateRow,
  PracticeTaskCatalogRow,
  PracticeTaskRow,
  RequestNudgeRow,
  WorkloadNoticeRow,
} from "../tables";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, lock, opts } from "./fixtures";
import { PERIOD, PERIOD_END, closeDb, request } from "./close-fixtures";

export { PERIOD, PERIOD_END };
export const DECEMBER = "2026-12-01";
export const DECEMBER_END = "2026-12-31";

export const LEAD = "USR-LEAD";
export const PREPARER = "USR-PREP";
export const PARTNER = "USR-PARTNER";

/** The practice base. One active monthly client with a four row catalog. */
export function practiceDb(): MemoryRunDb {
  const db = closeDb();
  db.seed("practice_states", [practiceState()]);
  db.seed("practice_task_catalog", standardCatalog());
  return db;
}

export function practiceState(extra: Partial<PracticeStateRow> = {}): PracticeStateRow {
  return {
    id: "PRC-A1",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    clientName: "Client A1",
    stage: "active",
    serviceFrequency: "monthly",
    leadId: LEAD,
    preparerId: PREPARER,
    partnerId: PARTNER,
    unavailableMemberIds: [],
    outOfOfficeMemberIds: [],
    escalationAssigneeDays: 1,
    escalationLeadDays: 3,
    escalationPartnerDays: 7,
    escalationAtRiskDays: 14,
    engagementPaused: false,
    nudgesPaused: false,
    atRisk: false,
    atRiskSetOn: null,
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

export function catalogRow(
  id: string,
  catalogCode: string,
  extra: Partial<PracticeTaskCatalogRow> = {},
): PracticeTaskCatalogRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    catalogCode,
    title: `Do ${catalogCode}`,
    kind: "checklist",
    role: "preparer",
    scopeKey: null,
    gateCode: null,
    predecessorCode: null,
    dueOffsetDays: 5,
    frequency: "monthly",
    isActive: true,
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

export function standardCatalog(): PracticeTaskCatalogRow[] {
  return [
    catalogRow("CAT-BANKREC", "BANKREC"),
    catalogRow("CAT-TIEOUT", "TIEOUT", {
      dueOffsetDays: 8,
      predecessorCode: "BANKREC",
    }),
    catalogRow("CAT-REVIEW", "REVIEW", {
      dueOffsetDays: 12,
      role: "reviewer",
      kind: "gate_target",
      gateCode: "G1",
    }),
    catalogRow("CAT-1099", "ANNUAL1099", {
      dueOffsetDays: 20,
      kind: "deadline",
      frequency: "annual",
    }),
  ];
}

/** A generated task, as the generator would have left it. */
export function task(
  id: string,
  catalogCode: string,
  dueDate: string,
  extra: Partial<PracticeTaskRow> = {},
): PracticeTaskRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    periodStart: PERIOD,
    periodEnd: PERIOD_END,
    catalogCode,
    title: `Do ${catalogCode}`,
    kind: "checklist",
    role: "preparer",
    gateCode: null,
    dueDate,
    dueDateSetOn: PERIOD_END,
    state: "open",
    blockedByCode: null,
    assigneeId: PREPARER,
    assignmentReason: "Assigned to the preparer of record for this client.",
    escalationRung: "none",
    lastEscalatedOn: null,
    commentCount: 0,
    timeEntryCount: 0,
    completedOn: null,
    createdByRunId: "RUNX-SEED",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

export function escalationRow(
  id: string,
  taskId: string,
  extra: Partial<PracticeEscalationRow> = {},
): PracticeEscalationRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    taskId,
    asOfDate: PERIOD_END,
    dueDate: PERIOD_END,
    daysOverdue: 0,
    rung: "assignee",
    recipientId: PREPARER,
    recipientRole: "assignee",
    priorRung: "none",
    reason: "seeded escalation",
    resetFromDueDate: null,
    resetToDueDate: null,
    createdByRunId: "RUNX-SEED",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

export function noticeRow(
  id: string,
  memberId: string,
  extra: Partial<WorkloadNoticeRow> = {},
): WorkloadNoticeRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    asOfDate: PERIOD_END,
    memberId,
    memberRole: "assignee",
    overdueCount: 1,
    oldestDueDate: PERIOD,
    oldestTaskId: null,
    maxDaysOverdue: 1,
    detail: "seeded notice",
    createdByRunId: "RUNX-SEED",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

export function nudgeRow(
  id: string,
  requestId: string,
  nudgeNumber: number,
  extra: Partial<RequestNudgeRow> = {},
): RequestNudgeRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    requestId,
    asOfDate: PERIOD_END,
    nudgeNumber,
    escalationAgeDays: 7,
    ageDays: 30,
    nextCheckOn: PERIOD_END,
    action: "nudge_due",
    detail: "seeded nudge",
    createdByRunId: "RUNX-SEED",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

/** A client owned open request, which is the only kind a nudge applies to. */
export function clientRequest(
  id: string,
  subjectKey: string,
  openedOn: string,
  extra: Parameters<typeof request>[2] = {},
) {
  return request(id, subjectKey, {
    owner: "client",
    openedOn,
    escalation: "none",
    agingDays: 0,
    ...extra,
  });
}

export function lockJanuary(db: MemoryRunDb): void {
  db.seed("period_locks", [
    ...db.all("period_locks"),
    lock("PL-JAN", FIRM_A, CLIENT_A1, PERIOD, PERIOD_END),
  ]);
}

export function practiceScope(
  period: string = PERIOD,
  clientId: string = CLIENT_A1,
): { clientId: string; period: string } {
  return { clientId, period };
}

export function previewPractice<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<RunOutcome<Proposal>> {
  return execute<S, Proposal>(db, run, scope, opts("preview", extra));
}

export async function applyPractice<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<{ preview: RunOutcome<Proposal>; applied: RunOutcome<Proposal> }> {
  const preview = await execute<S, Proposal>(db, run, scope, opts("preview", extra));
  const applied = await execute<S, Proposal>(
    db,
    run,
    scope,
    opts("apply", { ...extra, previewRunId: preview.executionId }),
  );
  return { preview, applied };
}

export function tasksOf(db: MemoryRunDb): PracticeTaskRow[] {
  return [...db.all("practice_tasks")].sort((a, b) =>
    a.catalogCode < b.catalogCode ? -1 : a.catalogCode > b.catalogCode ? 1 : 0,
  );
}

export function taskFor(db: MemoryRunDb, catalogCode: string): PracticeTaskRow | undefined {
  return tasksOf(db).find((t) => t.catalogCode === catalogCode);
}

export function escalationsOf(db: MemoryRunDb): PracticeEscalationRow[] {
  return [...db.all("practice_escalations")].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function noticesOf(db: MemoryRunDb): WorkloadNoticeRow[] {
  return [...db.all("workload_notices")].sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
}

export function nudgesOf(db: MemoryRunDb): RequestNudgeRow[] {
  return [...db.all("request_nudges")].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function shapeOf(proposals: readonly Proposal[]): string {
  return JSON.stringify(
    proposals.map((p) => ({
      kind: p.kind,
      table: "table" in p ? p.table : null,
      rowId: "rowId" in p ? p.rowId : null,
    })),
  );
}

export { ACTOR, CLIENT_A1, FIRM_A, NOW, opts };
