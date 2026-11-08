/**
 * Read models for the firm plane screens that are not a client list or a
 * transaction page. One contract per screen family. Every number here is read
 * from the table that owns it; the screens display and never derive.
 */

import { z } from "zod";
import { centsSchema, daySchema, idSchema, instantSchema } from "./common";
import { portalRequestSchema } from "./portal";

/* ------------------------------------------------------------------------ */
/* Close checklist                                                           */
/* ------------------------------------------------------------------------ */

export const closeTaskSchema = z.object({
  id: idSchema,
  catalogCode: z.string(),
  title: z.string(),
  kind: z.enum(["checklist", "deadline", "gate_target"]),
  role: z.enum(["preparer", "reviewer"]),
  gateCode: z.string().nullable(),
  dueDate: daySchema,
  state: z.enum(["open", "blocked", "complete"]),
  blockedByCode: z.string().nullable(),
  assigneeId: z.string().nullable(),
  escalationRung: z.string(),
  completedOn: daySchema.nullable(),
});
export type CloseTask = z.infer<typeof closeTaskSchema>;

export const closeGateSchema = z.object({
  gateCode: z.string(),
  gateTitle: z.string(),
  outcome: z.string(),
  blockingCount: z.number().int(),
  evaluatedAt: instantSchema,
  scopeReason: z.string().nullable(),
  manualOverride: z.boolean(),
  overrideReason: z.string().nullable(),
});
export type CloseGate = z.infer<typeof closeGateSchema>;

export const tieoutSchema = z.object({
  id: idSchema,
  accountNumber: z.string(),
  accountName: z.string(),
  sourceKind: z.string(),
  ledgerBalanceCents: centsSchema,
  supportedBalanceCents: centsSchema.nullable(),
  varianceCents: centsSchema.nullable(),
  state: z.enum(["computed_tied", "unsupported", "variance_open"]),
  detail: z.string(),
});
export type Tieout = z.infer<typeof tieoutSchema>;

export const closeChecklistSchema = z.object({
  clientId: idSchema,
  period: daySchema,
  periodStatus: z.enum(["locked", "open", "none"]),
  lockedAt: instantSchema.nullable(),
  tasks: z.array(closeTaskSchema),
  gates: z.array(closeGateSchema),
  tieouts: z.array(tieoutSchema),
  openSuspense: z.number().int(),
  openRequests: z.number().int(),
  openBatches: z.number().int(),
});
export type CloseChecklist = z.infer<typeof closeChecklistSchema>;

/* ------------------------------------------------------------------------ */
/* Reconciliation                                                            */
/* ------------------------------------------------------------------------ */

export const recBatchSchema = z.object({
  id: idSchema,
  bankAccountId: idSchema,
  bankAccountName: z.string(),
  bankKind: z.enum(["bank", "card"]),
  statementId: idSchema,
  statementPeriod: daySchema,
  statementBalanceCents: centsSchema,
  clearedLedgerBalanceCents: centsSchema.nullable(),
  diffCents: centsSchema.nullable(),
  state: z.enum(["open", "reconciled", "out_of_balance"]),
  openedAt: instantSchema,
  closedAt: instantSchema.nullable(),
  lineCount: z.number().int(),
  matchedCount: z.number().int(),
});
export type RecBatch = z.infer<typeof recBatchSchema>;

export const recLineSchema = z.object({
  id: idSchema,
  statementDate: daySchema,
  amountCents: centsSchema,
  description: z.string(),
  checkNumber: z.string().nullable(),
  matchTier: z.number().int().nullable(),
  matchConfidence: z.number().nullable(),
  matchDiffCents: centsSchema.nullable(),
  matchConfirmed: z.boolean(),
  matchedTransactionId: idSchema.nullable(),
  matchedTransactionCount: z.number().int(),
});
export type RecLine = z.infer<typeof recLineSchema>;

export const reconcileSchema = z.object({
  clientId: idSchema,
  period: daySchema,
  bankAccounts: z.array(
    z.object({ id: idSchema, nickname: z.string(), accountNumber: z.string(), kind: z.enum(["bank", "card"]) }),
  ),
  batches: z.array(recBatchSchema),
  /** Lines of the batch the query named, or of the first batch in the period. */
  selectedBatchId: idSchema.nullable(),
  lines: z.array(recLineSchema),
});
export type Reconcile = z.infer<typeof reconcileSchema>;

/* ------------------------------------------------------------------------ */
/* Staged statements, waiting on a commit or a reject decision              */
/* ------------------------------------------------------------------------ */

export const stagedBatchSchema = z.object({
  id: idSchema,
  bankAccountId: idSchema,
  bankAccountName: z.string(),
  periodStart: daySchema.nullable(),
  periodEnd: daySchema.nullable(),
  lineCount: z.number().int(),
  duplicatesHeld: z.number().int(),
  rejectedCount: z.number().int(),
  netCents: centsSchema,
  status: z.enum(["parsed", "in_review"]),
  createdAt: instantSchema,
  /** The firm's one open mapping exception for this account, if any. */
  mappingError: z.string().nullable(),
});
export type StagedBatch = z.infer<typeof stagedBatchSchema>;

export const stagedBatchesSchema = z.object({
  clientId: idSchema,
  items: z.array(stagedBatchSchema),
});
export type StagedBatches = z.infer<typeof stagedBatchesSchema>;

export const rejectBatchBodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type RejectBatchBody = z.infer<typeof rejectBatchBodySchema>;

/**
 * One row inside a staged batch, held for a person to say whether it is a
 * real repeat charge or an actual duplicate. IMPORT-PARSE-FEED holds a row
 * this way whenever a bank feed gives no transaction id and the row looks
 * like a probable repeat of one already posted; IMPORT-REVIEW-STAGED-ROW is
 * the only thing that ever moves it off held_for_review/pending.
 */
export const stagedRowSchema = z.object({
  id: idSchema,
  batchId: idSchema,
  postedOn: daySchema.nullable(),
  description: z.string().nullable(),
  amountCents: centsSchema.nullable(),
  dedupState: z.enum(["unique", "rejected_duplicate", "held_for_review", "confirmed_repeat", "committed"]),
  reviewState: z.enum(["none", "pending", "accepted", "rejected"]),
  reviewedAt: instantSchema.nullable(),
});
export type StagedRow = z.infer<typeof stagedRowSchema>;

export const stagedRowsSchema = z.object({
  batchId: idSchema,
  items: z.array(stagedRowSchema),
});
export type StagedRows = z.infer<typeof stagedRowsSchema>;

export const reviewStagedRowBodySchema = z.object({
  decision: z.enum(["accept", "reject"]),
});
export type ReviewStagedRowBody = z.infer<typeof reviewStagedRowBodySchema>;

/* ------------------------------------------------------------------------ */
/* Open items, the firm view of the client's requests                       */
/* ------------------------------------------------------------------------ */

export const firmRequestSchema = portalRequestSchema.extend({
  owner: z.enum(["client", "firm"]),
  transactionId: idSchema.nullable(),
});
export type FirmRequest = z.infer<typeof firmRequestSchema>;

export const firmRequestsSchema = z.object({
  clientId: idSchema,
  items: z.array(firmRequestSchema),
  openCount: z.number().int(),
  overdueCount: z.number().int(),
});
export type FirmRequests = z.infer<typeof firmRequestsSchema>;

/* ------------------------------------------------------------------------ */
/* Trial balance, firm side detail behind the statements                    */
/* ------------------------------------------------------------------------ */

export const trialBalanceLineSchema = z.object({
  accountNumber: z.string(),
  name: z.string(),
  debitCents: centsSchema,
  creditCents: centsSchema,
});
export const trialBalanceSchema = z.object({
  clientId: idSchema,
  period: daySchema,
  lines: z.array(trialBalanceLineSchema),
  totalDebitCents: centsSchema,
  totalCreditCents: centsSchema,
  foots: z.boolean(),
});
export type TrialBalance = z.infer<typeof trialBalanceSchema>;

/* ------------------------------------------------------------------------ */
/* Aging, from open invoices and bills                                       */
/* ------------------------------------------------------------------------ */

export const agingBucketsSchema = z.object({
  currentCents: centsSchema,
  b1To30Cents: centsSchema,
  b31To60Cents: centsSchema,
  b61To90Cents: centsSchema,
  over90Cents: centsSchema,
  totalCents: centsSchema,
});
export type AgingBuckets = z.infer<typeof agingBucketsSchema>;

export const agingPartySchema = z.object({
  partyId: idSchema,
  partyName: z.string(),
  documentCount: z.number().int(),
  buckets: agingBucketsSchema,
});
export type AgingParty = z.infer<typeof agingPartySchema>;

export const agingSchema = z.object({
  clientId: idSchema,
  asOfDate: daySchema,
  receivable: z.array(agingPartySchema),
  receivableTotals: agingBucketsSchema,
  payable: z.array(agingPartySchema),
  payableTotals: agingBucketsSchema,
  /** The last AR-REFRESH-AGING snapshot date, when one exists. */
  lastSnapshotDate: daySchema.nullable(),
});
export type Aging = z.infer<typeof agingSchema>;

/* ------------------------------------------------------------------------ */
/* Budget versus actual                                                      */
/* ------------------------------------------------------------------------ */

export const budgetLineSchema = z.object({
  accountNumber: z.string(),
  accountName: z.string(),
  budgetCents: centsSchema,
  actualCents: centsSchema,
  varianceCents: centsSchema,
  varianceBp: z.number().nullable(),
  direction: z.enum(["favorable", "unfavorable", "neutral"]),
  flagged: z.boolean(),
  flagCode: z.string(),
  detail: z.string(),
});
export type BudgetLine = z.infer<typeof budgetLineSchema>;

export const budgetSchema = z.object({
  clientId: idSchema,
  period: daySchema,
  /** Budget rows entered for the period, before any variance run. */
  budgetedAccounts: z.number().int(),
  budgetTotalCents: centsSchema,
  /** Variance rows RPT-COMPUTE-VARIANCES wrote; empty until it has run. */
  lines: z.array(budgetLineSchema),
  flaggedCount: z.number().int(),
  thresholds: z.array(
    z.object({ accountNumber: z.string().nullable(), varianceFloorCents: centsSchema, varianceThresholdBp: z.number().int(), note: z.string() }),
  ),
});
export type Budget = z.infer<typeof budgetSchema>;

/* ------------------------------------------------------------------------ */
/* Cash forecast                                                             */
/* ------------------------------------------------------------------------ */

export const forecastWeekSchema = z.object({
  weekNumber: z.number().int(),
  weekStart: daySchema,
  weekEnd: daySchema,
  openingCents: centsSchema,
  arInflowCents: centsSchema,
  otherInflowCents: centsSchema,
  apOutflowCents: centsSchema,
  recurringOutflowCents: centsSchema,
  loanOutflowCents: centsSchema,
  payrollOutflowCents: centsSchema,
  inflowCents: centsSchema,
  outflowCents: centsSchema,
  closingCents: centsSchema,
  shortfall: z.boolean(),
});
export type ForecastWeek = z.infer<typeof forecastWeekSchema>;

export const forecastRunSchema = z.object({
  id: idSchema,
  scenario: z.enum(["base", "slow_collections", "revenue_shortfall"]),
  startDate: daySchema,
  endDate: daySchema,
  horizonWeeks: z.number().int(),
  openingCashCents: centsSchema,
  totalInflowCents: centsSchema,
  totalOutflowCents: centsSchema,
  closingCashCents: centsSchema,
  firstShortfallWeek: z.number().int().nullable(),
  shortfallWeekCount: z.number().int(),
  builtAt: instantSchema,
});
export type ForecastRun = z.infer<typeof forecastRunSchema>;

export const forecastSchema = z.object({
  clientId: idSchema,
  runs: z.array(forecastRunSchema),
  selectedRunId: idSchema.nullable(),
  weeks: z.array(forecastWeekSchema),
});
export type Forecast = z.infer<typeof forecastSchema>;

/* ------------------------------------------------------------------------ */
/* Journal                                                                   */
/* ------------------------------------------------------------------------ */

export const journalLineSchema = z.object({
  id: idSchema,
  accountNumber: z.string(),
  accountName: z.string(),
  amountCents: centsSchema,
  memo: z.string(),
});
export const journalEntrySchema = z.object({
  id: idSchema,
  entryDate: daySchema,
  memo: z.string(),
  posted: z.boolean(),
  reversalOf: idSchema.nullable(),
  reversedByEntryId: idSchema.nullable(),
  runType: z.string(),
  createdByRunId: z.string(),
  sourceTable: z.string(),
  debitCents: centsSchema,
  lines: z.array(journalLineSchema),
});
export type JournalEntry = z.infer<typeof journalEntrySchema>;

export const journalSchema = z.object({
  clientId: idSchema,
  period: daySchema,
  entries: z.array(journalEntrySchema),
  postedCount: z.number().int(),
  totalDebitCents: centsSchema,
});
export type Journal = z.infer<typeof journalSchema>;

/* ------------------------------------------------------------------------ */
/* Rules                                                                     */
/* ------------------------------------------------------------------------ */

export const ruleSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int(),
  conditionCount: z.number().int(),
  conditions: z.array(z.unknown()),
  targetCategoryId: z.string(),
  targetCategoryName: z.string().nullable(),
  scopeKind: z.enum(["client", "firm_library"]),
  isActive: z.boolean(),
  acceptedCount: z.number().int(),
  rejectedCount: z.number().int(),
  autoPostEnabled: z.boolean(),
  autoPostCeilingCents: centsSchema,
  version: z.number().int(),
});
export type Rule = z.infer<typeof ruleSchema>;

export const rulesSchema = z.object({
  clientId: idSchema,
  items: z.array(ruleSchema),
  autoPostCount: z.number().int(),
});
export type Rules = z.infer<typeof rulesSchema>;

export const categorySchema = z.object({
  id: z.string(),
  version: z.number().int(),
  name: z.string(),
  accountNumber: z.string(),
  normalSide: z.enum(["debit", "credit"]),
  taxTreatment: z.enum([
    "deductible",
    "meals_50",
    "nondeductible",
    "owner_draw",
    "owner_contribution",
    "personal",
    "capital",
    "transfer",
    "not_applicable",
  ]),
  class1099: z.enum(["none", "nec", "misc_rent", "misc_other", "attorney"]),
  requiresReceiptOverCents: centsSchema.nullable(),
  requiresClass: z.boolean(),
  capitalizeOverCents: centsSchema.nullable(),
  restrictionRelevant: z.boolean(),
  isActive: z.boolean(),
});
export type Category = z.infer<typeof categorySchema>;

export const categoriesSchema = z.object({
  clientId: idSchema,
  items: z.array(categorySchema),
});
export type Categories = z.infer<typeof categoriesSchema>;

/** Audit fix (problem 8): customers/vendors had no screen at all. */
export const customerSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  name: z.string(),
  isActive: z.boolean(),
  lateFeeEnabled: z.boolean(),
  annualizedRateBp: z.number().int().nullable(),
  graceDays: z.number().int().nullable(),
  doNotPursue: z.boolean(),
});
export type Customer = z.infer<typeof customerSchema>;

export const customersSchema = z.object({
  clientId: idSchema,
  items: z.array(customerSchema),
});
export type Customers = z.infer<typeof customersSchema>;

export const vendorSchema = z.object({
  id: z.string(),
  legalName: z.string(),
  isActive: z.boolean(),
  entityType: z.enum([
    "individual",
    "sole_proprietor",
    "partnership",
    "llc",
    "c_corporation",
    "s_corporation",
    "government",
    "tax_exempt",
    "unknown",
  ]),
  w9OnFile: z.boolean(),
  w9ExpiresOn: z.string().nullable(),
  earlyDiscountRule: z.enum(["purchase_discount_income", "vendor_credit"]).nullable(),
});
export type Vendor = z.infer<typeof vendorSchema>;

export const vendorsSchema = z.object({
  clientId: idSchema,
  items: z.array(vendorSchema),
});
export type Vendors = z.infer<typeof vendorsSchema>;

/** Audit fix (problem 8): invoices, credit memos, and bills had no screen. */
export const invoiceSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  invoiceNumber: z.string(),
  invoiceDate: z.string(),
  dueDate: z.string(),
  originalAmountCents: centsSchema,
  taxCents: centsSchema,
  appliedPaymentsCents: centsSchema,
  appliedCreditsCents: centsSchema,
  writtenOffCents: centsSchema,
  status: z.enum(["draft", "posted", "paid", "void", "written_off"]),
  isLateFee: z.boolean(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const creditMemoSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  memoNumber: z.string(),
  memoDate: z.string(),
  amountCents: centsSchema,
  appliedCents: centsSchema,
  status: z.enum(["open", "applied", "void"]),
});
export type CreditMemo = z.infer<typeof creditMemoSchema>;

export const invoicesSchema = z.object({
  clientId: idSchema,
  invoices: z.array(invoiceSchema),
  creditMemos: z.array(creditMemoSchema),
});
export type Invoices = z.infer<typeof invoicesSchema>;

export const billSchema = z.object({
  id: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  billNumber: z.string(),
  billDate: z.string(),
  dueDate: z.string(),
  originalAmountCents: centsSchema,
  freightCents: centsSchema,
  taxCents: centsSchema,
  paidCents: centsSchema,
  discountTakenCents: centsSchema,
  creditsCents: centsSchema,
  status: z.enum(["draft", "posted", "paid", "void"]),
  onHold: z.boolean(),
  inDispute: z.boolean(),
});
export type Bill = z.infer<typeof billSchema>;

export const billsSchema = z.object({
  clientId: idSchema,
  items: z.array(billSchema),
});
export type Bills = z.infer<typeof billsSchema>;

/**
 * Audit fix (problem 8): payroll had no screen at all. PAY-APPROVE-RUN
 * never disburses (doc 05 D5) -- it only reviews a register the provider
 * produced, so there is no payroll amount entry here, only approval.
 */
export const payRunSchema = z.object({
  id: z.string(),
  providerName: z.string(),
  /** The accounting period this approval was raised against, distinct from the pay period dates below. PAY-POST-REGISTER posts under this exact period. */
  periodStart: z.string(),
  payPeriodStart: z.string(),
  payPeriodEnd: z.string(),
  payDate: z.string(),
  employeeCount: z.number().int().nullable(),
  grossCents: centsSchema,
  employerTaxCents: centsSchema,
  employeeWithholdingCents: centsSchema,
  netCents: centsSchema,
  status: z.enum(["approved", "posted"]),
  approvedAt: z.string(),
});
export type PayRun = z.infer<typeof payRunSchema>;

export const payRunsSchema = z.object({
  clientId: idSchema,
  items: z.array(payRunSchema),
});
export type PayRuns = z.infer<typeof payRunsSchema>;

/**
 * Audit fix (problem 8): neither the CPA handoff nor the client export had
 * a screen. Both are vault-locked archive artifacts, so neither row is
 * ever edited or deleted here -- only built.
 */
export const cpaHandoffSchema = z.object({
  id: z.string(),
  taxYear: z.number().int(),
  periodStart: z.string(),
  periodEnd: z.string(),
  scopeKind: z.enum(["period", "fiscal_year"]),
  reportingBasis: z.enum(["accrual", "cash", "both"]),
  artifactCount: z.number().int(),
  openItemCount: z.number().int(),
  builtAt: z.string(),
});
export type CpaHandoff = z.infer<typeof cpaHandoffSchema>;

export const cpaHandoffsSchema = z.object({
  clientId: idSchema,
  items: z.array(cpaHandoffSchema),
});
export type CpaHandoffs = z.infer<typeof cpaHandoffsSchema>;

export const offboardExportSchema = z.object({
  id: z.string(),
  requestedOn: z.string(),
  dueOn: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  fileCount: z.number().int(),
  documentCount: z.number().int(),
  totalRowCount: z.number().int(),
  builtAt: z.string(),
});
export type OffboardExport = z.infer<typeof offboardExportSchema>;

export const offboardExportsSchema = z.object({
  clientId: idSchema,
  items: z.array(offboardExportSchema),
});
export type OffboardExports = z.infer<typeof offboardExportsSchema>;

export const recurringSplitSchema = z.object({
  id: z.string(),
  accountNumber: z.string(),
  categoryId: z.string(),
  fixedAmountCents: centsSchema.nullable(),
  percentBps: z.number().int().nullable(),
  isRemainder: z.boolean(),
  memo: z.string().nullable(),
});
export type RecurringSplit = z.infer<typeof recurringSplitSchema>;

export const recurringTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  cadence: z.enum(["weekly", "semi_monthly", "monthly", "quarterly", "semi_annual", "annual"]).nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  postingDateRule: z.enum(["period_end", "day_n"]),
  dayOfMonth: z.number().int().nullable(),
  driverAmountCents: centsSchema.nullable(),
  entryMemoTemplate: z.string().nullable(),
  isActive: z.boolean(),
  splits: z.array(recurringSplitSchema),
});
export type RecurringTemplate = z.infer<typeof recurringTemplateSchema>;

export const recurringTemplatesSchema = z.object({
  clientId: idSchema,
  items: z.array(recurringTemplateSchema),
});
export type RecurringTemplates = z.infer<typeof recurringTemplatesSchema>;

/* ------------------------------------------------------------------------ */
/* Tax forms, the 1099 compilation                                           */
/* ------------------------------------------------------------------------ */

export const taxDataSetSchema = z.object({
  id: idSchema,
  taxYear: z.number().int(),
  thresholdCents: centsSchema,
  payeeCount: z.number().int(),
  reportableCount: z.number().int(),
  approachingCount: z.number().int(),
  excludedCount: z.number().int(),
  backupWithholdingCount: z.number().int(),
  reportableTotalCents: centsSchema,
  excludedCardTotalCents: centsSchema,
  handoffStatement: z.string(),
  builtAt: instantSchema,
});
export const taxDataLineSchema = z.object({
  id: idSchema,
  payeeName: z.string(),
  formCode: z.string(),
  boxCode: z.string(),
  grossPaidCents: centsSchema,
  excludedCardCents: centsSchema,
  reportableCents: centsSchema,
  state: z.enum(["reportable", "approaching_threshold"]),
  w9State: z.string(),
  backupWithholdingRequired: z.boolean(),
  tinLast4: z.string().nullable(),
  reason: z.string(),
});
export const w9StateSchema = z.object({
  id: idSchema,
  vendorName: z.string(),
  state: z.enum(["not_requested", "requested", "received", "on_file", "expired"]),
  requestedOn: daySchema.nullable(),
  receivedOn: daySchema.nullable(),
  expiresOn: daySchema.nullable(),
  ageDays: z.number().int(),
  escalation: z.enum(["none", "lead"]),
  detail: z.string(),
});
export const taxFormsSchema = z.object({
  clientId: idSchema,
  taxYear: z.number().int(),
  threshold: z.object({ thresholdCents: centsSchema, effectiveFrom: daySchema, sourceNote: z.string() }).nullable(),
  dataSets: z.array(taxDataSetSchema),
  selectedDataSetId: idSchema.nullable(),
  lines: z.array(taxDataLineSchema),
  w9: z.array(w9StateSchema),
});
export type TaxForms = z.infer<typeof taxFormsSchema>;
export type TaxDataLine = z.infer<typeof taxDataLineSchema>;
export type W9State = z.infer<typeof w9StateSchema>;

/* ------------------------------------------------------------------------ */
/* Substantiation                                                            */
/* ------------------------------------------------------------------------ */

export const substantiationRecordSchema = z.object({
  id: idSchema,
  kind: z.enum(["inventory_count", "payroll_register", "other"]),
  accountNumber: z.string(),
  accountName: z.string(),
  supportedBalanceCents: centsSchema,
  sourceRef: z.string().nullable(),
  preparedOn: daySchema.nullable(),
});
export const documentationExceptionSchema = z.object({
  id: idSchema,
  transactionId: idSchema,
  kind: z.enum(["missing_class", "missing_receipt"]),
  categoryId: z.string(),
  categoryName: z.string().nullable(),
  detail: z.string(),
  status: z.enum(["open", "resolved"]),
  openedAt: instantSchema,
});
export const substantiationSchema = z.object({
  clientId: idSchema,
  period: daySchema,
  records: z.array(substantiationRecordSchema),
  exceptions: z.array(documentationExceptionSchema),
  openExceptions: z.number().int(),
  tieouts: z.array(tieoutSchema),
});
export type Substantiation = z.infer<typeof substantiationSchema>;
export type SubstantiationRecord = z.infer<typeof substantiationRecordSchema>;
export type DocumentationException = z.infer<typeof documentationExceptionSchema>;

/* ------------------------------------------------------------------------ */
/* Report package and narrative                                              */
/* ------------------------------------------------------------------------ */

export const reportSectionSchema = z.object({
  id: idSchema,
  sequence: z.number().int(),
  sectionCode: z.string(),
  sectionTitle: z.string(),
  status: z.enum(["rendered", "omitted"]),
  omissionReason: z.string().nullable(),
  bannerText: z.string().nullable(),
  lines: z.array(
    z.object({ label: z.string(), accountNumber: z.string().nullable(), amountCents: centsSchema, comparisonCents: centsSchema.nullable(), note: z.string().nullable() }),
  ),
});
export const reportPackageSchema = z.object({
  id: idSchema,
  period: daySchema,
  basis: z.enum(["accrual", "cash"]),
  comparisonBasis: z.string(),
  comparisonAvailable: z.boolean(),
  comparisonNote: z.string(),
  state: z.enum(["draft", "superseded", "released"]),
  watermark: z.string().nullable(),
  closedWithExceptions: z.boolean(),
  exceptionBanner: z.string().nullable(),
  sectionCount: z.number().int(),
  omissionCount: z.number().int(),
  builtAt: instantSchema,
});
export const reportPackagesSchema = z.object({
  clientId: idSchema,
  period: daySchema,
  packages: z.array(reportPackageSchema),
  selectedPackageId: idSchema.nullable(),
  sections: z.array(reportSectionSchema),
});
export type ReportPackages = z.infer<typeof reportPackagesSchema>;
export type ReportSection = z.infer<typeof reportSectionSchema>;
export type ReportPackage = z.infer<typeof reportPackageSchema>;

/* ------------------------------------------------------------------------ */
/* Group consolidation                                                       */
/* ------------------------------------------------------------------------ */

export const entityGroupMemberSchema = z.object({
  clientId: idSchema,
  clientName: z.string(),
});
export const entityGroupSchema = z.object({
  id: idSchema,
  name: z.string(),
  archivedAt: instantSchema.nullable(),
  members: z.array(entityGroupMemberSchema),
});
export const entityGroupsSchema = z.object({
  items: z.array(entityGroupSchema),
});
export type EntityGroup = z.infer<typeof entityGroupSchema>;
export type EntityGroupMember = z.infer<typeof entityGroupMemberSchema>;
export type EntityGroups = z.infer<typeof entityGroupsSchema>;

/** Mirrors reportPackageSchema with memberCount in place of a single client. */
export const consolidatedPackageSchema = z.object({
  id: idSchema,
  period: daySchema,
  basis: z.enum(["accrual", "cash"]),
  comparisonBasis: z.string(),
  comparisonAvailable: z.boolean(),
  comparisonNote: z.string(),
  state: z.enum(["draft", "superseded"]),
  watermark: z.string().nullable(),
  closedWithExceptions: z.boolean(),
  exceptionBanner: z.string().nullable(),
  memberCount: z.number().int(),
  sectionCount: z.number().int(),
  omissionCount: z.number().int(),
  builtAt: instantSchema,
});
export const consolidatedPackagesSchema = z.object({
  groupId: idSchema,
  period: daySchema,
  packages: z.array(consolidatedPackageSchema),
  selectedPackageId: idSchema.nullable(),
  sections: z.array(reportSectionSchema),
});
export type ConsolidatedPackages = z.infer<typeof consolidatedPackagesSchema>;
export type ConsolidatedPackage = z.infer<typeof consolidatedPackageSchema>;

export const narrativeSchema = z.object({
  id: idSchema,
  period: daySchema,
  audience: z.enum(["owner", "lender"]),
  comparisonBasis: z.string(),
  state: z.enum(["draft", "released"]),
  sentenceCount: z.number().int(),
  droppedCount: z.number().int(),
  bodyText: z.string(),
  sentences: z.array(z.object({ sectionCode: z.string(), triggerCode: z.string(), priority: z.number(), text: z.string() })),
  manualEdit: z.boolean(),
  composedAt: instantSchema,
});
export const narrativesSchema = z.object({
  clientId: idSchema,
  period: daySchema,
  items: z.array(narrativeSchema),
});
export type Narratives = z.infer<typeof narrativesSchema>;
export type Narrative = z.infer<typeof narrativeSchema>;

/* ------------------------------------------------------------------------ */
/* Firm team and workload board                                              */
/* ------------------------------------------------------------------------ */

/** One firm scoped membership, read from tenancy.memberships and users. */
export const firmMemberSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  email: z.string(),
  role: z.string(),
});
export type FirmMember = z.infer<typeof firmMemberSchema>;

export const firmTeamSchema = z.object({
  items: z.array(firmMemberSchema),
});
export type FirmTeam = z.infer<typeof firmTeamSchema>;

/** One practice task across every client, for the board. */
export const firmTaskSchema = z.object({
  id: idSchema,
  clientId: idSchema,
  clientName: z.string(),
  periodStart: daySchema,
  catalogCode: z.string(),
  title: z.string(),
  kind: z.enum(["checklist", "deadline", "gate_target"]),
  role: z.enum(["preparer", "reviewer"]),
  dueDate: daySchema,
  state: z.enum(["open", "blocked", "complete"]),
  blockedByCode: z.string().nullable(),
  assigneeId: z.string().nullable(),
  escalationRung: z.string(),
  completedOn: daySchema.nullable(),
  manualOverride: z.boolean(),
});
export type FirmTask = z.infer<typeof firmTaskSchema>;

export const firmTasksSchema = z.object({
  period: daySchema,
  items: z.array(firmTaskSchema),
});
export type FirmTasks = z.infer<typeof firmTasksSchema>;

export const updateTaskBodySchema = z
  .object({
    state: z.enum(["open", "complete"]).optional(),
    assigneeId: z.string().min(1).nullable().optional(),
  })
  .refine((b) => b.state !== undefined || b.assigneeId !== undefined, { message: "state or assigneeId is required" });
export type UpdateTaskBody = z.infer<typeof updateTaskBodySchema>;

/* ------------------------------------------------------------------------ */
/* Client setup: bank accounts and mapping profiles                          */
/* ------------------------------------------------------------------------ */

export const setupBankAccountSchema = z.object({
  id: idSchema,
  accountNumber: z.string(),
  nickname: z.string(),
  kind: z.enum(["bank", "card"]),
  isProcessorDestination: z.boolean(),
});
export type SetupBankAccount = z.infer<typeof setupBankAccountSchema>;

export const setupProfileColumnSchema = z.object({
  sourceIndex: z.number().int(),
  sourceName: z.string(),
  canonicalField: z.string(),
  sampleValue: z.string(),
});
export type SetupProfileColumn = z.infer<typeof setupProfileColumnSchema>;

export const setupMappingProfileSchema = z.object({
  id: idSchema,
  version: z.number().int(),
  institutionName: z.string(),
  accountNumber: z.string(),
  fileFormat: z.enum(["csv", "xlsx"]),
  headerRowNumber: z.number().int(),
  skipRows: z.number().int(),
  dateColumn: z.string(),
  dateFormat: z.string(),
  descriptionColumn: z.string(),
  amountColumn: z.string().nullable(),
  debitColumn: z.string().nullable(),
  creditColumn: z.string().nullable(),
  signConvention: z.string(),
  currency: z.string(),
  columns: z.array(setupProfileColumnSchema),
});
export type SetupMappingProfile = z.infer<typeof setupMappingProfileSchema>;

/** Null means no ledger.client_policies row exists yet, i.e. every default applies. */
export const setupClientPolicySchema = z.object({
  functionalCurrency: z.string(),
  capitalizeOverCents: centsSchema.nullable(),
  grossAtSaleTime: z.boolean(),
  cleanupEngagement: z.boolean(),
  entityKind: z.enum(["for_profit", "nonprofit"]),
  retainedEarningsAccount: z.string().nullable(),
  netAssetsWithoutRestrictionsAccount: z.string().nullable(),
  netAssetsWithRestrictionsAccount: z.string().nullable(),
  fiscalYearEndMonth: z.number().int(),
});
export type SetupClientPolicy = z.infer<typeof setupClientPolicySchema>;

/**
 * Null means no subledger.arap_policies row exists yet. Only the fields a
 * firm actually sets up front -- the rest of the 26-field policy stays at
 * CFG-CREATE-ARAP-POLICY's own defaults until something needs to change them.
 */
export const setupArapPolicySchema = z.object({
  arControlAccount: z.string(),
  arClearingAccount: z.string(),
  apControlAccount: z.string(),
  apClearingAccount: z.string(),
  salesTaxAccount: z.string().nullable(),
  lateFeeRevenueAccount: z.string().nullable(),
  graceDays: z.number().int(),
  lateFeeMinimumCents: centsSchema,
});
export type SetupArapPolicy = z.infer<typeof setupArapPolicySchema>;

export const clientSetupSchema = z.object({
  clientId: idSchema,
  bankAccounts: z.array(setupBankAccountSchema),
  mappingProfiles: z.array(setupMappingProfileSchema),
  tasks: z.array(firmTaskSchema),
  /** False until object storage exists. The upload screen reads it. */
  uploadsConfigured: z.boolean(),
  policy: setupClientPolicySchema.nullable(),
  arapPolicy: setupArapPolicySchema.nullable(),
});
export type ClientSetup = z.infer<typeof clientSetupSchema>;
