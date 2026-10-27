/**
 * The portal, as the client sees it and as the firm sees it on the client's
 * behalf. Every read here is scoped to one client, and the reads a tier can
 * exclude are guarded on the server by requireFeature.
 */

import { z } from "zod";
import { TIER_ORDER } from "../tiers";
import { centsSchema, daySchema, idSchema, instantSchema } from "./common";
import { billingStatusSchema } from "./clients";

export const portalTierSchema = z.enum(TIER_ORDER as unknown as [string, ...string[]]);

export const portalRequestSchema = z.object({
  id: idSchema,
  kind: z.enum(["document", "transaction"]),
  subject: z.string(),
  detail: z.string(),
  status: z.enum(["open", "satisfied", "waived"]),
  openedOn: daySchema,
  dueOn: daySchema.nullable(),
  accountNumber: z.string().nullable(),
});
export type PortalRequest = z.infer<typeof portalRequestSchema>;

export const portalHomeSchema = z.object({
  client: z.object({
    id: idSchema,
    name: z.string(),
    entityType: z.string(),
    fiscalYearEndMonth: z.number().int(),
  }),
  tier: portalTierSchema,
  tierName: z.string(),
  /** Feature keys the engagement includes, from the entitlement view. */
  features: z.array(z.string()),
  engagementStatus: z.string().nullable(),
  /** The only thing the client's own portal may know about billing: are they current. */
  billingStatus: billingStatusSchema.nullable(),
  closedPeriods: z.array(daySchema),
  openPeriod: daySchema.nullable(),
  latestClosedPeriod: daySchema.nullable(),
  /** True when at least one posted entry exists. */
  hasBooks: z.boolean(),
  openRequests: z.array(portalRequestSchema),
  lastRunAt: instantSchema.nullable(),
});
export type PortalHome = z.infer<typeof portalHomeSchema>;

export const statementLineSchema = z.object({
  accountNumber: z.string(),
  name: z.string(),
  /** Signed, debit positive, as the ledger stores it. */
  balanceCents: centsSchema,
  /** The balance shown on the statement, sign adjusted to the normal side. */
  presentedCents: centsSchema,
});
export type StatementLine = z.infer<typeof statementLineSchema>;

export const statementSectionSchema = z.object({
  code: z.string(),
  title: z.string(),
  lines: z.array(statementLineSchema),
  totalCents: centsSchema,
});
export type StatementSection = z.infer<typeof statementSectionSchema>;

export const portalStatementsSchema = z.object({
  clientId: idSchema,
  period: daySchema,
  periodEnd: daySchema,
  periodStatus: z.enum(["locked", "open", "none"]),
  /** Periods the tier allows the client to open. Locked ones for every tier. */
  visiblePeriods: z.array(daySchema),
  incomeStatement: z.array(statementSectionSchema),
  netIncomeCents: centsSchema,
  balanceSheet: z.array(statementSectionSchema),
  totalAssetsCents: centsSchema,
  totalLiabilitiesAndEquityCents: centsSchema,
  /** False when the trial balance does not foot, which the screen must say. */
  foots: z.boolean(),
  entryCount: z.number().int(),
});
export type PortalStatements = z.infer<typeof portalStatementsSchema>;
