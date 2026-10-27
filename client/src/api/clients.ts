import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClientList, ClientSummary, CreateClientInput, RunOutcomeDto } from "@shared/api";
import { api } from "./http";
import { overviewKeys } from "./overview";

export const clientKeys = {
  all: ["api", "firm", "clients"] as const,
  list: () => [...clientKeys.all, "list"] as const,
  one: (clientId: string) => [...clientKeys.all, clientId] as const,
};

export interface CreateClientResult {
  client: ClientSummary | null;
  runs: RunOutcomeDto[];
  complete: boolean;
}

export function useClients() {
  return useQuery({ queryKey: clientKeys.list(), queryFn: () => api<ClientList>("GET", "/api/firm/clients") });
}

export function useClient(clientId: string | null) {
  return useQuery({
    queryKey: clientKeys.one(clientId ?? "none"),
    queryFn: () => api<ClientSummary>("GET", `/api/firm/clients/${clientId}`),
    enabled: clientId !== null && clientId !== "",
  });
}

/** POST /api/firm/clients. The body becomes four intake runs on the server. */
export function useCreateClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateClientInput) => api<CreateClientResult>("POST", "/api/firm/clients", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: clientKeys.all });
      void qc.invalidateQueries({ queryKey: overviewKeys.all });
    },
  });
}

/** POST /api/firm/clients/:clientId/billing-status. ENG-SET-BILLING-STATUS, preview and apply in one request. */
export function useSetBillingStatus(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (billingStatus: "current" | "past_due") =>
      api<{ done: boolean }>("POST", `/api/firm/clients/${clientId}/billing-status`, { billingStatus }),
    onSuccess: () => {
      if (clientId) void qc.invalidateQueries({ queryKey: clientKeys.one(clientId) });
      void qc.invalidateQueries({ queryKey: clientKeys.list() });
    },
  });
}
