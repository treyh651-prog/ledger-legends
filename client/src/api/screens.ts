import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Aging, Bills, Budget, Categories, ClientSetup, CloseChecklist, ConsolidatedPackages, CpaHandoffs, Customers, EntityGroups, FirmRequests, FirmTasks, FirmTeam, FixedAssets, Loans, RunOutcomeDto, UpdateTaskBody, Forecast, Invoices, Journal, Narratives, OffboardExports, PayRuns, PortalStatements, Reconcile, RecurringTemplates, ReportPackages, Rules, StagedBatches, StagedRows, Substantiation, TaxForms, TrialBalance, Vendors } from "@shared/api";
import { api, toQuery } from "./http";

/** Reads for the firm screens. Keys live under the client so run mutations invalidate them. */
export const screenKeys = {
  close: (clientId: string, period: string) => ["api", "firm", "clients", clientId, "close", period] as const,
  reconcile: (clientId: string, period: string, batchId: string | null) =>
    ["api", "firm", "clients", clientId, "reconcile", period, batchId ?? "first"] as const,
  stagedBatches: (clientId: string) => ["api", "firm", "clients", clientId, "staged-batches"] as const,
  stagedRows: (clientId: string, batchId: string) => ["api", "firm", "clients", clientId, "staged-batches", batchId, "rows"] as const,
  requests: (clientId: string) => ["api", "firm", "clients", clientId, "requests"] as const,
  statements: (clientId: string, period: string) => ["api", "firm", "clients", clientId, "statements", period] as const,
  trialBalance: (clientId: string, period: string) => ["api", "firm", "clients", clientId, "trial-balance", period] as const,
  aging: (clientId: string) => ["api", "firm", "clients", clientId, "aging"] as const,
  budget: (clientId: string, period: string) => ["api", "firm", "clients", clientId, "budget", period] as const,
  forecast: (clientId: string, runId: string | null) => ["api", "firm", "clients", clientId, "forecast", runId ?? "latest"] as const,
  journal: (clientId: string, period: string) => ["api", "firm", "clients", clientId, "journal", period] as const,
  rules: (clientId: string) => ["api", "firm", "clients", clientId, "rules"] as const,
  categories: (clientId: string) => ["api", "firm", "clients", clientId, "categories"] as const,
  recurringTemplates: (clientId: string) => ["api", "firm", "clients", clientId, "recurring-templates"] as const,
  customers: (clientId: string) => ["api", "firm", "clients", clientId, "customers"] as const,
  vendors: (clientId: string) => ["api", "firm", "clients", clientId, "vendors"] as const,
  fixedAssets: (clientId: string) => ["api", "firm", "clients", clientId, "fixed-assets"] as const,
  loans: (clientId: string) => ["api", "firm", "clients", clientId, "loans"] as const,
  invoices: (clientId: string) => ["api", "firm", "clients", clientId, "invoices"] as const,
  bills: (clientId: string) => ["api", "firm", "clients", clientId, "bills"] as const,
  payRuns: (clientId: string) => ["api", "firm", "clients", clientId, "pay-runs"] as const,
  cpaHandoffs: (clientId: string) => ["api", "firm", "clients", clientId, "cpa-handoffs"] as const,
  offboardExports: (clientId: string) => ["api", "firm", "clients", clientId, "offboard-exports"] as const,
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

export interface RunCloseChecksResult {
  stoppedAtStep: number | null;
  stoppedBy: string | null;
  done: boolean;
}

/** ARAP-REFRESH-AGING, SUB-TIEOUT-ACCOUNTS, CLOSE-CHECK-GATES, in order, as one sequence. */
export function useRunCloseChecks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, period }: { clientId: string; period: string }) =>
      api<RunCloseChecksResult>("POST", `/api/firm/clients/${clientId}/close/run-checks${toQuery({ period: periodStartOf(period) })}`),
    onSuccess: (_r, { clientId, period }) => void qc.invalidateQueries({ queryKey: screenKeys.close(clientId, periodStartOf(period)) }),
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

export function useStagedBatches(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.stagedBatches(clientId ?? "none"),
    queryFn: () => api<StagedBatches>("GET", `/api/firm/clients/${clientId}/staged-batches`),
    enabled: !!clientId,
  });
}

export interface ApproveBatchResult {
  commit: RunOutcomeDto;
  applied: RunOutcomeDto | null;
  cascade: { stoppedAtStep: number | null; stoppedBy: string | null } | null;
  done: boolean;
}

/** IMPORT-COMMIT-BATCH, then the coding cascade, as one firm decision. */
export function useApproveStagedBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, batchId }: { clientId: string; batchId: string }) =>
      api<ApproveBatchResult>("POST", `/api/firm/clients/${clientId}/staged-batches/${batchId}/approve`),
    onSuccess: (_r, { clientId }) => {
      void qc.invalidateQueries({ queryKey: screenKeys.stagedBatches(clientId) });
      void qc.invalidateQueries({ queryKey: ["api", "firm", "clients", clientId] });
    },
  });
}

export interface RejectBatchResult {
  preview: RunOutcomeDto;
  applied: RunOutcomeDto | null;
  done: boolean;
}

/** IMPORT-REJECT-BATCH. Throws the staged statement out, nothing committed. */
export function useRejectStagedBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, batchId, reason }: { clientId: string; batchId: string; reason: string }) =>
      api<RejectBatchResult>("POST", `/api/firm/clients/${clientId}/staged-batches/${batchId}/reject`, { reason }),
    onSuccess: (_r, { clientId }) => void qc.invalidateQueries({ queryKey: screenKeys.stagedBatches(clientId) }),
  });
}

/** Every row in one batch, so a firm member can decide the ones held for review. */
export function useStagedRows(clientId: string | null, batchId: string | null) {
  return useQuery({
    queryKey: screenKeys.stagedRows(clientId ?? "none", batchId ?? "none"),
    queryFn: () => api<StagedRows>("GET", `/api/firm/clients/${clientId}/staged-batches/${batchId}/rows`),
    enabled: !!clientId && !!batchId,
  });
}

export interface ReviewStagedRowResult {
  preview: RunOutcomeDto;
  applied: RunOutcomeDto | null;
  done: boolean;
}

/** IMPORT-REVIEW-STAGED-ROW. Accept lets a real repeat charge through; reject throws the duplicate out. */
export function useReviewStagedRow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clientId, batchId, stagedRowId, decision }: { clientId: string; batchId: string; stagedRowId: string; decision: "accept" | "reject" }) =>
      api<ReviewStagedRowResult>("POST", `/api/firm/clients/${clientId}/staged-batches/${batchId}/rows/${stagedRowId}/review`, { decision }),
    onSuccess: (_r, { clientId, batchId }) => {
      void qc.invalidateQueries({ queryKey: screenKeys.stagedRows(clientId, batchId) });
      void qc.invalidateQueries({ queryKey: screenKeys.stagedBatches(clientId) });
    },
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

export function useCategories(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.categories(clientId ?? "none"),
    queryFn: () => api<Categories>("GET", `/api/firm/clients/${clientId}/categories`),
    enabled: !!clientId,
  });
}

export function useRecurringTemplates(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.recurringTemplates(clientId ?? "none"),
    queryFn: () => api<RecurringTemplates>("GET", `/api/firm/clients/${clientId}/recurring-templates`),
    enabled: !!clientId,
  });
}

export function useCustomers(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.customers(clientId ?? "none"),
    queryFn: () => api<Customers>("GET", `/api/firm/clients/${clientId}/customers`),
    enabled: !!clientId,
  });
}

export function useFixedAssets(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.fixedAssets(clientId ?? "none"),
    queryFn: () => api<FixedAssets>("GET", `/api/firm/clients/${clientId}/fixed-assets`),
    enabled: !!clientId,
  });
}

export function useLoans(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.loans(clientId ?? "none"),
    queryFn: () => api<Loans>("GET", `/api/firm/clients/${clientId}/loans`),
    enabled: !!clientId,
  });
}

export function useVendors(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.vendors(clientId ?? "none"),
    queryFn: () => api<Vendors>("GET", `/api/firm/clients/${clientId}/vendors`),
    enabled: !!clientId,
  });
}

export function useInvoices(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.invoices(clientId ?? "none"),
    queryFn: () => api<Invoices>("GET", `/api/firm/clients/${clientId}/invoices`),
    enabled: !!clientId,
  });
}

export function useBills(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.bills(clientId ?? "none"),
    queryFn: () => api<Bills>("GET", `/api/firm/clients/${clientId}/bills`),
    enabled: !!clientId,
  });
}

export function usePayRuns(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.payRuns(clientId ?? "none"),
    queryFn: () => api<PayRuns>("GET", `/api/firm/clients/${clientId}/pay-runs`),
    enabled: !!clientId,
  });
}

export function useCpaHandoffs(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.cpaHandoffs(clientId ?? "none"),
    queryFn: () => api<CpaHandoffs>("GET", `/api/firm/clients/${clientId}/cpa-handoffs`),
    enabled: !!clientId,
  });
}

export function useOffboardExports(clientId: string | null) {
  return useQuery({
    queryKey: screenKeys.offboardExports(clientId ?? "none"),
    queryFn: () => api<OffboardExports>("GET", `/api/firm/clients/${clientId}/offboard-exports`),
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

export const entityGroupKeys = {
  all: ["api", "firm", "entity-groups"] as const,
};

export function useEntityGroups() {
  return useQuery({
    queryKey: entityGroupKeys.all,
    queryFn: () => api<EntityGroups>("GET", "/api/firm/entity-groups"),
  });
}

export function useConsolidatedPackages(groupId: string | null, period: string, packageId: string | null) {
  const p = periodStartOf(period);
  return useQuery({
    queryKey: ["api", "firm", "entity-groups", groupId ?? "none", "consolidated-packages", p, packageId ?? "latest"],
    queryFn: () => api<ConsolidatedPackages>("GET", `/api/firm/entity-groups/${groupId}/consolidated-packages${toQuery({ period: p, packageId: packageId ?? undefined })}`),
    enabled: !!groupId,
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
