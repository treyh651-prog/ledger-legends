/**
 * PER-SPLIT-LOAN. Split each cleared loan payment into interest and principal.
 *
 * Spec: docs/02-run-specifications.md Module 4 PER-SPLIT-LOANPAYMENT, and doc 04
 * Part 7 for the loan and amortization schedule tables.
 *
 * A loan payment leaves the bank as one number. On the books it is at least
 * two: interest, which is expense, and principal, which reduces the note. An
 * escrow component is a third. Nothing about that split is visible on the bank
 * feed, which is why the amortization schedule exists and why this run reads it
 * rather than deriving anything from a rate.
 *
 * The schedule is authoritative. Interest is never recomputed here. A lender
 * rounds its own way, and a payment recomputed from an annual rate lands a cent
 * or two off the lender's number every few months, so the loan balance on the
 * books drifts away from the payoff quote. The stored row is the number.
 *
 * Cleared is a prerequisite, not a nicety. A payment that has not cleared the
 * bank might still be returned, and splitting it would put interest expense on
 * the books for money that never left. An uncleared payment is skipped with
 * payment_not_cleared and picked up next time the run fires.
 *
 * Where the numbers disagree, nothing posts. A bank amount that differs from
 * the scheduled payment, or components that do not add to the payment, are
 * routed to suspense and left for a person. Plugging the difference into
 * interest would hide a fee, a rate change, or an escrow adjustment, and all
 * three are things somebody needs to see.
 */

import { z } from "zod";
import {
  makeResult,
  isFieldWrite,
  isJournalEntry,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedJournalEntry,
  type ProposedSuspenseRouting,
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
import { addDays, isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { reverseEntry, revertFieldWrite } from "../undo";
import type { LoanRow, LoanScheduleRow, TransactionRow } from "../tables";
import { abs, monthKey, periodWindow } from "./per-shared";

export const LOAN_SPLIT_ERROR_CODES = {
  missingLoan: "PER_LOAN_ROW_MISSING",
  componentsMismatch: "PER_LOAN_COMPONENTS_DO_NOT_FOOT",
} as const;

/** Doc 02 suspense codes this run can raise. */
export const LOAN_SPLIT_SUSPENSE = {
  amountVariance: "SUS-14",
  balanceVariance: "SUS-17",
} as const;

/**
 * How far from the due date a bank row may sit and still be the payment. Five
 * days each way is the same window doc 02 gives recurring matching, and a
 * payment that lands eight days late is a question rather than a match.
 */
const MATCH_DAY_WINDOW = 5;

export const splitLoanScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type SplitLoanScope = z.infer<typeof splitLoanScopeSchema>;

export const perSplitLoan: Run<SplitLoanScope, Proposal> = {
  type: "PER-SPLIT-LOANPAYMENT",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.period.slice(0, 7)}`,
  scopeSchema: splitLoanScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<SplitLoanScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const due = await tx.query("loan_schedule_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      from: window.periodStart,
      to: window.periodEnd,
    });
    const loans = await tx.query("loans_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });

    const candidateIds = due.map((s) => s.id);
    const versions = [
      { id: "PER-SPLIT-LOANPAYMENT", version: 1 },
      ...loans.map((l) => ({ id: l.id, version: l.version })),
      ...due.map((s) => ({ id: s.id, version: s.version })),
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
      overriddenIds: due.filter((s) => s.manualOverride).map((s) => s.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const due = await tx.query("loan_schedule_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: window.periodStart,
      to: window.periodEnd,
    });
    const loans = await tx.query("loans_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const loanById = new Map<Ulid, LoanRow>();
    for (const l of loans) loanById.set(l.id, l);

    // The register is read a few days either side of the period, because a
    // payment due on the last day of the month often clears on the first of
    // the next one and it is still that payment.
    const register =
      due.length === 0
        ? []
        : await tx.query("transactions_in_window", {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            from: addDays(window.periodStart, -MATCH_DAY_WINDOW),
            to: addDays(window.periodEnd, MATCH_DAY_WINDOW),
            bankAccountIds: null,
            // An overridden register row is still evidence that the bank took
            // the money. The override contract stops this run writing coding
            // onto that row, and the guard for that is the manual override
            // check below, not a narrower read.
            includeOverridden: true,
          });

    const allSchedule =
      loans.length === 0
        ? []
        : await tx.query("loan_schedule_for_loans", {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            loanIds: loans.map((l) => l.id),
          });

    /** A register row is consumed once. Two payments never claim one row. */
    const claimed = new Set<Ulid>();
    let net: Cents = BigInt(0);

    for (const row of due) {
      if (row.manualOverride) {
        skips.push({
          rowId: row.id,
          reason: "manual_override",
          detail: `schedule row ${row.id} carries manual_override`,
        });
        continue;
      }
      if (row.status === "posted") {
        skips.push({
          rowId: row.id,
          reason: "already_applied",
          detail: `already_split by entry ${String(row.postedEntryId)}`,
        });
        continue;
      }
      if (row.status !== "scheduled") {
        skips.push({
          rowId: row.id,
          reason: "superseded_version",
          detail: `schedule row is ${row.status}`,
        });
        continue;
      }

      const loan = loanById.get(row.loanId);
      if (loan === undefined) {
        errors.push({
          rowId: row.id,
          code: LOAN_SPLIT_ERROR_CODES.missingLoan,
          message: `schedule row ${row.id} points at loan ${row.loanId} which does not exist`,
          retryable: false,
        });
        continue;
      }
      if (loan.manualOverride) {
        skips.push({
          rowId: row.id,
          reason: "manual_override",
          detail: `loan ${loan.id} carries manual_override`,
        });
        continue;
      }

      const components =
        row.principalCents + row.interestCents + row.escrowCents + row.feesCents;
      if (components !== row.paymentCents) {
        // The schedule contradicts itself. Posting any part of it would put a
        // number on the books that the schedule does not support.
        proposals.push(
          suspense(
            row.id,
            LOAN_SPLIT_SUSPENSE.balanceVariance,
            `schedule row ${row.id} components add to ${components.toString()} and the payment is ${row.paymentCents.toString()}`,
          ),
        );
        errors.push({
          rowId: row.id,
          code: LOAN_SPLIT_ERROR_CODES.componentsMismatch,
          message: `schedule row ${row.id} does not foot, nothing posted`,
          retryable: false,
        });
        continue;
      }

      const matches = candidatesFor(row, register, claimed);
      if (matches.length === 0) {
        const uncleared = unclearedFor(row, register);
        skips.push({
          rowId: row.id,
          reason: "missing_prerequisite",
          detail:
            uncleared === null
              ? `no_payment_on_register within ${String(MATCH_DAY_WINDOW)} days of ${row.dueDate}`
              : `payment_not_cleared, transaction ${uncleared.id} is on the register and the bank has not confirmed it`,
        });
        continue;
      }
      if (matches.length > 1) {
        proposals.push(
          suspense(
            matches[0].id,
            LOAN_SPLIT_SUSPENSE.amountVariance,
            `${String(matches.length)} cleared register rows could be payment ${String(row.paymentNumber)} on loan ${loan.lenderName}`,
            matches.map((m) => m.id),
          ),
        );
        skips.push({
          rowId: row.id,
          reason: "ambiguous_candidate",
          detail: `multiple_register_matches, routed to suspense for a person`,
        });
        continue;
      }

      const payment = matches[0];
      // The override contract. This run links the register row to the entry it
      // produced, and that is a write, so a person's row is left alone and the
      // payment waits for them.
      if (payment.manualOverride) {
        skips.push({
          rowId: row.id,
          reason: "manual_override",
          detail: `register row ${payment.id} carries manual_override`,
        });
        continue;
      }
      if (abs(payment.amountCents) !== row.paymentCents) {
        // A bank amount that differs from the schedule is a rate change, a fee,
        // or an escrow adjustment. All three want a person, and none of them
        // wants the difference quietly pushed into interest expense.
        proposals.push(
          suspense(
            payment.id,
            LOAN_SPLIT_SUSPENSE.amountVariance,
            `bank took ${abs(payment.amountCents).toString()} and the schedule says ${row.paymentCents.toString()} for payment ${String(row.paymentNumber)}`,
            [row.id],
          ),
        );
        skips.push({
          rowId: row.id,
          reason: "ambiguous_candidate",
          detail: `bank_amount_differs_from_schedule, nothing posted`,
        });
        claimed.add(payment.id);
        continue;
      }

      const postingDay = payment.clearedDate ?? payment.postedDate;
      if (isLockedDay(locks, postingDay)) {
        skips.push({
          rowId: row.id,
          reason: "locked_period",
          detail: `clearing day ${postingDay} falls inside a locked period`,
        });
        continue;
      }

      claimed.add(payment.id);
      const entry = entryFor(loan, row, payment, postingDay);
      proposals.push(entry);
      proposals.push(markSchedulePosted(row, payment.id, entry.targetId));
      proposals.push(linkTransaction(payment, entry.targetId));
      for (const l of entry.lines) net += l.amountCents;

      // Doc 02 asks the run to check its own arithmetic against the balance the
      // schedule claims. A variance is reported, never plugged: the schedule is
      // authoritative for the split and a disagreement with its own balance
      // column means the schedule needs a person, not a correcting entry.
      const variance = balanceVariance(loan, row, allSchedule);
      if (variance !== null) {
        proposals.push(
          suspense(
            payment.id,
            LOAN_SPLIT_SUSPENSE.balanceVariance,
            variance,
            [row.id],
          ),
        );
      }
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
      runType: "PER-SPLIT-LOANPAYMENT",
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
    }
    return plan;
  },
};

/**
 * Cleared register rows that could be this payment: the right sign, the right
 * size, inside the window, and not already claimed by an earlier payment.
 *
 * The amount test is deliberately loose here and strict later. A row that is
 * near the payment is a candidate so that a variance gets reported. A row that
 * is nowhere near it is a different transaction entirely.
 */
function candidatesFor(
  row: LoanScheduleRow,
  register: readonly TransactionRow[],
  claimed: ReadonlySet<Ulid>,
): TransactionRow[] {
  const from = addDays(row.dueDate, -MATCH_DAY_WINDOW);
  const to = addDays(row.dueDate, MATCH_DAY_WINDOW);
  return register.filter(
    (t) =>
      !claimed.has(t.id) &&
      t.cleared &&
      !t.voided &&
      t.amountCents < BigInt(0) &&
      t.postedDate >= from &&
      t.postedDate <= to &&
      near(abs(t.amountCents), row.paymentCents),
  );
}

/** The same window, but rows the bank has not confirmed. Reported, not used. */
function unclearedFor(
  row: LoanScheduleRow,
  register: readonly TransactionRow[],
): TransactionRow | null {
  const from = addDays(row.dueDate, -MATCH_DAY_WINDOW);
  const to = addDays(row.dueDate, MATCH_DAY_WINDOW);
  const found = register.find(
    (t) =>
      !t.cleared &&
      !t.voided &&
      t.amountCents < BigInt(0) &&
      t.postedDate >= from &&
      t.postedDate <= to &&
      near(abs(t.amountCents), row.paymentCents),
  );
  return found ?? null;
}

/**
 * Within five percent, or within five dollars, whichever is wider. A payment
 * that moved because the rate reset is still that payment and wants a variance
 * report. A payment ten times the size is a different transaction.
 */
function near(actual: Cents, scheduled: Cents): boolean {
  const gap = abs(actual - scheduled);
  const fivePercent = abs(scheduled) / BigInt(20);
  const floor = BigInt(500);
  return gap <= (fivePercent > floor ? fivePercent : floor);
}

/**
 * Walk the loan forward through every posted payment and compare the balance
 * the schedule claims after this one. A disagreement is a sentence, not a
 * correcting entry.
 */
function balanceVariance(
  loan: LoanRow,
  row: LoanScheduleRow,
  allSchedule: readonly LoanScheduleRow[],
): string | null {
  let balance = loan.originalPrincipalCents;
  for (const s of allSchedule) {
    if (s.loanId !== loan.id) continue;
    if (s.paymentNumber > row.paymentNumber) continue;
    balance -= s.principalCents;
  }
  if (balance === row.balanceAfterCents) return null;
  return `loan ${loan.lenderName} payment ${String(row.paymentNumber)} computes a balance of ${balance.toString()} and the schedule says ${row.balanceAfterCents.toString()}`;
}

function entryFor(
  loan: LoanRow,
  row: LoanScheduleRow,
  payment: TransactionRow,
  postingDay: string,
): ProposedJournalEntry {
  const memo = `${loan.lenderName} payment ${String(row.paymentNumber)} ${monthKey(postingDay)}`;
  const lines = [];

  // Principal reduces the note. The long term account is used because it is the
  // account the loan row names as its principal; a current portion split is a
  // classification a person makes at year end, not a payment level decision.
  if (row.principalCents !== BigInt(0)) {
    lines.push({
      accountNumber: loan.principalAccountLt,
      categoryId: null,
      amountCents: row.principalCents,
      memo,
      dimensions: {},
    });
  }
  if (row.interestCents !== BigInt(0)) {
    lines.push({
      accountNumber: loan.interestAccount,
      categoryId: null,
      amountCents: row.interestCents,
      memo,
      dimensions: {},
    });
  }
  if (row.escrowCents !== BigInt(0) && loan.escrowAccount !== null) {
    lines.push({
      accountNumber: loan.escrowAccount,
      categoryId: null,
      amountCents: row.escrowCents,
      memo,
      dimensions: {},
    });
  }
  if (row.feesCents !== BigInt(0)) {
    lines.push({
      accountNumber: loan.interestAccount,
      categoryId: null,
      amountCents: row.feesCents,
      memo: `${memo} fees`,
      dimensions: {},
    });
  }
  // The credit is the cash that actually left, taken from the register row so
  // the entry closes against the account the bank debited.
  lines.push({
    accountNumber: payment.accountNumber,
    categoryId: null,
    amountCents: -row.paymentCents,
    memo,
    dimensions: {},
  });

  return {
    kind: "journal_entry",
    targetId: derivedId(`${row.id}:${payment.id}`, "per-split-loan", 0),
    entryDate: postingDay,
    lines,
    sourceRef: {
      table: "loan_schedule",
      rowId: row.id,
      version: row.version,
    },
  };
}

function markSchedulePosted(
  row: LoanScheduleRow,
  transactionId: Ulid,
  entryId: Ulid | null,
): ProposedFieldWrite {
  return {
    kind: "field_write",
    table: "loan_schedule",
    rowId: row.id,
    before: {
      status: row.status,
      matchedTransactionId: row.matchedTransactionId,
      postedEntryId: row.postedEntryId,
      postedRunId: row.postedRunId,
      postedAt: row.postedAt,
    },
    after: {
      status: "posted",
      matchedTransactionId: transactionId,
      postedEntryId: entryId,
      postedRunId: RUN_ID_PLACEHOLDER,
      postedAt: NOW_PLACEHOLDER,
    },
    provenance: { cascadeLevel: null },
  };
}

/**
 * Point the register row at the entry that explains it. Without this a person
 * looking at the payment on the register sees one number and no split.
 */
function linkTransaction(
  payment: TransactionRow,
  entryId: Ulid | null,
): ProposedFieldWrite {
  return {
    kind: "field_write",
    table: "transactions",
    rowId: payment.id,
    before: { journalEntryId: payment.journalEntryId },
    after: { journalEntryId: entryId },
    provenance: { cascadeLevel: null },
  };
}

function suspense(
  transactionId: Ulid,
  reasonCode: "SUS-14" | "SUS-17",
  detail: string,
  relatedIds?: Ulid[],
): ProposedSuspenseRouting {
  return {
    kind: "suspense",
    transactionId,
    reasonCode,
    account: "1990",
    detail,
    ...(relatedIds === undefined ? {} : { relatedIds }),
  };
}
