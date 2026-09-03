/**
 * The close pipeline. Doc 02 module 6 end to end.
 *
 * The questions these tests answer: does the chain of tie out, request, gate
 * evaluation and lock reach the same place a person would reach by hand, does
 * every gate produce a definite answer in the middle of the chain rather than at
 * the end of a clean fixture, does the lock refuse while any gate fails, and does
 * the chain finish once the blocking condition is fixed.
 *
 * The chain is run as separate executions rather than through the sequence
 * runner, because the point of the test is the handoff between the runs: what one
 * writes is what the next reads.
 */

import { subTieBalances } from "../runs/sub-tie-balances";
import { subRaiseRequests } from "../runs/sub-raise-requests";
import { clsEvaluateGates, CLOSE_GATES } from "../runs/cls-evaluate-gates";
import { clsLockPeriod, LOCK_ERROR_CODES, lockId } from "../runs/cls-lock-period";
import { clsRollForward } from "../runs/cls-roll-forward";
import { clsPostYearEnd } from "../runs/cls-post-yearend";
import { CLOSE_ORDER, lookupRun } from "../registry";
import type { MemoryRunDb } from "../db-memory";
import type { RunOutcome } from "../execute";
import type { Proposal } from "../contract";
import { CLIENT_A1 } from "./fixtures";
import {
  applyClose,
  balanceOf,
  closeDb,
  closeScope,
  outcomesOf,
  previewClose,
  recBatch,
  requestsOf,
  seedEntry,
  tieoutsOf,
  NEXT_PERIOD,
  PERIOD,
} from "./close-fixtures";
import { assert, assertEqual, test } from "./harness";

/**
 * Tie out, raise requests, evaluate gates, then try the lock. Returns the lock
 * outcome plus the gate outcomes the lock was judged against.
 */
async function closePeriod(
  db: MemoryRunDb,
  period: string = PERIOD,
): Promise<{ lock: RunOutcome<Proposal>; gates: Map<string, string> }> {
  await applyClose(db, subTieBalances, closeScope(period));
  await applyClose(db, subRaiseRequests, closeScope(period));
  await applyClose(db, clsEvaluateGates, closeScope(period));
  const gates = outcomesOf(db);
  const { applied } = await applyClose(db, clsLockPeriod, closeScope(period));
  return { lock: applied, gates };
}

test("pipeline, the registry states the close order", () => {
  assertEqual(
    [...CLOSE_ORDER],
    [
      "SUB-TIEOUT-ACCOUNTS",
      "SUB-RAISE-REQUESTS",
      "CLOSE-CHECK-GATES",
      "CLOSE-LOCK-PERIOD",
      "CLOSE-ROLL-FORWARD",
      "CLOSE-POST-YEAREND",
    ],
    "the six runs in the order a close walks them",
  );
  for (const type of CLOSE_ORDER) {
    assert(lookupRun(type) !== null, `${type} is registered`);
  }
});

test("pipeline, the chain ties out, raises requests, and answers every gate", async () => {
  const db = closeDb();
  const { gates } = await closePeriod(db);
  assert(tieoutsOf(db).length > 0, "the tie out run wrote its rows");
  assert(requestsOf(db).length > 0, "the request run raised its items");
  assertEqual(gates.size, CLOSE_GATES.length, "one answer per gate");
  for (const gate of CLOSE_GATES) {
    const outcome = gates.get(gate.code);
    assert(
      outcome === "pass" || outcome === "fail" || outcome === "not_applicable",
      `${gate.code} answered ${String(outcome)} rather than definitely`,
    );
  }
});

test("pipeline, the tie out run feeds the request run", async () => {
  const db = closeDb();
  db.seed("rec_batches", [
    recBatch("RB-JAN", { statementBalanceCents: BigInt(88000) }),
  ]);
  await applyClose(db, subTieBalances, closeScope());
  await applyClose(db, subRaiseRequests, closeScope());
  const variance = requestsOf(db).find(
    (r) => r.subjectKey === `variance:1010:${PERIOD}`,
  );
  assertEqual(variance?.catalogCode, "VARIANCE", "the variance became a request");
  assertEqual(variance?.accountNumber, "1010", "against the account that broke");
});

test("pipeline, the lock refuses while a gate fails and succeeds once it is fixed", async () => {
  const db = closeDb();
  // A stale request nobody reassigned fails G17 and nothing else.
  db.seed("document_requests", [
    {
      id: "DR-STALE",
      firmId: db.all("chart_accounts")[0]?.firmId ?? "FIRM-A",
      clientId: CLIENT_A1,
      version: 1,
      subjectKey: "receipt:TXN-STALE",
      catalogCode: "RECEIPT",
      accountNumber: "6100",
      periodStart: PERIOD,
      linkedItemId: null,
      status: "open",
      owner: "client",
      detail: "a receipt nobody chased",
      openedOn: "2025-12-15",
      asOfDate: "2026-01-31",
      agingDays: 47,
      escalatesOn: "2025-12-22",
      escalation: "final",
      ownerChangedOn: null,
      lastRefreshedOn: null,
      refreshCount: 0,
      createdByRunId: "RUNX-SEED",
      createdAt: "2025-12-15T00:00:00.000Z",
      manualOverride: false,
    },
  ]);
  const blocked = await closePeriod(db);
  assertEqual(blocked.gates.get("G17"), "fail", "the stale request failed G17");
  assertEqual(blocked.lock.status, "refused", "so the lock refused");
  assertEqual(
    blocked.lock.result.errors[0]?.code,
    LOCK_ERROR_CODES.gatesFailed,
    "naming the failing gate set",
  );
  assertEqual(db.all("period_locks").length, 0, "and nothing was locked");

  // Somebody picks the request up, which is what the gate is asking for.
  const stale = db.all("document_requests").find((r) => r.id === "DR-STALE");
  // The version moves with the reassignment, the way a real update would, which
  // is what tells the gate run its scope changed and it must look again.
  db.seed("document_requests", [
    { ...stale!, ownerChangedOn: "2026-01-28", version: 2 },
  ]);
  const fixed = await closePeriod(db);
  assertEqual(fixed.gates.get("G17"), "pass", "G17 now holds");
  assertEqual(fixed.lock.status, "completed", "and the period locked");
  assertEqual(
    db.all("period_locks").find((l) => l.id === lockId(CLIENT_A1, PERIOD))?.status,
    "locked",
    "the lock row says locked",
  );
});

test("pipeline, running the whole chain twice ends in the same place", async () => {
  const db = closeDb();
  await closePeriod(db);
  const tieouts = tieoutsOf(db).length;
  const requests = requestsOf(db).length;
  await closePeriod(db);
  assertEqual(tieoutsOf(db).length, tieouts, "no duplicate tie out rows");
  assertEqual(requestsOf(db).length, requests, "no duplicate requests");
  assertEqual(db.all("close_gate_results").length, 19, "one row per gate");
  assertEqual(db.all("period_locks").length, 1, "and one lock");
});

test("pipeline, the read only runs still work after the period is locked", async () => {
  const db = closeDb();
  await closePeriod(db);
  const tieout = await previewClose(db, subTieBalances, closeScope());
  const gates = await previewClose(db, clsEvaluateGates, closeScope());
  assert(tieout.status !== "refused", "the tie out run reads a locked period");
  assert(gates.status !== "refused", "and so does the gate evaluator");
  const requests = await previewClose(db, subRaiseRequests, closeScope());
  assert(
    requests.result.skips.every((s) => s.reason === "locked_period"),
    "while the request run stands down on a closed month",
  );
});

test("pipeline, the locked period rolls forward into the next one", async () => {
  const db = closeDb();
  await closePeriod(db);
  await applyClose(db, clsRollForward, closeScope(NEXT_PERIOD));
  const cash = db
    .all("opening_balances")
    .find((o) => o.periodStart === NEXT_PERIOD && o.accountNumber === "1010");
  assertEqual(cash?.openingBalanceCents, BigInt(100000), "February opens at it");
  assertEqual(cash?.sourcePeriodStart, PERIOD, "from the closed month");
});

test("pipeline, a full year closes to equity and leaves the next year clean", async () => {
  const db = closeDb();
  seedEntry(db, "JE-REV-JUN", "2026-06-30", [
    ["1010", BigInt(200000)],
    ["4100", BigInt(-200000)],
  ]);
  seedEntry(db, "JE-EXP-SEP", "2026-09-30", [
    ["6100", BigInt(120000)],
    ["1010", BigInt(-120000)],
  ]);
  await applyClose(db, clsPostYearEnd, closeScope("2027-01-01"));
  await applyClose(db, clsRollForward, closeScope("2027-01-01"));
  assertEqual(balanceOf(db, "4100"), BigInt(0), "revenue was emptied");
  assertEqual(balanceOf(db, "6100"), BigInt(0), "expense was emptied");
  assertEqual(balanceOf(db, "3200"), BigInt(-180000), "the result sits in equity");
  const openings = db
    .all("opening_balances")
    .filter((o) => o.periodStart === "2027-01-01");
  const equity = openings.find((o) => o.accountNumber === "3200");
  assertEqual(equity?.openingBalanceCents, BigInt(-180000), "the new year opens at it");
  assert(
    openings.every((o) => o.accountNumber !== "4100" && o.accountNumber !== "6100"),
    "and no income statement account rolled",
  );
});

test("pipeline, the trial balance still foots after the year end entry", async () => {
  const db = closeDb();
  await applyClose(db, clsPostYearEnd, closeScope("2027-01-01"));
  let total = BigInt(0);
  for (const line of db.all("journal_lines")) total += line.amountCents;
  assertEqual(total, BigInt(0), "the whole ledger foots to zero");
});
