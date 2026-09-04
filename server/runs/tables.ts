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
  /** Migration 0015. 'locked' while the lock holds, 'unlocked' once lifted. */
  status: "locked" | "unlocked";
  /**
   * Migration 0015. The gate result set CLOSE-LOCK-PERIOD read, frozen onto the
   * lock. Cents inside a snapshot are decimal strings rather than bigints,
   * because a snapshot column is jsonb and JSON has no bigint.
   */
  gateResultsSnapshot: GateSnapshotEntry[];
  /** Migration 0015. The trial balance the lock froze, which nets to zero. */
  trialBalanceSnapshot: TrialBalanceEntry[];
  /** Migration 0015. Hash of the ledger rows in the period at lock time. */
  ledgerFingerprint: string;
  lockedByRunId: string | null;
}

/** One line of a frozen trial balance. Cents as a decimal string, see above. */
export interface TrialBalanceEntry {
  accountNumber: string;
  balanceCents: string;
}

/** One line of a frozen gate result set. */
export interface GateSnapshotEntry {
  gateCode: string;
  outcome: GateOutcome;
  blockingCount: number;
}

export type GateOutcome = "pass" | "fail" | "not_applicable";

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
  /**
   * Migration 0014. Where a taken early payment discount lands. Null means
   * purchase discount income, which is the common case. The column exists
   * because the answer is a term of one vendor agreement and not a firm
   * preference, so AP-APPLY-EARLYDISCOUNT reads it rather than deciding.
   */
  earlyDiscountRule: "purchase_discount_income" | "vendor_credit" | null;
  /**
   * Migration 0015. Whether a W-9 is on file and the day it stops being
   * current. SUB-RAISE-REQUESTS asks for one that is absent or expired, and
   * both facts belong to the vendor rather than to the request.
   */
  w9OnFile: boolean;
  w9ExpiresOn: string | null;
  /**
   * Migration 0017. What the payee is, which is what decides whether a 1099
   * line exists at all. A corporation is excluded, and an incorporated attorney
   * is not, so the answer has to be the entity type and never a guess from the
   * name. Unknown is the honest default and it does not exclude anybody.
   */
  entityType:
    | "individual"
    | "sole_proprietor"
    | "partnership"
    | "llc"
    | "c_corporation"
    | "s_corporation"
    | "government"
    | "tax_exempt"
    | "unknown";
  /**
   * Migration 0017. A person put this payee on hold. A held payee with no W-9
   * is left out of the compiled set entirely rather than compiled with a
   * warning, because the hold is a decision somebody already made.
   */
  paymentHold: boolean;
  /**
   * Migration 0017. Four digits, and there is nowhere in this schema to put
   * more of a taxpayer identification number than that.
   */
  tinLast4: string | null;
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
  /**
   * Migration 0015. Doc 00 Part 6. A nonprofit closes to the two net asset
   * classes and a for profit closes to retained earnings, and which one a
   * client is cannot be guessed from its chart.
   */
  entityKind: "for_profit" | "nonprofit";
  retainedEarningsAccount: string | null;
  netAssetsWithoutRestrictionsAccount: string | null;
  netAssetsWithRestrictionsAccount: string | null;
  /** 12 for a calendar fiscal year. Read, never assumed. */
  fiscalYearEndMonth: number;
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

/**
 * subledger.arap_policies, migration 0014. One row per client holding the
 * module 5 thresholds and the account numbers the six AR and AP runs read.
 * Absent means every default in doc 02 module 5 applies, which is why every
 * run resolves the policy through a defaults helper rather than reading the
 * row directly.
 */
export interface ArapPolicyRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  agingBasis: "due_date" | "invoice_date";
  minimumStatementBalanceCents: Cents;
  statementType: "open_item" | "balance_forward";
  messageNeutral: string | null;
  messageReminder: string | null;
  messageFirm: string | null;
  messageFinal: string | null;
  graceDays: number;
  lateFeeMinimumCents: Cents;
  lateFeeMaximumCents: Cents | null;
  suppressBelowMinimumFee: boolean;
  writeoffAgeDays: number;
  writeoffMinimumCents: Cents;
  requiredAttempts: number;
  writeoffMethod: "allowance" | "direct";
  approvalTier1Cents: Cents;
  discountBaseExcludesFreightTax: boolean;
  arControlAccount: string;
  arClearingAccount: string;
  allowanceAccount: string | null;
  badDebtAccount: string | null;
  salesTaxAccount: string | null;
  lateFeeRevenueAccount: string | null;
  apControlAccount: string;
  apClearingAccount: string;
  purchaseDiscountAccount: string | null;
  vendorCreditAccount: string | null;
  manualOverride: boolean;
}

/**
 * subledger.customers, migration 0014. The late fee terms sit here because a
 * late fee is a term of one customer agreement, and doNotPursue is one of the
 * two standing authorities that let a write off be prepared at all.
 */
export interface CustomerRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  name: string;
  isActive: boolean;
  statementSuppressed: boolean;
  statementType: "open_item" | "balance_forward" | null;
  applicationPreference: "oldest_first" | "none";
  lateFeeEnabled: boolean;
  /** Basis points a year. Doc 00 Part 1 forbids a decimal rate anywhere. */
  annualizedRateBp: number | null;
  graceDays: number | null;
  flatFeeCents: Cents | null;
  lateFeeExempt: boolean;
  doNotPursue: boolean;
  paymentPlanActive: boolean;
  statementDocumentId: Ulid | null;
  statementDocumentDate: string | null;
  manualOverride: boolean;
}

/**
 * subledger.invoices, migration 0014. Open balance is original minus applied
 * payments minus applied credits minus written off, per doc 02
 * ARAP-REFRESH-AGING rule 1, so the three subtrahends are stored rather than
 * derived on every read.
 */
export interface InvoiceRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  customerId: Ulid;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  originalAmountCents: Cents;
  taxCents: Cents;
  appliedPaymentsCents: Cents;
  appliedCreditsCents: Cents;
  writtenOffCents: Cents;
  status: "draft" | "posted" | "paid" | "void" | "written_off";
  inDispute: boolean;
  collectionAttempts: number;
  parentInvoiceId: Ulid | null;
  isLateFee: boolean;
  /** Whole thirty day blocks this fee invoice charged, null on a real invoice. */
  feeMonths: number | null;
  writeoffApproved: boolean;
  arAccount: string;
  revenueAccount: string;
  manualOverride: boolean;
}

export interface CreditMemoRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  customerId: Ulid;
  memoNumber: string;
  memoDate: string;
  amountCents: Cents;
  appliedCents: Cents;
  status: "open" | "applied" | "void";
  manualOverride: boolean;
}

/**
 * subledger.customer_payments, migration 0014. A payment arrives on the
 * register coded to the receivable clearing account, and application is what
 * moves it from the clearing account to the control account.
 */
export interface CustomerPaymentRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  customerId: Ulid;
  paymentDate: string;
  amountCents: Cents;
  appliedCents: Cents;
  onHold: boolean;
  /** One invoice number. A multi invoice remittance is structured rows. */
  matchHint: string | null;
  transactionId: Ulid | null;
  clearingAccount: string;
  status: "unapplied" | "partially_applied" | "applied" | "void";
  appliedTier: number | null;
  manualOverride: boolean;
}

export interface RemittanceLineRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  paymentId: Ulid;
  lineNumber: number;
  invoiceNumber: string;
  amountCents: Cents;
}

export interface PaymentApplicationRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  paymentId: Ulid;
  invoiceId: Ulid;
  appliedCents: Cents;
  applicationDate: string;
  /** Which of the four doc 02 tiers resolved it. */
  tier: number;
  state: "proposed" | "applied" | "reversed";
  postedEntryId: Ulid | null;
  createdByRunId: string | null;
  manualOverride: boolean;
}

/**
 * subledger.aging_snapshots, migration 0014. One row per document per as of
 * date per side, plus one tie row per side carrying the control balance and the
 * signed difference gate G04 reads.
 */
export interface AgingSnapshotRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  asOfDate: string;
  side: "receivable" | "payable";
  agingBasis: "due_date" | "invoice_date";
  partyId: Ulid | null;
  partyName: string;
  documentId: Ulid | null;
  documentNumber: string | null;
  documentDate: string | null;
  basisDate: string | null;
  ageDays: number | null;
  bucket: AgingBucket;
  openBalanceCents: Cents;
  controlAccount: string | null;
  controlBalanceCents: Cents | null;
  tieDifferenceCents: Cents | null;
  subledgerOutOfTie: boolean;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/** Doc 02 ARAP-REFRESH-AGING rule 3, plus the credits line and the tie row. */
export type AgingBucket =
  | "current"
  | "b1_30"
  | "b31_60"
  | "b61_90"
  | "b91_plus"
  | "credits"
  | "tie";

/**
 * subledger.statement_documents, migration 0014. Built in state draft and never
 * delivered by a run. There is no recipient column and no delivery column.
 */
export interface StatementDocumentRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  customerId: Ulid;
  statementDate: string;
  statementType: "open_item" | "balance_forward";
  state: "draft" | "superseded";
  openingBalanceCents: Cents;
  activityCents: Cents;
  closingBalanceCents: Cents;
  messageBand: "neutral" | "reminder" | "firm" | "final_notice";
  messageText: string;
  oldestItemAgeDays: number;
  itemCount: number;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

export interface StatementItemRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  statementId: Ulid;
  lineNumber: number;
  itemKind: "invoice" | "payment" | "credit";
  documentId: Ulid;
  documentNumber: string;
  documentDate: string;
  originalCents: Cents;
  appliedCents: Cents;
  openCents: Cents;
  runningBalanceCents: Cents;
}

/**
 * subledger.writeoff_proposals, migration 0014. authority records which of the
 * two standing decisions allowed the proposal to be prepared. A proposal with
 * neither is a review item and nothing posts against it.
 */
export interface WriteoffProposalRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  invoiceId: Ulid;
  customerId: Ulid;
  asOfDate: string;
  ageDays: number;
  openBalanceCents: Cents;
  netCents: Cents;
  taxCents: Cents;
  method: "allowance" | "direct";
  approvalRoute: "preparer_and_lead" | "partner";
  authority: "do_not_pursue" | "manual_approve" | null;
  collectionAttempts: number;
  state: "proposed" | "posted" | "withdrawn";
  postedEntryId: Ulid | null;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/**
 * subledger.bills, migration 0014. Terms are the three structured fields and
 * there is no terms text column, because doc 02 AP-APPLY-DISCOUNTS rule 1 says
 * terms are never parsed from free text at run time.
 */
export interface BillRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  vendorId: Ulid;
  billNumber: string;
  billDate: string;
  dueDate: string;
  originalAmountCents: Cents;
  freightCents: Cents;
  taxCents: Cents;
  paidCents: Cents;
  discountTakenCents: Cents;
  creditsCents: Cents;
  /** 2/10 net 30 is 200, 10, 30. All three or none. */
  discountBps: number | null;
  discountDays: number | null;
  netDays: number | null;
  status: "draft" | "posted" | "paid" | "void";
  onHold: boolean;
  inDispute: boolean;
  apAccount: string;
  expenseAccount: string;
  manualOverride: boolean;
}

export interface VendorCreditRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  vendorId: Ulid;
  billId: Ulid | null;
  creditDate: string;
  amountCents: Cents;
  appliedCents: Cents;
  state: "open" | "applied" | "void";
  source: string;
  postedEntryId: Ulid | null;
  createdByRunId: string | null;
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

// ---------------------------------------------------------------------------
// Module 6 substantiation and close, migration 0015.
// ---------------------------------------------------------------------------

/**
 * A period with an identity. Before migration 0015 an open period was the
 * absence of a lock row, which is a fact nobody can open or point at.
 */
export interface ClosePeriodRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  periodStart: string;
  periodEnd: string;
  fiscalYearStart: string;
  fiscalYearEnd: string;
  status: "open" | "locked";
  openedByRunId: string | null;
  openedAt: string | null;
  lockedByRunId: string | null;
  lockedAt: string | null;
  rolledFromPeriodStart: string | null;
  manualOverride: boolean;
}

/** One substantiated balance sheet account for one period. */
export interface SubTieoutRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  periodStart: string;
  periodEnd: string;
  accountNumber: string;
  accountName: string;
  sourceKind: TieoutSourceKind;
  sourceRef: string | null;
  ledgerBalanceCents: Cents;
  supportedBalanceCents: Cents | null;
  /** Ledger minus supported, signed. Null when there is no source at all. */
  varianceCents: Cents | null;
  tied: boolean;
  wrongSideNoReason: boolean;
  state: "computed_tied" | "unsupported" | "variance_open";
  detail: string;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

export type TieoutSourceKind =
  | "statement_balance"
  | "aging_total"
  | "schedule_remaining"
  | "roll_forward_net"
  | "physical_count"
  | "register_total"
  | "none";

/** A supporting figure produced outside the ledger, such as a stock count. */
export interface SubstantiationRecordRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  kind: "inventory_count" | "payroll_register" | "other";
  accountNumber: string;
  periodStart: string;
  periodEnd: string;
  supportedBalanceCents: Cents;
  sourceRef: string | null;
  preparedBy: Ulid | null;
  preparedOn: string | null;
  manualOverride: boolean;
}

/** One open item, deduplicated by subject key and refreshed in place. */
export interface DocumentRequestRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  subjectKey: string;
  catalogCode: string;
  owner: "firm" | "client" | "system";
  accountNumber: string | null;
  periodStart: string;
  linkedItemId: Ulid | null;
  detail: string;
  status: "open" | "satisfied" | "waived";
  openedOn: string;
  asOfDate: string;
  agingDays: number;
  escalatesOn: string;
  escalation: "none" | "first" | "second" | "final";
  ownerChangedOn: string | null;
  lastRefreshedOn: string | null;
  refreshCount: number;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/** One row of the blocking evidence a gate kept. */
export interface GateBlockingRow {
  rowId: string | null;
  label: string;
  detail: string;
  /** Decimal string, because the payload column is jsonb. */
  amountCents: string | null;
}

/** One gate, one period, one outcome, with the blocking rows frozen. */
export interface CloseGateResultRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  periodStart: string;
  periodEnd: string;
  gateCode: string;
  gateTitle: string;
  outcome: GateOutcome;
  blockingCount: number;
  payload: GateBlockingRow[];
  scopeReason: string | null;
  ledgerFingerprint: string;
  evaluatedAt: string;
  evaluatedByRunId: string | null;
  manualOverride: boolean;
  overrideReason: string | null;
}

/** An opening balance copied forward from the prior period snapshot. */
export interface OpeningBalanceRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  periodStart: string;
  accountNumber: string;
  openingBalanceCents: Cents;
  sourcePeriodStart: string;
  sourceKind: string;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/** The claim that a fiscal year was closed to equity. One row per year. */
export interface ClosingEntryRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  fiscalYearStart: string;
  fiscalYearEnd: string;
  entryId: Ulid;
  entryDate: string;
  entityKind: "for_profit" | "nonprofit";
  equityAccount: string;
  closedRevenueCents: Cents;
  closedExpenseCents: Cents;
  closedNetCents: Cents;
  accountCount: number;
  postedByRunId: string | null;
  postedAt: string;
  manualOverride: boolean;
}

/**
 * Module 8 reporting, migration 0016.
 *
 * Everything below is a derived report row. Not one of these tables is read by
 * the ledger, and not one of them can produce a journal entry, which is what
 * makes the four reporting runs safe on a locked period.
 */

/** The other half of a variance. Ledger sign convention, integer cents. */
export interface BudgetRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  periodStart: string;
  periodEnd: string;
  accountNumber: string;
  classId: Ulid | null;
  locationId: Ulid | null;
  programId: Ulid | null;
  budgetCents: Cents;
  source: "entered" | "imported" | "rolled_forward";
  createdAt: string;
  manualOverride: boolean;
}

/** A null account number is the client default, an account number overrides it. */
export interface BudgetThresholdRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  accountNumber: string | null;
  varianceFloorCents: Cents;
  varianceThresholdBp: number;
  note: string;
  createdAt: string;
  manualOverride: boolean;
}

/** One figure on one statement line. Cents are text because jsonb has no bigint. */
export interface ReportSectionLine {
  label: string;
  accountNumber: string | null;
  amountCents: string;
  comparisonCents: string | null;
  note: string | null;
}

export interface ReportPackageRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  periodStart: string;
  periodEnd: string;
  basis: "accrual" | "cash";
  comparisonBasis: "prior_period" | "prior_year" | "budget" | "none";
  comparisonAvailable: boolean;
  comparisonNote: string;
  state: "draft" | "superseded";
  /** Doc 02 rule 1. Null once the period is locked. */
  watermark: string | null;
  closedWithExceptions: boolean;
  exceptionBanner: string | null;
  sectionCount: number;
  omissionCount: number;
  contentChecksum: string;
  ledgerFingerprint: string;
  /** D7. Governance mode only, retention starting at period end, seven years. */
  vaultObjectKey: string;
  vaultObjectLockMode: "GOVERNANCE";
  vaultRetentionStartsOn: string;
  vaultObjectLockUntil: string;
  builtByRunId: string | null;
  builtAt: string;
  manualOverride: boolean;
}

export interface ReportSectionRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  packageId: Ulid;
  sequence: number;
  sectionCode: string;
  sectionTitle: string;
  status: "rendered" | "omitted";
  omissionReason: string | null;
  asOfDate: string;
  bannerText: string | null;
  lines: ReportSectionLine[];
  contentChecksum: string;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

export interface ReportVarianceRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  periodStart: string;
  periodEnd: string;
  accountNumber: string;
  accountName: string;
  actualCents: Cents;
  budgetCents: Cents;
  varianceCents: Cents;
  /** Null where the budget is zero, because no division is attempted. */
  varianceBp: number | null;
  direction: "favorable" | "unfavorable" | "neutral";
  flagged: boolean;
  flagCode: "within_threshold" | "over_threshold" | "unbudgeted_activity";
  floorCents: Cents;
  thresholdBp: number;
  detail: string;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/** One source row behind one forecast week. Cents are text, jsonb again. */
export interface ForecastItem {
  itemId: string;
  kind:
    | "invoice"
    | "bill"
    | "recurring"
    | "loan"
    | "payroll";
  sourceTable: string;
  dueDate: string;
  amountCents: string;
  direction: "inflow" | "outflow";
}

export interface CashForecastRunRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  periodStart: string;
  periodEnd: string;
  startDate: string;
  endDate: string;
  horizonWeeks: number;
  scenario: "base" | "slow_collections" | "revenue_shortfall";
  slowShiftDays: number;
  shortfallBp: number;
  useHistory: boolean;
  openingCashCents: Cents;
  totalInflowCents: Cents;
  totalOutflowCents: Cents;
  closingCashCents: Cents;
  firstShortfallWeek: number | null;
  shortfallWeekCount: number;
  itemCount: number;
  ledgerFingerprint: string;
  builtByRunId: string | null;
  builtAt: string;
  manualOverride: boolean;
}

export interface CashForecastWeekRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  forecastRunId: Ulid;
  weekNumber: number;
  weekStart: string;
  weekEnd: string;
  openingCents: Cents;
  arInflowCents: Cents;
  otherInflowCents: Cents;
  apOutflowCents: Cents;
  recurringOutflowCents: Cents;
  loanOutflowCents: Cents;
  payrollOutflowCents: Cents;
  inflowCents: Cents;
  outflowCents: Cents;
  closingCents: Cents;
  shortfall: boolean;
  items: ForecastItem[];
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/** One sentence the composer selected, with the template that produced it. */
export interface NarrativeSentence {
  sectionCode: string;
  triggerCode: string;
  templateId: string;
  priority: number;
  droppable: boolean;
  text: string;
}

/** Every trigger evaluated, fired or not, with its value and its threshold. */
export interface NarrativeTrigger {
  triggerCode: string;
  sectionCode: string;
  computedValue: string;
  threshold: string;
  fired: boolean;
  detail: string;
}

export interface ReportNarrativeRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  periodStart: string;
  periodEnd: string;
  audience: "owner" | "lender";
  comparisonBasis: "prior_period" | "prior_year" | "budget" | "none";
  state: "draft";
  sentenceCount: number;
  droppedCount: number;
  maxSentencesPerSection: number;
  sentences: NarrativeSentence[];
  triggerLog: NarrativeTrigger[];
  bodyText: string;
  contentChecksum: string;
  ledgerFingerprint: string;
  manualEdit: boolean;
  composedByRunId: string | null;
  composedAt: string;
  manualOverride: boolean;
}

/** A future dated approved payroll amount, stated as a positive magnitude. */
export interface PayrollApprovalRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  payDate: string;
  amountCents: Cents;
  fundingAccount: string;
  status: "approved" | "draft" | "paid" | "void";
  approvedBy: Ulid | null;
  approvedOn: string | null;
  detail: string;
  createdAt: string;
  manualOverride: boolean;
}

/** The whole delivery surface of module 8. Two actions, no address column. */
export interface ReportAuditEventRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  periodStart: string;
  action: "report_available" | "narrative_available";
  subjectTable: string;
  subjectId: Ulid;
  detail: string;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/* --------------------------------------------------------------------------
 * Module 9 tax compilation, migration 0017.
 *
 * COMPLIANCE. Ledger Legends is not a CPA firm. These rows hold compiled data.
 * Nothing here is filed, issued, submitted, or transmitted. There is no form
 * number column, no submission id, and no filed at timestamp, because no run in
 * this codebase may create one.
 * ----------------------------------------------------------------------- */

/** The dated 1099 threshold. Doc 02 rule 1 forbids reading this from code. */
export interface TaxThresholdRow {
  id: Ulid;
  firmId: Ulid;
  version: number;
  formFamily: "1099";
  effectiveFrom: string;
  effectiveTo: string | null;
  thresholdCents: Cents;
  sourceNote: string;
  createdAt: string;
  manualOverride: boolean;
}

/** The compiled payee data set handed to the client's CPA. Never a filing. */
export interface TaxDataSetRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  taxYear: number;
  periodStart: string;
  periodEnd: string;
  thresholdCents: Cents;
  thresholdEffectiveFrom: string;
  thresholdEffectiveTo: string | null;
  payeeCount: number;
  reportableCount: number;
  approachingCount: number;
  excludedCount: number;
  backupWithholdingCount: number;
  reportableTotalCents: Cents;
  excludedCardTotalCents: Cents;
  state: "compiled";
  /** One value. The column exists so the guarantee is data and not a comment. */
  compilationOnly: true;
  handoffStatement: string;
  contentChecksum: string;
  ledgerFingerprint: string;
  vaultObjectKey: string;
  vaultObjectLockMode: "GOVERNANCE";
  vaultRetentionStartsOn: string;
  vaultObjectLockUntil: string;
  builtByRunId: string | null;
  builtAt: string;
  manualOverride: boolean;
}

/** One compiled line per payee per form box. Doc 02 module 9 rule 5. */
export interface TaxDataLineRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  dataSetId: Ulid;
  version: number;
  payeeId: Ulid;
  payeeName: string;
  class1099: "nec" | "attorney" | "misc_rent" | "misc_other";
  formCode: "1099-NEC" | "1099-MISC";
  boxCode: "NEC-1" | "MISC-1" | "MISC-3" | "MISC-10";
  grossPaidCents: Cents;
  excludedCardCents: Cents;
  excludedClassNoneCents: Cents;
  reportableCents: Cents;
  /** The aggregate payee total. The threshold is measured against this. */
  payeeTotalCents: Cents;
  state: "reportable" | "approaching_threshold";
  w9State: W9StatusCode;
  /** A flag for the CPA. This codebase withholds nothing. */
  backupWithholdingRequired: boolean;
  entityExcluded: boolean;
  attorneyExceptionApplied: boolean;
  /** Four digits at most. There is nowhere in this schema to put more. */
  tinLast4: string | null;
  reason: string;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/** The five value ordered status list, doc 02 TAX-TRACK-W9 rule 1. */
export type W9StatusCode =
  | "on_file_complete"
  | "on_file_incomplete"
  | "requested_pending"
  | "requested_overdue"
  | "missing";

/** W-9 collection state per vendor per year. */
export interface W9StateRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  taxYear: number;
  vendorId: Ulid;
  vendorName: string;
  /** The collection stage. */
  state: "not_requested" | "requested" | "received" | "on_file" | "expired";
  /** The doc 02 severity code. Stored, never derived at read time. */
  statusCode: W9StatusCode;
  requestedOn: string | null;
  receivedOn: string | null;
  expiresOn: string | null;
  onFile: boolean;
  requestId: Ulid | null;
  escalation: "none" | "lead";
  ageDays: number;
  tinLast4: string | null;
  asOfDate: string;
  lastRefreshedOn: string | null;
  refreshCount: number;
  detail: string;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/* --------------------------------------------------------------------------
 * Module 10 practice management, migration 0017.
 * ----------------------------------------------------------------------- */

/** The practice facts of one client that doc 02 module 10 reads. */
export interface PracticeStateRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  clientName: string;
  stage: "prospect" | "onboarding" | "active" | "paused" | "offboarded";
  serviceFrequency: "monthly" | "quarterly" | "annual";
  leadId: Ulid | null;
  preparerId: Ulid | null;
  partnerId: Ulid | null;
  /** Members unavailable for the whole period. Doc 02 leaves their work unassigned. */
  unavailableMemberIds: string[];
  /** Members out of office today. The assignee rung is skipped for them. */
  outOfOfficeMemberIds: string[];
  escalationAssigneeDays: number;
  escalationLeadDays: number;
  escalationPartnerDays: number;
  escalationAtRiskDays: number;
  engagementPaused: boolean;
  nudgesPaused: boolean;
  atRisk: boolean;
  atRiskSetOn: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/** One standard piece of work the firm does for a client every period. */
export interface PracticeTaskCatalogRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  catalogCode: string;
  title: string;
  kind: "checklist" | "deadline" | "gate_target";
  role: "preparer" | "reviewer";
  scopeKey: string | null;
  gateCode: string | null;
  predecessorCode: string | null;
  /** Days after period end. A weekend result shifts forward to Monday. */
  dueOffsetDays: number;
  frequency: "monthly" | "quarterly" | "annual";
  isActive: boolean;
  createdAt: string;
  manualOverride: boolean;
}

/** A generated task. One per client per period per catalog code. */
export interface PracticeTaskRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  periodStart: string;
  periodEnd: string;
  catalogCode: string;
  title: string;
  kind: "checklist" | "deadline" | "gate_target";
  role: "preparer" | "reviewer";
  gateCode: string | null;
  dueDate: string;
  /** The day the current due date was set. The escalation ladder keys on it. */
  dueDateSetOn: string;
  state: "open" | "blocked" | "complete";
  blockedByCode: string | null;
  assigneeId: Ulid | null;
  assignmentReason: string;
  escalationRung: EscalationRung;
  lastEscalatedOn: string | null;
  commentCount: number;
  timeEntryCount: number;
  completedOn: string | null;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

export type EscalationRung = "none" | "assignee" | "lead" | "partner" | "at_risk";

/** An escalation record. Append only, per doc 02 PRAC-ESCALATE-OVERDUE. */
export interface PracticeEscalationRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  taskId: Ulid;
  asOfDate: string;
  dueDate: string;
  daysOverdue: number;
  rung: "assignee" | "lead" | "partner" | "at_risk" | "due_date_reset";
  recipientId: Ulid | null;
  recipientRole: "assignee" | "lead" | "partner" | "firm" | "predecessor_owner";
  priorRung: EscalationRung;
  reason: string;
  resetFromDueDate: string | null;
  resetToDueDate: string | null;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/** What one firm member is carrying, as of one day. */
export interface WorkloadNoticeRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  asOfDate: string;
  memberId: Ulid;
  memberRole: "assignee" | "lead" | "partner" | "firm";
  overdueCount: number;
  oldestDueDate: string | null;
  oldestTaskId: Ulid | null;
  maxDaysOverdue: number;
  detail: string;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/**
 * A nudge decision. Not an outbox. There is no recipient, no address, and no
 * message body on this row, because nothing in this module sends anything.
 */
export interface RequestNudgeRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  requestId: Ulid;
  asOfDate: string;
  nudgeNumber: number;
  escalationAgeDays: number;
  ageDays: number;
  nextCheckOn: string;
  action: "nudge_due" | "schedule_exhausted" | "call_task";
  detail: string;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/* --------------------------------------------------------------------------
 * D5 payroll, migration 0017.
 *
 * Approval is review. It authorizes no disbursement, which is a column with a
 * named check constraint rather than a sentence in a comment.
 * ----------------------------------------------------------------------- */

export interface PayRunRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  providerName: string;
  payPeriodStart: string;
  payPeriodEnd: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  employeeCount: number | null;
  /** The register in the vault. PAY-POST-REGISTER posts from nothing else. */
  registerVaultObjectKey: string;
  registerChecksum: string;
  grossCents: Cents;
  employerTaxCents: Cents;
  employeeWithholdingCents: Cents;
  netCents: Cents;
  status: "approved" | "posted";
  approvedBy: Ulid | null;
  approvedAt: string;
  approvalStatement: string;
  /** One value. Constraint pay_run_no_disbursement_authority refuses the other. */
  authorizesDisbursement: false;
  postedEntryId: Ulid | null;
  postedAt: string | null;
  postedRunId: string | null;
  vaultObjectLockMode: "GOVERNANCE";
  vaultRetentionStartsOn: string;
  vaultObjectLockUntil: string;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/** One posted register per pay run per period per client. */
export interface PayRegisterEntryRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  payRunId: Ulid;
  version: number;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  entryId: Ulid | null;
  postedRunId: string | null;
  lineCount: number;
  grossCents: Cents;
  employerTaxCents: Cents;
  withholdingCents: Cents;
  netCents: Cents;
  wageAccount: string;
  employerTaxAccount: string;
  withholdingAccount: string;
  /** 1010 on the pay date, or 1930 payroll clearing when the debit lands later. */
  fundingAccount: string;
  detail: string;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/* --------------------------------------------------------------------------
 * D5 and D9 deliverables, migration 0017.
 * ----------------------------------------------------------------------- */

/** One artifact inside a handoff or an export. */
export interface ArchiveArtifact {
  path: string;
  artifactKind: string;
  fileFormat: "csv" | "json" | "pdf" | "txt";
  rowCount: number;
  checksum: string;
  detail: string;
}

/** One open item carried into the handoff so the CPA sees it before filing. */
export interface HandoffOpenItem {
  kind: string;
  subjectId: string;
  detail: string;
  amountCents: Cents;
}

/**
 * The CPA handoff archive.
 *
 * COMPLIANCE. There is no filed at column and no submission column. The scope
 * statement says in writing that this is compiled bookkeeping, not an audit,
 * not a review, not a compilation report under professional standards, and not
 * tax advice.
 */
export interface CpaHandoffRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  taxYear: number;
  periodStart: string;
  periodEnd: string;
  scopeKind: "period" | "fiscal_year";
  reportingBasis: "accrual" | "cash" | "both";
  isFiscalYearEnd: boolean;
  status: "complete";
  artifactCount: number;
  openItemCount: number;
  artifacts: ArchiveArtifact[];
  openItems: HandoffOpenItem[];
  scopeStatement: string;
  taxDataSetId: Ulid | null;
  contentChecksum: string;
  ledgerFingerprint: string;
  vaultObjectKey: string;
  vaultObjectLockMode: "GOVERNANCE";
  vaultRetentionStartsOn: string;
  vaultObjectLockUntil: string;
  builtByRunId: string | null;
  builtAt: string;
  manualOverride: boolean;
}

/** The D9 offboarding archive. Open formats, fifteen business days, no fee. */
export interface OffboardExportRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  requestedOn: string;
  productionDays: 15;
  dueOn: string;
  historyStart: string | null;
  historyEnd: string;
  periodStart: string;
  periodEnd: string;
  status: "complete";
  fileCount: number;
  documentCount: number;
  totalRowCount: number;
  files: ArchiveArtifact[];
  manifestChecksum: string;
  contentChecksum: string;
  ledgerFingerprint: string;
  vaultObjectKey: string;
  vaultObjectLockMode: "GOVERNANCE";
  vaultRetentionStartsOn: string;
  vaultObjectLockUntil: string;
  builtByRunId: string | null;
  builtAt: string;
  manualOverride: boolean;
}

/** import.mapping_profile_columns, migration 0018. */
export interface MappingProfileColumnRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  profileId: Ulid;
  profileVersion: number;
  /** Zero based position in the file, which is what tells duplicate headers apart. */
  sourceIndex: number;
  /** The header text exactly as it appeared. Never a normalized copy of it. */
  sourceName: string;
  canonicalField: CanonicalField;
  sampleValue: string;
  isActive: boolean;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

/**
 * The five fields the parser reads, plus the value that says a person looked at
 * this column and decided to ignore it. The list is closed here and closed
 * again by a check constraint in migration 0018.
 */
export type CanonicalField =
  | "date"
  | "description"
  | "amount_cents"
  | "memo"
  | "external_id"
  | "unmapped";

/**
 * intake.wizard_sessions, migration 0018. One row per client per wizard run.
 *
 * There is no password column and no credential column, in this type or in the
 * table behind it. Step 2 records whether a contact should get a login and
 * nothing about how they would prove who they are.
 */
export interface WizardSessionRow {
  id: Ulid;
  firmId: Ulid;
  clientId: Ulid;
  version: number;
  legalName: string;
  dbaName: string;
  /** Four characters at most. There is nowhere here for a whole EIN. */
  einLast4: string | null;
  stateOfIncorporation: string | null;
  entityType:
    | "llc"
    | "s_corporation"
    | "c_corporation"
    | "sole_proprietor"
    | "nonprofit"
    | "unknown";
  fiscalYearEndMonth: number;
  fiscalYearEndDay: number;
  serviceTier: "story" | "journey" | "legend";
  cutoverDate: string;
  industryTemplate: string;
  currentStep: number;
  state: "in_progress" | "finished" | "abandoned";
  stepCompany: Record<string, unknown>;
  stepPeople: Record<string, unknown>[];
  stepChart: Record<string, unknown>;
  stepAccounts: Record<string, unknown>[];
  stepBalances: Record<string, unknown>[];
  stepReview: Record<string, unknown>;
  chartRunId: string | null;
  tasksRunId: string | null;
  requestsRunId: string | null;
  balancesRunId: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdByRunId: string | null;
  createdAt: string;
  manualOverride: boolean;
}

export interface RowMap {
  bank_accounts: BankAccountRow;
  chart_accounts: ChartAccountRow;
  transactions: TransactionRow;
  rec_batches: RecBatchRow;
  statement_lines: StatementLineRow;
  mapping_profiles: MappingProfileRow;
  mapping_profile_columns: MappingProfileColumnRow;
  wizard_sessions: WizardSessionRow;
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
  arap_policies: ArapPolicyRow;
  customers: CustomerRow;
  invoices: InvoiceRow;
  credit_memos: CreditMemoRow;
  customer_payments: CustomerPaymentRow;
  remittance_lines: RemittanceLineRow;
  payment_applications: PaymentApplicationRow;
  aging_snapshots: AgingSnapshotRow;
  statement_documents: StatementDocumentRow;
  statement_items: StatementItemRow;
  writeoff_proposals: WriteoffProposalRow;
  bills: BillRow;
  vendor_credits: VendorCreditRow;
  close_periods: ClosePeriodRow;
  sub_tieouts: SubTieoutRow;
  substantiation_records: SubstantiationRecordRow;
  document_requests: DocumentRequestRow;
  close_gate_results: CloseGateResultRow;
  opening_balances: OpeningBalanceRow;
  closing_entries: ClosingEntryRow;
  budgets: BudgetRow;
  budget_thresholds: BudgetThresholdRow;
  report_packages: ReportPackageRow;
  report_sections: ReportSectionRow;
  report_variances: ReportVarianceRow;
  cash_forecast_runs: CashForecastRunRow;
  cash_forecast_weeks: CashForecastWeekRow;
  report_narratives: ReportNarrativeRow;
  payroll_approvals: PayrollApprovalRow;
  report_audit_events: ReportAuditEventRow;
  tax_thresholds: TaxThresholdRow;
  tax_data_sets: TaxDataSetRow;
  tax_data_lines: TaxDataLineRow;
  w9_states: W9StateRow;
  practice_states: PracticeStateRow;
  practice_task_catalog: PracticeTaskCatalogRow;
  practice_tasks: PracticeTaskRow;
  practice_escalations: PracticeEscalationRow;
  workload_notices: WorkloadNoticeRow;
  request_nudges: RequestNudgeRow;
  pay_runs: PayRunRow;
  pay_register_entries: PayRegisterEntryRow;
  cpa_handoffs: CpaHandoffRow;
  offboard_exports: OffboardExportRow;
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
  /**
   * Module 5 adds the receivable and payable columns the six AR and AP runs
   * write. The reasoning is invariant 8 again: a person who applied a payment
   * by hand, wrote a balance down, or attached a statement has made a decision,
   * and a run may not write over it. The running totals on an invoice and a
   * bill are on the list because they are the open balance, and the open
   * balance is the value a person was deciding about.
   */
  "appliedPaymentsCents",
  "appliedCreditsCents",
  "writtenOffCents",
  "appliedCents",
  "paidCents",
  "discountTakenCents",
  "creditsCents",
  "statementDocumentId",
  "statementDocumentDate",
  "appliedTier",
  "openBalanceCents",
  "tieDifferenceCents",
  "authority",
  /**
   * Module 6 adds the substantiation and close columns. A person who marked a
   * tie out as agreeing, changed the owner of a document request, overrode a
   * gate, or set an opening balance by hand has made a decision, and invariant
   * 8 says a run may not write over it. The outcome column is on the list
   * because a gate outcome is the decision itself.
   */
  "supportedBalanceCents",
  "varianceCents",
  "tied",
  "state",
  "outcome",
  "blockingCount",
  "owner",
  "escalation",
  "escalatesOn",
  "openingBalanceCents",
  "status",
  "equityAccount",
  /**
   * Module 8 adds the reporting columns. A person who edited a narrative draft,
   * corrected a package figure, or decided by hand that a variance is not worth
   * flagging has made a decision, and invariant 8 says a run may not write over
   * it. The checksum columns are on the list because a checksum is the identity
   * of the content a person was looking at, and the body text is on it because
   * the words in a draft are the decision itself.
   */
  "contentChecksum",
  "bodyText",
  "sentences",
  "lines",
  "flagged",
  "flagCode",
  "budgetCents",
  "closingCents",
  "shortfall",
  "watermark",
  "exceptionBanner",
  /**
   * Modules 9 and 10 add the tax, practice, payroll, and archive columns. The
   * reasoning is invariant 8 once more. A person who corrected a compiled 1099
   * figure, marked a W-9 received off a paper form, moved a task deadline,
   * assigned work by hand, or approved a payroll run has made a decision, and a
   * run may not write over it. The escalation rung is on the list because a
   * rung is the decision itself, and the disbursement flag is on it because
   * nothing at all may write that column.
   */
  "reportableCents",
  "payeeTotalCents",
  "backupWithholdingRequired",
  "statusCode",
  "onFile",
  "requestedOn",
  "receivedOn",
  "expiresOn",
  "tinLast4",
  "dueDate",
  "dueDateSetOn",
  "assigneeId",
  "escalationRung",
  "blockedByCode",
  "completedOn",
  "overdueCount",
  "nextCheckOn",
  "authorizesDisbursement",
  "approvedBy",
  "approvalStatement",
  "grossCents",
  "netCents",
  "registerVaultObjectKey",
  "artifacts",
  "files",
  "scopeStatement",
  "ledgerFingerprint",
];
