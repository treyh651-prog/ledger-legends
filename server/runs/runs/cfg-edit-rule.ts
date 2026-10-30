/**
 * CFG-EDIT-RULE, version 1.
 *
 * A person at the firm changes a rule's name, priority, conditions, target
 * category, or any of the other fields on ledger.rules. Manual tier for the
 * same reason TXN-APPLY-RULES itself is: a rule is configurable by a user and
 * therefore capable of encoding a mistake at scale, so changing one is a
 * decision a person makes on purpose.
 *
 * Doc 02 Part D's rule promotion condition 2, verbatim: "Editing the rule
 * resets both counters to zero and clears auto_post_enabled." Any field that
 * actually changes resets acceptedCount and rejectedCount to zero and clears
 * autoPostEnabled; autoPostEnabledBy is cleared alongside it, since a stale
 * approver's id on a flag that is no longer true is not provenance worth
 * keeping.
 *
 * conditionCount is never a field a caller sets directly. It is denormalized
 * from conditions.length (doc 00 Part 3's tie break input, and the live
 * rule_count_matches check migration 0004 enforces), so it is recomputed
 * here whenever conditions changes rather than trusted from the scope.
 *
 * ledger.rule_versions has carried the history shape since migration 0004
 * and nothing has ever written to it; this run is the first writer, and the
 * first edit of any rule also backfills a version 1 snapshot of the row as
 * it stood before this edit.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
} from "../contract";
import {
  ACTOR_PLACEHOLDER,
  NOW_PLACEHOLDER,
  applyProposals,
  requireTx,
} from "../apply-writer";
import { scopeHashFor, canonicalJson } from "../ids";
import { revertFieldWrite } from "../undo";
import type { RuleCondition, RuleRow } from "../tables";

export const ruleConditionSchema: z.ZodType<RuleCondition> = z.union([
  z.object({ type: z.literal("vendor_equals"), value: z.string().min(1) }),
  z.object({ type: z.literal("vendor_prefix"), value: z.string().min(1) }),
  z.object({
    type: z.literal("amount_range"),
    minCents: z.bigint().nonnegative(),
    maxCents: z.bigint().nonnegative(),
  }),
  z.object({ type: z.literal("sign"), value: z.enum(["debit", "credit"]) }),
  z.object({ type: z.literal("bank_account"), value: z.string().min(1) }),
  z.object({ type: z.literal("bank_code"), value: z.string().min(1) }),
]);

export const editableRuleFieldsSchema = z.object({
  name: z.string().min(1).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  conditions: z.array(ruleConditionSchema).min(1).optional(),
  targetCategoryId: z.string().min(1).optional(),
  targetClassId: z.string().min(1).nullable().optional(),
  scopeKind: z.enum(["client", "firm_library"]).optional(),
  effectiveFrom: z.string().nullable().optional(),
  effectiveTo: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const editRuleScopeSchema = z.object({
  clientId: z.string().min(1),
  ruleId: z.string().min(1),
  changeNote: z.string().min(1),
  fields: editableRuleFieldsSchema,
});

export type EditRuleScope = z.infer<typeof editRuleScopeSchema>;

export const ERR_RULE_NOT_FOUND = "CFG-RULE-NOT-FOUND";
export const BACKFILL_CHANGE_NOTE = "initial version, backfilled on first edit";

/** Cents and arrays of conditions need their own equality, bigint included. */
function valueChanged(current: unknown, next: unknown): boolean {
  if (Array.isArray(current) || Array.isArray(next)) {
    return canonicalJson(current) !== canonicalJson(next);
  }
  return current !== next;
}

function changedFields(
  current: RuleRow,
  fields: z.infer<typeof editableRuleFieldsSchema>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const key = k as keyof RuleRow;
    if (valueChanged(current[key], v)) {
      before[key] = current[key];
      after[key] = v;
    }
  }
  if ("conditions" in after) {
    before.conditionCount = current.conditionCount;
    after.conditionCount = (after.conditions as RuleCondition[]).length;
  }
  return { before, after };
}

export const cfgEditRule: Run<EditRuleScope, Proposal> = {
  type: "CFG-EDIT-RULE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:rule:${scope.ruleId}`,
  scopeSchema: editRuleScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<EditRuleScope>> {
    const tx = requireTx(ctx);
    const rows = await tx.query("rule_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      ruleId: scope.ruleId,
    });
    const rule = rows[0] ?? null;
    const candidateIds = [scope.ruleId];
    const versions = [{ id: "CFG-EDIT-RULE", version: 1 }];
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
        period: [
          rule ? String(rule.version) : "missing",
          canonicalJson(scope.fields),
        ].join("/"),
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];

    const rows = await tx.query("rule_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      ruleId: scope.ruleId,
    });
    const rule: RuleRow | undefined = rows[0];
    if (!rule) {
      errors.push({
        rowId: scope.ruleId,
        code: ERR_RULE_NOT_FOUND,
        message: `rule ${scope.ruleId} does not belong to client ${scope.clientId}`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const { before, after } = changedFields(rule, scope.fields);
    if (Object.keys(after).length === 0) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: rule.id, reason: "already_applied", detail: "every named field already has this value" }],
        [],
        BigInt(0),
      );
    }

    // Doc 02 Part D condition 2. Any real change resets the promotion state;
    // a rule has to re-earn auto post from zero under its new definition.
    before.acceptedCount = rule.acceptedCount;
    before.rejectedCount = rule.rejectedCount;
    before.autoPostEnabled = rule.autoPostEnabled;
    before.autoPostEnabledBy = rule.autoPostEnabledBy;
    after.acceptedCount = 0;
    after.rejectedCount = 0;
    after.autoPostEnabled = false;
    after.autoPostEnabledBy = null;

    const newVersion = rule.version + 1;
    const proposals: Proposal[] = [];

    const existingVersions = await tx.query("rule_versions_for_rule", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      ruleId: rule.id,
    });
    if (existingVersions.length === 0) {
      const backfill: ProposedRowInsert = {
        kind: "row_insert",
        table: "rule_versions",
        rowId: `${rule.id}:${rule.version}`,
        row: {
          ruleId: rule.id,
          version: rule.version,
          clientId: scope.clientId,
          firmId: ctx.firmId,
          snapshot: rule,
          validFrom: NOW_PLACEHOLDER,
          validTo: null,
          changedBy: ACTOR_PLACEHOLDER,
          changeNote: BACKFILL_CHANGE_NOTE,
        },
        provenance: { cascadeLevel: null },
      };
      proposals.push(backfill);
    }

    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "rules",
      rowId: rule.id,
      before: { ...before, version: rule.version },
      after: { ...after, version: newVersion },
      provenance: { cascadeLevel: null },
    };
    proposals.push(write);

    const historyInsert: ProposedRowInsert = {
      kind: "row_insert",
      table: "rule_versions",
      rowId: `${rule.id}:${newVersion}`,
      row: {
        ruleId: rule.id,
        version: newVersion,
        clientId: scope.clientId,
        firmId: ctx.firmId,
        snapshot: { ...rule, ...after, version: newVersion },
        validFrom: NOW_PLACEHOLDER,
        validTo: null,
        changedBy: ACTOR_PLACEHOLDER,
        changeNote: scope.changeNote,
      },
      provenance: { cascadeLevel: null },
    };
    proposals.push(historyInsert);

    return makeResult<Proposal>(1, proposals, [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-EDIT-RULE", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    return proposals.filter((p) => p.kind === "field_write").map(revertFieldWrite);
  },
};
