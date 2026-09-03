/**
 * Fixtures for the module 3 reconciliation tests.
 *
 * The base fixtures already give client A1 two bank accounts and a chart. What
 * reconciliation adds is the bank side: a statement made of lines, and a batch
 * to hang the difference on. Every builder takes an overrides object so a test
 * can say in one line what it is actually about.
 *
 * One statement, STMT-JAN, on BA-A1-OP, covering January 2026. That is the shape
 * of nearly every test below, so it is the default everywhere.
 */

import type { MemoryRunDb } from "../db-memory";
import type { Proposal, Run } from "../contract";
import { execute, type ExecuteOptions, type RunOutcome } from "../execute";
import type { RecBatchRow, StatementLineRow, TransactionRow } from "../tables";
import { derivedId } from "../ids";
import { CLIENT_A1, FIRM_A, NOW, baseDb, chartAccount, opts } from "./fixtures";
import type { MatchTieredScope } from "../runs/rec-match-tiered";
import type { ClearMatchedScope } from "../runs/rec-clear-matched";
import type { FlagStaleScope } from "../runs/rec-flag-stale";

export const STATEMENT = "STMT-JAN";
export const ACCOUNT = "BA-A1-OP";
export const PERIOD_START = "2026-01-01";
export const PERIOD_END = "2026-01-31";
export const AS_OF = "2026-02-10";

/** The batch id REC-MATCH-TIERED derives for the January statement. */
export const BATCH_ID = derivedId(STATEMENT, "rec-batch", 0);

/** The base database plus the suspense account the stale run's items name. */
export function recDb(): MemoryRunDb {
  const db = baseDb();
  db.seed("chart_accounts", [
    chartAccount("CH-A1-1990", FIRM_A, CLIENT_A1, "1990", "Suspense"),
  ]);
  return db;
}

export function statementLine(
  id: string,
  statementDate: string,
  amountCents: bigint,
  extra: Partial<StatementLineRow> = {},
): StatementLineRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    bankAccountId: ACCOUNT,
    statementId: STATEMENT,
    statementDate,
    amountCents,
    currency: "USD",
    description: `statement line ${id}`,
    normalizedVendor: null,
    checkNumber: null,
    sourceFormat: "csv",
    recBatchId: null,
    matchTier: null,
    matchConfidence: null,
    matchDiffCents: null,
    matchConfirmed: false,
    matchedTransactionId: null,
    matchedTransactionCount: 0,
    matchedByRunId: null,
    version: 1,
    ...extra,
  };
}

export function recBatch(extra: Partial<RecBatchRow> = {}): RecBatchRow {
  return {
    id: BATCH_ID,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    bankAccountId: ACCOUNT,
    statementId: STATEMENT,
    statementPeriod: "2026-01",
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    statementBalanceCents: BigInt(0),
    clearedLedgerBalanceCents: null,
    diffCents: null,
    state: "open",
    openedBy: CLIENT_A1,
    openedAt: NOW.toISOString(),
    openedByRunId: "RUNX-SEED",
    closedAt: null,
    closedByRunId: null,
    version: 1,
    ...extra,
  };
}

/** The matching scope, with the statement balance as a cents string. */
export function matchScope(
  statementBalanceCents: bigint,
  extra: Partial<MatchTieredScope> = {},
): MatchTieredScope {
  return {
    clientId: CLIENT_A1,
    bankAccountId: ACCOUNT,
    statementId: STATEMENT,
    statementPeriod: "2026-01",
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    statementBalanceCents: statementBalanceCents.toString(),
    windowDays: 5,
    toleranceCents: 1,
    maxGroupSize: 4,
    candidatePoolCap: 12,
    ...extra,
  };
}

export function clearScope(extra: Partial<ClearMatchedScope> = {}): ClearMatchedScope {
  return {
    clientId: CLIENT_A1,
    bankAccountId: ACCOUNT,
    statementId: STATEMENT,
    clearUnconfirmed: false,
    ...extra,
  };
}

export function staleScope(extra: Partial<FlagStaleScope> = {}): FlagStaleScope {
  return {
    clientId: CLIENT_A1,
    bankAccountIds: null,
    asOf: AS_OF,
    lookbackDays: 730,
    thresholdDays: null,
    ...extra,
  };
}

/** Preview a reconciliation run. Preview is apply with the commit removed. */
export function previewRec<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<RunOutcome<Proposal>> {
  return execute<S, Proposal>(db, run, scope, opts("preview", extra));
}

/** Preview then apply, the only legal way to apply. */
export async function applyRec<S>(
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

export function lineById(db: MemoryRunDb, id: string): StatementLineRow {
  const row = db.all("statement_lines").find((l) => l.id === id);
  if (row === undefined) throw new Error(`statement line ${id} not found`);
  return row;
}

export function txnById(db: MemoryRunDb, id: string): TransactionRow {
  const row = db.all("transactions").find((t) => t.id === id);
  if (row === undefined) throw new Error(`transaction ${id} not found`);
  return row;
}

export function batchRow(db: MemoryRunDb): RecBatchRow {
  const rows = db.all("rec_batches");
  if (rows.length !== 1) {
    throw new Error(`expected exactly one batch, found ${String(rows.length)}`);
  }
  return rows[0];
}

/**
 * Accept a match the way a person does on the reconcile screen. Seeding is used
 * rather than a run, because operator acceptance is a person's act and no run in
 * module 3 owns it.
 */
export function confirmLine(db: MemoryRunDb, id: string): void {
  db.seed("statement_lines", [{ ...lineById(db, id), matchConfirmed: true }]);
}

/** True when the run recorded that skip reason against the row. */
export function skippedFor(
  outcome: RunOutcome<Proposal>,
  rowId: string,
  reason: string,
): boolean {
  return outcome.result.skips.some((s) => s.rowId === rowId && s.reason === reason);
}

/** Every skip detail recorded against one row, sorted so a compare is stable. */
export function skipDetails(
  outcome: RunOutcome<Proposal>,
  rowId: string,
): string[] {
  return outcome.result.skips
    .filter((s) => s.rowId === rowId)
    .map((s) => `${s.reason}:${s.detail}`)
    .sort();
}
