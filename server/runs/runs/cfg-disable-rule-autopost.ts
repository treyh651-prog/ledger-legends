/**
 * CFG-DISABLE-RULE-AUTOPOST. A person revokes a rule's auto post privilege.
 * Manual tier. No threshold check -- unlike promotion, which only
 * TXN-ACCEPT-CODING grants automatically once a rule earns it, a person can
 * always take the privilege back without needing to manufacture a reject
 * first, the same way every other on/off state in this app (category and
 * rule isActive, for example) has an explicit off switch.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type Run,
  type RunResult,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { revertFieldWrite } from "../undo";
import { scopeHashFor } from "../ids";

export const disableRuleAutopostScopeSchema = z.object({
  clientId: z.string().min(1),
  ruleId: z.string().min(1),
});

export type DisableRuleAutopostScope = z.infer<typeof disableRuleAutopostScopeSchema>;

export const cfgDisableRuleAutopost: Run<DisableRuleAutopostScope, Proposal> = {
  type: "CFG-DISABLE-RULE-AUTOPOST",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:rule:${scope.ruleId}`,
  scopeSchema: disableRuleAutopostScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<DisableRuleAutopostScope>> {
    const tx = requireTx(ctx);
    const rows = await tx.query("rule_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      ruleId: scope.ruleId,
    });
    const rule = rows[0] ?? null;
    const candidateIds = [scope.ruleId];
    const versions = [
      { id: "CFG-DISABLE-RULE-AUTOPOST", version: 1 },
      ...(rule ? [{ id: rule.id, version: rule.version }] : []),
    ];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const rows = await tx.query("rule_by_id", {
      firmId: frozen.firmId,
      clientId: scope.clientId,
      ruleId: scope.ruleId,
    });
    const rule = rows[0];
    if (!rule) {
      return makeResult<Proposal>(
        1,
        [],
        [],
        [{ rowId: scope.ruleId, code: "CFG_DISABLE_AUTOPOST_UNKNOWN_RULE", message: `rule ${scope.ruleId} does not belong to client ${scope.clientId}`, retryable: false }],
        BigInt(0),
      );
    }
    if (!rule.autoPostEnabled) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: rule.id, reason: "already_applied", detail: "auto post is already off" }],
        [],
        BigInt(0),
      );
    }

    return makeResult<Proposal>(
      1,
      [
        {
          kind: "field_write",
          table: "rules",
          rowId: rule.id,
          before: { autoPostEnabled: rule.autoPostEnabled, autoPostEnabledBy: rule.autoPostEnabledBy },
          after: { autoPostEnabled: false, autoPostEnabledBy: null },
          provenance: { cascadeLevel: null },
        },
      ],
      [],
      [],
      BigInt(0),
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-DISABLE-RULE-AUTOPOST", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    return proposals.map((p) => revertFieldWrite(p));
  },
};
