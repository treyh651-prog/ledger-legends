/**
 * CLOSE-ROLL-FORWARD. Doc 02 module 6 CLS-ROLL-FORWARD.
 *
 * The questions these tests answer: does the new period open at the prior
 * period's ending balance, do income statement accounts stay out of it, does a
 * rerun restate rather than duplicate, does the locked source period stop it, and
 * does the run stay out of the ledger.
 */

import { clsRollForward, openingId } from "../runs/cls-roll-forward";
import type { MemoryRunDb } from "../db-memory";
import type { OpeningBalanceRow } from "../tables";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  addAccount,
  applyClose,
  closeDb,
  closeScope,
  opening,
  previewClose,
  seedEntry,
  NEXT_PERIOD,
  NEXT_PERIOD_END,
  PERIOD,
  PERIOD_END,
} from "./close-fixtures";
import { assert, assertEqual, test } from "./harness";

function openingsOf(db: MemoryRunDb): Map<string, OpeningBalanceRow> {
  return new Map(db.all("opening_balances").map((r) => [r.accountNumber, r]));
}

/** Roll January forward into February. */
async function roll(db: MemoryRunDb): Promise<Map<string, OpeningBalanceRow>> {
  await applyClose(db, clsRollForward, closeScope(NEXT_PERIOD));
  return openingsOf(db);
}

test("roll forward, the new period opens at the prior ending balance", async () => {
  const db = closeDb();
  const rows = await roll(db);
  const cash = rows.get("1010");
  assertEqual(cash?.openingBalanceCents, BigInt(100000), "January ended there");
  assertEqual(cash?.periodStart, NEXT_PERIOD, "and February opens there");
  assertEqual(cash?.sourcePeriodStart, PERIOD, "from the prior period");
  assertEqual(
    cash?.sourceKind,
    "prior_period_ending_balance",
    "and the source is named",
  );
});

test("roll forward, an income statement account does not roll", async () => {
  const db = closeDb();
  const rows = await roll(db);
  assert(!rows.has("4100"), "revenue was left out");
  assert(!rows.has("6100"), "and so was expense");
});

test("roll forward, an account at zero is not written", async () => {
  const db = closeDb();
  const rows = await roll(db);
  assert(!rows.has("1990"), "suspense sat at zero, so there is nothing to state");
  assertEqual(rows.size, 1, "only the account carrying a balance rolled");
});

test("roll forward, every balance sheet account carrying a balance rolls", async () => {
  const db = closeDb();
  addAccount(db, "1200", "Inventory");
  addAccount(db, "2000", "Accounts payable");
  seedEntry(db, "JE-BUY", "2026-01-11", [
    ["1200", BigInt(40000)],
    ["2000", BigInt(-40000)],
  ]);
  const rows = await roll(db);
  assertEqual(rows.get("1200")?.openingBalanceCents, BigInt(40000), "inventory");
  assertEqual(rows.get("2000")?.openingBalanceCents, BigInt(-40000), "payable");
});

test("roll forward, activity inside the new period is not counted", async () => {
  const db = closeDb();
  seedEntry(db, "JE-FEB", "2026-02-05", [
    ["1010", BigInt(25000)],
    ["4100", BigInt(-25000)],
  ]);
  const rows = await roll(db);
  assertEqual(
    rows.get("1010")?.openingBalanceCents,
    BigInt(100000),
    "the February receipt is activity, not an opening balance",
  );
});

test("roll forward, the period row for the new period is opened", async () => {
  const db = closeDb();
  await applyClose(db, clsRollForward, closeScope(NEXT_PERIOD));
  const row = db.all("close_periods").find((p) => p.periodStart === NEXT_PERIOD);
  assertEqual(row?.status, "open", "February is open");
  assertEqual(row?.periodEnd, NEXT_PERIOD_END, "through its last day");
  assertEqual(row?.rolledFromPeriodStart, PERIOD, "rolled from January");
});

test("roll forward, a rerun over an unchanged prior period proposes nothing", async () => {
  const db = closeDb();
  await applyClose(db, clsRollForward, closeScope(NEXT_PERIOD));
  const second = await previewClose(db, clsRollForward, closeScope(NEXT_PERIOD));
  assertEqual(second.result.proposals.length, 0, "nothing left to propose");
});

test("roll forward, a prior period correction restates the opening figure", async () => {
  const db = closeDb();
  await applyClose(db, clsRollForward, closeScope(NEXT_PERIOD));
  seedEntry(db, "JE-FIX", "2026-01-30", [
    ["1010", BigInt(-1500)],
    ["6100", BigInt(1500)],
  ]);
  await applyClose(db, clsRollForward, closeScope(NEXT_PERIOD));
  const rows = openingsOf(db);
  assertEqual(db.all("opening_balances").length, 1, "still one row per account");
  assertEqual(
    rows.get("1010")?.openingBalanceCents,
    BigInt(98500),
    "restated in place",
  );
});

test("roll forward, the row id is derived from the period and the account", () => {
  assertEqual(
    openingId(NEXT_PERIOD, "1010"),
    openingId(NEXT_PERIOD, "1010"),
    "the same inputs give the same id",
  );
  assert(
    openingId(NEXT_PERIOD, "1010") !== openingId(PERIOD, "1010"),
    "two periods are two rows",
  );
});

test("roll forward, an overridden opening balance is left alone", async () => {
  const db = closeDb();
  db.seed("opening_balances", [
    opening(openingId(NEXT_PERIOD, "1010"), NEXT_PERIOD, "1010", BigInt(1), {
      manualOverride: true,
    }),
  ]);
  const { applied } = await applyClose(db, clsRollForward, closeScope(NEXT_PERIOD));
  assertEqual(
    openingsOf(db).get("1010")?.openingBalanceCents,
    BigInt(1),
    "the hand entered figure stands",
  );
  assert(
    applied.result.skips.some((s) => s.reason === "manual_override"),
    "and the skip says why",
  );
});

test("roll forward, a locked source period is expected rather than a reason to stop", async () => {
  const db = closeDb();
  db.seed("period_locks", [
    lock("LOCK-JAN", FIRM_A, CLIENT_A1, PERIOD, PERIOD_END),
  ]);
  const rows = await roll(db);
  assertEqual(
    rows.get("1010")?.openingBalanceCents,
    BigInt(100000),
    "the closed month is exactly what rolls forward",
  );
});

test("roll forward, the run posts nothing", async () => {
  const db = closeDb();
  await applyClose(db, clsRollForward, closeScope(NEXT_PERIOD));
  assertEqual(db.all("journal_entries").length, 1, "the ledger is unchanged");
  assertEqual(db.all("journal_lines").length, 2, "no line was added");
});

test("roll forward, preview proposes what apply writes", async () => {
  const db = closeDb();
  const preview = await previewClose(db, clsRollForward, closeScope(NEXT_PERIOD));
  assertEqual(db.all("opening_balances").length, 0, "preview wrote nothing");
  const { applied } = await applyClose(db, clsRollForward, closeScope(NEXT_PERIOD));
  assertEqual(
    applied.result.proposals.length,
    preview.result.proposals.length,
    "the same proposal count",
  );
});

test("roll forward, the period is part of the scope hash", async () => {
  const db = closeDb();
  const february = await previewClose(db, clsRollForward, closeScope(NEXT_PERIOD));
  const march = await previewClose(db, clsRollForward, closeScope("2026-03-01"));
  assert(
    february.scopeHash !== march.scopeHash,
    "two periods are two scopes",
  );
});
