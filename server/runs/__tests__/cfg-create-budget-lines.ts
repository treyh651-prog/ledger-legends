/**
 * CFG-CREATE-BUDGET-LINES tests. Audit fix, problem 7: a bulk period insert,
 * a line that already exists for that exact combination skipped, and an
 * unknown account refused.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, baseDb, chartAccount, opts } from "./fixtures";
import {
  ERR_BUDGET_UNKNOWN_ACCOUNT,
  budgetLineIdFor,
  cfgCreateBudgetLines,
  type CreateBudgetLinesScope,
} from "../runs/cfg-create-budget-lines";
import type { BudgetRow } from "../tables";

function budgetDb() {
  const db = baseDb();
  db.seed("chart_accounts", [
    chartAccount("CH-A1-6100", FIRM_A, CLIENT_A1, "6100", "Software"),
    chartAccount("CH-A1-6300", FIRM_A, CLIENT_A1, "6300", "Rent"),
  ]);
  return db;
}

test("cfg-create-budget-lines: a bulk set of period lines is inserted", async () => {
  const db = budgetDb();
  const scope: CreateBudgetLinesScope = {
    clientId: CLIENT_A1,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    lines: [
      { accountNumber: "6100", classId: null, locationId: null, programId: null, budgetCents: 50000 },
      { accountNumber: "6300", classId: null, locationId: null, programId: null, budgetCents: 200000 },
    ],
  };
  const preview = await execute(db, cfgCreateBudgetLines, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, cfgCreateBudgetLines, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const rows = db.all("budgets") as BudgetRow[];
  assertEqual(rows.length, 2, "both lines inserted");
  assertEqual(rows.find((r) => r.accountNumber === "6100")?.budgetCents, BigInt(50000), "software budget carried through");
});

test("cfg-create-budget-lines: an existing line for the same period and account is skipped", async () => {
  const db = budgetDb();
  const scope: CreateBudgetLinesScope = {
    clientId: CLIENT_A1,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    lines: [{ accountNumber: "6100", classId: null, locationId: null, programId: null, budgetCents: 50000 }],
  };
  const first = await execute(db, cfgCreateBudgetLines, scope, opts("preview"));
  await execute(db, cfgCreateBudgetLines, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, cfgCreateBudgetLines, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(second.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("cfg-create-budget-lines: an unknown account is refused", async () => {
  const db = budgetDb();
  const scope: CreateBudgetLinesScope = {
    clientId: CLIENT_A1,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    lines: [{ accountNumber: "6199", classId: null, locationId: null, programId: null, budgetCents: 50000 }],
  };
  const preview = await execute(db, cfgCreateBudgetLines, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_BUDGET_UNKNOWN_ACCOUNT), "named error code");
  const id = budgetLineIdFor(CLIENT_A1, "2026-01-01", scope.lines[0]);
  assert(!(db.all("budgets") as BudgetRow[]).some((r) => r.id === id), "nothing was inserted");
});
