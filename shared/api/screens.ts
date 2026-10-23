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
