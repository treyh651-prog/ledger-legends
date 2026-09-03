/**
 * Postgres implementation of the run port, written against the `pg` style API.
 *
 * It is not exercised in this sandbox because there is no Postgres here, and
 * `pg` is deliberately not installed, so the client type is declared
 * structurally below. Correctness is by inspection against doc 03.
 *
 * Points worth reading closely:
 *   Isolation is set on the transaction, serializable for anything that both
 *   reads and writes ledger rows.
 *   Tenant context and actor kind are set with set_config, which is what the
 *   override guard and the row level security policies read.
 *   The advisory lock is the two key form of pg_try_advisory_xact_lock, taken
 *   inside the transaction so it releases on commit or rollback.
 *   Every candidate query carries firm_id and client_id terms, because a
 *   missing tenant term is the failure mode doc 03 Part 12 calls out.
 *   Integer cents cross the wire as text and are converted with BigInt, never
 *   through Number.
 */

import {
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
import type { RowMap, TableName } from "./tables";

export interface PgQueryResultLike<R> {
  rows: R[];
  rowCount: number | null;
}

export interface PgClientLike {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<PgQueryResultLike<R>>;
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
}

const SCHEMA = "ledger";

/**
 * Most run tables live in the ledger schema, but the import pipeline writes to
 * three tables that migration 0009 put in the import schema, and two of them
 * carry a different physical name than the row map key. Qualification is a
 * lookup rather than a prefix so the mismatch stays in one place.
 */
const PHYSICAL_TABLES: Partial<Record<TableName, string>> = {
  mapping_profiles: "import.mapping_profiles",
  import_batches: "import.batches",
  staged_rows: "import.staged_rows",
  recurring_templates: "subledger.recurring_templates",
  recurring_splits: "subledger.recurring_splits",
  vendors: "subledger.vendors",
  settlement_rows: "subledger.settlement_rows",
  fixed_assets: "subledger.fixed_assets",
  depreciation_schedule: "subledger.depreciation_schedule",
  deferral_schedules: "subledger.deferral_schedules",
  deferral_lines: "subledger.deferral_lines",
  loans: "subledger.loans",
  loan_schedule: "subledger.loan_schedule",
  accrual_templates: "subledger.accrual_templates",
  arap_policies: "subledger.arap_policies",
  customers: "subledger.customers",
  invoices: "subledger.invoices",
  credit_memos: "subledger.credit_memos",
  customer_payments: "subledger.customer_payments",
  remittance_lines: "subledger.remittance_lines",
  payment_applications: "subledger.payment_applications",
  aging_snapshots: "subledger.aging_snapshots",
  statement_documents: "subledger.statement_documents",
  statement_items: "subledger.statement_items",
  writeoff_proposals: "subledger.writeoff_proposals",
  bills: "subledger.bills",
  vendor_credits: "subledger.vendor_credits",
};

function physical(table: TableName): string {
  return PHYSICAL_TABLES[table] ?? `${SCHEMA}.${table}`;
}

/** Cents columns per table, converted from text to bigint on the way out. */
const CENTS_FIELDS: Record<string, readonly string[]> = {
  transactions: ["amountCents"],
  journal_lines: ["amountCents"],
  categories: ["requiresReceiptOverCents", "capitalizeOverCents"],
  rules: ["autoPostCeilingCents"],
  recurring_templates: [
    "matchAmountCents",
    "amountFloorCents",
    "amountCeilingCents",
    "driverAmountCents",
  ],
  fixed_assets: ["costCents", "salvageCents", "depreciableBaseCents"],
  depreciation_schedule: [
    "amountCents",
    "accumulatedAfterCents",
    "nbvAfterCents",
  ],
  deferral_schedules: ["totalCents"],
  deferral_lines: ["amountCents", "remainingAfterCents"],
  loans: ["originalPrincipalCents", "paymentCents"],
  loan_schedule: [
    "paymentCents",
    "principalCents",
    "interestCents",
    "escrowCents",
    "feesCents",
    "balanceAfterCents",
  ],
  accrual_templates: [
    "fixedAmountCents",
    "sourceDocumentAmountCents",
    "dailyRateCents",
    "baseCents",
  ],
  recurring_splits: ["fixedAmountCents"],
  settlement_rows: ["grossCents", "feeCents", "netCents"],
  client_policies: ["capitalizeOverCents"],
  run_log_events: ["netCents"],
  import_batches: ["netCents"],
  staged_rows: ["amountCents"],
  statement_lines: ["amountCents", "matchDiffCents"],
  rec_batches: [
    "statementBalanceCents",
    "clearedLedgerBalanceCents",
    "diffCents",
  ],
  arap_policies: [
    "minimumStatementBalanceCents",
    "lateFeeMinimumCents",
    "lateFeeMaximumCents",
    "writeoffMinimumCents",
    "approvalTier1Cents",
  ],
  customers: ["flatFeeCents"],
  invoices: [
    "originalAmountCents",
    "taxCents",
    "appliedPaymentsCents",
    "appliedCreditsCents",
    "writtenOffCents",
  ],
  credit_memos: ["amountCents", "appliedCents"],
  customer_payments: ["amountCents", "appliedCents"],
  remittance_lines: ["amountCents"],
  payment_applications: ["appliedCents"],
  aging_snapshots: [
    "openBalanceCents",
    "controlBalanceCents",
    "tieDifferenceCents",
  ],
  statement_documents: [
    "openingBalanceCents",
    "activityCents",
    "closingBalanceCents",
  ],
  statement_items: [
    "originalCents",
    "appliedCents",
    "openCents",
    "runningBalanceCents",
  ],
  writeoff_proposals: ["openBalanceCents", "netCents", "taxCents"],
  bills: [
    "originalAmountCents",
    "freightCents",
    "taxCents",
    "paidCents",
    "discountTakenCents",
    "creditsCents",
  ],
  vendor_credits: ["amountCents", "appliedCents"],
};

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function encodeParam(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

function decodeRow(table: string, row: Record<string, unknown>): unknown {
  const fields = CENTS_FIELDS[table] ?? [];
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    if (typeof out[f] === "string") out[f] = BigInt(out[f] as string);
    else if (typeof out[f] === "number") out[f] = BigInt(out[f] as number);
  }
  return out;
}

/**
 * Named query catalog as SQL. Column aliases produce camelCase keys so the row
 * types in tables.ts are the single definition of a row shape.
 */
interface SqlSpec {
  table: string;
  sql: string;
  params: (p: Record<string, unknown>) => unknown[];
}

const TXN_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId",
  bank_account_id as "bankAccountId", account_number as "accountNumber",
  posted_date::text as "postedDate",
  amount_cents::text as "amountCents", currency, description,
  bank_merchant_name as "bankMerchantName",
  vendor_normalized as "normalizedVendor",
  vendor_normalization_version as "vendorNormalizationVersion",
  normalization_degraded as "normalizationDegraded",
  vendor_id as "vendorId", check_number as "checkNumber",
  bank_code as "bankCode", institution_id as "institutionId",
  bank_transaction_id as "bankTransactionId",
  source, import_batch_id as "importBatchId", staged_row_id as "stagedRowId",
  category_id as "categoryId", category_version as "categoryVersion",
  cascade_level as "cascadeLevel",
  rule_id as "ruleId", rule_version as "ruleVersion",
  matched_conditions as "matchedConditions",
  auto_posted_under_rule_promotion as "autoPostedUnderRulePromotion",
  template_id as "templateId", template_version as "templateVersion",
  class_id as "classId", location_id as "locationId",
  program_id as "programId",
  suspense_reason as "suspenseReason", suspense_owner as "suspenseOwner",
  suspense_opened_on::text as "suspenseOpenedOn",
  suspense_escalates_on::text as "suspenseEscalatesOn",
  paired_with_id as "pairedWithId",
  settlement_of_transaction_id as "settlementOfTransactionId",
  is_processor_settlement as "isProcessorSettlement",
  duplicate_flag as "duplicateFlag",
  duplicate_of_transaction_id as "duplicateOfTransactionId",
  legitimate_repeat as "legitimateRepeat",
  journal_entry_id as "journalEntryId",
  instrument_type as "instrumentType", cleared,
  cleared_date::text as "clearedDate",
  statement_id as "statementId", statement_line_id as "statementLineId",
  statement_date::text as "statementDate",
  match_tier as "matchTier", match_confidence as "matchConfidence",
  rec_batch_id as "recBatchId",
  stale_flagged as "staleFlagged",
  stale_flagged_on::text as "staleFlaggedOn",
  stale_owner as "staleOwner",
  stale_escalates_on::text as "staleEscalatesOn",
  escheat_review as "escheatReview", voided, status,
  manual_override as "manualOverride", manual_override_by as "manualOverrideBy",
  manual_override_at::text as "manualOverrideAt", version`;

const MAPPING_PROFILE_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version,
  institution_name as "institutionName", account_number as "accountNumber",
  file_format as "fileFormat", header_fingerprint as "headerFingerprint",
  header_row_number as "headerRowNumber", skip_rows as "skipRows",
  date_column as "dateColumn", date_format as "dateFormat",
  description_column as "descriptionColumn", amount_column as "amountColumn",
  debit_column as "debitColumn", credit_column as "creditColumn",
  sign_convention as "signConvention", currency,
  bank_id_column as "bankIdColumn",
  check_number_column as "checkNumberColumn",
  bank_code_column as "bankCodeColumn", is_active as "isActive"`;

const IMPORT_BATCH_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", name,
  source_format as "sourceFormat", bank_account_id as "bankAccountId",
  account_number as "accountNumber",
  mapping_profile_id as "mappingProfileId",
  mapping_profile_version as "mappingProfileVersion", status,
  reject_reason as "rejectReason", row_count as "rowCount",
  accepted_count as "acceptedCount", rejected_count as "rejectedCount",
  held_count as "heldCount", net_cents::text as "netCents",
  parsed_run_id as "parsedRunId", committed_run_id as "committedRunId",
  committed_at::text as "committedAt", reversed_run_id as "reversedRunId",
  reversed_at::text as "reversedAt", reversal_blocked as "reversalBlocked",
  created_at::text as "createdAt", version`;

const STAGED_ROW_COLUMNS = `
  id, batch_id as "batchId", firm_id as "firmId", client_id as "clientId",
  row_number as "rowNumber", raw_row as "rawRow",
  posted_on::text as "postedOn", description,
  normalized_description as "normalizedDescription",
  amount_cents::text as "amountCents", currency,
  account_number as "accountNumber", bank_account_id as "bankAccountId",
  bank_transaction_id as "bankTransactionId",
  check_number as "checkNumber", bank_code as "bankCode",
  dedup_state as "dedupState",
  duplicate_of_transaction_id as "duplicateOfTransactionId",
  review_state as "reviewState",
  committed_transaction_id as "committedTransactionId",
  committed_entry_id as "committedEntryId",
  error_code as "errorCode", error_message as "errorMessage", version`;

const RUN_LOG_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", run_type as "runType",
  run_version as "runVersion", mode, status,
  idempotency_key as "idempotencyKey", scope_hash as "scopeHash",
  actor_id as "actorId", actor_kind as "actorKind", source,
  parent_sequence_id as "parentSequenceId", preview_run_id as "previewRunId",
  original_run_id as "originalRunId", period_start::text as "periodStart",
  period_end::text as "periodEnd", candidate_count as "candidateCount",
  candidate_ids as "candidateIds", scope_input as "scopeInput", versions,
  started_at::text as "startedAt", git_sha as "gitSha", release_id as "releaseId"`;

const JE_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId",
  entry_date::text as "entryDate", memo, posted, reversal_of as "reversalOf",
  reversed_by_entry_id as "reversedByEntryId",
  redated_from_locked_period::text as "redatedFromLockedPeriod",
  source_table as "sourceTable", source_row_id as "sourceRowId",
  source_version as "sourceVersion", created_by_run_id as "createdByRunId",
  run_type as "runType", run_version as "runVersion",
  reverses_on::text as "reversesOn",
  linked_document_id as "linkedDocumentId",
  accrual_template_id as "accrualTemplateId"`;

const JL_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId",
  entry_id as "entryId", account_number as "accountNumber",
  category_id as "categoryId", amount_cents::text as "amountCents",
  memo, entry_date::text as "entryDate", class_id as "classId",
  location_id as "locationId", program_id as "programId", restriction`;

const FIXED_ASSET_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", tag, description,
  asset_class as "assetClass", cost_account as "costAccount",
  accum_account as "accumAccount", expense_account as "expenseAccount",
  acquired_on::text as "acquiredOn",
  placed_in_service_on::text as "placedInServiceOn",
  cost_cents::text as "costCents", salvage_cents::text as "salvageCents",
  depreciable_base_cents::text as "depreciableBaseCents",
  method, life_months as "lifeMonths", ddb_factor_bps as "ddbFactorBps",
  macrs_recovery_years as "macrsRecoveryYears", units_total as "unitsTotal",
  convention, half_month_convention as "halfMonthConvention", status,
  disposed_on::text as "disposedOn", manual_override as "manualOverride",
  version`;

const DEPRECIATION_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", asset_id as "assetId",
  period_start::text as "periodStart", period_end::text as "periodEnd",
  period_number as "periodNumber", schedule_version as "scheduleVersion",
  amount_cents::text as "amountCents",
  accumulated_after_cents::text as "accumulatedAfterCents",
  nbv_after_cents::text as "nbvAfterCents", status,
  posted_entry_id as "postedEntryId", posted_run_id as "postedRunId",
  posted_at::text as "postedAt", manual_override as "manualOverride", version`;

const DEFERRAL_SCHEDULE_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", kind, description,
  balance_account as "balanceAccount", release_account as "releaseAccount",
  accum_account as "accumAccount", total_cents::text as "totalCents",
  service_start::text as "serviceStart", service_end::text as "serviceEnd",
  method, periods, status,
  source_transaction_id as "sourceTransactionId",
  source_document_id as "sourceDocumentId",
  linked_document_id as "linkedDocumentId",
  manual_override as "manualOverride", version`;

const DEFERRAL_LINE_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId",
  schedule_id as "scheduleId", schedule_version as "scheduleVersion",
  period_number as "periodNumber", period_start::text as "periodStart",
  period_end::text as "periodEnd", amount_cents::text as "amountCents",
  remaining_after_cents::text as "remainingAfterCents", status,
  posted_entry_id as "postedEntryId", posted_run_id as "postedRunId",
  posted_at::text as "postedAt", reversal_entry_id as "reversalEntryId",
  linked_document_id as "linkedDocumentId",
  manual_override as "manualOverride", version`;

const LOAN_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId",
  lender_name as "lenderName", loan_type as "loanType",
  principal_account_lt as "principalAccountLt",
  principal_account_cp as "principalAccountCp",
  interest_account as "interestAccount",
  funding_account as "fundingAccount", escrow_account as "escrowAccount",
  original_principal_cents::text as "originalPrincipalCents",
  origination_date::text as "originationDate",
  first_payment_date::text as "firstPaymentDate",
  term_months as "termMonths", annual_rate_bps as "annualRateBps",
  payment_cents::text as "paymentCents", status,
  manual_override as "manualOverride", version`;

const LOAN_SCHEDULE_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", loan_id as "loanId",
  schedule_version as "scheduleVersion", payment_number as "paymentNumber",
  due_date::text as "dueDate", payment_cents::text as "paymentCents",
  principal_cents::text as "principalCents",
  interest_cents::text as "interestCents",
  escrow_cents::text as "escrowCents", fees_cents::text as "feesCents",
  balance_after_cents::text as "balanceAfterCents", status,
  matched_transaction_id as "matchedTransactionId",
  posted_entry_id as "postedEntryId", posted_run_id as "postedRunId",
  posted_at::text as "postedAt", manual_override as "manualOverride", version`;

/** Migration 0014 column lists, one per module 5 table. */
const ARAP_POLICY_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version,
  aging_basis as "agingBasis",
  minimum_statement_balance_cents::text as "minimumStatementBalanceCents",
  statement_type as "statementType",
  message_neutral as "messageNeutral", message_reminder as "messageReminder",
  message_firm as "messageFirm", message_final as "messageFinal",
  grace_days as "graceDays",
  late_fee_minimum_cents::text as "lateFeeMinimumCents",
  late_fee_maximum_cents::text as "lateFeeMaximumCents",
  suppress_below_minimum_fee as "suppressBelowMinimumFee",
  writeoff_age_days as "writeoffAgeDays",
  writeoff_minimum_cents::text as "writeoffMinimumCents",
  required_attempts as "requiredAttempts",
  writeoff_method as "writeoffMethod",
  approval_tier1_cents::text as "approvalTier1Cents",
  discount_base_excludes_freight_tax as "discountBaseExcludesFreightTax",
  ar_control_account as "arControlAccount",
  ar_clearing_account as "arClearingAccount",
  allowance_account as "allowanceAccount",
  bad_debt_account as "badDebtAccount",
  sales_tax_account as "salesTaxAccount",
  late_fee_revenue_account as "lateFeeRevenueAccount",
  ap_control_account as "apControlAccount",
  ap_clearing_account as "apClearingAccount",
  purchase_discount_account as "purchaseDiscountAccount",
  vendor_credit_account as "vendorCreditAccount",
  manual_override as "manualOverride"
`;

const CUSTOMER_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version, name,
  is_active as "isActive",
  statement_suppressed as "statementSuppressed",
  statement_type as "statementType",
  application_preference as "applicationPreference",
  late_fee_enabled as "lateFeeEnabled",
  annualized_rate_bp as "annualizedRateBp",
  grace_days as "graceDays",
  flat_fee_cents::text as "flatFeeCents",
  late_fee_exempt as "lateFeeExempt",
  do_not_pursue as "doNotPursue",
  payment_plan_active as "paymentPlanActive",
  statement_document_id as "statementDocumentId",
  statement_document_date as "statementDocumentDate",
  manual_override as "manualOverride"
`;

const INVOICE_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version,
  customer_id as "customerId", invoice_number as "invoiceNumber",
  invoice_date as "invoiceDate", due_date as "dueDate",
  original_amount_cents::text as "originalAmountCents",
  tax_cents::text as "taxCents",
  applied_payments_cents::text as "appliedPaymentsCents",
  applied_credits_cents::text as "appliedCreditsCents",
  written_off_cents::text as "writtenOffCents",
  status, in_dispute as "inDispute",
  collection_attempts as "collectionAttempts",
  parent_invoice_id as "parentInvoiceId", is_late_fee as "isLateFee",
  fee_months as "feeMonths", writeoff_approved as "writeoffApproved",
  ar_account as "arAccount", revenue_account as "revenueAccount",
  manual_override as "manualOverride"
`;

const CREDIT_MEMO_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version,
  customer_id as "customerId", memo_number as "memoNumber",
  memo_date as "memoDate", amount_cents::text as "amountCents",
  applied_cents::text as "appliedCents", status,
  manual_override as "manualOverride"
`;

const CUSTOMER_PAYMENT_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version,
  customer_id as "customerId", payment_date as "paymentDate",
  amount_cents::text as "amountCents",
  applied_cents::text as "appliedCents",
  on_hold as "onHold", match_hint as "matchHint",
  transaction_id as "transactionId",
  clearing_account as "clearingAccount", status,
  applied_tier as "appliedTier", manual_override as "manualOverride"
`;

const REMITTANCE_LINE_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId",
  payment_id as "paymentId", line_number as "lineNumber",
  invoice_number as "invoiceNumber", amount_cents::text as "amountCents"
`;

const PAYMENT_APPLICATION_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version,
  payment_id as "paymentId", invoice_id as "invoiceId",
  applied_cents::text as "appliedCents",
  application_date as "applicationDate", tier, state,
  posted_entry_id as "postedEntryId",
  created_by_run_id as "createdByRunId",
  manual_override as "manualOverride"
`;

const AGING_SNAPSHOT_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version,
  as_of_date as "asOfDate", side, aging_basis as "agingBasis",
  party_id as "partyId", party_name as "partyName",
  document_id as "documentId", document_number as "documentNumber",
  document_date as "documentDate", basis_date as "basisDate",
  age_days as "ageDays", bucket,
  open_balance_cents::text as "openBalanceCents",
  control_account as "controlAccount",
  control_balance_cents::text as "controlBalanceCents",
  tie_difference_cents::text as "tieDifferenceCents",
  subledger_out_of_tie as "subledgerOutOfTie",
  created_by_run_id as "createdByRunId", created_at as "createdAt",
  manual_override as "manualOverride"
`;

const STATEMENT_DOCUMENT_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version,
  customer_id as "customerId", statement_date as "statementDate",
  statement_type as "statementType", state,
  opening_balance_cents::text as "openingBalanceCents",
  activity_cents::text as "activityCents",
  closing_balance_cents::text as "closingBalanceCents",
  message_band as "messageBand", message_text as "messageText",
  oldest_item_age_days as "oldestItemAgeDays", item_count as "itemCount",
  created_by_run_id as "createdByRunId", created_at as "createdAt",
  manual_override as "manualOverride"
`;

const STATEMENT_ITEM_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId",
  statement_id as "statementId", line_number as "lineNumber",
  item_kind as "itemKind", document_id as "documentId",
  document_number as "documentNumber", document_date as "documentDate",
  original_cents::text as "originalCents",
  applied_cents::text as "appliedCents",
  open_cents::text as "openCents",
  running_balance_cents::text as "runningBalanceCents"
`;

const WRITEOFF_PROPOSAL_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version,
  invoice_id as "invoiceId", customer_id as "customerId",
  as_of_date as "asOfDate", age_days as "ageDays",
  open_balance_cents::text as "openBalanceCents",
  net_cents::text as "netCents", tax_cents::text as "taxCents",
  method, approval_route as "approvalRoute", authority,
  collection_attempts as "collectionAttempts", state,
  posted_entry_id as "postedEntryId",
  created_by_run_id as "createdByRunId", created_at as "createdAt",
  manual_override as "manualOverride"
`;

const BILL_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version,
  vendor_id as "vendorId", bill_number as "billNumber",
  bill_date as "billDate", due_date as "dueDate",
  original_amount_cents::text as "originalAmountCents",
  freight_cents::text as "freightCents",
  tax_cents::text as "taxCents",
  paid_cents::text as "paidCents",
  discount_taken_cents::text as "discountTakenCents",
  credits_cents::text as "creditsCents",
  discount_bps as "discountBps", discount_days as "discountDays",
  net_days as "netDays", status, on_hold as "onHold",
  in_dispute as "inDispute", ap_account as "apAccount",
  expense_account as "expenseAccount", manual_override as "manualOverride"
`;

const VENDOR_CREDIT_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version,
  vendor_id as "vendorId", bill_id as "billId",
  credit_date as "creditDate", amount_cents::text as "amountCents",
  applied_cents::text as "appliedCents", state, source,
  posted_entry_id as "postedEntryId",
  created_by_run_id as "createdByRunId",
  manual_override as "manualOverride"
`;

const ACCRUAL_TEMPLATE_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version, name,
  accrual_kind as "accrualKind", basis,
  debit_account as "debitAccount", credit_account as "creditAccount",
  category_id as "categoryId",
  fixed_amount_cents::text as "fixedAmountCents",
  source_document_id as "sourceDocumentId",
  source_document_amount_cents::text as "sourceDocumentAmountCents",
  daily_rate_cents::text as "dailyRateCents", day_count as "dayCount",
  base_cents::text as "baseCents", percent_bps as "percentBps",
  entry_memo as "entryMemo", auto_reverse as "autoReverse",
  is_active as "isActive", manual_override as "manualOverride"`;

const STATEMENT_LINE_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId",
  bank_account_id as "bankAccountId", statement_id as "statementId",
  statement_date::text as "statementDate",
  amount_cents::text as "amountCents", currency, description,
  normalized_vendor as "normalizedVendor", check_number as "checkNumber",
  source_format as "sourceFormat", rec_batch_id as "recBatchId",
  match_tier as "matchTier", match_confidence as "matchConfidence",
  match_diff_cents::text as "matchDiffCents",
  match_confirmed as "matchConfirmed",
  matched_transaction_id as "matchedTransactionId",
  matched_transaction_count as "matchedTransactionCount",
  matched_by_run_id as "matchedByRunId", version`;

const REC_BATCH_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId",
  bank_account_id as "bankAccountId", statement_id as "statementId",
  statement_period as "statementPeriod",
  period_start::text as "periodStart", period_end::text as "periodEnd",
  statement_balance_cents::text as "statementBalanceCents",
  cleared_ledger_balance_cents::text as "clearedLedgerBalanceCents",
  diff_cents::text as "diffCents", state,
  opened_by as "openedBy", opened_at::text as "openedAt",
  opened_by_run_id as "openedByRunId", closed_at::text as "closedAt",
  closed_by_run_id as "closedByRunId", version`;

const QUERIES: Record<QueryName, SqlSpec> = {
  bank_accounts_for_client: {
    table: "bank_accounts",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            account_number as "accountNumber", nickname, kind,
            is_processor_destination as "isProcessorDestination"
          from ${SCHEMA}.bank_accounts
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  chart_account: {
    table: "chart_accounts",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            account_number as "accountNumber", name
          from ${SCHEMA}.chart_accounts
          where firm_id = $1 and client_id = $2 and account_number = $3
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.accountNumber],
  },
  open_period_locks: {
    table: "period_locks",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            period_start::text as "periodStart", period_end::text as "periodEnd",
            locked_at::text as "lockedAt", locked_by as "lockedBy",
            closed_with_exceptions as "closedWithExceptions",
            exception_note as "exceptionNote", unlocked_at::text as "unlockedAt",
            unlocked_by as "unlockedBy", unlock_reason as "unlockReason"
          from ${SCHEMA}.period_locks
          where firm_id = $1 and client_id = $2 and unlocked_at is null
          order by period_start asc, id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  transactions_in_window: {
    table: "transactions",
    sql: `select ${TXN_COLUMNS}
          from ${SCHEMA}.transactions
          where firm_id = $1
            and client_id = $2
            and posted_date between $3::date and $4::date
            and ($5::boolean or manual_override = false)
            and ($6::uuid[] is null or bank_account_id = any($6::uuid[]))
          order by posted_date asc, abs(amount_cents) asc, id asc`,
    params: (p) => [
      p.firmId,
      p.clientId,
      p.from,
      p.to,
      p.includeOverridden,
      p.bankAccountIds,
    ],
  },
  overridden_transaction_ids_in_window: {
    table: "transactions",
    sql: `select id
          from ${SCHEMA}.transactions
          where firm_id = $1
            and client_id = $2
            and posted_date between $3::date and $4::date
            and manual_override = true
          order by posted_date asc, abs(amount_cents) asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.from, p.to],
  },
  transfer_pairs_for_client: {
    table: "transfer_pairs",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            outbound_txn_id as "outboundTxnId", inbound_txn_id as "inboundTxnId",
            created_by_run_id as "createdByRunId",
            manually_confirmed as "manuallyConfirmed"
          from ${SCHEMA}.transfer_pairs
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  applied_run_by_idempotency_key: {
    table: "run_log",
    sql: `select ${RUN_LOG_COLUMNS}
          from ${SCHEMA}.run_log
          where mode = 'apply' and idempotency_key = $1
          order by started_at asc, id asc`,
    params: (p) => [p.idempotencyKey],
  },
  run_log_by_id: {
    table: "run_log",
    sql: `select ${RUN_LOG_COLUMNS}
          from ${SCHEMA}.run_log
          where firm_id = $1 and id = $2`,
    params: (p) => [p.firmId, p.executionId],
  },
  run_log_items_by_execution: {
    table: "run_log_items",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            run_execution_id as "runExecutionId", row_table as "rowTable",
            row_id as "rowId", decision, reason,
            cascade_level as "cascadeLevel", rule_id as "ruleId",
            rule_version as "ruleVersion", template_id as "templateId",
            template_version as "templateVersion",
            suspense_reason_code as "suspenseReasonCode",
            journal_entry_id as "journalEntryId", before_json as "beforeJson",
            after_json as "afterJson", proposal_json as "proposalJson",
            error_code as "errorCode", error_message as "errorMessage"
          from ${SCHEMA}.run_log_items
          where firm_id = $1 and run_execution_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.executionId],
  },
  run_log_events_by_execution: {
    table: "run_log_events",
    sql: `select id, firm_id as "firmId", run_execution_id as "runExecutionId",
            event, attempt, detail, proposal_count as "proposalCount",
            skip_count as "skipCount", error_count as "errorCount",
            net_cents::text as "netCents", entries_created as "entriesCreated",
            entries_reversed as "entriesReversed",
            skip_counts_by_reason as "skipCountsByReason",
            duration_ms as "durationMs", related_run_id as "relatedRunId",
            occurred_at::text as "occurredAt"
          from ${SCHEMA}.run_log_events
          where firm_id = $1 and run_execution_id = $2
          order by occurred_at asc, id asc`,
    params: (p) => [p.firmId, p.executionId],
  },
  started_runs_before: {
    table: "run_log",
    sql: `select ${RUN_LOG_COLUMNS}
          from ${SCHEMA}.run_log
          where status = 'started' and started_at <= $1::timestamptz
          order by started_at asc, id asc`,
    params: (p) => [p.before],
  },
  journal_entries_by_run: {
    table: "journal_entries",
    sql: `select ${JE_COLUMNS}
          from ${SCHEMA}.journal_entries
          where firm_id = $1 and created_by_run_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.executionId],
  },
  journal_entries_referencing: {
    table: "journal_entries",
    sql: `select ${JE_COLUMNS}
          from ${SCHEMA}.journal_entries
          where firm_id = $1 and client_id = $2
            and reversal_of = any($3::char(26)[])
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.entryIds],
  },
  journal_lines_for_client: {
    table: "journal_lines",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            entry_id as "entryId", account_number as "accountNumber",
            category_id as "categoryId", amount_cents::text as "amountCents",
            memo, entry_date::text as "entryDate", class_id as "classId",
            location_id as "locationId", program_id as "programId", restriction
          from ${SCHEMA}.journal_lines
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  suspense_items_by_run: {
    table: "suspense_items",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            transaction_id as "transactionId", reason_code as "reasonCode",
            account_number as "accountNumber", detail,
            related_ids as "relatedIds", created_by_run_id as "createdByRunId",
            withdrawn_by_run_id as "withdrawnByRunId"
          from ${SCHEMA}.suspense_items
          where firm_id = $1 and created_by_run_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.executionId],
  },
  transactions_by_ids: {
    table: "transactions",
    sql: `select ${TXN_COLUMNS}
          from ${SCHEMA}.transactions
          where firm_id = $1 and client_id = $2 and id = any($3::char(26)[])
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.ids],
  },
  active_mapping_profile: {
    table: "mapping_profiles",
    sql: `select ${MAPPING_PROFILE_COLUMNS}
          from import.mapping_profiles
          where firm_id = $1 and client_id = $2
            and institution_name = $3 and file_format = $4
            and is_active = true
          order by version desc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.institutionName, p.fileFormat],
  },
  import_batch_by_id: {
    table: "import_batches",
    sql: `select ${IMPORT_BATCH_COLUMNS}
          from import.batches
          where firm_id = $1 and client_id = $2 and id = $3`,
    params: (p) => [p.firmId, p.clientId, p.batchId],
  },
  staged_rows_by_batch: {
    table: "staged_rows",
    sql: `select ${STAGED_ROW_COLUMNS}
          from import.staged_rows
          where firm_id = $1 and client_id = $2 and batch_id = $3
          order by row_number asc`,
    params: (p) => [p.firmId, p.clientId, p.batchId],
  },
  transactions_by_bank_ids: {
    table: "transactions",
    sql: `select ${TXN_COLUMNS}
          from ${SCHEMA}.transactions
          where firm_id = $1 and client_id = $2
            and bank_account_id = $3
            and bank_transaction_id = any($4::text[])
          order by posted_date asc, abs(amount_cents) asc, id asc`,
    params: (p) => [
      p.firmId,
      p.clientId,
      p.bankAccountId,
      p.bankTransactionIds,
    ],
  },
  transactions_for_account_window: {
    table: "transactions",
    sql: `select ${TXN_COLUMNS}
          from ${SCHEMA}.transactions
          where firm_id = $1 and client_id = $2
            and bank_account_id = $3
            and posted_date between $4::date and $5::date
          order by posted_date asc, abs(amount_cents) asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.bankAccountId, p.from, p.to],
  },
  transactions_by_batch: {
    table: "transactions",
    sql: `select ${TXN_COLUMNS}
          from ${SCHEMA}.transactions
          where firm_id = $1 and client_id = $2 and import_batch_id = $3
          order by posted_date asc, abs(amount_cents) asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.batchId],
  },

  // Doc 02 module 2 reference reads. The tie break and iteration orders live in
  // the order by clauses so the run never sorts a second time.
  categories_for_client: {
    table: "categories",
    sql: `select id, firm_id as "firmId", client_id as "clientId", version,
            name, account_number as "accountNumber",
            normal_side as "normalSide", tax_treatment as "taxTreatment",
            class_1099 as "class1099",
            requires_receipt_over::text as "requiresReceiptOverCents",
            requires_class as "requiresClass",
            capitalize_over::text as "capitalizeOverCents",
            restriction_relevant as "restrictionRelevant",
            is_active as "isActive"
          from ${SCHEMA}.categories
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  active_rules_for_client: {
    table: "rules",
    sql: `select id, firm_id as "firmId", client_id as "clientId", version,
            name, priority, condition_count as "conditionCount", conditions,
            target_category_id as "targetCategoryId",
            scope_kind as "scopeKind",
            effective_from::text as "effectiveFrom",
            effective_to::text as "effectiveTo", is_active as "isActive",
            accepted_count as "acceptedCount",
            rejected_count as "rejectedCount",
            auto_post_enabled as "autoPostEnabled",
            auto_post_enabled_by as "autoPostEnabledBy",
            auto_post_ceiling::text as "autoPostCeilingCents"
          from ${SCHEMA}.rules
          where firm_id = $1 and client_id = $2 and is_active
          order by priority desc, condition_count desc, id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  recurring_templates_for_client: {
    table: "recurring_templates",
    sql: `select id, firm_id as "firmId", client_id as "clientId", version,
            name, match_kind as "matchKind",
            match_normalized_name as "matchNormalizedName",
            bank_account_id as "bankAccountId", amount_mode as "amountMode",
            match_amount_cents::text as "matchAmountCents",
            amount_floor_cents::text as "amountFloorCents",
            amount_ceiling_cents::text as "amountCeilingCents",
            day_of_month as "dayOfMonth", day_window as "dayWindow",
            split_mode as "splitMode", is_active as "isActive",
            cadence, start_date::text as "startDate",
            end_date::text as "endDate",
            posting_date_rule as "postingDateRule",
            driver_amount_cents::text as "driverAmountCents",
            entry_memo_template as "entryMemoTemplate",
            manual_override as "manualOverride"
          from subledger.recurring_templates
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  recurring_splits_for_template: {
    table: "recurring_splits",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            template_id as "templateId",
            template_version as "templateVersion",
            line_number as "lineNumber", category_id as "categoryId",
            account_number as "accountNumber",
            fixed_amount_cents::text as "fixedAmountCents",
            percent_bps as "percentBps", is_remainder as "isRemainder",
            class_id as "classId", location_id as "locationId",
            program_id as "programId", memo
          from subledger.recurring_splits
          where firm_id = $1 and client_id = $2 and template_id = $3
            and template_version = $4
          order by line_number asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.templateId, p.templateVersion],
  },
  vendors_for_client: {
    table: "vendors",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            legal_name as "legalName", normalized_name as "normalizedName",
            normalizer_version as "normalizerVersion", aliases,
            default_category_id as "defaultCategoryId",
            default_category_version as "defaultCategoryVersion",
            is_active as "isActive",
            early_discount_rule as "earlyDiscountRule"
          from subledger.vendors
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  bank_code_mappings_for_client: {
    table: "bank_code_mappings",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            institution_id as "institutionId", bank_code as "bankCode",
            category_id as "categoryId", is_active as "isActive"
          from ${SCHEMA}.bank_code_mappings
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  settlement_rows_in_window: {
    table: "settlement_rows",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            processor_key as "processorKey", payout_id as "payoutId",
            payout_date::text as "payoutDate",
            gross_cents::text as "grossCents", fee_cents::text as "feeCents",
            net_cents::text as "netCents",
            batch_reference as "batchReference",
            revenue_category_id as "revenueCategoryId",
            fee_category_id as "feeCategoryId",
            matched_transaction_id as "matchedTransactionId", version
          from subledger.settlement_rows
          where firm_id = $1 and client_id = $2
            and payout_date >= $3 and payout_date <= $4
          order by payout_date asc, payout_id asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.from, p.to],
  },
  client_policy: {
    table: "client_policies",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            functional_currency as "functionalCurrency",
            capitalize_over::text as "capitalizeOverCents",
            gross_at_sale_time as "grossAtSaleTime",
            cleanup_engagement as "cleanupEngagement"
          from ${SCHEMA}.client_policies
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  document_links_for_transactions: {
    table: "document_links",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            transaction_id as "transactionId", document_id as "documentId",
            document_type as "documentType"
          from ${SCHEMA}.document_links
          where firm_id = $1 and client_id = $2
            and transaction_id = any($3::text[])
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.transactionIds],
  },
  open_portal_requests_for_client: {
    table: "portal_requests",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            transaction_id as "transactionId", reason_code as "reasonCode",
            detail, status, opened_on::text as "openedOn",
            due_on::text as "dueOn", created_by_run_id as "createdByRunId"
          from ${SCHEMA}.portal_requests
          where firm_id = $1 and client_id = $2 and status = 'open'
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  statement_lines_for_statement: {
    table: "statement_lines",
    sql: `select ${STATEMENT_LINE_COLUMNS}
          from ${SCHEMA}.statement_lines
          where firm_id = $1 and client_id = $2
            and bank_account_id = $3 and statement_id = $4
          order by statement_date asc, abs(amount_cents) asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.bankAccountId, p.statementId],
  },
  rec_batch_for_statement: {
    table: "rec_batches",
    sql: `select ${REC_BATCH_COLUMNS}
          from ${SCHEMA}.rec_batches
          where firm_id = $1 and client_id = $2
            and bank_account_id = $3 and statement_id = $4
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.bankAccountId, p.statementId],
  },
  cleared_transactions_for_account: {
    table: "transactions",
    sql: `select ${TXN_COLUMNS}
          from ${SCHEMA}.transactions
          where firm_id = $1 and client_id = $2
            and bank_account_id = $3
            and cleared = true and status = 'active'
            and posted_date <= $4::date
          order by posted_date asc, abs(amount_cents) asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.bankAccountId, p.through],
  },
  transactions_for_statement: {
    table: "transactions",
    sql: `select ${TXN_COLUMNS}
          from ${SCHEMA}.transactions
          where firm_id = $1 and client_id = $2
            and bank_account_id = $3 and statement_id = $4
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.bankAccountId, p.statementId],
  },
  suspense_items_for_transactions: {
    table: "suspense_items",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            transaction_id as "transactionId", reason_code as "reasonCode",
            account_number as "accountNumber", detail,
            related_ids as "relatedIds", created_by_run_id as "createdByRunId",
            withdrawn_by_run_id as "withdrawnByRunId"
          from ${SCHEMA}.suspense_items
          where firm_id = $1 and client_id = $2
            and transaction_id = any($3::text[])
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.transactionIds],
  },

  // Doc 02 module 4, the period end reads.

  journal_entries_in_window: {
    table: "journal_entries",
    sql: `select ${JE_COLUMNS}
          from ${SCHEMA}.journal_entries
          where firm_id = $1 and client_id = $2
            and entry_date >= $3::date and entry_date <= $4::date
          order by entry_date asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.from, p.to],
  },
  journal_entries_awaiting_reversal: {
    table: "journal_entries",
    sql: `select ${JE_COLUMNS}
          from ${SCHEMA}.journal_entries
          where firm_id = $1 and client_id = $2
            and reverses_on is not null
            and reverses_on >= $3::date and reverses_on <= $4::date
          order by entry_date asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.from, p.to],
  },
  journal_lines_for_entries: {
    table: "journal_lines",
    sql: `select ${JL_COLUMNS}
          from ${SCHEMA}.journal_lines
          where firm_id = $1 and client_id = $2
            and entry_id = any($3::char(26)[])
          order by entry_id asc, account_number asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.entryIds],
  },
  deferral_schedules_for_client: {
    table: "deferral_schedules",
    sql: `select ${DEFERRAL_SCHEDULE_COLUMNS}
          from subledger.deferral_schedules
          where firm_id = $1 and client_id = $2 and kind = any($3::text[])
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.kinds],
  },
  deferral_lines_for_schedules: {
    table: "deferral_lines",
    sql: `select ${DEFERRAL_LINE_COLUMNS}
          from subledger.deferral_lines
          where firm_id = $1 and client_id = $2
            and schedule_id = any($3::char(26)[])
          order by schedule_id asc, period_number asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.scheduleIds],
  },
  loans_for_client: {
    table: "loans",
    sql: `select ${LOAN_COLUMNS}
          from subledger.loans
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  loan_schedule_for_client: {
    table: "loan_schedule",
    sql: `select ${LOAN_SCHEDULE_COLUMNS}
          from subledger.loan_schedule
          where firm_id = $1 and client_id = $2
            and due_date >= $3::date and due_date <= $4::date
          order by due_date asc, payment_number asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.from, p.to],
  },
  loan_schedule_for_loans: {
    table: "loan_schedule",
    sql: `select ${LOAN_SCHEDULE_COLUMNS}
          from subledger.loan_schedule
          where firm_id = $1 and client_id = $2
            and loan_id = any($3::char(26)[])
          order by due_date asc, payment_number asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.loanIds],
  },
  fixed_assets_for_client: {
    table: "fixed_assets",
    sql: `select ${FIXED_ASSET_COLUMNS}
          from subledger.fixed_assets
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  depreciation_schedule_for_assets: {
    table: "depreciation_schedule",
    sql: `select ${DEPRECIATION_COLUMNS}
          from subledger.depreciation_schedule
          where firm_id = $1 and client_id = $2
            and asset_id = any($3::char(26)[])
          order by asset_id asc, period_start asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.assetIds],
  },
  accrual_templates_for_client: {
    table: "accrual_templates",
    sql: `select ${ACCRUAL_TEMPLATE_COLUMNS}
          from subledger.accrual_templates
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  arap_policy: {
    table: "arap_policies",
    sql: `select ${ARAP_POLICY_COLUMNS}
          from subledger.arap_policies
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  customers_for_client: {
    table: "customers",
    sql: `select ${CUSTOMER_COLUMNS}
          from subledger.customers
          where firm_id = $1 and client_id = $2
          order by name asc, id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  invoices_for_client: {
    table: "invoices",
    sql: `select ${INVOICE_COLUMNS}
          from subledger.invoices
          where firm_id = $1 and client_id = $2
          order by due_date asc, id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  credit_memos_for_client: {
    table: "credit_memos",
    sql: `select ${CREDIT_MEMO_COLUMNS}
          from subledger.credit_memos
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  customer_payments_in_window: {
    table: "customer_payments",
    sql: `select ${CUSTOMER_PAYMENT_COLUMNS}
          from subledger.customer_payments
          where firm_id = $1 and client_id = $2
            and payment_date >= $3 and payment_date <= $4
          order by payment_date asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.from, p.to],
  },
  remittance_lines_for_payments: {
    table: "remittance_lines",
    sql: `select ${REMITTANCE_LINE_COLUMNS}
          from subledger.remittance_lines
          where firm_id = $1 and client_id = $2
            and payment_id = any($3::char(26)[])
          order by payment_id asc, line_number asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.paymentIds],
  },
  payment_applications_for_client: {
    table: "payment_applications",
    sql: `select ${PAYMENT_APPLICATION_COLUMNS}
          from subledger.payment_applications
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  aging_snapshots_for_date: {
    table: "aging_snapshots",
    sql: `select ${AGING_SNAPSHOT_COLUMNS}
          from subledger.aging_snapshots
          where firm_id = $1 and client_id = $2 and as_of_date = $3
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.asOfDate],
  },
  statement_documents_for_date: {
    table: "statement_documents",
    sql: `select ${STATEMENT_DOCUMENT_COLUMNS}
          from subledger.statement_documents
          where firm_id = $1 and client_id = $2 and statement_date = $3
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.statementDate],
  },
  statement_items_for_statements: {
    table: "statement_items",
    sql: `select ${STATEMENT_ITEM_COLUMNS}
          from subledger.statement_items
          where firm_id = $1 and client_id = $2
            and statement_id = any($3::char(26)[])
          order by statement_id asc, line_number asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.statementIds],
  },
  writeoff_proposals_for_client: {
    table: "writeoff_proposals",
    sql: `select ${WRITEOFF_PROPOSAL_COLUMNS}
          from subledger.writeoff_proposals
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  bills_for_client: {
    table: "bills",
    sql: `select ${BILL_COLUMNS}
          from subledger.bills
          where firm_id = $1 and client_id = $2
          order by bill_date asc, id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  vendor_credits_for_client: {
    table: "vendor_credits",
    sql: `select ${VENDOR_CREDIT_COLUMNS}
          from subledger.vendor_credits
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
};

function translateError(err: unknown): unknown {
  const e = err as PgErrorLike;
  if (!e || typeof e !== "object") return err;
  if (e.code === "40001" || e.code === "40P01") {
    return new SerializationFailure(e.message ?? "serialization");
  }
  if (e.code === "23505" || e.code === "23P01") {
    return new UniqueViolation(e.constraint ?? "unique");
  }
  const message = e.message ?? "";
  if (message.startsWith("override_protected_row")) {
    const parts = message.split(" ");
    return new OverrideProtectedError(parts[1] ?? "unknown", parts[2] ?? "unknown");
  }
  if (message.startsWith("locked_period")) {
    return new LockedPeriodError("unknown", "unknown");
  }
  return err;
}

class PostgresTx implements RunTx {
  constructor(
    private readonly client: PgClientLike,
    readonly session: TxSession,
  ) {}

  async query<K extends QueryName>(
    name: K,
    params: QueryCatalog[K]["params"],
  ): Promise<QueryCatalog[K]["row"][]> {
    const spec = QUERIES[name];
    try {
      const res = await this.client.query<Record<string, unknown>>(
        spec.sql,
        spec.params(params as unknown as Record<string, unknown>).map(encodeParam),
      );
      return res.rows.map(
        (r) => decodeRow(spec.table, r) as QueryCatalog[K]["row"],
      );
    } catch (err) {
      throw translateError(err);
    }
  }

  async tryAdvisoryXactLock(highKey: string, lowKey: string): Promise<boolean> {
    const res = await this.client.query<{ locked: boolean }>(
      `select pg_try_advisory_xact_lock(hashtext($1::text), hashtext($2::text)) as locked`,
      [highKey, lowKey],
    );
    return res.rows.length > 0 && res.rows[0].locked === true;
  }

  async insert<T extends TableName>(table: T, rows: RowMap[T][]): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      const entries = Object.entries(row as unknown as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      );
      const cols = entries.map(([k]) => camelToSnake(k)).join(", ");
      const placeholders = entries.map((_e, i) => `$${i + 1}`).join(", ");
      const values = entries.map(([, v]) => encodeParam(v));
      try {
        await this.client.query(
          `insert into ${physical(table)} (${cols}) values (${placeholders})`,
          values,
        );
      } catch (err) {
        throw translateError(err);
      }
    }
  }

  async update<T extends TableName>(
    table: T,
    rowId: string,
    patch: Partial<RowMap[T]>,
  ): Promise<void> {
    const entries = Object.entries(patch as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return;
    const sets = entries
      .map(([k], i) => `${camelToSnake(k)} = $${i + 1}`)
      .join(", ");
    const values = entries.map(([, v]) => encodeParam(v));
    values.push(rowId);
    values.push(this.session.firmId);
    try {
      await this.client.query(
        `update ${physical(table)} set ${sets}
         where id = $${values.length - 1} and firm_id = $${values.length}`,
        values,
      );
    } catch (err) {
      throw translateError(err);
    }
  }
}

export class PostgresRunDb implements RunDb {
  constructor(private readonly pool: PgPoolLike) {}

  async tx<T>(session: TxSession, fn: (tx: RunTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const isolation =
      session.isolation === "serializable" ? "serializable" : "repeatable read";
    try {
      await client.query(
        `begin isolation level ${isolation}${session.readOnly ? " read only" : ""}`,
      );
      // Tenant context and actor kind, read by the guards and the RLS policies.
      await client.query(
        `select set_config('app.firm_id', $1, true),
                set_config('app.client_id', $2, true),
                set_config('app.actor_id', $3, true),
                set_config('app.actor_kind', $4, true)`,
        [session.firmId, session.clientId, session.actorId, session.actorKind],
      );
      const out = await fn(new PostgresTx(client, session));
      await client.query("commit");
      return out;
    } catch (err) {
      try {
        await client.query("rollback");
      } catch {
        // A rollback failure on a dead connection is not the interesting error.
      }
      throw translateError(err);
    } finally {
      client.release();
    }
  }
}
