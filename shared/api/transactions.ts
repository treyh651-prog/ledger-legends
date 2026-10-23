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
});
export type Transaction = z.infer<typeof transactionSchema>;

export const transactionQuerySchema = pageQuerySchema.extend({
  from: daySchema.optional(),
  to: daySchema.optional(),
  bankAccountId: idSchema.optional(),
  /** Case insensitive substring over description and normalized vendor. */
  search: z.string().trim().max(200).optional(),
  uncategorized: z.coerce.boolean().optional(),
});
export type TransactionQuery = z.infer<typeof transactionQuerySchema>;

export const transactionPageSchema = pageSchema(transactionSchema);
export type TransactionPage = z.infer<typeof transactionPageSchema>;
