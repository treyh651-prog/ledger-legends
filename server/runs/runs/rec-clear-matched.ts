/**
 * REC-CLEAR-MATCHED. Clear the matched rows and close the batch with a difference.
 *
 * Spec: docs/02-run-specifications.md Module 3, and gate G03 in
 * docs/00-conventions.md, which asks that every bank and card account be
 * reconciled through period end with a difference of zero.
 *
 * REC-MATCH-TIERED decided which bank line is which register row. This run acts
 * on those decisions and does three things:
 *
 *   1. Flips the cleared flag to true on every register row whose match is
 *      confirmed, and writes the cleared date from the statement line, not from
 *      the book date. The bank decides when money moved.
 *   2. Computes the cleared ledger balance on the account through period end,
 *      which is every register row already cleared plus every row this run is
 *      about to clear.
 *   3. Writes the difference onto the batch row and closes it. Statement balance
 *      minus cleared ledger balance. Zero is reconciled. One cent is not.
 *
 * The balance is computed from the rows this run reads plus the writes it is
 * proposing, never from the state the writes would produce, because a preview
 * has to arrive at exactly the number the apply will. That is also why the
 * difference is a proposal and not a post apply recomputation.
 *
 * An unconfirmed match is not cleared. Tier 1 is confirmed on write because it
 * is identity, and tiers 2, 3, and 4 are proposals a person accepts on the
 * reconcile screen. Clearing an unaccepted tier 4 group would let the engine
 * decide a question it already reported as needing a person.
 *
 * A row carrying the manual override flag is cleared here. Doc 03 Part 6 keeps
 * a run away from a value a person set, and the person set the coding, not the
 * bank's clearing. See the override contract in NOTES.md.
 */

import { z } from "zod";
import {
  makeResult,
  isFieldWrite,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
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
import { scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { RecBatchRow, StatementLineRow, TransactionRow } from "../tables";
import {
  TIER,
  batchStateFor,
  bookOrder,
  lineOrder,
  reconciliationDiff,
} from "./rec-shared";

export const CLEAR_ERROR_CODES = {
  noBatch: "REC_NO_OPEN_BATCH",
  batchClosed: "REC_BATCH_ALREADY_CLOSED",
  missingRow: "REC_MATCHED_ROW_MISSING",
} as const;

export const clearMatchedScopeSchema = z.object({
  clientId: z.string().min(1),
  bankAccountId: z.string().min(1),
  statementId: z.string().min(1),
  /**
   * Clear tiers 2, 3, and 4 without an operator acceptance on the line. Off by
   * default. It exists so a firm that has decided it trusts exact amount inside
   * the window can say so explicitly rather than by patching the run.
   */
  clearUnconfirmed: z.boolean().default(false),
});

export type ClearMatchedScope = z.infer<typeof clearMatchedScopeSchema>;

export const recClearMatched: Run<ClearMatchedScope, Proposal> = {
  type: "REC-CLEAR-MATCHED",
  version: 1,
  // No journal entry. A cleared flag records that the bank moved money that the
  // books already recorded, so the money has been posted once already.
  writesLedger: false,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.bankAccountId}`,
  scopeSchema: clearMatchedScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ClearMatchedScope>> {
    const tx = requireTx(ctx);
    const batches = await tx.query("rec_batch_for_statement", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      bankAccountId: scope.bankAccountId,
      statementId: scope.statementId,
    });
    const batch = batches.length > 0 ? batches[0] : null;
    const lines = await tx.query("statement_lines_for_statement", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      bankAccountId: scope.bankAccountId,
      statementId: scope.statementId,
    });
    const matched = await tx.query("transactions_for_statement", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      bankAccountId: scope.bankAccountId,
      statementId: scope.statementId,
    });

    const orderedLines = lines.slice().sort(lineOrder);
    const orderedRows = matched.slice().sort(bookOrder);

    // The batch is a candidate in its own right. A statement that matched
    // nothing still produces one row of work, the difference, and a candidate
    // count of zero would hide it.
    const candidateIds = (batch === null ? [] : [batch.id])
      .concat(orderedRows.map((t) => t.id));

    const versions = [
      { id: "REC-CLEAR-MATCHED", version: 1 },
      ...(batch === null ? [] : [{ id: batch.id, version: batch.version }]),
      ...orderedLines.map((l) => ({ id: l.id, version: l.version })),
      ...orderedRows.map((t) => ({ id: t.id, version: t.version })),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: batch === null ? scope.statementId : batch.periodStart,
      periodEnd: batch === null ? scope.statementId : batch.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      // Reported for completeness. Clearing does not skip them, see the header.
      overriddenIds: orderedRows.filter((t) => t.manualOverride).map((t) => t.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const candidateCount = frozen.candidateIds.length;

    const batches = await tx.query("rec_batch_for_statement", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      bankAccountId: scope.bankAccountId,
      statementId: scope.statementId,
    });
    if (batches.length === 0) {
      // Ordering prerequisite. Matching opens the batch, clearing closes it, and
      // clearing cannot invent the statement balance the batch carries.
      errors.push({
        rowId: null,
        code: CLEAR_ERROR_CODES.noBatch,
        message: `no reconciliation batch exists for statement ${scope.statementId}, run REC-MATCH-TIERED first`,
        retryable: false,
      });
      return makeResult<Proposal>(candidateCount, [], [], errors, BigInt(0));
    }
    const batch = batches[0];
    if (batch.closedAt !== null) {
      errors.push({
        rowId: batch.id,
        code: CLEAR_ERROR_CODES.batchClosed,
        message: `reconciliation batch ${batch.id} already closed at ${batch.closedAt}`,
        retryable: false,
      });
      return makeResult<Proposal>(candidateCount, [], [], errors, BigInt(0));
    }

    const lines = await tx.query("statement_lines_for_statement", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      bankAccountId: scope.bankAccountId,
      statementId: scope.statementId,
    });
    const matched = await tx.query("transactions_for_statement", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      bankAccountId: scope.bankAccountId,
      statementId: scope.statementId,
    });
    const alreadyCleared = await tx.query("cleared_transactions_for_account", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      bankAccountId: scope.bankAccountId,
      through: batch.periodEnd,
    });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    const rowById = new Map<Ulid, TransactionRow>();
    for (const t of matched) rowById.set(t.id, t);

    /** Rows this run will clear, and the statement date to clear them at. */
    const toClear: { row: TransactionRow; on: string }[] = [];

    for (const line of lines.slice().sort(lineOrder)) {
      if (line.matchTier === null) {
        skips.push({
          rowId: line.id,
          reason: "missing_prerequisite",
          detail: `statement line ${line.id} is unmatched and stays outstanding in the difference`,
        });
        continue;
      }
      if (!line.matchConfirmed && !scope.clearUnconfirmed) {
        skips.push({
          rowId: line.id,
          reason: "ambiguous_candidate",
          detail: `match_not_confirmed, tier ${String(line.matchTier)} needs an operator acceptance before it clears`,
        });
        continue;
      }
      if (isLockedDay(locks, line.statementDate)) {
        skips.push({
          rowId: line.id,
          reason: "locked_period",
          detail: `statement date ${line.statementDate} falls inside a locked period`,
        });
        continue;
      }

      const rows = rowsForLine(line, matched);
      if (rows.length !== line.matchedTransactionCount) {
        // The match says n rows and the register produced a different number.
        // Reported rather than half applied, because clearing part of a group
        // would put a difference on the batch that no one could explain.
        errors.push({
          rowId: line.id,
          code: CLEAR_ERROR_CODES.missingRow,
          message: `statement line ${line.id} claims ${String(line.matchedTransactionCount)} matched rows and ${String(rows.length)} were found`,
          retryable: false,
        });
        continue;
      }

      for (const row of rows.slice().sort(bookOrder)) {
        if (row.cleared) {
          skips.push({
            rowId: row.id,
            reason: "already_applied",
            detail: `already_cleared on ${String(row.clearedDate)}`,
          });
          continue;
        }
        if (isLockedDay(locks, row.postedDate)) {
          skips.push({
            rowId: row.id,
            reason: "locked_period",
            detail: `posted ${row.postedDate} falls inside a locked period`,
          });
          continue;
        }
        toClear.push({ row, on: line.statementDate });
      }
    }

    for (const item of toClear.sort((a, b) => bookOrder(a.row, b.row))) {
      proposals.push(clearWrite(item.row, item.on));
    }

    // The cleared ledger balance is what is cleared now plus what this run
    // clears, counting only rows dated through period end. A balance is
    // cumulative, so the already cleared side deliberately reaches back before
    // the statement period.
    const clearingIds = new Set<Ulid>(toClear.map((c) => c.row.id));
    let clearedBalance: Cents = BigInt(0);
    for (const t of alreadyCleared) {
      if (clearingIds.has(t.id)) continue; // counted below, never twice
      clearedBalance += t.amountCents;
    }
    for (const item of toClear) {
      if (item.on > batch.periodEnd) continue;
      clearedBalance += item.row.amountCents;
    }

    const diff = reconciliationDiff(batch.statementBalanceCents, clearedBalance);
    proposals.push(closeBatchWrite(batch, clearedBalance, diff));

    // The net of this run is zero. It moves no money, it records that money the
    // books already carried has been seen by the bank.
    return makeResult<Proposal>(candidateCount, proposals, skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "REC-CLEAR-MATCHED",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      // Shape R2 throughout. Uncleared goes back to uncleared and the batch goes
      // back to open with no difference on it, which is a truthful state to
      // return to because the difference was only ever a statement of the
      // clearing this run did.
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

/** Both shapes of match: a single row, or a group that carries only a count. */
function rowsForLine(
  line: StatementLineRow,
  matched: readonly TransactionRow[],
): TransactionRow[] {
  if (line.matchTier === TIER.sumToSum) {
    return matched.filter((t) => t.statementLineId === line.id);
  }
  return matched.filter(
    (t) => t.statementLineId === line.id && t.id === line.matchedTransactionId,
  );
}

/**
 * The cleared flag and the cleared date. Two fields, neither of them coding,
 * which is what makes this write legal on an overridden row.
 */
function clearWrite(row: TransactionRow, clearedOn: string): ProposedFieldWrite {
  return {
    kind: "field_write",
    table: "transactions",
    rowId: row.id,
    before: { cleared: row.cleared, clearedDate: row.clearedDate },
    after: { cleared: true, clearedDate: clearedOn },
    provenance: { cascadeLevel: null },
  };
}

function closeBatchWrite(
  batch: RecBatchRow,
  clearedBalance: Cents,
  diff: Cents,
): ProposedFieldWrite {
  return {
    kind: "field_write",
    table: "rec_batches",
    rowId: batch.id,
    before: {
      clearedLedgerBalanceCents: batch.clearedLedgerBalanceCents,
      diffCents: batch.diffCents,
      state: batch.state,
      closedAt: batch.closedAt,
      closedByRunId: batch.closedByRunId,
    },
    after: {
      clearedLedgerBalanceCents: clearedBalance,
      diffCents: diff,
      // A batch closes either way. An out of balance close with the difference
      // on it is the record a person needs, and refusing to close would leave
      // the account with no statement of where it stands at all.
      state: batchStateFor(diff),
      closedAt: NOW_PLACEHOLDER,
      closedByRunId: RUN_ID_PLACEHOLDER,
    },
    provenance: { cascadeLevel: null },
  };
}
