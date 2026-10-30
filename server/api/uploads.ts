/**
 * Document upload and download, both planes. NOTES 256.
 *
 * Mounted inside the portal plane, so a request has already passed
 * requireClient: a client user reaches their own client, firm staff reach any
 * client of their firm through membership, and nobody else gets here. The
 * portal toggle in the browser decides nothing. The gate on "documents" is the
 * tier's.
 *
 * Order on upload, so a document never exists in one place only:
 *   1. the raw body is bounded by the configured ceiling before it is read,
 *   2. name, declared type, and first bytes are inspected on the server,
 *   3. the object is written under firm/<firm>/client/<client>/<id>/<name>,
 *   4. DOC-RECORD-UPLOAD writes the row; if that fails the object is removed
 *      and the request fails.
 * Success is answered only after step 4.
 *
 * Download reads the row inside the actor's transaction (RLS and firm scope
 * apply) and then signs a sixty second URL with the service role. The memory
 * store streams the bytes instead, because it has nothing to sign.
 */

import express, { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import { extensionOf, UPLOAD_DOC_TYPES, mimeForFilename, safeFilename } from "../../shared/uploads";
import type { ImportOutcome, PortalDocument, UploadDocumentResult } from "../../shared/api";
import type { AuditEventRow, DocumentRow } from "../runs/tables";
import type { Actor } from "../db/with-actor";
import type { RunActor } from "../runs/contract";
import { ulid } from "../runs/ids";
import { execute } from "../runs/execute";
import { importParseFeed, PARSE_ERROR_CODES, type ParseFeedScope } from "../runs/runs/import-parse-feed";
import { importFlagMappingNeeded, type FlagMappingNeededScope } from "../runs/runs/import-flag-mapping-needed";
import { ApiFailure, notConfigured, notFound } from "./errors";
import { readSession } from "./session";
import { triggerRun } from "./runs";
import type { ApiDeps } from "./router";
import { inspectUpload, type DocumentStorage, type UploadAccepted, uploadMaxBytes } from "../storage/document-storage";

const DOC_TYPE_IDS = new Set(UPLOAD_DOC_TYPES.map((t) => t.id));

/** Statement document types the upload route tries to read automatically. */
const AUTO_IMPORT_DOC_TYPES = new Set(["bank_statement", "card_statement"]);

/** The two IMPORT-PARSE-FEED refusals that mean a mapping profile needs attention, not a broken file. */
const MAPPING_FAILURE_CODES: ReadonlySet<string> = new Set([
  PARSE_ERROR_CODES.missingMappingProfile,
  PARSE_ERROR_CODES.headerMismatch,
]);

const headerSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  docType: z.string().refine((v) => DOC_TYPE_IDS.has(v), "unknown document type"),
  requestId: z.string().trim().min(1).max(64).nullable(),
  bankAccountId: z.string().trim().min(1).nullable(),
  vendorId: z.string().trim().min(1).nullable(),
  assetId: z.string().trim().min(1).nullable(),
  loanId: z.string().trim().min(1).nullable(),
});

const uploadUrlBodySchema = z.object({
  filename: z.string().trim().min(1).max(255),
  docType: z.string().refine((v) => DOC_TYPE_IDS.has(v), "unknown document type"),
});

const finalizeBodySchema = z.object({
  filename: z.string().trim().min(1).max(255),
  docType: z.string().refine((v) => DOC_TYPE_IDS.has(v), "unknown document type"),
  objectKey: z.string().min(1).max(500),
  requestId: z.string().trim().min(1).max(64).nullable().optional(),
  bankAccountId: z.string().trim().min(1).nullable().optional(),
  vendorId: z.string().trim().min(1).nullable().optional(),
  assetId: z.string().trim().min(1).nullable().optional(),
  loanId: z.string().trim().min(1).nullable().optional(),
});

const downloadParamsSchema = z.object({ clientId: z.string().min(1), documentId: z.string().length(26) });
const finalizeParamsSchema = z.object({ clientId: z.string().min(1), documentId: z.string().length(26) });

function documentDto(d: DocumentRow): PortalDocument {
  return {
    id: d.id,
    docType: d.docType,
    title: d.title,
    periodStart: d.periodStart,
    periodEnd: d.periodEnd,
    status: d.status,
    byteSize: d.byteSize,
    contentType: d.contentType,
    uploadedAt: d.uploadedAt,
    createdAt: d.createdAt,
  };
}

function headerValue(req: Request, name: string): string | null {
  const raw = req.header(name);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function clientOf(req: Request) {
  const client = req.client;
  const actor = req.actor;
  if (!client || !actor) throw new ApiFailure(400, "client_required", "A client is required.");
  return { actor, clientId: client.clientId, firmId: client.firmId, via: client.via };
}

function remoteIp(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  return ip.length > 0 ? ip : "0.0.0.0";
}

/**
 * docvault.audit_events has carried the document access log since migration
 * 0008. Nothing ever wrote to it for the three events this route answers
 * outside any run: a presigned URL is issued, a presigned URL is handed out
 * for a download, or the bytes are streamed back directly. documentId is
 * null for presigned_put_issued, because the document row this upload will
 * become does not exist yet; the id it will use travels in detail instead.
 */
async function recordAuditEvent(
  deps: ApiDeps,
  args: {
    actor: Actor;
    firmId: string;
    clientId: string;
    documentId: string | null;
    action: AuditEventRow["action"];
    presignedExpiresAt?: string | null;
    req: Request;
    now: Date;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const row: AuditEventRow = {
    id: ulid(args.now),
    clientId: args.clientId,
    firmId: args.firmId,
    documentId: args.documentId,
    action: args.action,
    actorId: args.actor.userId,
    actorKind: "human",
    presignedExpiresAt: args.presignedExpiresAt ?? null,
    ipInet: remoteIp(args.req),
    userAgent: args.req.get("user-agent") ?? "unknown",
    runId: null,
    detail: args.detail ?? {},
    createdAt: args.now.toISOString(),
  };
  await deps.db.tx(
    { ...readSession(args.actor, args.firmId, args.clientId), readOnly: false },
    (tx) => tx.insert("audit_events", [row]),
  );
}

/**
 * The tail shared by both upload paths, once bytes are inspected and in
 * place: run DOC-RECORD-UPLOAD preview then apply, read the row back, and
 * remove the object if any of that fails. Identical to what the direct body
 * route always did; the two step path below just reaches it from a different
 * starting point, after the browser has already written the object itself.
 *
 * A bank or card statement CSV with an account named goes one step further,
 * through maybeAutoImport below. DOC-RECORD-UPLOAD records the document
 * either way; a parse that cannot get past the mapping check is reported
 * through importOutcome, not through a failed upload.
 */
async function recordDocument(args: {
  deps: ApiDeps;
  storage: DocumentStorage;
  actor: Actor;
  firmId: string;
  clientId: string;
  via: "firm" | "client";
  documentId: string;
  objectKey: string;
  filename: string;
  docType: string;
  requestId: string | null;
  bankAccountId: string | null;
  vendorId: string | null;
  assetId: string | null;
  loanId: string | null;
  inspected: UploadAccepted;
  byteSize: number;
  now: Date;
}): Promise<UploadDocumentResult> {
  const { deps, storage, actor, firmId, clientId, via, documentId, objectKey, filename, docType, requestId, bankAccountId, vendorId, assetId, loanId, inspected, byteSize, now } = args;
  const scope = {
    clientId,
    documentId,
    docType,
    title: filename,
    bucket: storage.bucket,
    objectKey,
    storageProvider: storage.provider,
    byteSize,
    contentType: inspected.contentType,
    sha256Hex: inspected.sha256Hex,
    requestId,
    bankAccountId,
    vendorId,
    assetId,
    loanId,
  };
  const common = { db: deps.db, actor, firmId, clientId, via, runCode: "DOC-RECORD-UPLOAD", scope, now };
  let recorded = false;
  try {
    const preview = await triggerRun({ ...common, mode: "preview" });
    const ok = (s: string) => s === "completed" || s === "completed_with_skips";
    if (ok(preview.status)) {
      const applied = await triggerRun({ ...common, mode: "apply", previewRunId: preview.executionId });
      recorded = ok(applied.status);
      if (!recorded) {
        const first = applied.errors[0];
        throw new ApiFailure(500, "run_refused", first ? first.message : "The document record was not saved.");
      }
    } else {
      const first = preview.errors[0];
      throw new ApiFailure(500, "run_refused", first ? first.message : "The document record was not saved.");
    }
  } finally {
    if (!recorded) await storage.remove(objectKey).catch(() => undefined);
  }

  const rows = await deps.db.tx(readSession(actor, firmId, clientId), (tx) => tx.query("document_by_id", { firmId, clientId, documentId }));
  const row = rows[0];
  if (!row) {
    await storage.remove(objectKey).catch(() => undefined);
    throw new ApiFailure(500, "internal", "The document record could not be read back.");
  }

  const importOutcome = await maybeAutoImport({
    deps,
    storage,
    actor,
    firmId,
    clientId,
    docType,
    filename,
    bankAccountId,
    objectKey,
    documentId,
    now,
  });

  return { document: documentDto(row), done: true, importOutcome };
}

/**
 * The automatic half of doc upload for a bank or card statement. Nothing a
 * client actor sends chooses the run that runs here; this function is the
 * only caller of IMPORT-PARSE-FEED and IMPORT-FLAG-MAPPING-NEEDED in the whole
 * server, reached only from inside recordDocument above, with the uploading
 * actor's own id but the "sequence" kind that marks a step as automated
 * rather than a person pressing apply, the same convention
 * server/runs/sequence.ts uses for the month end prep order.
 *
 * csv only. xlsx is accepted for upload and storage, because a firm may still
 * want it on file, but is not read automatically: IMPORT-PARSE-FEED's own
 * grid payload needs a workbook unzipped first, which this route does not do,
 * and doc 05 Part 3 already refuses to guess a shifted column, so a half
 * built xlsx reader would be worse than an honest "not yet supported" note.
 *
 * No profile, or a header that does not match one: IMPORT-FLAG-MAPPING-NEEDED
 * opens the firm's one row for this account rather than guessing a column.
 * A parse that gets through resolves it, so a bookkeeper who fixed the
 * profile does not also have to remember to close the old flag by hand.
 */
async function maybeAutoImport(args: {
  deps: ApiDeps;
  storage: DocumentStorage;
  actor: Actor;
  firmId: string;
  clientId: string;
  docType: string;
  filename: string;
  bankAccountId: string | null;
  objectKey: string;
  documentId: string;
  now: Date;
}): Promise<ImportOutcome | null> {
  const { deps, storage, actor, firmId, clientId, docType, filename, bankAccountId, objectKey, documentId, now } = args;
  if (!AUTO_IMPORT_DOC_TYPES.has(docType) || bankAccountId === null) return null;

  const ext = extensionOf(filename);
  if (ext === "xlsx") {
    return {
      status: "not_supported",
      detail: "Excel statements are not read automatically yet. Export the statement as CSV and upload that instead.",
    };
  }
  if (ext !== "csv") return null;

  const sequenceActor: RunActor = { userId: actor.userId, kind: "sequence" };
  const accounts = await deps.db.tx(readSession(actor, firmId, clientId), (tx) =>
    tx.query("bank_accounts_for_client", { firmId, clientId }),
  );
  const account = accounts.find((a) => a.id === bankAccountId);
  if (!account) return null;

  const obj = await storage.read(objectKey);
  if (!obj) return { status: "failed", detail: "The uploaded file could not be read back for parsing." };

  const scope: ParseFeedScope = {
    clientId,
    bankAccountId,
    batchName: filename,
    institutionName: account.institutionName,
    sourceFormat: "csv",
    fileText: obj.bytes.toString("utf8"),
    grid: null,
    sourceDocumentId: documentId,
  };
  const preview = await execute(deps.db, importParseFeed, scope, {
    mode: "preview",
    firmId,
    clientId,
    actor: sequenceActor,
    now,
    source: "sequence",
  });
  // "deduplicated" is a real terminal status, not a failure: the apply layer
  // matched this exact scope's idempotency key to one that already
  // completed, which is exactly the "already imported" case for a repeat
  // upload of the same file, and never reaches propose() to say so itself.
  const ok = (s: string) => s === "completed" || s === "completed_with_skips" || s === "no_op" || s === "deduplicated";
  const alreadyImported = (s: string) => s === "no_op" || s === "deduplicated";

  if (!ok(preview.status)) {
    const first = preview.result.errors[0] ?? null;
    if (first && MAPPING_FAILURE_CODES.has(first.code)) {
      await setMappingException(deps, sequenceActor, firmId, clientId, {
        clientId,
        bankAccountId,
        sourceDocumentId: documentId,
        institutionName: account.institutionName,
        sourceFormat: "csv",
        errorCode: first.code,
        errorMessage: first.message,
        resolved: false,
      }, now);
      return { status: "needs_mapping", detail: first.message };
    }
    return { status: "failed", detail: first ? first.message : "the parse was refused" };
  }
  if (alreadyImported(preview.status)) {
    return { status: "staged", detail: "this statement was already imported" };
  }

  const applied = await execute(deps.db, importParseFeed, scope, {
    mode: "apply",
    firmId,
    clientId,
    actor: sequenceActor,
    now,
    source: "sequence",
    previewRunId: preview.executionId,
  });
  if (alreadyImported(applied.status)) {
    return { status: "staged", detail: "this statement was already imported" };
  }
  if (!ok(applied.status)) {
    const first = applied.result.errors[0] ?? null;
    return { status: "failed", detail: first ? first.message : "the parse was refused" };
  }

  await setMappingException(deps, sequenceActor, firmId, clientId, {
    clientId,
    bankAccountId,
    sourceDocumentId: null,
    institutionName: account.institutionName,
    sourceFormat: "csv",
    errorCode: "RESOLVED",
    errorMessage: "a later parse for this account got past the mapping check",
    resolved: true,
  }, now);
  return { status: "staged", detail: null };
}

async function setMappingException(
  deps: ApiDeps,
  actor: RunActor,
  firmId: string,
  clientId: string,
  scope: FlagMappingNeededScope,
  now: Date,
): Promise<void> {
  const preview = await execute(deps.db, importFlagMappingNeeded, scope, {
    mode: "preview",
    firmId,
    clientId,
    actor,
    now,
    source: "sequence",
  });
  if (preview.status === "no_op") return;
  await execute(deps.db, importFlagMappingNeeded, scope, {
    mode: "apply",
    firmId,
    clientId,
    actor,
    now,
    source: "sequence",
    previewRunId: preview.executionId,
  });
}

export function createDocumentRoutes(args: { deps: ApiDeps; gate: RequestHandler }): Router {
  const { deps, gate } = args;
  const router = Router({ mergeParams: true });
  const maxBytes = uploadMaxBytes();

  const needStorage = (): DocumentStorage => {
    if (!deps.storage) {
      throw notConfigured("Document storage is not set up on this server. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    }
    return deps.storage;
  };

  // The ceiling applies before the body is read. express.raw answers 413 on
  // its own; the translator turns that into the envelope with payload_too_large.
  // On Netlify, req is serverless-http's reconstructed stream, which can only
  // be read once; by the time express.raw's own raw-body reader gets to it,
  // it reads empty. netlify/functions/api.ts attaches the original event as
  // __nfEvent for exactly this route, so the ceiling and the bytes both come
  // from there when it is present, and from express.raw itself otherwise
  // (the traditional server path, where no such property exists).
  const rawBody: RequestHandler = (req, res, next) => {
    const event = (req as unknown as { __nfEvent?: { body?: string | null; isBase64Encoded?: boolean } }).__nfEvent;
    if (!event) {
      express.raw({ type: () => true, limit: maxBytes })(req, res, next);
      return;
    }
    const raw = event.body ?? "";
    const bytes = event.isBase64Encoded ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8");
    if (bytes.length > maxBytes) {
      next(Object.assign(new Error("request entity too large"), { type: "entity.too.large", status: 413 }));
      return;
    }
    (req as unknown as { body: unknown }).body = bytes;
    next();
  };

  router.post("/documents", gate, rawBody, (req, res, next) => {
    (async () => {
      const storage = needStorage();
      const { actor, clientId, firmId, via } = clientOf(req);
      const meta = headerSchema.parse({
        filename: headerValue(req, "x-file-name"),
        docType: headerValue(req, "x-doc-type"),
        requestId: headerValue(req, "x-request-id"),
        bankAccountId: headerValue(req, "x-bank-account-id"),
        vendorId: headerValue(req, "x-vendor-id"),
        assetId: headerValue(req, "x-asset-id"),
        loanId: headerValue(req, "x-loan-id"),
      });
      const bytes = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
      const filename = safeFilename(meta.filename);
      if (!mimeForFilename(filename)) {
        throw new ApiFailure(400, "upload_rejected", "Only PDF, PNG, JPEG, CSV, and Excel files are accepted.");
      }
      const inspected = inspectUpload({ bytes, filename, declaredType: req.header("content-type") ?? null, maxBytes });
      if (!inspected.ok) {
        throw new ApiFailure(inspected.code === "too_large" ? 413 : 400, inspected.code === "too_large" ? "payload_too_large" : "upload_rejected", inspected.message);
      }

      const now = deps.now ? deps.now() : new Date();
      const documentId = ulid(now);
      const objectKey = `firm/${firmId}/client/${clientId}/${documentId}/${filename}`;
      const stored = await storage.put(objectKey, bytes, inspected.contentType);

      const body = await recordDocument({
        deps,
        storage,
        actor,
        firmId,
        clientId,
        via,
        documentId,
        objectKey: stored.objectKey,
        filename,
        docType: meta.docType,
        requestId: meta.requestId,
        bankAccountId: meta.bankAccountId,
        vendorId: meta.vendorId,
        assetId: meta.assetId,
        loanId: meta.loanId,
        inspected,
        byteSize: bytes.length,
        now,
      });
      res.status(201).json(body);
    })().catch(next);
  });

  /**
   * Step 1 of the direct upload path. Netlify's standard functions cap a
   * request body at 6 MB (about 4.5 MB once a binary body is base64 encoded),
   * well under this server's own 25 MiB default and the bucket's 100 MiB
   * ceiling, and well under what a multi page scan or a phone photo reaches.
   * This issues a short lived URL the browser writes directly to Supabase
   * Storage, bypassing that ceiling entirely. Only the memory store (local
   * development) has no such mechanism; callers fall back to the body route.
   */
  router.post("/documents/upload-url", gate, (req, res, next) => {
    (async () => {
      const storage = needStorage();
      const { actor, clientId, firmId } = clientOf(req);
      const body = uploadUrlBodySchema.parse(req.body);
      const filename = safeFilename(body.filename);
      if (!mimeForFilename(filename)) {
        throw new ApiFailure(400, "upload_rejected", "Only PDF, PNG, JPEG, CSV, and Excel files are accepted.");
      }
      const now = deps.now ? deps.now() : new Date();
      const documentId = ulid(now);
      const objectKey = `firm/${firmId}/client/${clientId}/${documentId}/${filename}`;
      const target = await storage.createUploadUrl(objectKey);
      if (!target) {
        throw notConfigured("This server's storage does not support a direct upload; send the file in the request body instead.");
      }
      await recordAuditEvent(deps, {
        actor,
        firmId,
        clientId,
        documentId: null,
        action: "presigned_put_issued",
        req,
        now,
        detail: { documentId, objectKey },
      });
      res.status(201).json({ documentId, objectKey, uploadUrl: target.url, bucket: storage.bucket });
    })().catch(next);
  });

  /**
   * Step 2. The browser has already written the object itself; nothing here
   * trusts that write. The bytes are read back from storage and run through
   * the same size, type, and magic byte inspection the body route applies
   * before any byte was accepted, scoped to the exact object key step 1
   * issued for this document id so a caller cannot finalize a path it was
   * never handed. A failed inspection removes the object, same as always.
   */
  router.post("/documents/:documentId/finalize", gate, (req, res, next) => {
    (async () => {
      const storage = needStorage();
      const { actor, clientId, firmId, via } = clientOf(req);
      const params = finalizeParamsSchema.parse({ clientId, documentId: req.params.documentId });
      const body = finalizeBodySchema.parse(req.body);
      const filename = safeFilename(body.filename);
      const expectedPrefix = `firm/${firmId}/client/${clientId}/${params.documentId}/`;
      if (!body.objectKey.startsWith(expectedPrefix)) {
        throw new ApiFailure(400, "upload_rejected", "The uploaded object does not match this request.");
      }
      const obj = await storage.read(body.objectKey);
      if (!obj) {
        throw new ApiFailure(400, "upload_rejected", "No object was found at the uploaded location. Upload the file again.");
      }
      const inspected = inspectUpload({ bytes: obj.bytes, filename, declaredType: obj.contentType, maxBytes });
      if (!inspected.ok) {
        await storage.remove(body.objectKey).catch(() => undefined);
        throw new ApiFailure(inspected.code === "too_large" ? 413 : 400, inspected.code === "too_large" ? "payload_too_large" : "upload_rejected", inspected.message);
      }

      const now = deps.now ? deps.now() : new Date();
      const result = await recordDocument({
        deps,
        storage,
        actor,
        firmId,
        clientId,
        via,
        documentId: params.documentId,
        objectKey: body.objectKey,
        filename,
        docType: body.docType,
        requestId: body.requestId ?? null,
        bankAccountId: body.bankAccountId ?? null,
        vendorId: body.vendorId ?? null,
        assetId: body.assetId ?? null,
        loanId: body.loanId ?? null,
        inspected,
        byteSize: obj.bytes.length,
        now,
      });
      res.status(201).json(result);
    })().catch(next);
  });

  router.get("/documents/:documentId/download", gate, (req, res, next) => {
    (async () => {
      const storage = needStorage();
      const { actor, clientId, firmId } = clientOf(req);
      const params = downloadParamsSchema.parse(req.params);
      const rows = await deps.db.tx(readSession(actor, firmId, clientId), (tx) =>
        tx.query("document_storage_by_id", { firmId, clientId, documentId: params.documentId }),
      );
      const doc = rows[0];
      if (!doc) throw notFound("document");
      if (doc.bucket !== storage.bucket) throw notConfigured("This document lives in a store this server is not connected to.");
      const now = deps.now ? deps.now() : new Date();
      const expiresInSeconds = 60;
      const url = await storage.signedUrl(doc.objectKey, expiresInSeconds);
      if (url) {
        await recordAuditEvent(deps, {
          actor,
          firmId,
          clientId,
          documentId: doc.id,
          action: "presigned_get_issued",
          req,
          now,
          presignedExpiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
        });
        res.json({ url, expiresInSeconds });
        return;
      }
      const obj = await storage.read(doc.objectKey);
      if (!obj) throw notFound("document");
      await recordAuditEvent(deps, {
        actor,
        firmId,
        clientId,
        documentId: doc.id,
        action: "download_completed",
        req,
        now,
      });
      res.setHeader("content-type", obj.contentType);
      res.setHeader("content-disposition", `attachment; filename="${doc.title.replace(/"/g, "")}"`);
      res.setHeader("cache-control", "private, no-store");
      res.send(obj.bytes);
    })().catch(next);
  });

  return router;
}
