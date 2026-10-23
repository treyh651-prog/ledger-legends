import { useEffect, useMemo } from "react";
import type { ClientSummary } from "@shared/api";
import { useApp } from "@/store";
import { useClients } from "@/api";
import { isUuid } from "@/lib/period";

/** Months as YYYY-MM, oldest first, from `from` through `to` inclusive. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ty, tm] = to.slice(0, 7).split("-").map(Number);
  let guard = 0;
  while ((y < ty || (y === ty && m <= tm)) && guard < 240) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    guard += 1;
  }
  return out;
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** The month a client's header should open on: its open period, else the current month. */
export function defaultPeriodFor(client: ClientSummary | null | undefined): string {
  if (client?.openPeriod) return client.openPeriod.slice(0, 7);
  if (client?.latestClosedPeriod) return client.latestClosedPeriod.slice(0, 7);
  return currentMonth();
}

/** The months the header offers for a client: from its first known period to the current month. */
export function periodsFor(client: ClientSummary | null | undefined): string[] {
  const now = currentMonth();
  const starts = [client?.openPeriod, client?.latestClosedPeriod, client?.engagement?.startDate]
    .filter((d): d is string => !!d)
    .map((d) => d.slice(0, 7))
    .sort();
  const from = starts[0] ?? now;
  const range = monthRange(from < now ? from : now, now);
  const open = defaultPeriodFor(client);
  if (!range.includes(open)) range.push(open);
  return range;
}

/**
 * The client the firm plane works on, from GET /api/firm/clients. The store
 * keeps only the chosen id; this hook makes sure the id names a client the API
 * knows and lands on the first one otherwise.
 */
export function useActiveClient() {
  const { activeClientId, setActiveClient } = useApp();
  const list = useClients();
  const clients = useMemo(() => list.data?.items ?? [], [list.data]);
  const clientId = useMemo(() => {
    if (isUuid(activeClientId) && clients.some((c) => c.id === activeClientId)) return activeClientId;
    return clients[0]?.id ?? null;
  }, [activeClientId, clients]);
  useEffect(() => {
    if (clientId && clientId !== activeClientId) setActiveClient(clientId);
  }, [clientId, activeClientId, setActiveClient]);
  const client = useMemo(() => clients.find((c) => c.id === clientId) ?? null, [clients, clientId]);
  return {
    clients,
    client,
    clientId,
    hasClients: clients.length > 0,
    loading: list.isPending,
    error: list.isError ? list.error : null,
    retry: () => void list.refetch(),
  };
}
