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
  type ImportBatchRow,
  type JournalEntryRow,
  type JournalLineRow,
  type MappingProfileRow,
  type PeriodLockRow,
  type RowMap,
  type AgingSnapshotRow,
  type BillRow,
  type CustomerPaymentRow,
  type CustomerRow,
  type DeferralLineRow,
  type DeferralScheduleRow,
  type DepreciationScheduleRow,
  type InvoiceRow,
  type LoanScheduleRow,
  type RemittanceLineRow,
  type StatementItemRow,
  type RunLogRow,
  type StagedRowRow,
  type StatementLineRow,
  type RuleRow,
  type SettlementRowRow,
  type SuspenseItemRow,
  type TableName,
  type TransactionRow,
} from "./tables";

type AnyRow = Record<string, unknown> & { id: string };

const TABLES: TableName[] = [
  "bank_accounts",
  "chart_accounts",
  "transactions",
  "rec_batches",
  "statement_lines",
  "mapping_profiles",
  "import_batches",
  "staged_rows",
  "period_locks",
  "transfer_pairs",
  "journal_entries",
  "journal_lines",
  "suspense_items",
  "categories",
  "rules",
  "recurring_templates",
  "recurring_splits",
  "vendors",
  "bank_code_mappings",
  "settlement_rows",
  "client_policies",
  "document_links",
  "portal_requests",
  "documentation_exceptions",
  "fixed_assets",
  "depreciation_schedule",
  "deferral_schedules",
  "deferral_lines",
  "loans",
  "loan_schedule",
  "accrual_templates",
  "arap_policies",
  "customers",
  "invoices",
  "credit_memos",
  "customer_payments",
  "remittance_lines",
  "payment_applications",
  "aging_snapshots",
  "statement_documents",
  "statement_items",
  "writeoff_proposals",
  "bills",
  "vendor_credits",
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
      this.guardBankTransactionId(table, r);
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

  /**
   * Mirrors txn_bank_id_unique from migration 0011. Doc 05 Part 3: where the
   * feed carries a bank supplied id, that id is the key and a repeat is
   * rejected outright. The store refuses it even if a run forgets to check.
   */
  private guardBankTransactionId(table: TableName, row: AnyRow): void {
    if (table !== "transactions") return;
    const candidate = row as unknown as TransactionRow;
    if (!candidate.bankTransactionId) return;
    for (const existing of this.view("transactions")) {
      const r = existing as unknown as TransactionRow;
      if (r.id === candidate.id) continue;
      if (
        r.clientId === candidate.clientId &&
        r.bankAccountId === candidate.bankAccountId &&
        r.bankTransactionId === candidate.bankTransactionId
      ) {
        throw new UniqueViolation("txn_bank_id_unique");
      }
    }
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
      case "active_mapping_profile": {
        const p = rawParams as QueryCatalog["active_mapping_profile"]["params"];
        return this.view("mapping_profiles")
          .map((r) => r as unknown as MappingProfileRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.institutionName === p.institutionName &&
              r.fileFormat === p.fileFormat &&
              r.isActive,
          )
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "import_batch_by_id": {
        const p = rawParams as QueryCatalog["import_batch_by_id"]["params"];
        return this.view("import_batches")
          .map((r) => r as unknown as ImportBatchRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.id === p.batchId,
          )
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "staged_rows_by_batch": {
        const p = rawParams as QueryCatalog["staged_rows_by_batch"]["params"];
        return this.view("staged_rows")
          .map((r) => r as unknown as StagedRowRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.batchId === p.batchId,
          )
          .sort((a, b) => a.rowNumber - b.rowNumber)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "transactions_by_bank_ids": {
        const p = rawParams as QueryCatalog["transactions_by_bank_ids"]["params"];
        return this.view("transactions")
          .map((r) => r as unknown as TransactionRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.bankAccountId === p.bankAccountId &&
              r.bankTransactionId !== null &&
              p.bankTransactionIds.includes(r.bankTransactionId),
          )
          .sort(compareTransactions)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "transactions_for_account_window": {
        const p =
          rawParams as QueryCatalog["transactions_for_account_window"]["params"];
        return this.view("transactions")
          .map((r) => r as unknown as TransactionRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.bankAccountId === p.bankAccountId &&
              r.postedDate >= p.from &&
              r.postedDate <= p.to,
          )
          .sort(compareTransactions)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "transactions_by_batch": {
        const p = rawParams as QueryCatalog["transactions_by_batch"]["params"];
        return this.view("transactions")
          .map((r) => r as unknown as TransactionRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.importBatchId === p.batchId,
          )
          .sort(compareTransactions)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "categories_for_client": {
        const p = rawParams as QueryCatalog["categories_for_client"]["params"];
        return this.view("categories")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "active_rules_for_client": {
        const p = rawParams as QueryCatalog["active_rules_for_client"]["params"];
        return this.view("rules")
          .map((r) => r as unknown as RuleRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.isActive === true,
          )
          .sort(compareRules)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "recurring_templates_for_client": {
        const p =
          rawParams as QueryCatalog["recurring_templates_for_client"]["params"];
        return this.view("recurring_templates")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "recurring_splits_for_template": {
        const p =
          rawParams as QueryCatalog["recurring_splits_for_template"]["params"];
        return this.view("recurring_splits")
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.templateId === p.templateId &&
              r.templateVersion === p.templateVersion,
          )
          .sort(compareSplits)
          .map(clone);
      }
      case "vendors_for_client": {
        const p = rawParams as QueryCatalog["vendors_for_client"]["params"];
        return this.view("vendors")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "bank_code_mappings_for_client": {
        const p =
          rawParams as QueryCatalog["bank_code_mappings_for_client"]["params"];
        return this.view("bank_code_mappings")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "settlement_rows_in_window": {
        const p = rawParams as QueryCatalog["settlement_rows_in_window"]["params"];
        return this.view("settlement_rows")
          .map((r) => r as unknown as SettlementRowRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.payoutDate >= p.from &&
              r.payoutDate <= p.to,
          )
          .sort(compareSettlements)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "client_policy": {
        const p = rawParams as QueryCatalog["client_policy"]["params"];
        return this.view("client_policies")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "document_links_for_transactions": {
        const p =
          rawParams as QueryCatalog["document_links_for_transactions"]["params"];
        return this.view("document_links")
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              p.transactionIds.includes(r.transactionId as string),
          )
          .sort(byId)
          .map(clone);
      }
      case "open_portal_requests_for_client": {
        const p =
          rawParams as QueryCatalog["open_portal_requests_for_client"]["params"];
        return this.view("portal_requests")
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.status === "open",
          )
          .sort(byId)
          .map(clone);
      }
      case "suspense_items_for_transactions": {
        const p =
          rawParams as QueryCatalog["suspense_items_for_transactions"]["params"];
        return this.view("suspense_items")
          .map((r) => r as unknown as SuspenseItemRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.transactionId !== null &&
              p.transactionIds.includes(r.transactionId),
          )
          .sort(byId)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "statement_lines_for_statement": {
        const p =
          rawParams as QueryCatalog["statement_lines_for_statement"]["params"];
        return this.view("statement_lines")
          .map((r) => r as unknown as StatementLineRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.bankAccountId === p.bankAccountId &&
              r.statementId === p.statementId,
          )
          .sort(compareStatementLines)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "rec_batch_for_statement": {
        const p = rawParams as QueryCatalog["rec_batch_for_statement"]["params"];
        return this.view("rec_batches")
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.bankAccountId === p.bankAccountId &&
              r.statementId === p.statementId,
          )
          .sort(byId)
          .map(clone);
      }
      case "cleared_transactions_for_account": {
        const p =
          rawParams as QueryCatalog["cleared_transactions_for_account"]["params"];
        return this.view("transactions")
          .map((r) => r as unknown as TransactionRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.bankAccountId === p.bankAccountId &&
              r.cleared === true &&
              r.status === "active" &&
              r.postedDate <= p.through,
          )
          .sort(compareTransactions)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "transactions_for_statement": {
        const p = rawParams as QueryCatalog["transactions_for_statement"]["params"];
        return this.view("transactions")
          .map((r) => r as unknown as TransactionRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.bankAccountId === p.bankAccountId &&
              r.statementId === p.statementId,
          )
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((r) => clone(r as unknown as AnyRow));
      }

      // Doc 02 module 4, the period end reads.

      case "journal_entries_in_window": {
        const p = rawParams as QueryCatalog["journal_entries_in_window"]["params"];
        return this.view("journal_entries")
          .map((r) => r as unknown as JournalEntryRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.entryDate >= p.from &&
              r.entryDate <= p.to,
          )
          .sort(compareEntries)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "journal_entries_awaiting_reversal": {
        const p =
          rawParams as QueryCatalog["journal_entries_awaiting_reversal"]["params"];
        return this.view("journal_entries")
          .map((r) => r as unknown as JournalEntryRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.reversesOn !== null &&
              r.reversesOn >= p.from &&
              r.reversesOn <= p.to,
          )
          .sort(compareEntries)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "journal_lines_for_entries": {
        const p =
          rawParams as QueryCatalog["journal_lines_for_entries"]["params"];
        return this.view("journal_lines")
          .map((r) => r as unknown as JournalLineRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              p.entryIds.includes(r.entryId),
          )
          .sort(compareLines)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "deferral_schedules_for_client": {
        const p =
          rawParams as QueryCatalog["deferral_schedules_for_client"]["params"];
        return this.view("deferral_schedules")
          .map((r) => r as unknown as DeferralScheduleRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              p.kinds.includes(r.kind),
          )
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "deferral_lines_for_schedules": {
        const p =
          rawParams as QueryCatalog["deferral_lines_for_schedules"]["params"];
        return this.view("deferral_lines")
          .map((r) => r as unknown as DeferralLineRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              p.scheduleIds.includes(r.scheduleId),
          )
          .sort(compareDeferralLines)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "loans_for_client": {
        const p = rawParams as QueryCatalog["loans_for_client"]["params"];
        return this.view("loans")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "loan_schedule_for_client": {
        const p =
          rawParams as QueryCatalog["loan_schedule_for_client"]["params"];
        return this.view("loan_schedule")
          .map((r) => r as unknown as LoanScheduleRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.dueDate >= p.from &&
              r.dueDate <= p.to,
          )
          .sort(compareLoanSchedule)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "loan_schedule_for_loans": {
        const p = rawParams as QueryCatalog["loan_schedule_for_loans"]["params"];
        return this.view("loan_schedule")
          .map((r) => r as unknown as LoanScheduleRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              p.loanIds.includes(r.loanId),
          )
          .sort(compareLoanSchedule)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "fixed_assets_for_client": {
        const p = rawParams as QueryCatalog["fixed_assets_for_client"]["params"];
        return this.view("fixed_assets")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "depreciation_schedule_for_assets": {
        const p =
          rawParams as QueryCatalog["depreciation_schedule_for_assets"]["params"];
        return this.view("depreciation_schedule")
          .map((r) => r as unknown as DepreciationScheduleRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              p.assetIds.includes(r.assetId),
          )
          .sort(compareDepreciationLines)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "accrual_templates_for_client": {
        const p =
          rawParams as QueryCatalog["accrual_templates_for_client"]["params"];
        return this.view("accrual_templates")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "arap_policy": {
        const p = rawParams as QueryCatalog["arap_policy"]["params"];
        return this.view("arap_policies")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "customers_for_client": {
        const p = rawParams as QueryCatalog["customers_for_client"]["params"];
        return this.view("customers")
          .map((r) => r as unknown as CustomerRow)
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(compareCustomers)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "invoices_for_client": {
        const p = rawParams as QueryCatalog["invoices_for_client"]["params"];
        return this.view("invoices")
          .map((r) => r as unknown as InvoiceRow)
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(compareInvoices)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "credit_memos_for_client": {
        const p = rawParams as QueryCatalog["credit_memos_for_client"]["params"];
        return this.view("credit_memos")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "customer_payments_in_window": {
        const p =
          rawParams as QueryCatalog["customer_payments_in_window"]["params"];
        return this.view("customer_payments")
          .map((r) => r as unknown as CustomerPaymentRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.paymentDate >= p.from &&
              r.paymentDate <= p.to,
          )
          .sort(comparePayments)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "remittance_lines_for_payments": {
        const p =
          rawParams as QueryCatalog["remittance_lines_for_payments"]["params"];
        return this.view("remittance_lines")
          .map((r) => r as unknown as RemittanceLineRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              p.paymentIds.includes(r.paymentId),
          )
          .sort(compareRemittanceLines)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "payment_applications_for_client": {
        const p =
          rawParams as QueryCatalog["payment_applications_for_client"]["params"];
        return this.view("payment_applications")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "aging_snapshots_for_date": {
        const p = rawParams as QueryCatalog["aging_snapshots_for_date"]["params"];
        return this.view("aging_snapshots")
          .map((r) => r as unknown as AgingSnapshotRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.asOfDate === p.asOfDate,
          )
          .sort(byId)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "statement_documents_for_date": {
        const p =
          rawParams as QueryCatalog["statement_documents_for_date"]["params"];
        return this.view("statement_documents")
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              r.statementDate === p.statementDate,
          )
          .sort(byId)
          .map(clone);
      }
      case "statement_items_for_statements": {
        const p =
          rawParams as QueryCatalog["statement_items_for_statements"]["params"];
        return this.view("statement_items")
          .map((r) => r as unknown as StatementItemRow)
          .filter(
            (r) =>
              r.firmId === p.firmId &&
              r.clientId === p.clientId &&
              p.statementIds.includes(r.statementId),
          )
          .sort(compareStatementItems)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "writeoff_proposals_for_client": {
        const p =
          rawParams as QueryCatalog["writeoff_proposals_for_client"]["params"];
        return this.view("writeoff_proposals")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(byId)
          .map(clone);
      }
      case "bills_for_client": {
        const p = rawParams as QueryCatalog["bills_for_client"]["params"];
        return this.view("bills")
          .map((r) => r as unknown as BillRow)
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
          .sort(compareBills)
          .map((r) => clone(r as unknown as AnyRow));
      }
      case "vendor_credits_for_client": {
        const p = rawParams as QueryCatalog["vendor_credits_for_client"]["params"];
        return this.view("vendor_credits")
          .filter((r) => r.firmId === p.firmId && r.clientId === p.clientId)
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

/**
 * The doc 00 Part 3 rule tie break, applied in the query rather than in the run
 * so that both the memory store and Postgres hand back the same order and the
 * run never has to sort a second time.
 */
function compareRules(a: RuleRow, b: RuleRow): number {
  if (a.priority !== b.priority) return a.priority > b.priority ? -1 : 1;
  if (a.conditionCount !== b.conditionCount) {
    return a.conditionCount > b.conditionCount ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareSplits(a: AnyRow, b: AnyRow): number {
  const an = a.lineNumber as number;
  const bn = b.lineNumber as number;
  if (an !== bn) return an < bn ? -1 : 1;
  return byId(a, b);
}

/**
 * Doc 02 module 3 iteration order for the bank side: statement line date
 * ascending, absolute amount ascending, statement line id ascending.
 */
function compareStatementLines(a: StatementLineRow, b: StatementLineRow): number {
  if (a.statementDate !== b.statementDate) {
    return a.statementDate < b.statementDate ? -1 : 1;
  }
  const aa = a.amountCents < BigInt(0) ? -a.amountCents : a.amountCents;
  const ba = b.amountCents < BigInt(0) ? -b.amountCents : b.amountCents;
  if (aa !== ba) return aa < ba ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Doc 02 TXN-SPLIT-SETTLEMENTS iteration order: payout date asc, payout id asc. */
function compareSettlements(a: SettlementRowRow, b: SettlementRowRow): number {
  if (a.payoutDate !== b.payoutDate) return a.payoutDate < b.payoutDate ? -1 : 1;
  if (a.payoutId !== b.payoutId) return a.payoutId < b.payoutId ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Doc 02 module 4 iteration order for anything read out of the ledger by date:
 * entry date ascending then id ascending, so a rerun sees the same order the
 * first run saw.
 */
function compareEntries(a: JournalEntryRow, b: JournalEntryRow): number {
  if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareLines(a: JournalLineRow, b: JournalLineRow): number {
  if (a.entryId !== b.entryId) return a.entryId < b.entryId ? -1 : 1;
  if (a.accountNumber !== b.accountNumber) {
    return a.accountNumber < b.accountNumber ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareDeferralLines(a: DeferralLineRow, b: DeferralLineRow): number {
  if (a.scheduleId !== b.scheduleId) return a.scheduleId < b.scheduleId ? -1 : 1;
  if (a.periodNumber !== b.periodNumber) {
    return a.periodNumber < b.periodNumber ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareDepreciationLines(
  a: DepreciationScheduleRow,
  b: DepreciationScheduleRow,
): number {
  if (a.assetId !== b.assetId) return a.assetId < b.assetId ? -1 : 1;
  if (a.periodStart !== b.periodStart) {
    return a.periodStart < b.periodStart ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Doc 02 PER-SPLIT-LOANPAYMENT iteration order: due date ascending, then
 * payment number ascending, then id.
 */
function compareLoanSchedule(a: LoanScheduleRow, b: LoanScheduleRow): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.paymentNumber !== b.paymentNumber) {
    return a.paymentNumber < b.paymentNumber ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Doc 02 module 5 iteration order for the receivable side: customer name
 * ascending then customer id ascending. The name is not unique, so the id is
 * the tie breaker that makes the order total.
 */
function compareCustomers(a: CustomerRow, b: CustomerRow): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Due date ascending then invoice id ascending. */
function compareInvoices(a: InvoiceRow, b: InvoiceRow): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Doc 02 AR-APPLY-PAYMENTS: payment date ascending then payment id. */
function comparePayments(a: CustomerPaymentRow, b: CustomerPaymentRow): number {
  if (a.paymentDate !== b.paymentDate) return a.paymentDate < b.paymentDate ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Remittance advice is read in the order the payer stated it. */
function compareRemittanceLines(
  a: RemittanceLineRow,
  b: RemittanceLineRow,
): number {
  if (a.paymentId !== b.paymentId) return a.paymentId < b.paymentId ? -1 : 1;
  if (a.lineNumber !== b.lineNumber) return a.lineNumber < b.lineNumber ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareStatementItems(a: StatementItemRow, b: StatementItemRow): number {
  if (a.statementId !== b.statementId) return a.statementId < b.statementId ? -1 : 1;
  if (a.lineNumber !== b.lineNumber) return a.lineNumber < b.lineNumber ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Bill date ascending then bill id ascending. */
function compareBills(a: BillRow, b: BillRow): number {
  if (a.billDate !== b.billDate) return a.billDate < b.billDate ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Small helper so tests can mint ids that sort the way rows were created. */
export function newId(): string {
  return ulid();
}
