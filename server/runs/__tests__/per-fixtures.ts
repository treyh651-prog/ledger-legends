/**
 * Fixtures for the module 4 period end tests.
 *
 * The base fixtures give client A1 a chart with cash and a clearing account and
 * nothing else. Period end needs a wider chart: a prepaid asset, an accrued
 * liability, a note, interest, depreciation, and the expense accounts the
 * recurring templates hit. That chart is built once here and every suite in the
 * module starts from it.
 *
 * Every builder takes an overrides object, so a test says in one line what it
 * is actually about and inherits a sane row for everything else.
 */

import type { MemoryRunDb } from "../db-memory";
import type { Proposal, Run } from "../contract";
import { execute, type ExecuteOptions, type RunOutcome } from "../execute";
import type {
  AccrualTemplateRow,
  DeferralScheduleRow,
  FixedAssetRow,
  JournalEntryRow,
  JournalLineRow,
  LoanRow,
  LoanScheduleRow,
  RecurringSplitRow,
  RecurringTemplateRow,
} from "../tables";
import { CLIENT_A1, FIRM_A, NOW, baseDb, chartAccount, opts } from "./fixtures";

/** The period every module 4 suite works on unless it says otherwise. */
export const PERIOD = "2026-01-01";
export const PERIOD_END = "2026-01-31";
/** The period being opened, where the reversals land. */
export const NEXT_PERIOD = "2026-02-01";

export const ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ["1200", "Accounts receivable"],
  ["1310", "Prepaid expenses"],
  ["1510", "Equipment"],
  ["1590", "Accumulated depreciation"],
  ["1990", "Suspense"],
  ["2200", "Accrued liabilities"],
  ["2210", "Accrued wages"],
  ["2750", "Note payable"],
  ["4100", "Service revenue"],
  ["6100", "Rent expense"],
  ["6200", "Insurance expense"],
  ["6300", "Subscriptions"],
  ["6700", "Depreciation expense"],
  ["8100", "Interest expense"],
];

/** The base database plus every account the period end runs post to. */
export function perDb(): MemoryRunDb {
  const db = baseDb();
  db.seed(
    "chart_accounts",
    ACCOUNTS.map(([number, name]) =>
      chartAccount(`CH-A1-${number}`, FIRM_A, CLIENT_A1, number, name),
    ),
  );
  return db;
}

export function generatedTemplate(
  id: string,
  extra: Partial<RecurringTemplateRow> = {},
): RecurringTemplateRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    name: `template ${id}`,
    matchKind: "generated_entry",
    matchNormalizedName: null,
    bankAccountId: null,
    amountMode: "fixed_amount",
    matchAmountCents: null,
    amountFloorCents: null,
    amountCeilingCents: null,
    dayOfMonth: null,
    dayWindow: 5,
    splitMode: "fixed_amount",
    isActive: true,
    cadence: "monthly",
    startDate: "2026-01-01",
    endDate: null,
    postingDateRule: "period_end",
    driverAmountCents: null,
    entryMemoTemplate: null,
    manualOverride: false,
    ...extra,
  };
}

export function split(
  id: string,
  templateId: string,
  lineNumber: number,
  accountNumber: string,
  extra: Partial<RecurringSplitRow> = {},
): RecurringSplitRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    templateId,
    templateVersion: 1,
    lineNumber,
    categoryId: `CAT-${accountNumber}`,
    accountNumber,
    fixedAmountCents: null,
    percentBps: null,
    isRemainder: false,
    classId: null,
    locationId: null,
    programId: null,
    memo: null,
    ...extra,
  };
}

/** A twelve month prepaid, bought on the first, so no partial months. */
export function prepaid(
  id: string,
  extra: Partial<DeferralScheduleRow> = {},
): DeferralScheduleRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    kind: "prepaid",
    description: "Annual insurance policy",
    balanceAccount: "1310",
    releaseAccount: "6200",
    accumAccount: null,
    totalCents: BigInt(120000),
    serviceStart: "2026-01-01",
    serviceEnd: "2026-12-31",
    method: "straight_line_monthly",
    periods: 12,
    status: "active",
    sourceTransactionId: null,
    sourceDocumentId: null,
    linkedDocumentId: null,
    manualOverride: false,
    version: 1,
    ...extra,
  };
}

export function loan(id: string, extra: Partial<LoanRow> = {}): LoanRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    lenderName: "First Bank",
    loanType: "term",
    principalAccountLt: "2750",
    principalAccountCp: null,
    interestAccount: "8100",
    fundingAccount: "1010",
    escrowAccount: null,
    originalPrincipalCents: BigInt(1000000),
    originationDate: "2025-12-01",
    firstPaymentDate: "2026-01-15",
    termMonths: 12,
    annualRateBps: 600,
    paymentCents: BigInt(100000),
    status: "active",
    manualOverride: false,
    version: 1,
    ...extra,
  };
}

/** Payment one on the note: 600.00 of principal and 400.00 of interest. */
export function loanPayment(
  id: string,
  loanId: string,
  extra: Partial<LoanScheduleRow> = {},
): LoanScheduleRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    loanId,
    scheduleVersion: 1,
    paymentNumber: 1,
    dueDate: "2026-01-15",
    paymentCents: BigInt(100000),
    principalCents: BigInt(60000),
    interestCents: BigInt(40000),
    escrowCents: BigInt(0),
    feesCents: BigInt(0),
    balanceAfterCents: BigInt(940000),
    status: "scheduled",
    matchedTransactionId: null,
    postedEntryId: null,
    postedRunId: null,
    postedAt: null,
    manualOverride: false,
    version: 1,
    ...extra,
  };
}

export function accrualTemplate(
  id: string,
  extra: Partial<AccrualTemplateRow> = {},
): AccrualTemplateRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    name: `accrual ${id}`,
    accrualKind: "bill_received_not_entered",
    basis: "fixed_amount",
    debitAccount: "6100",
    creditAccount: "2200",
    categoryId: null,
    fixedAmountCents: BigInt(50000),
    sourceDocumentId: null,
    sourceDocumentAmountCents: null,
    dailyRateCents: null,
    dayCount: null,
    baseCents: null,
    percentBps: null,
    entryMemo: "Accrued January rent",
    autoReverse: true,
    isActive: true,
    manualOverride: false,
    ...extra,
  };
}

/**
 * A twelve month straight line asset placed in service on the first of the
 * period, so the plain case is a clean 100.00 a month.
 */
export function asset(
  id: string,
  extra: Partial<FixedAssetRow> = {},
): FixedAssetRow {
  const cost = extra.costCents ?? BigInt(1200000);
  const salvage = extra.salvageCents ?? BigInt(0);
  const row: FixedAssetRow = {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    tag: null,
    description: `asset ${id}`,
    assetClass: "equipment",
    costAccount: "1510",
    accumAccount: "1590",
    expenseAccount: "6700",
    acquiredOn: "2026-01-01",
    placedInServiceOn: "2026-01-01",
    costCents: cost,
    salvageCents: salvage,
    // The database generates this column. The fixture computes the same thing
    // so a test never has to state it twice.
    depreciableBaseCents: cost - salvage,
    method: "straight_line",
    lifeMonths: 12,
    ddbFactorBps: null,
    macrsRecoveryYears: null,
    unitsTotal: null,
    convention: "full_month",
    halfMonthConvention: false,
    status: "active",
    disposedOn: null,
    manualOverride: false,
    version: 1,
    ...extra,
  };
  // The generated column follows cost and salvage even when a test overrode
  // one of them and did not restate the base.
  return {
    ...row,
    depreciableBaseCents: extra.depreciableBaseCents ?? cost - salvage,
  };
}

/** A posted journal entry, for seeding history the runs read rather than write. */
export function entry(
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
    sourceTable: "accrual_templates",
    sourceRowId: id,
    sourceVersion: 1,
    createdByRunId: "RUNX-SEED",
    runType: "SEED",
    runVersion: 1,
    ...extra,
  };
}

export function jline(
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

/** The scope shape every module 4 run takes. */
export function periodScope(
  period: string = PERIOD,
  clientId: string = CLIENT_A1,
): { clientId: string; period: string } {
  return { clientId, period };
}

export function previewPer<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<RunOutcome<Proposal>> {
  return execute<S, Proposal>(db, run, scope, opts("preview", extra));
}

/** Preview then apply, the only legal way to apply. */
export async function applyPer<S>(
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

/** Every skip reason the run reported, sorted, for a readable failure message. */
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
