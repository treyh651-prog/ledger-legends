import { useMemo } from "react";
import { useApp } from "@/store";
import {
  closeFor,
  closedPeriods,
  entitlementFor,
  entitlementHistory,
  groupFor,
  groupMembers,
  hasFeature,
  latestClosedPeriod,
  openPeriod as openPeriodOf,
  tierMeta,
  visiblePeriods,
  type Entitlement,
  type FeatureId,
} from "@/data/entitlement";
import type { Client, EntityGroup, PeriodClose, TierId } from "@/data/types";
import type { Dataset } from "@/data/seed";

export interface PortalContext {
  ds: Dataset;
  client: Client;
  clientId: string;
  hasClients: boolean;
  /** True when this client has anything posted at all. */
  hasBooks: boolean;
  tier: TierId;
  tierName: string;
  entitlement: Entitlement;
  history: ReturnType<typeof entitlementHistory>;
  can: (id: FeatureId) => boolean;
  closedPeriods: string[];
  openPeriod: string | null;
  visiblePeriods: string[];
  /** The period portal pages should read. Ledger clients land on the last closed month. */
  period: string | null;
  /** The period picked in the header, which may be ahead of what this tier can open. */
  requestedPeriod: string;
  /** True when the header period was pulled back because the month is not closed yet. */
  periodHeldBack: boolean;
  close: PeriodClose | undefined;
  group: EntityGroup | undefined;
  members: Client[];
  memberIds: string[];
}

export function usePortal(): PortalContext {
  const { ds, activeClient, activeClientId, period, hasClients } = useApp();

  return useMemo(() => {
    const entitlement = entitlementFor(ds, activeClientId);
    const tier = entitlement.tier;
    const closed = closedPeriods(ds, activeClientId);
    const open = openPeriodOf(ds, activeClientId);
    const visible = visiblePeriods(ds, activeClientId, tier);
    const canOpen = hasFeature(tier, "open_period");
    let effective: string | null = null;
    let heldBack = false;
    if (visible.includes(period)) {
      effective = period;
    } else if (!canOpen && period === open) {
      effective = latestClosedPeriod(ds, activeClientId);
      heldBack = true;
    } else {
      effective = visible[0] || null;
      heldBack = visible.length > 0 && period !== effective;
    }
    const members = groupMembers(ds, activeClientId);
    return {
      ds,
      client: activeClient,
      clientId: activeClientId,
      hasClients,
      hasBooks: ds.txns.some((t) => t.clientId === activeClientId) || ds.journalEntries.some((j) => j.clientId === activeClientId),
      tier,
      tierName: tierMeta(tier).name,
      entitlement,
      history: entitlementHistory(ds, activeClientId),
      can: (id: FeatureId) => hasFeature(tier, id),
      closedPeriods: closed,
      openPeriod: open,
      visiblePeriods: visible,
      period: effective,
      requestedPeriod: period,
      periodHeldBack: heldBack,
      close: effective ? closeFor(ds, activeClientId, effective) : undefined,
      group: groupFor(ds, activeClientId),
      members,
      memberIds: members.map((c) => c.id),
    };
  }, [ds, activeClient, activeClientId, period, hasClients]);
}
