import { useQuery } from "@tanstack/react-query";
import type { PortalHome, PortalRequest, PortalStatements, TransactionPage } from "@shared/api";
import { api, toQuery } from "./http";

export const portalKeys = {
  client: (clientId: string) => ["api", "portal", clientId] as const,
  home: (clientId: string) => [...portalKeys.client(clientId), "home"] as const,
  statements: (clientId: string, period: string | null) => [...portalKeys.client(clientId), "statements", period ?? "latest"] as const,
  transactions: (clientId: string, range: string) => [...portalKeys.client(clientId), "transactions", range] as const,
  requests: (clientId: string) => [...portalKeys.client(clientId), "requests"] as const,
};

export function usePortalHome(clientId: string | null) {
  return useQuery({
    queryKey: portalKeys.home(clientId ?? "none"),
    queryFn: () => api<PortalHome>("GET", `/api/portal/${clientId}/home`),
    enabled: !!clientId,
  });
}

/** Period is the first day of the month. Null asks for the latest visible one. */
export function usePortalStatements(clientId: string | null, period: string | null) {
  return useQuery({
    queryKey: portalKeys.statements(clientId ?? "none", period),
    queryFn: () => api<PortalStatements>("GET", `/api/portal/${clientId}/statements${toQuery({ period })}`),
    enabled: !!clientId,
  });
}

export function usePortalTransactions(clientId: string | null, range: { from?: string; to?: string; search?: string } = {}) {
  return useQuery({
    queryKey: portalKeys.transactions(clientId ?? "none", `${range.from ?? ""}..${range.to ?? ""}..${range.search ?? ""}`),
    queryFn: () => api<TransactionPage>("GET", `/api/portal/${clientId}/transactions${toQuery(range)}`),
    enabled: !!clientId,
  });
}

export function usePortalRequests(clientId: string | null) {
  return useQuery({
    queryKey: portalKeys.requests(clientId ?? "none"),
    queryFn: () => api<{ items: PortalRequest[] }>("GET", `/api/portal/${clientId}/requests`),
    enabled: !!clientId,
  });
}
