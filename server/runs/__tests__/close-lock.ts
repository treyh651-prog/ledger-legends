/**
 * CLOSE-LOCK-PERIOD. Doc 02 module 6 CLS-LOCK-PERIOD, doc 00 Part 5.
 *
 * The questions these tests answer: does a lock require all nineteen gates to
 * hold, does one failing gate refuse the run rather than lock quietly, does an
 * override with a written reason lock the period as closed with exceptions while
 * an override with no reason refuses, does a stale gate set refuse, and is
 * locking an already locked period a no op.
 */

import { clsEvaluateGates, gateResultId } from "../runs/cls-evaluate-gates";
import {
  clsLockPeriod,
  fiscalYearEndOf,
  fiscalYearStartOf,
  lockId,
  LOCK_ERROR_CODES,
} from "../runs/cls-lock-period";
import type { MemoryRunDb } from "../db-memory";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  applyClose,
  closeDb,
  closeScope,
  period,
  previewClose,
  request,
  seedEntry,
  APPROVER,
  PERIOD,
  PERIOD_END,
} from "./close-fixtures";
import { assert, assertEqual, test } from "./harness";

/** Evaluate the gates so the lock run has something to read. */
async function withGates(db: MemoryRunDb): Promise<MemoryRunDb> {
  await applyClose(db, clsEvaluateGates, closeScope());
  return db;
}

/** Break G01 by parking revenue in suspense. That also fails G19, which is why
 * the override tests below use the single gate break instead. */
function breakAGate(db: MemoryRunDb): void {
  seedEntry(db, "JE-STUCK", "2026-01-20", [
    ["1990", BigInt(5000)],
    ["4100", BigInt(-5000)],
  ]);
}

/** Break G17 alone by leaving a stale request nobody reassigned. */
function breakOneGate(db: MemoryRunDb): void {
  db.seed("document_requests", [request("DR-OLD", "receipt:TXN-OLD")]);
}

test("lock, a period whose gates all hold is locked", async () => {
  const db = await withGates(closeDb());
  const { applied } = await applyClose(db, clsLockPeriod, closeScope());
  assertEqual(applied.status, "completed", "the run completed");
  const row = db.all("period_locks").find((l) => l.id === lockId(CLIENT_A1, PERIOD));
  assertEqual(row?.status, "locked", "the lock is locked");
  assertEqual(row?.periodStart, PERIOD, "for the period asked for");
  assertEqual(row?.periodEnd, PERIOD_END, "through its last day");
  assertEqual(row?.lockedBy, APPROVER, "by the person who applied it");
  assert(row?.lockedAt !== null, "with a time on it");
  assertEqual(row?.closedWithExceptions, false, "and no exceptions");
});

test("lock, the lock carries the gate results and the trial balance", async () => {
  const db = await withGates(closeDb());
  await applyClose(db, clsLockPeriod, closeScope());
  const row = db.all("period_locks").find((l) => l.id === lockId(CLIENT_A1, PERIOD));
  assertEqual(row?.gateResultsSnapshot.length, 19, "all nineteen gates snapshot");
  assert(
    row?.gateResultsSnapshot.every(
      (g) => g.outcome === "pass" || g.outcome === "not_applicable",
    ) === true,
    "every snapshot entry holds",
  );
  const cash = row?.trialBalanceSnapshot.find((t) => t.accountNumber === "1010");
  assertEqual(cash?.balanceCents, "100000", "the cash balance was snapshot");
  assert((row?.ledgerFingerprint ?? "").length > 0, "the fingerprint was stored");
});

test("lock, the period row moves to locked", async () => {
  const db = await withGates(closeDb());
  db.seed("close_periods", [period("CP-JAN", PERIOD, PERIOD_END)]);
  await applyClose(db, clsLockPeriod, closeScope());
  const row = db.all("close_periods").find((p) => p.id === "CP-JAN");
  assertEqual(row?.status, "locked", "the period is closed");
  assert(row?.lockedAt !== null, "and dated");
});

test("lock, a client with no period row gets one", async () => {
  const db = await withGates(closeDb());
  assertEqual(db.all("close_periods").length, 0, "nothing to start with");
  await applyClose(db, clsLockPeriod, closeScope());
  const rows = db.all("close_periods");
  assertEqual(rows.length, 1, "one period row was created");
  assertEqual(rows[0]?.status, "locked", "already locked");
  assertEqual(rows[0]?.fiscalYearEnd, "2026-12-31", "with the fiscal year on it");
});

test("lock, one failing gate refuses the run", async () => {
  const db = closeDb();
  breakAGate(db);
  await withGates(db);
  const { applied } = await applyClose(db, clsLockPeriod, closeScope());
  assertEqual(applied.status, "refused", "the run refused");
  assertEqual(
    applied.result.errors[0]?.code,
    LOCK_ERROR_CODES.gatesFailed,
    "because a gate failed",
  );
  assertEqual(db.all("period_locks").length, 0, "and nothing was locked");
});

test("lock, a missing gate result refuses the run", async () => {
  const db = await withGates(closeDb());
  const target = gateResultId(PERIOD, "G07");
  const kept = db.all("close_gate_results").filter((r) => r.id !== target);
  // Seeding merges, so the table is rebuilt through a fresh database instead.
  const rebuilt = closeDb();
  rebuilt.seed("close_gate_results", kept);
  const { applied } = await applyClose(rebuilt, clsLockPeriod, closeScope());
  assertEqual(applied.status, "refused", "the run refused");
  assertEqual(
    applied.result.errors[0]?.code,
    LOCK_ERROR_CODES.gatesMissing,
    "because the gate set is incomplete",
  );
});

test("lock, a gate set evaluated against a different ledger refuses", async () => {
  const db = await withGates(closeDb());
  // A posting after the gates ran is exactly the state the freshness check is
  // for. The gates would answer differently now, so their answers are stale.
  seedEntry(db, "JE-LATE", "2026-01-29", [
    ["6100", BigInt(1200)],
    ["1010", BigInt(-1200)],
  ]);
  const { applied } = await applyClose(db, clsLockPeriod, closeScope());
  assertEqual(applied.status, "refused", "the run refused");
  assertEqual(
    applied.result.errors[0]?.code,
    LOCK_ERROR_CODES.gatesStale,
    "because the gate set is stale",
  );
  assertEqual(applied.result.errors[0]?.retryable, true, "rerun the gates and retry");
});

test("lock, an overridden failure with a reason locks with exceptions", async () => {
  const db = closeDb();
  breakOneGate(db);
  await withGates(db);
  const failed = db
    .all("close_gate_results")
    .find((r) => r.gateCode === "G17" && r.outcome === "fail");
  assert(failed !== undefined, "G17 failed to begin with");
  db.seed("close_gate_results", [
    {
      ...failed!,
      manualOverride: true,
      overrideReason: "the client corrects this in February",
    },
  ]);
  const { applied } = await applyClose(db, clsLockPeriod, closeScope());
  assertEqual(applied.status, "completed", "the period locked");
  const row = db.all("period_locks").find((l) => l.id === lockId(CLIENT_A1, PERIOD));
  assertEqual(row?.closedWithExceptions, true, "as closed with exceptions");
  assert(
    (row?.exceptionNote ?? "").includes("G17"),
    "and the note names the gate",
  );
});

test("lock, an override with no written reason refuses", async () => {
  const db = closeDb();
  breakOneGate(db);
  await withGates(db);
  const failed = db
    .all("close_gate_results")
    .find((r) => r.gateCode === "G17" && r.outcome === "fail");
  db.seed("close_gate_results", [
    { ...failed!, manualOverride: true, overrideReason: "   " },
  ]);
  const { applied } = await applyClose(db, clsLockPeriod, closeScope());
  assertEqual(applied.status, "refused", "the run refused");
  assertEqual(
    applied.result.errors[0]?.code,
    LOCK_ERROR_CODES.overrideWithoutReason,
    "because nobody wrote a reason",
  );
});

test("lock, an already locked period is a no op", async () => {
  const db = closeDb();
  db.seed("period_locks", [
    lock("LOCK-JAN", FIRM_A, CLIENT_A1, PERIOD, PERIOD_END),
  ]);
  const { applied } = await applyClose(db, clsLockPeriod, closeScope());
  assertEqual(applied.status, "no_op", "nothing was proposed");
  assertEqual(db.all("period_locks").length, 1, "and no second lock exists");
});

test("lock, locking the same period twice ends in the same place", async () => {
  const db = await withGates(closeDb());
  await applyClose(db, clsLockPeriod, closeScope());
  const { applied } = await applyClose(db, clsLockPeriod, closeScope());
  // Nothing about the period changed, so the second execution is the first one
  // handed back rather than a fresh pass over the same books.
  assert(applied.deduplicatedFrom !== undefined, "the second run deduplicated");
  assertEqual(db.all("period_locks").length, 1, "one lock row");
});

test("lock, the run posts nothing to the ledger", async () => {
  const db = await withGates(closeDb());
  await applyClose(db, clsLockPeriod, closeScope());
  assertEqual(db.all("journal_entries").length, 1, "the ledger is unchanged");
});

test("lock, preview proposes what apply writes", async () => {
  const db = await withGates(closeDb());
  const preview = await previewClose(db, clsLockPeriod, closeScope());
  assertEqual(db.all("period_locks").length, 0, "preview locked nothing");
  const { applied } = await applyClose(db, clsLockPeriod, closeScope());
  assertEqual(
    applied.result.proposals.length,
    preview.result.proposals.length,
    "the same proposal count",
  );
});

test("lock, a period row carrying manual override keeps its status", async () => {
  const db = await withGates(closeDb());
  db.seed("close_periods", [
    period("CP-JAN", PERIOD, PERIOD_END, { manualOverride: true }),
  ]);
  const { applied } = await applyClose(db, clsLockPeriod, closeScope());
  assertEqual(
    db.all("close_periods").find((p) => p.id === "CP-JAN")?.status,
    "open",
    "the overridden period row was left alone",
  );
  assert(
    applied.result.skips.some((s) => s.reason === "manual_override"),
    "and the skip says why",
  );
  assertEqual(db.all("period_locks").length, 1, "the lock itself still landed");
});

test("lock, the fiscal year helpers follow the policy month", () => {
  assertEqual(fiscalYearStartOf("2026-03-01", 12), "2026-01-01", "calendar year");
  assertEqual(fiscalYearEndOf("2026-03-01", 12), "2026-12-31", "ends in December");
  assertEqual(fiscalYearStartOf("2026-03-01", 6), "2025-07-01", "a June year end");
  assertEqual(fiscalYearEndOf("2026-03-01", 6), "2026-06-30", "ends in June");
  assertEqual(fiscalYearStartOf("2026-08-01", 6), "2026-07-01", "the next one");
});
