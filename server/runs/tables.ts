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

export interface TransactionRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  bankAccountId: Ulid;
  postedDate: string;
  /** Signed. Money out of the account is negative. */
  amountCents: Cents;
  description: string;
  normalizedVendor: string;
  categoryId: string | null;
  pairedWithId: Ulid | null;
  duplicateFlag: boolean;
  manualOverride: boolean;
  manualOverrideBy: Ulid | null;
  manualOverrideAt: string | null;
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
