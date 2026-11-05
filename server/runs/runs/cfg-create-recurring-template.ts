/**
 * CFG-CREATE-RECURRING-TEMPLATE, version 1.
 *
 * subledger.recurring_templates has carried a `generated_entry` match_kind
 * since migration 0005, and PER-POST-RECURRING has been able to post one in
 * full -- cadence, posting day, fixed or basis point splits, idempotency,
 * undo -- since before this round. Nothing has ever created one: the whole
 * insert path for this table was missing (apply-writer.ts had no case for
 * either recurring_templates or recurring_splits), the deepest instance yet
 * of this engagement's "nothing creates the first row" pattern, because the
 * run that was missing was the posting run's own *input*, not a sibling of
 * it. This run closes that gap for generated_entry templates specifically.
 * A transaction_match template -- the one that waits for a bank row rather
 * than generating its own entry -- has the identical gap and is left
 * unbuilt, flagged the same way this engagement leaves a sibling bug
 * unfixed when it is out of the round's named scope.
 *
 * Validates up front, rather than letting a broken template sit on the
 * books failing silently every period, exactly the three ways
 * PER-POST-RECURRING's own buildLines() can fail (unbalanced fixed splits,
 * a missing driver amount for basis point splits, the wrong number of
 * remainder lines) by calling that same function here against the
 * proposed splits before ever inserting them -- the one existing
 * implementation of "does this template produce a valid entry," not a
 * second copy of it. Also refuses a cadence PER-POST-RECURRING's own
 * dueness() can never act on (weekly, semi_monthly -- both legal under the
 * DB's rec_cadence check, neither period shaped), and a posting_date_rule
 * of day_n with no day named, since postingDayFor() would silently treat
 * that as period_end anyway and a person who chose day_n meant something
 * by it.
 *
 * next_due_date is required not null by rec_generated_needs_cadence, but
 * grepped zero hits anywhere in server/runs -- PER-POST-RECURRING computes
 * dueness from start_date and cadence directly (per-shared.ts's
 * cadenceDueIn), never from this column. Same call as ledger.accounts.
 * contra_of: cosmetic, satisfied with the template's own start date so the
 * constraint passes, not worth maintaining going forward since nothing
 * ever reads it. split_mode is the identical situation -- PER-POST-RECURRING
 * derives whether a template uses percent splits from the splits
 * themselves, never from this column -- so it is set here to describe
 * what was actually entered, for a human reading the row, and nothing more.
 *
 * id is derived from the client and the name, the same natural-key idiom
 * CFG-CREATE-CATEGORY/CFG-CREATE-RULE use, not a fresh ulid() (which
 * cannot be called inside propose() at all -- see cfg-create-rule.ts's own
 * note on this). Split line ids are derived from the template id and line
 * number.
 */

import { z } from "zod";
import {
  makeResult,
  type Cents,
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
import { SUPPORTED_CADENCES } from "./per-shared";
import { RECURRING_ERROR_CODES, buildLines } from "./per-post-recurring";
import type { RecurringSplitRow, RecurringTemplateRow } from "../tables";

const splitLineSchema = z
  .object({
    accountNumber: z.string().regex(/^[0-9]{4}$/),
    categoryId: z.string().min(1),
    // Plain numbers, not z.bigint(): the scope arrives as parsed JSON over
    // HTTP, which has no bigint, and JSON.stringify throws on one client
    // side before the request is even sent. Cast to Cents below.
    fixedAmountCents: z.number().int().safe().nullable().default(null),
    percentBps: z.number().int().min(1).max(10000).nullable().default(null),
    isRemainder: z.boolean().default(false),
    classId: z.string().min(1).nullable().default(null),
    locationId: z.string().min(1).nullable().default(null),
    programId: z.string().min(1).nullable().default(null),
    memo: z.string().min(1).nullable().default(null),
  })
  .refine(
    (s) => Number(s.fixedAmountCents !== null) + Number(s.percentBps !== null) + Number(s.isRemainder) === 1,
    { message: "each split line is exactly one of a fixed amount, a basis point share, or the remainder" },
  );

export const newRecurringTemplateFieldsSchema = z.object({
  name: z.string().min(1),
  cadence: z.enum(["weekly", "semi_monthly", "monthly", "quarterly", "semi_annual", "annual"]),
  startDate: z.string().min(10),
  endDate: z.string().min(10).nullable().default(null),
  postingDateRule: z.enum(["period_end", "day_n"]).default("period_end"),
  dayOfMonth: z.number().int().min(1).max(31).nullable().default(null),
  driverAmountCents: z.number().int().safe().nullable().default(null),
  entryMemoTemplate: z.string().min(1).nullable().default(null),
  isActive: z.boolean().default(true),
  splits: z.array(splitLineSchema).min(1),
});

export const createRecurringTemplateScopeSchema = z.object({
  clientId: z.string().min(1),
  fields: newRecurringTemplateFieldsSchema,
});

export type CreateRecurringTemplateScope = z.infer<typeof createRecurringTemplateScopeSchema>;

export const ERR_RECURRING_TEMPLATE_CADENCE_NOT_SUPPORTED = "CFG-RECURRING-TEMPLATE-CADENCE-NOT-SUPPORTED";
export const ERR_RECURRING_TEMPLATE_DAY_OF_MONTH_REQUIRED = "CFG-RECURRING-TEMPLATE-DAY-OF-MONTH-REQUIRED";
export const ERR_RECURRING_TEMPLATE_UNKNOWN_ACCOUNT = "CFG-RECURRING-TEMPLATE-UNKNOWN-ACCOUNT";
export const ERR_RECURRING_TEMPLATE_UNKNOWN_CATEGORY = "CFG-RECURRING-TEMPLATE-UNKNOWN-CATEGORY";

export function recurringTemplateIdFor(clientId: string, name: string): string {
  return derivedId(`${clientId}:${name}`, "cfg-create-recurring-template", 0);
}

function splitRowFor(
  templateId: string,
  field: z.infer<typeof splitLineSchema>,
  lineNumber: number,
  firmId: string,
  clientId: string,
): RecurringSplitRow {
  return {
    id: derivedId(`${templateId}:${lineNumber}`, "cfg-create-recurring-template-split", 0),
    firmId,
    clientId,
    templateId,
    templateVersion: 1,
    lineNumber,
    categoryId: field.categoryId,
    accountNumber: field.accountNumber,
    fixedAmountCents: field.fixedAmountCents === null ? null : (BigInt(field.fixedAmountCents) as Cents),
    percentBps: field.percentBps,
    isRemainder: field.isRemainder,
    classId: field.classId,
    locationId: field.locationId,
    programId: field.programId,
    memo: field.memo,
  };
}

export const cfgCreateRecurringTemplate: Run<CreateRecurringTemplateScope, Proposal> = {
  type: "CFG-CREATE-RECURRING-TEMPLATE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:recurring-template:${recurringTemplateIdFor(scope.clientId, scope.fields.name)}`,
  scopeSchema: createRecurringTemplateScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateRecurringTemplateScope>> {
    const candidateIds = [recurringTemplateIdFor(scope.clientId, scope.fields.name)];
    const versions = [{ id: "CFG-CREATE-RECURRING-TEMPLATE", version: 1 }];
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
    const id = recurringTemplateIdFor(scope.clientId, scope.fields.name);

    const existing = await tx.query("recurring_templates_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    if (existing.some((t) => t.id === id)) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: id, reason: "already_applied", detail: "a recurring template with this name already exists for this client" }],
        [],
        BigInt(0),
      );
    }

    if (!SUPPORTED_CADENCES.includes(scope.fields.cadence)) {
      errors.push({
        rowId: id,
        code: ERR_RECURRING_TEMPLATE_CADENCE_NOT_SUPPORTED,
        message: `${scope.fields.cadence} posts more than once in a period, which PER-POST-RECURRING cannot represent; use monthly, quarterly, semi_annual, or annual`,
        retryable: false,
      });
    }
    if (scope.fields.postingDateRule === "day_n" && scope.fields.dayOfMonth === null) {
      errors.push({
        rowId: id,
        code: ERR_RECURRING_TEMPLATE_DAY_OF_MONTH_REQUIRED,
        message: "posting_date_rule day_n needs a day of month, or it silently posts at period end anyway",
        retryable: false,
      });
    }

    const chart = await tx.query("chart_accounts_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const knownNumbers = new Set(chart.map((a) => a.accountNumber));
    const categories = categoryIndex(await tx.query("categories_for_client", { firmId: ctx.firmId, clientId: scope.clientId }));
    for (const split of scope.fields.splits) {
      if (!knownNumbers.has(split.accountNumber)) {
        errors.push({
          rowId: id,
          code: ERR_RECURRING_TEMPLATE_UNKNOWN_ACCOUNT,
          message: `account ${split.accountNumber} is not on client ${scope.clientId}'s chart`,
          retryable: false,
        });
      }
      if (!categories.has(split.categoryId)) {
        errors.push({
          rowId: id,
          code: ERR_RECURRING_TEMPLATE_UNKNOWN_CATEGORY,
          message: `category ${split.categoryId} does not belong to client ${scope.clientId}`,
          retryable: false,
        });
      }
    }
    if (errors.length > 0) return makeResult<Proposal>(1, [], [], errors, BigInt(0));

    const template: RecurringTemplateRow = {
      id,
      firmId: ctx.firmId,
      clientId: scope.clientId,
      version: 1,
      name: scope.fields.name,
      matchKind: "generated_entry",
      matchNormalizedName: null,
      bankAccountId: null,
      amountMode: "fixed_amount",
      matchAmountCents: null,
      amountFloorCents: null,
      amountCeilingCents: null,
      dayOfMonth: scope.fields.dayOfMonth,
      dayWindow: 5,
      // Cosmetic, like nextDueDate below -- PER-POST-RECURRING derives
      // whether a template uses percent splits from the splits themselves,
      // never from this column. Set to describe what was actually entered.
      splitMode: scope.fields.splits.some((s) => s.percentBps !== null) ? "fixed_percent" : "single",
      isActive: scope.fields.isActive,
      cadence: scope.fields.cadence,
      startDate: scope.fields.startDate,
      endDate: scope.fields.endDate,
      nextDueDate: scope.fields.startDate,
      postingDateRule: scope.fields.postingDateRule,
      driverAmountCents: scope.fields.driverAmountCents === null ? null : (BigInt(scope.fields.driverAmountCents) as Cents),
      entryMemoTemplate: scope.fields.entryMemoTemplate,
      manualOverride: false,
      createdAt: NOW_PLACEHOLDER as unknown as string,
      createdBy: ACTOR_PLACEHOLDER as unknown as string,
    };

    const splitRows = scope.fields.splits.map((s, i) => splitRowFor(id, s, i + 1, ctx.firmId, scope.clientId));

    // The one existing implementation of "does this template produce a
    // valid entry" -- PER-POST-RECURRING's own buildLines -- run here
    // against a synthetic posting day, so a template that would fail every
    // period at posting time is refused now instead.
    const built = buildLines(template, splitRows, scope.fields.startDate);
    if ("code" in built) {
      errors.push({ rowId: id, code: built.code, message: built.message, retryable: false });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const proposals: ProposedRowInsert[] = [
      {
        kind: "row_insert",
        table: "recurring_templates",
        rowId: id,
        row: template as unknown as Record<string, unknown>,
        provenance: { cascadeLevel: null },
      },
      ...splitRows.map(
        (row): ProposedRowInsert => ({
          kind: "row_insert",
          table: "recurring_splits",
          rowId: row.id,
          row: row as unknown as Record<string, unknown>,
          provenance: { cascadeLevel: null },
        }),
      ),
    ];

    return makeResult<Proposal>(1, proposals, [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-RECURRING-TEMPLATE", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    // Every proposal here is an insert of a row that had no prior value;
    // inserts never revert in this framework.
    return [];
  },
};
