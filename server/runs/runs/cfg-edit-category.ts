/**
 * CFG-EDIT-CATEGORY, version 1.
 *
 * A person at the firm changes a category's name, posting account, tax
 * treatment, or any of the other fields on ledger.categories. Manual tier:
 * which account a category posts to and how it is taxed are judgments a
 * person makes on purpose, never something a run infers.
 *
 * The row is updated in place (unlike a mapping profile, which is never
 * edited in place; see MappingProfileRow's own comment for why those two
 * disagree), with its version bumped by exactly one. ledger.category_versions
 * has carried the history shape since migration 0002 and nothing has ever
 * written to it; this run is the first writer, and the first edit of any
 * category also backfills a version 1 snapshot of the row as it stood before
 * this edit, so the history never starts mid-stream.
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
import { canonicalJson, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { CategoryRow } from "../tables";

export const editableCategoryFieldsSchema = z.object({
  name: z.string().min(1).optional(),
  accountNumber: z.string().regex(/^[0-9]{4}$/).optional(),
  normalSide: z.enum(["debit", "credit"]).optional(),
  taxTreatment: z
    .enum([
      "deductible",
      "meals_50",
      "nondeductible",
      "owner_draw",
      "owner_contribution",
      "personal",
      "capital",
      "transfer",
      "not_applicable",
    ])
    .optional(),
  class1099: z.enum(["none", "nec", "misc_rent", "misc_other", "attorney"]).optional(),
  requiresReceiptOverCents: z.bigint().nonnegative().nullable().optional(),
  requiresClass: z.boolean().optional(),
  capitalizeOverCents: z.bigint().nonnegative().nullable().optional(),
  restrictionRelevant: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const editCategoryScopeSchema = z.object({
  clientId: z.string().min(1),
  categoryId: z.string().min(1),
  changeNote: z.string().min(1),
  fields: editableCategoryFieldsSchema,
});

export type EditCategoryScope = z.infer<typeof editCategoryScopeSchema>;

export const ERR_CATEGORY_NOT_FOUND = "CFG-CATEGORY-NOT-FOUND";

/** Backfilled history carries this note, so it reads as what it is, not a real edit. */
export const BACKFILL_CHANGE_NOTE = "initial version, backfilled on first edit";

function changedFields(
  current: CategoryRow,
  fields: z.infer<typeof editableCategoryFieldsSchema>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const key = k as keyof CategoryRow;
    if (current[key] !== v) {
      before[key] = current[key];
      after[key] = v;
    }
  }
  return { before, after };
}

export const cfgEditCategory: Run<EditCategoryScope, Proposal> = {
  type: "CFG-EDIT-CATEGORY",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:category:${scope.categoryId}`,
  scopeSchema: editCategoryScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<EditCategoryScope>> {
    const tx = requireTx(ctx);
    const rows = await tx.query("category_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      categoryId: scope.categoryId,
    });
    const category = rows[0] ?? null;
    const candidateIds = [scope.categoryId];
    const versions = [{ id: "CFG-EDIT-CATEGORY", version: 1 }];
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
          category ? String(category.version) : "missing",
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

    const rows = await tx.query("category_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      categoryId: scope.categoryId,
    });
    const category: CategoryRow | undefined = rows[0];
    if (!category) {
      errors.push({
        rowId: scope.categoryId,
        code: ERR_CATEGORY_NOT_FOUND,
        message: `category ${scope.categoryId} does not belong to client ${scope.clientId}`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const { before, after } = changedFields(category, scope.fields);
    if (Object.keys(after).length === 0) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: category.id, reason: "already_applied", detail: "every named field already has this value" }],
        [],
        BigInt(0),
      );
    }

    const newVersion = category.version + 1;
    const proposals: Proposal[] = [];

    const existingVersions = await tx.query("category_versions_for_category", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      categoryId: category.id,
    });
    if (existingVersions.length === 0) {
      const backfill: ProposedRowInsert = {
        kind: "row_insert",
        table: "category_versions",
        rowId: `${category.id}:${category.version}`,
        row: {
          categoryId: category.id,
          version: category.version,
          clientId: scope.clientId,
          firmId: ctx.firmId,
          snapshot: category,
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
      table: "categories",
      rowId: category.id,
      before: { ...before, version: category.version, updatedAt: category.updatedAt },
      after: { ...after, version: newVersion, updatedAt: NOW_PLACEHOLDER },
      provenance: { cascadeLevel: null },
    };
    proposals.push(write);

    const historyInsert: ProposedRowInsert = {
      kind: "row_insert",
      table: "category_versions",
      rowId: `${category.id}:${newVersion}`,
      row: {
        categoryId: category.id,
        version: newVersion,
        clientId: scope.clientId,
        firmId: ctx.firmId,
        snapshot: { ...category, ...after, version: newVersion },
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
    await applyProposals(proposals, ctx, { runType: "CFG-EDIT-CATEGORY", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    // The version history is an insert only log, same as every other audit
    // trail in this system: undoing the edit reverts the live row, but the
    // fact that the edit happened, and was then undone, is not erased.
    return proposals.filter((p) => p.kind === "field_write").map(revertFieldWrite);
  },
};
