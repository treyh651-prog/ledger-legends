import type { Dataset } from "./seed";
import { CURRENT_PERIOD, PERIODS, TODAY } from "./seed";
import type { EntityGroup, PeriodClose } from "./types";
import { hasFeature, type TierId } from "@shared/tiers";

/**
 * Portal depth is a bundled property of the engagement (decision D1). There is no
 * subscription, no plan picker, and no payment surface anywhere in this product.
 *
 * The tiers, the feature keys and hasFeature live in shared/tiers.ts, which
 * the server imports too. This file re exports them and keeps the helpers
 * that read the in memory dataset. Nothing about a tier is defined here.
 */

export {
  ADDON_ORDER,
  ADDONS,
  FEATURE_BY_ID,
  FEATURE_KEYS,
  FEATURES,
  TIER_ORDER,
  TIERS,
  featuresAtTier,
  featuresForTier,
  hasFeature,
  isAddonId,
  isFeatureKey,
  isTierId,
  nextTier,
  tierMeta,
  tierRank,
} from "@shared/tiers";
export type { AddonId, AddonMeta, FeatureId, FeatureKey, FeatureMeta, TierId, TierMeta } from "@shared/tiers";

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
