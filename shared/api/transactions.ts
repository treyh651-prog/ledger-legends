/**
 * The transaction register, paged and filtered.
 */

import { z } from "zod";
import { centsSchema, daySchema, idSchema, pageQuerySchema, pageSchema } from "./common";

export const transactionSchema = z.object({
  id: idSchema,
  bankAccountId: idSchema,
  accountNumber: z.string(),
  postedDate: daySchema,
  amountCents: centsSchema,
  description: z.string(),
  normalizedVendor: z.string().nullable(),
  categoryId: z.string().nullable(),
  /** The category's name, joined for the screens. Null when uncategorized. */
  categoryName: z.string().nullable(),
  cascadeLevel: z.number().int().nullable(),
  manualOverride: z.boolean(),
  status: z.string(),
  voided: z.boolean(),
  /** Whether the bank has cleared this row. Surfaced so a void dialog can warn before voiding a cleared transaction. */
  cleared: z.boolean(),
  /** Set when TXN-VOID-AND-REISSUE replaced this row; points at the replacement. */
  voidOfTransactionId: idSchema.nullable(),
  /** Set when this row is a TXN-VOID-AND-REISSUE replacement; points at the transaction it corrects. */
  reissueOfTransactionId: idSchema.nullable(),
  /** The rule that coded this row, if any. Null for every other cascade level. */
  ruleId: z.string().nullable(),
  /** The rule's name, joined for the screens. Null when ruleId is null. */
  ruleName: z.string().nullable(),
  /** Set by TXN-ACCEPT-CODING or TXN-RECODE. Null while a rule-coded row is still pending review. */
  ruleReviewedAt: z.string().nullable(),
  ruleReviewOutcome: z.enum(["accepted", "rejected"]).nullable(),
});
export type Transaction = z.infer<typeof transactionSchema>;

export const transactionQuerySchema = pageQuerySchema.extend({
  from: daySchema.optional(),
  to: daySchema.optional(),
  bankAccountId: idSchema.optional(),
  /** Case insensitive substring over description and normalized vendor. */
  search: z.string().trim().max(200).optional(),
  uncategorized: z.coerce.boolean().optional(),
  /** Rule-coded, not voided, not yet reviewed, and not already auto-posted under an earned promotion. */
  pendingRuleReview: z.coerce.boolean().optional(),
});
export type TransactionQuery = z.infer<typeof transactionQuerySchema>;

export const transactionPageSchema = pageSchema(transactionSchema);
export type TransactionPage = z.infer<typeof transactionPageSchema>;
