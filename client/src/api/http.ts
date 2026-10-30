/**
 * The one fetch every hook uses. Bearer and X-Firm headers come from the
 * AuthProvider through setAuthHeaderProvider (auth brief), so nothing here
 * touches a token. Errors arrive as the API's one envelope and are rethrown
 * as ApiRequestError so a screen can show the server's own message.
 */
import { apiErrorSchema, type ApiErrorCode } from "@shared/api";
import { apiRequest } from "@/lib/queryClient";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await apiRequest(method, url, body);
  } catch (e) {
    // apiRequest throws "<status>: <text>" for non 2xx. Pull the envelope back out.
    const msg = e instanceof Error ? e.message : String(e);
    const m = /^(\d{3}): ([\s\S]*)$/.exec(msg);
    if (m) {
      try {
        const raw = JSON.parse(m[2]) as unknown;
        const env = apiErrorSchema.safeParse(raw);
        if (env.success) throw new ApiRequestError(Number(m[1]), env.data.error.code, env.data.error.message, env.data.error.details);
        // The auth and tiers middleware answer { code, message } without the envelope.
        const flat = raw as { code?: string; message?: string };
        if (flat && typeof flat.message === "string") {
          const code = (flat.code ?? "unknown").toLowerCase() === "feature_not_in_tier" ? "feature_not_included" : (flat.code ?? "unknown");
          throw new ApiRequestError(Number(m[1]), code, flat.message);
        }
        // The run trigger route answers 409 with the run outcome itself, not
        // the error envelope (router.ts: refused/rejected_locked), so a
        // screen can still read outcome.status/errors on success. Here, on
        // the error path, pull the first named error's own message out of it
        // rather than falling through to the raw JSON dump below.
        const runOutcome = raw as { errors?: Array<{ code?: string; message?: string }> };
        const firstError = runOutcome?.errors?.[0];
        if (firstError && typeof firstError.message === "string") {
          throw new ApiRequestError(Number(m[1]), firstError.code ?? "unknown", firstError.message, raw);
        }
        throw new Error("unrecognised");
      } catch (inner) {
        if (inner instanceof ApiRequestError) throw inner;
        throw new ApiRequestError(Number(m[1]), "unknown", m[2] || "The server answered with an error.");
      }
    }
    throw new ApiRequestError(0, "network", "The server could not be reached.");
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** The text a screen shows for any error a hook surfaced. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

export function toQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}
