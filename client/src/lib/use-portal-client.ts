import { useEffect, useMemo } from "react";
import { useApp } from "@/store";
import { useAuth } from "@/lib/auth";
import { useClients } from "@/api";
import { isUuid } from "@/lib/period";

/**
 * Which client the portal screens read. A client scoped person has exactly
 * the clients in their memberships. A firm person gets the active client
 * from the header when the API knows it, else the first client in the book.
 */
export function usePortalClient(): { clientId: string | null; loading: boolean; error: unknown; retry: () => void; hasClients: boolean } {
  const { activeClientId, setActiveClient } = useApp();
  const auth = useAuth();
  const firmScoped = auth.status === "off" || (auth.me?.memberships.some((m) => m.scope === "firm") ?? false);
  const memberClientIds = useMemo(
    () => (auth.me?.memberships ?? []).filter((m) => m.scope === "client" && m.clientId).map((m) => m.clientId as string),
    [auth.me],
  );
  const list = useClients();
  const apiIds = useMemo(() => (list.data?.items ?? []).map((c) => c.id), [list.data]);
  const known = firmScoped ? apiIds : memberClientIds;

  const clientId = useMemo(() => {
    if (isUuid(activeClientId) && known.includes(activeClientId)) return activeClientId;
    return known[0] ?? null;
  }, [activeClientId, known]);

  useEffect(() => {
    if (clientId && clientId !== activeClientId) setActiveClient(clientId);
  }, [clientId, activeClientId, setActiveClient]);

  // A client scoped person cannot list the firm's clients; that error is not theirs to see.
  const loading = firmScoped ? list.isPending : false;
  const error = firmScoped && list.isError ? list.error : null;
  return { clientId, loading, error, retry: () => void list.refetch(), hasClients: known.length > 0 };
}
