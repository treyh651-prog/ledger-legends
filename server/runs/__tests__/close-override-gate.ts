/**
 * CLOSE-OVERRIDE-GATE tests (audit fix, problem 4). The whole point: a
 * solo firm trips G18 on every real close (the same actor previews and
 * applies everything), and before this run existed, nothing could ever
 * set close_gate_results.manual_override -- confirmed by close-lock.ts's
 * own override tests, which seed that field directly rather than through
 * any run. These tests chain the real runs instead: evaluate gates, then
 * override the failing one, then confirm CLOSE-LOCK-PERIOD actually
 * accepts it.
 */

import { executeUndo } from "../undo";
import { clsEvaluateGates } from "../runs/cls-evaluate-gates";
import { clsLockPeriod, lockId } from "../runs/cls-lock-period";
import { closeOverrideGate, ERR_GATE_RESULT_NOT_FOUND } from "../runs/close-override-gate";
import { ACTOR, CLIENT_A1, FIRM_A, NOW } from "./fixtures";
import {
  applyClose,
  closeDb,
  closeScope,
  request,
  PERIOD,
} from "./close-fixtures";
import { assert, assertEqual, test } from "./harness";

/** Break G17 alone, same shape close-lock.ts's own breakOneGate uses. */
function breakOneGate(db: ReturnType<typeof closeDb>): void {
  db.seed("document_requests", [request("DR-OLD", "receipt:TXN-OLD")]);
}

function overrideScope(gateCode: string, reason = "accepted, the client corrects this in February") {
  return { clientId: CLIENT_A1, period: PERIOD, gateCode, reason };
}

test("close-override-gate: a failing gate is overridden and CLOSE-LOCK-PERIOD accepts it with exceptions", async () => {
  const db = closeDb();
  breakOneGate(db);
  await applyClose(db, clsEvaluateGates, closeScope());

  const { applied } = await applyClose(db, closeOverrideGate, overrideScope("G17"));
  assertEqual(applied.status, "completed", "apply completed");
  const result = db.all("close_gate_results").find((r) => r.gateCode === "G17");
  assertEqual(result?.manualOverride, true, "the gate carries the override");
  assertEqual(result?.overrideReason, "accepted, the client corrects this in February", "with the written reason");

  const lockOutcome = await applyClose(db, clsLockPeriod, closeScope());
  assertEqual(lockOutcome.applied.status, "completed", "the period locks now that G17 is accepted");
  const lockRow = db.all("period_locks").find((l) => l.id === lockId(CLIENT_A1, PERIOD));
  assertEqual(lockRow?.closedWithExceptions, true, "closed with exceptions");
  assert((lockRow?.exceptionNote ?? "").includes("G17"), "the exception note names the gate");
});

test("close-override-gate: a gate with no evaluated result is refused", async () => {
  const db = closeDb();
  const { preview } = await applyClose(db, closeOverrideGate, overrideScope("G17"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === ERR_GATE_RESULT_NOT_FOUND),
    "named error code",
  );
});

test("close-override-gate: a gate that already passes is a no op, nothing to override", async () => {
  const db = closeDb();
  await applyClose(db, clsEvaluateGates, closeScope());
  const result = db.all("close_gate_results").find((r) => r.gateCode === "G01");
  assertEqual(result?.outcome, "pass", "G01 passes on the clean fixture");
  const { preview } = await applyClose(db, closeOverrideGate, overrideScope("G01"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(preview.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("close-override-gate: overriding the same gate twice is a no op the second time", async () => {
  const db = closeDb();
  breakOneGate(db);
  await applyClose(db, clsEvaluateGates, closeScope());
  await applyClose(db, closeOverrideGate, overrideScope("G17"));
  const { preview } = await applyClose(db, closeOverrideGate, overrideScope("G17", "a different reason"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(preview.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
  const result = db.all("close_gate_results").find((r) => r.gateCode === "G17");
  assertEqual(result?.overrideReason, "accepted, the client corrects this in February", "the first reason stands, not overwritten");
});

test("close-override-gate: undo is a no op, the override protection guard refuses to touch the row again", async () => {
  // Confirmed live: once manual_override is set on any row, the same
  // guard that protects it from every other run also refuses this run's
  // own undo (OVERRIDE_PROTECTED_ROW) -- the identical terminal invariant
  // TXN-RECODE's own undo runs into. undoPlan returns no proposals rather
  // than let apply fail on a write the database would refuse anyway.
  const db = closeDb();
  breakOneGate(db);
  await applyClose(db, clsEvaluateGates, closeScope());
  const { applied } = await applyClose(db, closeOverrideGate, overrideScope("G17"));

  const undone = await executeUndo(db, closeOverrideGate, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "no_op", "nothing to undo");
  const result = db.all("close_gate_results").find((r) => r.gateCode === "G17");
  assertEqual(result?.manualOverride, true, "the override still stands");
  assertEqual(result?.overrideReason, "accepted, the client corrects this in February", "and its reason");
});
