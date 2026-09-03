/**
 * In memory implementation of the run port, used by the tests.
 *
 * It is not a toy. It reproduces the four guarantees doc 03 pushes into
 * Postgres, because a test suite running against a store that cannot refuse a
 * write proves nothing:
 *
 *   1. Insert only run log tables, matching the do instead nothing rules.
 *   2. The manual override guard, matching ledger.guard_manual_override.
 *   3. The period lock guard on ledger writes, matching ledger.enforce_period_lock.
 *   4. Two key advisory locks that release when the transaction ends, plus a
 *      write write conflict check that raises a serialization failure.
 *
 * Every query filters on firmId and clientId, which is how the two tenant
 * negative test can pass or fail for a real reason.
 */

import {
  ImmutableLogError,
  LockedPeriodError,
  OverrideProtectedError,
  SerializationFailure,
  UniqueViolation,
  type QueryCatalog,
  type QueryName,
  type RunDb,
  type RunTx,
  type TxSession,
} from "./db";
import { isLockedDay } from "./dates";
import { ulid } from "./ids";
import {
  INSERT_ONLY_TABLES,
  OVERRIDE_WATCHED_FIELDS,
  type JournalEntryRow,
  type PeriodLockRow,
  type RowMap,
  type RunLogRow,
  type TableName,
  type TransactionRow,
} from "./tables";

type AnyRow = Record<string, unknown> & { id: string };

const TABLES: TableName[] = [
  "bank_accounts",
  "chart_accounts",
  "transactions",
  "period_locks",
  "transfer_pairs",
  "journal_entries",
  "journal_lines",
  "suspense_items",
  "run_log",
  "run_log_items",
  "run_log_events",
  "run_sequence",
];

function key(table: string, rowId: string): string {
  return `${table}:${rowId}`;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class MemoryRunDb implements RunDb {
  private committed = new Map<TableName, Map<string, AnyRow>>();
  private rowVersions = new Map<string, number>();
  private locks = new Map<string, string>();
  private lockTicket = 0;

  constructor() {
    for (const t of TABLES) this.committed.set(t, new Map());
  }

  /** Test seeding. Bypasses the guards on purpose, like a migration would. */
  seed<T extends TableName>(table: T, rows: RowMap[T][]): void {
    const target = this.committed.get(table);
    if (!target) throw new Error(`unknown table ${table}`);
    for (const row of rows) {
      const r = row as unknown as AnyRow;
      target.set(r.id, { ...r });
      this.rowVersions.set(key(table, r.id), 1);
    }
  }

  /** Read every committed row of a table. Tests use this for assertions. */
  all<T extends TableName>(table: T): RowMap[T][] {
    const target = this.committed.get(table);
    if (!target) throw new Error(`unknown table ${table}`);
    return Array.from(target.values())
      .map((r) => ({ ...r }) as unknown as RowMap[T])
      .sort((a, b) => byId(a as unknown as AnyRow, b as unknown as AnyRow));
  }

  heldLocks(): string[] {
    return Array.from(this.locks.keys()).sort();
  }

  async tx<T>(session: TxSession, fn: (tx: RunTx) => Promise<T>): Promise<T> {
    const tx = new MemoryTx(this, session);
    try {
      const out = await fn(tx);
      this.commit(tx);
      return out;
    } catch (err) {
      this.rollback(tx);
      throw err;
    }
  }

  // internals used by MemoryTx

  committedRows(table: TableName): AnyRow[] {
    const target = this.committed.get(table);
    if (!target) throw new Error(`unknown table ${table}`);
    return Array.from(target.values());
  }

  committedRow(table: TableName, rowId: string): AnyRow | undefined {
    return this.committed.get(table)?.get(rowId);
  }

  versionOf(table: TableName, rowId: string): number {
    return this.rowVersions.get(key(table, rowId)) ?? 0;
  }

  takeLock(lockKey: string, owner: string): boolean {
    if (this.locks.has(lockKey)) return false;
    this.locks.set(lockKey, owner);
    return true;
  }

  nextLockOwner(): string {
    this.lockTicket += 1;
    return `tx-${this.lockTicket}`;
  }

  private commit(tx: MemoryTx): void {
    for (const [k, base] of tx.readVersions) {
      const [table, rowId] = splitKey(k);
      if (this.versionOf(table, rowId) !== base) {
        this.releaseLocks(tx);
        throw new SerializationFailure(k);
      }
    }
    for (const [k, row] of tx.writes) {
      const [table, rowId] = splitKey(k);
      const target = this.committed.get(table);
      if (!target) throw new Error(`unknown table ${table}`);
      target.set(rowId, row);
      this.rowVersions.set(k, this.versionOf(table, rowId) + 1);
    }
    this.releaseLocks(tx);
  }

  private rollback(tx: MemoryTx): void {
    tx.writes.clear();
    this.releaseLocks(tx);
  }

  private releaseLocks(tx: MemoryTx): void {
    for (const lockKey of tx.ownedLocks) {
      if (this.locks.get(lockKey) === tx.owner) this.locks.delete(lockKey);
    }
    tx.ownedLocks.clear();
  }
}

function splitKey(k: string): [TableName, string] {
  const idx = k.indexOf(":");
  return [k.slice(0, idx) as TableName, k.slice(idx + 1)];
}

class MemoryTx implements RunTx {
  readonly writes = new Map<string, AnyRow>();
  readonly readVersions = new Map<string, number>();
  readonly ownedLocks = new Set<string>();
  readonly owner: string;

  constructor(
    private readonly db: MemoryRunDb,
    readonly session: TxSession,
  ) {
    this.owner = db.nextLockOwner();
  }

  private view(table: TableName): AnyRow[] {
    const out = new Map<string, AnyRow>();
    for (const row of this.db.committedRows(table)) out.set(row.id, row);
    for (const [k, row] of this.writes) {
      const [t, rowId] = splitKey(k);
      if (t === table) out.set(rowId, row);
    }
    return Array.from(out.values());
  }

  private lookup(table: TableName, rowId: string): AnyRow | undefined {
    const pending = this.writes.get(key(table, rowId));
    if (pending) return pending;
    return this.db.committedRow(table, rowId);
  }

  async tryAdvisoryXactLock(highKey: string, lowKey: string): Promise<boolean> {
    const lockKey = `${highKey}|${lowKey}`;
    if (this.ownedLocks.has(lockKey)) return true;
    const got = this.db.takeLock(lockKey, this.owner);
    if (got) this.ownedLocks.add(lockKey);
    return got;
  }

  async insert<T extends TableName>(table: T, rows: RowMap[T][]): Promise<void> {
    if (this.session.readOnly) {
      throw new Error(`read only transaction cannot insert into ${table}`);
    }
    for (const row of rows) {
      const r = { ...(row as unknown as AnyRow) };
      if (this.lookup(table, r.id)) {
        throw new UniqueViolation(`${table}_pkey`);
      }
      this.guardLedgerDate(table, r);
      this.guardIdempotency(table, r);
      const k = key(table, r.id);
      if (!this.readVersions.has(k)) {
        this.readVersions.set(k, this.db.versionOf(table, r.id));
      }
      this.writes.set(k, r);
    }
  }

  async update<T extends TableName>(
    table: T,
    rowId: string,
    patch: Partial<RowMap[T]>,
  ): Promise<void> {
    if (this.session.readOnly) {
      throw new Error(`read only transaction cannot update ${table}`);
    }
    if (INSERT_ONLY_TABLES.includes(table)) throw new ImmutableLogError(table);
    const current = this.lookup(table, rowId);
    if (!current) throw new Error(`row not found: ${table} ${rowId}`);
    const next = { ...current, ...(patch as Record<string, unknown>) };
    // Mirrors the row version trigger. A row that changed is a different row for
    // scope hashing, which is what makes a stale preview detectable.
    if (typeof current.version === "number" && !("version" in patch)) {
      next.version = current.version + 1;
    }
    this.guardOverride(table, current, next, rowId);
    this.guardLedgerDate(table, next);
    const k = key(table, rowId);
    if (!this.readVersions.has(k)) {
      this.readVersions.set(k, this.db.versionOf(table, rowId));
    }
    this.writes.set(k, next as AnyRow);
  }

  /** Mirrors ledger.guard_manual_override. */
  private guardOverride(
    table: TableName,
    current: AnyRow,
    next: AnyRow,
    rowId: string,
  ): void {
    const isAutomation = this.session.actorKind !== "human";
    if (current.manualOverride === true && isAutomation) {
      for (const field of OVERRIDE_WATCHED_FIELDS) {
        if (field in next && next[field] !== current[field]) {
          throw new OverrideProtectedError(table, rowId);
        }
      }
    }
    if (
      current.manualOverride === true &&
      next.manualOverride === false &&
      isAutomation
    ) {
      throw new OverrideProtectedError(table, rowId);
    }
  }

  /** Mirrors ledger.enforce_period_lock, including on delete style rewrites. */
  private guardLedgerDate(table: TableName, row: AnyRow): void {
    if (table !== "journal_entries" && table !== "journal_lines") return;
    const day = row.entryDate as string | undefined;
    const clientId = row.clientId as string | undefined;
    if (!day || !clientId) return;
    const locks = this.db
      .committedRows("period_locks")
      .filter((l) => (l as unknown as PeriodLockRow).clientId === clientId)
      .map((l) => l as unknown as PeriodLockRow);
    if (isLockedDay(locks, day)) throw new LockedPeriodError(day, clientId);
  }

  /** The unique idempotency key on run_log for mode apply. */
  private guardIdempotency(table: TableName, row: AnyRow): void {
    if (table !== "run_log") return;
    const candidate = row as unknown as RunLogRow;
    if (candidate.mode !== "apply") return;
    for (const existing of this.view("run_log")) {
      const r = existing as unknown as RunLogRow;
      if (r.mode === "apply" && r.idempotencyKey === candidate.idempotencyKey) {
        throw new UniqueViolation("run_log_apply_idempotency_key");
      }
    }
  }

  async query<K extends QueryName>(
    name: K,
    params: QueryCatalog[K]["params"],
  ): Promise<QueryCatalog[K]["row"][]> {
    const rows = this.runQuery(name, params);
    return rows as QueryCatalog[K]["row"][];
  }

  private runQuery(name: QueryName, rawParams: unknown): unknown[] {
    switch (name) {
      case "bank_accounts_for_client": {
        const p = rawParams as QueryCatalog["bank_accounts_for_client"]["params"];
        return this.view("bank_accounts")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "chart_account": {
        const p = rawParams as QueryCatalog["chart_account"]["params"];
        return this.view("chart_accounts")
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.accountNumber === p.accountNumber,
          )
          .sort(byId)
          .map(clone);
      }
      case "open_period_locks": {
        const p = rawParams as QueryCatalog["open_period_locks"]["params"];
        return this.view("period_locks")
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.unlockedAt === null,
          )
          .sort(byId)
          .map(clone);
      }
      case "transactions_in_window": {
        const p = rawParams as QueryCatalog["transactions_in_window"]["params"];
        return this.view("transactions")
          .map((r) => r as unknown as TransactionRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.postedDate >= p.from &&
              r.postedDate <= p.to &&
              (p.includeOverridden || r.manualOverride === false) &&
              (p.bankAccountIds === null ||
                p.bankAccountIds.includes(r.bankAccountId)),
          )
          .sort(compareTransactions)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "overridden_transaction_ids_in_window": {
        const p =
          rawParams as QueryCatalog["overridden_transaction_ids_in_window"]["params"];
        return this.view("transactions")
          .map((r) => r as unknown as TransactionRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.postedDate >= p.from &&
              r.postedDate <= p.to &&
              r.manualOverride === true,
          )
          .sort(compareTransactions)
          .map((r) => ({ id: r.id }));
      }
      case "transfer_pairs_for_client": {
        const p = rawParams as QueryCatalog["transfer_pairs_for_client"]["params"];
        return this.view("transfer_pairs")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "applied_run_by_idempotency_key": {
        const p =
          rawParams as QueryCatalog["applied_run_by_idempotency_key"]["params"];
        return this.view("run_log")
          .map((r) => r as unknown as RunLogRow)
          .filter(
            (r) => r.mode === "apply" && r.idempotencyKey === p.idempotencyKey,
          )
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "run_log_by_id": {
        const p = rawParams as QueryCatalog["run_log_by_id"]["params"];
        return this.view("run_log")
          .filter((r) => r.firmId === p.firmId && r.id === p.executionId)
          .map(clone);
      }
      case "run_log_items_by_execution": {
        const p =
          rawParams as QueryCatalog["run_log_items_by_execution"]["params"];
        return this.view("run_log_items")
          .filter(
            (r) =>
              r.firmId === p.firmId && r.runExecutionId === p.executionId,
          )
          .sort(byId)
          .map(clone);
      }
      case "run_log_events_by_execution": {
        const p =
          rawParams as QueryCatalog["run_log_events_by_execution"]["params"];
        return this.view("run_log_events")
          .filter(
            (r) =>
              r.firmId === p.firmId && r.runExecutionId === p.executionId,
          )
          .sort(byId)
          .map(clone);
      }
      case "started_runs_before": {
        const p = rawParams as QueryCatalog["started_runs_before"]["params"];
        return this.view("run_log")
          .map((r) => r as unknown as RunLogRow)
          .filter((r) => r.status === "started" && r.startedAt <= p.before)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "journal_entries_by_run": {
        const p = rawParams as QueryCatalog["journal_entries_by_run"]["params"];
        return this.view("journal_entries")
          .filter(
            (r) => r.firmId === p.firmId && r.createdByRunId === p.executionId,
          )
          .sort(byId)
          .map(clone);
      }
      case "journal_entries_referencing": {
        const p =
          rawParams as QueryCatalog["journal_entries_referencing"]["params"];
        return this.view("journal_entries")
          .map((r) => r as unknown as JournalEntryRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.reversalOf !== null &&
              p.entryIds.includes(r.reversalOf),
          )
          .sort(byId)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "journal_lines_for_client": {
        const p =
          rawParams as QueryCatalog["journal_lines_for_client"]["params"];
        return this.view("journal_lines")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "suspense_items_by_run": {
        const p = rawParams as QueryCatalog["suspense_items_by_run"]["params"];
        return this.view("suspense_items")
          .filter(
            (r) => r.firmId === p.firmId && r.createdByRunId === p.executionId,
          )
          .sort(byId)
          .map(clone);
      }
      case "transactions_by_ids": {
        const p = rawParams as QueryCatalog["transactions_by_ids"]["params"];
        return this.view("transactions")
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              p.ids.includes(r.id),
          )
          .sort(byId)
          .map(clone);
      }
      default: {
        const exhaustive: never = name;
        throw new Error(`unknown query ${String(exhaustive)}`);
      }
    }
  }
}

function clone(row: AnyRow): AnyRow {
  const out: AnyRow = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v)) out[k] = v.slice();
  }
  return out;
}

/** Doc 02 iteration order: date ascending, absolute amount, then id. */
function compareTransactions(a: TransactionRow, b: TransactionRow): number {
  if (a.postedDate !== b.postedDate) return a.postedDate < b.postedDate ? -1 : 1;
  const aa = a.amountCents < BigInt(0) ? -a.amountCents : a.amountCents;
  const ba = b.amountCents < BigInt(0) ? -b.amountCents : b.amountCents;
  if (aa !== ba) return aa < ba ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Small helper so tests can mint ids that sort the way rows were created. */
export function newId(): string {
  return ulid();
}
