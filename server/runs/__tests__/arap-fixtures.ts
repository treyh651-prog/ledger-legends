/**
 * Fixtures for the module 5 AR and AP tests.
 *
 * The base fixtures give client A1 a chart with cash and a clearing account.
 * Module 5 needs the receivable and payable side of the chart as well, so that
 * chart is built once here and every suite in the module starts from it.
 *
 * Every builder takes an overrides object, so a test says in one line what it
 * is actually about and inherits a sane row for everything else. Dates are
 * chosen so the plain case lands on a round number: a January invoice due on
 * the tenth is 21 days past due at the end of the month, which is the first
 * aging bucket and not a fee, and the same invoice viewed from July is well
 * past every write off threshold.
 */

import type { MemoryRunDb } from "../db-memory";
import type { Proposal, Run } from "../contract";
import { execute, type ExecuteOptions, type RunOutcome } from "../execute";
import type {
  ArapPolicyRow,
  BillRow,
  CreditMemoRow,
  CustomerPaymentRow,
  CustomerRow,
  InvoiceRow,
  JournalEntryRow,
  JournalLineRow,
  RemittanceLineRow,
  VendorRow,
} from "../tables";
import { CLIENT_A1, FIRM_A, NOW, baseDb, chartAccount, opts } from "./fixtures";

/** The period every module 5 suite works on unless it says otherwise. */
export const PERIOD = "2026-01-01";
export const PERIOD_END = "2026-01-31";
/** A period far enough forward that an old January invoice is uncollectible. */
export const LATE_PERIOD = "2026-09-01";
export const LATE_PERIOD_END = "2026-09-30";

export const ARAP_ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ["1100", "Accounts receivable"],
  ["1150", "Allowance for doubtful accounts"],
  ["1200", "Accounts receivable clearing"],
  ["1990", "Suspense"],
  ["2000", "Accounts payable"],
  ["2050", "Vendor credits"],
  ["2400", "Sales tax payable"],
  ["4100", "Service revenue"],
  ["4200", "Late fee revenue"],
  ["6800", "Bad debt expense"],
  ["8200", "Purchase discounts taken"],
];

/** The base database plus every account the module 5 runs read or post to. */
export function arapDb(): MemoryRunDb {
  const db = baseDb();
  db.seed(
    "chart_accounts",
    ARAP_ACCOUNTS.map(([number, name]) =>
      chartAccount(`CH-A1-${number}`, FIRM_A, CLIENT_A1, number, name),
    ),
  );
  return db;
}

/**
 * A policy row. Tests that care about a threshold state it here, and tests that
 * do not seed no policy at all and get the doc 02 defaults.
 */
export function arapPolicy(
  id: string,
  extra: Partial<ArapPolicyRow> = {},
): ArapPolicyRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    agingBasis: "due_date",
    minimumStatementBalanceCents: BigInt(0),
    statementType: "open_item",
    messageNeutral: null,
    messageReminder: null,
    messageFirm: null,
    messageFinal: null,
    graceDays: 10,
    lateFeeMinimumCents: BigInt(0),
    lateFeeMaximumCents: null,
    suppressBelowMinimumFee: true,
    writeoffAgeDays: 180,
    writeoffMinimumCents: BigInt(100),
    requiredAttempts: 3,
    writeoffMethod: "direct",
    approvalTier1Cents: BigInt(100000),
    discountBaseExcludesFreightTax: true,
    arControlAccount: "1100",
    arClearingAccount: "1200",
    allowanceAccount: "1150",
    badDebtAccount: "6800",
    salesTaxAccount: "2400",
    lateFeeRevenueAccount: "4200",
    apControlAccount: "2000",
    apClearingAccount: "1010",
    purchaseDiscountAccount: "8200",
    vendorCreditAccount: "2050",
    manualOverride: false,
    ...extra,
  };
}

/** A customer with fees off, which is the only safe default for a fee. */
export function customer(
  id: string,
  extra: Partial<CustomerRow> = {},
): CustomerRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    name: `customer ${id}`,
    isActive: true,
    statementSuppressed: false,
    statementType: null,
    applicationPreference: "oldest_first",
    lateFeeEnabled: false,
    annualizedRateBp: null,
    graceDays: null,
    flatFeeCents: null,
    lateFeeExempt: false,
    doNotPursue: false,
    paymentPlanActive: false,
    statementDocumentId: null,
    statementDocumentDate: null,
    manualOverride: false,
    ...extra,
  };
}

/** A posted invoice for 1,000.00 with no tax, due on the tenth of January. */
export function invoice(
  id: string,
  customerId: string,
  extra: Partial<InvoiceRow> = {},
): InvoiceRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    customerId,
    invoiceNumber: id,
    invoiceDate: "2025-12-11",
    dueDate: "2026-01-10",
    originalAmountCents: BigInt(100000),
    taxCents: BigInt(0),
    appliedPaymentsCents: BigInt(0),
    appliedCreditsCents: BigInt(0),
    writtenOffCents: BigInt(0),
    status: "posted",
    inDispute: false,
    collectionAttempts: 0,
    parentInvoiceId: null,
    isLateFee: false,
    feeMonths: null,
    writeoffApproved: false,
    arAccount: "1100",
    revenueAccount: "4100",
    manualOverride: false,
    ...extra,
  };
}

export function creditMemo(
  id: string,
  customerId: string,
  extra: Partial<CreditMemoRow> = {},
): CreditMemoRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    customerId,
    memoNumber: id,
    memoDate: "2026-01-05",
    amountCents: BigInt(5000),
    appliedCents: BigInt(0),
    status: "open",
    manualOverride: false,
    ...extra,
  };
}

/** A payment sitting on the register, coded to the clearing account. */
export function payment(
  id: string,
  customerId: string,
  extra: Partial<CustomerPaymentRow> = {},
): CustomerPaymentRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    customerId,
    paymentDate: "2026-01-20",
    amountCents: BigInt(100000),
    appliedCents: BigInt(0),
    onHold: false,
    matchHint: null,
    transactionId: null,
    clearingAccount: "1200",
    status: "unapplied",
    appliedTier: null,
    manualOverride: false,
    ...extra,
  };
}

export function remittance(
  id: string,
  paymentId: string,
  lineNumber: number,
  invoiceNumber: string,
  amountCents: bigint,
): RemittanceLineRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    paymentId,
    lineNumber,
    invoiceNumber,
    amountCents,
  };
}

/** A vendor. The discount rule defaults to taking the discount to income. */
export function vendor(id: string, extra: Partial<VendorRow> = {}): VendorRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    legalName: `vendor ${id}`,
    normalizedName: id.toLowerCase(),
    normalizerVersion: 1,
    aliases: [],
    defaultCategoryId: null,
    defaultCategoryVersion: null,
    isActive: true,
    earlyDiscountRule: null,
    w9OnFile: true,
    w9ExpiresOn: null,
    entityType: "individual",
    paymentHold: false,
    tinLast4: null,
    ...extra,
  };
}

/** A bill for 1,000.00 on 2/10 net 30 terms, dated the fifth of January. */
export function bill(
  id: string,
  vendorId: string,
  extra: Partial<BillRow> = {},
): BillRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    vendorId,
    billNumber: id,
    billDate: "2026-01-05",
    dueDate: "2026-02-04",
    originalAmountCents: BigInt(100000),
    freightCents: BigInt(0),
    taxCents: BigInt(0),
    paidCents: BigInt(0),
    discountTakenCents: BigInt(0),
    creditsCents: BigInt(0),
    discountBps: 200,
    discountDays: 10,
    netDays: 30,
    status: "posted",
    onHold: false,
    inDispute: false,
    apAccount: "2000",
    expenseAccount: "6100",
    manualOverride: false,
    ...extra,
  };
}

/** A posted journal entry, for seeding the control balance the aging ties to. */
export function arEntry(
  id: string,
  entryDate: string,
  extra: Partial<JournalEntryRow> = {},
): JournalEntryRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    entryDate,
    memo: `entry ${id}`,
    posted: true,
    reversalOf: null,
    reversedByEntryId: null,
    redatedFromLockedPeriod: null,
    reversesOn: null,
    linkedDocumentId: null,
    accrualTemplateId: null,
    sourceTable: "invoices",
    sourceRowId: id,
    sourceVersion: 1,
    createdByRunId: "RUNX-SEED",
    runType: "SEED",
    runVersion: 1,
    ...extra,
  };
}

export function arLine(
  id: string,
  entryId: string,
  accountNumber: string,
  amountCents: bigint,
  entryDate: string,
  extra: Partial<JournalLineRow> = {},
): JournalLineRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    entryId,
    accountNumber,
    categoryId: null,
    amountCents,
    memo: `line ${id}`,
    entryDate,
    classId: null,
    locationId: null,
    programId: null,
    restriction: null,
    ...extra,
  };
}

/**
 * Seed the control account so an aging run has something to tie to. One entry,
 * a debit to the receivable and a credit to revenue, for the amount stated.
 */
export function seedArControl(
  db: MemoryRunDb,
  id: string,
  amountCents: bigint,
  entryDate: string = "2025-12-11",
): void {
  db.seed("journal_entries", [...db.all("journal_entries"), arEntry(id, entryDate)]);
  db.seed("journal_lines", [
    ...db.all("journal_lines"),
    arLine(`${id}-L1`, id, "1100", amountCents, entryDate),
    arLine(`${id}-L2`, id, "4100", -amountCents, entryDate),
  ]);
}

/** The scope shape the aging, statement, fee, and write off runs take. */
export function arapScope(
  period: string = PERIOD,
  clientId: string = CLIENT_A1,
): { clientId: string; period: string } {
  return { clientId, period };
}

export function previewArap<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<RunOutcome<Proposal>> {
  return execute<S, Proposal>(db, run, scope, opts("preview", extra));
}

/** Preview then apply, the only legal way to apply. */
export async function applyArap<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<{ preview: RunOutcome<Proposal>; applied: RunOutcome<Proposal> }> {
  const preview = await execute<S, Proposal>(
    db,
    run,
    scope,
    opts("preview", extra),
  );
  const applied = await execute<S, Proposal>(
    db,
    run,
    scope,
    opts("apply", { ...extra, previewRunId: preview.executionId }),
  );
  return { preview, applied };
}

/** True when the run recorded that skip reason against the row. */
export function skippedFor(
  outcome: RunOutcome<Proposal>,
  rowId: string,
  reason: string,
): boolean {
  return outcome.result.skips.some(
    (s) => s.rowId === rowId && s.reason === reason,
  );
}

/** True when the run recorded a skip whose detail contains that phrase. */
export function skipDetail(
  outcome: RunOutcome<Proposal>,
  rowId: string,
  fragment: string,
): boolean {
  return outcome.result.skips.some(
    (s) => s.rowId === rowId && (s.detail ?? "").includes(fragment),
  );
}

export function reasons(outcome: RunOutcome<Proposal>): string[] {
  return outcome.result.skips.map((s) => s.reason).sort();
}

export function linesOf(db: MemoryRunDb, entryId: string): JournalLineRow[] {
  return db.all("journal_lines").filter((l) => l.entryId === entryId);
}

export function sumLines(rows: readonly JournalLineRow[]): bigint {
  let net = BigInt(0);
  for (const r of rows) net += r.amountCents;
  return net;
}

/** The balance on one account across every line in the book. */
export function balanceOf(db: MemoryRunDb, accountNumber: string): bigint {
  return sumLines(
    db.all("journal_lines").filter((l) => l.accountNumber === accountNumber),
  );
}

/** The seed timestamp, so a test can assert a stamped row against it. */
export const SEEDED_AT = NOW.toISOString();
