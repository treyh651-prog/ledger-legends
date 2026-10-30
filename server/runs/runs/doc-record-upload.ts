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
 * bankAccountId, migration 0045, and vendorId, assetId, and loanId, migration
 * 0047. A bank or card statement names which account it is a statement for, a
 * bill from a vendor names the vendor, a receipt names the fixed asset it
 * documents the purchase of, and a loan agreement names the loan, the same
 * way linked_transaction_id already lets a document point at a transaction.
 * Each is refused outright, before anything is written, when the named row
 * does not belong to this client, which is the one tenant boundary a client
 * actor could otherwise reach through: the id travels in the body of a run a
 * client is allowed to trigger.
 *
 * Undo. Deleting a record while the object stays would orphan bytes, so
 * undoPlan is empty. Archiving is a separate action.
 *
 * Alongside the document row, one docvault.audit_events row, action
 * row_created. The table has carried the document access log since
 * migration 0008 and nothing had ever written to it.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
} from "../contract";
import {
  ACTOR_KIND_PLACEHOLDER,
  ACTOR_PLACEHOLDER,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  applyProposals,
  requireTx,
} from "../apply-writer";
import type { RunTx } from "../db";
import { derivedId, scopeHashFor } from "../ids";
import type { AuditEventRow, DocumentRow } from "../tables";

export const RECORD_UPLOAD_ERROR_CODES = {
  unknownBankAccount: "UNKNOWN_BANK_ACCOUNT",
  unknownVendor: "UNKNOWN_VENDOR",
  unknownAsset: "UNKNOWN_FIXED_ASSET",
  unknownLoan: "UNKNOWN_LOAN",
} as const;

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
  bankAccountId: z.string().min(1).nullable().default(null),
  vendorId: z.string().min(1).nullable().default(null),
  assetId: z.string().min(1).nullable().default(null),
  loanId: z.string().min(1).nullable().default(null),
});

export type RecordUploadScope = z.infer<typeof recordUploadScopeSchema>;

/**
 * One tenant check, reused for each of the four optional links. Returns the
 * error to push, or null when the id is absent or belongs to this client.
 */
async function foreignTenantError(
  tx: RunTx,
  firmId: string,
  clientId: string,
  documentId: string,
  id: string | null,
  query: "bank_accounts_for_client" | "vendors_for_client" | "fixed_assets_for_client" | "loans_for_client",
  code: string,
  noun: string,
): Promise<RunError | null> {
  if (id === null) return null;
  const rows = await tx.query(query, { firmId, clientId });
  if (rows.some((r) => r.id === id)) return null;
  return {
    rowId: documentId,
    code,
    message: `${noun} ${id} does not belong to client ${clientId}`,
    retryable: false,
  };
}

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
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];

    const linkChecks = [
      [scope.bankAccountId, "bank_accounts_for_client", RECORD_UPLOAD_ERROR_CODES.unknownBankAccount, "bank account"],
      [scope.vendorId, "vendors_for_client", RECORD_UPLOAD_ERROR_CODES.unknownVendor, "vendor"],
      [scope.assetId, "fixed_assets_for_client", RECORD_UPLOAD_ERROR_CODES.unknownAsset, "fixed asset"],
      [scope.loanId, "loans_for_client", RECORD_UPLOAD_ERROR_CODES.unknownLoan, "loan"],
    ] as const;
    for (const [id, query, code, noun] of linkChecks) {
      const error = await foreignTenantError(tx, ctx.firmId, scope.clientId, scope.documentId, id, query, code, noun);
      if (error) {
        errors.push(error);
        return makeResult<Proposal>(1, [], [], errors, BigInt(0));
      }
    }

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
      linkedBankAccountId: scope.bankAccountId,
      linkedVendorId: scope.vendorId,
      linkedAssetId: scope.assetId,
      linkedLoanId: scope.loanId,
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

    // docvault.audit_events has carried the document access log since
    // migration 0008 and nothing ever wrote a row to it. This is the one
    // event this run can attest to: the row it just created.
    const auditEvent: AuditEventRow = {
      id: derivedId(scope.documentId, "audit-event-row-created", 0),
      clientId: scope.clientId,
      firmId: ctx.firmId,
      documentId: scope.documentId,
      action: "row_created",
      actorId: ACTOR_PLACEHOLDER,
      actorKind: ACTOR_KIND_PLACEHOLDER,
      presignedExpiresAt: null,
      ipInet: null,
      userAgent: null,
      runId: RUN_ID_PLACEHOLDER,
      detail: {},
      createdAt: NOW_PLACEHOLDER,
    };
    const auditInsert: ProposedRowInsert = {
      kind: "row_insert",
      table: "audit_events",
      rowId: auditEvent.id,
      row: auditEvent as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };
    return makeResult<Proposal>(1, [insert, auditInsert], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "DOC-RECORD-UPLOAD", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
