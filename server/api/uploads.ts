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
import { UPLOAD_DOC_TYPES, mimeForFilename, safeFilename } from "../../shared/uploads";
import type { PortalDocument, UploadDocumentResult } from "../../shared/api";
import type { DocumentRow } from "../runs/tables";
import { ulid } from "../runs/ids";
import { ApiFailure, notConfigured, notFound } from "./errors";
import { readSession } from "./session";
import { triggerRun } from "./runs";
import type { ApiDeps } from "./router";
import { inspectUpload, type DocumentStorage, uploadMaxBytes } from "../storage/document-storage";

const DOC_TYPE_IDS = new Set(UPLOAD_DOC_TYPES.map((t) => t.id));

const headerSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  docType: z.string().refine((v) => DOC_TYPE_IDS.has(v), "unknown document type"),
  requestId: z.string().trim().min(1).max(64).nullable(),
});

const downloadParamsSchema = z.object({ clientId: z.string().min(1), documentId: z.string().length(26) });

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
  const rawBody = express.raw({ type: () => true, limit: maxBytes });

  router.post("/documents", gate, rawBody, (req, res, next) => {
    (async () => {
      const storage = needStorage();
      const { actor, clientId, firmId, via } = clientOf(req);
      const meta = headerSchema.parse({
        filename: headerValue(req, "x-file-name"),
        docType: headerValue(req, "x-doc-type"),
        requestId: headerValue(req, "x-request-id"),
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

      const scope = {
        clientId,
        documentId,
        docType: meta.docType,
        title: filename,
        bucket: stored.bucket,
        objectKey: stored.objectKey,
        storageProvider: storage.provider,
        byteSize: bytes.length,
        contentType: inspected.contentType,
        sha256Hex: inspected.sha256Hex,
        requestId: meta.requestId,
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
        if (!recorded) await storage.remove(stored.objectKey).catch(() => undefined);
      }

      const rows = await deps.db.tx(readSession(actor, firmId, clientId), (tx) => tx.query("document_by_id", { firmId, clientId, documentId }));
      const row = rows[0];
      if (!row) {
        await storage.remove(stored.objectKey).catch(() => undefined);
        throw new ApiFailure(500, "internal", "The document record could not be read back.");
      }
      const body: UploadDocumentResult = { document: documentDto(row), done: true };
      res.status(201).json(body);
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
      const expiresInSeconds = 60;
      const url = await storage.signedUrl(doc.objectKey, expiresInSeconds);
      if (url) {
        res.json({ url, expiresInSeconds });
        return;
      }
      const obj = await storage.read(doc.objectKey);
      if (!obj) throw notFound("document");
      res.setHeader("content-type", obj.contentType);
      res.setHeader("content-disposition", `attachment; filename="${doc.title.replace(/"/g, "")}"`);
      res.setHeader("cache-control", "private, no-store");
      res.send(obj.bytes);
    })().catch(next);
  });

  return router;
}
