/**
 * TXN-APPLY-RULES. Apply user rules, level 6 of the cascade.
 *
 * Spec: docs/02-run-specifications.md Module 2 TXN-APPLY-RULES, rule shape from
 * docs/04-reference-data.md Part 9, tie breaking from docs/00-conventions.md
 * Part 3, auto post conditions from doc 02 Part D.
 *
 * Ordering matters and is enforced, not assumed. This run sits below duplicate
 * detection, transfer pairing, settlement splitting, and recurring templates. A
 * paired transfer already carries a level 3 decision and this run reports it as
 * already resolved rather than recoding it. That is the negative test the pipeline
 * has to be able to fail on, because a rule saying every WELLS FARGO line is bank
 * fees would otherwise quietly turn one side of a transfer into an expense and the
 * transfer clearing account would never come back to zero.
 *
 * Conditions. Six types, and nothing else:
 *   vendor_equals   exact equality on the normalized vendor.
 *   vendor_prefix   token boundary prefix on the normalized vendor. A prefix has
 *                   to end on a token boundary, so JOE does not match JOEL.
 *   amount_range    inclusive integer cent range on the absolute amount.
 *   sign            debit or credit.
 *   bank_account    bank or card account equality.
 *   bank_code       exact bank code equality.
 * Conditions are conjunctive. There is no OR, no regular expression, and no
 * similarity score, because a rule a person cannot read back is a rule nobody can
 * audit.
 *
 * Selection. Priority descending, then condition count descending, then rule id
 * ascending. If more than one rule survives and they target different categories,
 * none is applied and SUS-19 surfaces every surviving rule id. If the survivors
 * all target the same category the coding is applied and the tie is logged as
 * benign, because there is nothing to decide.
 *
 * Then the shared attribute checks of doc 02 steps 5 through 8 in
 * coding-cascade.ts, and only then the auto post question of Part D.
 */

import {
  makeResult,
  isFieldWrite,
  isRowInsert,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import {
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  applyProposals,
  requireTx,
} from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId } from "../ids";
import { revertFieldWrite } from "../undo";
import type { CategoryRow, RuleCondition, RuleRow, TransactionRow } from "../tables";
import {
  LEVEL,
  abs,
  alreadyResolvedSkip,
  foreignCurrencySkip,
  categoryChecks,
  categoryIndex,
  codingScopeSchema,
  codingWrite,
  freezeCodingScope,
  iterationOrder,
  overrideSkips,
  policyOf,
  resolvedLevel,
  signOf,
  suspenseProposal,
  type CodingScope,
} from "./coding-cascade";

export const SUS_RULE_CONFLICT = "SUS-19";
/** Doc 02 Part D. Auto post is possible here, but only under five conditions. */
export const RULES_AUTO_POST_ELIGIBLE = true;
export const RULE_PROMOTION_MIN_ACCEPTED = 25;
export const DEFAULT_AUTO_POST_CEILING_CENTS = BigInt(250000);

/** Tax treatments Part D forbids from ever auto posting. */
export const AUTO_POST_FORBIDDEN_TREATMENTS: readonly string[] = [
  "personal",
  "owner_draw",
  "owner_contribution",
];

/** A prefix has to end on a token boundary. JOE matches JOE S PIZZA, not JOEL. */
export function tokenPrefixMatches(vendor: string, prefix: string): boolean {
  if (prefix.length === 0) return false;
  if (vendor === prefix) return true;
  return vendor.startsWith(`${prefix} `);
}

export function conditionMatches(
  t: TransactionRow,
  c: RuleCondition,
): boolean {
  switch (c.type) {
    case "vendor_equals":
      return t.normalizedVendor !== null && t.normalizedVendor === c.value;
    case "vendor_prefix":
      return (
        t.normalizedVendor !== null && tokenPrefixMatches(t.normalizedVendor, c.value)
      );
    case "amount_range": {
      const magnitude = abs(t.amountCents);
      return magnitude >= c.minCents && magnitude <= c.maxCents;
    }
    case "sign":
      return signOf(t) === c.value;
    case "bank_account":
      return t.bankAccountId === c.value;
    case "bank_code":
      return t.bankCode !== null && t.bankCode === c.value;
    default: {
      const exhaustive: never = c;
      throw new Error(`unknown condition ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Conjunctive. Every condition or no match. */
export function ruleMatches(t: TransactionRow, rule: RuleRow): boolean {
  if (!rule.isActive) return false;
  if (rule.effectiveFrom !== null && t.postedDate < rule.effectiveFrom) return false;
  if (rule.effectiveTo !== null && t.postedDate > rule.effectiveTo) return false;
  if (rule.conditions.length === 0) return false;
  for (const c of rule.conditions) if (!conditionMatches(t, c)) return false;
  return true;
}

/**
 * Doc 00 Part 3 tie break: priority descending, condition count descending, rule
 * id ascending. The query hands rows back in this order already, and sorting again
 * here is deliberate. A run that depends on a store ordering it does not control
 * is a run that breaks the day someone edits an index.
 */
export function tieBreakOrder(a: RuleRow, b: RuleRow): number {
  if (a.priority !== b.priority) return a.priority > b.priority ? -1 : 1;
  if (a.conditionCount !== b.conditionCount) {
    return a.conditionCount > b.conditionCount ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The five Part D conditions, all required. Any one of them failing means the
 * coding is a proposal a person accepts, which is the default and the safe state.
 */
export function autoPostAllowed(args: {
  rule: RuleRow;
  category: CategoryRow;
  amountCents: bigint;
  cleanupEngagement: boolean;
}): boolean {
  if (!args.rule.autoPostEnabled) return false;
  if (args.rule.autoPostEnabledBy === null) return false;
  if (args.rule.acceptedCount < RULE_PROMOTION_MIN_ACCEPTED) return false;
  if (args.rule.rejectedCount !== 0) return false;
  if (AUTO_POST_FORBIDDEN_TREATMENTS.includes(args.category.taxTreatment)) {
    return false;
  }
  const ceiling = args.rule.autoPostCeilingCents;
  if (abs(args.amountCents) > ceiling) return false;
  if (args.cleanupEngagement) return false;
  return true;
}

export const txnApplyRules: Run<CodingScope, Proposal> = {
  type: "TXN-APPLY-RULES",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => scope.clientId,
  scopeSchema: codingScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CodingScope>> {
    const tx = requireTx(ctx);
    const rules = await tx.query("active_rules_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    return freezeCodingScope(scope, ctx, "TXN-APPLY-RULES", 1, [
      ...rules.map((r) => ({ id: r.id, version: r.version })),
    ]);
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const proposals: Proposal[] = [];
    const skips: Skip[] = overrideSkips(frozen.overriddenIds);
    const errors: RunError[] = [];

    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const categories = categoryIndex(
      await tx.query("categories_for_client", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
      }),
    );
    const policy = policyOf(
      await tx.query("client_policy", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
      }),
    );
    const rules = (
      await tx.query("active_rules_for_client", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
      })
    )
      .slice()
      .sort(tieBreakOrder);
    const candidates = await tx.query("transactions_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: scope.from,
      to: scope.to,
      bankAccountIds: scope.bankAccountIds,
      includeOverridden: false,
    });
    const documents = await tx.query("document_links_for_transactions", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      transactionIds: candidates.map((t) => t.id),
    });
    const documented = new Set<Ulid>(documents.map((d) => d.transactionId));

    let ordinal = 0;
    for (const t of candidates.slice().sort(iterationOrder)) {
      if (isLockedDay(locks, t.postedDate)) {
        skips.push({
          rowId: t.id,
          reason: "locked_period",
          detail: `posted ${t.postedDate} falls inside a locked period`,
        });
        continue;
      }
      // The ordering guarantee. Anything decided at level 2 through 5 is left
      // exactly as the earlier step left it, including a paired transfer.
      const level = resolvedLevel(t);
      if (level !== null && level < LEVEL.rule) {
        skips.push(alreadyResolvedSkip(t, level));
        continue;
      }
      const currencySkip = foreignCurrencySkip(t, policy.functionalCurrency);
      if (currencySkip !== null) {
        skips.push(currencySkip);
        continue;
      }
      if (t.duplicateFlag) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: "duplicate_pending",
        });
        continue;
      }
      if (t.normalizedVendor === null) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: "vendor is not normalized yet, TXN-NORMALIZE-VENDORS runs first",
        });
        continue;
      }

      const hits = rules.filter((r) => ruleMatches(t, r));
      if (hits.length === 0) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: "no_rule_matched",
        });
        continue;
      }

      // Survivors are the rules that share the top of the tie break order.
      const best = hits[0];
      const survivors = hits.filter(
        (r) =>
          r.priority === best.priority && r.conditionCount === best.conditionCount,
      );
      const targets = new Set(survivors.map((r) => r.targetCategoryId));
      if (survivors.length > 1 && targets.size > 1) {
        proposals.push(
          suspenseProposal({
            transactionId: t.id,
            reasonCode: SUS_RULE_CONFLICT,
            detail: `rules conflict on different categories, every survivor: ${survivors.map((r) => r.id).join(",")}`,
            relatedIds: survivors.map((r) => r.id),
          }),
        );
        continue;
      }
      if (survivors.length > 1) {
        // Benign tie. Same destination, so the tie break just picks a winner and
        // the fact that it was a tie is worth recording and nothing more.
        ctx.logger.info("benign_tie", {
          transactionId: t.id,
          categoryId: best.targetCategoryId,
          ruleIds: survivors.map((r) => r.id),
        });
      }

      const rule = survivors[0];
      const category = categories.get(rule.targetCategoryId);
      if (!category) {
        errors.push({
          rowId: t.id,
          code: "MISSING_ACCOUNT",
          message: `rule ${rule.id} targets category ${rule.targetCategoryId} which is not on this client`,
          retryable: false,
        });
        continue;
      }
      if (!category.isActive) {
        proposals.push(
          suspenseProposal({
            transactionId: t.id,
            reasonCode: "SUS-03",
            detail: `rule ${rule.id} targets inactive category ${category.id}`,
            relatedIds: [rule.id],
          }),
        );
        continue;
      }

      const outcome = categoryChecks(t, category, {
        hasDocument: documented.has(t.id),
        policyCapitalizeOverCents: policy.capitalizeOverCents,
      });
      if (outcome.block) {
        proposals.push(
          suspenseProposal({
            transactionId: t.id,
            reasonCode: outcome.block.reasonCode,
            detail: `${outcome.block.detail}, rule ${rule.id}`,
            relatedIds: [rule.id],
          }),
        );
        continue;
      }

      const posts = autoPostAllowed({
        rule,
        category,
        amountCents: t.amountCents,
        cleanupEngagement: policy.cleanupEngagement,
      });

      const write = codingWrite({
        t,
        categoryId: category.id,
        categoryVersion: category.version,
        cascadeLevel: LEVEL.rule,
        ruleId: rule.id,
        ruleVersion: rule.version,
        matchedConditions: rule.conditions,
      });
      if (posts) {
        // Part D. The flag is written only when all five conditions held, which is
        // what lets a review six months later separate what a person accepted from
        // what a promoted rule posted on its own.
        write.after.autoPostedUnderRulePromotion = true;
        write.before.autoPostedUnderRulePromotion = t.autoPostedUnderRulePromotion;
      }
      proposals.push(write);

      for (const ex of outcome.exceptions) {
        ordinal += 1;
        proposals.push(
          exceptionInsert(t, category.id, ex.kind, ex.detail, ordinal),
        );
        if (ex.reasonCode !== null) {
          proposals.push(
            suspenseProposal({
              transactionId: t.id,
              reasonCode: ex.reasonCode,
              detail: ex.detail,
              relatedIds: [rule.id],
            }),
          );
        }
      }
    }

    return makeResult<Proposal>(
      frozen.candidateIds.length,
      proposals,
      skips,
      errors,
      BigInt(0),
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "TXN-APPLY-RULES",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
      // A documentation exception and a suspense item are both work items for a
      // person. Undoing the coding does not make the missing receipt appear.
      if (isRowInsert(p)) continue;
    }
    return plan;
  },
};

/**
 * A documentation exception. Derived id rather than a fresh ULID, because preview
 * and apply have to produce byte identical proposals and a fresh id would differ.
 */
export function exceptionInsert(
  t: TransactionRow,
  categoryId: string,
  kind: "missing_class" | "missing_receipt",
  detail: string,
  ordinal: number,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "documentation_exceptions",
    rowId: derivedId(t.id, `docex-${kind}`, ordinal),
    row: {
      firmId: t.firmId,
      clientId: t.clientId,
      transactionId: t.id,
      kind,
      categoryId,
      detail,
      status: "open",
      createdByRunId: RUN_ID_PLACEHOLDER,
      openedAt: NOW_PLACEHOLDER,
    },
    provenance: { cascadeLevel: LEVEL.rule },
  };
}
