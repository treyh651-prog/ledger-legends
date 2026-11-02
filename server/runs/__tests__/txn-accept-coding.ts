/**
 * TXN-ACCEPT-CODING tests. A single accept marks the row reviewed and
 * increments the rule's accepted count; a bulk accept across several
 * transactions coded by the same rule tallies correctly in one run instead
 * of clobbering itself; crossing the promotion threshold with a clean
 * record flips autoPostEnabled automatically, mid batch if that is where
 * the twenty fifth one lands; an already reviewed, not rule coded, or
 * voided row is skipped, not errored; undo puts the counters back.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, opts, txn } from "./fixtures";
import { codingDb, rule, standardCategories } from "./coding-fixtures";
import { txnAcceptCoding } from "../runs/txn-accept-coding";
import { RULE_PROMOTION_MIN_ACCEPTED } from "../runs/txn-apply-rules";
import type { RuleRow, TransactionRow } from "../tables";

function reviewableTxn(id: string, ruleId: string, extra: Record<string, unknown> = {}): TransactionRow {
  return {
    ...txn(id, FIRM_A, CLIENT_A1, "BA-A1-CARD", "2026-01-15", BigInt(-5000)),
    categoryId: "CAT-software",
    categoryVersion: 1,
    cascadeLevel: 6,
    ruleId,
    ruleVersion: 1,
    ...extra,
  };
}

function acceptScope(transactionIds: string[]) {
  return { clientId: CLIENT_A1, transactionIds };
}

function ruleRow(db: ReturnType<typeof codingDb>, id: string): RuleRow | undefined {
  return (db.all("rules") as RuleRow[]).find((r) => r.id === id);
}

function transactionRow(db: ReturnType<typeof codingDb>, id: string): TransactionRow | undefined {
  return (db.all("transactions") as TransactionRow[]).find((t) => t.id === id);
}

test("txn-accept-coding: a single accept marks the row reviewed and bumps accepted_count", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("rules", [rule("RULE-1")]);
  db.seed("transactions", [reviewableTxn("TX-1", "RULE-1")]);

  const preview = await execute(db, txnAcceptCoding, acceptScope(["TX-1"]), opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, txnAcceptCoding, acceptScope(["TX-1"]), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const t = transactionRow(db, "TX-1");
  assertEqual(t?.ruleReviewOutcome, "accepted", "marked accepted");
  assert(t?.ruleReviewedAt !== null, "reviewed timestamp stamped");

  const r = ruleRow(db, "RULE-1");
  assertEqual(r?.acceptedCount, 1, "accepted count incremented once");
});

test("txn-accept-coding: a bulk accept of several rows under the same rule tallies in one run", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("rules", [rule("RULE-1", { acceptedCount: 5 })]);
  db.seed("transactions", [
    reviewableTxn("TX-1", "RULE-1"),
    reviewableTxn("TX-2", "RULE-1"),
    reviewableTxn("TX-3", "RULE-1"),
  ]);

  const preview = await execute(db, txnAcceptCoding, acceptScope(["TX-1", "TX-2", "TX-3"]), opts("preview"));
  const applied = await execute(db, txnAcceptCoding, acceptScope(["TX-1", "TX-2", "TX-3"]), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const r = ruleRow(db, "RULE-1");
  assertEqual(r?.acceptedCount, 8, "five plus three, not five plus one three times");
  for (const id of ["TX-1", "TX-2", "TX-3"]) {
    assertEqual(transactionRow(db, id)?.ruleReviewOutcome, "accepted", `${id} accepted`);
  }
});

test("txn-accept-coding: crossing the promotion threshold promotes automatically, mid batch", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("rules", [rule("RULE-1", { acceptedCount: RULE_PROMOTION_MIN_ACCEPTED - 2, rejectedCount: 0, autoPostEnabled: false })]);
  db.seed("transactions", [reviewableTxn("TX-1", "RULE-1"), reviewableTxn("TX-2", "RULE-1")]);

  const preview = await execute(db, txnAcceptCoding, acceptScope(["TX-1", "TX-2"]), opts("preview"));
  const applied = await execute(db, txnAcceptCoding, acceptScope(["TX-1", "TX-2"]), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const r = ruleRow(db, "RULE-1");
  assertEqual(r?.acceptedCount, RULE_PROMOTION_MIN_ACCEPTED, "exactly at the threshold");
  assertEqual(r?.autoPostEnabled, true, "promoted, no separate click");
  assertEqual(r?.autoPostEnabledBy, ACTOR, "approver attributed to the accepting actor");
});

test("txn-accept-coding: a rule with a reject on its record never promotes, however many accepts", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("rules", [rule("RULE-1", { acceptedCount: RULE_PROMOTION_MIN_ACCEPTED, rejectedCount: 1, autoPostEnabled: false })]);
  db.seed("transactions", [reviewableTxn("TX-1", "RULE-1")]);

  const preview = await execute(db, txnAcceptCoding, acceptScope(["TX-1"]), opts("preview"));
  const applied = await execute(db, txnAcceptCoding, acceptScope(["TX-1"]), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const r = ruleRow(db, "RULE-1");
  assertEqual(r?.autoPostEnabled, false, "rejectedCount !== 0 blocks promotion");
});

test("txn-accept-coding: already reviewed, not rule coded, and voided rows are skipped, not errored", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("rules", [rule("RULE-1")]);
  db.seed("transactions", [
    reviewableTxn("TX-REVIEWED", "RULE-1", { ruleReviewedAt: NOW.toISOString(), ruleReviewOutcome: "accepted" as const }),
    reviewableTxn("TX-NO-RULE", "RULE-1", { ruleId: null, ruleVersion: null }),
    reviewableTxn("TX-VOIDED", "RULE-1", { voided: true, status: "reversed" as const }),
  ]);

  const preview = await execute(
    db,
    txnAcceptCoding,
    acceptScope(["TX-REVIEWED", "TX-NO-RULE", "TX-VOIDED"]),
    opts("preview"),
  );
  assertEqual(preview.status, "no_op", "nothing left to accept");
  assertEqual(preview.result.errors.length, 0, "no errors, only skips");
  const reasons = preview.result.skips.map((s) => s.rowId);
  assert(reasons.includes("TX-REVIEWED"), "reviewed row skipped");
  assert(reasons.includes("TX-NO-RULE"), "non rule coded row skipped");
  assert(reasons.includes("TX-VOIDED"), "voided row skipped");
});

test("txn-accept-coding: undo puts the review marker and accepted count back", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("rules", [rule("RULE-1", { acceptedCount: 3 })]);
  db.seed("transactions", [reviewableTxn("TX-1", "RULE-1")]);

  const preview = await execute(db, txnAcceptCoding, acceptScope(["TX-1"]), opts("preview"));
  const applied = await execute(db, txnAcceptCoding, acceptScope(["TX-1"]), opts("apply", { previewRunId: preview.executionId }));

  const undone = await executeUndo(db, txnAcceptCoding, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");

  assertEqual(ruleRow(db, "RULE-1")?.acceptedCount, 3, "accepted count reverted");
  assertEqual(transactionRow(db, "TX-1")?.ruleReviewedAt, null, "review marker reverted");
  assertEqual(transactionRow(db, "TX-1")?.ruleReviewOutcome, null, "outcome reverted");
});
