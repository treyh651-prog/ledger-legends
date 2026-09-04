/**
 * Fixtures for the module 1 intake and setup tests.
 *
 * Every other module in this suite starts from a client that already has a
 * chart, a catalog, and a book. Module 1 is the run set that creates all three,
 * so the base here is the opposite of every other fixture file: an empty
 * database and a client id nothing has ever written a row for. That is the
 * whole point. A wizard test that started from a seeded chart would never see
 * the insert path it exists to check.
 *
 * The client is CLI-NEW at firm FIRM-A. The cutover is 2026-07-01, which makes
 * July 2026 the first period, so a monthly catalog row lands in the first
 * period and a quarterly one does not. Tests that want the quarterly and the
 * annual paths ask for QUARTER_PERIOD and DECEMBER_PERIOD instead.
 *
 * Every builder takes an overrides object, so a test says in one line what it
 * is about and inherits a sane scope for everything else.
 */

import { MemoryRunDb } from "../db-memory";
import type { Proposal, Run } from "../contract";
import { execute, type ExecuteOptions, type RunOutcome } from "../execute";
import { canonicalJson, toJsonValue } from "../ids";
import type {
  CategoryRow,
  ChartAccountRow,
  DocumentRequestRow,
  JournalEntryRow,
  JournalLineRow,
  OpeningBalanceRow,
  PracticeTaskCatalogRow,
  PracticeTaskRow,
} from "../tables";
import { ACTOR, FIRM_A, NOW, chartAccount, lock, opts } from "./fixtures";
import type { BuildChartScope } from "../runs/intake-build-chart";
import type { SeedTasksScope } from "../runs/intake-seed-tasks";
import type { OpenRequestsScope } from "../runs/intake-open-requests";
import type { ImportBalancesScope } from "../runs/setup-import-balances";

/** A client id nothing else in the suite writes to. */
export const INTAKE_CLIENT = "CLI-NEW";

/** The wizard answers the demo client Northgate Mechanical was set up with. */
export const CUTOVER = "2026-07-01";
export const PERIOD = "2026-07-01";
export const PERIOD_END = "2026-07-31";

/** September is the first quarter end after the cutover. */
export const QUARTER_PERIOD = "2026-09-01";
export const QUARTER_PERIOD_END = "2026-09-30";

/** December is the only month an annual catalog row lands in. */
export const DECEMBER_PERIOD = "2026-12-01";
export const DECEMBER_PERIOD_END = "2026-12-31";

/** The six subjects doc 02 module 1 says a new client is asked for. */
export const STANDARD_SUBJECT_KEYS: readonly string[] = [
  "articles-of-incorporation",
  "chart-of-authorization",
  "ein-letter",
  "opening-bank-statements",
  "prior-year-trial-balance",
  "w9-owner",
];

/** The five industry words the wizard offers on step 2. */
export const WIZARD_INDUSTRIES: readonly string[] = [
  "services",
  "product",
  "restaurant",
  "real_estate",
  "nonprofit",
];

/**
 * A fresh client. No chart, no categories, no catalog, no requests, no book.
 *
 * Built from an empty MemoryRunDb rather than from baseDb, because baseDb seeds
 * a chart for CLI-A1 and every account count assertion below would then be
 * counting somebody else's rows.
 */
export function intakeDb(): MemoryRunDb {
  return new MemoryRunDb();
}

/** Put one account on the client's chart the way a person would have. */
export function seedAccount(
  db: MemoryRunDb,
  accountNumber: string,
  name: string,
): void {
  db.seed("chart_accounts", [
    ...db.all("chart_accounts"),
    chartAccount(
      `CH-NEW-${accountNumber}`,
      FIRM_A,
      INTAKE_CLIENT,
      accountNumber,
      name,
    ),
  ]);
}

/**
 * Close the first period. A cutover inside a closed period is the case the
 * balance importer has to refuse rather than redate, so one test needs this.
 */
export function lockFirstPeriod(db: MemoryRunDb): void {
  db.seed("period_locks", [
    ...db.all("period_locks"),
    lock("PL-INTAKE-FIRST", FIRM_A, INTAKE_CLIENT, PERIOD, PERIOD_END),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Scopes                                                                     */
/* -------------------------------------------------------------------------- */

export function chartScope(extra: Partial<BuildChartScope> = {}): BuildChartScope {
  return {
    clientId: INTAKE_CLIENT,
    period: PERIOD,
    industry: "services",
    scopeKeys: [],
    excludeAccountNumbers: [],
    addAccounts: [],
    ...extra,
  };
}

export function tasksScope(extra: Partial<SeedTasksScope> = {}): SeedTasksScope {
  return {
    clientId: INTAKE_CLIENT,
    period: PERIOD,
    scopeKeys: [],
    excludeCatalogCodes: [],
    ...extra,
  };
}

export function requestsScope(
  extra: Partial<OpenRequestsScope> = {},
): OpenRequestsScope {
  return {
    clientId: INTAKE_CLIENT,
    period: PERIOD,
    openedOn: CUTOVER,
    scopeKeys: [],
    excludeSubjectKeys: [],
    ...extra,
  };
}

/**
 * A trial balance scope. Lines arrive as account number and signed cents, the
 * same shape the wizard grid hands over, and are turned into the cents strings
 * the schema wants here so a test never writes a quoted number.
 */
export function balancesScope(
  lines: ReadonlyArray<readonly [string, bigint]>,
  extra: Partial<ImportBalancesScope> = {},
): ImportBalancesScope {
  return {
    clientId: INTAKE_CLIENT,
    period: PERIOD,
    cutoverDate: CUTOVER,
    lines: lines.map(([accountNumber, amountCents]) => ({
      accountNumber,
      amountCents: amountCents.toString(),
    })),
    sourceKind: "wizard_trial_balance",
    ...extra,
  };
}

/** A balanced opening trial balance a test can hand over without thinking. */
export function balancedLines(): ReadonlyArray<readonly [string, bigint]> {
  return [
    ["1000", BigInt(2500000)],
    ["1100", BigInt(750000)],
    ["2000", BigInt(-400000)],
  ];
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

export function intakeOpts(
  mode: "preview" | "apply",
  extra: Partial<ExecuteOptions> = {},
): ExecuteOptions {
  return opts(mode, { clientId: INTAKE_CLIENT, ...extra });
}

/** Preview an intake run. Preview is apply with the commit removed. */
export function previewIntake<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<RunOutcome<Proposal>> {
  return execute<S, Proposal>(db, run, scope, intakeOpts("preview", extra));
}

/** Preview then apply, the only legal way to apply. */
export async function applyIntake<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<{ preview: RunOutcome<Proposal>; applied: RunOutcome<Proposal> }> {
  const preview = await execute<S, Proposal>(
    db,
    run,
    scope,
    intakeOpts("preview", extra),
  );
  const applied = await execute<S, Proposal>(
    db,
    run,
    scope,
    intakeOpts("apply", { ...extra, previewRunId: preview.executionId }),
  );
  return { preview, applied };
}

/* -------------------------------------------------------------------------- */
/* Reading what a run wrote                                                   */
/* -------------------------------------------------------------------------- */

export function accountsOf(db: MemoryRunDb): ChartAccountRow[] {
  return [...db.all("chart_accounts")]
    .filter((a) => a.clientId === INTAKE_CLIENT)
    .sort((a, b) => (a.accountNumber < b.accountNumber ? -1 : 1));
}

export function accountNumbersOf(db: MemoryRunDb): string[] {
  return accountsOf(db).map((a) => a.accountNumber);
}

export function accountByNumber(
  db: MemoryRunDb,
  accountNumber: string,
): ChartAccountRow | undefined {
  return accountsOf(db).find((a) => a.accountNumber === accountNumber);
}

export function categoriesOf(db: MemoryRunDb): CategoryRow[] {
  return [...db.all("categories")]
    .filter((c) => c.clientId === INTAKE_CLIENT)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function catalogOf(db: MemoryRunDb): PracticeTaskCatalogRow[] {
  return [...db.all("practice_task_catalog")]
    .filter((c) => c.clientId === INTAKE_CLIENT)
    .sort((a, b) => (a.catalogCode < b.catalogCode ? -1 : 1));
}

export function tasksOf(db: MemoryRunDb): PracticeTaskRow[] {
  return [...db.all("practice_tasks")]
    .filter((t) => t.clientId === INTAKE_CLIENT)
    .sort((a, b) => (a.catalogCode < b.catalogCode ? -1 : 1));
}

export function requestsOf(db: MemoryRunDb): DocumentRequestRow[] {
  return [...db.all("document_requests")]
    .filter((r) => r.clientId === INTAKE_CLIENT)
    .sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : 1));
}

export function openingBalancesOf(db: MemoryRunDb): OpeningBalanceRow[] {
  return [...db.all("opening_balances")]
    .filter((b) => b.clientId === INTAKE_CLIENT)
    .sort((a, b) => (a.accountNumber < b.accountNumber ? -1 : 1));
}

export function entriesOf(db: MemoryRunDb): JournalEntryRow[] {
  return [...db.all("journal_entries")].filter((e) => e.clientId === INTAKE_CLIENT);
}

export function linesOf(db: MemoryRunDb): JournalLineRow[] {
  return [...db.all("journal_lines")]
    .filter((l) => l.clientId === INTAKE_CLIENT)
    .sort((a, b) => (a.accountNumber < b.accountNumber ? -1 : 1));
}

/** The signed total of every posted line, which has to be zero. */
export function footingOf(db: MemoryRunDb): bigint {
  let total = BigInt(0);
  for (const line of linesOf(db)) total += line.amountCents;
  return total;
}

/** The posted balance on one account. */
export function balanceOf(db: MemoryRunDb, accountNumber: string): bigint {
  let total = BigInt(0);
  for (const line of linesOf(db)) {
    if (line.accountNumber === accountNumber) total += line.amountCents;
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/* Assertion helpers                                                          */
/* -------------------------------------------------------------------------- */

/** A stable string for a proposal set, so preview and apply can be compared. */
export function shapeOf(proposals: readonly Proposal[]): string {
  return canonicalJson(toJsonValue(proposals));
}

export function skippedFor(
  outcome: RunOutcome<Proposal>,
  rowId: string,
  reason: string,
): boolean {
  return outcome.result.skips.some((s) => s.rowId === rowId && s.reason === reason);
}

export function skipDetails(
  outcome: RunOutcome<Proposal>,
  rowId: string,
): string[] {
  return outcome.result.skips
    .filter((s) => s.rowId === rowId)
    .map((s) => `${s.reason}:${s.detail}`)
    .sort();
}

export function errorCodes(outcome: RunOutcome<Proposal>): string[] {
  return outcome.result.errors.map((e) => e.code).sort();
}

/** True when every skip recorded carries one of these reasons. */
export function allSkipsAre(
  outcome: RunOutcome<Proposal>,
  reasons: readonly string[],
): boolean {
  return outcome.result.skips.every((s) => reasons.includes(s.reason));
}

export { ACTOR, FIRM_A, NOW };
