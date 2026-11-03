/**
 * The backfill script's own claim: re-triggering INTAKE-BUILD-CHART for a
 * client onboarded before 1420/CAT-DUE-FROM-RELATED existed inserts exactly
 * those two rows and nothing else, because propose() is per-row idempotent
 * (intake-build-chart.ts) and 1420's scopeKey is "always."
 *
 * The fixture simulates "onboarded before this round" by excluding 1420 on
 * the first build, the same shape a real pre-existing client's chart would
 * have (the account simply never existed to seed).
 */

import { assert, assertEqual, test } from "./harness";
import { isRowInsert } from "../contract";
import { accountNumbersOf, applyIntake, categoriesOf, chartScope, intakeDb, previewIntake } from "./intake-fixtures";
import { intakeBuildChart } from "../runs/intake-build-chart";

test("backfill: a client onboarded before 1420 existed is missing it and the category", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeBuildChart, chartScope({ excludeAccountNumbers: ["1420"] }));
  assert(!accountNumbersOf(db).includes("1420"), "1420 was excluded, simulating a pre-existing client");
  assert(!categoriesOf(db).some((c) => c.id === "CAT-DUE-FROM-RELATED"), "its category never landed either");
});

test("backfill: re-triggering with no exclusions inserts exactly the one account and one category", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeBuildChart, chartScope({ excludeAccountNumbers: ["1420"] }));
  const before = accountNumbersOf(db).length;

  const rerun = chartScope();
  const preview = await previewIntake(db, intakeBuildChart, rerun);
  const inserts = preview.result.proposals.filter(isRowInsert);
  assertEqual(inserts.length, 2, "exactly one account and one category insert");
  assert(inserts.some((p) => p.table === "chart_accounts" && (p.row as { accountNumber: string }).accountNumber === "1420"), "the account insert");
  assert(inserts.some((p) => p.table === "categories" && p.rowId === "CAT-DUE-FROM-RELATED"), "the category insert");
  assert(
    preview.result.skips.every((s) => s.reason === "already_applied"),
    "every other row on the already-built chart is reported already_applied",
  );

  await applyIntake(db, intakeBuildChart, rerun);
  assertEqual(accountNumbersOf(db).length, before + 1, "exactly one new account landed");
  assert(categoriesOf(db).some((c) => c.id === "CAT-DUE-FROM-RELATED"), "and its category");
});

test("backfill: a second re-run is a true no op", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeBuildChart, chartScope({ excludeAccountNumbers: ["1420"] }));
  await applyIntake(db, intakeBuildChart, chartScope());
  const again = await previewIntake(db, intakeBuildChart, chartScope());
  assertEqual(again.result.proposals.length, 0, "nothing left to insert");
});
