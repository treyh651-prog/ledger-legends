/**
 * ENG-SET-BILLING-STATUS, version 1.
 *
 * A person at the firm marks a client's engagement current or past due on
 * what the client owes the firm for the bookkeeping engagement itself.
 * Deliberately not a billing subsystem (migration 0032, which also recorded
 * why): no amounts, no invoice rows, no payment history, no processor of any
 * kind, just the one state a person sets by hand. The client's portal may
 * read this single field and nothing else about the engagement's billing.
 *
 * Manual tier: this is a decision a person at the firm makes on purpose,
 * never something a clock infers from a payment event, because there is no
 * payment event in this system to infer it from.
 *
 * One field write, no ledger rows, no document, no undo plan beyond the
 * standard field write reversal.
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
import { applyProposals, requireTx } from "../apply-writer";
import { scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { EngagementRow } from "../tables";

export const setBillingStatusScopeSchema = z.object({
  clientId: z.string().min(1),
  engagementId: z.string().min(1),
  billingStatus: z.enum(["current", "past_due"]),
});

export type SetBillingStatusScope = z.infer<typeof setBillingStatusScopeSchema>;

export const ERR_ENGAGEMENT_NOT_FOUND = "ENG-BILLING-ENGAGEMENT-NOT-FOUND";

export const engSetBillingStatus: Run<SetBillingStatusScope, Proposal> = {
  type: "ENG-SET-BILLING-STATUS",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:billing-status`,
  scopeSchema: setBillingStatusScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<SetBillingStatusScope>> {
    const tx = requireTx(ctx);
    const rows = await tx.query("engagements_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const engagement = rows.find((e) => e.id === scope.engagementId) ?? null;
    const candidateIds = [scope.engagementId];
    const versions = [{ id: "ENG-SET-BILLING-STATUS", version: 1 }];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [engagement ? engagement.billingStatus : "missing", scope.billingStatus].join("/"),
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];

    const rows = await tx.query("engagements_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const engagement: EngagementRow | undefined = rows.find((e) => e.id === scope.engagementId);
    if (!engagement) {
      errors.push({
        rowId: scope.engagementId,
        code: ERR_ENGAGEMENT_NOT_FOUND,
        message: `engagement ${scope.engagementId} does not belong to client ${scope.clientId}`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }
    if (engagement.billingStatus === scope.billingStatus) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: engagement.id, reason: "already_applied", detail: `billing status is already ${scope.billingStatus}` }],
        [],
        BigInt(0),
      );
    }
    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "engagements",
      rowId: engagement.id,
      before: { billingStatus: engagement.billingStatus },
      after: { billingStatus: scope.billingStatus },
      provenance: { cascadeLevel: null },
    };
    return makeResult<Proposal>(1, [write], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "ENG-SET-BILLING-STATUS", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    return proposals.filter((p) => p.kind === "field_write").map(revertFieldWrite);
  },
};
