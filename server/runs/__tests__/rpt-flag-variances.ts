/**
 * RPT-FLAG-VARIANCES tests.
 *
 * The interesting cases are the edges of the two conditions. A variance that
 * clears the percentage but not the floor, a variance that clears the floor but
 * not the percentage, and an account with no budget at all, which is not a
 * percentage question and must not be answered as one.
 */

import { assert, assertEqual, test } from "./harness";
import { PERIOD, addAccount, seedEntry } from "./close-fixtures";
import {
  applyReport,
  budget,
  lockPeriod,
  previewReport,
  reportDb,
  reportScope,
  shapeOf,
  threshold,
  variancesOf,
} from "./rpt-fixtures";
import { rptFlagVariances, varianceIdOf } from "../runs/rpt-flag-variances";

const scope = reportScope();

function rowFor(db: ReturnType<typeof reportDb>, accountNumber: string) {
  return variancesOf(db).find((v) => v.accountNumber === accountNumber);
}

test("variance preview and apply propose the same rows", async () => {
  const db = reportDb();
  const { preview, applied } = await applyReport(db, rptFlagVariances, scope);
  assertEqual(applied.status, "completed", "the apply completed");
  assertEqual(
    shapeOf(applied.result.proposals),
    shapeOf(preview.result.proposals),
    "apply proposed exactly what preview showed",
  );
});

test("variance ids are derived, so a rerun is a no operation", async () => {
  const db = reportDb();
  await applyReport(db, rptFlagVariances, scope);
  assertEqual(
    rowFor(db, "4100")?.id,
    varianceIdOf(PERIOD, "4100"),
    "the id is derived from the period and the account",
  );
  const again = await previewReport(db, rptFlagVariances, scope);
  assertEqual(again.result.proposals.length, 0, "the second call proposes nothing");
  assert(
    again.result.skips.every((s) => s.reason === "already_applied"),
    "and says the rows are already applied",
  );
});

test("two periods do not collide because the period is in the scope hash", async () => {
  const db = reportDb();
  const january = await previewReport(db, rptFlagVariances, scope);
  const february = await previewReport(db, rptFlagVariances, {
    ...scope,
    period: "2026-02-01",
  });
  assert(january.scopeHash !== february.scopeHash, "the two hashes differ");
  assert(
    varianceIdOf(PERIOD, "4100") !== varianceIdOf("2026-02-01", "4100"),
    "and the same account in two periods is two rows",
  );
});

test("a posting changes the ledger fingerprint and so changes the scope hash", async () => {
  const db = reportDb();
  const before = await previewReport(db, rptFlagVariances, scope);
  seedEntry(db, "JE-MORE", "2026-01-25", [
    ["1010", BigInt(9000)],
    ["4100", BigInt(-9000)],
  ]);
  const after = await previewReport(db, rptFlagVariances, scope);
  assert(before.scopeHash !== after.scopeHash, "a posting is a new scope");
});

test("an overridden variance row is never rewritten", async () => {
  const db = reportDb();
  await applyReport(db, rptFlagVariances, scope);
  db.seed(
    "report_variances",
    variancesOf(db).map((v) =>
      v.accountNumber === "4100"
        ? { ...v, manualOverride: true, flagged: false, flagCode: "within_threshold" }
        : v,
    ),
  );
  seedEntry(db, "JE-MORE", "2026-01-25", [
    ["1010", BigInt(9000)],
    ["4100", BigInt(-9000)],
  ]);
  const again = await previewReport(db, rptFlagVariances, scope);
  assert(
    again.result.skips.some(
      (s) => s.rowId === varianceIdOf(PERIOD, "4100") && s.reason === "manual_override",
    ),
    "the overridden row is skipped",
  );
  assertEqual(rowFor(db, "4100")?.flagged, false, "and its flag is left as a person set it");
});

test("an overridden budget row is not used as a comparison", async () => {
  const db = reportDb();
  await applyReport(db, rptFlagVariances, scope);
  db.seed("budgets", [
    { ...budget("BUD-4100", "4100", BigInt(-40000)), manualOverride: true },
    budget("BUD-6100", "6100", BigInt(40000)),
  ]);
  seedEntry(db, "JE-MORE", "2026-01-25", [
    ["1010", BigInt(9000)],
    ["4100", BigInt(-9000)],
  ]);
  const again = await previewReport(db, rptFlagVariances, scope);
  assert(
    again.result.skips.some(
      (s) => s.reason === "manual_override" && s.detail.includes("budget row"),
    ),
    "the run says why it did not recompute against a budget somebody took over",
  );
});

test("a locked period is read, never written", async () => {
  const db = reportDb();
  lockPeriod(db);
  const { applied } = await applyReport(db, rptFlagVariances, scope);
  assertEqual(applied.status, "completed", "the run completes on a locked period");
  assertEqual(db.all("journal_entries").length, 2, "and writes nothing to the ledger");
  assert(variancesOf(db).length > 0, "while still writing its own report rows");
});

test("a variance over both the percentage and the floor is flagged", async () => {
  const db = reportDb();
  await applyReport(db, rptFlagVariances, scope);
  const revenue = rowFor(db, "4100");
  assertEqual(revenue?.actualCents, BigInt(-100000), "actual is the ledger balance");
  assertEqual(revenue?.budgetCents, BigInt(-40000), "budget is the budget row");
  assertEqual(revenue?.varianceCents, BigInt(-60000), "variance is actual less budget");
  assertEqual(revenue?.varianceBp, -15000, "which is one hundred and fifty percent");
  assertEqual(revenue?.flagged, true, "so it is flagged");
  assertEqual(revenue?.flagCode, "over_threshold", "with the over threshold code");
});

test("a variance over the percentage but under the floor is not flagged", async () => {
  const db = reportDb();
  db.seed("budgets", [
    budget("BUD-4100", "4100", BigInt(-90000)),
    budget("BUD-6100", "6100", BigInt(40000)),
  ]);
  await applyReport(db, rptFlagVariances, scope);
  const revenue = rowFor(db, "4100");
  assertEqual(revenue?.varianceCents, BigInt(-10000), "a hundred dollar variance");
  assertEqual(revenue?.varianceBp, -1111, "which is over eleven percent");
  assertEqual(revenue?.flagged, false, "is still under the floor and is not flagged");
  assert(
    (revenue?.detail ?? "").includes("floor"),
    "and the row says the floor is why",
  );
});

test("an account with no budget and real activity is reported as unbudgeted", async () => {
  const db = reportDb();
  addAccount(db, "6200", "Unplanned expense");
  seedEntry(db, "JE-UNPLANNED", "2026-01-26", [
    ["6200", BigInt(80000)],
    ["1010", BigInt(-80000)],
  ]);
  await applyReport(db, rptFlagVariances, scope);
  const row = rowFor(db, "6200");
  assertEqual(row?.budgetCents, BigInt(0), "there is no budget");
  assertEqual(row?.varianceBp, null, "so there is no percentage to state");
  assertEqual(row?.flagged, true, "the activity is still flagged");
  assertEqual(row?.flagCode, "unbudgeted_activity", "under its own code");
});

test("a per account threshold overrides the client default", async () => {
  const db = reportDb();
  db.seed("budget_thresholds", [
    threshold("BT-DEFAULT", null, 1000, BigInt(50000)),
    threshold("BT-4100", "4100", 20000, BigInt(50000)),
  ]);
  await applyReport(db, rptFlagVariances, scope);
  const revenue = rowFor(db, "4100");
  assertEqual(revenue?.thresholdBp, 20000, "the account override is what was used");
  assertEqual(
    revenue?.flagged,
    false,
    "and a two hundred percent threshold is not crossed by a hundred and fifty percent variance",
  );
});

test("every evaluated account gets a row, flagged or not", async () => {
  const db = reportDb();
  await applyReport(db, rptFlagVariances, scope);
  const rows = variancesOf(db);
  assertEqual(rows.length, 2, "both income statement accounts are reported");
  assertEqual(
    rows.filter((r) => r.flagged).length,
    1,
    "one of them is flagged, and the quiet one is still on the record",
  );
  assertEqual(rowFor(db, "6100")?.flagCode, "within_threshold", "the quiet account says so");
});

test("balance sheet and memo accounts are outside the comparison", async () => {
  const db = reportDb();
  addAccount(db, "9100", "Memo only");
  db.seed("budgets", [
    budget("BUD-4100", "4100", BigInt(-40000)),
    budget("BUD-1010", "1010", BigInt(500000)),
    budget("BUD-9100", "9100", BigInt(100)),
  ]);
  await applyReport(db, rptFlagVariances, scope);
  const accounts = variancesOf(db).map((v) => v.accountNumber);
  assert(!accounts.includes("1010"), "a cash budget is a cash plan, not a variance");
  assert(!accounts.includes("9100"), "and the memo block is never on a statement");
});

test("direction reads from the account block, not from the sign", async () => {
  const db = reportDb();
  addAccount(db, "6200", "Overspend");
  seedEntry(db, "JE-OVER", "2026-01-27", [
    ["6200", BigInt(90000)],
    ["1010", BigInt(-90000)],
  ]);
  db.seed("budgets", [
    budget("BUD-4100", "4100", BigInt(-40000)),
    budget("BUD-6200", "6200", BigInt(20000)),
  ]);
  await applyReport(db, rptFlagVariances, scope);
  assertEqual(
    rowFor(db, "4100")?.direction,
    "favorable",
    "revenue above budget carries a negative variance and is favorable",
  );
  assertEqual(
    rowFor(db, "6200")?.direction,
    "unfavorable",
    "expense above budget carries a positive variance and is unfavorable",
  );
});
