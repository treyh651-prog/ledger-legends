/**
 * CFG-CREATE-CATEGORY, version 1.
 *
 * A person at the firm invents a category INTAKE-BUILD-CHART's template
 * never named. Manual tier, same reasoning as CFG-EDIT-CATEGORY: which
 * account a category posts to and how it is taxed is a judgment a person
 * makes on purpose.
 *
 * INTAKE-BUILD-CHART only ever inserts the categories a published template
 * already lists, keyed by the template's own slug (categoryIdOf's own
 * comment: "every coded transaction carries that string," so a template
 * category's id has to be the slug, not a minted one). A firm-invented
 * category has no template slug to carry, so its id is a derived id from
 * the client and the name instead (derivedId, same idiom
 * AP-CREATE-VENDOR/AR-CREATE-CUSTOMER/SETUP-ADD-BANK-ACCOUNT already use
 * for a natural-key row this run mints for the first time) -- a different
 * id shape on purpose, not an oversight.
 *
 * accountNumber is checked against the client's real chart, a check
 * CFG-EDIT-CATEGORY does not have. Leaving that gap open here would let a
 * typo mint a category pointing nowhere; not retrofitting the edit run in
 * this pass, just not inheriting the gap into a brand new write path.
 *
 * ledger.category_versions gets this category's version 1 row directly;
 * there is no backfill branch, unlike CFG-EDIT-CATEGORY's first edit of a
 * category INTAKE-BUILD-CHART inserted, because this run is always the
 * first and only writer of the row it creates.
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
import type { CategoryRow } from "../tables";

export const newCategoryFieldsSchema = z.object({
  name: z.string().min(1),
  accountNumber: z.string().regex(/^[0-9]{4}$/),
  normalSide: z.enum(["debit", "credit"]),
  taxTreatment: z.enum([
    "deductible",
    "meals_50",
    "nondeductible",
    "owner_draw",
    "owner_contribution",
    "personal",
    "capital",
    "transfer",
    "not_applicable",
  ]),
  class1099: z.enum(["none", "nec", "misc_rent", "misc_other", "attorney"]).default("none"),
  requiresReceiptOverCents: z.bigint().nonnegative().nullable().default(null),
  requiresClass: z.boolean().default(false),
  capitalizeOverCents: z.bigint().nonnegative().nullable().default(null),
  restrictionRelevant: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const createCategoryScopeSchema = z.object({
  clientId: z.string().min(1),
  changeNote: z.string().min(1),
  fields: newCategoryFieldsSchema,
});

export type CreateCategoryScope = z.infer<typeof createCategoryScopeSchema>;

export const ERR_CATEGORY_UNKNOWN_ACCOUNT = "CFG-CATEGORY-UNKNOWN-ACCOUNT";

export function categoryIdFor(clientId: string, name: string): string {
  return derivedId(`${clientId}:${name}`, "cfg-create-category", 0);
}

export const cfgCreateCategory: Run<CreateCategoryScope, Proposal> = {
  type: "CFG-CREATE-CATEGORY",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:category:${categoryIdFor(scope.clientId, scope.fields.name)}`,
  scopeSchema: createCategoryScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateCategoryScope>> {
    const candidateIds = [categoryIdFor(scope.clientId, scope.fields.name)];
    const versions = [{ id: "CFG-CREATE-CATEGORY", version: 1 }];
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
    const id = categoryIdFor(scope.clientId, scope.fields.name);

    const existing = await tx.query("category_by_id", { firmId: ctx.firmId, clientId: scope.clientId, categoryId: id });
    if (existing.length > 0) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: id, reason: "already_applied", detail: "a category with this name already exists for this client" }],
        [],
        BigInt(0),
      );
    }

    const chart = await tx.query("chart_accounts_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const knownNumbers = new Set(chart.map((a) => a.accountNumber));
    if (!knownNumbers.has(scope.fields.accountNumber)) {
      errors.push({
        rowId: id,
        code: ERR_CATEGORY_UNKNOWN_ACCOUNT,
        message: `account ${scope.fields.accountNumber} is not on client ${scope.clientId}'s chart`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const row: CategoryRow = {
      id,
      firmId: ctx.firmId,
      clientId: scope.clientId,
      version: 1,
      name: scope.fields.name,
      accountNumber: scope.fields.accountNumber,
      normalSide: scope.fields.normalSide,
      taxTreatment: scope.fields.taxTreatment,
      class1099: scope.fields.class1099,
      requiresReceiptOverCents: scope.fields.requiresReceiptOverCents,
      requiresClass: scope.fields.requiresClass,
      capitalizeOverCents: scope.fields.capitalizeOverCents,
      restrictionRelevant: scope.fields.restrictionRelevant,
      isActive: scope.fields.isActive,
      updatedAt: NOW_PLACEHOLDER,
    };
    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "categories",
      rowId: id,
      row: row as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };
    const historyInsert: ProposedRowInsert = {
      kind: "row_insert",
      table: "category_versions",
      rowId: `${id}:1`,
      row: {
        categoryId: id,
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
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-CATEGORY", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    // Every proposal here is an insert of a row that had no prior value;
    // inserts never revert in this framework (same reasoning
    // INTAKE-BUILD-CHART's own undoPlan comment gives).
    return [];
  },
};
