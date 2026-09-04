/**
 * INTAKE-BUILD-CHART tests.
 *
 * The framework invariants first, then the five things the chart builder has to
 * get right: what a template produces, what the clearing block forces in, what a
 * struck row does, what a person's own account name survives, and what happens
 * on the second press.
 */

import { assert, assertEqual, test } from "./harness";
import { isFieldWrite, isRowInsert } from "../contract";
import {
  FIRM_A,
  INTAKE_CLIENT,
  WIZARD_INDUSTRIES,
  accountByNumber,
  accountNumbersOf,
  accountsOf,
  applyIntake,
  categoriesOf,
  chartScope,
  errorCodes,
  intakeDb,
  previewIntake,
  seedAccount,
  shapeOf,
} from "./intake-fixtures";
import { accountIdOf, intakeBuildChart, planFor } from "../runs/intake-build-chart";
import { MANDATORY_CLEARING_ACCOUNTS, contraFor } from "../runs/intake-shared";

test("build chart, preview and apply propose the identical set", async () => {
  const db = intakeDb();
  const { preview, applied } = await applyIntake(db, intakeBuildChart, chartScope());
  assertEqual(
    shapeOf(applied.result.proposals),
    shapeOf(preview.result.proposals),
    "apply proposed exactly what preview showed",
  );
});

test("build chart, a fresh client gets the whole services chart", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeBuildChart, chartScope());
  const accounts = accountsOf(db);
  const plan = planFor(chartScope());
  assertEqual(accounts.length, plan.accounts.length, "every planned account landed");
  assert(accounts.length > 40, "a real chart, not a stub");
  assert(
    accounts.every((a) => /^[0-9]{4}$/.test(a.accountNumber)),
    "every account number is four digits",
  );
  assert(
    accounts.every((a) => a.name.trim().length > 0),
    "and every account is named",
  );
});

test("build chart, the mandatory clearing block is always present", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeBuildChart, chartScope());
  const numbers = new Set(accountNumbersOf(db));
  for (const required of MANDATORY_CLEARING_ACCOUNTS) {
    assert(numbers.has(required), `clearing account ${required} is on the chart`);
  }
});

test("build chart, striking a clearing account does not remove it", async () => {
  const db = intakeDb();
  await applyIntake(
    db,
    intakeBuildChart,
    chartScope({ excludeAccountNumbers: ["1990", "6420"] }),
  );
  const numbers = new Set(accountNumbersOf(db));
  assert(numbers.has("1990"), "suspense survived being struck, because every run needs it");
  assert(!numbers.has("6420"), "an ordinary struck account really is gone");
});

test("build chart, an added row lands and brings its contra when it is a fixed asset", async () => {
  const db = intakeDb();
  await applyIntake(
    db,
    intakeBuildChart,
    chartScope({
      addAccounts: [
        { accountNumber: "1560", name: "Kiln and firing equipment", normalSide: "debit" },
      ],
    }),
  );
  const numbers = new Set(accountNumbersOf(db));
  assert(numbers.has("1560"), "the row the firm typed is on the chart");
  const contra = contraFor("1560");
  assert(contra !== null, "a 15xx account has a contra number");
  assert(numbers.has(contra ?? ""), "and the accumulated depreciation contra came with it");
});

test("build chart, every fixed asset cost account is paired with its contra", async () => {
  const db = intakeDb();
  await applyIntake(
    db,
    intakeBuildChart,
    chartScope({ scopeKeys: ["fixed_assets", "vehicles"] }),
  );
  const numbers = new Set(accountNumbersOf(db));
  for (const number of numbers) {
    const contra = contraFor(number);
    if (contra === null) continue;
    assert(numbers.has(contra), `${number} is paired with ${contra}`);
  }
});

test("build chart, a scope question the client did not answer adds nothing", async () => {
  const withInventory = planFor(chartScope({ industry: "product", scopeKeys: ["inventory"] }));
  const without = planFor(chartScope({ industry: "product", scopeKeys: [] }));
  assert(
    withInventory.accounts.length > without.accounts.length,
    "answering the inventory question adds accounts",
  );
});

test("build chart, the second press is a no operation", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeBuildChart, chartScope());
  const first = accountsOf(db).length;
  const again = await previewIntake(db, intakeBuildChart, chartScope());
  assertEqual(again.result.proposals.length, 0, "nothing left to propose");
  assert(again.result.skips.length > 0, "every account is reported instead");
  assert(
    again.result.skips.every((s) => s.reason === "already_applied"),
    "and the reason is that the row is already there",
  );
  assertEqual(accountsOf(db).length, first, "the chart did not grow");
});

test("build chart, a derived account id is stable across executions", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeBuildChart, chartScope());
  const row = accountByNumber(db, "1990");
  assert(row !== undefined, "suspense exists");
  assertEqual(
    row?.id,
    accountIdOf(INTAKE_CLIENT, "1990"),
    "the id is the derived id, not a fresh ULID",
  );
});

test("build chart, an account a person renamed is never rewritten", async () => {
  const db = intakeDb();
  seedAccount(db, "1990", "Ask my bookkeeper");
  const outcome = await previewIntake(db, intakeBuildChart, chartScope());
  const touches1990 = outcome.result.proposals.some(
    (p) => isRowInsert(p) && p.row.accountNumber === "1990",
  );
  assert(!touches1990, "the run proposed nothing at all for the renamed account");
  await applyIntake(db, intakeBuildChart, chartScope());
  assertEqual(
    accountByNumber(db, "1990")?.name,
    "Ask my bookkeeper",
    "the name a person chose survived",
  );
});

test("build chart, the run only ever inserts and never writes a field", async () => {
  const db = intakeDb();
  const outcome = await previewIntake(db, intakeBuildChart, chartScope());
  assert(outcome.result.proposals.length > 0, "there is something to check");
  assert(
    !outcome.result.proposals.some((p) => isFieldWrite(p)),
    "no existing row is ever amended by the chart builder",
  );
  for (const p of outcome.result.proposals) {
    if (!isRowInsert(p)) continue;
    assert(
      p.table === "chart_accounts" || p.table === "categories",
      `${p.table} is one of the two tables this run owns`,
    );
  }
});

test("build chart, categories are seeded and point at accounts that exist", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeBuildChart, chartScope());
  const numbers = new Set(accountNumbersOf(db));
  const categories = categoriesOf(db);
  assert(categories.length > 10, "the category spine landed");
  for (const c of categories) {
    assert(numbers.has(c.accountNumber), `${c.id} points at account ${c.accountNumber}`);
    assert(c.id.startsWith("CAT-"), `${c.id} carries the published id shape`);
    assert(c.isActive, `${c.id} is active`);
    assert(
      c.normalSide === "debit" || c.normalSide === "credit",
      `${c.id} has a normal side`,
    );
  }
});

test("build chart, an unknown template is an error and writes nothing", async () => {
  const db = intakeDb();
  const outcome = await previewIntake(
    db,
    intakeBuildChart,
    chartScope({ industry: "yacht_racing" }),
  );
  assertEqual(errorCodes(outcome).join(","), "UNKNOWN_TEMPLATE", "the run said why it stopped");
  assertEqual(outcome.result.proposals.length, 0, "and proposed nothing");
});

test("build chart, every one of the five wizard industries resolves to a template", () => {
  for (const industry of WIZARD_INDUSTRIES) {
    const plan = planFor(chartScope({ industry }));
    assert(plan.accounts.length > 30, `${industry} produces a real chart`);
    assert(plan.templateId.startsWith("TPL-"), `${industry} maps onto a published template`);
  }
});

test("build chart, one client's chart does not leak into another", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeBuildChart, chartScope());
  assert(
    accountsOf(db).every((a) => a.clientId === INTAKE_CLIENT && a.firmId === FIRM_A),
    "every row written is stamped with the client and firm it was run for",
  );
  assertEqual(
    db.all("chart_accounts").filter((a) => a.clientId !== INTAKE_CLIENT).length,
    0,
    "and no row landed anywhere else",
  );
});
