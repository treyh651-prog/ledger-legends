/**
 * DOC-RECORD-UPLOAD v1. NOTES 256.
 *
 * One row in docvault.documents for one object the upload route has already
 * stored. The route owns the order: inspect the bytes, write the object, then
 * trigger this run; if this run fails the route removes the object, so a
 * document never exists in one place only. The row says status uploaded,
 * magic_verified true, scan_status not_scanned (migration 0031 allows that for
 * Supabase Storage, which has no scanner in the path), head_verified_at now
 * because the storage API acknowledged the object before the run began.
 *
 * The id is minted by the route because the object key carries it and the key
 * is written before the row. Preview and apply therefore agree by construction.
 * uploaded_by is the actor, stamped by the apply writer, never from the body.
 *
 * Undo. Deleting a record while the object stays would orphan bytes, so
 * undoPlan is empty. Archiving is a separate action.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunResult,
} from "../contract";
import { ACTOR_PLACEHOLDER, NOW_PLACEHOLDER, applyProposals, requireTx } from "../apply-writer";
import { scopeHashFor } from "../ids";
import type { DocumentRow } from "../tables";

export const recordUploadScopeSchema = z.object({
  clientId: z.string().min(1),
  documentId: z.string().length(26),
  docType: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(200),
  bucket: z.string().min(1),
  objectKey: z.string().min(1),
  storageProvider: z.enum(["supabase", "memory"]),
  byteSize: z.number().int().positive(),
  contentType: z.string().min(1),
  sha256Hex: z.string().length(64),
  requestId: z.string().min(1).nullable(),
});

export type RecordUploadScope = z.infer<typeof recordUploadScopeSchema>;

export const docRecordUpload: Run<RecordUploadScope, Proposal> = {
  type: "DOC-RECORD-UPLOAD",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:documents`,
  scopeSchema: recordUploadScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<RecordUploadScope>> {
    requireTx(ctx);
    const candidateIds = [scope.documentId];
    const versions = [{ id: "DOC-RECORD-UPLOAD", version: 1 }];
    const day = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: day,
      periodEnd: day,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions, period: scope.sha256Hex }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    requireTx(ctx);
    const scope = frozen.input;
    const row: DocumentRow = {
      id: scope.documentId,
      firmId: ctx.firmId,
      clientId: scope.clientId,
      docType: scope.docType,
      title: scope.title,
      periodStart: null,
      periodEnd: null,
      status: "uploaded",
      byteSize: scope.byteSize,
      contentType: scope.contentType,
      sha256Hex: scope.sha256Hex,
      requestId: scope.requestId,
      uploadedAt: NOW_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      bucket: scope.bucket,
      objectKey: scope.objectKey,
      // The memory provider is development only; its rows are labelled supabase
      // shaped so the same check constraints apply when the memory port mirrors them.
      kmsKeyAlias: scope.storageProvider === "supabase" ? "supabase-managed" : "none",
      objectLockMode: null,
      uploadedBy: ACTOR_PLACEHOLDER,
      scanStatus: "not_scanned",
      magicVerified: true,
      headVerifiedAt: NOW_PLACEHOLDER,
      storageProvider: "supabase",
    };
    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "documents",
      rowId: row.id,
      row: row as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };
    return makeResult<Proposal>(1, [insert], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "DOC-RECORD-UPLOAD", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
