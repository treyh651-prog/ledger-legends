/**
 * CFG-CREATE-RECURRING-TEMPLATE tests. The clean create, an unbalanced
 * fixed-split template refused before it is ever stored, a basis point
 * template with no driver amount refused the same way, an unsupported
 * cadence refused, day_n with no day named refused, an unknown account and
 * an unknown category each refused, a repeat create treated as already
 * applied, and the created template actually posting through
 * PER-POST-RECURRING with no further code involved.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, opts } from "./fixtures";
import { category } from "./coding-fixtures";
import {
  ERR_RECURRING_TEMPLATE_CADENCE_NOT_SUPPORTED,
  ERR_RECURRING_TEMPLATE_DAY_OF_MONTH_REQUIRED,
  ERR_RECURRING_TEMPLATE_UNKNOWN_ACCOUNT,
  ERR_RECURRING_TEMPLATE_UNKNOWN_CATEGORY,
  cfgCreateRecurringTemplate,
  recurringTemplateIdFor,
  type CreateRecurringTemplateScope,
} from "../runs/cfg-create-recurring-template";
import { RECURRING_ERROR_CODES, perPostRecurring } from "../runs/per-post-recurring";
import { applyPer, perDb, periodScope } from "./per-fixtures";
import type { RecurringSplitRow, RecurringTemplateRow } from "../tables";

function recurringDb() {
  const db = perDb();
  db.seed("categories", [
    category("CAT-RENT", "6100"),
    category("CAT-ACCRUED", "2200", { normalSide: "credit" }),
  ]);
  return db;
}

function scopeFor(
  fields: Partial<CreateRecurringTemplateScope["fields"]> = {},
): CreateRecurringTemplateScope {
  return {
    clientId: CLIENT_A1,
    fields: {
      name: "Office rent",
      cadence: "monthly",
      startDate: "2026-01-01",
      endDate: null,
      postingDateRule: "period_end",
      dayOfMonth: null,
      driverAmountCents: null,
      entryMemoTemplate: null,
      isActive: true,
      splits: [
        { accountNumber: "6100", categoryId: "CAT-RENT", fixedAmountCents: 250000, percentBps: null, isRemainder: false, classId: null, locationId: null, programId: null, memo: null },
        { accountNumber: "2200", categoryId: "CAT-ACCRUED", fixedAmountCents: -250000, percentBps: null, isRemainder: false, classId: null, locationId: null, programId: null, memo: null },
      ],
      ...fields,
    },
  };
}

async function createAndApply(db: ReturnType<typeof recurringDb>, scope: CreateRecurringTemplateScope) {
  const preview = await execute(db, cfgCreateRecurringTemplate, scope, opts("preview"));
  const applied = await execute(db, cfgCreateRecurringTemplate, scope, opts("apply", { previewRunId: preview.executionId }));
  return { preview, applied };
}

test("cfg-create-recurring-template: a balanced fixed-split template is created with its two split lines", async () => {
  const db = recurringDb();
  const { applied } = await createAndApply(db, scopeFor());
  assertEqual(applied.status, "completed", "apply completed");

  const id = recurringTemplateIdFor(CLIENT_A1, "Office rent");
  const template = (db.all("recurring_templates") as unknown as RecurringTemplateRow[]).find((t) => t.id === id);
  assertEqual(template?.matchKind, "generated_entry", "always generated_entry from this run");
  assertEqual(template?.cadence, "monthly", "the named cadence");
  assertEqual(template?.nextDueDate, "2026-01-01", "set to startDate, cosmetic, nothing reads it back");
  assertEqual(template?.isActive, true, "active by default");

  const splits = (db.all("recurring_splits") as unknown as RecurringSplitRow[]).filter((s) => s.templateId === id);
  assertEqual(splits.length, 2, "both split lines inserted");
  assertEqual(splits.find((s) => s.accountNumber === "6100")?.fixedAmountCents, BigInt(250000), "converted to a real bigint");
  assertEqual(splits.find((s) => s.accountNumber === "2200")?.fixedAmountCents, BigInt(-250000), "converted to a real bigint");
});

test("cfg-create-recurring-template: the created template actually posts through PER-POST-RECURRING, no further code involved", async () => {
  const db = recurringDb();
  await createAndApply(db, scopeFor());
  const { applied } = await applyPer(db, perPostRecurring, periodScope());
  assert(applied.status === "completed" || applied.status === "completed_with_skips", `status ${applied.status}`);
  const entries = db.all("journal_entries");
  assertEqual(entries.length, 1, "one posted entry for the created template");
  assertEqual(entries[0].sourceRowId, recurringTemplateIdFor(CLIENT_A1, "Office rent"), "sourced from the template this run created");
});

test("cfg-create-recurring-template: fixed splits that do not sum to zero are refused before anything is stored", async () => {
  const db = recurringDb();
  const preview = await execute(
    db,
    cfgCreateRecurringTemplate,
    scopeFor({
      splits: [
        { accountNumber: "6100", categoryId: "CAT-RENT", fixedAmountCents: 250000, percentBps: null, isRemainder: false, classId: null, locationId: null, programId: null, memo: null },
      ],
    }),
    opts("preview"),
  );
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === RECURRING_ERROR_CODES.unbalancedTemplate), "the same code PER-POST-RECURRING would fail with later");
  assertEqual(db.all("recurring_templates").length, 0, "nothing was created");
});

test("cfg-create-recurring-template: basis point splits with no driver amount are refused", async () => {
  const db = recurringDb();
  const preview = await execute(
    db,
    cfgCreateRecurringTemplate,
    scopeFor({
      splits: [
        { accountNumber: "6100", categoryId: "CAT-RENT", fixedAmountCents: null, percentBps: 10000, isRemainder: false, classId: null, locationId: null, programId: null, memo: null },
        { accountNumber: "2200", categoryId: "CAT-ACCRUED", fixedAmountCents: null, percentBps: null, isRemainder: true, classId: null, locationId: null, programId: null, memo: null },
      ],
    }),
    opts("preview"),
  );
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === RECURRING_ERROR_CODES.missingDriver), "named error code");
});

test("cfg-create-recurring-template: a cadence PER-POST-RECURRING can never act on is refused", async () => {
  const db = recurringDb();
  const preview = await execute(db, cfgCreateRecurringTemplate, scopeFor({ cadence: "weekly" }), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_RECURRING_TEMPLATE_CADENCE_NOT_SUPPORTED), "named error code");
});

test("cfg-create-recurring-template: posting_date_rule day_n with no day named is refused", async () => {
  const db = recurringDb();
  const preview = await execute(db, cfgCreateRecurringTemplate, scopeFor({ postingDateRule: "day_n" }), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_RECURRING_TEMPLATE_DAY_OF_MONTH_REQUIRED), "named error code");
});

test("cfg-create-recurring-template: a split naming an account not on the chart is refused", async () => {
  const db = recurringDb();
  const preview = await execute(
    db,
    cfgCreateRecurringTemplate,
    scopeFor({
      splits: [
        { accountNumber: "9999", categoryId: "CAT-RENT", fixedAmountCents: 250000, percentBps: null, isRemainder: false, classId: null, locationId: null, programId: null, memo: null },
        { accountNumber: "2200", categoryId: "CAT-ACCRUED", fixedAmountCents: -250000, percentBps: null, isRemainder: false, classId: null, locationId: null, programId: null, memo: null },
      ],
    }),
    opts("preview"),
  );
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_RECURRING_TEMPLATE_UNKNOWN_ACCOUNT), "named error code");
});

test("cfg-create-recurring-template: a split naming a category not on the client's own list is refused", async () => {
  const db = recurringDb();
  const preview = await execute(
    db,
    cfgCreateRecurringTemplate,
    scopeFor({
      splits: [
        { accountNumber: "6100", categoryId: "CAT-DOES-NOT-EXIST", fixedAmountCents: 250000, percentBps: null, isRemainder: false, classId: null, locationId: null, programId: null, memo: null },
        { accountNumber: "2200", categoryId: "CAT-ACCRUED", fixedAmountCents: -250000, percentBps: null, isRemainder: false, classId: null, locationId: null, programId: null, memo: null },
      ],
    }),
    opts("preview"),
  );
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_RECURRING_TEMPLATE_UNKNOWN_CATEGORY), "named error code");
});

test("cfg-create-recurring-template: creating the same name twice is a no op the second time", async () => {
  const db = recurringDb();
  await createAndApply(db, scopeFor());
  const preview = await execute(db, cfgCreateRecurringTemplate, scopeFor(), opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(preview.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("cfg-create-recurring-template: undo does nothing, every proposal here is an insert", async () => {
  const db = recurringDb();
  const { applied } = await createAndApply(db, scopeFor());
  const undone = await executeUndo(db, cfgCreateRecurringTemplate, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "no_op", "nothing to revert");
  assertEqual(db.all("recurring_templates").length, 1, "the template created by the insert is still there");
});
