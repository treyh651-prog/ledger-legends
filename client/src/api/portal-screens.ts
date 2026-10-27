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
  DocumentDownload,
  UploadDocumentResult,
} from "@shared/api";
import { api, ApiRequestError, toQuery } from "./http";
import { API_BASE, getAuthHeaders as authHeaders } from "@/lib/queryClient";
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

/* ---------------- Documents: upload and download ---------------- */

export interface UploadDocumentArgs {
  file: File;
  docType: string;
  requestId?: string | null;
}

/**
 * Above this size the file goes straight to storage (step 2 below) instead of
 * through this server's own request body. A standard Netlify function caps a
 * request at 6 MB, about 4.5 MB once a binary body is base64 encoded; this
 * threshold leaves margin under that for a platform that enforces it, and
 * changes nothing for a host that does not.
 */
const DIRECT_UPLOAD_THRESHOLD_BYTES = 4 * 1024 * 1024;

/**
 * POST /api/portal/:clientId/documents with the raw bytes. The server inspects
 * name, type, size and first bytes, stores the object, then writes the row;
 * 201 means both exist.
 */
async function uploadDirect(clientId: string, args: UploadDocumentArgs): Promise<UploadDocumentResult> {
  const headers: Record<string, string> = {
    ...(await authHeaders()),
    "content-type": args.file.type || "application/octet-stream",
    "x-file-name": encodeURIComponent(args.file.name),
    "x-doc-type": args.docType,
  };
  if (args.requestId) headers["x-request-id"] = args.requestId;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/portal/${clientId}/documents`, { method: "POST", headers, body: args.file });
  } catch {
    throw new ApiRequestError(0, "network", "The server could not be reached.");
  }
  if (!res.ok) throw await errorFromResponse(res);
  return (await res.json()) as UploadDocumentResult;
}

/**
 * Three steps for a file too large for this server's own request body: ask
 * for a signed upload target scoped to a fresh document id, write the bytes
 * straight to storage with it, then finalize so the server reads the object
 * back, runs the same inspection the small path runs inline, and records the
 * row. If the server answers 501 (no direct upload mechanism, the in memory
 * development store), this falls back to the small path, which still works
 * for anything under that store's own ceiling.
 */
async function uploadViaSignedUrl(clientId: string, args: UploadDocumentArgs): Promise<UploadDocumentResult> {
  let signRes: Response;
  try {
    signRes = await fetch(`${API_BASE}/api/portal/${clientId}/documents/upload-url`, {
      method: "POST",
      headers: { ...(await authHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ filename: args.file.name, docType: args.docType }),
    });
  } catch {
    throw new ApiRequestError(0, "network", "The server could not be reached.");
  }
  if (!signRes.ok) {
    if (signRes.status === 501) return uploadDirect(clientId, args);
    throw await errorFromResponse(signRes);
  }
  const target = (await signRes.json()) as { documentId: string; objectKey: string; uploadUrl: string };

  let putRes: Response;
  try {
    putRes = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: { "content-type": args.file.type || "application/octet-stream" },
      body: args.file,
    });
  } catch {
    throw new ApiRequestError(0, "network", "The file could not be uploaded.");
  }
  if (!putRes.ok) throw new ApiRequestError(putRes.status, "upload_failed", "The file could not be uploaded.");

  let finRes: Response;
  try {
    finRes = await fetch(`${API_BASE}/api/portal/${clientId}/documents/${target.documentId}/finalize`, {
      method: "POST",
      headers: { ...(await authHeaders()), "content-type": "application/json" },
      body: JSON.stringify({ filename: args.file.name, docType: args.docType, objectKey: target.objectKey, requestId: args.requestId ?? null }),
    });
  } catch {
    throw new ApiRequestError(0, "network", "The server could not be reached.");
  }
  if (!finRes.ok) throw await errorFromResponse(finRes);
  return (await finRes.json()) as UploadDocumentResult;
}

/** The documents query is refreshed on success so the list shows the new row without a reload. */
export function useUploadDocument(clientId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: UploadDocumentArgs): Promise<UploadDocumentResult> => {
      if (!clientId) throw new ApiRequestError(400, "client_required", "A client is required.");
      return args.file.size > DIRECT_UPLOAD_THRESHOLD_BYTES ? uploadViaSignedUrl(clientId, args) : uploadDirect(clientId, args);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: portalScreenKeys.documents(clientId ?? "none") }),
  });
}

/**
 * GET /api/portal/:clientId/documents/:id/download. With Supabase Storage the
 * answer is a sixty second signed URL; the development store streams the bytes.
 * Either way the file opens in a new tab from a URL that was never public.
 */
export async function downloadDocument(clientId: string, documentId: string, title: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/portal/${clientId}/documents/${documentId}/download`, { headers: await authHeaders() });
  } catch {
    throw new ApiRequestError(0, "network", "The server could not be reached.");
  }
  if (!res.ok) throw await errorFromResponse(res);
  const type = res.headers.get("content-type") ?? "";
  let href: string;
  let revoke: string | null = null;
  if (type.startsWith("application/json")) {
    href = ((await res.json()) as DocumentDownload).url;
  } else {
    href = URL.createObjectURL(await res.blob());
    revoke = href;
  }
  const a = document.createElement("a");
  a.href = href;
  a.download = title;
  a.rel = "noopener";
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(revoke), 60_000);
}

async function errorFromResponse(res: Response): Promise<ApiRequestError> {
  const text = await res.text();
  try {
    const raw = JSON.parse(text) as { error?: { code?: string; message?: string }; code?: string; message?: string };
    const code = raw.error?.code ?? raw.code ?? "unknown";
    const message = raw.error?.message ?? raw.message ?? "The server answered with an error.";
    return new ApiRequestError(res.status, code, message);
  } catch {
    return new ApiRequestError(res.status, "unknown", text || "The server answered with an error.");
  }
}
