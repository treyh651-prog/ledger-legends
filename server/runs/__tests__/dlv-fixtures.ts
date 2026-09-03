/**
 * Fixtures for the D5 payroll runs and the two archive runs.
 *
 * The base is the close fixture plus the five payroll accounts doc 01 Part 4
 * names, because the posting run refuses on a chart that is missing any of
 * them and a test of that refusal has to be able to remove one deliberately
 * rather than benefit from it being absent by accident.
 *
 * The register. A payroll register substantiation record for January, prepared
 * by USR-PREPARER and linked to a vault object. Gross wages of 500,000 cents
 * come off that record and are never keyed by a caller, which is the whole
 * point of D5: the firm reviews figures the provider produced.
 *
 * The second source. A payroll approval row from the provider carrying the
 * provider's own approved net of 400,000 cents, which is gross minus the
 * 100,000 cents of withholding the scope carries. The approval run refuses when
 * those two do not agree.
 *
 * The actor. The suite's default actor is USR-OPERATOR, which is deliberately
 * not the preparer, so the G18 separation check passes in the base story and a
 * test of that check has to name the preparer as the actor on purpose.
 */

import { MemoryRunDb } from "../db-memory";
import type { Proposal, Run } from "../contract";
import { execute, type ExecuteOptions, type RunOutcome } from "../execute";
import type {
  CpaHandoffRow,
  OffboardExportRow,
  PayRegisterEntryRow,
  PayRunRow,
  PayrollApprovalRow,
  SubstantiationRecordRow,
} from "../tables";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, lock, opts } from "./fixtures";
import {
  PERIOD,
  PERIOD_END,
  PREPARER,
  addAccount,
  closeDb,
  seedEntry,
  substantiation,
} from "./close-fixtures";

export { PERIOD, PERIOD_END, PREPARER };

/** The pay date inside the January period, so net funds from 1010. */
export const PAY_DATE = "2026-01-28";
/** A pay date outside it, so net lands in 1930 payroll clearing instead. */
export const LATE_PAY_DATE = "2026-02-03";
export const PROVIDER = "Gusto";

export const GROSS = BigInt(500000);
export const WITHHOLDING = BigInt(100000);
export const EMPLOYER_TAX = BigInt(38000);
export const NET = BigInt(400000);

export const REGISTER_KEY = "clients/CLI-A1/payroll/2026-01/register.pdf";

/** The payroll accounts doc 01 Part 4 names, which the close chart lacks. */
export const PAYROLL_ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ["2310", "Payroll taxes payable"],
  ["2320", "Employee withholdings payable"],
  ["1930", "Payroll clearing"],
  ["6300", "Wages and salaries"],
  ["6310", "Payroll taxes employer"],
];

/** The payroll base. Chart, register, provider approval. */
export function payrollDb(): MemoryRunDb {
  const db = closeDb();
  for (const [number, name] of PAYROLL_ACCOUNTS) addAccount(db, number, name);
  db.seed("substantiation_records", [payrollRegister()]);
  db.seed("payroll_approvals", [providerApproval()]);
  return db;
}

/** The vault linked register. sourceRef is the vault object key. */
export function payrollRegister(
  extra: Partial<SubstantiationRecordRow> = {},
): SubstantiationRecordRow {
  return substantiation("SUB-PAYROLL", "payroll_register", "6300", GROSS, {
    sourceRef: REGISTER_KEY,
    preparedBy: PREPARER,
    ...extra,
  });
}

/** The provider's own approved net, as a second independent source. */
export function providerApproval(
  extra: Partial<PayrollApprovalRow> = {},
): PayrollApprovalRow {
  return {
    id: "PAY-PROVIDER",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    payDate: PAY_DATE,
    amountCents: NET,
    fundingAccount: "1010",
    status: "approved",
    approvedBy: "USR-PROVIDER",
    approvedOn: PAY_DATE,
    detail: "seeded provider approval",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

/** An approved pay run, as PAY-APPROVE-RUN would have left it. */
export function payRun(id: string, extra: Partial<PayRunRow> = {}): PayRunRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    providerName: PROVIDER,
    payPeriodStart: PERIOD,
    payPeriodEnd: PERIOD_END,
    payDate: PAY_DATE,
    periodStart: PERIOD,
    periodEnd: PERIOD_END,
    employeeCount: 4,
    registerVaultObjectKey: REGISTER_KEY,
    registerChecksum: "seeded",
    grossCents: GROSS,
    employerTaxCents: EMPLOYER_TAX,
    employeeWithholdingCents: WITHHOLDING,
    netCents: NET,
    status: "approved",
    approvedBy: ACTOR,
    approvedAt: NOW.toISOString(),
    approvalStatement: "seeded approval",
    authorizesDisbursement: false,
    postedEntryId: null,
    postedAt: null,
    postedRunId: null,
    vaultObjectLockMode: "GOVERNANCE",
    vaultRetentionStartsOn: PERIOD_END,
    vaultObjectLockUntil: "2033-01-31",
    createdByRunId: "RUNX-SEED",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

/** The scope PAY-APPROVE-RUN takes. */
export function approveScope(
  extra: Partial<{
    clientId: string;
    period: string;
    payDate: string;
    providerName: string;
    employeeWithholdingCents: bigint;
    employerTaxCents: bigint;
    employeeCount: number;
  }> = {},
) {
  return {
    clientId: CLIENT_A1,
    period: PERIOD,
    payDate: PAY_DATE,
    providerName: PROVIDER,
    employeeWithholdingCents: WITHHOLDING,
    employerTaxCents: EMPLOYER_TAX,
    employeeCount: 4,
    ...extra,
  };
}

/** The scope PAY-POST-REGISTER takes. */
export function postScope(
  extra: Partial<{
    clientId: string;
    period: string;
    payDate: string;
    providerName: string;
  }> = {},
) {
  return {
    clientId: CLIENT_A1,
    period: PERIOD,
    payDate: PAY_DATE,
    providerName: PROVIDER,
    ...extra,
  };
}

/** The archive base. A close fixture with a second period of history in it. */
export function archiveDb(): MemoryRunDb {
  const db = closeDb();
  seedEntry(db, "JE-FEB", "2026-02-11", [
    ["6100", BigInt(15000)],
    ["1010", BigInt(-15000)],
  ]);
  return db;
}

/**
 * The payroll base with one account left out of the chart.
 *
 * Seeding cannot remove a row, so a chart that is missing an account has to be
 * built that way rather than edited afterwards.
 */
export function payrollDbMissing(accountNumber: string): MemoryRunDb {
  const db = closeDb();
  for (const [number, name] of PAYROLL_ACCOUNTS) {
    if (number === accountNumber) continue;
    addAccount(db, number, name);
  }
  db.seed("substantiation_records", [payrollRegister()]);
  db.seed("payroll_approvals", [providerApproval()]);
  return db;
}

export function lockJanuary(db: MemoryRunDb): void {
  db.seed("period_locks", [
    ...db.all("period_locks"),
    lock("PL-JAN", FIRM_A, CLIENT_A1, PERIOD, PERIOD_END),
  ]);
}

export function previewDlv<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<RunOutcome<Proposal>> {
  return execute<S, Proposal>(db, run, scope, opts("preview", extra));
}

export async function applyDlv<S>(
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

export function payRunsOf(db: MemoryRunDb): PayRunRow[] {
  return [...db.all("pay_runs")].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function registerEntriesOf(db: MemoryRunDb): PayRegisterEntryRow[] {
  return [...db.all("pay_register_entries")].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function handoffsOf(db: MemoryRunDb): CpaHandoffRow[] {
  return [...db.all("cpa_handoffs")].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function exportsOf(db: MemoryRunDb): OffboardExportRow[] {
  return [...db.all("offboard_exports")].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function shapeOf(proposals: readonly Proposal[]): string {
  return JSON.stringify(
    proposals.map((p) => ({
      kind: p.kind,
      table: "table" in p ? p.table : null,
      rowId: "rowId" in p ? p.rowId : null,
    })),
  );
}

export { ACTOR, CLIENT_A1, FIRM_A, NOW, opts };
