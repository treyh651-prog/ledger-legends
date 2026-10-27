/**
 * Where document bytes live. NOTES 256.
 *
 * One interface, two providers. Supabase Storage through its REST API with the
 * service role key, which never leaves this process. Memory for the memory
 * database, so the development server and the tests exercise the whole path
 * without pretending bytes were kept anywhere durable; the payload says
 * provider "memory" and the screens show it.
 *
 * No supabase-js here, for the reason auth-admin.ts gives: the full client
 * drags in Realtime, and plain fetch is all the Storage API needs.
 */

import { createHash } from "node:crypto";
import { UPLOAD_DEFAULT_MAX_BYTES, UPLOAD_TYPES } from "../../shared/uploads";

export type StorageProvider = "supabase" | "memory";

export interface StoredObject {
  bucket: string;
  objectKey: string;
}

export interface DocumentStorage {
  readonly provider: StorageProvider;
  readonly bucket: string;
  /** Writes one object. Refuses to overwrite; keys carry a fresh document id so this never collides. */
  put(objectKey: string, bytes: Buffer, contentType: string): Promise<StoredObject>;
  /** Removes one object. Used only to clean up after a failed record write. */
  remove(objectKey: string): Promise<void>;
  /** A short lived private URL, or null when the provider streams instead. */
  signedUrl(objectKey: string, expiresInSeconds: number): Promise<string | null>;
  /** The bytes, read back for providers without signed URLs, or for inspecting an object a browser just wrote directly. */
  read(objectKey: string): Promise<{ bytes: Buffer; contentType: string } | null>;
  /**
   * A short lived URL the browser may write bytes to directly, bypassing this
   * server's own request body ceiling (a hard platform limit under a function
   * runtime, well under what a scanned document or a phone photo can reach).
   * Null when the provider has no such mechanism (the memory store), in which
   * case the caller falls back to sending the body through this server.
   */
  createUploadUrl(objectKey: string): Promise<{ url: string } | null>;
}

export class StorageError extends Error {
  constructor(
    readonly code: "put_failed" | "remove_failed" | "sign_failed" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export interface StorageConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  bucket: string;
  maxBytes: number;
}

/** Null when the two Supabase values are missing. The bucket and ceiling have defaults. */
export function readStorageEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig | null {
  const url = env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return {
    supabaseUrl: url,
    serviceRoleKey: key,
    bucket: env.DOCUMENT_BUCKET?.trim() || "documents",
    maxBytes: uploadMaxBytes(env),
  };
}

export function uploadMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.UPLOAD_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : UPLOAD_DEFAULT_MAX_BYTES;
}

export function createSupabaseStorage(cfg: StorageConfig): DocumentStorage {
  const base = `${cfg.supabaseUrl}/storage/v1`;
  const headers = { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };
  const encode = (key: string) => key.split("/").map(encodeURIComponent).join("/");
  return {
    provider: "supabase",
    bucket: cfg.bucket,
    async put(objectKey, bytes, contentType) {
      const res = await fetch(`${base}/object/${cfg.bucket}/${encode(objectKey)}`, {
        method: "POST",
        headers: { ...headers, "content-type": contentType, "x-upsert": "false" },
        body: new Uint8Array(bytes),
      });
      if (!res.ok) throw new StorageError("put_failed", `storage answered ${res.status} on put`);
      return { bucket: cfg.bucket, objectKey };
    },
    async remove(objectKey) {
      const res = await fetch(`${base}/object/${cfg.bucket}/${encode(objectKey)}`, { method: "DELETE", headers });
      if (!res.ok && res.status !== 404) throw new StorageError("remove_failed", `storage answered ${res.status} on remove`);
    },
    async signedUrl(objectKey, expiresInSeconds) {
      const res = await fetch(`${base}/object/sign/${cfg.bucket}/${encode(objectKey)}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (!res.ok) throw new StorageError("sign_failed", `storage answered ${res.status} on sign`);
      const body = (await res.json()) as { signedURL?: string; signedUrl?: string };
      const path = body.signedURL ?? body.signedUrl;
      if (!path) throw new StorageError("sign_failed", "storage returned no signed path");
      return path.startsWith("http") ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
    },
    async read(objectKey) {
      const res = await fetch(`${base}/object/${cfg.bucket}/${encode(objectKey)}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new StorageError("not_found", `storage answered ${res.status} on read`);
      const contentType = res.headers.get("content-type") ?? "application/octet-stream";
      const bytes = Buffer.from(await res.arrayBuffer());
      return { bytes, contentType };
    },
    async createUploadUrl(objectKey) {
      const res = await fetch(`${base}/object/upload/sign/${cfg.bucket}/${encode(objectKey)}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "x-upsert": "false" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new StorageError("sign_failed", `storage answered ${res.status} on upload sign`);
      const body = (await res.json()) as { url?: string; token?: string };
      if (body.token) {
        return { url: `${base}/object/upload/sign/${cfg.bucket}/${encode(objectKey)}?token=${encodeURIComponent(body.token)}` };
      }
      if (!body.url) throw new StorageError("sign_failed", "storage returned no upload url or token");
      return { url: body.url.startsWith("http") ? body.url : `${base}${body.url.startsWith("/") ? "" : "/"}${body.url}` };
    },
  };
}

/** Bytes in a Map. For the memory database and the tests only. */
export function createMemoryStorage(bucket = "documents"): DocumentStorage & { objects: Map<string, { bytes: Buffer; contentType: string }>; failNextPut?: boolean } {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const store = {
    provider: "memory" as const,
    bucket,
    objects,
    failNextPut: false,
    async put(objectKey: string, bytes: Buffer, contentType: string) {
      if (store.failNextPut) {
        store.failNextPut = false;
        throw new StorageError("put_failed", "storage refused the object");
      }
      if (objects.has(objectKey)) throw new StorageError("put_failed", "an object with that key exists");
      objects.set(objectKey, { bytes: Buffer.from(bytes), contentType });
      return { bucket, objectKey };
    },
    async remove(objectKey: string) {
      objects.delete(objectKey);
    },
    async signedUrl() {
      return null;
    },
    async read(objectKey: string) {
      return objects.get(objectKey) ?? null;
    },
    async createUploadUrl() {
      return null;
    },
  };
  return store;
}

/* ---------------- Validation at the trusted boundary ---------------- */

export type UploadRefusal =
  | { ok: false; code: "empty" | "too_large" | "type_not_allowed" | "content_mismatch"; message: string };

export type UploadAccepted = { ok: true; contentType: string; sha256Hex: string };

/**
 * Size, declared type, and the first bytes must agree. CSV has no signature,
 * so it must decode as UTF-8 text with no NUL bytes in its first 4 KB.
 */
export function inspectUpload(args: { bytes: Buffer; filename: string; declaredType: string | null; maxBytes: number }): UploadAccepted | UploadRefusal {
  const { bytes, filename, maxBytes } = args;
  if (bytes.length === 0) return { ok: false, code: "empty", message: "The file is empty." };
  if (bytes.length > maxBytes) {
    return { ok: false, code: "too_large", message: `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.` };
  }
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : "";
  const accepted = UPLOAD_TYPES.find((t) => t.ext === ext);
  if (!accepted) return { ok: false, code: "type_not_allowed", message: "Only PDF, PNG, JPEG, CSV, and Excel files are accepted." };
  const declared = (args.declaredType ?? "").split(";")[0].trim().toLowerCase();
  if (declared && declared !== accepted.mime && declared !== "application/octet-stream" && !(accepted.ext === "csv" && declared.startsWith("text/"))) {
    return { ok: false, code: "content_mismatch", message: "The file's type does not match its name." };
  }
  if (!magicMatches(accepted.mime, bytes)) {
    return { ok: false, code: "content_mismatch", message: "The file's contents do not match its name." };
  }
  return { ok: true, contentType: accepted.mime, sha256Hex: createHash("sha256").update(bytes).digest("hex") };
}

export function magicMatches(mime: string, bytes: Buffer): boolean {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  switch (mime) {
    case "application/pdf":
      return starts([0x25, 0x50, 0x44, 0x46]);
    case "image/png":
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return starts([0xff, 0xd8, 0xff]);
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return starts([0x50, 0x4b, 0x03, 0x04]);
    case "text/csv": {
      const head = bytes.subarray(0, 4096);
      if (head.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(head);
        return true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}
