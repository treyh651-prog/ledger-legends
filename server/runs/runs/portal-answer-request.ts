/**
 * PORTAL-ANSWER-REQUEST v1.
 *
 * The client answers an open portal request in words. Before this run the
 * portal requests screen read a fixture and the client could type into a box
 * nothing read. Now the answer is a run like everything else, with an intent
 * row and a preview the apply has to agree with, and the firm sees the answer
 * on the same row the suspense sweep opened.
 *
 * One proposal: a field write on ledger.portal_requests that stores the answer
 * and moves the request from open to satisfied. The status enumeration from
 * migration 0019 is unchanged, an answered request is a satisfied one. Only
 * portal requests are answered here. A document request wants a file, and no
 * file can arrive until object storage exists, so that screen says so instead.
 *
 * Idempotency. The scope carries the request id and the answer text, so the
 * same answer twice hashes the same and the engine deduplicates it. A request
 * that is already satisfied or waived is refused rather than overwritten,
 * because a person's earlier answer is a value a run may not change.
 *
 * Undo. The field write records the before image, so the standard undo plan
 * reopens the request and clears the answer.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type Run,
  type RunError,
  type RunResult,
} from "../contract";
import { ACTOR_PLACEHOLDER, NOW_PLACEHOLDER, applyProposals, requireTx } from "../apply-writer";
import { scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";

export const answerRequestScopeSchema = z.object({
  clientId: z.string().min(1),
  requestId: z.string().min(1),
  answer: z.string().trim().min(1).max(4000),
});

export type AnswerRequestScope = z.infer<typeof answerRequestScopeSchema>;

export const ERR_REQUEST_NOT_FOUND = "PORTAL-REQUEST-NOT-FOUND";
export const ERR_REQUEST_NOT_OPEN = "PORTAL-REQUEST-NOT-OPEN";

export const portalAnswerRequest: Run<AnswerRequestScope, Proposal> = {
  type: "PORTAL-ANSWER-REQUEST",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:portal-request:${scope.requestId}`,
  scopeSchema: answerRequestScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<AnswerRequestScope>> {
    const tx = requireTx(ctx);
    const rows = await tx.query("portal_requests_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const row = rows.find((r) => r.id === scope.requestId);
    const candidateIds = [scope.requestId];
    const versions = [{ id: "PORTAL-ANSWER-REQUEST", version: 1 }];
    const day = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: day,
      periodEnd: day,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [row ? row.status : "missing", scope.answer].join("/"),
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const rows = await tx.query("portal_requests_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const row = rows.find((r) => r.id === scope.requestId);
    if (!row) {
      errors.push({
        rowId: scope.requestId,
        code: ERR_REQUEST_NOT_FOUND,
        message: `portal request ${scope.requestId} is not one of this client's requests`,
        retryable: false,
      });
    } else if (row.status !== "open") {
      errors.push({
        rowId: scope.requestId,
        code: ERR_REQUEST_NOT_OPEN,
        message: `portal request ${scope.requestId} is ${row.status}, and an answer on record is not overwritten`,
        retryable: false,
      });
    }
    if (!row || errors.length > 0) {
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }
    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "portal_requests",
      rowId: row.id,
      before: {
        status: row.status,
        answer: row.answer,
        answeredAt: row.answeredAt,
        answeredBy: row.answeredBy,
      },
      after: {
        status: "satisfied",
        answer: scope.answer,
        answeredAt: NOW_PLACEHOLDER,
        answeredBy: ACTOR_PLACEHOLDER,
      },
      provenance: { cascadeLevel: null },
    };
    return makeResult<Proposal>(1, [write], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "PORTAL-ANSWER-REQUEST",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    return proposals.filter((p) => p.kind === "field_write").map(revertFieldWrite);
  },
};
