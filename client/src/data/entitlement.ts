import type { Dataset } from "./seed";
import { CURRENT_PERIOD, PERIODS, TODAY } from "./seed";
import type { EntityGroup, PeriodClose, TierId } from "./types";

/**
 * Portal depth is a bundled property of the engagement (decision D1). There is no
 * subscription, no plan picker, and no payment surface anywhere in this product.
 * Everything here is read only and is checked in the UI layer.
 */

export const TIER_ORDER: TierId[] = ["ledger", "ledger_plus", "legend"];

export interface TierMeta {
  id: TierId;
  name: string;
  tagline: string;
  rank: number;
}

export const TIERS: Record<TierId, TierMeta> = {
  ledger: {
    id: "ledger",
    name: "Ledger",
    tagline: "Clean books, closed monthly, with your records in your hands.",
    rank: 0,
  },
  ledger_plus: {
    id: "ledger_plus",
    name: "Ledger+",
    tagline: "Adds comparison, budget tracking, collections detail, and early numbers.",
    rank: 1,
  },
  legend: {
    id: "legend",
    name: "Legend",
    tagline: "Adds forward looking cash, a written read on the month, and group reporting.",
    rank: 2,
  },
};

export function tierMeta(id: TierId): TierMeta {
  return TIERS[id];
}

export function tierRank(id: TierId): number {
  return TIERS[id].rank;
}

/* ---------------- Feature catalog ---------------- */

export type FeatureId =
  | "statements"
  | "transactions"
  | "documents"
  | "requests"
  | "messages"
  | "compare"
  | "budget"
  | "aging"
  | "open_period"
  | "forecast"
  | "narrative"
  | "scenarios"
  | "consolidation";

export interface FeatureMeta {
  id: FeatureId;
  label: string;
  /** One plain sentence a client would recognize. */
  summary: string;
  minTier: TierId;
  route?: string;
  /** True when the feature is a client's own record set and can never be gated. */
  ownRecords?: boolean;
}

export const FEATURES: FeatureMeta[] = [
  { id: "statements", label: "Financial statements", summary: "Profit and loss, balance sheet, and cash flow for every closed month.", minTier: "ledger", route: "/portal/statements", ownRecords: true },
  { id: "transactions", label: "Your transactions", summary: "Every posted transaction on your accounts with the category we used.", minTier: "ledger", route: "/portal/transactions", ownRecords: true },
  { id: "documents", label: "Documents and upload", summary: "Send us receipts and statements, and keep the file history.", minTier: "ledger", route: "/portal/upload", ownRecords: true },
  { id: "requests", label: "Open requests", summary: "The short list of what we still need from you this month.", minTier: "ledger", route: "/portal/requests", ownRecords: true },
  { id: "messages", label: "Messages", summary: "Talk to the people doing your books, in one thread.", minTier: "ledger", route: "/portal/messages", ownRecords: true },
  { id: "compare", label: "Month over month", summary: "This month against last month, line by line, with the drivers called out.", minTier: "ledger_plus", route: "/portal/compare" },
  { id: "budget", label: "Budget versus actual", summary: "Where spending landed against the plan, by account.", minTier: "ledger_plus", route: "/portal/budget" },
  { id: "aging", label: "AR and AP aging", summary: "Who owes you, who you owe, and how late each one is.", minTier: "ledger_plus", route: "/portal/aging" },
  { id: "open_period", label: "Open period numbers", summary: "The month in progress before it closes, marked as draft.", minTier: "ledger_plus", route: "/portal/open-period" },
  { id: "forecast", label: "Thirteen week cash forecast", summary: "Cash in and cash out by week for the next thirteen weeks.", minTier: "legend", route: "/portal/forecast" },
  { id: "narrative", label: "Period narrative", summary: "A written read on the month from the person who closed it.", minTier: "legend", route: "/portal/narrative" },
  { id: "scenarios", label: "Scenario comparison", summary: "The same forecast under slower collections or a change in spend.", minTier: "legend", route: "/portal/scenarios" },
  { id: "consolidation", label: "Group consolidation", summary: "Two or more entities combined into one set of statements.", minTier: "legend", route: "/portal/entities" },
];

export const FEATURE_BY_ID: Record<FeatureId, FeatureMeta> = Object.fromEntries(
  FEATURES.map((f) => [f.id, f]),
) as Record<FeatureId, FeatureMeta>;

export function featuresForTier(tier: TierId): FeatureMeta[] {
  return FEATURES.filter((f) => tierRank(f.minTier) <= tierRank(tier));
}

export function featuresAtTier(tier: TierId): FeatureMeta[] {
  return FEATURES.filter((f) => f.minTier === tier);
}

export function hasFeature(tier: TierId, id: FeatureId): boolean {
  return tierRank(FEATURE_BY_ID[id].minTier) <= tierRank(tier);
}

/* ---------------- Entitlement lookup ---------------- */

export interface Entitlement {
  tier: TierId;
  effectiveFrom: string;
  reason: string;
  setBy: string;
  /** True when no grant row was found, which means read only defaults apply. */
  fallback: boolean;
}

const DEFAULT_ENTITLEMENT: Entitlement = {
  tier: "ledger",
  effectiveFrom: TODAY,
  reason: "No entitlement grant on file, so the base service level applies.",
  setBy: "System default",
  fallback: true,
};

/** Effective dated lookup. The grant in force on asOf wins, latest start first. */
export function entitlementFor(ds: Dataset, clientId: string, asOf: string = TODAY): Entitlement {
  const rows = ds.entitlements
    .filter((g) => g.clientId === clientId)
    .filter((g) => g.effectiveFrom <= asOf && (!g.effectiveTo || g.effectiveTo > asOf))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  const active = rows[0];
  if (!active) return DEFAULT_ENTITLEMENT;
  return {
    tier: active.tierId,
    effectiveFrom: active.effectiveFrom,
    reason: active.reason,
    setBy: active.setBy,
    fallback: false,
  };
}

export function tierFor(ds: Dataset, clientId: string, asOf: string = TODAY): TierId {
  return entitlementFor(ds, clientId, asOf).tier;
}

/** Grant history for one client, oldest first. Shows how the service level moved. */
export function entitlementHistory(ds: Dataset, clientId: string) {
  return ds.entitlements
    .filter((g) => g.clientId === clientId)
    .slice()
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
}

/** The next level up, or null at the top. */
export function nextTier(tier: TierId): TierId | null {
  const i = tierRank(tier);
  return i >= TIER_ORDER.length - 1 ? null : TIER_ORDER[i + 1];
}

/* ---------------- Close state ---------------- */

export function closeFor(ds: Dataset, clientId: string, period: string): PeriodClose | undefined {
  return ds.closes.find((c) => c.clientId === clientId && c.period === period);
}

export function isPeriodClosed(ds: Dataset, clientId: string, period: string): boolean {
  return closeFor(ds, clientId, period)?.state === "closed";
}

export function isPeriodLocked(ds: Dataset, clientId: string, period: string): boolean {
  return closeFor(ds, clientId, period)?.locked === true;
}

/** Closed periods for one client, newest first. */
export function closedPeriods(ds: Dataset, clientId: string): string[] {
  return ds.closes
    .filter((c) => c.clientId === clientId && c.state === "closed")
    .map((c) => c.period)
    .sort()
    .reverse();
}

export function latestClosedPeriod(ds: Dataset, clientId: string): string | null {
  return closedPeriods(ds, clientId)[0] || null;
}

/** The month in progress. Falls back to the seeded current period when nothing is open. */
export function openPeriod(ds: Dataset, clientId: string): string | null {
  const row = ds.closes.filter((c) => c.clientId === clientId && c.state === "open").map((c) => c.period).sort().reverse()[0];
  return row || null;
}

/** Periods a client can open at a given tier. Ledger stops at the last close. */
export function visiblePeriods(ds: Dataset, clientId: string, tier: TierId): string[] {
  const closed = closedPeriods(ds, clientId);
  if (!hasFeature(tier, "open_period")) return closed;
  const open = openPeriod(ds, clientId);
  return open ? [open, ...closed] : closed;
}

/** Period the portal should land on for a tier, or null when there is nothing yet. */
export function defaultPortalPeriod(ds: Dataset, clientId: string, tier: TierId): string | null {
  const list = visiblePeriods(ds, clientId, tier);
  return list[0] || null;
}

export function groupFor(ds: Dataset, clientId: string): EntityGroup | undefined {
  return ds.entityGroups.find((g) => g.memberClientIds.includes(clientId));
}

export function groupMembers(ds: Dataset, clientId: string) {
  const group = groupFor(ds, clientId);
  const ids = group ? group.memberClientIds : [clientId];
  return ds.clients.filter((c) => ids.includes(c.id));
}

/** Kept so period pickers stay in step with the fixtures. */
export const SEED_PERIODS = PERIODS;
export const SEED_CURRENT_PERIOD = CURRENT_PERIOD;
