/**
 * CFG-CREATE-RULE, version 1.
 *
 * A person at the firm writes a brand new coding rule. Manual tier, same
 * reasoning as CFG-EDIT-RULE and TXN-APPLY-RULES itself: a rule is
 * configurable by a user and therefore capable of encoding a mistake at
 * scale, so writing one is a decision a person makes on purpose.
 *
 * id is derived from the client and the full field set rather than a fresh
 * ulid(): a run id minted inside propose() must come out identical on the
 * apply re-derivation check, and ulid() carries its own randomness even
 * given the same clock reading (ids.ts's own module state), so it cannot
 * be called from inside propose() at all -- every other create-shaped run
 * in this codebase either derives its id from stable input or has it
 * minted by the calling route before the run ever runs (DOC-RECORD-UPLOAD's
 * documentId, uploads.ts). Deriving from clientId plus the full field set
 * also means two requests to create an identical rule collapse into the
 * same id rather than producing two indistinguishable duplicates.
 *
 * targetCategoryId is checked against the client's real categories, a
 * check CFG-EDIT-RULE does not have. Not retrofitting the edit run in this
 * pass, just not inheriting the gap into a brand new write path.
 *
 * Every promotion field (hitCount, acceptedCount, rejectedCount,
 * autoPostEnabled, autoPostEnabledBy) starts at its zero state; a new rule
 * has not won a tie break or earned auto-post yet by definition.
 *
 * ledger.rule_versions gets this rule's version 1 row directly, no backfill
 * branch: this run is always the first and only writer of the row it
 * creates.
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
import { ACTOR_PLACEHOLDER, NOW_PLACEHOLDER, applyProposals, requireTx } from "../apply-writer";
import { canonicalJson, derivedId, scopeHashFor } from "../ids";
import { categoryIndex } from "./coding-cascade";
import { ruleConditionSchema } from "./cfg-edit-rule";
import type { RuleRow } from "../tables";

export const newRuleFieldsSchema = z.object({
  name: z.string().min(1),
  priority: z.number().int().min(0).max(1000),
  conditions: z.array(ruleConditionSchema).min(1),
  targetCategoryId: z.string().min(1),
  targetClassId: z.string().min(1).nullable().default(null),
  scopeKind: z.enum(["client", "firm_library"]).default("client"),
  effectiveFrom: z.string().nullable().default(null),
  effectiveTo: z.string().nullable().default(null),
  isActive: z.boolean().default(true),
  autoPostCeilingCents: z.bigint().nonnegative().default(BigInt(250000)),
});

export const createRuleScopeSchema = z.object({
  clientId: z.string().min(1),
  changeNote: z.string().min(1),
  fields: newRuleFieldsSchema,
});

export type CreateRuleScope = z.infer<typeof createRuleScopeSchema>;

export const ERR_RULE_UNKNOWN_CATEGORY = "CFG-RULE-UNKNOWN-CATEGORY";

export function ruleIdFor(clientId: string, fields: z.infer<typeof newRuleFieldsSchema>): string {
  return `RULE-${derivedId(`${clientId}:${canonicalJson(fields)}`, "cfg-create-rule", 0)}`;
}

export const cfgCreateRule: Run<CreateRuleScope, Proposal> = {
  type: "CFG-CREATE-RULE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:rule:${ruleIdFor(scope.clientId, scope.fields)}`,
  scopeSchema: createRuleScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateRuleScope>> {
    const candidateIds = [ruleIdFor(scope.clientId, scope.fields)];
    const versions = [{ id: "CFG-CREATE-RULE", version: 1 }];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions, period: canonicalJson(scope.fields) }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const id = ruleIdFor(scope.clientId, scope.fields);

    const existing = await tx.query("rule_by_id", { firmId: ctx.firmId, clientId: scope.clientId, ruleId: id });
    if (existing.length > 0) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: id, reason: "already_applied", detail: "an identical rule already exists for this client" }],
        [],
        BigInt(0),
      );
    }

    const categories = categoryIndex(await tx.query("categories_for_client", { firmId: ctx.firmId, clientId: scope.clientId }));
    if (!categories.has(scope.fields.targetCategoryId)) {
      errors.push({
        rowId: scope.clientId,
        code: ERR_RULE_UNKNOWN_CATEGORY,
        message: `category ${scope.fields.targetCategoryId} does not belong to client ${scope.clientId}`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const row: RuleRow = {
      id,
      firmId: ctx.firmId,
      clientId: scope.clientId,
      version: 1,
      name: scope.fields.name,
      priority: scope.fields.priority,
      conditionCount: scope.fields.conditions.length,
      conditions: scope.fields.conditions,
      targetCategoryId: scope.fields.targetCategoryId,
      targetClassId: scope.fields.targetClassId,
      scopeKind: scope.fields.scopeKind,
      effectiveFrom: scope.fields.effectiveFrom,
      effectiveTo: scope.fields.effectiveTo,
      isActive: scope.fields.isActive,
      hitCount: 0,
      lastHitAt: null,
      acceptedCount: 0,
      rejectedCount: 0,
      autoPostEnabled: false,
      autoPostEnabledBy: null,
      autoPostCeilingCents: scope.fields.autoPostCeilingCents,
    };
    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "rules",
      rowId: id,
      row: row as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };
    const historyInsert: ProposedRowInsert = {
      kind: "row_insert",
      table: "rule_versions",
      rowId: `${id}:1`,
      row: {
        ruleId: id,
        version: 1,
        clientId: scope.clientId,
        firmId: ctx.firmId,
        snapshot: row,
        validFrom: NOW_PLACEHOLDER,
        validTo: null,
        changedBy: ACTOR_PLACEHOLDER,
        changeNote: scope.changeNote,
      },
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [insert, historyInsert], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-RULE", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
