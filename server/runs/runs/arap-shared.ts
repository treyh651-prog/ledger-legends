/**
 * Shared arithmetic and policy resolution for the six receivable and payable
 * runs of doc 02 module 5.
 *
 * Everything here is integer arithmetic on bigint cents. There is no floating
 * point rate anywhere in this file, because a rate held as a float and then
 * multiplied by a balance produces a fee that two people cannot reproduce. A
 * rate is basis points a year, an integer, and a fee is a quotient of integers
 * rounded once, at the end, by a rule stated in one place.
 *
 * The policy resolver exists because a client may have no policy row at all. A
 * missing row is not an error and it is not a reason to refuse to age a
 * receivable, so absence resolves to the module 5 defaults and each run reads
 * the resolved object rather than the row.
 *
 * Nothing here computes a tax liability, prepares a filing, or produces a
 * notice. A late fee, an early payment discount, and a write off are
 * bookkeeping mechanics. Whether any of them is lawful or deductible is a
 * question for the client's own advisor and this code does not answer it.
 */

import type { Cents } from "../contract";
import { dayToUtcMs } from "../dates";
import type {
  ArapPolicyRow,
  AgingBucket,
  BillRow,
  CreditMemoRow,
  CustomerRow,
  InvoiceRow,
} from "../tables";

/** The two sides an aging report can cover. */
export type ArapSide = "receivable" | "payable";

export const ZERO: Cents = BigInt(0);

/**
 * The accounts the module 5 entries touch. They are resolved from the policy
 * row rather than written into the runs, because a chart is a client artifact
 * and two clients of one firm can number the same idea differently. The
 * defaults below are the numbers doc 01 gives the standard chart.
 */
export interface ArapAccounts {
  /** The receivable control account the subledger has to tie to. */
  arControl: string;
  /** Where a received customer payment sits before it is applied. */
  arClearing: string;
  allowance: string | null;
  badDebt: string | null;
  salesTax: string | null;
  lateFeeRevenue: string | null;
  apControl: string;
  apClearing: string;
  purchaseDiscount: string | null;
  vendorCredit: string | null;
}

export interface StatementMessages {
  neutral: string;
  reminder: string;
  firm: string;
  final: string;
}

/** A policy row resolved against the module 5 defaults. */
export interface ArapPolicy {
  agingBasis: "due_date" | "invoice_date";
  minimumStatementBalanceCents: Cents;
  statementType: "open_item" | "balance_forward";
  messages: StatementMessages;
  graceDays: number;
  lateFeeMinimumCents: Cents;
  lateFeeMaximumCents: Cents | null;
  suppressBelowMinimumFee: boolean;
  writeoffAgeDays: number;
  writeoffMinimumCents: Cents;
  requiredAttempts: number;
  writeoffMethod: "allowance" | "direct";
  approvalTier1Cents: Cents;
  discountBaseExcludesFreightTax: boolean;
  accounts: ArapAccounts;
}

/**
 * The wording bands doc 02 AR-BUILD-STATEMENTS names. The text is neutral by
 * design. A statement is a record of what is open, not a demand, and the final
 * band says the account is under review rather than threatening a step the firm
 * has no standing to take.
 */
export const DEFAULT_MESSAGES: StatementMessages = {
  neutral: "Thank you for your business. Open items are listed below.",
  reminder: "The items below are past their due date. Please review.",
  firm: "Several items below are well past due. Please contact us.",
  final: "This account is under review. Please contact us about the balance.",
};

/**
 * Module 5 defaults. The write off age is 180 days because that is the
 * threshold this build was asked for. Doc 02 states 365 and the difference is
 * recorded in NOTES.md rather than split between the two.
 */
export const ARAP_DEFAULTS = {
  agingBasis: "due_date" as const,
  minimumStatementBalanceCents: ZERO,
  statementType: "open_item" as const,
  graceDays: 10,
  lateFeeMinimumCents: ZERO,
  lateFeeMaximumCents: null,
  suppressBelowMinimumFee: true,
  writeoffAgeDays: 180,
  writeoffMinimumCents: BigInt(100),
  requiredAttempts: 3,
  writeoffMethod: "direct" as const,
  approvalTier1Cents: BigInt(100000),
  discountBaseExcludesFreightTax: true,
  accounts: {
    arControl: "1100",
    arClearing: "1200",
    allowance: "1150",
    badDebt: "6800",
    salesTax: "2400",
    lateFeeRevenue: "4200",
    apControl: "2000",
    apClearing: "1010",
    purchaseDiscount: "8200",
    vendorCredit: "2050",
  } as ArapAccounts,
};

/**
 * Resolve at most one policy row into the effective policy. A client with no
 * row gets every default. A client with a row gets the row, and the row is not
 * merged field by field: the columns are all not null in migration 0014, so a
 * row that exists is complete and mixing it with defaults would produce a
 * policy that is written nowhere and reproducible by nobody.
 */
export function resolvePolicy(rows: readonly ArapPolicyRow[]): ArapPolicy {
  const row = rows.length > 0 ? rows[0] : undefined;
  if (row === undefined) {
    return {
      agingBasis: ARAP_DEFAULTS.agingBasis,
      minimumStatementBalanceCents: ARAP_DEFAULTS.minimumStatementBalanceCents,
      statementType: ARAP_DEFAULTS.statementType,
      messages: DEFAULT_MESSAGES,
      graceDays: ARAP_DEFAULTS.graceDays,
      lateFeeMinimumCents: ARAP_DEFAULTS.lateFeeMinimumCents,
      lateFeeMaximumCents: ARAP_DEFAULTS.lateFeeMaximumCents,
      suppressBelowMinimumFee: ARAP_DEFAULTS.suppressBelowMinimumFee,
      writeoffAgeDays: ARAP_DEFAULTS.writeoffAgeDays,
      writeoffMinimumCents: ARAP_DEFAULTS.writeoffMinimumCents,
      requiredAttempts: ARAP_DEFAULTS.requiredAttempts,
      writeoffMethod: ARAP_DEFAULTS.writeoffMethod,
      approvalTier1Cents: ARAP_DEFAULTS.approvalTier1Cents,
      discountBaseExcludesFreightTax:
        ARAP_DEFAULTS.discountBaseExcludesFreightTax,
      accounts: { ...ARAP_DEFAULTS.accounts },
    };
  }
  return {
    agingBasis: row.agingBasis,
    minimumStatementBalanceCents: row.minimumStatementBalanceCents,
    statementType: row.statementType,
    messages: {
      neutral: row.messageNeutral ?? DEFAULT_MESSAGES.neutral,
      reminder: row.messageReminder ?? DEFAULT_MESSAGES.reminder,
      firm: row.messageFirm ?? DEFAULT_MESSAGES.firm,
      final: row.messageFinal ?? DEFAULT_MESSAGES.final,
    },
    graceDays: row.graceDays,
    lateFeeMinimumCents: row.lateFeeMinimumCents,
    lateFeeMaximumCents: row.lateFeeMaximumCents,
    suppressBelowMinimumFee: row.suppressBelowMinimumFee,
    writeoffAgeDays: row.writeoffAgeDays,
    writeoffMinimumCents: row.writeoffMinimumCents,
    requiredAttempts: row.requiredAttempts,
    writeoffMethod: row.writeoffMethod,
    approvalTier1Cents: row.approvalTier1Cents,
    discountBaseExcludesFreightTax: row.discountBaseExcludesFreightTax,
    accounts: {
      arControl: row.arControlAccount,
      arClearing: row.arClearingAccount,
      allowance: row.allowanceAccount,
      badDebt: row.badDebtAccount,
      salesTax: row.salesTaxAccount,
      lateFeeRevenue: row.lateFeeRevenueAccount,
      apControl: row.apControlAccount,
      apClearing: row.apClearingAccount,
      purchaseDiscount: row.purchaseDiscountAccount,
      vendorCredit: row.vendorCreditAccount,
    },
  };
}

/**
 * Doc 02 ARAP-REFRESH-AGING rule 1. The open balance of an invoice is what was
 * billed less what was paid, credited, and written off. It is computed here
 * rather than stored as one column, so that the four parts stay visible and a
 * disagreement between them can be seen instead of inferred.
 */
export function invoiceOpen(inv: InvoiceRow): Cents {
  return (
    inv.originalAmountCents -
    inv.appliedPaymentsCents -
    inv.appliedCreditsCents -
    inv.writtenOffCents
  );
}

/** The open balance of a bill, on the same principle as an invoice. */
export function billOpen(bill: BillRow): Cents {
  return (
    bill.originalAmountCents -
    bill.paidCents -
    bill.discountTakenCents -
    bill.creditsCents
  );
}

/** The unapplied remainder of a credit memo. */
export function creditOpen(memo: CreditMemoRow): Cents {
  return memo.amountCents - memo.appliedCents;
}

/** An invoice that is on the books and still owes something. */
export function invoiceIsOpen(inv: InvoiceRow): boolean {
  if (inv.status === "void" || inv.status === "draft") return false;
  return invoiceOpen(inv) > ZERO;
}

/** A bill that is on the books and still owes something. */
export function billIsOpen(bill: BillRow): boolean {
  if (bill.status === "void" || bill.status === "draft") return false;
  return billOpen(bill) > ZERO;
}

/**
 * The date the age of a document is measured from. Due date is the default
 * because a receivable is not late until it is due, but a client whose invoices
 * carry no meaningful due date can age from the invoice date instead, and the
 * choice belongs to the policy rather than to the run.
 */
export function basisDateOf(
  policy: ArapPolicy,
  invoiceDate: string,
  dueDate: string,
): string {
  return policy.agingBasis === "invoice_date" ? invoiceDate : dueDate;
}

/**
 * Doc 02 ARAP-REFRESH-AGING rule 3. Age is measured in whole days from the
 * basis date to the as of date. A document dated after the as of date has a
 * negative age and lands in current, which is the right answer: it is not yet
 * due and it is certainly not overdue.
 */
export function ageDaysFor(basisDate: string, asOf: string): number {
  return signedDayGap(basisDate, asOf);
}

/**
 * Whole days from the first date to the second, signed. The shared dayGap
 * helper returns an absolute value, which is the right answer for a matching
 * window and the wrong one here: a document dated four days into the future has
 * to age to minus four and not to four, or it lands in an overdue bucket while
 * it is not yet due.
 */
export function signedDayGap(from: string, to: string): number {
  return Math.round((dayToUtcMs(to) - dayToUtcMs(from)) / 86400000);
}

/**
 * The five buckets, with the boundaries stated once. A document exactly 30 days
 * past due is in the first bucket and one exactly 31 days past due is in the
 * second, so no document can fall between two buckets and none can fall in two.
 */
export function bucketFor(ageDays: number): AgingBucket {
  if (ageDays <= 0) return "current";
  if (ageDays <= 30) return "b1_30";
  if (ageDays <= 60) return "b31_60";
  if (ageDays <= 90) return "b61_90";
  return "b91_plus";
}

/** The bucket order a report prints in, and the order rows are emitted in. */
export const BUCKET_ORDER: readonly AgingBucket[] = [
  "current",
  "b1_30",
  "b31_60",
  "b61_90",
  "b91_plus",
  "credits",
  "tie",
];

/**
 * Divide two positive integers and round half away from zero, entirely in
 * bigint. Half away from zero rather than half to even, because a fee that
 * rounds one way at 0.5 and the other way at 1.5 is not something a client will
 * accept as consistent, and because the direction has to be stated somewhere
 * or four call sites will each choose their own.
 */
export function divRoundHalfAway(numerator: Cents, denominator: Cents): Cents {
  if (denominator === ZERO) return ZERO;
  const negative = numerator < ZERO !== denominator < ZERO;
  const n = numerator < ZERO ? -numerator : numerator;
  const d = denominator < ZERO ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  const rounded = r * BigInt(2) >= d ? q + BigInt(1) : q;
  return negative ? -rounded : rounded;
}

export function absCents(v: Cents): Cents {
  return v < ZERO ? -v : v;
}

/**
 * How many whole thirty day blocks a document is past due, once the grace
 * window has been allowed. Whole blocks rather than a daily proration, because
 * a fee that changes every day cannot be reconciled by a client looking at a
 * statement printed yesterday.
 *
 * With a ten day grace window, 39 days past due is zero blocks and 40 days is
 * one. The grace window is consumed first and only then does the clock start.
 */
export function feeBlocksPastGrace(ageDays: number, graceDays: number): number {
  const beyond = ageDays - graceDays;
  if (beyond <= 0) return 0;
  return Math.floor(beyond / 30);
}

/**
 * The late fee for one document, from an annualized rate in basis points.
 *
 *   fee = base * rateBp * 30 * blocks / (10000 * 365)
 *
 * The whole quotient is formed once and rounded once. Rounding each block
 * separately and adding would drift, and a fee that depends on how the
 * arithmetic was grouped is not reproducible.
 */
export function lateFeeFromRate(
  base: Cents,
  annualizedRateBp: number,
  blocks: number,
): Cents {
  if (base <= ZERO || annualizedRateBp <= 0 || blocks <= 0) return ZERO;
  const numerator =
    base * BigInt(annualizedRateBp) * BigInt(30) * BigInt(blocks);
  return divRoundHalfAway(numerator, BigInt(10000) * BigInt(365));
}

/** A flat monthly fee charged for each whole block past the grace window. */
export function lateFeeFromFlat(flatFeeCents: Cents, blocks: number): Cents {
  if (flatFeeCents <= ZERO || blocks <= 0) return ZERO;
  return flatFeeCents * BigInt(blocks);
}

/**
 * Clamp a computed fee to the policy floor and ceiling. A fee under the floor
 * is dropped rather than rounded up to it, because charging a client a minimum
 * they never agreed to is worse than charging nothing.
 */
export function clampFee(policy: ArapPolicy, fee: Cents): Cents {
  if (fee <= ZERO) return ZERO;
  if (fee < policy.lateFeeMinimumCents) {
    return policy.suppressBelowMinimumFee ? ZERO : fee;
  }
  if (policy.lateFeeMaximumCents !== null && fee > policy.lateFeeMaximumCents) {
    return policy.lateFeeMaximumCents;
  }
  return fee;
}

/** The grace window that applies to one customer, policy as the fallback. */
export function graceFor(policy: ArapPolicy, customer: CustomerRow): number {
  return customer.graceDays ?? policy.graceDays;
}

/**
 * Doc 02 AP-APPLY-DISCOUNTS rule 1. Terms are three integers and nothing is
 * parsed from free text at run time. 2/10 net 30 is 200 basis points, a ten day
 * window, and thirty net days. All three or none, which the migration enforces
 * with a check constraint and this predicate reports.
 */
export function hasDiscountTerms(bill: BillRow): boolean {
  return (
    bill.discountBps !== null &&
    bill.discountDays !== null &&
    bill.netDays !== null &&
    bill.discountBps > 0 &&
    bill.discountDays > 0
  );
}

/**
 * The amount a discount percentage applies to. Freight and tax are excluded by
 * default: a vendor offering two percent for early payment is discounting the
 * goods, and taking two percent off the sales tax the vendor merely collected
 * would understate a liability that is not the vendor's to discount.
 */
export function discountBase(policy: ArapPolicy, bill: BillRow): Cents {
  const gross = bill.originalAmountCents;
  if (!policy.discountBaseExcludesFreightTax) return gross;
  return gross - bill.freightCents - bill.taxCents;
}

/** The discount a bill earns, before any comparison to the open balance. */
export function discountAmount(policy: ArapPolicy, bill: BillRow): Cents {
  if (!hasDiscountTerms(bill)) return ZERO;
  const base = discountBase(policy, bill);
  if (base <= ZERO) return ZERO;
  return divRoundHalfAway(base * BigInt(bill.discountBps ?? 0), BigInt(10000));
}

/**
 * Whether a payment on a given day still falls inside the discount window. The
 * window runs from the bill date, inclusive of the last day, because a vendor
 * offering ten days means the tenth day counts.
 */
export function withinDiscountWindow(bill: BillRow, payDay: string): boolean {
  if (!hasDiscountTerms(bill)) return false;
  const elapsed = signedDayGap(bill.billDate, payDay);
  return elapsed >= 0 && elapsed <= (bill.discountDays ?? 0);
}

/**
 * The annualized benefit of taking a discount, in basis points a year. Two
 * percent for paying twenty days early is not a two percent gain, it is roughly
 * thirty six percent a year, and a client deciding whether to fund an early
 * payment needs the annualized figure. It is reported and never posted.
 */
export function annualizedBenefitBp(bill: BillRow): number {
  if (!hasDiscountTerms(bill)) return 0;
  const daysEarly = (bill.netDays ?? 0) - (bill.discountDays ?? 0);
  if (daysEarly <= 0) return 0;
  return Math.round(((bill.discountBps ?? 0) * 365) / daysEarly);
}

/**
 * The statement wording band for an account, chosen from the age of its oldest
 * open item. Bands are a function of age alone and never of the balance, so a
 * large current account is not spoken to as though it were delinquent.
 */
export function messageBandFor(
  oldestAgeDays: number,
): "neutral" | "reminder" | "firm" | "final_notice" {
  if (oldestAgeDays <= 30) return "neutral";
  if (oldestAgeDays <= 60) return "reminder";
  if (oldestAgeDays <= 90) return "firm";
  return "final_notice";
}

export function messageTextFor(
  policy: ArapPolicy,
  band: "neutral" | "reminder" | "firm" | "final_notice",
): string {
  switch (band) {
    case "neutral":
      return policy.messages.neutral;
    case "reminder":
      return policy.messages.reminder;
    case "firm":
      return policy.messages.firm;
    case "final_notice":
      return policy.messages.final;
  }
}

/**
 * Doc 02 AR-WRITEOFF-UNCOLLECTIBLE. Approval routing is a function of size. A
 * small balance is prepared and reviewed inside the engagement team, and a
 * balance over the tier threshold needs the partner. The run records the route
 * on the proposal and does not itself grant either approval.
 */
export function approvalRouteFor(
  policy: ArapPolicy,
  amount: Cents,
): "preparer_and_lead" | "partner" {
  return absCents(amount) > policy.approvalTier1Cents
    ? "partner"
    : "preparer_and_lead";
}

/**
 * The split of an open balance into the part that was revenue and the part that
 * was sales tax collected on the client's behalf. A write off reverses both in
 * proportion, because writing off the whole balance against bad debt would
 * leave a tax liability on the books for revenue that was never collected.
 *
 * The tax share is derived from the original invoice proportions rather than
 * from the open balance, so a partly paid invoice does not shift the mix.
 */
export function splitTax(
  inv: InvoiceRow,
  amount: Cents,
): { net: Cents; tax: Cents } {
  if (inv.taxCents <= ZERO || inv.originalAmountCents <= ZERO) {
    return { net: amount, tax: ZERO };
  }
  const tax = divRoundHalfAway(
    amount * inv.taxCents,
    inv.originalAmountCents,
  );
  return { net: amount - tax, tax };
}

/**
 * Every subset of one, two, or three invoices whose open balances sum to the
 * target within the stated tolerance, in ascending size then ascending index
 * order. Doc 02 AR-APPLY-PAYMENTS tier 3 accepts a combination only when it is
 * unique, so the caller needs the count and not just the first hit.
 *
 * The search is capped at three members and at a bounded candidate list, which
 * is a deliberate limit rather than an oversight: the number of subsets grows
 * as the cube of the candidate count, and a payment that needs four invoices
 * guessed at is a payment that needs a person to read the remittance.
 */
export function combinationsSummingTo(
  amounts: readonly Cents[],
  target: Cents,
  tolerance: Cents,
  maxCandidates = 12,
): number[][] {
  const n = Math.min(amounts.length, maxCandidates);
  const hits: number[][] = [];
  const close = (v: Cents): boolean => absCents(v - target) <= tolerance;
  for (let i = 0; i < n; i += 1) {
    if (close(amounts[i])) hits.push([i]);
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (close(amounts[i] + amounts[j])) hits.push([i, j]);
    }
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      for (let k = j + 1; k < n; k += 1) {
        if (close(amounts[i] + amounts[j] + amounts[k])) hits.push([i, j, k]);
      }
    }
  }
  return hits;
}

/**
 * Sort open documents oldest first, which is the default application order of
 * doc 02 AR-APPLY-PAYMENTS tier 4. Oldest is by basis date and the id breaks
 * the tie, so two invoices of the same date always apply in the same order and
 * a rerun produces the identical application.
 */
export function oldestFirst(
  invoices: readonly InvoiceRow[],
  policy: ArapPolicy,
): InvoiceRow[] {
  return [...invoices].sort((a, b) => {
    const da = basisDateOf(policy, a.invoiceDate, a.dueDate);
    const db = basisDateOf(policy, b.invoiceDate, b.dueDate);
    if (da !== db) return da < db ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Sum of a list of cents. */
export function sumArapCents(values: readonly Cents[]): Cents {
  let total = ZERO;
  for (const v of values) total += v;
  return total;
}

/**
 * The tolerance a multi invoice remittance is allowed to miss by: one cent for
 * each invoice named. A payer who rounds each line of a five line remittance
 * can be off by five cents in total, and refusing that payment would leave real
 * cash unapplied over an amount smaller than the postage on a letter about it.
 */
export function remittanceTolerance(invoiceCount: number): Cents {
  return BigInt(Math.max(invoiceCount, 1));
}
