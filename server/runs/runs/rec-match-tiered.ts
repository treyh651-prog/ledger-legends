/**
 * REC-MATCH-TIERED. Tiered automatic matching of a bank statement to the ledger.
 *
 * Spec: docs/02-run-specifications.md Module 3, and the reconciliation identity
 * in docs/00-conventions.md gate G03.
 *
 * The statement has already been imported. Its lines are in
 * ledger.statement_lines carrying a statement id and a statement date, and this
 * run answers one question per line: which register row or rows is this line?
 *
 * Four tiers, tried in order, first tier that produces exactly one answer wins:
 *
 *   T1  Exact integer cents and the same date. This is identity, so it is
 *       written as a confirmed match.
 *   T2  Exact integer cents inside the date window, five days by default.
 *   T3  Amount inside the cent tolerance, one cent by default, plus an equal
 *       normalized vendor. The vendor test is what makes a tolerance safe.
 *   T4  One statement line against the exact sum of two to four book rows, one
 *       deposit against several invoices being the ordinary case.
 *
 * Tier order is strict and there is no scoring across tiers. If T1 finds an
 * answer, T4 is never consulted, because a same day exact amount is a better
 * explanation of a line than a coincidental sum and no arithmetic on a
 * confidence number should be able to overturn that.
 *
 * Ambiguity is never broken by the engine. If a tier finds two answers, the line
 * is reported ambiguous at that tier and no lower tier is tried. Falling through
 * would mean answering a question a person was better placed to answer, and it
 * would mean the engine had preferred a weaker explanation to a tied stronger
 * one.
 *
 * This run posts nothing. It writes the match onto the bank line and the same
 * match back onto the register row, and it opens the reconciliation batch that
 * REC-CLEAR-MATCHED later closes with a difference. None of the columns it
 * writes are coding columns, which is why a row carrying the manual override
 * flag is matched here rather than skipped: the bank either cleared that row or
 * it did not, and that fact is not the person's coding decision.
 */

import { z } from "zod";
import {
  makeResult,
  isFieldWrite,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
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
import { addDays, dayGap, isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { PeriodLockRow, StatementLineRow, TransactionRow } from "../tables";
import { abs } from "./coding-cascade";
import {
  CONFIDENCE,
  DEFAULT_CANDIDATE_POOL_CAP,
  DEFAULT_MAX_GROUP_SIZE,
  DEFAULT_TOLERANCE_CENTS,
  DEFAULT_WINDOW_DAYS,
  MAX_TOLERANCE_CENTS,
  TIER,
  bookOrder,
  idList,
  lineOrder,
  matchable,
  sameSign,
  subsetsOfSize,
  sumOf,
  type Tier,
  vendorMatches,
} from "./rec-shared";

export const MATCH_ERROR_CODES = {
  batchClosed: "REC_BATCH_ALREADY_CLOSED",
  emptyStatement: "REC_STATEMENT_HAS_NO_LINES",
  unknownAccount: "REC_UNKNOWN_BANK_ACCOUNT",
} as const;

/**
 * The statement balance arrives as a decimal string of integer cents, not as a
 * number. Doc 00 Part 1 keeps money in integer cents and a JSON number cannot
 * hold a large cents value without becoming approximate, so the scope carries
 * the digits and the run converts them once.
 */
const centsString = z.string().regex(/^-?\d{1,18}$/);

export const matchTieredScopeSchema = z.object({
  clientId: z.string().min(1),
  bankAccountId: z.string().min(1),
  statementId: z.string().min(1),
  /** "YYYY-MM", the period the statement covers. */
  statementPeriod: z.string().regex(/^\d{4}-\d{2}$/),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  statementBalanceCents: centsString,
  /** T2 and T3 window. The brief says five days, doc 02 says three. */
  windowDays: z.number().int().min(0).max(30).default(DEFAULT_WINDOW_DAYS),
  /** T3 tolerance in cents. Capped, and never applied without a vendor match. */
  toleranceCents: z
    .number()
    .int()
    .min(0)
    .max(MAX_TOLERANCE_CENTS)
    .default(DEFAULT_TOLERANCE_CENTS),
  maxGroupSize: z.number().int().min(2).max(6).default(DEFAULT_MAX_GROUP_SIZE),
  candidatePoolCap: z
    .number()
    .int()
    .min(2)
    .max(24)
    .default(DEFAULT_CANDIDATE_POOL_CAP),
});

export type MatchTieredScope = z.infer<typeof matchTieredScopeSchema>;

/** One tier's answer for one statement line. */
interface TierAnswer {
  tier: Tier;
  rows: TransactionRow[];
  diffCents: Cents;
}

export const recMatchTiered: Run<MatchTieredScope, Proposal> = {
  type: "REC-MATCH-TIERED",
  version: 1,
  // Matching posts no journal entry. It records which bank line is which book
  // row, and a link is not a debit.
  writesLedger: false,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.bankAccountId}`,
  scopeSchema: matchTieredScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<MatchTieredScope>> {
    const tx = requireTx(ctx);
    const lines = await tx.query("statement_lines_for_statement", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      bankAccountId: scope.bankAccountId,
      statementId: scope.statementId,
    });
    // The book side reaches a window either side of the statement period,
    // otherwise a check written on the last day of the period can never be
    // matched to the line that cleared it three days into the next one.
    const book = await tx.query("transactions_in_window", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      from: addDays(scope.periodStart, -scope.windowDays),
      to: addDays(scope.periodEnd, scope.windowDays),
      bankAccountIds: [scope.bankAccountId],
      // Deliberate. An overridden row is matchable, see the header.
      includeOverridden: true,
    });
    const overridden = await tx.query("overridden_transaction_ids_in_window", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      from: addDays(scope.periodStart, -scope.windowDays),
      to: addDays(scope.periodEnd, scope.windowDays),
    });

    const orderedLines = lines.slice().sort(lineOrder);
    const orderedBook = book.slice().sort(bookOrder);

    // Both sides are candidates. The statement line is the thing being decided
    // and the register row is the thing being written, so a count that named
    // only one of them would understate the work.
    const candidateIds = orderedLines
      .map((l) => l.id)
      .concat(orderedBook.map((t) => t.id));

    const versions = [
      { id: "REC-MATCH-TIERED", version: 1 },
      { id: scope.statementId, version: orderedLines.length },
      ...orderedLines.map((l) => ({ id: l.id, version: l.version })),
      ...orderedBook.map((t) => ({ id: t.id, version: t.version })),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: scope.periodStart,
      periodEnd: scope.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      // Reported, not hidden, exactly as doc 03 Part 6 rule 4 requires. These
      // are not skipped by this run and the reason is in the header.
      overriddenIds: overridden.map((o) => o.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const candidateCount = frozen.candidateIds.length;

    const accounts = await tx.query("bank_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (!accounts.some((a) => a.id === scope.bankAccountId)) {
      errors.push({
        rowId: null,
        code: MATCH_ERROR_CODES.unknownAccount,
        message: `bank account ${scope.bankAccountId} does not belong to client ${frozen.clientId}`,
        retryable: false,
      });
      return makeResult<Proposal>(candidateCount, [], [], errors, BigInt(0));
    }

    const existing = await tx.query("rec_batch_for_statement", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      bankAccountId: scope.bankAccountId,
      statementId: scope.statementId,
    });
    const openBatch = existing.length > 0 ? existing[0] : null;
    if (openBatch !== null && openBatch.closedAt !== null) {
      // A closed batch is a period of reconciliation history. Matching into it
      // would move a difference a person already signed off on.
      errors.push({
        rowId: openBatch.id,
        code: MATCH_ERROR_CODES.batchClosed,
        message: `reconciliation batch ${openBatch.id} closed at ${openBatch.closedAt} and cannot take new matches`,
        retryable: false,
      });
      return makeResult<Proposal>(candidateCount, [], [], errors, BigInt(0));
    }

    const batchId =
      openBatch !== null ? openBatch.id : derivedId(scope.statementId, "rec-batch", 0);

    const lines = await tx.query("statement_lines_for_statement", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      bankAccountId: scope.bankAccountId,
      statementId: scope.statementId,
    });
    const book = await tx.query("transactions_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: addDays(scope.periodStart, -scope.windowDays),
      to: addDays(scope.periodEnd, scope.windowDays),
      bankAccountIds: [scope.bankAccountId],
      includeOverridden: true,
    });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    if (openBatch === null) {
      // The batch is opened even when the statement matches nothing, because a
      // statement that matched nothing is exactly the case a person most needs
      // to see a difference for. An empty batch that closes with the whole
      // statement balance as its difference is a correct answer, not a failure.
      proposals.push(openBatchProposal(frozen, scope, batchId));
    } else {
      skips.push({
        rowId: openBatch.id,
        reason: "already_applied",
        detail: `reconciliation batch ${openBatch.id} is already open on this statement`,
      });
    }

    if (lines.length === 0) {
      errors.push({
        rowId: null,
        code: MATCH_ERROR_CODES.emptyStatement,
        message: `statement ${scope.statementId} has no lines on account ${scope.bankAccountId}`,
        retryable: false,
      });
      return makeResult<Proposal>(candidateCount, proposals, skips, errors, BigInt(0));
    }

    const bookById = new Map<Ulid, TransactionRow>();
    for (const t of book) bookById.set(t.id, t);

    /** Ids a match earlier in this run has already spent. */
    const consumed = new Set<Ulid>();

    for (const line of lines.slice().sort(lineOrder)) {
      if (line.matchTier !== null) {
        skips.push({
          rowId: line.id,
          reason: "already_applied",
          detail: `already_matched at tier ${String(line.matchTier)}`,
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

      const pool = eligiblePool(book, line, scope.windowDays, consumed, locks);
      if (pool.length === 0) {
        skips.push({
          rowId: line.id,
          reason: "missing_prerequisite",
          detail: `no unmatched register row on this account within ${String(scope.windowDays)} days of ${line.statementDate}`,
        });
        continue;
      }

      const answer = decide(line, pool, scope, skips);
      if (answer === null) continue;

      proposals.push(lineWrite(line, answer, batchId));
      for (const row of answer.rows) {
        consumed.add(row.id);
        proposals.push(bookWrite(row, line, answer, batchId));
      }
    }

    // Nothing is posted, so the net movement of this run is zero by
    // construction and not by arithmetic on its proposals.
    return makeResult<Proposal>(candidateCount, proposals, skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "REC-MATCH-TIERED",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) {
        // Shape R2. Every match write goes back to its before value, which
        // returns both the bank line and the register row to unmatched.
        plan.push(revertFieldWrite(p));
      }
      // The batch row insert is not withdrawn. The statement really was
      // reconciled against, and a batch with no matches on it is the honest
      // record of an attempt that found nothing.
    }
    return plan;
  },
};

/**
 * The book rows this line could be explained by. Filtered once so all four
 * tiers see the same pool and a tier cannot silently consider a row a stricter
 * tier was not allowed to.
 */
function eligiblePool(
  book: readonly TransactionRow[],
  line: StatementLineRow,
  windowDays: number,
  consumed: ReadonlySet<Ulid>,
  locks: readonly PeriodLockRow[],
): TransactionRow[] {
  return book
    .filter(
      (t) =>
        matchable(t) &&
        !consumed.has(t.id) &&
        t.bankAccountId === line.bankAccountId &&
        dayGap(t.postedDate, line.statementDate) <= windowDays &&
        !isLockedDay(locks, t.postedDate),
    )
    .sort(bookOrder);
}

/**
 * Walk the tiers in order and return the first unambiguous answer. A tie at any
 * tier stops the walk: the line is reported and no lower tier is tried.
 */
function decide(
  line: StatementLineRow,
  pool: readonly TransactionRow[],
  scope: MatchTieredScope,
  skips: Skip[],
): TierAnswer | null {
  // T1. Exact cents, same date.
  const t1 = pool.filter(
    (t) => t.amountCents === line.amountCents && t.postedDate === line.statementDate,
  );
  if (t1.length === 1) {
    return { tier: TIER.exactDate, rows: [t1[0]], diffCents: BigInt(0) };
  }
  if (t1.length > 1) {
    skips.push(ambiguous(line, TIER.exactDate, t1));
    return null;
  }

  // T2. Exact cents inside the window. The date test already happened in the
  // pool filter, so this tier is the amount test alone.
  const t2 = pool.filter((t) => t.amountCents === line.amountCents);
  if (t2.length === 1) {
    return { tier: TIER.exactWindow, rows: [t2[0]], diffCents: BigInt(0) };
  }
  if (t2.length > 1) {
    skips.push(ambiguous(line, TIER.exactWindow, t2));
    return null;
  }

  // T3. Inside the cent tolerance and the same normalized vendor. Both tests
  // are required. The tolerance alone would match unrelated money.
  const tolerance = BigInt(Math.min(scope.toleranceCents, MAX_TOLERANCE_CENTS));
  const t3 = pool.filter(
    (t) =>
      sameSign(t.amountCents, line.amountCents) &&
      abs(t.amountCents - line.amountCents) <= tolerance &&
      vendorMatches(line, t),
  );
  if (t3.length === 1) {
    return {
      tier: TIER.tolerantVendor,
      rows: [t3[0]],
      diffCents: line.amountCents - t3[0].amountCents,
    };
  }
  if (t3.length > 1) {
    skips.push(ambiguous(line, TIER.tolerantVendor, t3));
    return null;
  }

  // T4. One line against the exact sum of a group. Same sign throughout, so a
  // deposit is never explained by netting a refund against two receipts.
  const groupPool = pool.filter((t) => sameSign(t.amountCents, line.amountCents));
  if (groupPool.length > scope.candidatePoolCap) {
    skips.push({
      rowId: line.id,
      reason: "ambiguous_candidate",
      detail: `candidate_pool_over_cap, ${String(groupPool.length)} same sign rows within the window exceeds the cap of ${String(scope.candidatePoolCap)}, group matching not attempted`,
    });
    return null;
  }

  const groups: TransactionRow[][] = [];
  for (let size = 2; size <= scope.maxGroupSize; size += 1) {
    if (size > groupPool.length) break;
    for (const subset of subsetsOfSize(groupPool, size)) {
      if (sumOf(subset) === line.amountCents) groups.push(subset);
    }
    // Smallest group that explains the line wins. Two invoices summing to a
    // deposit is a better explanation than four, and if a group of two exists
    // there is no reason to consider a group of three that contains it.
    if (groups.length > 0) break;
  }

  if (groups.length === 1) {
    return { tier: TIER.sumToSum, rows: groups[0], diffCents: BigInt(0) };
  }
  if (groups.length > 1) {
    skips.push({
      rowId: line.id,
      reason: "ambiguous_candidate",
      detail: `tier ${String(TIER.sumToSum)} found ${String(groups.length)} distinct groups summing to ${line.amountCents.toString()} cents, no match written`,
    });
    return null;
  }

  skips.push({
    rowId: line.id,
    reason: "missing_prerequisite",
    detail: `no tier explains statement line ${line.id} for ${line.amountCents.toString()} cents on ${line.statementDate}`,
  });
  return null;
}

function ambiguous(
  line: StatementLineRow,
  tier: Tier,
  found: readonly TransactionRow[],
): Skip {
  return {
    rowId: line.id,
    reason: "ambiguous_candidate",
    detail: `tier ${String(tier)} found ${String(found.length)} register rows for statement line ${line.id}, candidates considered: ${idList(found.map((f) => f.id))}`,
  };
}

function openBatchProposal(
  frozen: FrozenScope<MatchTieredScope>,
  scope: MatchTieredScope,
  batchId: Ulid,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "rec_batches",
    rowId: batchId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      bankAccountId: scope.bankAccountId,
      statementId: scope.statementId,
      statementPeriod: scope.statementPeriod,
      periodStart: scope.periodStart,
      periodEnd: scope.periodEnd,
      statementBalanceCents: BigInt(scope.statementBalanceCents),
      // REC-CLEAR-MATCHED fills these three in. An open batch has no difference
      // yet, and writing a zero here would read as reconciled.
      clearedLedgerBalanceCents: null,
      diffCents: null,
      state: "open",
      openedBy: frozen.clientId,
      openedAt: NOW_PLACEHOLDER,
      openedByRunId: RUN_ID_PLACEHOLDER,
      closedAt: null,
      closedByRunId: null,
      version: 1,
    },
    provenance: { cascadeLevel: null },
  };
}

/** The match, written onto the bank line. */
function lineWrite(
  line: StatementLineRow,
  answer: TierAnswer,
  batchId: Ulid,
): ProposedFieldWrite {
  const group = answer.tier === TIER.sumToSum;
  return {
    kind: "field_write",
    table: "statement_lines",
    rowId: line.id,
    before: {
      matchTier: line.matchTier,
      matchConfidence: line.matchConfidence,
      matchDiffCents: line.matchDiffCents,
      matchConfirmed: line.matchConfirmed,
      matchedTransactionId: line.matchedTransactionId,
      matchedTransactionCount: line.matchedTransactionCount,
      recBatchId: line.recBatchId,
      matchedByRunId: line.matchedByRunId,
    },
    after: {
      matchTier: answer.tier,
      matchConfidence: CONFIDENCE[answer.tier],
      matchDiffCents: answer.diffCents,
      // Tier 1 is identity and is confirmed on write. Every other tier is a
      // proposal a person accepts on the reconcile screen, which is what doc 02
      // means by a link requiring operator acceptance.
      matchConfirmed: answer.tier === TIER.exactDate,
      matchedTransactionId: group ? null : answer.rows[0].id,
      matchedTransactionCount: answer.rows.length,
      recBatchId: batchId,
      matchedByRunId: RUN_ID_PLACEHOLDER,
    },
    provenance: { cascadeLevel: null },
  };
}

/**
 * The same match, written back onto the register row.
 *
 * Every field here is a reconciliation field. Not one of them is a category, a
 * class, a suspense reason, or a cascade level, which is why this write is legal
 * on a row carrying the manual override flag.
 */
function bookWrite(
  row: TransactionRow,
  line: StatementLineRow,
  answer: TierAnswer,
  batchId: Ulid,
): ProposedFieldWrite {
  return {
    kind: "field_write",
    table: "transactions",
    rowId: row.id,
    before: {
      statementId: row.statementId,
      statementLineId: row.statementLineId,
      statementDate: row.statementDate,
      matchTier: row.matchTier,
      matchConfidence: row.matchConfidence,
      recBatchId: row.recBatchId,
    },
    after: {
      statementId: line.statementId,
      statementLineId: line.id,
      statementDate: line.statementDate,
      matchTier: answer.tier,
      matchConfidence: CONFIDENCE[answer.tier],
      recBatchId: batchId,
    },
    provenance: { cascadeLevel: null },
  };
}
