/**
 * Reversal semantics, doc 03 Part 7.
 *
 * Two worlds. Unposted changes revert to the before snapshot captured in the
 * proposal. Posted entries reverse and are never deleted or edited: undo posts a
 * mirror entry with the signs flipped and reversal_of pointing at the original.
 *
 * Dating. A reversal of an entry in an open period carries the original date. A
 * reversal of an entry in a locked period is dated the first day of the earliest
 * open period, and the source item is routed with SUS-20 so a human confirms the
 * correcting treatment.
 *
 * Undo is refused, not forced, in three cases: the run was already undone, there
 * is no open period after the locked one, or a later posted entry depends on the
 * original. Partial undo does not exist. A run is the unit of reversal.
 */

import { z } from "zod";
import {
  RUN_ERROR_CODES,
  isFieldWrite,
  isJournalEntry,
  makeResult,
  type AnyRunTypeId,
  type FrozenScope,
  type Proposal,
  type ProposedJournalEntry,
  type Run,
  type RunError,
  type RunResult,
  type Ulid,
} from "./contract";
import { applyProposals, requireTx } from "./apply-writer";
import type { RunDb } from "./db";
import { firstDayOfEarliestOpenPeriod, isLockedDay } from "./dates";
import { execute, type ExecuteOptions, type RunOutcome } from "./execute";
import { fromJsonValue, scopeHashFor } from "./ids";
import { appendEvent, proposalRowId } from "./run-log";
import type { PeriodLockRow } from "./tables";

export const SUS_LOCKED_PERIOD = "SUS-20" as const;

export const undoScopeSchema = z.object({
  originalExecutionId: z.string().min(1),
});

export type UndoScope = z.infer<typeof undoScopeSchema>;

/** Flip every sign on every line. Cents stay bigint. */
export function reverseEntry(
  entry: ProposedJournalEntry,
  entryId: Ulid | null,
): ProposedJournalEntry {
  return {
    kind: "journal_entry",
    targetId: null,
    entryDate: entry.entryDate,
    lines: entry.lines.map((line) => ({
      accountNumber: line.accountNumber,
      categoryId: line.categoryId,
      amountCents: -line.amountCents,
      memo: `reversal of ${line.memo}`,
      dimensions: { ...line.dimensions },
    })),
    reversalOf: entryId ?? undefined,
    sourceRef: { ...entry.sourceRef },
  };
}

/** Swap before and after, which is how an unposted field write reverts. */
export function revertFieldWrite(p: Proposal): Proposal {
  if (!isFieldWrite(p)) return p;
  return {
    kind: "field_write",
    table: p.table,
    rowId: p.rowId,
    before: { ...p.after },
    after: { ...p.before },
    provenance: { ...p.provenance },
  };
}

/**
 * Apply the dating table. Returns the dated plan plus any SUS-20 routings the
 * redating requires, and an error when no open period exists at all.
 */
export function applyReversalDating(
  plan: readonly Proposal[],
  locks: readonly PeriodLockRow[],
): { plan: Proposal[]; errors: RunError[] } {
  const out: Proposal[] = [];
  const errors: RunError[] = [];
  for (const p of plan) {
    if (!isJournalEntry(p) || !isLockedDay(locks, p.entryDate)) {
      out.push(p);
      continue;
    }
    const target = firstDayOfEarliestOpenPeriod(locks, p.entryDate);
    if (target === null) {
      errors.push({
        rowId: p.sourceRef.rowId,
        code: RUN_ERROR_CODES.noOpenPeriod,
        message: `no open period exists at or after ${p.entryDate}`,
        retryable: false,
      });
      continue;
    }
    out.push({ ...p, entryDate: target, redatedFromLockedPeriod: p.entryDate });
    out.push({
      kind: "suspense",
      transactionId: p.sourceRef.rowId,
      reasonCode: SUS_LOCKED_PERIOD,
      account: "1990",
      detail: `reversal redated from ${p.entryDate} to ${target}, confirm the correcting treatment`,
    });
  }
  return { plan: out, errors };
}

/**
 * Build the undo run for one original execution. Its type is
 * `<ORIGINAL>-UNDO`, it carries its own execution id, and it goes through the
 * same execute path as any other run, which is what keeps the reversal logged
 * like everything else. State lives in this closure, not in module scope, so two
 * concurrent undos cannot see each other.
 */
export function makeUndoRun<S, P>(
  original: Run<S, P>,
  originalExecutionId: string,
): Run<UndoScope, Proposal> {
  const type = `${original.type}-UNDO` as AnyRunTypeId;
  let originalProposals: Proposal[] = [];

  return {
    type,
    version: original.version,
    writesLedger: original.writesLedger,
    requiresOpenPeriod: false,
    concurrencyKey: () => `undo:${originalExecutionId}`,
    scopeSchema: undoScopeSchema,

    async resolveScope(scope, ctx): Promise<FrozenScope<UndoScope>> {
      if (scope.originalExecutionId !== originalExecutionId) {
        throw new Error("undo scope does not match the run it was built for");
      }
      const tx = requireTx(ctx);
      const rows = await tx.query("run_log_by_id", {
        firmId: ctx.firmId,
        executionId: originalExecutionId,
      });
      if (rows.length === 0) {
        throw new Error(
          `original execution ${originalExecutionId} not found for this firm`,
        );
      }
      const originalRow = rows[0];
      const items = await tx.query("run_log_items_by_execution", {
        firmId: ctx.firmId,
        executionId: originalExecutionId,
      });
      const proposals: Proposal[] = [];
      const candidateIds: Ulid[] = [];
      for (const item of items) {
        if (item.decision !== "proposed" || item.proposalJson === null) continue;
        const decoded = fromJsonValue(item.proposalJson) as Proposal;
        if (isJournalEntry(decoded)) decoded.targetId = item.journalEntryId;
        proposals.push(decoded);
        const rowId = proposalRowId(decoded);
        if (rowId && !candidateIds.includes(rowId)) candidateIds.push(rowId);
      }
      originalProposals = proposals;
      // Undo attempts count toward the scope. An original that has already been
      // undone is a different world, so the second undo gets its own key and is
      // refused on its merits rather than deduplicated into the first.
      const priorEvents = await tx.query("run_log_events_by_execution", {
        firmId: ctx.firmId,
        executionId: originalExecutionId,
      });
      const undoCount = priorEvents.filter((e) => e.event === "undone_by").length;
      const versions = [
        { id: originalRow.id, version: originalRow.runVersion },
        { id: "undo_attempts", version: undoCount },
      ];
      return {
        input: scope,
        clientId: originalRow.clientId,
        firmId: originalRow.firmId,
        periodStart: originalRow.periodStart,
        periodEnd: originalRow.periodEnd,
        candidateIds,
        scopeHash: scopeHashFor({ candidateIds, versions }),
        versions,
        overriddenIds: [],
      };
    },

    async propose(frozen, ctx): Promise<RunResult<Proposal>> {
      const tx = requireTx(ctx);
      const errors: RunError[] = [];

      // Refusal one. The original run has already been undone.
      const events = await tx.query("run_log_events_by_execution", {
        firmId: frozen.firmId,
        executionId: originalExecutionId,
      });
      if (events.some((e) => e.event === "undone_by")) {
        errors.push({
          rowId: null,
          code: RUN_ERROR_CODES.alreadyUndone,
          message: `execution ${originalExecutionId} was already undone`,
          retryable: false,
        });
      }

      // Refusal two. A later posted entry depends on an entry this run posted.
      const postedIds = originalProposals
        .filter(isJournalEntry)
        .map((p) => p.targetId)
        .filter((id): id is Ulid => id !== null);
      if (postedIds.length > 0) {
        const dependents = await tx.query("journal_entries_referencing", {
          firmId: frozen.firmId,
          clientId: frozen.clientId,
          entryIds: postedIds,
        });
        for (const dep of dependents) {
          errors.push({
            rowId: dep.id,
            code: RUN_ERROR_CODES.dependentEntry,
            message: `entry ${dep.id} already references ${String(dep.reversalOf)}`,
            retryable: false,
          });
        }
      }

      const rawPlan = await original.undoPlan(
        originalProposals as unknown as P[],
        ctx,
      );
      const locks = await tx.query("open_period_locks", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
      });
      // Refusal three lands here as a no open period error.
      const dated = applyReversalDating(rawPlan, locks);
      errors.push(...dated.errors);

      if (errors.length > 0) {
        return makeResult<Proposal>(
          frozen.candidateIds.length,
          [],
          [],
          errors,
          BigInt(0),
        );
      }

      let net = BigInt(0);
      for (const p of dated.plan) {
        if (!isJournalEntry(p)) continue;
        for (const line of p.lines) net += line.amountCents;
      }
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        dated.plan,
        [],
        [],
        net,
      );
    },

    async apply(proposals, ctx): Promise<void> {
      const tx = requireTx(ctx);
      await applyProposals(proposals, ctx, {
        runType: type,
        runVersion: original.version,
      });
      const reversed = proposals.filter(isJournalEntry).length;
      // Linkage is appended to the original execution rather than written over
      // it, because the log is insert only.
      await appendEvent(tx, {
        firmId: ctx.firmId,
        runExecutionId: originalExecutionId,
        event: "undone_by",
        attempt: 1,
        detail: `undone by ${ctx.runExecutionId}`,
        proposalCount: proposals.length,
        skipCount: 0,
        errorCount: 0,
        netCents: BigInt(0),
        entriesCreated: reversed,
        entriesReversed: reversed,
        skipCountsByReason: {},
        durationMs: 0,
        relatedRunId: ctx.runExecutionId,
        occurredAt: ctx.now.toISOString(),
      });
    },

    async undoPlan(): Promise<Proposal[]> {
      // Undoing an undo is not offered. Reapply the original run instead.
      return [];
    },
  };
}

/**
 * Undo an applied execution. The undo is itself a run, so it takes the lock,
 * writes its own log, and can be previewed first like anything else.
 */
export async function executeUndo<S, P>(
  db: RunDb,
  original: Run<S, P>,
  originalExecutionId: string,
  opts: Omit<ExecuteOptions, "previewRunId" | "requirePreviewForApply">,
): Promise<RunOutcome<Proposal>> {
  const undoRun = makeUndoRun(original, originalExecutionId);
  return execute<UndoScope, Proposal>(
    db,
    undoRun,
    { originalExecutionId },
    {
      ...opts,
      originalRunId: originalExecutionId,
      requirePreviewForApply: false,
    },
  );
}
