/**
 * INTAKE-SEED-TASKS. Seed a new client's standard practice work.
 *
 * Spec: docs/02-run-specifications.md Module 1 and Module 10.
 *
 * What the run does. Two things, in one execution, because they are one
 * decision. First it writes the client's task catalog from the standard
 * catalog: the monthly close checklist, the quarterly review, and the annual
 * close. Second it writes the first period's task instances from that catalog,
 * so the firm opens the client and sees a workload rather than an empty board.
 *
 * The catalog is the durable half and the instances are the disposable half.
 * PRAC-GENERATE-TASKS owns every period after the first and reads the same
 * catalog rows this run wrote, which is why the task id here is derived by the
 * identical rule that run uses. A wizard finish followed by the nightly
 * generator produces one set of tasks, not two.
 *
 * Idempotency. Catalog ids are derived from the client and the catalog code.
 * Task ids are derived from the client, the period start, and the catalog code.
 * A second execution finds both sides present and reports exists on each.
 *
 * Never overwrites. There is no field write path. A catalog row somebody edited
 * after intake keeps the edit, and a task somebody already worked keeps its due
 * date and its assignee.
 *
 * Locked periods. A cutover period that is already locked gets the catalog but
 * no instances, because a task about a closed period is noise assigned to a
 * person. The catalog still lands, because the catalog is not about a period.
 *
 * SENDS. None. This run writes task rows. Nothing is transmitted.
 *
 * CONSTRAINT. No model. Due dates are integer day arithmetic off period end and
 * the frequency test is calendar arithmetic.
 */

import { z } from "zod";
import {
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
import type { PracticeTaskCatalogRow, PracticeTaskRow } from "../tables";
import { ZERO } from "./close-shared";
import { periodWindow } from "./per-shared";
import { frequencyLandsIn, shiftToBusinessDay } from "./prc-shared";
import { taskIdOf } from "./prc-generate-work";
import {
  STANDARD_TASK_CATALOG,
  loadIntakeData,
  type StandardCatalogRow,
} from "./intake-shared";

export const seedTasksScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  /**
   * The engagement scope answers. A catalog row carrying a scope key the client
   * did not answer is not seeded, because a checklist step about inventory on a
   * client with no inventory is a step somebody has to close every month for no
   * reason.
   */
  scopeKeys: z.array(z.string().min(1)).default([]),
  /** Catalog codes the firm struck at wizard time. */
  excludeCatalogCodes: z.array(z.string().min(1)).default([]),
});

export type SeedTasksScope = z.infer<typeof seedTasksScopeSchema>;

export const intakeSeedTasks: Run<SeedTasksScope, Proposal> = {
  type: "INTAKE-SEED-TASKS",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:intake-tasks`,
  scopeSchema: seedTasksScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<SeedTasksScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadIntakeData(
      tx,
      ctx.firmId,
      scope.clientId,
      scope.period,
      window.periodStart,
    );
    const wanted = wantedCatalog(scope);
    const candidateIds = [
      ...wanted.map((c) => catalogIdOf(scope.clientId, c.catalogCode)),
      ...wanted
        .filter((c) => frequencyLandsIn(c.frequency, window.periodStart))
        .map((c) => taskIdOf(scope.clientId, window.periodStart, c.catalogCode)),
    ];
    const versions = [
      { id: "INTAKE-SEED-TASKS", version: 1 },
      ...data.catalog.map((c) => ({ id: c.id, version: c.version })),
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
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [
          window.periodStart,
          [...scope.scopeKeys].sort().join("|"),
          [...scope.excludeCatalogCodes].sort().join("|"),
        ].join("/"),
      }),
      versions,
      overriddenIds: [
        ...data.catalog.filter((c) => c.manualOverride).map((c) => c.id),
        ...data.tasks.filter((t) => t.manualOverride).map((t) => t.id),
      ],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const data = await loadIntakeData(
      tx,
      frozen.firmId,
      frozen.clientId,
      frozen.input.period,
      window.periodStart,
    );
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const wanted = wantedCatalog(frozen.input);
    const catalogById = new Map<string, PracticeTaskCatalogRow>(
      data.catalog.map((c) => [c.id, c]),
    );
    const catalogByCode = new Map<string, PracticeTaskCatalogRow>(
      data.catalog.map((c) => [c.catalogCode, c]),
    );
    const taskById = new Map<string, PracticeTaskRow>(data.tasks.map((t) => [t.id, t]));

    for (const row of wanted) {
      const rowId = catalogIdOf(frozen.clientId, row.catalogCode);
      const prior = catalogById.get(rowId) ?? catalogByCode.get(row.catalogCode);
      if (prior !== undefined && prior.manualOverride) {
        skips.push({
          rowId,
          reason: "manual_override",
          detail: `catalog row ${row.catalogCode} carries manual_override`,
        });
        continue;
      }
      if (prior !== undefined) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `catalog_exists for ${row.catalogCode}`,
        });
        continue;
      }
      proposals.push(insertCatalog(frozen, rowId, row));
    }

    const locked = isLockedDay(data.close.locks, window.periodEnd);

    for (const row of wanted) {
      if (!frequencyLandsIn(row.frequency, window.periodStart)) {
        skips.push({
          rowId: taskIdOf(frozen.clientId, window.periodStart, row.catalogCode),
          reason: "out_of_scope_engagement",
          detail: `${row.frequency} work does not land in the period starting ${window.periodStart}`,
        });
        continue;
      }
      const rowId = taskIdOf(frozen.clientId, window.periodStart, row.catalogCode);
      if (locked) {
        skips.push({
          rowId,
          reason: "locked_period",
          detail: `period ending ${window.periodEnd} is locked, so ${row.catalogCode} was not instanced`,
        });
        continue;
      }
      const prior = taskById.get(rowId);
      if (prior !== undefined && prior.manualOverride) {
        skips.push({
          rowId,
          reason: "manual_override",
          detail: `task ${row.catalogCode} carries manual_override`,
        });
        continue;
      }
      if (prior !== undefined) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `task_exists for ${row.catalogCode} in ${window.periodStart}`,
        });
        continue;
      }
      proposals.push(insertTask(frozen, rowId, row, window.periodStart, window.periodEnd));
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "INTAKE-SEED-TASKS",
      runVersion: 1,
    });
  },

  /** Nothing reverts. Catalog rows and tasks are worked on by people. */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};

export function catalogIdOf(clientId: Ulid, catalogCode: string): Ulid {
  return derivedId(`${clientId}:${catalogCode}`, "intake-seed-tasks", 0);
}

/** The standard rows this scope asks for, catalog code ascending. */
export function wantedCatalog(scope: SeedTasksScope): StandardCatalogRow[] {
  const excluded = new Set(scope.excludeCatalogCodes);
  const answered = new Set(scope.scopeKeys);
  return STANDARD_TASK_CATALOG.filter((c) => !excluded.has(c.catalogCode))
    .filter((c) => c.scopeKey === null || answered.has(c.scopeKey))
    .slice()
    .sort((a, b) => (a.catalogCode < b.catalogCode ? -1 : a.catalogCode > b.catalogCode ? 1 : 0));
}

function insertCatalog(
  frozen: FrozenScope<SeedTasksScope>,
  rowId: Ulid,
  row: StandardCatalogRow,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "practice_task_catalog",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      catalogCode: row.catalogCode,
      title: row.title,
      kind: row.kind,
      role: row.role,
      scopeKey: row.scopeKey,
      gateCode: row.gateCode,
      predecessorCode: row.predecessorCode,
      dueOffsetDays: row.dueOffsetDays,
      frequency: row.frequency,
      isActive: true,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

/**
 * The first period's instance of one catalog row.
 *
 * Assignment is left empty on purpose. At intake there is no roster decision on
 * record yet, and PRAC-GENERATE-TASKS assigns from the practice state once the
 * firm has set one. Guessing an owner here would put work in somebody's queue
 * that nobody agreed to.
 */
function insertTask(
  frozen: FrozenScope<SeedTasksScope>,
  rowId: Ulid,
  row: StandardCatalogRow,
  periodStart: string,
  periodEnd: string,
): ProposedRowInsert {
  const dueDate = shiftToBusinessDay(addDays(periodEnd, row.dueOffsetDays));
  const blocked = row.predecessorCode !== null;
  return {
    kind: "row_insert",
    table: "practice_tasks",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      periodStart,
      periodEnd,
      catalogCode: row.catalogCode,
      title: row.title,
      kind: row.kind,
      role: row.role,
      gateCode: row.gateCode,
      dueDate,
      dueDateSetOn: periodEnd,
      state: blocked ? "blocked" : "open",
      blockedByCode: blocked ? row.predecessorCode : null,
      assigneeId: null,
      assignmentReason:
        "Seeded at intake before a roster was set, so the task is unassigned.",
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
