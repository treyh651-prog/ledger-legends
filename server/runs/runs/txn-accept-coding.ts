/**
 * TXN-ACCEPT-CODING. A person confirms a rule coded one or more transactions
 * right. Manual tier -- this is a bookkeeper's judgment, not something a
 * clock infers.
 *
 * ledger.rules has carried accepted_count since migration 0021 and
 * TXN-APPLY-RULES's own autoPostAllowed (txn-apply-rules.ts) has read it,
 * alongside rejected_count/autoPostEnabled/autoPostEnabledBy, since before
 * this round -- nothing has ever written accepted_count, so the promotion
 * gate has been dead code. This run is the first writer.
 *
 * Bulk, not one call per transaction: the scope takes an array, the same
 * shape SETUP-IMPORT-BALANCES's lines already use, so a bookkeeper
 * reviewing a page of correctly-coded transactions clears all of them in
 * one preview/apply round trip. Several transactions in the same batch can
 * share a winning rule, so accepted_count is tallied in-run exactly the way
 * TXN-APPLY-RULES already tallies hit_count (hitTally there, acceptedTally
 * here) -- without it, every field write for that rule would read the same
 * stale before value and overwrite each other down to a single increment.
 *
 * Promotion is automatic. The moment a rule's tallied counts first satisfy
 * acceptedCount >= RULE_PROMOTION_MIN_ACCEPTED (imported from
 * txn-apply-rules.ts, not re-declared) and rejectedCount === 0, this run
 * folds autoPostEnabled: true, autoPostEnabledBy: ACTOR_PLACEHOLDER into
 * that same rule's field write. No separate click -- the user chose fully
 * automatic promotion in both directions over this round's course.
 */

import { z } from "zod";
import {
  makeResult,
  isFieldWrite,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
} from "../contract";
import { ACTOR_PLACEHOLDER, NOW_PLACEHOLDER, applyProposals, requireTx } from "../apply-writer";
import { revertFieldWrite } from "../undo";
import { scopeHashFor } from "../ids";
import type { RuleRow, TransactionRow } from "../tables";
import { RULE_PROMOTION_MIN_ACCEPTED } from "./txn-apply-rules";

export const acceptCodingScopeSchema = z.object({
  clientId: z.string().min(1),
  transactionIds: z.array(z.string().min(1)).min(1),
});

export type AcceptCodingScope = z.infer<typeof acceptCodingScopeSchema>;

interface RuleTally {
  acceptedCount: number;
  rejectedCount: number;
  autoPostEnabled: boolean;
  autoPostEnabledByBefore: string | null;
}

export const txnAcceptCoding: Run<AcceptCodingScope, Proposal> = {
  type: "TXN-ACCEPT-CODING",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:txn-accept-coding`,
  scopeSchema: acceptCodingScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<AcceptCodingScope>> {
    const tx = requireTx(ctx);
    const transactions = await tx.query("transactions_by_ids", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      ids: scope.transactionIds,
    });
    const dates = transactions.map((t) => t.postedDate).sort();
    const today = ctx.now.toISOString().slice(0, 10);
    const candidateIds = [...scope.transactionIds];
    const versions = [
      { id: "TXN-ACCEPT-CODING", version: 1 },
      ...transactions.map((t) => ({ id: t.id, version: t.version })),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: dates[0] ?? today,
      periodEnd: dates[dates.length - 1] ?? today,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const transactions = await tx.query("transactions_by_ids", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      ids: scope.transactionIds,
    });
    const byId = new Map<string, TransactionRow>(transactions.map((t) => [t.id, t]));

    const ruleIds = new Set<string>();
    for (const id of scope.transactionIds) {
      const t = byId.get(id);
      if (t && t.ruleId !== null) ruleIds.add(t.ruleId);
    }
    const rules = new Map<string, RuleRow>();
    for (const ruleId of ruleIds) {
      const rows = await tx.query("rule_by_id", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        ruleId,
      });
      if (rows[0]) rules.set(ruleId, rows[0]);
    }

    // Running tallies, not stored values: several transactions in this batch
    // can share a winning rule, and a field write computed from the same
    // stale before value for each one would overwrite the others.
    const tally = new Map<string, RuleTally>();
    const tallyFor = (ruleId: string): RuleTally => {
      const existing = tally.get(ruleId);
      if (existing) return existing;
      const rule = rules.get(ruleId);
      const fresh: RuleTally = {
        acceptedCount: rule?.acceptedCount ?? 0,
        rejectedCount: rule?.rejectedCount ?? 0,
        autoPostEnabled: rule?.autoPostEnabled ?? false,
        autoPostEnabledByBefore: rule?.autoPostEnabledBy ?? null,
      };
      tally.set(ruleId, fresh);
      return fresh;
    };

    for (const id of scope.transactionIds) {
      const t = byId.get(id);
      if (!t) {
        skips.push({ rowId: id, reason: "missing_prerequisite", detail: "transaction not found" });
        continue;
      }
      if (t.voided) {
        skips.push({ rowId: id, reason: "missing_prerequisite", detail: "transaction is voided" });
        continue;
      }
      if (t.ruleId === null) {
        skips.push({ rowId: id, reason: "missing_prerequisite", detail: "not rule-coded" });
        continue;
      }
      if (t.ruleReviewedAt !== null) {
        skips.push({ rowId: id, reason: "already_applied", detail: "already reviewed" });
        continue;
      }

      proposals.push({
        kind: "field_write",
        table: "transactions",
        rowId: t.id,
        before: { ruleReviewedAt: t.ruleReviewedAt, ruleReviewOutcome: t.ruleReviewOutcome },
        after: { ruleReviewedAt: NOW_PLACEHOLDER, ruleReviewOutcome: "accepted" },
        provenance: { cascadeLevel: null },
      });

      const before = tallyFor(t.ruleId);
      before.acceptedCount += 1;
    }

    for (const [ruleId, counted] of tally) {
      const rule = rules.get(ruleId);
      if (!rule) continue;
      const promotes =
        !counted.autoPostEnabled &&
        counted.acceptedCount >= RULE_PROMOTION_MIN_ACCEPTED &&
        counted.rejectedCount === 0;
      const write: ProposedFieldWrite = {
        kind: "field_write",
        table: "rules",
        rowId: ruleId,
        before: { acceptedCount: rule.acceptedCount, autoPostEnabled: rule.autoPostEnabled, autoPostEnabledBy: rule.autoPostEnabledBy },
        after: {
          acceptedCount: counted.acceptedCount,
          ...(promotes ? { autoPostEnabled: true, autoPostEnabledBy: ACTOR_PLACEHOLDER } : {}),
        },
        provenance: { cascadeLevel: null },
      };
      proposals.push(write);
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "TXN-ACCEPT-CODING", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    return proposals.filter(isFieldWrite).map((p) => revertFieldWrite(p));
  },
};
