/**
 * CFG-CREATE-BUDGET-THRESHOLD tests. Audit fix, problem 7: the client
 * default row (accountNumber null), a per-account override, a duplicate
 * of either refused as already applied, and an unknown account refused.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, baseDb, chartAccount, opts } from "./fixtures";
import {
  ERR_BUDGET_THRESHOLD_UNKNOWN_ACCOUNT,
  budgetThresholdIdFor,
  cfgCreateBudgetThreshold,
  type CreateBudgetThresholdScope,
} from "../runs/cfg-create-budget-threshold";
import type { BudgetThresholdRow } from "../tables";

function fieldsFor(
  extra: Partial<CreateBudgetThresholdScope["fields"]> = {},
): CreateBudgetThresholdScope["fields"] {
  return {
    accountNumber: null,
    varianceFloorCents: 10000,
    varianceThresholdBp: 1000,
    note: "Ten percent or a thousand dollars, whichever is greater",
    ...extra,
  };
}

test("cfg-create-budget-threshold: the client default is inserted", async () => {
  const db = baseDb();
  const scope: CreateBudgetThresholdScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const preview = await execute(db, cfgCreateBudgetThreshold, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, cfgCreateBudgetThreshold, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const id = budgetThresholdIdFor(CLIENT_A1, null);
  const row = (db.all("budget_thresholds") as BudgetThresholdRow[]).find((t) => t.id === id);
  assert(row !== undefined, "the default threshold row exists");
  assertEqual(row?.accountNumber, null, "a null account number is the default");
});

test("cfg-create-budget-threshold: a per-account override is a separate row from the default", async () => {
  const db = baseDb();
  db.seed("chart_accounts", [chartAccount("CH-A1-6300", FIRM_A, CLIENT_A1, "6300", "Rent")]);
  const defaultScope: CreateBudgetThresholdScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const defaultPreview = await execute(db, cfgCreateBudgetThreshold, defaultScope, opts("preview"));
  await execute(db, cfgCreateBudgetThreshold, defaultScope, opts("apply", { previewRunId: defaultPreview.executionId }));

  const scope: CreateBudgetThresholdScope = {
    clientId: CLIENT_A1,
    fields: fieldsFor({ accountNumber: "6300", varianceThresholdBp: 500 }),
  };
  const preview = await execute(db, cfgCreateBudgetThreshold, scope, opts("preview"));
  assertEqual(preview.status, "completed", "the per-account override is a different row, not a no op");
  const applied = await execute(db, cfgCreateBudgetThreshold, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const rows = db.all("budget_thresholds") as BudgetThresholdRow[];
  assertEqual(rows.length, 2, "the default and the override both exist");
});

test("cfg-create-budget-threshold: a second default for the same client is a no op", async () => {
  const db = baseDb();
  const scope: CreateBudgetThresholdScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const first = await execute(db, cfgCreateBudgetThreshold, scope, opts("preview"));
  await execute(db, cfgCreateBudgetThreshold, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, cfgCreateBudgetThreshold, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
});

test("cfg-create-budget-threshold: an unknown account on an override is refused", async () => {
  const db = baseDb();
  const scope: CreateBudgetThresholdScope = { clientId: CLIENT_A1, fields: fieldsFor({ accountNumber: "6399" }) };
  const preview = await execute(db, cfgCreateBudgetThreshold, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === ERR_BUDGET_THRESHOLD_UNKNOWN_ACCOUNT),
    "named error code",
  );
});
