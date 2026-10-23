import { useQuery } from "@tanstack/react-query";
import type { Aging, Budget, CloseChecklist, FirmRequests, Forecast, Journal, PortalStatements, Reconcile, Rules, TrialBalance } from "@shared/api";
import { api, toQuery } from "./http";

/** Reads for the firm screens. Keys live under the client so run mutations invalidate them. */
export const screenKeys = {
  close: (clientId: string, period: string) => ["api", "firm", "clients", clientId, "close", period] as const,
  reconcile: (clientId: string, period: string, batchId: string | null) =>
    ["api", "firm", "clients", clientId, "reconcile", period, batchId ?? "first"] as const,
  requests: (clientId: string) => ["api", "firm", "clients", clientId, "requests"] as const,
  statements: (clientId: string, period: string) => ["api", "firm", "clients", clientId, "statements", period] as const,
  trialBalance: (clientId: string, period: string) => ["api", "firm", "clients", clientId, "trial-balance", period] as const,
  aging: (clientId: string) => ["api", "firm", "clients", clientId, "aging"] as const,
  budget: (clientId: string, period: string) => ["api", "firm", "clients", clientId, "budget", period] as const,
  forecast: (clientId: string, runId: string | null) => ["api", "firm", "clients", clientId, "forecast", runId ?? "latest"] as const,
  journal: (clientId: string, period: string) => ["api", "firm", "clients", clientId, "journal", period] as const,
  rules: (clientId: string) => ["api", "firm", "clients", clientId, "rules"] as const,
};

/** A YYYY-MM from the header becomes the first of that month for the API. */
export function periodStartOf(period: string): string {
  return period.length === 7 ? `${period}-01` : period;
}

export function useCloseChecklist(clientId: string | null, period: string) {
  const p = periodStartOf(period);
  return useQuery({
    queryKey: screenKeys.close(clientId ?? "none", p),
    queryFn: () => api<CloseChecklist>("GET", `/api/firm/clients/${clientId}/close${toQuery({ period: p })}`),
    enabled: !!clientId,
  });
}

export function useReconcile(clientId: string | null, period: string, batchId: string | null) {
  const p = periodStartOf(period);
  return useQuery({
    queryKey: screenKeys.reconcile(clientId ?? "none", p, batchId),
    queryFn: () => api<Reconcile>("GET", `/api/firm/clients/${clientId}/reconcile${toQuery({ period: p, batchId: batchId ?? undefined })}`),
    enabled: !!clientId,
  });
}

export function useFirmRequests(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.requests(clientId ?? "none"),
    queryFn: () => api<FirmRequests>("GET", `/api/firm/clients/${clientId}/requests`),
    enabled: !!clientId,
  });
}

export function useFirmStatements(clientId: string | null, period: string) {
  const p = periodStartOf(period);
  return useQuery({
    queryKey: screenKeys.statements(clientId ?? "none", p),
    queryFn: () => api<PortalStatements>("GET", `/api/firm/clients/${clientId}/statements${toQuery({ period: p })}`),
    enabled: !!clientId,
  });
}

export function useTrialBalance(clientId: string | null, period: string) {
  const p = periodStartOf(period);
  return useQuery({
    queryKey: screenKeys.trialBalance(clientId ?? "none", p),
    queryFn: () => api<TrialBalance>("GET", `/api/firm/clients/${clientId}/trial-balance${toQuery({ period: p })}`),
    enabled: !!clientId,
  });
}

export function useAging(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.aging(clientId ?? "none"),
    queryFn: () => api<Aging>("GET", `/api/firm/clients/${clientId}/aging`),
    enabled: !!clientId,
  });
}

export function useBudget(clientId: string | null, period: string) {
  const p = periodStartOf(period);
  return useQuery({
    queryKey: screenKeys.budget(clientId ?? "none", p),
    queryFn: () => api<Budget>("GET", `/api/firm/clients/${clientId}/budget${toQuery({ period: p })}`),
    enabled: !!clientId,
  });
}

export function useForecast(clientId: string | null, runId: string | null) {
  return useQuery({
    queryKey: screenKeys.forecast(clientId ?? "none", runId),
    queryFn: () => api<Forecast>("GET", `/api/firm/clients/${clientId}/forecast${toQuery({ runId: runId ?? undefined })}`),
    enabled: !!clientId,
  });
}

export function useJournal(clientId: string | null, period: string) {
  const p = periodStartOf(period);
  return useQuery({
    queryKey: screenKeys.journal(clientId ?? "none", p),
    queryFn: () => api<Journal>("GET", `/api/firm/clients/${clientId}/journal${toQuery({ period: p })}`),
    enabled: !!clientId,
  });
}

export function useRules(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.rules(clientId ?? "none"),
    queryFn: () => api<Rules>("GET", `/api/firm/clients/${clientId}/rules`),
    enabled: !!clientId,
  });
}
