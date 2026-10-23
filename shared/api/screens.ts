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
