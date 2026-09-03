/**
 * Fixtures for the module 6 substantiation and close tests.
 *
 * The shape of this file is decided by what a gate test needs. Nineteen gates
 * each need a period where they pass and a period where they fail, so the base
 * database here is deliberately small: a cash account, a suspense account, a
 * revenue account, an expense account, and equity. On that chart most gates are
 * out of scope and answer not applicable, and a test that wants a gate to say
 * anything else seeds the one thing that brings it into scope. A larger base
 * would mean every gate test carried the noise of the other eighteen.
 *
 * The period is January 2026, the same window module 5 uses, so the two modules
 * read as one story when a person follows a client through them.
 */

import { MemoryRunDb } from "../db-memory";
import type { Proposal, Run } from "../contract";
import { execute, type ExecuteOptions, type RunOutcome } from "../execute";
import type {
  ClientPolicyRow,
  ClosePeriodRow,
  CloseGateResultRow,
  DocumentRequestRow,
  JournalEntryRow,
  JournalLineRow,
  OpeningBalanceRow,
  RecBatchRow,
  SubTieoutRow,
  SubstantiationRecordRow,
} from "../tables";
import { CLIENT_A1, FIRM_A, NOW, chartAccount, opts } from "./fixtures";

export const PERIOD = "2026-01-01";
export const PERIOD_END = "2026-01-31";
export const NEXT_PERIOD = "2026-02-01";
export const NEXT_PERIOD_END = "2026-02-28";

/** A second person, so a test can preview as one actor and apply as another. */
export const PREPARER = "USR-PREPARER";
export const APPROVER = "USR-APPROVER";

/** The chart every close test starts from. Nothing here is optional. */
export const CLOSE_ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ["1010", "Operating"],
  ["1990", "Suspense"],
  ["3200", "Retained earnings"],
  ["4100", "Service revenue"],
  ["6100", "Office expense"],
];

/**
 * The base close database. One bank account, a January cash sale, a reconciled
 * statement, and a policy that says the client is a calendar year for profit.
 *
 * The single entry is the thing that makes the clean case honest. It puts a real
 * balance on the cash account, foots to zero, and moves through the ledger the
 * way a cash sale does, so the trial balance gate and the cash basis derivation
 * gate are both answering a question about a real book rather than an empty one.
 */
export function closeDb(): MemoryRunDb {
  // Built from an empty database rather than from the shared base fixture,
  // because seeding merges by id and the base chart would leave two extra
  // unsupported accounts in every tie out and every gate payload.
  const db = new MemoryRunDb();
  db.seed(
    "chart_accounts",
    CLOSE_ACCOUNTS.map(([number, name]) =>
      chartAccount(`CH-A1-${number}`, FIRM_A, CLIENT_A1, number, name),
    ),
  );
  // One bank account, so the statement request and the reconciliation gates
  // have exactly one subject.
  db.seed("bank_accounts", [
    {
      id: "BA-A1-OP",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      accountNumber: "1010",
      nickname: "A1 operating",
      kind: "bank",
      isProcessorDestination: false,
    },
  ]);
  db.seed("client_policies", [policy()]);
  db.seed("rec_batches", [recBatch("RB-JAN")]);
  seedEntry(db, "JE-SALE", "2026-01-15", [
    ["1010", BigInt(100000)],
    ["4100", BigInt(-100000)],
  ]);
  return db;
}

export function policy(extra: Partial<ClientPolicyRow> = {}): ClientPolicyRow {
  return {
    id: "POL-A1",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    functionalCurrency: "USD",
    capitalizeOverCents: BigInt(250000),
    grossAtSaleTime: false,
    cleanupEngagement: false,
    entityKind: "for_profit",
    retainedEarningsAccount: "3200",
    netAssetsWithoutRestrictionsAccount: null,
    netAssetsWithRestrictionsAccount: null,
    fiscalYearEndMonth: 12,
    ...extra,
  };
}

/** A reconciled January statement with no difference. */
export function recBatch(
  id: string,
  extra: Partial<RecBatchRow> = {},
): RecBatchRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    bankAccountId: "BA-A1-OP",
    statementId: `ST-${id}`,
    statementPeriod: "2026-01",
    periodStart: PERIOD,
    periodEnd: PERIOD_END,
    statementBalanceCents: BigInt(100000),
    clearedLedgerBalanceCents: BigInt(100000),
    diffCents: BigInt(0),
    state: "reconciled",
    openedBy: PREPARER,
    openedAt: NOW.toISOString(),
    openedByRunId: null,
    closedAt: NOW.toISOString(),
    closedByRunId: null,
    version: 1,
    ...extra,
  };
}

export function closeEntry(
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
    sourceTable: "manual_entries",
    sourceRowId: id,
    sourceVersion: 1,
    createdByRunId: "RUNX-SEED",
    runType: "SEED",
    runVersion: 1,
    ...extra,
  };
}

export function closeLine(
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

/** Append one balanced entry and its lines to whatever is already in the book. */
export function seedEntry(
  db: MemoryRunDb,
  id: string,
  entryDate: string,
  lines: ReadonlyArray<readonly [string, bigint]>,
  extra: Partial<JournalEntryRow> = {},
  lineExtra: Partial<JournalLineRow> = {},
): void {
  db.seed("journal_entries", [
    ...db.all("journal_entries"),
    closeEntry(id, entryDate, extra),
  ]);
  db.seed("journal_lines", [
    ...db.all("journal_lines"),
    ...lines.map(([account, amount], at) =>
      closeLine(`${id}-L${at + 1}`, id, account, amount, entryDate, lineExtra),
    ),
  ]);
}

/** Add one account to the chart without disturbing the rest of it. */
export function addAccount(
  db: MemoryRunDb,
  accountNumber: string,
  name: string,
): void {
  db.seed("chart_accounts", [
    ...db.all("chart_accounts"),
    chartAccount(`CH-A1-${accountNumber}`, FIRM_A, CLIENT_A1, accountNumber, name),
  ]);
}

export function substantiation(
  id: string,
  kind: "inventory_count" | "payroll_register" | "other",
  accountNumber: string,
  supportedBalanceCents: bigint,
  extra: Partial<SubstantiationRecordRow> = {},
): SubstantiationRecordRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    kind,
    accountNumber,
    periodStart: PERIOD,
    periodEnd: PERIOD_END,
    supportedBalanceCents,
    sourceRef: `${kind} sheet`,
    preparedBy: PREPARER,
    preparedOn: PERIOD_END,
    manualOverride: false,
    ...extra,
  };
}

export function tieout(
  id: string,
  accountNumber: string,
  extra: Partial<SubTieoutRow> = {},
): SubTieoutRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    periodStart: PERIOD,
    periodEnd: PERIOD_END,
    accountNumber,
    accountName: `account ${accountNumber}`,
    sourceKind: "statement_balance",
    sourceRef: null,
    ledgerBalanceCents: BigInt(0),
    supportedBalanceCents: BigInt(0),
    varianceCents: BigInt(0),
    tied: true,
    wrongSideNoReason: false,
    state: "computed_tied",
    detail: "seeded tie out",
    createdByRunId: "RUNX-SEED",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

export function request(
  id: string,
  subjectKey: string,
  extra: Partial<DocumentRequestRow> = {},
): DocumentRequestRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    subjectKey,
    catalogCode: "RECEIPT",
    owner: "client",
    accountNumber: null,
    periodStart: PERIOD,
    linkedItemId: null,
    detail: "seeded request",
    status: "open",
    openedOn: PERIOD,
    asOfDate: PERIOD_END,
    agingDays: 30,
    escalatesOn: "2026-01-08",
    escalation: "final",
    ownerChangedOn: null,
    lastRefreshedOn: null,
    refreshCount: 0,
    createdByRunId: "RUNX-SEED",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

export function gateResult(
  id: string,
  gateCode: string,
  extra: Partial<CloseGateResultRow> = {},
): CloseGateResultRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    periodStart: PERIOD,
    periodEnd: PERIOD_END,
    gateCode,
    gateTitle: `gate ${gateCode}`,
    outcome: "pass",
    blockingCount: 0,
    payload: [],
    scopeReason: null,
    ledgerFingerprint: "",
    evaluatedAt: NOW.toISOString(),
    evaluatedByRunId: "RUNX-SEED",
    manualOverride: false,
    overrideReason: null,
    ...extra,
  };
}

export function period(
  id: string,
  periodStart: string,
  periodEnd: string,
  extra: Partial<ClosePeriodRow> = {},
): ClosePeriodRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    periodStart,
    periodEnd,
    fiscalYearStart: `${periodStart.slice(0, 4)}-01-01`,
    fiscalYearEnd: `${periodStart.slice(0, 4)}-12-31`,
    status: "open",
    openedByRunId: null,
    openedAt: NOW.toISOString(),
    lockedByRunId: null,
    lockedAt: null,
    rolledFromPeriodStart: null,
    manualOverride: false,
    ...extra,
  };
}

export function opening(
  id: string,
  periodStart: string,
  accountNumber: string,
  openingBalanceCents: bigint,
  extra: Partial<OpeningBalanceRow> = {},
): OpeningBalanceRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    periodStart,
    accountNumber,
    openingBalanceCents,
    sourcePeriodStart: PERIOD,
    sourceKind: "prior_period_ending_balance",
    createdByRunId: "RUNX-SEED",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

/** The scope every module 6 run takes. */
export function closeScope(
  period: string = PERIOD,
  clientId: string = CLIENT_A1,
): { clientId: string; period: string } {
  return { clientId, period };
}

export function previewClose<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<RunOutcome<Proposal>> {
  return execute<S, Proposal>(db, run, scope, opts("preview", extra));
}

/**
 * Preview as the preparer, apply as the approver. Doc 05 D4 wants those to be
 * two people, and gate G18 checks that they were, so the helper every close test
 * uses does it properly rather than leaving each test to remember.
 */
export async function applyClose<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<{ preview: RunOutcome<Proposal>; applied: RunOutcome<Proposal> }> {
  const preview = await execute<S, Proposal>(
    db,
    run,
    scope,
    opts("preview", { actor: { userId: PREPARER, kind: "human" }, ...extra }),
  );
  const applied = await execute<S, Proposal>(
    db,
    run,
    scope,
    opts("apply", {
      actor: { userId: APPROVER, kind: "human" },
      ...extra,
      previewRunId: preview.executionId,
    }),
  );
  return { preview, applied };
}

/** The gate outcome by code, read from whatever the run wrote. */
export function outcomesOf(db: MemoryRunDb): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of db.all("close_gate_results")) {
    out.set(row.gateCode, row.outcome);
  }
  return out;
}

export function tieoutsOf(db: MemoryRunDb): SubTieoutRow[] {
  return [...db.all("sub_tieouts")].sort((a, b) =>
    a.accountNumber < b.accountNumber ? -1 : 1,
  );
}

export function requestsOf(db: MemoryRunDb): DocumentRequestRow[] {
  return [...db.all("document_requests")].sort((a, b) =>
    a.subjectKey < b.subjectKey ? -1 : 1,
  );
}

export function balanceOf(db: MemoryRunDb, accountNumber: string): bigint {
  let total = BigInt(0);
  for (const line of db.all("journal_lines")) {
    if (line.accountNumber === accountNumber) total += line.amountCents;
  }
  return total;
}
