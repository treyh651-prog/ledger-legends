/**
 * Row shapes for the tables a run may read or write.
 *
 * These are deliberately the narrow projections runs need, not the full DDL in
 * docs/04-data-structures.md. Money is bigint cents. Dates are ISO day strings
 * of the form YYYY-MM-DD so ordering is lexical and stable.
 */

import type { Cents, RunMode, RunStatus, Ulid } from "./contract";

export interface BankAccountRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  /** Chart account this bank or card account posts to, for example "1010". */
  accountNumber: string;
  nickname: string;
  kind: "bank" | "card";
  isProcessorDestination: boolean;
}

export interface ChartAccountRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  accountNumber: string;
  name: string;
}

/**
 * The bank transaction register, migration 0011. The projection below is what
 * the framework and the import pipeline touch, not the whole DDL.
 */
export interface TransactionRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  bankAccountId: Ulid;
  /** The chart account the funding source posts to, for example "1010". */
  accountNumber: string;
  postedDate: string;
  /** Signed. Money out of the account is negative. */
  amountCents: Cents;
  currency: string;
  description: string;
  normalizedVendor: string;
  checkNumber: string | null;
  bankCode: string | null;
  /** The bank supplied unique id, null when the format did not carry one. */
  bankTransactionId: string | null;
  source: "import" | "manual" | "conversion";
  importBatchId: Ulid | null;
  stagedRowId: Ulid | null;
  categoryId: string | null;
  cascadeLevel: number | null;
  suspenseReason: string | null;
  pairedWithId: Ulid | null;
  duplicateFlag: boolean;
  journalEntryId: Ulid | null;
  cleared: boolean;
  clearedDate: string | null;
  status: "active" | "reversed";
  manualOverride: boolean;
  manualOverrideBy: Ulid | null;
  manualOverrideAt: string | null;
  version: number;
}

/** import.mapping_profiles, migration 0009. Read only from a run's point of view. */
export interface MappingProfileRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  institutionName: string;
  accountNumber: string;
  fileFormat: "csv" | "xlsx";
  /** Compared exactly against the incoming header row. Never fuzzily. */
  headerFingerprint: string;
  headerRowNumber: number;
  skipRows: number;
  dateColumn: string;
  dateFormat: string;
  descriptionColumn: string;
  amountColumn: string | null;
  debitColumn: string | null;
  creditColumn: string | null;
  signConvention: "debit_positive" | "credit_positive" | "separate_columns";
  currency: string;
  bankIdColumn: string | null;
  checkNumberColumn: string | null;
  bankCodeColumn: string | null;
  isActive: boolean;
}

/** import.batches, migration 0009. */
export interface ImportBatchRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  name: string;
  sourceFormat: "ofx" | "qfx" | "qbo" | "camt053" | "csv" | "xlsx";
  bankAccountId: Ulid;
  accountNumber: string;
  mappingProfileId: Ulid | null;
  mappingProfileVersion: number | null;
  status:
    | "parsing"
    | "parsed"
    | "in_review"
    | "committed"
    | "reversed"
    | "rejected"
    | "failed";
  rejectReason: string | null;
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  heldCount: number;
  netCents: Cents;
  parsedRunId: string | null;
  committedRunId: string | null;
  committedAt: string | null;
  reversedRunId: string | null;
  reversedAt: string | null;
  reversalBlocked: boolean;
  createdAt: string;
  version: number;
}

/** import.staged_rows, migration 0009. Nothing here is in the ledger yet. */
export interface StagedRowRow {
  id: Ulid;
  batchId: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  rowNumber: number;
  rawRow: Record<string, unknown>;
  postedOn: string | null;
  description: string | null;
  normalizedDescription: string | null;
  amountCents: Cents | null;
  currency: string;
  accountNumber: string;
  bankAccountId: Ulid;
  bankTransactionId: string | null;
  checkNumber: string | null;
  bankCode: string | null;
  dedupState:
    | "unique"
    | "rejected_duplicate"
    | "held_for_review"
    | "confirmed_repeat"
    | "committed";
  duplicateOfTransactionId: Ulid | null;
  reviewState: "none" | "pending" | "accepted" | "rejected";
  committedTransactionId: Ulid | null;
  committedEntryId: Ulid | null;
  errorCode: string | null;
  errorMessage: string | null;
  version: number;
}

export interface PeriodLockRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  periodStart: string;
  periodEnd: string;
  lockedAt: string;
  lockedBy: Ulid;
  closedWithExceptions: boolean;
  exceptionNote: string | null;
  unlockedAt: string | null;
  unlockedBy: Ulid | null;
  unlockReason: string | null;
}

export interface TransferPairRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  outboundTxnId: Ulid;
  inboundTxnId: Ulid;
  createdByRunId: string;
  manuallyConfirmed: boolean;
}

export interface JournalEntryRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  entryDate: string;
  memo: string;
  posted: boolean;
  reversalOf: Ulid | null;
  reversedByEntryId: Ulid | null;
  redatedFromLockedPeriod: string | null;
  sourceTable: string;
  sourceRowId: Ulid;
  sourceVersion: number;
  createdByRunId: string;
  runType: string;
  runVersion: number;
}

export interface JournalLineRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  entryId: Ulid;
  accountNumber: string;
  categoryId: string | null;
  amountCents: Cents;
  memo: string;
  entryDate: string;
  classId: Ulid | null;
  locationId: Ulid | null;
  programId: Ulid | null;
  restriction: string | null;
}

export interface SuspenseItemRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  transactionId: Ulid;
  reasonCode: string;
  accountNumber: string;
  detail: string;
  relatedIds: Ulid[];
  createdByRunId: string;
  withdrawnByRunId: string | null;
}

export interface RunLogRow {
  id: string; // "RUNX-" plus ULID
  firmId: Ulid;
  clientId: Ulid;
  runType: string;
  runVersion: number;
  mode: RunMode;
  status: RunStatus | "started";
  idempotencyKey: string;
  scopeHash: string;
  actorId: Ulid;
  actorKind: string;
  source: string;
  parentSequenceId: string | null;
  previewRunId: string | null;
  originalRunId: string | null;
  periodStart: string;
  periodEnd: string;
  candidateCount: number;
  candidateIds: Ulid[];
  scopeInput: unknown;
  versions: unknown;
  startedAt: string;
  gitSha: string;
  releaseId: string;
}

export interface RunLogItemRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  runExecutionId: string;
  rowTable: string;
  rowId: Ulid | null;
  decision: "proposed" | "skipped" | "errored";
  reason: string;
  cascadeLevel: number | null;
  ruleId: string | null;
  ruleVersion: number | null;
  templateId: string | null;
  templateVersion: number | null;
  suspenseReasonCode: string | null;
  journalEntryId: Ulid | null;
  beforeJson: unknown;
  afterJson: unknown;
  proposalJson: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

/** Status transitions are appended here, never written over the run_log row. */
export interface RunLogEventRow {
  id: Ulid;
  firmId: Ulid;
  runExecutionId: string;
  event: RunStatus | "attempt_retried" | "undone_by";
  attempt: number;
  detail: string;
  proposalCount: number;
  skipCount: number;
  errorCount: number;
  netCents: Cents;
  entriesCreated: number;
  entriesReversed: number;
  skipCountsByReason: Record<string, number>;
  durationMs: number;
  relatedRunId: string | null;
  occurredAt: string;
}

export interface RunSequenceRow {
  id: string;
  firmId: Ulid;
  clientId: Ulid;
  name: string;
  childRunIds: string[];
  stoppedAtStep: number | null;
  actorId: Ulid;
  startedAt: string;
  finishedAt: string;
}

/** Every table the port knows about, mapped to its row shape. */
export interface RowMap {
  bank_accounts: BankAccountRow;
  chart_accounts: ChartAccountRow;
  transactions: TransactionRow;
  mapping_profiles: MappingProfileRow;
  import_batches: ImportBatchRow;
  staged_rows: StagedRowRow;
  period_locks: PeriodLockRow;
  transfer_pairs: TransferPairRow;
  journal_entries: JournalEntryRow;
  journal_lines: JournalLineRow;
  suspense_items: SuspenseItemRow;
  run_log: RunLogRow;
  run_log_items: RunLogItemRow;
  run_log_events: RunLogEventRow;
  run_sequence: RunSequenceRow;
}

export type TableName = keyof RowMap;

/** Tables that are insert only, per doc 03 Part 9. */
export const INSERT_ONLY_TABLES: readonly TableName[] = [
  "run_log",
  "run_log_items",
  "run_log_events",
];

/** Fields the override guard watches, per doc 03 Part 6. */
export const OVERRIDE_WATCHED_FIELDS: readonly string[] = [
  "categoryId",
  "accountNumber",
  "amountCents",
  "pairedWithId",
  "duplicateFlag",
  "normalizedVendor",
];
