/**
 * PER-AMORTIZE-PREPAIDS. Release one period of every prepaid expense.
 *
 * Spec: docs/02-run-specifications.md Module 4 PER-AMORTIZE-PREPAID, and doc 04
 * Part 3 for the deferral schedule and its lines.
 *
 * A prepaid is cash spent now for a service delivered later. The payment put
 * the whole amount on the balance sheet, and this run moves one period of it to
 * expense: debit the release account, credit the prepaid account. The balance
 * left on the prepaid is the service still owed.
 *
 * The allocation table is authoritative. When deferral_lines exist for the
 * schedule they are used exactly as stored and never recomputed, because a
 * schedule that changes its own arithmetic between periods produces a prepaid
 * that never reaches zero. When the schedule has no lines this run builds the
 * table once, proposes it as row inserts, and posts the first period from it.
 * Building it here rather than leaving the schedule empty is the difference
 * between a prepaid that amortizes and a prepaid that quietly does nothing.
 *
 * Partial months on both ends are the reason the table is weighted by days
 * rather than split evenly. A twelve month policy bought on the 15th of March
 * covers seventeen days of March, eleven whole months, and fourteen days of the
 * following March. Seventeen days plus fourteen days is one month, so thirteen
 * calendar months of releases add to exactly the amount paid.
 *
 * The residual lands in the final period. Every earlier period is equal to
 * every other and the last one absorbs the rounding, which is what a person
 * reading the schedule expects and what makes the prepaid land on zero.
 */

import { z } from "zod";
import {
  makeResult,
  isFieldWrite,
  isJournalEntry,
  isRowInsert,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedJournalEntry,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import {
  applyProposals,
  requireTx,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
} from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { reverseEntry, revertFieldWrite } from "../undo";
import type { DeferralLineRow, DeferralScheduleRow } from "../tables";
import {
  monthKey,
  periodWindow,
  sliceMonths,
  weightByDays,
  type MonthSlice,
  type PeriodWindow,
} from "./per-shared";

export const PREPAID_ERROR_CODES = {
  emptyWindow: "PER_PREPAID_SERVICE_WINDOW_EMPTY",
  scheduleMismatch: "PER_PREPAID_LINES_DO_NOT_FOOT",
} as const;

/** Kinds this run releases. Deferred revenue is a different run. */
const PREPAID_KINDS = ["prepaid", "intangible_amortization"];

export const amortizePrepaidsScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type AmortizePrepaidsScope = z.infer<typeof amortizePrepaidsScopeSchema>;

export const perAmortizePrepaids: Run<AmortizePrepaidsScope, Proposal> = {
  type: "PER-AMORTIZE-PREPAID",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.period.slice(0, 7)}`,
  scopeSchema: amortizePrepaidsScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<AmortizePrepaidsScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const schedules = await tx.query("deferral_schedules_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      kinds: PREPAID_KINDS,
    });
    const lines =
      schedules.length === 0
        ? []
        : await tx.query("deferral_lines_for_schedules", {
            firmId: ctx.firmId,
            clientId: scope.clientId,
            scheduleIds: schedules.map((s) => s.id),
          });

    const candidateIds = schedules.map((s) => s.id);
    const versions = [
      { id: "PER-AMORTIZE-PREPAID", version: 1 },
      ...schedules.map((s) => ({ id: s.id, version: s.version })),
      ...lines.map((l) => ({ id: l.id, version: l.version })),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // The period is part of the hash. Two periods often see the same set of
      // rows at the same versions, and without the window in the hash the
      // second period would key to the first and be deduplicated away.
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: schedules.filter((s) => s.manualOverride).map((s) => s.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const schedules = await tx.query("deferral_schedules_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      kinds: PREPAID_KINDS,
    });
    const stored =
      schedules.length === 0
        ? []
        : await tx.query("deferral_lines_for_schedules", {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            scheduleIds: schedules.map((s) => s.id),
          });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    let net: Cents = BigInt(0);

    for (const schedule of schedules) {
      if (schedule.manualOverride) {
        skips.push({
          rowId: schedule.id,
          reason: "manual_override",
          detail: `schedule ${schedule.id} carries manual_override`,
        });
        continue;
      }
      if (schedule.status !== "active") {
        skips.push({
          rowId: schedule.id,
          reason: "missing_prerequisite",
          detail: `schedule_${schedule.status}, only an active schedule releases`,
        });
        continue;
      }
      // A document that superseded the schedule already carries the amount.
      // Releasing on top of it would expense the same service twice.
      if (schedule.linkedDocumentId !== null) {
        skips.push({
          rowId: schedule.id,
          reason: "superseded_version",
          detail: `superseded by document ${schedule.linkedDocumentId}`,
        });
        continue;
      }
      if (window.periodEnd < schedule.serviceStart) {
        skips.push({
          rowId: schedule.id,
          reason: "missing_prerequisite",
          detail: `before_start_period, service starts ${schedule.serviceStart}`,
        });
        continue;
      }
      if (window.periodStart > schedule.serviceEnd) {
        skips.push({
          rowId: schedule.id,
          reason: "already_applied",
          detail: `schedule_complete, service ended ${schedule.serviceEnd}`,
        });
        continue;
      }

      const existing = stored.filter((l) => l.scheduleId === schedule.id);
      let table: PlannedLine[];
      if (existing.length > 0) {
        const check = footing(schedule, existing);
        if (check !== null) {
          errors.push(check);
          continue;
        }
        table = existing.map(fromStored);
      } else {
        const built = buildTable(schedule);
        if ("code" in built) {
          errors.push({
            rowId: schedule.id,
            code: built.code,
            message: built.message,
            retryable: false,
          });
          continue;
        }
        table = built.lines;
        // The allocation table is written once and read forever after. It is
        // proposed as inserts rather than computed on every run so that next
        // period reads the same numbers this period used.
        for (const planned of table) {
          proposals.push(insertLine(schedule, planned));
        }
      }

      const current = table.find((l) => monthKey(l.periodEnd) === monthKey(window.periodEnd));
      if (current === undefined) {
        skips.push({
          rowId: schedule.id,
          reason: "missing_prerequisite",
          detail: `no_line_for_period ${monthKey(window.periodEnd)} on schedule ${schedule.id}`,
        });
        continue;
      }
      if (current.status === "posted") {
        skips.push({
          rowId: current.id,
          reason: "already_applied",
          detail: `already_released_this_period by entry ${String(current.postedEntryId)}`,
        });
        continue;
      }
      if (current.status === "superseded" || current.linkedDocumentId !== null) {
        skips.push({
          rowId: current.id,
          reason: "superseded_version",
          detail: `line ${current.id} was superseded and does not release`,
        });
        continue;
      }
      if (current.manualOverride) {
        skips.push({
          rowId: current.id,
          reason: "manual_override",
          detail: `line ${current.id} carries manual_override`,
        });
        continue;
      }
      if (current.amountCents === BigInt(0)) {
        skips.push({
          rowId: current.id,
          reason: "missing_prerequisite",
          detail: `zero_release, the schedule allocates nothing to this period`,
        });
        continue;
      }

      const postingDay = window.periodEnd;
      if (isLockedDay(locks, postingDay)) {
        skips.push({
          rowId: current.id,
          reason: "locked_period",
          detail: `period end ${postingDay} falls inside a locked period`,
        });
        continue;
      }

      const entry = entryFor(schedule, current, postingDay);
      proposals.push(entry);
      proposals.push(markPosted(current, entry.targetId));
      for (const l of entry.lines) net += l.amountCents;
    }

    return makeResult<Proposal>(
      frozen.candidateIds.length,
      proposals,
      skips,
      errors,
      net,
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "PER-AMORTIZE-PREPAID",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isJournalEntry(p) && p.targetId !== null) {
        plan.push(reverseEntry(p, p.targetId));
      } else if (isFieldWrite(p)) {
        plan.push(revertFieldWrite(p));
      }
      // An inserted allocation line is left in place on purpose. The table is a
      // statement of how the prepaid will amortize, not a posting, and deleting
      // it would leave the schedule unable to say what it owes.
    }
    return plan;
  },
};

/** One period of the allocation table, whether stored or just computed. */
interface PlannedLine {
  id: Ulid;
  periodNumber: number;
  periodStart: string;
  periodEnd: string;
  amountCents: Cents;
  remainingAfterCents: Cents;
  status: string;
  postedEntryId: Ulid | null;
  linkedDocumentId: Ulid | null;
  manualOverride: boolean;
  before: Record<string, unknown> | null;
}

function fromStored(row: DeferralLineRow): PlannedLine {
  return {
    id: row.id,
    periodNumber: row.periodNumber,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    amountCents: row.amountCents,
    remainingAfterCents: row.remainingAfterCents,
    status: row.status,
    postedEntryId: row.postedEntryId,
    linkedDocumentId: row.linkedDocumentId,
    manualOverride: row.manualOverride,
    before: {
      status: row.status,
      postedEntryId: row.postedEntryId,
      postedRunId: row.postedRunId,
      postedAt: row.postedAt,
    },
  };
}

interface BuildFailure {
  code: string;
  message: string;
}

/**
 * Build the allocation table from the service window. Day weighted, so the two
 * partial months at the ends add to one whole month.
 */
function buildTable(
  schedule: DeferralScheduleRow,
): { lines: PlannedLine[] } | BuildFailure {
  if (schedule.serviceEnd < schedule.serviceStart) {
    return {
      code: PREPAID_ERROR_CODES.emptyWindow,
      message: `schedule ${schedule.id} ends ${schedule.serviceEnd} before it starts ${schedule.serviceStart}`,
    };
  }
  const slices: MonthSlice[] = sliceMonths(
    schedule.serviceStart,
    schedule.serviceEnd,
  );
  const amounts = weightByDays(schedule.totalCents, slices);
  const lines: PlannedLine[] = [];
  let released: Cents = BigInt(0);
  for (let i = 0; i < slices.length; i += 1) {
    released += amounts[i];
    lines.push({
      // Derived from the schedule and the period number, so a preview and an
      // apply insert the same row and a second run collides rather than
      // duplicating the table.
      id: derivedId(`${schedule.id}:${String(i + 1)}`, "per-deferral-line", 0),
      periodNumber: slices[i].periodNumber,
      periodStart: slices[i].periodStart,
      periodEnd: slices[i].periodEnd,
      amountCents: amounts[i],
      remainingAfterCents: schedule.totalCents - released,
      status: "scheduled",
      postedEntryId: null,
      linkedDocumentId: null,
      manualOverride: false,
      before: null,
    });
  }
  return { lines };
}

/**
 * The stored table has to add to the schedule total. A table that does not is
 * reported rather than patched, because the only way to make it foot is to
 * change a number a person may have set deliberately.
 */
function footing(
  schedule: DeferralScheduleRow,
  lines: readonly DeferralLineRow[],
): RunError | null {
  const sum = lines.reduce((acc, l) => acc + l.amountCents, BigInt(0));
  if (sum === schedule.totalCents) return null;
  return {
    rowId: schedule.id,
    code: PREPAID_ERROR_CODES.scheduleMismatch,
    message: `schedule ${schedule.id} totals ${schedule.totalCents.toString()} and its lines add to ${sum.toString()}`,
    retryable: false,
  };
}

function entryFor(
  schedule: DeferralScheduleRow,
  planned: PlannedLine,
  postingDay: string,
): ProposedJournalEntry {
  const memo = `${schedule.description} ${monthKey(postingDay)}`;
  return {
    kind: "journal_entry",
    targetId: derivedId(
      `${schedule.id}:${monthKey(postingDay)}`,
      "per-amortize-prepaid",
      0,
    ),
    entryDate: postingDay,
    lines: [
      // Debit the expense the period consumed.
      {
        accountNumber: schedule.releaseAccount,
        categoryId: null,
        amountCents: planned.amountCents,
        memo,
        dimensions: {},
      },
      // Credit the prepaid asset by the same amount.
      {
        accountNumber: schedule.balanceAccount,
        categoryId: null,
        amountCents: -planned.amountCents,
        memo,
        dimensions: {},
      },
    ],
    sourceRef: {
      table: "deferral_schedules",
      rowId: schedule.id,
      version: schedule.version,
    },
  };
}

function markPosted(planned: PlannedLine, entryId: Ulid | null): ProposedFieldWrite {
  return {
    kind: "field_write",
    table: "deferral_lines",
    rowId: planned.id,
    before: planned.before ?? {
      status: "scheduled",
      postedEntryId: null,
      postedRunId: null,
      postedAt: null,
    },
    after: {
      status: "posted",
      postedEntryId: entryId,
      postedRunId: RUN_ID_PLACEHOLDER,
      postedAt: NOW_PLACEHOLDER,
    },
    // Releasing a prepaid is not a coding decision. The account was decided
    // when the schedule was created.
    provenance: { cascadeLevel: null },
  };
}

function insertLine(
  schedule: DeferralScheduleRow,
  planned: PlannedLine,
): ProposedRowInsert {
  const row: DeferralLineRow = {
    id: planned.id,
    firmId: schedule.firmId,
    clientId: schedule.clientId,
    scheduleId: schedule.id,
    scheduleVersion: schedule.version,
    periodNumber: planned.periodNumber,
    periodStart: planned.periodStart,
    periodEnd: planned.periodEnd,
    amountCents: planned.amountCents,
    remainingAfterCents: planned.remainingAfterCents,
    status: "scheduled",
    postedEntryId: null,
    postedRunId: null,
    postedAt: null,
    reversalEntryId: null,
    linkedDocumentId: null,
    manualOverride: false,
    version: 1,
  };
  return {
    kind: "row_insert",
    table: "deferral_lines",
    rowId: planned.id,
    row: row as unknown as Record<string, unknown>,
    provenance: { cascadeLevel: null },
  };
}

/** Exported for the pipeline test, which needs the same window arithmetic. */
export function prepaidWindow(period: string): PeriodWindow {
  return periodWindow(period);
}

/** Exported so a caller can tell whether a proposal set touched the table. */
export function isAllocationInsert(p: Proposal): boolean {
  return isRowInsert(p) && p.table === "deferral_lines";
}
