/**
 * Fixtures for the module 8 reporting tests.
 *
 * Reporting reads a closed book and writes nothing back to it, so the base
 * database here is the close fixture plus the things a report needs that a close
 * does not: a receivable and a payable so the aging sections and the forecast
 * have documents, a budget so a variance has something to compare against, and
 * an approved payroll so the forecast has a committed outflow.
 *
 * The period is January 2026, the same window modules 5 and 6 use, so a person
 * can follow one client through the whole story without switching calendars.
 */

import { MemoryRunDb } from "../db-memory";
import type { Proposal, Run } from "../contract";
import { execute, type ExecuteOptions, type RunOutcome } from "../execute";
import type {
  BudgetRow,
  BudgetThresholdRow,
  AgingSnapshotRow,
  BillRow,
  InvoiceRow,
  PayrollApprovalRow,
  ReportPackageRow,
  ReportSectionRow,
  ReportVarianceRow,
  CashForecastRunRow,
  CashForecastWeekRow,
  ReportNarrativeRow,
} from "../tables";
import { CLIENT_A1, FIRM_A, NOW, lock, opts } from "./fixtures";
import {
  PERIOD,
  PERIOD_END,
  addAccount,
  closeDb,
  seedEntry,
} from "./close-fixtures";

export { PERIOD, PERIOD_END };
export const NEXT_PERIOD = "2026-02-01";
export const NEXT_PERIOD_END = "2026-02-28";
/** The day after the period end, which is where every forecast starts. */
export const FORECAST_START = "2026-02-01";

/**
 * The reporting base.
 *
 * Revenue of one hundred thousand cents against a budget of forty thousand, an
 * expense of forty thousand against a budget of forty thousand. The revenue
 * account clears both the ten percent threshold and the five hundred dollar
 * floor, so the base story has one flag in it, and the expense account is exactly
 * on budget, so a test can tell a quiet account from an unexamined one.
 */
export function reportDb(): MemoryRunDb {
  const db = closeDb();
  addAccount(db, "1100", "Accounts receivable");
  addAccount(db, "2000", "Accounts payable");
  seedEntry(db, "JE-EXP", "2026-01-20", [
    ["6100", BigInt(40000)],
    ["1010", BigInt(-40000)],
  ]);
  db.seed("budgets", [
    budget("BUD-4100", "4100", BigInt(-40000)),
    budget("BUD-6100", "6100", BigInt(40000)),
  ]);
  db.seed("invoices", [invoiceRow("INV-1")]);
  db.seed("bills", [billRow("BILL-1")]);
  db.seed("payroll_approvals", [payroll("PAY-1", "2026-02-14", BigInt(30000))]);
  db.seed("aging_snapshots", [
    agingRow("AG-AR", "receivable", "current", BigInt(120000)),
    agingRow("AG-AP", "payable", "current", BigInt(60000)),
  ]);
  return db;
}

export function budget(
  id: string,
  accountNumber: string,
  budgetCents: bigint,
  extra: Partial<BudgetRow> = {},
): BudgetRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    periodStart: PERIOD,
    periodEnd: PERIOD_END,
    accountNumber,
    classId: null,
    locationId: null,
    programId: null,
    budgetCents,
    source: "entered",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

export function threshold(
  id: string,
  accountNumber: string | null,
  thresholdBp: number,
  floorCents: bigint,
  extra: Partial<BudgetThresholdRow> = {},
): BudgetThresholdRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    accountNumber,
    varianceThresholdBp: thresholdBp,
    varianceFloorCents: floorCents,
    note: "seeded threshold",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

/** An open receivable due inside the forecast horizon. */
export function invoiceRow(
  id: string,
  extra: Partial<InvoiceRow> = {},
): InvoiceRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    customerId: "CUS-1",
    invoiceNumber: id,
    invoiceDate: "2026-01-10",
    dueDate: "2026-02-10",
    originalAmountCents: BigInt(120000),
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

/**
 * An open payable. No discount by default, so a test that wants the discount
 * timing rule has to ask for it and reads as a statement about that rule.
 */
export function billRow(id: string, extra: Partial<BillRow> = {}): BillRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    vendorId: "VEN-1",
    billNumber: id,
    billDate: "2026-01-20",
    dueDate: "2026-02-19",
    originalAmountCents: BigInt(60000),
    freightCents: BigInt(0),
    taxCents: BigInt(0),
    paidCents: BigInt(0),
    discountTakenCents: BigInt(0),
    creditsCents: BigInt(0),
    discountBps: 0,
    discountDays: 0,
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

export function payroll(
  id: string,
  payDate: string,
  amountCents: bigint,
  extra: Partial<PayrollApprovalRow> = {},
): PayrollApprovalRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    payDate,
    amountCents,
    fundingAccount: "1010",
    status: "approved",
    approvedBy: "USR-APPROVER",
    approvedOn: PERIOD_END,
    detail: "seeded payroll",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

export function agingRow(
  id: string,
  side: "receivable" | "payable",
  bucket: AgingSnapshotRow["bucket"],
  openBalanceCents: bigint,
  extra: Partial<AgingSnapshotRow> = {},
): AgingSnapshotRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    asOfDate: PERIOD_END,
    side,
    agingBasis: "due_date",
    partyId: side === "receivable" ? "CUS-1" : "VEN-1",
    partyName: side === "receivable" ? "customer one" : "vendor one",
    documentId: side === "receivable" ? "INV-1" : "BILL-1",
    documentNumber: side === "receivable" ? "INV-1" : "BILL-1",
    documentDate: "2026-01-10",
    basisDate: "2026-01-10",
    ageDays: 0,
    bucket,
    openBalanceCents,
    controlAccount: side === "receivable" ? "1100" : "2000",
    controlBalanceCents: openBalanceCents,
    tieDifferenceCents: BigInt(0),
    subledgerOutOfTie: false,
    createdByRunId: "RUNX-SEED",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

/**
 * Lock the period, which is the state most reporting runs see in production.
 *
 * The base database is left open on purpose so a test has to say when it wants a
 * closed period, and the draft watermark case is reachable without unwinding a
 * lock somebody else put there.
 */
export function lockPeriod(
  db: MemoryRunDb,
  extra: Partial<import("../tables").PeriodLockRow> = {},
): void {
  db.seed("period_locks", [
    ...db.all("period_locks"),
    { ...lock("PL-JAN", FIRM_A, CLIENT_A1, PERIOD, PERIOD_END), ...extra },
  ]);
}

/** The scope every reporting run takes, before its own defaults are applied. */
export function reportScope(
  period: string = PERIOD,
  clientId: string = CLIENT_A1,
): { clientId: string; period: string } {
  return { clientId, period };
}

export function previewReport<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<RunOutcome<Proposal>> {
  return execute<S, Proposal>(db, run, scope, opts("preview", extra));
}

/**
 * Preview then apply, the way every reporting test runs a run.
 *
 * The apply carries the preview execution id, because the framework refuses an
 * apply that has no preview behind it, and a test that skipped that would be
 * testing a path production cannot take.
 */
export async function applyReport<S>(
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

export function packagesOf(db: MemoryRunDb): ReportPackageRow[] {
  return [...db.all("report_packages")].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function sectionsOf(db: MemoryRunDb): ReportSectionRow[] {
  return [...db.all("report_sections")].sort(
    (a, b) => a.sequence - b.sequence,
  );
}

export function variancesOf(db: MemoryRunDb): ReportVarianceRow[] {
  return [...db.all("report_variances")].sort((a, b) =>
    a.accountNumber < b.accountNumber ? -1 : 1,
  );
}

export function forecastsOf(db: MemoryRunDb): CashForecastRunRow[] {
  return [...db.all("cash_forecast_runs")].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function weeksOf(db: MemoryRunDb): CashForecastWeekRow[] {
  return [...db.all("cash_forecast_weeks")].sort(
    (a, b) => a.weekNumber - b.weekNumber,
  );
}

export function narrativesOf(db: MemoryRunDb): ReportNarrativeRow[] {
  return [...db.all("report_narratives")].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The full narrative text, which is what a reader actually receives. */
export function narrativeText(db: MemoryRunDb): string {
  const rows = narrativesOf(db);
  return rows.length === 0 ? "" : rows[0].bodyText;
}

/**
 * A comparable shape for a proposal.
 *
 * Preview equals apply is the invariant every module asserts, and it is asserted
 * on this shape rather than on the raw objects because a raw proposal carries an
 * execution id that is different by definition on the two calls.
 */
export function shapeOf(proposals: readonly Proposal[]): string {
  return JSON.stringify(
    proposals.map((p) => ({
      kind: p.kind,
      table: "table" in p ? p.table : null,
      rowId: "rowId" in p ? p.rowId : null,
    })),
  );
}
