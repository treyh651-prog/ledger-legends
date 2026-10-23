import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AnswerRequestBody,
  PortalActionResult,
  PortalAging,
  PortalBudget,
  PortalDocuments,
  PortalForecast,
  PortalMessages,
  PortalNarrative,
  PortalPeriods,
  PortalReports,
  PortalRequests,
  PortalSign,
  PostMessageBody,
  SignLetterBody,
} from "@shared/api";
import { api, toQuery } from "./http";
import { portalKeys } from "./portal";

/**
 * Hooks for the portal screens past home, statements and transactions.
 * Reads are GET /api/portal/:clientId/<screen>. Actions are POSTs that start
 * one of the three client side runs and come back as PortalActionResult.
 */
export const portalScreenKeys = {
  requests: (clientId: string) => [...portalKeys.client(clientId), "requests", "all"] as const,
  messages: (clientId: string) => [...portalKeys.client(clientId), "messages"] as const,
  documents: (clientId: string) => [...portalKeys.client(clientId), "documents"] as const,
  sign: (clientId: string) => [...portalKeys.client(clientId), "sign"] as const,
  aging: (clientId: string, side: string) => [...portalKeys.client(clientId), "aging", side] as const,
  budget: (clientId: string, period: string | null) => [...portalKeys.client(clientId), "budget", period ?? "latest"] as const,
  forecast: (clientId: string, run: string | null) => [...portalKeys.client(clientId), "forecast", run ?? "base"] as const,
  narrative: (clientId: string) => [...portalKeys.client(clientId), "narrative"] as const,
  reports: (clientId: string) => [...portalKeys.client(clientId), "reports"] as const,
  periods: (clientId: string) => [...portalKeys.client(clientId), "periods"] as const,
};

function read<T>(clientId: string | null, key: readonly unknown[], path: string) {
  return useQuery({
    queryKey: key,
    queryFn: () => api<T>("GET", `/api/portal/${clientId}${path}`),
    enabled: !!clientId,
  });
}

export function usePortalRequestList(clientId: string | null) {
  return read<PortalRequests>(clientId, portalScreenKeys.requests(clientId ?? "none"), "/requests");
}

export function useAnswerRequest(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AnswerRequestBody) => api<PortalActionResult>("POST", `/api/portal/${clientId}/requests/answer`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: portalKeys.client(clientId ?? "none") }),
  });
}

export function usePortalMessages(clientId: string | null) {
  return read<PortalMessages>(clientId, portalScreenKeys.messages(clientId ?? "none"), "/messages");
}

export function usePostMessage(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PostMessageBody) => api<PortalActionResult>("POST", `/api/portal/${clientId}/messages`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: portalScreenKeys.messages(clientId ?? "none") }),
  });
}

/** The firm's side of the same thread. */
export function useFirmMessages(clientId: string | null) {
  return useQuery({
    queryKey: ["api", "firm", "clients", clientId ?? "none", "messages"] as const,
    queryFn: () => api<PortalMessages>("GET", `/api/firm/clients/${clientId}/messages`),
    enabled: !!clientId,
  });
}

export function useFirmPostMessage(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PostMessageBody) => api<PortalActionResult>("POST", `/api/firm/clients/${clientId}/messages`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["api", "firm", "clients", clientId ?? "none", "messages"] }),
  });
}

export function usePortalDocuments(clientId: string | null) {
  return read<PortalDocuments>(clientId, portalScreenKeys.documents(clientId ?? "none"), "/documents");
}

export function usePortalSign(clientId: string | null) {
  return read<PortalSign>(clientId, portalScreenKeys.sign(clientId ?? "none"), "/sign");
}

export function useSignLetter(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SignLetterBody) => api<PortalActionResult>("POST", `/api/portal/${clientId}/sign`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: portalKeys.client(clientId ?? "none") }),
  });
}

export function usePortalAging(clientId: string | null, side: "receivable" | "payable") {
  return read<PortalAging>(clientId, portalScreenKeys.aging(clientId ?? "none", side), `/aging${toQuery({ side })}`);
}

export function usePortalBudget(clientId: string | null, period: string | null) {
  return read<PortalBudget>(clientId, portalScreenKeys.budget(clientId ?? "none", period), `/budget${toQuery({ period })}`);
}

export function usePortalForecast(clientId: string | null, run: string | null = null) {
  return read<PortalForecast>(clientId, portalScreenKeys.forecast(clientId ?? "none", run), `/forecast${toQuery({ run })}`);
}

export function usePortalNarrative(clientId: string | null) {
  return read<PortalNarrative>(clientId, portalScreenKeys.narrative(clientId ?? "none"), "/narrative");
}

export function usePortalReports(clientId: string | null) {
  return read<PortalReports>(clientId, portalScreenKeys.reports(clientId ?? "none"), "/reports");
}

export function usePortalPeriods(clientId: string | null) {
  return read<PortalPeriods>(clientId, portalScreenKeys.periods(clientId ?? "none"), "/periods");
}
