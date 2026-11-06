/**
 * CFG-CREATE-ACCRUAL-TEMPLATE tests. Audit fix, problem 7: the insert, a
 * basis missing its own required companion field refused before PER-POST-
 * ACCRUALS ever has to discover that silently, an unknown account refused,
 * and the exact duplicate no-op.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, baseDb, chartAccount, opts } from "./fixtures";
import { codingDb, standardCategories } from "./coding-fixtures";
import {
  ERR_ACCRUAL_MISSING_BASIS_FIELDS,
  ERR_ACCRUAL_UNKNOWN_ACCOUNT,
  ERR_ACCRUAL_UNKNOWN_CATEGORY,
  accrualTemplateIdFor,
  cfgCreateAccrualTemplate,
  type CreateAccrualTemplateScope,
} from "../runs/cfg-create-accrual-template";
import type { AccrualTemplateRow } from "../tables";

function fieldsFor(
  extra: Partial<CreateAccrualTemplateScope["fields"]> = {},
): CreateAccrualTemplateScope["fields"] {
  return {
    name: "Monthly utilities accrual",
    accrualKind: "bill_received_not_entered",
    basis: "fixed_amount",
    debitAccount: "6400",
    creditAccount: "2200",
    categoryId: null,
    fixedAmountCents: 45000,
    sourceDocumentId: null,
    sourceDocumentAmountCents: null,
    dailyRateCents: null,
    dayCount: null,
    baseCents: null,
    percentBps: null,
    entryMemo: "Estimated utilities not yet billed",
    autoReverse: true,
    isActive: true,
    ...extra,
  };
}

function accrualDb() {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("chart_accounts", [
    chartAccount("CH-A1-6400", FIRM_A, CLIENT_A1, "6400", "Utilities expense"),
    chartAccount("CH-A1-2200", FIRM_A, CLIENT_A1, "2200", "Accrued liabilities"),
  ]);
  return db;
}

test("cfg-create-accrual-template: a new template is inserted", async () => {
  const db = accrualDb();
  const scope: CreateAccrualTemplateScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const preview = await execute(db, cfgCreateAccrualTemplate, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, cfgCreateAccrualTemplate, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const id = accrualTemplateIdFor(CLIENT_A1, scope.fields);
  const row = (db.all("accrual_templates") as AccrualTemplateRow[]).find((t) => t.id === id);
  assert(row !== undefined, "the template row exists");
  assertEqual(row?.fixedAmountCents, BigInt(45000), "fixed amount carried through");
});

test("cfg-create-accrual-template: the exact same template twice is a no op the second time", async () => {
  const db = accrualDb();
  const scope: CreateAccrualTemplateScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const first = await execute(db, cfgCreateAccrualTemplate, scope, opts("preview"));
  await execute(db, cfgCreateAccrualTemplate, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, cfgCreateAccrualTemplate, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
});

test("cfg-create-accrual-template: fixed_amount with no fixedAmountCents is refused", async () => {
  const db = accrualDb();
  const scope: CreateAccrualTemplateScope = {
    clientId: CLIENT_A1,
    fields: fieldsFor({ fixedAmountCents: null }),
  };
  const preview = await execute(db, cfgCreateAccrualTemplate, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_ACCRUAL_MISSING_BASIS_FIELDS), "named error code");
});

test("cfg-create-accrual-template: percent_of_base needs both baseCents and percentBps", async () => {
  const db = accrualDb();
  const scope: CreateAccrualTemplateScope = {
    clientId: CLIENT_A1,
    fields: fieldsFor({ basis: "percent_of_base", fixedAmountCents: null, baseCents: 500000, percentBps: null }),
  };
  const preview = await execute(db, cfgCreateAccrualTemplate, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_ACCRUAL_MISSING_BASIS_FIELDS), "named error code");
});

test("cfg-create-accrual-template: an unknown debit account is refused", async () => {
  const db = accrualDb();
  const scope: CreateAccrualTemplateScope = { clientId: CLIENT_A1, fields: fieldsFor({ debitAccount: "6499" }) };
  const preview = await execute(db, cfgCreateAccrualTemplate, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_ACCRUAL_UNKNOWN_ACCOUNT), "named error code");
});

test("cfg-create-accrual-template: an unknown category is refused", async () => {
  const db = accrualDb();
  const scope: CreateAccrualTemplateScope = { clientId: CLIENT_A1, fields: fieldsFor({ categoryId: "CAT-NOPE" }) };
  const preview = await execute(db, cfgCreateAccrualTemplate, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_ACCRUAL_UNKNOWN_CATEGORY), "named error code");
});
