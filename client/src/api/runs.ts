import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunCatalogItem, RunHistory, RunOutcomeDto, TriggerRunInput } from "@shared/api";
import { api, toQuery } from "./http";
import { clientKeys } from "./clients";
import { overviewKeys } from "./overview";
import { portalKeys } from "./portal";

export const runKeys = {
  catalog: ["api", "firm", "runs", "catalog"] as const,
  history: (clientId: string, runType?: string | null) => ["api", "firm", "clients", clientId, "runs", runType ?? "all"] as const,
};

export function useRunCatalog() {
  return useQuery({
    queryKey: runKeys.catalog,
    queryFn: () => api<{ items: RunCatalogItem[] }>("GET", "/api/firm/runs/catalog"),
  });
}

export function useRunHistory(clientId: string | null, runType?: string | null, limit = 50) {
  return useQuery({
    queryKey: [...runKeys.history(clientId ?? "none", runType), limit],
    queryFn: () => api<RunHistory>("GET", `/api/firm/clients/${clientId}/runs${toQuery({ runType, limit })}`),
    enabled: !!clientId,
  });
}

/** POST /api/firm/clients/:clientId/runs/:runCode. Preview by default. */
export function useTriggerRun(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runCode, body }: { runCode: string; body: TriggerRunInput }) =>
      api<RunOutcomeDto>("POST", `/api/firm/clients/${clientId}/runs/${runCode}`, body),
    onSuccess: () => {
      if (clientId) {
        void qc.invalidateQueries({ queryKey: clientKeys.one(clientId) });
        void qc.invalidateQueries({ queryKey: ["api", "firm", "clients", clientId, "runs"] });
        void qc.invalidateQueries({ queryKey: portalKeys.client(clientId) });
      }
      void qc.invalidateQueries({ queryKey: clientKeys.list() });
      void qc.invalidateQueries({ queryKey: overviewKeys.all });
    },
  });
}

export function useApplyRun(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (logId: string) => api<RunOutcomeDto>("POST", `/api/firm/runs/${logId}/apply`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["api", "firm"] });
      if (clientId) void qc.invalidateQueries({ queryKey: portalKeys.client(clientId) });
    },
  });
}

export function useUndoRun(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ logId, reason }: { logId: string; reason: string }) =>
      api<RunOutcomeDto>("POST", `/api/firm/runs/${logId}/undo`, { reason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["api", "firm"] });
      if (clientId) void qc.invalidateQueries({ queryKey: portalKeys.client(clientId) });
    },
  });
}
