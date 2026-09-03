/**
 * Shared reading and arithmetic for module 8, the reporting runs.
 *
 * Spec: docs/02-run-specifications.md Module 8 Reporting.
 *
 * Four runs assemble a package, flag variances against budget, rebuild a
 * thirteen week cash forecast, and compose a period narrative. All four are
 * readers of the ledger and writers of report rows only. Not one of them
 * proposes a journal entry, which is the property that lets them work on a
 * locked period: doc 03 Part 7 says a locked period refuses a ledger write, and
 * a run that never writes the ledger has nothing to refuse.
 *
 * Three things live here rather than in the four run files.
 *
 * 1. One read. loadReportData reads the close data set once and adds the rows
 *    module 8 needs and module 6 did not: the gate results, the receivable and
 *    payable documents, the budgets, the thresholds, the approved payroll, and
 *    whatever report rows already exist. A run that reads the same table twice
 *    can see two answers, so every reporting run takes one snapshot and works
 *    from it.
 *
 * 2. One scope discriminator. Every reporting run puts the period and the
 *    ledger fingerprint in its scope hash. The period is there because a report
 *    is a statement about one period and two periods must never collide. The
 *    fingerprint is there because a rebuild after somebody posts an entry has to
 *    produce a fresh report rather than a stale deduplication hit, which is the
 *    same reasoning CLOSE-LOCK-PERIOD used in NOTES.md entry 93.
 *
 * 3. One arithmetic vocabulary. Statement blocks, section catalog, week windows,
 *    basis point variance, and the diff used to rewrite an existing report row.
 *
 * CONSTRAINT. No model anywhere in this module. Every figure below is either a
 * ledger balance, a stored threshold a person set, or an integer arithmetic
 * result of the two. The collection curve in the forecast is a stated rule about
 * due dates, not a fitted parameter.
 *
 * COMPLIANCE. Nothing here computes a tax figure, states an opinion, or offers
 * assurance. The narrative templates are descriptive sentences about figures
 * already on the books.
 */

import type { Cents, Ulid } from "../contract";
import type { RunTx } from "../db";
import { canonicalJson, sha256Hex } from "../ids";
import { addDays } from "../dates";
import type {
  AgingSnapshotRow,
  BillRow,
  BudgetRow,
  BudgetThresholdRow,
  CashForecastRunRow,
  CashForecastWeekRow,
  CloseGateResultRow,
  InvoiceRow,
  PayrollApprovalRow,
  PeriodLockRow,
  RecurringTemplateRow,
  TransactionRow,
  ReportAuditEventRow,
  ReportNarrativeRow,
  ReportPackageRow,
  ReportSectionRow,
  ReportVarianceRow,
} from "../tables";
import { periodWindow } from "./per-shared";
// One absolute value helper for the whole codebase. A second copy here would be
// a second definition of the same idea, free to drift from the first.
import { absCents } from "./arap-shared";

export { absCents };

import {
  ZERO,
  balanceOf,
  balancesBetween,
  blockOf,
  isBalanceSheet,
  isIncomeStatement,
  loadCloseData,
  priorDayOf,
  type CloseData,
} from "./close-shared";

/** Thirteen weeks, stated once. Doc 02 RPT-REBUILD-FORECAST step 1. */
export const HORIZON_WEEKS = 13;

/** Seven days a week. Named so the week arithmetic reads as a rule. */
export const DAYS_PER_WEEK = 7;

/** D7 retention. Seven years from the period end, in whole years. */
export const RETENTION_YEARS = 7;

/**
 * Default variance thresholds.
 *
 * Two conditions, not one. The percentage keeps small accounts from shouting
 * and the floor keeps large accounts from shouting over rounding. Doc 02 states
 * the pair, the brief states the percentage as ten percent, and both are
 * overridable per account. See NOTES.md entry 99.
 */
export const DEFAULT_VARIANCE_THRESHOLD_BP = 1000;
export const DEFAULT_VARIANCE_FLOOR_CENTS = 50000n;

/** One basis point denominator, stated once so no call site writes 10000. */
export const BP_SCALE = 10000n;

/** Doc 02 RPT-COMPOSE-NARRATIVE. A suspense item older than this is named. */
export const SUSPENSE_AGE_DAYS = 30;

/** Days back the narrative looks for the transaction under a suspense item. */
export const SUSPENSE_LOOKBACK_DAYS = 400;

/**
 * The section catalog, in the order a package prints.
 *
 * The order is fixed and does not depend on what a period happens to contain.
 * A section that cannot be rendered is written with status omitted and a
 * reason, because a reader notices a section that says it is missing and does
 * not notice one that is simply absent.
 */
export interface SectionSpec {
  sequence: number;
  code: string;
  title: string;
}

export const SECTION_CATALOG: readonly SectionSpec[] = [
  { sequence: 1, code: "COVER", title: "Cover" },
  { sequence: 2, code: "BALANCE_SHEET", title: "Balance Sheet" },
  { sequence: 3, code: "INCOME_STATEMENT", title: "Income Statement" },
  { sequence: 4, code: "CASH_FLOW", title: "Statement of Cash Flows" },
  { sequence: 5, code: "STATEMENT_OF_EQUITY", title: "Statement of Equity" },
  { sequence: 6, code: "AR_AGING", title: "Accounts Receivable Aging" },
  { sequence: 7, code: "AP_AGING", title: "Accounts Payable Aging" },
  { sequence: 8, code: "NOTES", title: "Notes" },
  { sequence: 9, code: "CHANGE_LOG", title: "Change Log" },
];

/** Everything module 8 reads, read once. */
export interface ReportData {
  close: CloseData;
  firmId: Ulid;
  clientId: Ulid;
  periodStart: string;
  periodEnd: string;
  /** The active lock covering this period, or null while the period is open. */
  lock: PeriodLockRow | null;
  gates: readonly CloseGateResultRow[];
  invoices: readonly InvoiceRow[];
  bills: readonly BillRow[];
  budgets: readonly BudgetRow[];
  thresholds: readonly BudgetThresholdRow[];
  payroll: readonly PayrollApprovalRow[];
  /**
   * Generated entry templates only. A transaction match template does not
   * create cash, it recognises cash that already moved, so it is not a forecast
   * input and is filtered out here rather than in the forecast run.
   */
  recurringTemplates: readonly RecurringTemplateRow[];
  /**
   * Transactions reaching back beyond the period, so a suspense item raised
   * months ago can still be aged. The close data window stops at the period
   * start, which is exactly where an old suspense item stops being visible.
   */
  suspenseTransactions: readonly TransactionRow[];
  packages: readonly ReportPackageRow[];
  variances: readonly ReportVarianceRow[];
  forecasts: readonly CashForecastRunRow[];
  narratives: readonly ReportNarrativeRow[];
  /** The module's whole delivery surface. Two actions, and nobody is emailed. */
  auditEvents: readonly ReportAuditEventRow[];
  /** Balances inside the prior period, for the comparison column. */
  priorInPeriod: Map<string, Cents>;
  /** True when any ledger line predates this period. */
  comparisonAvailable: boolean;
  /** Hash of the ledger rows inside the period. Part of every scope hash here. */
  fingerprint: string;
}

export async function loadReportData(
  tx: RunTx,
  firmId: Ulid,
  clientId: Ulid,
  period: string,
): Promise<ReportData> {
  const close = await loadCloseData(tx, firmId, clientId, period);
  const key = { firmId, clientId };
  const gates = await tx.query("close_gate_results_for_period", {
    ...key,
    periodStart: close.periodStart,
  });
  const invoices = await tx.query("invoices_for_client", key);
  const bills = await tx.query("bills_for_client", key);
  const budgets = await tx.query("budgets_for_period", {
    ...key,
    periodStart: close.periodStart,
  });
  const thresholds = await tx.query("budget_thresholds_for_client", key);
  const payroll = await tx.query("payroll_approvals_for_client", key);
  const templates = await tx.query("recurring_templates_for_client", key);
  const suspenseTransactions = await tx.query("transactions_in_window", {
    ...key,
    from: addDays(close.periodEnd, -SUSPENSE_LOOKBACK_DAYS),
    to: close.periodEnd,
    bankAccountIds: null,
    includeOverridden: true,
  });
  const packages = await tx.query("report_packages_for_client", key);
  const variances = await tx.query("report_variances_for_period", {
    ...key,
    periodStart: close.periodStart,
  });
  const forecasts = await tx.query("cash_forecast_runs_for_client", key);
  const narratives = await tx.query("report_narratives_for_client", key);
  const auditEvents = await tx.query("report_audit_events_for_client", key);

  // The prior period, one month back from this one. The comparison column is a
  // statement about the period before this, so it is computed here once rather
  // than by each section that wants it.
  const priorEnd = priorDayOf(close.periodStart);
  const priorWindow = periodWindow(priorEnd);
  const priorInPeriod = balancesBetween(
    close.lines,
    priorWindow.periodStart,
    priorWindow.periodEnd,
  );
  const comparisonAvailable = close.lines.some((l) => {
    const entry = close.entries.find((e) => e.id === l.entryId);
    return entry !== undefined && entry.entryDate < close.periodStart;
  });

  return {
    close,
    firmId,
    clientId,
    periodStart: close.periodStart,
    periodEnd: close.periodEnd,
    lock: lockForPeriod(close.locks, close.periodStart),
    gates,
    invoices,
    bills,
    budgets,
    thresholds,
    payroll,
    recurringTemplates: templates.filter((t) => t.matchKind === "generated_entry"),
    suspenseTransactions,
    packages,
    variances,
    forecasts,
    narratives,
    auditEvents,
    priorInPeriod,
    comparisonAvailable,
    fingerprint: close.fingerprint,
  };
}

/**
 * The active lock whose window is this period.
 *
 * open_period_locks already drops lifted locks, so a row here means the period
 * is closed. A locked period is the normal case for reporting and an open one
 * gets a watermark, per doc 02 rule 1.
 */
export function lockForPeriod(
  locks: readonly PeriodLockRow[],
  periodStart: string,
): PeriodLockRow | null {
  for (const lock of locks) {
    if (lock.periodStart === periodStart && lock.status === "locked") return lock;
  }
  return null;
}

/**
 * Doc 02 rule 1. An open period is still packaged, and the watermark says so.
 *
 * Null once the period is locked, because a watermark on a closed period would
 * be a false statement about figures that cannot move.
 */
export function reportingWatermark(data: ReportData): string | null {
  if (data.lock !== null) return null;
  return "DRAFT. Period not closed.";
}

/**
 * The scope hash discriminator every reporting run shares.
 *
 * The period comes first so two periods can never produce the same string, and
 * the fingerprint follows so a posting inside the period changes the hash. The
 * run type is on the end because two different reporting runs over the same
 * period and the same ledger are still two different runs.
 */
export function reportingDiscriminator(
  periodStart: string,
  fingerprint: string,
  runType: string,
): string {
  return `${periodStart}:${fingerprint}:${runType}`;
}

/** Cents as a decimal string. jsonb has no bigint, so a snapshot carries text. */
export function centsStr(value: Cents): string {
  return value.toString();
}

/**
 * D7 retention. The clock starts at the period end and runs seven years, so a
 * package built late is held from the period it describes rather than from the
 * day somebody happened to build it. See docs/05-decisions.md D7.
 */
export function retentionUntil(periodEnd: string): string {
  const [y, m, d] = periodEnd.split("-");
  const year = Number(y) + RETENTION_YEARS;
  return `${String(year).padStart(4, "0")}-${m}-${d}`;
}

/** One week of the forecast horizon. */
export interface WeekWindow {
  weekNumber: number;
  weekStart: string;
  weekEnd: string;
}

/**
 * Thirteen consecutive seven day windows from the start date.
 *
 * Weeks are counted from the start date rather than snapped to a calendar
 * Monday. A forecast that begins on the day after period end and then jumps to
 * the next Monday has a first week of an unstated length, and a reader who adds
 * up the weeks would be off by that gap.
 */
export function weekWindows(startDate: string): WeekWindow[] {
  const out: WeekWindow[] = [];
  for (let i = 0; i < HORIZON_WEEKS; i += 1) {
    const weekStart = addDays(startDate, i * DAYS_PER_WEEK);
    out.push({
      weekNumber: i + 1,
      weekStart,
      weekEnd: addDays(weekStart, DAYS_PER_WEEK - 1),
    });
  }
  return out;
}

/** The week a date lands in, or null when it falls outside the horizon. */
export function weekOf(windows: readonly WeekWindow[], day: string): WeekWindow | null {
  for (const w of windows) {
    if (day >= w.weekStart && day <= w.weekEnd) return w;
  }
  return null;
}

/**
 * The threshold pair that applies to one account.
 *
 * A row naming the account wins, the client default is the fallback, and the
 * constants above are the last resort. Precedence is resolved here once so no
 * two runs can disagree about which threshold a flag was measured against.
 */
export interface ThresholdPair {
  floorCents: Cents;
  thresholdBp: number;
  source: "account_override" | "client_default" | "system_default";
}

export function resolveThreshold(
  thresholds: readonly BudgetThresholdRow[],
  accountNumber: string,
): ThresholdPair {
  let fallback: ThresholdPair = {
    floorCents: DEFAULT_VARIANCE_FLOOR_CENTS,
    thresholdBp: DEFAULT_VARIANCE_THRESHOLD_BP,
    source: "system_default",
  };
  for (const t of thresholds) {
    if (t.accountNumber === accountNumber) {
      return {
        floorCents: t.varianceFloorCents,
        thresholdBp: t.varianceThresholdBp,
        source: "account_override",
      };
    }
    if (t.accountNumber === null) {
      fallback = {
        floorCents: t.varianceFloorCents,
        thresholdBp: t.varianceThresholdBp,
        source: "client_default",
      };
    }
  }
  return fallback;
}

/**
 * Variance as basis points of the budget, rounded half away from zero.
 *
 * Null when the budget is zero. There is no percentage of nothing, and a zero
 * returned there would read as no variance when the truth is unbudgeted
 * activity. Doc 00 Part 5 states the rounding rule.
 */
export function varianceBpOf(varianceCents: Cents, budgetCents: Cents): number | null {
  if (budgetCents === ZERO) return null;
  const numerator = varianceCents * BP_SCALE;
  const denominator = absCents(budgetCents);
  const negative = numerator < ZERO;
  const magnitude = absCents(numerator);
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return Number(negative ? -rounded : rounded);
}

/**
 * Whether a variance on this account reads as favorable or unfavorable.
 *
 * The ledger sign is not the answer by itself. Revenue is a credit, so revenue
 * above budget is a more negative number, and calling that unfavorable would be
 * exactly backwards. Direction is read from the account block: on a revenue or
 * other income account a credit variance is favorable, and on a cost account a
 * debit variance is unfavorable.
 */
export function varianceDirection(
  accountNumber: string,
  varianceCents: Cents,
): "favorable" | "unfavorable" | "neutral" {
  if (varianceCents === ZERO) return "neutral";
  const block = blockOf(accountNumber);
  if (block === "revenue") {
    return varianceCents < ZERO ? "favorable" : "unfavorable";
  }
  if (block === "cogs" || block === "opex") {
    return varianceCents > ZERO ? "unfavorable" : "favorable";
  }
  // The eight thousand block holds other income and other expense together, so
  // the block does not say which way is good. Such an account is reported
  // neutral rather than guessed at, and the figures are still on the row for a
  // reader who knows what the account is.
  return "neutral";
}

/**
 * The accounts a variance report covers.
 *
 * Income statement accounts only, and never a memo account. A budget against a
 * balance sheet account is a cash plan and not a period comparison, and doc 00
 * Part 3 puts the nine thousand block outside published statements.
 */
export function isVarianceAccount(accountNumber: string): boolean {
  return isIncomeStatement(accountNumber) && !isMemoAccount(accountNumber);
}

/** Doc 00 Part 3. The nine thousand block never appears on a statement. */
export function isMemoAccount(accountNumber: string): boolean {
  return accountNumber >= "9000";
}

/** Doc 00 Part 3. The one thousand block through 1099 is cash. */
export function isCashAccount(accountNumber: string): boolean {
  return blockOf(accountNumber) === "cash";
}

/** Every published account, in account number order, memo accounts dropped. */
export function publishedAccounts(data: ReportData): readonly string[] {
  return data.close.chart
    .filter((a) => !isMemoAccount(a.accountNumber))
    .filter((a) => isBalanceSheet(a.accountNumber) || isIncomeStatement(a.accountNumber))
    .map((a) => a.accountNumber);
}

/** The chart name of an account, or the number itself when the chart is silent. */
export function accountNameOf(data: ReportData, accountNumber: string): string {
  const row = data.close.chart.find((a) => a.accountNumber === accountNumber);
  return row === undefined ? accountNumber : row.name;
}

/** Sum of the balances of every cash account in a balance map. */
export function cashBalanceOf(
  data: ReportData,
  balances: Map<string, Cents>,
): Cents {
  let total = ZERO;
  for (const account of data.close.chart) {
    if (!isCashAccount(account.accountNumber)) continue;
    total += balanceOf(balances, account.accountNumber);
  }
  return total;
}

/**
 * The open balance of a receivable, in the sign the forecast wants.
 *
 * Original plus tax, less what has been paid, credited, or written off. Positive
 * means money still owed to the client. Doc 02 module 7 states the same
 * arithmetic for the aging, and the two must not disagree.
 */
export function invoiceOpenCents(invoice: InvoiceRow): Cents {
  return (
    invoice.originalAmountCents +
    invoice.taxCents -
    invoice.appliedPaymentsCents -
    invoice.appliedCreditsCents -
    invoice.writtenOffCents
  );
}

/** The open balance of a payable. Positive means money still owed by the client. */
export function billOpenCents(bill: BillRow): Cents {
  return (
    bill.originalAmountCents +
    bill.freightCents +
    bill.taxCents -
    bill.paidCents -
    bill.discountTakenCents -
    bill.creditsCents
  );
}

/**
 * The day a payable is expected to leave the bank.
 *
 * The due date, unless the bill carries a discount whose window closes earlier,
 * in which case the discount date is the answer. A two percent discount for
 * paying twenty days early is worth far more than twenty days of float, so the
 * rule is to take it, and the forecast has to show the cash leaving when it
 * actually leaves. See NOTES.md entry 108.
 */
export function billPaymentDay(bill: BillRow): string {
  if (bill.discountBps === null || bill.discountDays === null) return bill.dueDate;
  if (bill.discountBps <= 0) return bill.dueDate;
  const discountDay = addDays(bill.billDate, bill.discountDays);
  return discountDay < bill.dueDate ? discountDay : bill.dueDate;
}

/** Aging rows for one side at one date, in the order the aging run wrote them. */
export function agingFor(
  data: ReportData,
  side: "receivable" | "payable",
  asOfDate: string,
): AgingSnapshotRow[] {
  return data.close.aging.filter(
    (a) => a.side === side && a.asOfDate === asOfDate,
  );
}

/** Gate rows that failed, gate code ascending. */
export function failedGates(data: ReportData): CloseGateResultRow[] {
  return data.gates
    .filter((g) => g.outcome === "fail")
    .slice()
    .sort((a, b) => (a.gateCode < b.gateCode ? -1 : a.gateCode > b.gateCode ? 1 : 0));
}

/** Checksum of any snapshot, computed the one way the whole codebase computes it. */
export function checksumOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * The fields that moved between a stored report row and the content a rerun
 * computed.
 *
 * A rerun that found nothing moved produces no field write at all, which is what
 * turns a second execution into the no op doc 03 Part 4 requires. Bigints,
 * strings, booleans and nulls compare by value. Arrays and objects compare by
 * canonical JSON, because a jsonb snapshot is equal when its content is equal
 * and not when it happens to be the same object.
 */
export function changedFieldsOf<T extends Record<string, unknown>>(
  prior: Record<string, unknown>,
  next: T,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of Object.keys(next)) {
    const priorValue = prior[k];
    const nextValue = next[k];
    if (!sameValue(priorValue, nextValue)) {
      before[k] = priorValue;
      after[k] = nextValue;
    }
  }
  return { before, after };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    return canonicalJson(a) === canonicalJson(b);
  }
  return false;
}
