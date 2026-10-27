/**
 * Clients, as the firm sees them.
 *
 * A client row lives in tenancy.clients and its engagement in
 * tenancy.engagements. The summary adds the counts a list screen shows, each
 * read from the table that owns it, so a status here is never a stored field
 * that could go stale.
 */

import { z } from "zod";
import { TIER_ORDER } from "../tiers";
import { centsSchema, daySchema, idSchema, instantSchema } from "./common";

export const INDUSTRIES = [
  "services",
  "product",
  "contractor",
  "restaurant",
  "real_estate",
  "nonprofit",
] as const;
export const industrySchema = z.enum(INDUSTRIES);
export type Industry = z.infer<typeof industrySchema>;

export const ENTITY_TYPES = ["Sole Prop", "Partnership", "LLC", "S Corp", "C Corp", "Nonprofit"] as const;
export const entityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof entityTypeSchema>;

export const SCOPE_KEYS = [
  "monthly_close",
  "ap",
  "ar",
  "payroll_je",
  "sales_tax",
  "form_1099",
  "cleanup",
  "inventory",
  "fixed_assets",
  "loans",
  "prepaids",
] as const;
export const scopeKeySchema = z.enum(SCOPE_KEYS);
export type ScopeKey = z.infer<typeof scopeKeySchema>;

export const tierIdSchema = z.enum(TIER_ORDER as unknown as [string, ...string[]]);

export const clientStatusSchema = z.enum(["onboarding", "active", "archived"]);
export type ClientStatus = z.infer<typeof clientStatusSchema>;

export const engagementStatusSchema = z.enum(["draft", "sent", "signed", "active", "terminated"]);

/**
 * Whether the client is current on what they owe the firm for the
 * engagement itself. Not a billing subsystem (migration 0032): no amounts,
 * no invoice rows, no payment history.
 */
export const billingStatusSchema = z.enum(["current", "past_due"]);

export const clientSummarySchema = z.object({
  id: idSchema,
  firmId: idSchema,
  name: z.string(),
  entityType: z.string(),
  isNonprofit: z.boolean(),
  fiscalYearEndMonth: z.number().int().min(1).max(12),
  functionalCurrency: z.string(),
  chartTemplateId: z.string().nullable(),
  scopeKeys: z.array(z.string()),
  onboardedAt: instantSchema.nullable(),
  archivedAt: instantSchema.nullable(),
  status: clientStatusSchema,
  engagement: z
    .object({
      id: idSchema,
      status: engagementStatusSchema,
      serviceLevel: z.string(),
      reportingBasis: z.string(),
      startDate: daySchema,
      signedAt: instantSchema.nullable(),
      billingStatus: billingStatusSchema,
    })
    .nullable(),
  /** Counts read from the owning tables. */
  openRequests: z.number().int().min(0),
  openSuspense: z.number().int().min(0),
  openTasks: z.number().int().min(0),
  chartAccounts: z.number().int().min(0),
  latestClosedPeriod: daySchema.nullable(),
  openPeriod: daySchema.nullable(),
  lastRunAt: instantSchema.nullable(),
});
export type ClientSummary = z.infer<typeof clientSummarySchema>;

export const clientListSchema = z.object({
  items: z.array(clientSummarySchema),
});
export type ClientList = z.infer<typeof clientListSchema>;

const extraAccountSchema = z.object({
  accountNumber: z.string().regex(/^[0-9]{4}$/),
  name: z.string().min(1),
  normalSide: z.enum(["debit", "credit"]),
});

/**
 * Everything the intake runs need, and nothing a run would have to invent.
 * The first period is the month the start date falls in unless the body says
 * otherwise.
 */
export const createClientBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  entityType: entityTypeSchema,
  industry: industrySchema,
  isNonprofit: z.boolean().default(false),
  fiscalYearEndMonth: z.number().int().min(1).max(12).default(12),
  scopeKeys: z.array(scopeKeySchema).default(["monthly_close"]),
  serviceLevel: tierIdSchema.default("ledger"),
  reportingBasis: z.enum(["accrual", "cash", "both"]).default("accrual"),
  startDate: daySchema,
  period: daySchema.optional(),
  monthlyFeeCents: centsSchema.min(0).default(0),
  excludeAccountNumbers: z.array(z.string().regex(/^[0-9]{4}$/)).default([]),
  addAccounts: z.array(extraAccountSchema).default([]),
});
export type CreateClientBody = z.infer<typeof createClientBodySchema>;
export type CreateClientInput = z.input<typeof createClientBodySchema>;
