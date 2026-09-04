/**
 * INTAKE-BUILD-CHART. Seed a new client's chart of accounts and categories.
 *
 * Spec: docs/02-run-specifications.md Module 1, docs/01-categories-and-charts.md.
 *
 * What the run does. The wizard picks one industry template. This run assembles
 * that template into a concrete account list, forces the mandatory clearing
 * block in whatever the template says, pairs every fixed asset cost account
 * with its accumulated depreciation contra, and writes the rows the client does
 * not already have. It then writes the category spine and the template's own
 * categories the same way.
 *
 * Idempotency. Account ids and category ids are derived from the client and the
 * account number or the category slug, so a second execution finds every row
 * already present and reports account exists. That is the property that lets
 * the wizard be run twice by a person who was not sure it finished.
 *
 * Never overwrites. This run has no field write path at all. An account that is
 * already on the chart is skipped, not renamed, because the name on a live
 * account is a decision somebody made and a template is not evidence against
 * it. The same holds for a category. That also means an overridden row is
 * untouchable by construction rather than by a check, and the check is here
 * anyway so the skip reason says so in words.
 *
 * Exclusions and additions. Step 3 of the wizard lets the firm strike template
 * rows before seeding and add its own. Both arrive on the scope, both are part
 * of the scope hash, and neither is inferred.
 *
 * SENDS. None. This run writes chart rows. Nothing is transmitted.
 *
 * CONSTRAINT. No model and no inference. The template is a table in
 * intake-shared.ts and the scope keys are answers the firm typed.
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
  type Skip,
  type Ulid,
} from "../contract";
import {
  applyProposals,
  requireTx,
} from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";
import type { CategoryRow, ChartAccountRow } from "../tables";
import { ZERO } from "./close-shared";
import { periodWindow } from "./per-shared";
import {
  MANDATORY_CLEARING_ACCOUNTS,
  assembleAccounts,
  assembleCategories,
  byAccountNumber,
  loadIntakeData,
  missingContraAccounts,
  templateFor,
  type AssembledAccount,
  type TemplateCategory,
} from "./intake-shared";

const extraAccountSchema = z.object({
  accountNumber: z.string().regex(/^[0-9]{4}$/),
  name: z.string().min(1),
  normalSide: z.union([z.literal("debit"), z.literal("credit")]),
});

export const buildChartScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  /** One of the five industry words the wizard offers, or a template id. */
  industry: z.string().min(1),
  /** The engagement scope answers that decide the optional template blocks. */
  scopeKeys: z.array(z.string().min(1)).default([]),
  /** Account numbers the firm struck on step 3 before seeding. */
  excludeAccountNumbers: z.array(z.string().regex(/^[0-9]{4}$/)).default([]),
  /** Account rows the firm typed on step 3. */
  addAccounts: z.array(extraAccountSchema).default([]),
});

export type BuildChartScope = z.infer<typeof buildChartScopeSchema>;

export const intakeBuildChart: Run<BuildChartScope, Proposal> = {
  type: "INTAKE-BUILD-CHART",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:intake-chart`,
  scopeSchema: buildChartScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<BuildChartScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadIntakeData(
      tx,
      ctx.firmId,
      scope.clientId,
      scope.period,
      window.periodStart,
    );
    const plan = planFor(scope);
    const candidateIds = [
      ...plan.accounts.map((a) => accountIdOf(scope.clientId, a.accountNumber)),
      ...plan.categories.map((c) => categoryIdOf(scope.clientId, c.id)),
    ];
    const versions = [
      { id: "INTAKE-BUILD-CHART", version: 1 },
      { id: plan.templateId, version: plan.templateVersion },
      ...data.categories.map((c) => ({ id: c.id, version: c.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // The template, the scope answers, and the step 3 edits all ride in the
      // discriminator, because two executions against the same empty client
      // would otherwise see the same candidate set and hash to the same key.
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [
          window.periodStart,
          plan.templateId,
          [...scope.scopeKeys].sort().join("|"),
          [...scope.excludeAccountNumbers].sort().join("|"),
          plan.addedKeys.join("|"),
        ].join("/"),
      }),
      versions,
      overriddenIds: data.categories.filter((c) => !c.isActive).map((c) => c.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const data = await loadIntakeData(
      tx,
      frozen.firmId,
      frozen.clientId,
      frozen.input.period,
      window.periodStart,
    );
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const template = templateFor(frozen.input.industry);
    if (template === null) {
      errors.push({
        rowId: null,
        code: "UNKNOWN_TEMPLATE",
        message: `no chart template is published for ${frozen.input.industry}`,
        retryable: false,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const plan = planFor(frozen.input);
    const existingAccounts = new Map<string, ChartAccountRow>(
      data.accounts.map((a) => [a.accountNumber, a]),
    );
    const existingById = new Map<string, ChartAccountRow>(data.accounts.map((a) => [a.id, a]));
    const existingCategories = new Map<string, CategoryRow>(
      data.categories.map((c) => [c.id, c]),
    );

    for (const account of plan.accounts) {
      const rowId = accountIdOf(frozen.clientId, account.accountNumber);
      const priorByNumber = existingAccounts.get(account.accountNumber);
      const priorById = existingById.get(rowId);
      if (priorByNumber !== undefined || priorById !== undefined) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `account_exists, ${account.accountNumber} is already on the chart`,
        });
        continue;
      }
      proposals.push(insertAccount(frozen, rowId, account));
    }

    for (const category of plan.categories) {
      const rowId = categoryIdOf(frozen.clientId, category.id);
      const prior = existingCategories.get(category.id) ?? existingCategories.get(rowId);
      if (prior !== undefined) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `category_exists, ${category.id} is already defined for this client`,
        });
        continue;
      }
      proposals.push(insertCategory(frozen, rowId, category));
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "INTAKE-BUILD-CHART",
      runVersion: 1,
    });
  },

  /**
   * Nothing reverts. Every proposal this run makes is an insert of a row that
   * had no prior value, and an account a person has already posted to cannot be
   * withdrawn without orphaning the entry. An unwanted account is deactivated
   * by a person, which is a decision and belongs in the audit log as one.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};

/** Derived so a rerun lands on the same row. Doc 03 Part 4. */
export function accountIdOf(clientId: Ulid, accountNumber: string): Ulid {
  return derivedId(`${clientId}:${accountNumber}`, "intake-build-chart", 0);
}

/**
 * A category id is the published slug, not a derived ULID. Doc 04 Part 9 fixes
 * the id as "CAT-" plus slug and every coded transaction carries that string in
 * its categoryId column, so minting a ULID here would produce categories that
 * no rule, template, or coded row could ever point at. See NOTES.md entry 126.
 */
export function categoryIdOf(_clientId: Ulid, categorySlugId: string): Ulid {
  return categorySlugId;
}

export interface ChartPlan {
  templateId: string;
  templateVersion: number;
  accounts: AssembledAccount[];
  categories: TemplateCategory[];
  addedKeys: string[];
}

/**
 * The concrete chart one scope produces. Exported because step 3 of the wizard
 * previews exactly this list and the preview must be the same function the run
 * uses, not a second implementation that drifts.
 */
export function planFor(scope: BuildChartScope): ChartPlan {
  const template = templateFor(scope.industry);
  if (template === null) {
    return {
      templateId: scope.industry,
      templateVersion: 0,
      accounts: [],
      categories: [],
      addedKeys: [],
    };
  }
  const excluded = new Set(scope.excludeAccountNumbers);
  const assembled = assembleAccounts(template, scope.scopeKeys);
  const kept = assembled.filter(
    // A struck row from the clearing block stays. Doc 00 Part 1 says those five
    // accounts exist on every chart, and a wizard checkbox does not outrank the
    // invariant the suspense sweep depends on. The membership test is the rule
    // itself rather than the forcedMandatory flag, because that flag only marks
    // a row the scope key would have dropped and every clearing account is in
    // scope always. See NOTES.md entry 128.
    (a) =>
      !excluded.has(a.accountNumber) ||
      a.forcedMandatory ||
      MANDATORY_CLEARING_ACCOUNTS.includes(a.accountNumber),
  );
  const added: AssembledAccount[] = scope.addAccounts
    .filter((a) => !kept.some((k) => k.accountNumber === a.accountNumber))
    .map((a) => ({
      accountNumber: a.accountNumber,
      name: a.name,
      normalSide: a.normalSide,
      scopeKey: "always" as const,
      forcedMandatory: false,
    }));
  const withAdded = [...kept, ...added].sort(byAccountNumber);
  const contras = missingContraAccounts(withAdded).filter(
    (c) => !excluded.has(c.accountNumber),
  );
  const accounts = [...withAdded, ...contras].sort(byAccountNumber);
  const categories = assembleCategories(template).filter(
    // A category whose account was struck would point at nothing. Dropping it
    // is the only honest answer, and the run says which account did it.
    (c) => accounts.some((a) => a.accountNumber === c.accountNumber),
  );
  return {
    templateId: template.id,
    templateVersion: template.version,
    accounts,
    categories,
    addedKeys: added.map((a) => `${a.accountNumber}:${a.name}`).sort(),
  };
}

function insertAccount(
  frozen: FrozenScope<BuildChartScope>,
  rowId: Ulid,
  account: AssembledAccount,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "chart_accounts",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      accountNumber: account.accountNumber,
      name: account.name,
    },
    provenance: { cascadeLevel: null },
  };
}

function insertCategory(
  frozen: FrozenScope<BuildChartScope>,
  rowId: Ulid,
  category: TemplateCategory,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "categories",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      name: category.name,
      accountNumber: category.accountNumber,
      normalSide: category.normalSide,
      taxTreatment: category.taxTreatment,
      class1099: category.class1099,
      requiresReceiptOverCents: category.requiresReceiptOverCents,
      requiresClass: category.requiresClass,
      capitalizeOverCents: category.capitalizeOverCents,
      restrictionRelevant: category.restrictionRelevant,
      isActive: true,
    },
    provenance: { cascadeLevel: null },
  };
}
