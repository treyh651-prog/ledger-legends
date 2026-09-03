/**
 * The database port for runs.
 *
 * Four capabilities, and nothing else: read a named query, open a transaction
 * with a stated isolation level, take a two key advisory lock inside that
 * transaction, and write rows. Writes are split into insert and update because
 * a field write proposal has to be able to change an existing row.
 *
 * Keeping the port this narrow is what lets the in memory implementation used
 * by the tests be honest about the guarantees the Postgres implementation gets
 * from triggers.
 */

import type { Cents, Ulid } from "./contract";
import type {
  BankAccountRow,
  ChartAccountRow,
  JournalEntryRow,
  JournalLineRow,
  PeriodLockRow,
  RowMap,
  RunLogEventRow,
  RunLogItemRow,
  RunLogRow,
  SuspenseItemRow,
  TableName,
  TransactionRow,
  TransferPairRow,
} from "./tables";

export type Isolation = "repeatable read" | "serializable";

/**
 * Session context set at transaction start. In Postgres these become
 * set_config calls, which is what the override guard and the row level
 * security policies read.
 */
export interface TxSession {
  isolation: Isolation;
  readOnly: boolean;
  firmId: Ulid;
  clientId: Ulid;
  actorId: Ulid;
  /** 'run', 'schedule', or 'sequence' for automation, 'human' for a person. */
  actorKind: "human" | "run" | "schedule" | "sequence";
}

/** The named query catalog. Params in, rows out, both typed. */
export interface QueryCatalog {
  bank_accounts_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: BankAccountRow;
  };
  chart_account: {
    params: { firmId: Ulid; clientId: Ulid; accountNumber: string };
    row: ChartAccountRow;
  };
  open_period_locks: {
    params: { firmId: Ulid; clientId: Ulid };
    row: PeriodLockRow;
  };
  /**
   * Candidate transactions in a date window. Overridden rows are excluded by
   * predicate when includeOverridden is false, per doc 03 Part 6 rule 1.
   */
  transactions_in_window: {
    params: {
      firmId: Ulid;
      clientId: Ulid;
      from: string;
      to: string;
      bankAccountIds: Ulid[] | null;
      includeOverridden: boolean;
    };
    row: TransactionRow;
  };
  /** Ids only, so an overridden row is counted without being loaded to write. */
  overridden_transaction_ids_in_window: {
    params: { firmId: Ulid; clientId: Ulid; from: string; to: string };
    row: { id: Ulid };
  };
  transfer_pairs_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: TransferPairRow;
  };
  applied_run_by_idempotency_key: {
    params: { idempotencyKey: string };
    row: RunLogRow;
  };
  run_log_by_id: {
    params: { firmId: Ulid; executionId: string };
    row: RunLogRow;
  };
  run_log_items_by_execution: {
    params: { firmId: Ulid; executionId: string };
    row: RunLogItemRow;
  };
  run_log_events_by_execution: {
    params: { firmId: Ulid; executionId: string };
    row: RunLogEventRow;
  };
  started_runs_before: {
    params: { before: string };
    row: RunLogRow;
  };
  journal_entries_by_run: {
    params: { firmId: Ulid; executionId: string };
    row: JournalEntryRow;
  };
  journal_entries_referencing: {
    params: { firmId: Ulid; clientId: Ulid; entryIds: Ulid[] };
    row: JournalEntryRow;
  };
  journal_lines_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: JournalLineRow;
  };
  suspense_items_by_run: {
    params: { firmId: Ulid; executionId: string };
    row: SuspenseItemRow;
  };
  transactions_by_ids: {
    params: { firmId: Ulid; clientId: Ulid; ids: Ulid[] };
    row: TransactionRow;
  };
}

export type QueryName = keyof QueryCatalog;

export interface RunTx {
  readonly session: TxSession;
  query<K extends QueryName>(
    name: K,
    params: QueryCatalog[K]["params"],
  ): Promise<QueryCatalog[K]["row"][]>;
  /** Two key form. Returns false when another transaction holds the lock. */
  tryAdvisoryXactLock(highKey: string, lowKey: string): Promise<boolean>;
  insert<T extends TableName>(table: T, rows: RowMap[T][]): Promise<void>;
  update<T extends TableName>(
    table: T,
    rowId: string,
    patch: Partial<RowMap[T]>,
  ): Promise<void>;
}

export interface RunDb {
  tx<T>(session: TxSession, fn: (tx: RunTx) => Promise<T>): Promise<T>;
}

/** Raised when a write would land on a row carrying the manual override flag. */
export class OverrideProtectedError extends Error {
  readonly code = "OVERRIDE_PROTECTED_ROW";
  constructor(
    readonly table: string,
    readonly rowId: string,
  ) {
    super(`override_protected_row: ${table} ${rowId}`);
  }
}

/** Raised when a ledger write would land inside a locked period. */
export class LockedPeriodError extends Error {
  readonly code = "LOCKED_PERIOD";
  constructor(
    readonly date: string,
    readonly clientId: string,
  ) {
    super(`locked_period: ${date} is inside a locked period for client ${clientId}`);
  }
}

/** Raised when something tries to change an insert only log table. */
export class ImmutableLogError extends Error {
  readonly code = "IMMUTABLE_LOG";
  constructor(readonly table: string) {
    super(`insert_only_table: ${table} may not be updated or deleted`);
  }
}

/** Raised on a write write conflict under serializable isolation. */
export class SerializationFailure extends Error {
  readonly code = "SERIALIZATION_FAILURE";
  readonly retryable = true;
  constructor(readonly key: string) {
    super(`serialization_failure on ${key}`);
  }
}

/** Raised when an idempotency key is inserted twice for mode apply. */
export class UniqueViolation extends Error {
  readonly code = "UNIQUE_VIOLATION";
  constructor(readonly constraintName: string) {
    super(`unique_violation: ${constraintName}`);
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof SerializationFailure;
}

/** Sum of signed cents, used by tests and gates. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = BigInt(0);
  for (const v of values) total += v;
  return total;
}
