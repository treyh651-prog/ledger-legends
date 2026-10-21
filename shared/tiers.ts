/**
 * The three service tiers, in one place.
 *
 * The public pricing page at ledgerlegends.pro is the source of truth for
 * what each tier includes. This file carries the page's promises as data so
 * the server, the client and migration 0024 agree on one vocabulary. Server
 * code imports from here. Client code imports from here through
 * client/src/data/entitlement.ts, which re exports this module.
 *
 * Tiers are bundled with the engagement (decision D1). There is no checkout,
 * no plan picker and no payment surface, so nothing in this file carries a
 * price. Pricing belongs to the engagement letter.
 *
 * Payroll and cleanup are add ons on the public page. They are not tiers and
 * they grant no feature. They live in tenancy.engagement_addons.
 *
 * Each feature is listed once, at the lowest tier that includes it.
 * Inclusion at a higher tier is derived from rank, never duplicated. The seed
 * in db/migrations/0024_tiers.sql follows the same rule.
 */

export type TierId = "ledger" | "ledger_plus" | "legend";

/** Lowest rank first. The index in this array is the tier's rank. */
export const TIER_ORDER: readonly TierId[] = ["ledger", "ledger_plus", "legend"] as const;

export interface TierMeta {
  id: TierId;
  name: string;
  rank: number;
  /** The public page's words for the tier, shortened to one line. */
  tagline: string;
  /** Annual revenue band the page uses to place a client, in cents. */
  revenueFloorCents: number;
  /** Null at the top tier, which has no ceiling. */
  revenueCeilingCents: number | null;
}

export const TIERS: Record<TierId, TierMeta> = {
  ledger: {
    id: "ledger",
    name: "Ledger",
    rank: 0,
    tagline:
      "Monthly bank and card reconciliation, expense categorization with bank rules, and monthly financial statements.",
    revenueFloorCents: 0,
    revenueCeilingCents: 100_000_00,
  },
  ledger_plus: {
    id: "ledger_plus",
    name: "Ledger+",
    rank: 1,
    tagline:
      "Everything in Ledger, light AR and AP tracking, a quarterly performance summary, and priority support.",
    revenueFloorCents: 100_000_00,
    revenueCeilingCents: 250_000_00,
  },
  legend: {
    id: "legend",
    name: "Legend",
    rank: 2,
    tagline:
      "Everything in Ledger+, custom reports and KPI dashboards, accrual and loan tracking, a monthly review, and CPA ready books for tax time.",
    revenueFloorCents: 250_000_00,
    revenueCeilingCents: null,
  },
};

export function isTierId(value: unknown): value is TierId {
  return typeof value === "string" && (TIER_ORDER as readonly string[]).includes(value);
}

export function tierMeta(id: TierId): TierMeta {
  return TIERS[id];
}

export function tierRank(id: TierId): number {
  return TIERS[id].rank;
}

/** The next level up, or null at the top. */
export function nextTier(tier: TierId): TierId | null {
  const i = tierRank(tier);
  return i >= TIER_ORDER.length - 1 ? null : TIER_ORDER[i + 1];
}

/* ---------------- Feature catalog ---------------- */

export type FeatureKey =
  // Ledger
  | "statements"
  | "transactions"
  | "documents"
  | "requests"
  | "messages"
  | "reconciliation_status"
  | "bank_rules"
  // Ledger+
  | "aging"
  | "compare"
  | "quarterly_summary"
  | "priority_support"
  // Legend
  | "custom_reports"
  | "budget"
  | "forecast"
  | "narrative"
  | "scenarios"
  | "consolidation"
  | "open_period"
  | "loans"
  | "monthly_review"
  | "cpa_packet";

/** Kept as a name the client code already uses. */
export type FeatureId = FeatureKey;

export interface FeatureMeta {
  id: FeatureKey;
  label: string;
  /** One plain sentence a client would recognize. */
  summary: string;
  /** The lowest tier that includes the feature. */
  minTier: TierId;
  /** Portal route, when the feature is a screen. Deliverables have none. */
  route?: string;
  /** True when the feature is a client's own record set and can never be gated. */
  ownRecords?: boolean;
}

/**
 * The feature map, decided by the pricing page. NOTES entry 211 records the
 * reasoning for each placement. Order here is display order on the tiers
 * screen, so Ledger features come first and each tier's additions follow.
 */
export const FEATURES: readonly FeatureMeta[] = [
  // Ledger: monthly reconciliation, categorization with bank rules, monthly statements.
  { id: "statements", label: "Monthly financial statements", summary: "Profit and loss, balance sheet, and cash flow for every closed month.", minTier: "ledger", route: "/portal/statements", ownRecords: true },
  { id: "transactions", label: "Your transactions", summary: "Every posted transaction on your accounts with the category we used.", minTier: "ledger", route: "/portal/transactions", ownRecords: true },
  { id: "documents", label: "Documents and upload", summary: "Send us receipts and statements, and keep the file history.", minTier: "ledger", route: "/portal/upload", ownRecords: true },
  { id: "requests", label: "Open requests", summary: "The short list of what we still need from you this month.", minTier: "ledger", route: "/portal/requests", ownRecords: true },
  { id: "messages", label: "Messages", summary: "Talk to the people doing your books, in one thread.", minTier: "ledger", route: "/portal/messages", ownRecords: true },
  { id: "reconciliation_status", label: "Monthly reconciliation", summary: "Every bank and card account reconciled each month, with the status shown on your statements.", minTier: "ledger" },
  { id: "bank_rules", label: "Categorization with bank rules", summary: "Expenses categorized by rules written for your accounts, and the rule shown next to the transaction.", minTier: "ledger" },

  // Ledger+: light AR and AP tracking, quarterly performance summary, priority support.
  { id: "aging", label: "AR and AP tracking", summary: "Who owes you, who you owe, and how late each one is.", minTier: "ledger_plus", route: "/portal/aging" },
  { id: "compare", label: "Month over month", summary: "This month against last month, line by line, with the drivers called out.", minTier: "ledger_plus", route: "/portal/compare" },
  { id: "quarterly_summary", label: "Quarterly performance summary", summary: "A written summary of the quarter from the person who closed it, delivered after the quarter's last close.", minTier: "ledger_plus" },
  { id: "priority_support", label: "Priority support", summary: "Your messages go to the front of the queue.", minTier: "ledger_plus" },

  // Legend: custom reports and KPI dashboards, accrual and loan tracking, monthly review, CPA ready books.
  { id: "custom_reports", label: "Custom reports and KPI dashboards", summary: "Reports built for your business. The budget, forecast, narrative and scenario screens are part of this.", minTier: "legend" },
  { id: "budget", label: "Budget versus actual", summary: "Where spending landed against the plan, by account.", minTier: "legend", route: "/portal/budget" },
  { id: "forecast", label: "Thirteen week cash forecast", summary: "Cash in and cash out by week for the next thirteen weeks.", minTier: "legend", route: "/portal/forecast" },
  { id: "narrative", label: "Period narrative", summary: "A written read on the month from the person who closed it.", minTier: "legend", route: "/portal/narrative" },
  { id: "scenarios", label: "Scenario comparison", summary: "The same forecast under slower collections or a change in spend.", minTier: "legend", route: "/portal/scenarios" },
  { id: "consolidation", label: "Group consolidation", summary: "Two or more entities combined into one set of statements.", minTier: "legend", route: "/portal/entities" },
  { id: "open_period", label: "Accrual tracking", summary: "The month in progress before it closes, with accruals shown as draft.", minTier: "legend", route: "/portal/open-period" },
  { id: "loans", label: "Loan tracking", summary: "Each loan's balance, with payments split between principal and interest.", minTier: "legend" },
  { id: "monthly_review", label: "Monthly review", summary: "A scheduled review of the month with the person who closed it.", minTier: "legend" },
  { id: "cpa_packet", label: "CPA ready books", summary: "A packet compiled for your CPA at tax time. We compile the books; we do not prepare tax forms.", minTier: "legend" },
];

export const FEATURE_KEYS: readonly FeatureKey[] = FEATURES.map((f) => f.id);

export const FEATURE_BY_ID: Record<FeatureKey, FeatureMeta> = Object.fromEntries(
  FEATURES.map((f) => [f.id, f]),
) as Record<FeatureKey, FeatureMeta>;

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && value in FEATURE_BY_ID;
}

/** Everything a tier includes, by rank. */
export function featuresForTier(tier: TierId): FeatureMeta[] {
  return FEATURES.filter((f) => tierRank(f.minTier) <= tierRank(tier));
}

/** Only what a tier adds over the one below it. */
export function featuresAtTier(tier: TierId): FeatureMeta[] {
  return FEATURES.filter((f) => f.minTier === tier);
}

/** Pure. True when the tier's rank reaches the feature's lowest tier. */
export function hasFeature(tier: TierId, key: FeatureKey): boolean {
  return tierRank(FEATURE_BY_ID[key].minTier) <= tierRank(tier);
}

/* ---------------- Add ons ---------------- */

export type AddonId = "payroll" | "cleanup";

export const ADDON_ORDER: readonly AddonId[] = ["payroll", "cleanup"] as const;

export interface AddonMeta {
  id: AddonId;
  name: string;
  summary: string;
}

/**
 * Add ons attach to an engagement at any tier. They never grant a feature,
 * and hasFeature never looks at them.
 */
export const ADDONS: Record<AddonId, AddonMeta> = {
  payroll: {
    id: "payroll",
    name: "Payroll",
    summary: "Payroll support through your payroll provider, available at any tier.",
  },
  cleanup: {
    id: "cleanup",
    name: "Cleanup",
    summary: "Catch up and cleanup of prior periods, quoted separately before work starts.",
  },
};

export function isAddonId(value: unknown): value is AddonId {
  return typeof value === "string" && (ADDON_ORDER as readonly string[]).includes(value);
}
