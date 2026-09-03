/**
 * CLOSE-POST-YEAREND. Doc 02 module 6 CLS-POST-YEAREND, doc 00 Part 6 for the
 * two net asset classes.
 *
 * The questions these tests answer: does the entry empty every revenue and
 * expense account into equity, does the new year start those accounts at zero,
 * does a nonprofit split its result by donor restriction, does the run fire once
 * a year rather than once a month, is it idempotent per fiscal year, and does it
 * stay out of the 9000 block.
 *
 * COMPLIANCE. Nothing here computes a tax, prepares a return, or files anything.
 * These tests assert a bookkeeping mechanic and nothing more.
 */

import {
  clsPostYearEnd,
  closingClaimId,
  closingEntryId,
  YEAREND_ERROR_CODES,
} from "../runs/cls-post-yearend";
import { balancesBetween, balancesThrough } from "../runs/close-shared";
import type { MemoryRunDb } from "../db-memory";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  addAccount,
  applyClose,
  balanceOf,
  closeDb,
  closeScope,
  policy,
  previewClose,
  seedEntry,
} from "./close-fixtures";
import { assert, assertEqual, test } from "./harness";

const YEAR_END = "2026-12-31";
const NEW_YEAR = "2027-01-01";

/** Put a full year of activity on the books, then step into the new year. */
function yearOfActivity(db: MemoryRunDb): MemoryRunDb {
  seedEntry(db, "JE-REV-Q1", "2026-03-31", [
    ["1010", BigInt(400000)],
    ["4100", BigInt(-400000)],
  ]);
  seedEntry(db, "JE-EXP-Q2", "2026-06-30", [
    ["6100", BigInt(150000)],
    ["1010", BigInt(-150000)],
  ]);
  return db;
}

/** Balance of an account through a day, read straight off the journal lines. */
function balanceThrough(db: MemoryRunDb, account: string, day: string): bigint {
  return balancesThrough(db.all("journal_lines"), day).get(account) ?? BigInt(0);
}

test("year end, revenue and expense are emptied into retained earnings", async () => {
  const db = yearOfActivity(closeDb());
  const { applied } = await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  assertEqual(applied.status, "completed", "the run completed");
  // January revenue of 100000 plus the March 400000, less the 150000 of expense.
  assertEqual(balanceOf(db, "3200"), BigInt(-350000), "the net result is in equity");
  assertEqual(balanceOf(db, "4100"), BigInt(0), "revenue is empty");
  assertEqual(balanceOf(db, "6100"), BigInt(0), "and so is expense");
});

test("year end, the new year starts the income statement at zero", async () => {
  const db = yearOfActivity(closeDb());
  await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  const newYear = balancesBetween(db.all("journal_lines"), NEW_YEAR, "2027-12-31");
  assertEqual(newYear.get("4100") ?? BigInt(0), BigInt(0), "no revenue yet");
  assertEqual(newYear.get("6100") ?? BigInt(0), BigInt(0), "no expense yet");
  assertEqual(
    balanceThrough(db, "1010", NEW_YEAR),
    BigInt(350000),
    "and the cash balance carried across the year end untouched",
  );
});

test("year end, the entry is dated the last day of the fiscal year", async () => {
  const db = yearOfActivity(closeDb());
  await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  const entry = db
    .all("journal_entries")
    .find((e) => e.id === closingEntryId(CLIENT_A1, YEAR_END));
  assertEqual(entry?.entryDate, YEAR_END, "the day the year ended");
  assertEqual(entry?.redatedFromLockedPeriod, null, "with no redating needed");
});

test("year end, the entry balances to zero", async () => {
  const db = yearOfActivity(closeDb());
  await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  const id = closingEntryId(CLIENT_A1, YEAR_END);
  let total = BigInt(0);
  for (const line of db.all("journal_lines")) {
    if (line.entryId === id) total += line.amountCents;
  }
  assertEqual(total, BigInt(0), "debits equal credits");
});

test("year end, the claim row records what was closed", async () => {
  const db = yearOfActivity(closeDb());
  await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  const claim = db
    .all("closing_entries")
    .find((c) => c.id === closingClaimId(CLIENT_A1, YEAR_END));
  assertEqual(claim?.fiscalYearStart, "2026-01-01", "the year it covers");
  assertEqual(claim?.fiscalYearEnd, YEAR_END, "through its last day");
  assertEqual(claim?.closedRevenueCents, BigInt(500000), "revenue closed");
  assertEqual(claim?.closedExpenseCents, BigInt(150000), "expense closed");
  assertEqual(claim?.closedNetCents, BigInt(350000), "and the net result");
  assertEqual(claim?.equityAccount, "3200", "into retained earnings");
  assertEqual(claim?.entityKind, "for_profit", "for a for profit client");
});

test("year end, a loss closes against equity in the other direction", async () => {
  const db = closeDb();
  seedEntry(db, "JE-BIG-EXPENSE", "2026-08-31", [
    ["6100", BigInt(250000)],
    ["1010", BigInt(-250000)],
  ]);
  await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  assertEqual(balanceOf(db, "3200"), BigInt(150000), "equity fell by the loss");
});

test("year end, a period that is not the start of a fiscal year is out of scope", async () => {
  const db = yearOfActivity(closeDb());
  const { applied } = await applyClose(db, clsPostYearEnd, closeScope("2026-07-01"));
  assertEqual(applied.status, "no_op", "nothing was proposed");
  assertEqual(
    applied.result.skips[0]?.reason,
    "out_of_scope_engagement",
    "because it is not a year start",
  );
  assertEqual(db.all("closing_entries").length, 0, "and nothing was posted");
});

test("year end, a fiscal year already closed is not closed twice", async () => {
  const db = yearOfActivity(closeDb());
  await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  const before = db.all("journal_entries").length;
  const { applied } = await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  assert(
    applied.status === "no_op" || applied.deduplicatedFrom !== undefined,
    "the second run did not post again",
  );
  assertEqual(db.all("journal_entries").length, before, "no second entry");
  assertEqual(db.all("closing_entries").length, 1, "and one claim row");
});

test("year end, a June fiscal year end closes in June", async () => {
  const db = closeDb();
  db.seed("client_policies", [policy({ fiscalYearEndMonth: 6 })]);
  seedEntry(db, "JE-REV-MAY", "2026-05-31", [
    ["1010", BigInt(80000)],
    ["4100", BigInt(-80000)],
  ]);
  await applyClose(db, clsPostYearEnd, closeScope("2026-07-01"));
  const claim = db.all("closing_entries")[0];
  assertEqual(claim?.fiscalYearStart, "2025-07-01", "the year started in July");
  assertEqual(claim?.fiscalYearEnd, "2026-06-30", "and ended in June");
  assertEqual(claim?.entryDate, "2026-06-30", "the entry is dated the year end");
});

test("year end, a nonprofit splits its result between the two net asset classes", async () => {
  const db = closeDb();
  db.seed("client_policies", [
    policy({
      entityKind: "nonprofit",
      retainedEarningsAccount: null,
      netAssetsWithoutRestrictionsAccount: "3300",
      netAssetsWithRestrictionsAccount: "3400",
    }),
  ]);
  addAccount(db, "3300", "Net assets without donor restrictions");
  addAccount(db, "3400", "Net assets with donor restrictions");
  addAccount(db, "4200", "Contributions");
  seedEntry(
    db,
    "JE-GRANT",
    "2026-04-30",
    [
      ["1010", BigInt(250000)],
      ["4200", BigInt(-250000)],
    ],
    {},
    { restriction: "with_donor_restrictions" },
  );
  await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  assertEqual(
    balanceOf(db, "3400"),
    BigInt(-250000),
    "the restricted gift closed to the restricted class",
  );
  assertEqual(
    balanceOf(db, "3300"),
    BigInt(-100000),
    "and the unrestricted revenue to the unrestricted class",
  );
  assertEqual(balanceOf(db, "4200"), BigInt(0), "the contribution account is empty");
});

test("year end, a nonprofit with no restricted class configured still closes", async () => {
  const db = closeDb();
  db.seed("client_policies", [
    policy({
      entityKind: "nonprofit",
      retainedEarningsAccount: null,
      netAssetsWithoutRestrictionsAccount: "3300",
      netAssetsWithRestrictionsAccount: null,
    }),
  ]);
  addAccount(db, "3300", "Net assets without donor restrictions");
  const { applied } = await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  assertEqual(applied.status, "completed", "no restricted activity, no problem");
  assertEqual(balanceOf(db, "3300"), BigInt(-100000), "closed to the one class");
});

test("year end, a missing equity account refuses rather than guessing one", async () => {
  const db = closeDb();
  db.seed("client_policies", [policy({ retainedEarningsAccount: null })]);
  const { applied } = await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  assertEqual(applied.status, "refused", "the run refused");
  assertEqual(
    applied.result.errors[0]?.code,
    YEAREND_ERROR_CODES.missingEquityAccount,
    "because there is nowhere to close to",
  );
  assertEqual(db.all("closing_entries").length, 0, "and nothing was posted");
});

test("year end, the 9000 memo block is left alone", async () => {
  const db = closeDb();
  addAccount(db, "9100", "Income tax expense");
  // The block exists so a memo figure can be tracked without reaching a
  // published statement. Closing it to equity would be a tax position, and this
  // run does not take one.
  seedEntry(db, "JE-MEMO", "2026-09-30", [
    ["9100", BigInt(50000)],
    ["1990", BigInt(-50000)],
  ]);
  await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  assertEqual(balanceOf(db, "9100"), BigInt(50000), "the memo balance stands");
  const id = closingEntryId(CLIENT_A1, YEAR_END);
  const touched = db
    .all("journal_lines")
    .some((l) => l.entryId === id && l.accountNumber === "9100");
  assertEqual(touched, false, "no closing line touched it");
});

test("year end, a year ending inside a locked period is redated and says so", async () => {
  const db = yearOfActivity(closeDb());
  db.seed("period_locks", [
    lock("LOCK-DEC", FIRM_A, CLIENT_A1, "2026-12-01", YEAR_END),
  ]);
  await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  const entry = db
    .all("journal_entries")
    .find((e) => e.id === closingEntryId(CLIENT_A1, YEAR_END));
  assertEqual(entry?.entryDate, NEW_YEAR, "moved to the earliest open day");
  assertEqual(
    entry?.redatedFromLockedPeriod,
    YEAR_END,
    "and the entry records where it came from",
  );
});

test("year end, a year with no activity is not closed", async () => {
  const db = closeDb();
  // The base book has January revenue, so a year with nothing in it needs a
  // client whose only activity is outside the year being closed.
  const empty = closeDb();
  empty.seed("journal_entries", []);
  const { applied } = await applyClose(db, clsPostYearEnd, closeScope("2028-01-01"));
  assertEqual(applied.status, "no_op", "nothing was proposed");
  assert(
    applied.result.skips.some((s) => s.detail.includes("no revenue or expense")),
    "and the skip says the year was empty",
  );
  assertEqual(db.all("closing_entries").length, 0, "and posted nothing");
  assertEqual(empty.all("closing_entries").length, 0, "nor for the empty client");
});

test("year end, preview proposes what apply posts", async () => {
  const db = yearOfActivity(closeDb());
  const preview = await previewClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  assertEqual(db.all("closing_entries").length, 0, "preview posted nothing");
  const { applied } = await applyClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  assertEqual(
    applied.result.proposals.length,
    preview.result.proposals.length,
    "the same proposal count",
  );
  assertEqual(applied.entriesCreated, 1, "one entry was created");
});

test("year end, the period is part of the scope hash", async () => {
  const db = yearOfActivity(closeDb());
  const a = await previewClose(db, clsPostYearEnd, closeScope(NEW_YEAR));
  const b = await previewClose(db, clsPostYearEnd, closeScope("2028-01-01"));
  assert(a.scopeHash !== b.scopeHash, "two years are two scopes");
});
