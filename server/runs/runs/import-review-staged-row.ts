/**
 * IMPORT-REVIEW-STAGED-ROW. A person accepts or rejects a staged row held for
 * review.
 *
 * Not one of doc 05's documented runs. import.staged_rows has carried
 * review_state, reviewed_by, and reviewed_at since migration 0009.
 * IMPORT-PARSE-FEED holds a row (dedup_state held_for_review, review_state
 * pending) whenever a bank feed gives no transaction id and the row looks
 * like a probable repeat of one already posted, and IMPORT-COMMIT-BATCH has
 * always refused to commit a held row until review_state reaches accepted.
 * Nothing ever moved review_state past pending: a bank feed without
 * transaction ids held every genuine repeat charge forever, with no way for
 * a bookkeeper to let it through.
 *
 * Two decisions:
 *   accept. The row is a real repeat, not a duplicate. dedup_state moves to
 *     confirmed_repeat, the value IMPORT-COMMIT-BATCH already reads to stamp
 *     the committed transaction's legitimate_repeat flag, so acceptance and
 *     commit agree on what the row is without a second lookup. review_state
 *     moves to accepted, which is the only thing IMPORT-COMMIT-BATCH's
 *     existing check requires to let the row through.
 *   reject. The row really is a duplicate. review_state moves to rejected.
 *     dedup_state is left at held_for_review, because IMPORT-COMMIT-BATCH
 *     checks dedup_state against rejected_duplicate first, and that reason
 *     names a parse time rejection; leaving dedup_state alone lets the
 *     second check, the one that names a reviewer's decision, be the one
 *     that fires.
 *
 * Both record who decided and when, the reviewed_by and reviewed_at columns
 * migration 0009 gave this table and nothing had ever written.
 *
 * Only a row still pending review, in a batch still waiting on its own
 * decision, can be reviewed. A row already decided, or a batch already
 * committed or rejected, is reported rather than rewritten.
 *
 * Posting: none. A review changes no ledger account.
 *
 * Manual tier: whether two same day, same amount charges are one purchase
 * repeated or two different ones is a judgment a person makes once, looking
 * at the statement, the same reasoning IMPORT-COMMIT-BATCH itself is not
 * unattended for.
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
import {
  ACTOR_PLACEHOLDER,
  applyProposals,
  NOW_PLACEHOLDER,
  requireTx,
} from "../apply-writer";
import { scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import { COMMITTABLE_STATUSES } from "./import-commit-batch";

export const REVIEW_ERROR_CODES = {
  unknownBatch: "UNKNOWN_IMPORT_BATCH",
  unknownRow: "UNKNOWN_STAGED_ROW",
} as const;

export const reviewStagedRowScopeSchema = z.object({
  clientId: z.string().min(1),
  batchId: z.string().min(1),
  stagedRowId: z.string().min(1),
  decision: z.enum(["accept", "reject"]),
});

export type ReviewStagedRowScope = z.infer<typeof reviewStagedRowScopeSchema>;

export const importReviewStagedRow: Run<ReviewStagedRowScope, Proposal> = {
  type: "IMPORT-REVIEW-STAGED-ROW",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.stagedRowId}`,
  scopeSchema: reviewStagedRowScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ReviewStagedRowScope>> {
    const tx = requireTx(ctx);
    const batches = await tx.query("import_batch_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      batchId: scope.batchId,
    });
    const rows = await tx.query("staged_rows_by_batch", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      batchId: scope.batchId,
    });
    const row = rows.find((r) => r.id === scope.stagedRowId);
    const candidateIds = row ? [row.id] : [];
    const runDay = ctx.now.toISOString().slice(0, 10);
    const versions = [
      { id: "IMPORT-REVIEW-STAGED-ROW", version: 1 },
      ...batches.map((b) => ({ id: b.id, version: b.version })),
      ...(row ? [{ id: row.id, version: row.version }] : []),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: runDay,
      periodEnd: runDay,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions, period: scope.decision }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const skips: Skip[] = [];

    const refuse = (code: string, message: string): RunResult<Proposal> => {
      errors.push({ rowId: scope.stagedRowId, code, message, retryable: false });
      return makeResult<Proposal>(frozen.candidateIds.length, [], skips, errors, BigInt(0));
    };

    const batches = await tx.query("import_batch_by_id", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      batchId: scope.batchId,
    });
    const batch = batches[0];
    if (!batch) {
      return refuse(
        REVIEW_ERROR_CODES.unknownBatch,
        `import batch ${scope.batchId} does not exist for client ${frozen.clientId}`,
      );
    }

    const rows = await tx.query("staged_rows_by_batch", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      batchId: scope.batchId,
    });
    const row = rows.find((r) => r.id === scope.stagedRowId);
    if (!row) {
      return refuse(
        REVIEW_ERROR_CODES.unknownRow,
        `staged row ${scope.stagedRowId} does not exist in batch ${scope.batchId}`,
      );
    }

    if (!COMMITTABLE_STATUSES.some((s) => s === batch.status)) {
      skips.push({
        rowId: row.id,
        reason: "already_applied",
        detail: `batch ${batch.id} is already ${batch.status} and is no longer waiting on a decision`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, [], skips, [], BigInt(0));
    }

    if (row.dedupState !== "held_for_review" || row.reviewState !== "pending") {
      skips.push({
        rowId: row.id,
        reason: "already_applied",
        detail: `row ${row.id} is not waiting on review, dedup_state ${row.dedupState} review_state ${row.reviewState}`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, [], skips, [], BigInt(0));
    }

    const after =
      scope.decision === "accept"
        ? { dedupState: "confirmed_repeat" as const, reviewState: "accepted" as const }
        : { dedupState: row.dedupState, reviewState: "rejected" as const };
    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "staged_rows",
      rowId: row.id,
      before: {
        dedupState: row.dedupState,
        reviewState: row.reviewState,
        reviewedBy: row.reviewedBy,
        reviewedAt: row.reviewedAt,
      },
      after: {
        ...after,
        reviewedBy: ACTOR_PLACEHOLDER,
        reviewedAt: NOW_PLACEHOLDER,
      },
      provenance: { cascadeLevel: null },
    };
    return makeResult<Proposal>(frozen.candidateIds.length, [write], skips, [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "IMPORT-REVIEW-STAGED-ROW",
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
