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
  /** The merchant name where the feed sent one, null otherwise. */
  bankMerchantName: string | null;
  /** vendor_normalized. Null until TXN-NORMALIZE-VENDORS has run on the row. */
  normalizedVendor: string | null;
  /** vendor_normalization_version, stamped by TXN-NORMALIZE-VENDORS. */
  vendorNormalizationVersion: number | null;
  /** Set when step 7 of the normalization rule had to keep the step 3 result. */
  normalizationDegraded: boolean;
  vendorId: Ulid | null;
  checkNumber: string | null;
  bankCode: string | null;
  /** Feed side institution identifier, used by the bank code mapping lookup. */
  institutionId: string | null;
  /** The bank supplied unique id, null when the format did not carry one. */
  bankTransactionId: string | null;
  source: "import" | "manual" | "conversion";
  importBatchId: Ulid | null;
  stagedRowId: Ulid | null;
  categoryId: string | null;
  categoryVersion: number | null;
  cascadeLevel: number | null;
  /** Cascade provenance, doc 06 C9. Which rule decided the row, and at which version. */
  ruleId: string | null;
  ruleVersion: number | null;
  matchedConditions: unknown;
  autoPostedUnderRulePromotion: boolean;
  templateId: Ulid | null;
  templateVersion: number | null;
  classId: Ulid | null;
  locationId: Ulid | null;
  programId: Ulid | null;
  suspenseReason: string | null;
  suspenseOwner: "firm" | "client" | "system" | null;
  suspenseOpenedOn: string | null;
  suspenseEscalatesOn: string | null;
  pairedWithId: Ulid | null;
  settlementOfTransactionId: Ulid | null;
  isProcessorSettlement: boolean;
  duplicateFlag: boolean;
  duplicateOfTransactionId: Ulid | null;
  legitimateRepeat: boolean;
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

/**
 * ledger.categories, doc 04 Part 1. The projection the coding runs read: the
 * posting destination plus the five attribute checks doc 02 module 2 applies.
 */
export interface CategoryRow {
  id: string; // "CAT-" plus slug
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  name: string;
  accountNumber: string;
  normalSide: "debit" | "credit";
  taxTreatment:
    | "deductible"
    | "meals_50"
    | "nondeductible"
    | "owner_draw"
    | "owner_contribution"
    | "personal"
    | "capital"
    | "transfer"
    | "not_applicable";
  class1099: "none" | "nec" | "misc_rent" | "misc_other" | "attorney";
  requiresReceiptOverCents: Cents | null;
  requiresClass: boolean;
  capitalizeOverCents: Cents | null;
  restrictionRelevant: boolean;
  isActive: boolean;
}

/**
 * The six condition types doc 02 TXN-APPLY-RULES step 1 allows, and nothing
 * else. There is no substring similarity and no wildcard beyond the token
 * boundary prefix, so the union is closed on purpose.
 */
export type RuleCondition =
  | { type: "vendor_equals"; value: string }
  | { type: "vendor_prefix"; value: string }
  | { type: "amount_range"; minCents: Cents; maxCents: Cents }
  | { type: "sign"; value: "debit" | "credit" }
  | { type: "bank_account"; value: Ulid }
  | { type: "bank_code"; value: string };

/** ledger.rules, doc 04 Part 9. */
export interface RuleRow {
  id: string; // "RULE-" plus ULID
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  name: string;
  priority: number;
  /** Denormalized because it is a tie break input, doc 00 Part 3. */
  conditionCount: number;
  conditions: RuleCondition[];
  targetCategoryId: string;
  scopeKind: "client" | "firm_library";
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isActive: boolean;
  /** Rule promotion inputs, doc 02 Part D. */
  acceptedCount: number;
  rejectedCount: number;
  autoPostEnabled: boolean;
  autoPostEnabledBy: Ulid | null;
  autoPostCeilingCents: Cents;
}

/** subledger.recurring_templates, doc 04 Part 6. */
export interface RecurringTemplateRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  name: string;
  matchKind: "transaction_match" | "generated_entry";
  matchNormalizedName: string | null;
  bankAccountId: Ulid | null;
  amountMode: "fixed_amount" | "variable_amount";
  matchAmountCents: Cents | null;
  amountFloorCents: Cents | null;
  amountCeilingCents: Cents | null;
  dayOfMonth: number | null;
  /** Doc 02 TXN-APPLY-RECURRING step 1, default 5 calendar days either side. */
  dayWindow: number;
  splitMode: "single" | "fixed_amount" | "fixed_percent";
  isActive: boolean;
}

/** subledger.recurring_splits, doc 04 Part 6. */
export interface RecurringSplitRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  templateId: Ulid;
  templateVersion: number;
  lineNumber: number;
  categoryId: string;
  accountNumber: string;
  fixedAmountCents: Cents | null;
  percentBps: number | null;
  isRemainder: boolean;
  classId: Ulid | null;
  locationId: Ulid | null;
  programId: Ulid | null;
  memo: string | null;
}

/** subledger.vendors, doc 04 Part 5, narrowed to the level 7 coding default. */
export interface VendorRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  legalName: string;
  normalizedName: string;
  normalizerVersion: number;
  aliases: string[];
  defaultCategoryId: string | null;
  defaultCategoryVersion: number | null;
  isActive: boolean;
}

/**
 * The bank and card issuer code mapping doc 02 TXN-MAP-BANKCODES reads. Doc 04
 * never modeled it, so the projection is derived from the run that uses it.
 */
export interface BankCodeMappingRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  /** "*" is the wildcard, used only when no institution specific row exists. */
  institutionId: string;
  bankCode: string;
  categoryId: string;
  isActive: boolean;
}

/**
 * An uploaded processor settlement report row. Doc 02 TXN-SPLIT-SETTLEMENTS
 * reads payout id, payout date, gross, fee, net, and the batch reference.
 */
export interface SettlementRowRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  processorKey: string;
  payoutId: string;
  payoutDate: string;
  grossCents: Cents;
  /** Stored negative, per doc 02 TXN-SPLIT-SETTLEMENTS step 2. */
  feeCents: Cents;
  netCents: Cents;
  batchReference: string | null;
  revenueCategoryId: string;
  feeCategoryId: string;
  matchedTransactionId: Ulid | null;
  version: number;
}

/**
 * Per client settings the coding runs read at execution rather than infer.
 * Doc 02 TXN-SPLIT-SETTLEMENTS step 4 and doc 00 Part 2 both require this.
 */
export interface ClientPolicyRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  functionalCurrency: string;
  /** Doc 00 Part 2, default 250000 cents. */
  capitalizeOverCents: Cents | null;
  /** Doc 02 step 4. Gross booked at sale time credits 1910, not revenue. */
  grossAtSaleTime: boolean;
  /** Doc 02 Part D rule promotion condition 5. */
  cleanupEngagement: boolean;
}

/** A document linked to a transaction. The receipt check reads only this. */
export interface DocumentLinkRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  transactionId: Ulid;
  documentId: Ulid;
  documentType: string;
}

/**
 * A client portal request. Doc 02 TXN-SWEEP-SUSPENSE step 4 creates exactly one
 * per client owned suspense code, unless an open request already covers it.
 */
export interface PortalRequestRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  transactionId: Ulid | null;
  reasonCode: string;
  detail: string;
  status: "open" | "satisfied" | "waived";
  openedOn: string;
  dueOn: string;
  createdByRunId: string;
  requestedAt: string;
}

/**
 * The documentation exception doc 02 TXN-APPLY-RULES steps 7 and 8 raise. The
 * coding still applies, only the support is missing, so this is not a suspense
 * routing and it does not stop the cascade.
 */
export interface DocumentationExceptionRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  transactionId: Ulid;
  kind: "missing_class" | "missing_receipt";
  categoryId: string;
  detail: string;
  status: "open" | "resolved";
  createdByRunId: string;
  openedAt: string;
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
  categories: CategoryRow;
  rules: RuleRow;
  recurring_templates: RecurringTemplateRow;
  recurring_splits: RecurringSplitRow;
  vendors: VendorRow;
  bank_code_mappings: BankCodeMappingRow;
  settlement_rows: SettlementRowRow;
  client_policies: ClientPolicyRow;
  document_links: DocumentLinkRow;
  portal_requests: PortalRequestRow;
  documentation_exceptions: DocumentationExceptionRow;
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

/**
 * Fields the override guard watches, per doc 03 Part 6. Every column the nine
 * coding runs write is on this list, because invariant 8 says a run may not
 * change a value a person set and provenance columns are part of that value.
 */
export const OVERRIDE_WATCHED_FIELDS: readonly string[] = [
  "categoryId",
  "categoryVersion",
  "accountNumber",
  "amountCents",
  "pairedWithId",
  "duplicateFlag",
  "duplicateOfTransactionId",
  "normalizedVendor",
  "vendorNormalizationVersion",
  "vendorId",
  "cascadeLevel",
  "ruleId",
  "ruleVersion",
  "templateId",
  "templateVersion",
  "suspenseReason",
  "settlementOfTransactionId",
  "classId",
  "locationId",
  "programId",
];
