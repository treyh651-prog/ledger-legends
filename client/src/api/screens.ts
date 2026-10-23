import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Aging, Budget, ClientSetup, CloseChecklist, FirmRequests, FirmTasks, FirmTeam, RunOutcomeDto, UpdateTaskBody, Forecast, Journal, Narratives, PortalStatements, Reconcile, ReportPackages, Rules, Substantiation, TaxForms, TrialBalance } from "@shared/api";
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

export function useTaxForms(clientId: string | null, dataSetId: string | null) {
  return useQuery({
    queryKey: ["api", "firm", "clients", clientId ?? "none", "tax-forms", dataSetId ?? "latest"],
    queryFn: () => api<TaxForms>("GET", `/api/firm/clients/${clientId}/tax-forms${toQuery({ dataSetId: dataSetId ?? undefined })}`),
    enabled: !!clientId,
  });
}

export function useSubstantiation(clientId: string | null, period: string) {
  const p = periodStartOf(period);
  return useQuery({
    queryKey: ["api", "firm", "clients", clientId ?? "none", "substantiation", p],
    queryFn: () => api<Substantiation>("GET", `/api/firm/clients/${clientId}/substantiation${toQuery({ period: p })}`),
    enabled: !!clientId,
  });
}

export function useReportPackages(clientId: string | null, period: string, packageId: string | null) {
  const p = periodStartOf(period);
  return useQuery({
    queryKey: ["api", "firm", "clients", clientId ?? "none", "report-packages", p, packageId ?? "latest"],
    queryFn: () => api<ReportPackages>("GET", `/api/firm/clients/${clientId}/report-packages${toQuery({ period: p, packageId: packageId ?? undefined })}`),
    enabled: !!clientId,
  });
}

export function useNarratives(clientId: string | null, period: string) {
  const p = periodStartOf(period);
  return useQuery({
    queryKey: ["api", "firm", "clients", clientId ?? "none", "narratives", p],
    queryFn: () => api<Narratives>("GET", `/api/firm/clients/${clientId}/narratives${toQuery({ period: p })}`),
    enabled: !!clientId,
  });
}


/* ---------------- Team, board, client setup ---------------- */

export const firmKeys = {
  team: () => ["api", "firm", "team"] as const,
  tasks: (period: string) => ["api", "firm", "tasks", period] as const,
  setup: (clientId: string) => ["api", "firm", "clients", clientId, "setup"] as const,
};

export function useFirmTeam() {
  return useQuery({ queryKey: firmKeys.team(), queryFn: () => api<FirmTeam>("GET", "/api/firm/team") });
}

export function useFirmTasks(period: string) {
  const p = periodStartOf(period);
  return useQuery({
    queryKey: firmKeys.tasks(p),
    queryFn: () => api<FirmTasks>("GET", `/api/firm/tasks${toQuery({ period: p })}`),
  });
}

export function useClientSetup(clientId: string | null) {
  return useQuery({
    queryKey: firmKeys.setup(clientId ?? "none"),
    queryFn: () => api<ClientSetup>("GET", `/api/firm/clients/${clientId}/setup`),
    enabled: !!clientId,
  });
}

export interface UpdateTaskResult {
  preview: RunOutcomeDto;
  applied: RunOutcomeDto | null;
  done: boolean;
}

/** PRAC-UPDATE-TASK through the firm route. Preview and apply in one request. */
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, taskId, body }: { clientId: string; taskId: string; body: UpdateTaskBody }) =>
      api<UpdateTaskResult>("POST", `/api/firm/clients/${clientId}/tasks/${taskId}`, body),
    onSuccess: (_r, { clientId }) => {
      void qc.invalidateQueries({ queryKey: ["api", "firm", "tasks"] });
      void qc.invalidateQueries({ queryKey: ["api", "firm", "clients", clientId] });
    },
  });
}
