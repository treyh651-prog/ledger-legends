/**
 * PER-POST-DEPRECIATION tests.
 *
 * Compliance note, repeated from the run itself: depreciation is treated here
 * as a bookkeeping mechanic for spreading cost across the months an asset is
 * used. Nothing in these tests asserts a tax position, and none of them computes
 * a liability. A question that turns into one routes to CPA-BUILD-HANDOFF.
 *
 * The tests cover the three methods, the half month convention on both ends,
 * the grouping of assets into one entry per class, and the rule that cumulative
 * depreciation never passes the depreciable base.
 */

import { isRowInsert } from "../contract";
import { canonicalJson, toJsonValue } from "../ids";
import { perPostDepreciation } from "../runs/per-post-depreciation";
import type { DepreciationScheduleRow } from "../tables";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  applyPer,
  asset,
  balanceOf,
  linesOf,
  perDb,
  periodScope,
  previewPer,
  reasons,
  skippedFor,
  sumLines,
} from "./per-fixtures";
import { assert, assertEqual, show, test } from "./harness";

function scheduleRows(db: ReturnType<typeof perDb>): DepreciationScheduleRow[] {
  return db.all("depreciation_schedule");
}

function historyRow(
  id: string,
  assetId: string,
  periodStart: string,
  periodEnd: string,
  amountCents: bigint,
  accumulatedAfterCents: bigint,
): DepreciationScheduleRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    assetId,
    periodStart,
    periodEnd,
    periodNumber: 1,
    scheduleVersion: 1,
    amountCents,
    accumulatedAfterCents,
    nbvAfterCents: BigInt(1200000) - accumulatedAfterCents,
    status: "posted",
    postedEntryId: null,
    postedRunId: "RUNX-SEED",
    postedAt: "2025-12-31T00:00:00.000Z",
    manualOverride: false,
    version: 1,
  };
}

test("per depreciation, straight line posts one month and records the schedule row", async () => {
  const db = perDb();
  db.seed("fixed_assets", [asset("FA-1")]);
  const { applied } = await applyPer(db, perPostDepreciation, periodScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );

  const entries = db.all("journal_entries");
  assertEqual(entries.length, 1, "one entry");
  assertEqual(entries[0].entryDate, "2026-01-31", "dated the period end");
  assertEqual(sumLines(linesOf(db, entries[0].id)), BigInt(0), "it balances");
  assertEqual(balanceOf(db, "6700"), BigInt(100000), "1200000 over twelve months");
  assertEqual(balanceOf(db, "1590"), BigInt(-100000), "the contra took the credit");

  const rows = scheduleRows(db);
  assertEqual(rows.length, 1, "one schedule row");
  assertEqual(rows[0].amountCents, BigInt(100000), "carrying the amount");
  assertEqual(rows[0].accumulatedAfterCents, BigInt(100000), "and the accumulation");
  assertEqual(rows[0].nbvAfterCents, BigInt(1100000), "and the book value after");
  assertEqual(rows[0].postedEntryId, entries[0].id, "pointing at the entry");
});

test("per depreciation, assets in one class share one entry", async () => {
  const db = perDb();
  db.seed("fixed_assets", [
    asset("FA-1"),
    asset("FA-2", { costCents: BigInt(600000) }),
    asset("FA-3", {
      expenseAccount: "6300",
      accumAccount: "1590",
      assetClass: "software",
    }),
  ]);
  await applyPer(db, perPostDepreciation, periodScope());
  const entries = db.all("journal_entries");
  assertEqual(entries.length, 2, "one entry per pair of accounts");
  assertEqual(balanceOf(db, "6700"), BigInt(150000), "the two equipment assets together");
  assertEqual(balanceOf(db, "6300"), BigInt(100000), "and the software one on its own");
  assertEqual(scheduleRows(db).length, 3, "but a schedule row for every asset");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the books foot");
});

test("per depreciation, the half month convention halves the first month and adds one on the end", async () => {
  const db = perDb();
  db.seed("fixed_assets", [asset("FA-H", { halfMonthConvention: true })]);
  await applyPer(db, perPostDepreciation, periodScope());
  assertEqual(balanceOf(db, "6700"), BigInt(50000), "half a month to begin with");

  // Walk the whole life and check the total lands exactly on the base.
  for (let i = 1; i <= 12; i += 1) {
    const month = i + 1;
    const year = 2026 + Math.floor((month - 1) / 12);
    const inYear = ((month - 1) % 12) + 1;
    const period = `${String(year)}-${inYear < 10 ? `0${String(inYear)}` : String(inYear)}-01`;
    await applyPer(db, perPostDepreciation, periodScope(period));
  }
  assertEqual(balanceOf(db, "6700"), BigInt(1200000), "thirteen months add to the base");
  assertEqual(balanceOf(db, "1590"), BigInt(-1200000), "and so does the contra");
  assertEqual(scheduleRows(db).length, 13, "thirteen schedule rows");
});

test("per depreciation, a disposal in the month takes half a month and nothing after", async () => {
  const db = perDb();
  db.seed("fixed_assets", [
    asset("FA-D", { halfMonthConvention: false, disposedOn: "2026-03-15" }),
  ]);
  await applyPer(db, perPostDepreciation, periodScope("2026-03-01"));
  assertEqual(balanceOf(db, "6700"), BigInt(100000), "no convention, a whole month");

  const half = perDb();
  half.seed("fixed_assets", [
    asset("FA-DH", { halfMonthConvention: true, disposedOn: "2026-03-15" }),
  ]);
  await applyPer(half, perPostDepreciation, periodScope("2026-03-01"));
  assertEqual(balanceOf(half, "6700"), BigInt(50000), "with it, half a month");

  const after = await previewPer(half, perPostDepreciation, periodScope("2026-04-01"));
  assert(
    skippedFor(after, "FA-DH", "out_of_scope_engagement"),
    `expected out of scope after disposal, got ${show(reasons(after))}`,
  );
});

test("per depreciation, declining balance front loads and never passes the base", async () => {
  const db = perDb();
  db.seed("fixed_assets", [
    asset("FA-DDB", { method: "ddb", ddbFactorBps: 20000 }),
  ]);
  await applyPer(db, perPostDepreciation, periodScope());
  assertEqual(balanceOf(db, "6700"), BigInt(200000), "double the straight line month");

  for (let month = 2; month <= 12; month += 1) {
    const period = `2026-${month < 10 ? `0${String(month)}` : String(month)}-01`;
    await applyPer(db, perPostDepreciation, periodScope(period));
  }
  assertEqual(balanceOf(db, "6700"), BigInt(1200000), "the life writes off the base exactly");
  const rows = scheduleRows(db).slice().sort((a, b) => a.periodNumber - b.periodNumber);
  assert(
    rows[0].amountCents > rows[11].amountCents,
    "and the early months are larger than the late ones",
  );
});

test("per depreciation, MACRS spreads the published year across its months", async () => {
  const db = perDb();
  db.seed("fixed_assets", [
    asset("FA-M", { method: "macrs", macrsRecoveryYears: 5, lifeMonths: null }),
  ]);
  for (let month = 1; month <= 12; month += 1) {
    const period = `2026-${month < 10 ? `0${String(month)}` : String(month)}-01`;
    await applyPer(db, perPostDepreciation, periodScope(period));
  }
  // Twenty percent of the base in the first recovery year.
  assertEqual(balanceOf(db, "6700"), BigInt(240000), "year one is twenty percent");
  assertEqual(scheduleRows(db).length, 12, "one row a month");
  assertEqual(scheduleRows(db)[0].amountCents, BigInt(20000), "an even twelfth of it");
});

test("per depreciation, MACRS with no recovery period is reported rather than assumed", async () => {
  const db = perDb();
  db.seed("fixed_assets", [
    asset("FA-MB", { method: "macrs", macrsRecoveryYears: null }),
  ]);
  const preview = await previewPer(db, perPostDepreciation, periodScope());
  assert(
    preview.result.errors.some((e) => e.code === "PER_ASSET_MACRS_RECOVERY_MISSING"),
    `expected the recovery error, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
});

test("per depreciation, straight line with no life and units of production are both errors", async () => {
  const db = perDb();
  db.seed("fixed_assets", [
    asset("FA-NOLIFE", { lifeMonths: null }),
    asset("FA-UNITS", { method: "units_of_production", unitsTotal: 1000 }),
  ]);
  const preview = await previewPer(db, perPostDepreciation, periodScope());
  const codes = preview.result.errors.map((e) => e.code).sort();
  assert(codes.includes("PER_ASSET_LIFE_MISSING"), `codes ${show(codes)}`);
  assert(codes.includes("PER_ASSET_METHOD_UNSUPPORTED"), `codes ${show(codes)}`);
  assertEqual(preview.status, "refused", "and the run refuses");
});

test("per depreciation, cumulative depreciation stops at the depreciable base", async () => {
  const db = perDb();
  db.seed("fixed_assets", [
    asset("FA-END", { placedInServiceOn: "2025-03-01", acquiredOn: "2025-03-01" }),
  ]);
  db.seed("depreciation_schedule", [
    historyRow(
      "DEP-PRIOR",
      "FA-END",
      "2025-12-01",
      "2025-12-31",
      BigInt(1150000),
      BigInt(1150000),
    ),
  ]);
  await applyPer(db, perPostDepreciation, periodScope());
  assertEqual(balanceOf(db, "6700"), BigInt(50000), "only what was left of the base");
  const posted = scheduleRows(db).find((r) => r.id !== "DEP-PRIOR");
  assertEqual(posted?.accumulatedAfterCents, BigInt(1200000), "which closes the asset");
  assertEqual(posted?.nbvAfterCents, BigInt(0), "at zero book value");
});

test("per depreciation, a life that has run out posts nothing", async () => {
  const db = perDb();
  db.seed("fixed_assets", [asset("FA-OLD", { placedInServiceOn: "2024-01-01" })]);
  const preview = await previewPer(db, perPostDepreciation, periodScope());
  assert(
    skippedFor(preview, "FA-OLD", "already_applied"),
    `expected the exhausted skip, got ${show(reasons(preview))}`,
  );
  assertEqual(preview.result.proposals.length, 0, "and nothing was proposed");
});

test("per depreciation, an asset not yet in service waits", async () => {
  const db = perDb();
  db.seed("fixed_assets", [asset("FA-NEW", { placedInServiceOn: "2026-06-01" })]);
  const preview = await previewPer(db, perPostDepreciation, periodScope());
  assert(
    skippedFor(preview, "FA-NEW", "missing_prerequisite"),
    `expected not in service, got ${show(reasons(preview))}`,
  );
});

test("per depreciation, a missing contra account is skipped rather than guessed", async () => {
  const db = perDb();
  db.seed("fixed_assets", [asset("FA-NOCONTRA", { accumAccount: "1595" })]);
  const { applied } = await applyPer(db, perPostDepreciation, periodScope());
  assert(
    applied.result.skips.some((s) => s.detail.includes("contra_account_missing")),
    `expected the contra skip, got ${show(applied.result.skips.map((s) => s.detail))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "nothing was posted anywhere");
});

test("per depreciation, non depreciating, written off, and overridden assets stand aside", async () => {
  const db = perDb();
  db.seed("fixed_assets", [
    asset("FA-LAND", { method: "none" }),
    asset("FA-OFF", { status: "written_off" }),
    asset("FA-DONE", { status: "fully_depreciated" }),
    asset("FA-OVR", { manualOverride: true }),
  ]);
  const { applied } = await applyPer(db, perPostDepreciation, periodScope());
  assert(skippedFor(applied, "FA-LAND", "out_of_scope_engagement"), "land");
  assert(skippedFor(applied, "FA-OFF", "out_of_scope_engagement"), "written off");
  assert(skippedFor(applied, "FA-DONE", "already_applied"), "fully depreciated");
  assert(skippedFor(applied, "FA-OVR", "manual_override"), "the overridden one");
  assertEqual(db.all("journal_entries").length, 0, "and none of them posted");
});

test("per depreciation, the same period twice posts once", async () => {
  const db = perDb();
  db.seed("fixed_assets", [asset("FA-1")]);
  await applyPer(db, perPostDepreciation, periodScope());
  const second = await applyPer(db, perPostDepreciation, periodScope());
  assertEqual(db.all("journal_entries").length, 1, "still one entry");
  assertEqual(scheduleRows(db).length, 1, "and one schedule row");
  assert(
    skippedFor(second.preview, "FA-1", "already_applied"),
    `expected already_applied, got ${show(reasons(second.preview))}`,
  );
});

test("per depreciation, a locked period is skipped and never thrown", async () => {
  const db = perDb();
  db.seed("fixed_assets", [asset("FA-1")]);
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await applyPer(db, perPostDepreciation, periodScope());
  assert(
    skippedFor(applied, "FA-1", "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "nothing reached the books");
  assertEqual(scheduleRows(db).length, 0, "and no schedule row was written");
});

test("per depreciation, preview writes nothing and equals the apply", async () => {
  const db = perDb();
  db.seed("fixed_assets", [asset("FA-1"), asset("FA-2")]);
  const first = await previewPer(db, perPostDepreciation, periodScope());
  assertEqual(db.all("journal_entries").length, 0, "the preview posted nothing");
  assertEqual(scheduleRows(db).length, 0, "and inserted no schedule rows");
  assert(first.result.proposals.some(isRowInsert), "though it proposed them");

  const { preview, applied } = await applyPer(db, perPostDepreciation, periodScope());
  assertEqual(
    canonicalJson(toJsonValue(preview.result.proposals)),
    canonicalJson(toJsonValue(applied.result.proposals)),
    "the same proposals",
  );
});
