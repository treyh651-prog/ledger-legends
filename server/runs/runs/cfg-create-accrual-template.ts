/**
 * CFG-CREATE-ACCRUAL-TEMPLATE, version 1.
 *
 * Audit fix, 2026-11-06 (problem 7, one of seven missing setup-data
 * creators). subledger.accrual_templates has carried its full shape since
 * migration 0013, and PER-POST-ACCRUALS/PER-REVERSE-ACCRUALS have always
 * been able to read and post from a template that exists -- but
 * apply-writer.ts had no insert case for the table, so a firm had no way
 * to name a single one of the three real period end accruals doc 02
 * describes (a bill received not entered, wages earned not paid, revenue
 * earned not billed).
 *
 * per-post-accruals.ts's own amountFor() recognizes exactly four bases and
 * each one reads a specific pair of companion fields, refusing (not
 * skipping) a template whose companion fields are null for its own basis.
 * This run checks the same requirement at creation time instead of letting
 * a template sit silently broken until the first period end run finds it:
 * fixed_amount needs fixedAmountCents; from_document needs
 * sourceDocumentAmountCents; daily_rate_x_days needs dailyRateCents and
 * dayCount; percent_of_base needs baseCents and percentBps.
 *
 * debitAccount/creditAccount are checked against the client's real chart,
 * the same reasoning every other CFG-CREATE-* run in this file gives;
 * categoryId is checked against the client's real categories only when
 * given, since a template need not tag one.
 *
 * Manual tier: naming a recurring accrual and which basis computes its
 * amount is a judgment a person makes once.
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
import { applyProposals, requireTx } from "../apply-writer";
import { canonicalJson, derivedId, scopeHashFor } from "../ids";
import { categoryIndex } from "./coding-cascade";

export const newAccrualTemplateFieldsSchema = z.object({
  name: z.string().min(1),
  accrualKind: z.enum(["bill_received_not_entered", "wages_earned_not_paid", "revenue_earned_not_billed", "other"]),
  basis: z.enum(["fixed_amount", "from_document", "daily_rate_x_days", "percent_of_base"]),
  debitAccount: z.string().regex(/^[0-9]{4}$/),
  creditAccount: z.string().regex(/^[0-9]{4}$/),
  categoryId: z.string().min(1).nullable().default(null),
  fixedAmountCents: z.number().int().nonnegative().safe().nullable().default(null),
  sourceDocumentId: z.string().min(1).nullable().default(null),
  sourceDocumentAmountCents: z.number().int().nonnegative().safe().nullable().default(null),
  dailyRateCents: z.number().int().nonnegative().safe().nullable().default(null),
  dayCount: z.number().int().nonnegative().nullable().default(null),
  baseCents: z.number().int().nonnegative().safe().nullable().default(null),
  percentBps: z.number().int().nonnegative().nullable().default(null),
  entryMemo: z.string().min(1),
  autoReverse: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

export const createAccrualTemplateScopeSchema = z.object({
  clientId: z.string().min(1),
  fields: newAccrualTemplateFieldsSchema,
});

export type CreateAccrualTemplateScope = z.infer<typeof createAccrualTemplateScopeSchema>;

export const ERR_ACCRUAL_UNKNOWN_ACCOUNT = "CFG-ACCRUAL-UNKNOWN-ACCOUNT";
export const ERR_ACCRUAL_UNKNOWN_CATEGORY = "CFG-ACCRUAL-UNKNOWN-CATEGORY";
export const ERR_ACCRUAL_MISSING_BASIS_FIELDS = "CFG-ACCRUAL-MISSING-BASIS-FIELDS";

function missingBasisFields(fields: z.infer<typeof newAccrualTemplateFieldsSchema>): string | null {
  switch (fields.basis) {
    case "fixed_amount":
      return fields.fixedAmountCents === null ? "fixedAmountCents" : null;
    case "from_document":
      return fields.sourceDocumentAmountCents === null ? "sourceDocumentAmountCents" : null;
    case "daily_rate_x_days":
      if (fields.dailyRateCents === null || fields.dayCount === null) return "dailyRateCents and dayCount";
      return null;
    case "percent_of_base":
      if (fields.baseCents === null || fields.percentBps === null) return "baseCents and percentBps";
      return null;
  }
}

export function accrualTemplateIdFor(
  clientId: string,
  fields: z.infer<typeof newAccrualTemplateFieldsSchema>,
): string {
  return derivedId(`${clientId}:${canonicalJson(fields)}`, "cfg-create-accrual-template", 0);
}

export const cfgCreateAccrualTemplate: Run<CreateAccrualTemplateScope, Proposal> = {
  type: "CFG-CREATE-ACCRUAL-TEMPLATE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:accrual-template:${accrualTemplateIdFor(scope.clientId, scope.fields)}`,
  scopeSchema: createAccrualTemplateScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateAccrualTemplateScope>> {
    const candidateIds = [accrualTemplateIdFor(scope.clientId, scope.fields)];
    const versions = [{ id: "CFG-CREATE-ACCRUAL-TEMPLATE", version: 1 }];
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
    const id = accrualTemplateIdFor(scope.clientId, scope.fields);

    const existing = await tx.query("accrual_templates_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    if (existing.some((t) => t.id === id)) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: id, reason: "already_applied", detail: "an identical accrual template already exists for this client" }],
        [],
        BigInt(0),
      );
    }

    const chart = await tx.query("chart_accounts_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const knownNumbers = new Set(chart.map((a) => a.accountNumber));
    for (const [label, number] of [
      ["debit", scope.fields.debitAccount],
      ["credit", scope.fields.creditAccount],
    ] as const) {
      if (!knownNumbers.has(number)) {
        errors.push({
          rowId: id,
          code: ERR_ACCRUAL_UNKNOWN_ACCOUNT,
          message: `${label} account ${number} is not on client ${scope.clientId}'s chart`,
          retryable: false,
        });
      }
    }

    if (scope.fields.categoryId !== null) {
      const categories = await tx.query("categories_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
      const index = categoryIndex(categories);
      if (!index.has(scope.fields.categoryId)) {
        errors.push({
          rowId: id,
          code: ERR_ACCRUAL_UNKNOWN_CATEGORY,
          message: `category ${scope.fields.categoryId} does not belong to client ${scope.clientId}`,
          retryable: false,
        });
      }
    }
    if (errors.length > 0) return makeResult<Proposal>(1, [], [], errors, BigInt(0));

    const missing = missingBasisFields(scope.fields);
    if (missing !== null) {
      errors.push({
        rowId: id,
        code: ERR_ACCRUAL_MISSING_BASIS_FIELDS,
        message: `basis ${scope.fields.basis} requires ${missing}, which this template does not set`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const row: Record<string, unknown> = {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      version: 1,
      name: scope.fields.name,
      accrualKind: scope.fields.accrualKind,
      basis: scope.fields.basis,
      debitAccount: scope.fields.debitAccount,
      creditAccount: scope.fields.creditAccount,
      categoryId: scope.fields.categoryId,
      fixedAmountCents: scope.fields.fixedAmountCents === null ? null : BigInt(scope.fields.fixedAmountCents),
      sourceDocumentId: scope.fields.sourceDocumentId,
      sourceDocumentAmountCents:
        scope.fields.sourceDocumentAmountCents === null ? null : BigInt(scope.fields.sourceDocumentAmountCents),
      dailyRateCents: scope.fields.dailyRateCents === null ? null : BigInt(scope.fields.dailyRateCents),
      dayCount: scope.fields.dayCount,
      baseCents: scope.fields.baseCents === null ? null : BigInt(scope.fields.baseCents),
      percentBps: scope.fields.percentBps,
      entryMemo: scope.fields.entryMemo,
      autoReverse: scope.fields.autoReverse,
      isActive: scope.fields.isActive,
      manualOverride: false,
    };

    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "accrual_templates",
      rowId: id,
      row,
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [insert], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-ACCRUAL-TEMPLATE", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
