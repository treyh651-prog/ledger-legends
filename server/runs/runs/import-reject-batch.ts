/**
 * IMPORT-REJECT-BATCH. A person decides a staged batch should not be committed.
 *
 * Not one of doc 05's documented runs. import.batches has carried a rejected
 * status and a reject_reason column since migration 0009, with a check
 * constraint that a rejected batch must give its reason, and nothing in the
 * original pipeline ever wrote either one: IMPORT-PARSE-FEED only ever
 * produces parsed or in_review, and IMPORT-COMMIT-BATCH only ever produces
 * committed. A batch a bookkeeper decides was the wrong account, the wrong
 * statement, or simply not needed had no way off the staged statements list.
 *
 * Only a batch still waiting on a decision can be rejected. A committed batch
 * is reversed instead, which is a different decision with a different cost,
 * and a batch already rejected or reversed is reported rather than rewritten.
 *
 * Posting: none. Rejecting a batch that never reached the register touches no
 * ledger account, so writesLedger is false and no open period is required.
 *
 * Manual tier: which staged statement to throw out is a decision a person
 * makes once, looking at the mapping, the same reasoning IMPORT-COMMIT-BATCH
 * itself is manual rather than unattended for.
 */

import { z } from "zod";
import {
  isFieldWrite,
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import { COMMITTABLE_STATUSES } from "./import-commit-batch";

export const REJECT_ERROR_CODES = {
  unknownBatch: "UNKNOWN_IMPORT_BATCH",
  batchNotPending: "IMPORT_BATCH_NOT_PENDING",
} as const;

export const rejectBatchScopeSchema = z.object({
  clientId: z.string().min(1),
  batchId: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
});

export type RejectBatchScope = z.infer<typeof rejectBatchScopeSchema>;

export const importRejectBatch: Run<RejectBatchScope, Proposal> = {
  type: "IMPORT-REJECT-BATCH",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.batchId}`,
  scopeSchema: rejectBatchScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<RejectBatchScope>> {
    const tx = requireTx(ctx);
    const batches = await tx.query("import_batch_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      batchId: scope.batchId,
    });
    const candidateIds = batches.map((b) => b.id);
    const runDay = ctx.now.toISOString().slice(0, 10);
    const versions = [
      { id: "IMPORT-REJECT-BATCH", version: 1 },
      ...batches.map((b) => ({ id: b.id, version: b.version })),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: runDay,
      periodEnd: runDay,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions, period: scope.reason }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const skips: Skip[] = [];

    const batches = await tx.query("import_batch_by_id", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      batchId: scope.batchId,
    });
    if (batches.length === 0) {
      errors.push({
        rowId: scope.batchId,
        code: REJECT_ERROR_CODES.unknownBatch,
        message: `import batch ${scope.batchId} does not exist for client ${frozen.clientId}`,
        retryable: false,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, [], skips, errors, BigInt(0));
    }
    const batch = batches[0];

    if (!COMMITTABLE_STATUSES.some((s) => s === batch.status)) {
      skips.push({
        rowId: batch.id,
        reason: "already_applied",
        detail: `batch ${batch.id} is already ${batch.status} and is no longer waiting on a decision`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, [], skips, [], BigInt(0));
    }

    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "import_batches",
      rowId: batch.id,
      before: { status: batch.status, rejectReason: batch.rejectReason },
      after: { status: "rejected", rejectReason: scope.reason },
      provenance: { cascadeLevel: null },
    };
    return makeResult<Proposal>(frozen.candidateIds.length, [write], skips, [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "IMPORT-REJECT-BATCH",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};
