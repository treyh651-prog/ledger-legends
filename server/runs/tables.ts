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
  /** Doc 02 module 3 REC-FLAG-STALE reads this to pick a threshold. */
  instrumentType: "issued_check" | "electronic" | "deposit" | "other";
  /** The cleared flag. Migration 0011 named it cleared and 0012 kept that name. */
  cleared: boolean;
  clearedDate: string | null;
  /** Migration 0012. Which statement, which line, which tier, which batch. */
  statementId: Ulid | null;
  statementLineId: Ulid | null;
  statementDate: string | null;
  matchTier: number | null;
  matchConfidence: number | null;
  recBatchId: Ulid | null;
  /** REC-FLAG-STALE. None of these four are coding columns. */
  staleFlagged: boolean;
  staleFlaggedOn: string | null;
  staleOwner: "firm" | "client" | "system" | null;
  staleEscalatesOn: string | null;
  escheatReview: boolean;
  voided: boolean;
  status: "active" | "reversed";
  manualOverride: boolean;
  manualOverrideBy: Ulid | null;
  manualOverrideAt: string | null;
  version: number;
}

/**
 * ledger.rec_batches, migration 0012. One row per account per statement
 * period. REC-MATCH-TIERED opens it, REC-CLEAR-MATCHED closes it with the
 * difference gate G03 tests on it.
 */
export interface RecBatchRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  bankAccountId: Ulid;
  statementId: Ulid;
  /** "YYYY-MM", the period the statement covers. */
  statementPeriod: string;
  periodStart: string;
  periodEnd: string;
  statementBalanceCents: Cents;
  clearedLedgerBalanceCents: Cents | null;
  diffCents: Cents | null;
  state: "open" | "reconciled" | "out_of_balance";
  openedBy: Ulid;
  openedAt: string;
  openedByRunId: string | null;
  closedAt: string | null;
  closedByRunId: string | null;
  version: number;
}

/**
 * ledger.statement_lines, migration 0012. The bank side of the match. A
 * statement line is never a register row: the register is what the books say
 * and the statement is what the bank says, and reconciliation is the question
 * of whether the two agree.
 */
export interface StatementLineRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  bankAccountId: Ulid;
  statementId: Ulid;
  /** The date the bank put on the line. This governs clearing. */
  statementDate: string;
  amountCents: Cents;
  currency: string;
  description: string;
  normalizedVendor: string | null;
  checkNumber: string | null;
  sourceFormat: "csv" | "ofx" | "qfx" | "qbo" | "xlsx";
  recBatchId: Ulid | null;
  matchTier: number | null;
  matchConfidence: number | null;
  matchDiffCents: Cents | null;
  matchConfirmed: boolean;
  matchedTransactionId: Ulid | null;
  matchedTransactionCount: number;
  matchedByRunId: string | null;
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
  /**
   * Migration 0013. The day an auto reversing accrual undoes itself, which is
   * the first day of the following period. Null on every entry that is not an
   * accrual, and PER-REVERSE-ACCRUALS selects on exactly this column.
   */
  reversesOn: string | null;
  /**
   * Migration 0013. The real bill or invoice that arrived and made the accrual
   * unnecessary. Set means the accrual was superseded and must not reverse,
   * because the document already carries the amount.
   */
  linkedDocumentId: Ulid | null;
  /** Migration 0013. Which accrual template produced the entry. */
  accrualTemplateId: Ulid | null;
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

/**
 * subledger.recurring_templates, doc 04 Part 6, plus the generated entry
 * columns migration 0013 added. One table carries both shapes: a template that
 * recognizes a transaction already on the register, and a template that
 * generates a journal entry for a period whether or not a transaction exists.
 * matchKind is what tells the two apart, and PER-POST-RECURRING reads only the
 * generated_entry rows.
 */
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
  /** Generated entry columns. Null on a transaction_match template. */
  cadence:
    | "weekly"
    | "semi_monthly"
    | "monthly"
    | "quarterly"
    | "semi_annual"
    | "annual"
    | null;
  startDate: string | null;
  endDate: string | null;
  /** Doc 02 PER-POST-RECURRING. The last day of the period, or a stated day. */
  postingDateRule: "period_end" | "day_n";
  /** The amount basis point split lines are applied to. Migration 0013. */
  driverAmountCents: Cents | null;
  entryMemoTemplate: string | null;
  manualOverride: boolean;
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

/**
 * subledger.fixed_assets, doc 04 Part 4, plus the three columns migration 0013
 * added. The cost account and the accumulated depreciation account are stored
 * on the row rather than inferred from the plus 100 convention, so the run can
 * skip an asset whose contra account is missing instead of guessing one.
 *
 * The method is a bookkeeping mechanic. It is not a tax position, and nothing
 * that reads this row computes a tax liability.
 */
export interface FixedAssetRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  tag: string | null;
  description: string;
  assetClass: string;
  costAccount: string;
  accumAccount: string;
  expenseAccount: string;
  acquiredOn: string;
  placedInServiceOn: string;
  costCents: Cents;
  salvageCents: Cents;
  /** Generated in the database as cost minus salvage. Never recomputed here. */
  depreciableBaseCents: Cents;
  method:
    | "straight_line"
    | "ddb"
    | "ddb_150"
    | "macrs"
    | "sum_of_years"
    | "units_of_production"
    | "none";
  lifeMonths: number | null;
  /** Basis points, so 20000 is a factor of two. Migration 0013. */
  ddbFactorBps: number | null;
  /** MACRS recovery period in years. Migration 0013. */
  macrsRecoveryYears: number | null;
  unitsTotal: number | null;
  convention:
    | "full_month"
    | "mid_month"
    | "mid_quarter"
    | "mid_year"
    | "actual_days";
  /** Migration 0013. Half a month in the acquisition and disposal months. */
  halfMonthConvention: boolean;
  status: "active" | "fully_depreciated" | "disposed" | "written_off";
  disposedOn: string | null;
  manualOverride: boolean;
  version: number;
}

/** subledger.depreciation_schedule, doc 04 Part 4. One row per asset period. */
export interface DepreciationScheduleRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  assetId: Ulid;
  periodStart: string;
  periodEnd: string;
  periodNumber: number;
  scheduleVersion: number;
  /** Always positive. The sign is applied when the entry is built. */
  amountCents: Cents;
  accumulatedAfterCents: Cents;
  nbvAfterCents: Cents;
  status: "scheduled" | "posted" | "skipped" | "superseded";
  postedEntryId: Ulid | null;
  postedRunId: string | null;
  postedAt: string | null;
  manualOverride: boolean;
  version: number;
}

/**
 * subledger.deferral_schedules, doc 04 Part 3. Prepaids, intangible
 * amortization, deferred revenue, and stored accruals all share this shape.
 */
export interface DeferralScheduleRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  kind: "prepaid" | "intangible_amortization" | "deferred_revenue" | "accrual";
  description: string;
  /** 13xx prepaid, 17xx intangible, 25xx deferred revenue, 22xx accrual. */
  balanceAccount: string;
  /** Where the release lands: 6xxx expense, or 4xxx revenue. */
  releaseAccount: string;
  accumAccount: string | null;
  totalCents: Cents;
  serviceStart: string;
  serviceEnd: string;
  method: "straight_line_monthly" | "straight_line_daily" | "custom";
  periods: number;
  status: "active" | "complete" | "cancelled" | "superseded";
  sourceTransactionId: Ulid | null;
  sourceDocumentId: Ulid | null;
  /** Migration 0013. The document that superseded this schedule, if any. */
  linkedDocumentId: Ulid | null;
  manualOverride: boolean;
  version: number;
}

/**
 * subledger.deferral_lines. The allocation table, computed once when the
 * schedule was created and never recomputed, per doc 02 PER-AMORTIZE-PREPAID.
 */
export interface DeferralLineRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  scheduleId: Ulid;
  scheduleVersion: number;
  periodNumber: number;
  periodStart: string;
  periodEnd: string;
  amountCents: Cents;
  remainingAfterCents: Cents;
  status: "scheduled" | "posted" | "skipped" | "superseded";
  postedEntryId: Ulid | null;
  postedRunId: string | null;
  postedAt: string | null;
  reversalEntryId: Ulid | null;
  linkedDocumentId: Ulid | null;
  manualOverride: boolean;
  version: number;
}

/** subledger.loans, doc 04 Part 7. */
export interface LoanRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  lenderName: string;
  loanType: string;
  /** 27xx long term debt. */
  principalAccountLt: string;
  /** 26xx current portion, optional. */
  principalAccountCp: string | null;
  /** 8xxx interest expense. */
  interestAccount: string;
  /** 10xx cash that received the proceeds and pays the note. */
  fundingAccount: string | null;
  /** 1xxx or 2xxx escrow holding account, null when the loan has no escrow. */
  escrowAccount: string | null;
  originalPrincipalCents: Cents;
  originationDate: string;
  firstPaymentDate: string;
  termMonths: number;
  annualRateBps: number;
  paymentCents: Cents | null;
  status: "active" | "paid_off" | "refinanced" | "written_off";
  manualOverride: boolean;
  version: number;
}

/**
 * subledger.loan_schedule. The amortization table is authoritative. Doc 02
 * PER-SPLIT-LOANPAYMENT is explicit that interest is never recomputed from a
 * rate, because a lender's rounding is the lender's rounding.
 */
export interface LoanScheduleRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  loanId: Ulid;
  scheduleVersion: number;
  paymentNumber: number;
  dueDate: string;
  paymentCents: Cents;
  principalCents: Cents;
  interestCents: Cents;
  escrowCents: Cents;
  feesCents: Cents;
  balanceAfterCents: Cents;
  status: "scheduled" | "posted" | "skipped" | "superseded";
  matchedTransactionId: Ulid | null;
  postedEntryId: Ulid | null;
  postedRunId: string | null;
  postedAt: string | null;
  manualOverride: boolean;
  version: number;
}

/**
 * subledger.accrual_templates, migration 0013. Doc 02 PER-POST-ACCRUALS names
 * four calculation bases and no others, so the union is closed.
 */
export interface AccrualTemplateRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  name: string;
  accrualKind:
    | "bill_received_not_entered"
    | "wages_earned_not_paid"
    | "revenue_earned_not_billed"
    | "other";
  basis:
    | "fixed_amount"
    | "from_document"
    | "daily_rate_x_days"
    | "percent_of_base";
  debitAccount: string;
  creditAccount: string;
  categoryId: string | null;
  fixedAmountCents: Cents | null;
  sourceDocumentId: Ulid | null;
  sourceDocumentAmountCents: Cents | null;
  dailyRateCents: Cents | null;
  dayCount: number | null;
  baseCents: Cents | null;
  percentBps: number | null;
  entryMemo: string;
  autoReverse: boolean;
  isActive: boolean;
  manualOverride: boolean;
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
  rec_batches: RecBatchRow;
  statement_lines: StatementLineRow;
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
  fixed_assets: FixedAssetRow;
  depreciation_schedule: DepreciationScheduleRow;
  deferral_schedules: DeferralScheduleRow;
  deferral_lines: DeferralLineRow;
  loans: LoanRow;
  loan_schedule: LoanScheduleRow;
  accrual_templates: AccrualTemplateRow;
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
  /**
   * Module 4 adds the subledger columns the six period end runs write. A person
   * who marks a depreciation line posted by hand, or fixes a loan split, has
   * made a decision, and invariant 8 says a run may not write over it. Every
   * status change these runs make travels with a posted entry id, so watching
   * the posting columns covers the status column as well.
   */
  "postedEntryId",
  "postedRunId",
  "postedAt",
  "matchedTransactionId",
  "accumulatedAfterCents",
  "nbvAfterCents",
  "remainingAfterCents",
  "linkedDocumentId",
  "reversalEntryId",
];
