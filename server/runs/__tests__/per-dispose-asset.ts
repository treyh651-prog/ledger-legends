/**
 * PER-DISPOSE-ASSET tests.
 *
 * The run takes an asset off the books in one entry: a final partial month of
 * depreciation if the disposal month still owes one, the net removal of
 * accumulated depreciation, the cost reversed in full, the proceeds, and the
 * gain or loss that balances the rest. Every test checks the entry sums to
 * zero cents, which is what would have caught the sign error this run shipped
 * with the first time: the gain or loss line negated instead of posted
 * straight, so the entry was off by twice the gain or loss.
 */

import { DISPOSE_ASSET_ERROR_CODES, perDisposeAsset } from "../runs/per-dispose-asset";
import { perPostDepreciation } from "../runs/per-post-depreciation";
import { executeUndo } from "../undo";
import type { DepreciationScheduleRow, FixedAssetRow } from "../tables";
import { ACTOR, CLIENT_A1, CLIENT_A2, FIRM_A, NOW, chartAccount, lock } from "./fixtures";
import {
  applyPer,
  asset,
  balanceOf,
  linesOf,
  perDb,
  previewPer,
  reasons,
  skippedFor,
  sumLines,
} from "./per-fixtures";
import { assert, assertEqual, show, test } from "./harness";

/** Every dispose test needs cash for proceeds and a gain/loss account the base chart lacks. */
function disposeDb(): ReturnType<typeof perDb> {
  const db = perDb();
  db.seed("chart_accounts", [
    chartAccount("CH-A1-1010", FIRM_A, CLIENT_A1, "1010", "Cash"),
    chartAccount("CH-A1-8200", FIRM_A, CLIENT_A1, "8200", "Gain or loss on disposal"),
  ]);
  return db;
}

interface DisposeScopeArgs {
  clientId?: string;
  assetId: string;
  disposedOn?: string;
  proceedsCents?: string;
  proceedsAccount?: string | null;
  gainLossAccount?: string;
}

function disposeScope(args: DisposeScopeArgs) {
  return {
    clientId: args.clientId ?? CLIENT_A1,
    assetId: args.assetId,
    disposedOn: args.disposedOn ?? "2026-02-15",
    proceedsCents: args.proceedsCents ?? "0",
    proceedsAccount: args.proceedsAccount ?? null,
    gainLossAccount: args.gainLossAccount ?? "8200",
  };
}

function historyRow(
  id: string,
  assetId: string,
  periodStart: string,
  periodEnd: string,
  periodNumber: number,
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
    periodNumber,
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

function scheduleRows(db: ReturnType<typeof perDb>): DepreciationScheduleRow[] {
  return db.all("depreciation_schedule");
}

function assetOf(db: ReturnType<typeof perDb>, id: string): FixedAssetRow {
  const row = db.all("fixed_assets").find((a) => a.id === id);
  if (!row) throw new Error(`asset ${id} not found`);
  return row;
}

test("per dispose asset, mid life with a gain balances to zero and records the disposal", async () => {
  const db = disposeDb();
  db.seed("fixed_assets", [asset("FA-G")]);
  db.seed("depreciation_schedule", [
    historyRow("DEP-JAN", "FA-G", "2026-01-01", "2026-01-31", 1, BigInt(100000), BigInt(100000)),
  ]);

  const { applied } = await applyPer(
    db,
    perDisposeAsset,
    disposeScope({
      assetId: "FA-G",
      disposedOn: "2026-02-15",
      proceedsCents: "1200000",
      proceedsAccount: "1010",
    }),
  );
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );

  const entries = db.all("journal_entries");
  assertEqual(entries.length, 1, "one entry");
  assertEqual(sumLines(linesOf(db, entries[0].id)), BigInt(0), "it balances");

  // Feb owes a full month (100000, no half month convention), so accumulated
  // reaches 200000, net book value is 1000000, and proceeds of 1200000 leave
  // a 200000 gain, a credit, reported as -200000 on the debit-positive line.
  assertEqual(balanceOf(db, "6700"), BigInt(100000), "the final month's expense");
  assertEqual(balanceOf(db, "1590"), BigInt(100000), "removing what was accumulated, net");
  assertEqual(balanceOf(db, "1510"), BigInt(-1200000), "the cost account cleared");
  assertEqual(balanceOf(db, "1010"), BigInt(1200000), "proceeds landed in cash");
  assertEqual(balanceOf(db, "8200"), BigInt(-200000), "a 200000 gain, which is a credit");

  const row = assetOf(db, "FA-G");
  assertEqual(row.status, "disposed", "status flips");
  assertEqual(row.disposedOn, "2026-02-15", "disposal date recorded");
  assertEqual(row.disposalEntryId, entries[0].id, "pointing at the entry");
  assertEqual(row.disposalProceedsCents, BigInt(1200000), "and the proceeds");

  const feb = scheduleRows(db).find((r) => r.periodNumber === 2);
  assert(feb !== undefined, "the disposal month got its own schedule row");
  assertEqual(feb?.amountCents, BigInt(100000), "carrying the final charge");
  assertEqual(feb?.status, "posted", "posted, not just proposed");
  assertEqual(feb?.postedEntryId, entries[0].id, "pointing at the same entry");

  const after = await previewPer(db, perPostDepreciation, { clientId: CLIENT_A1, period: "2026-03-01" });
  assert(
    skippedFor(after, "FA-G", "out_of_scope_engagement"),
    `expected the disposed asset skipped, got ${show(reasons(after))}`,
  );
});

test("per dispose asset, proceeds under book value post a loss", async () => {
  const db = disposeDb();
  db.seed("fixed_assets", [asset("FA-L")]);
  db.seed("depreciation_schedule", [
    historyRow("DEP-JAN", "FA-L", "2026-01-01", "2026-01-31", 1, BigInt(100000), BigInt(100000)),
  ]);

  const { applied } = await applyPer(
    db,
    perDisposeAsset,
    disposeScope({
      assetId: "FA-L",
      disposedOn: "2026-02-15",
      proceedsCents: "500000",
      proceedsAccount: "1010",
    }),
  );
  const entries = db.all("journal_entries");
  assertEqual(sumLines(linesOf(db, entries[0].id)), BigInt(0), "still balances");
  // Net book value lands at 1000000 (same as the gain test), proceeds of
  // 500000 leave a 500000 loss, a debit, posted straight with no negation.
  assertEqual(balanceOf(db, "8200"), BigInt(500000), "a 500000 loss, a debit");
  const line = linesOf(db, entries[0].id).find((l) => l.accountNumber === "8200");
  assert(line !== undefined && line.memo.includes("loss"), "the memo says loss");
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );
});

test("per dispose asset, the half month convention halves the disposal month's charge", async () => {
  const db = disposeDb();
  db.seed("fixed_assets", [asset("FA-H", { halfMonthConvention: true })]);
  db.seed("depreciation_schedule", [
    historyRow("DEP-JAN", "FA-H", "2026-01-01", "2026-01-31", 1, BigInt(50000), BigInt(50000)),
    historyRow("DEP-FEB", "FA-H", "2026-02-01", "2026-02-28", 2, BigInt(100000), BigInt(150000)),
  ]);

  // Proceeds equal to the resulting net book value, so the gain or loss line
  // drops out and the final charge is the only thing this test has to isolate.
  const { applied } = await applyPer(
    db,
    perDisposeAsset,
    disposeScope({
      assetId: "FA-H",
      disposedOn: "2026-03-15",
      proceedsCents: "1000000",
      proceedsAccount: "1010",
    }),
  );
  const entries = db.all("journal_entries");
  assertEqual(sumLines(linesOf(db, entries[0].id)), BigInt(0), "balances");
  assertEqual(balanceOf(db, "6700"), BigInt(50000), "half of march's regular 100000");
  const mar = scheduleRows(db).find((r) => r.periodNumber === 3);
  assertEqual(mar?.amountCents, BigInt(50000), "the halved charge, recorded");
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );
});

test("per dispose asset, a fully depreciated asset posts no final charge", async () => {
  const db = disposeDb();
  db.seed("fixed_assets", [asset("FA-DONE")]);
  db.seed("depreciation_schedule", [
    historyRow("DEP-ALL", "FA-DONE", "2026-01-01", "2026-12-31", 1, BigInt(1200000), BigInt(1200000)),
  ]);

  await applyPer(
    db,
    perDisposeAsset,
    disposeScope({
      assetId: "FA-DONE",
      disposedOn: "2026-02-15",
      proceedsCents: "50000",
      proceedsAccount: "1010",
    }),
  );
  const entries = db.all("journal_entries");
  assertEqual(sumLines(linesOf(db, entries[0].id)), BigInt(0), "balances");
  assertEqual(balanceOf(db, "6700"), BigInt(0), "nothing left to expense");
  assertEqual(balanceOf(db, "1590"), BigInt(1200000), "the whole accumulated balance removed");
  assertEqual(balanceOf(db, "8200"), BigInt(-50000), "the sale proceeds are a straight gain");
  assertEqual(scheduleRows(db).length, 1, "no new schedule row, only the seeded one");
});

test("per dispose asset, an already disposed asset is skipped, not reposted", async () => {
  const db = disposeDb();
  db.seed("fixed_assets", [
    asset("FA-X", {
      status: "disposed",
      disposedOn: "2026-01-20",
      disposalEntryId: "JE-PRIOR",
      disposalProceedsCents: BigInt(900000),
    }),
  ]);
  const preview = await previewPer(db, perDisposeAsset, disposeScope({ assetId: "FA-X" }));
  assert(
    skippedFor(preview, "FA-X", "already_applied"),
    `expected already_applied, got ${show(reasons(preview))}`,
  );
  assertEqual(preview.result.proposals.length, 0, "nothing proposed");
});

test("per dispose asset, a written off asset is skipped the same way", async () => {
  const db = disposeDb();
  db.seed("fixed_assets", [asset("FA-WO", { status: "written_off" })]);
  const preview = await previewPer(db, perDisposeAsset, disposeScope({ assetId: "FA-WO" }));
  assert(
    skippedFor(preview, "FA-WO", "already_applied"),
    `expected already_applied, got ${show(reasons(preview))}`,
  );
});

test("per dispose asset, a locked disposal date is skipped, not refused", async () => {
  const db = disposeDb();
  db.seed("fixed_assets", [asset("FA-LK")]);
  db.seed("period_locks", [lock("LK-FEB", FIRM_A, CLIENT_A1, "2026-02-01", "2026-02-28")]);
  const { applied } = await applyPer(
    db,
    perDisposeAsset,
    disposeScope({ assetId: "FA-LK", disposedOn: "2026-02-15" }),
  );
  assert(
    skippedFor(applied, "FA-LK", "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "nothing posted");
});

test("per dispose asset, an unknown asset is refused by name", async () => {
  const db = disposeDb();
  const preview = await previewPer(db, perDisposeAsset, disposeScope({ assetId: "FA-GHOST" }));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === DISPOSE_ASSET_ERROR_CODES.unknownAsset),
    `expected unknownAsset, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
});

test("per dispose asset, an asset belonging to another client is unknown here too", async () => {
  const db = disposeDb();
  db.seed("fixed_assets", [asset("FA-OTHER", { clientId: CLIENT_A2 })]);
  const preview = await previewPer(
    db,
    perDisposeAsset,
    disposeScope({ assetId: "FA-OTHER", clientId: CLIENT_A1 }),
  );
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === DISPOSE_ASSET_ERROR_CODES.unknownAsset),
    `expected unknownAsset across tenants, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
});

test("per dispose asset, disposing before the asset was placed in service is refused", async () => {
  const db = disposeDb();
  db.seed("fixed_assets", [asset("FA-EARLY")]);
  const preview = await previewPer(
    db,
    perDisposeAsset,
    disposeScope({ assetId: "FA-EARLY", disposedOn: "2025-12-01" }),
  );
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === DISPOSE_ASSET_ERROR_CODES.beforeService),
    `expected beforeService, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
});

test("per dispose asset, proceeds with no account named is refused rather than guessed", async () => {
  const db = disposeDb();
  db.seed("fixed_assets", [asset("FA-NOACC")]);
  const preview = await previewPer(
    db,
    perDisposeAsset,
    disposeScope({ assetId: "FA-NOACC", proceedsCents: "50000", proceedsAccount: null }),
  );
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some(
      (e) => e.code === DISPOSE_ASSET_ERROR_CODES.missingProceedsAccount,
    ),
    `expected missingProceedsAccount, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
});

test("per dispose asset, undo reverses the entry, restores the asset, and leaves the schedule row", async () => {
  const db = disposeDb();
  db.seed("fixed_assets", [asset("FA-U")]);
  db.seed("depreciation_schedule", [
    historyRow("DEP-JAN", "FA-U", "2026-01-01", "2026-01-31", 1, BigInt(100000), BigInt(100000)),
  ]);
  const { applied } = await applyPer(
    db,
    perDisposeAsset,
    disposeScope({
      assetId: "FA-U",
      disposedOn: "2026-02-15",
      proceedsCents: "1200000",
      proceedsAccount: "1010",
    }),
  );

  const undone = await executeUndo(db, perDisposeAsset, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");

  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the original plus its mirror still foot");
  assertEqual(balanceOf(db, "6700"), BigInt(0), "every account nets back to zero");
  assertEqual(balanceOf(db, "8200"), BigInt(0), "the gain line too");

  const row = assetOf(db, "FA-U");
  assertEqual(row.status, "active", "status reverted");
  assertEqual(row.disposedOn, null, "disposal date cleared");
  assertEqual(row.disposalEntryId, null, "entry pointer cleared");
  assertEqual(row.disposalProceedsCents, null, "and the proceeds");

  const feb = scheduleRows(db).find((r) => r.periodNumber === 2);
  assert(feb !== undefined, "the schedule row stays");
  assertEqual(feb?.status, "posted", "it is the record that the period was taken, undo does not touch it");
});
