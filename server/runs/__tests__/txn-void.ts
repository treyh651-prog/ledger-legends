/**
 * TXN-VOID tests. A posted transaction reverses its own entry and flips to
 * voided/reversed, an unposted transaction just flips the two flags, an
 * already voided transaction is a no op the second time, and undo puts both
 * halves back.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { isJournalEntry } from "../contract";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, opts, scopeFor, txn } from "./fixtures";
import { codingDb, standardCategories } from "./coding-fixtures";
import { txnPostCoded, postedEntryIdFor } from "../runs/txn-post-coded";
import { txnVoid, voidReversalEntryIdFor } from "../runs/txn-void";
import type { TransactionRow } from "../tables";

function ruleCodedTxn(id: string, extra: Record<string, unknown> = {}): TransactionRow {
  return {
    ...txn(id, FIRM_A, CLIENT_A1, "BA-A1-CARD", "2026-01-15", BigInt(-5000)),
    categoryId: "CAT-software",
    categoryVersion: 1,
    cascadeLevel: 6,
    ruleId: "RULE-1",
    ruleVersion: 1,
    ...extra,
  };
}

function balanceOf(db: ReturnType<typeof codingDb>, accountNumber: string): bigint {
  let total = BigInt(0);
  for (const l of db.all("journal_lines")) {
    if (l.accountNumber === accountNumber) total += l.amountCents;
  }
  return total;
}

function voidScope(transactionId: string, reason = "duplicate entry") {
  return { clientId: CLIENT_A1, transactionId, reason };
}

test("txn-void: a posted transaction's entry reverses and the row flips to voided/reversed", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1")]);
  const postPreview = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("apply", { previewRunId: postPreview.executionId }));

  const preview = await execute(db, txnVoid, voidScope("TX-1"), opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, txnVoid, voidScope("TX-1"), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries.length, 1, "one reversal entry");
  assertEqual(entries[0].targetId, voidReversalEntryIdFor("TX-1"), "a deterministic id, not a fresh ulid");
  assertEqual(entries[0].reversalOf, postedEntryIdFor("TX-1"), "pointing at the entry it reverses");

  assertEqual(balanceOf(db, "1010"), BigInt(0), "the card account is back to zero");
  assertEqual(balanceOf(db, "6100"), BigInt(0), "software expense is back to zero");

  const row = (db.all("transactions") as TransactionRow[]).find((t) => t.id === "TX-1");
  assertEqual(row?.voided, true, "voided");
  assertEqual(row?.status, "reversed", "status reversed");
});

test("txn-void: an unposted transaction just flips voided and status, no journal entry", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1", { categoryId: null, cascadeLevel: null, ruleId: null })]);

  const preview = await execute(db, txnVoid, voidScope("TX-1"), opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, txnVoid, voidScope("TX-1"), opts("apply", { previewRunId: preview.executionId }));

  assertEqual(applied.result.proposals.filter(isJournalEntry).length, 0, "nothing to reverse, never posted");
  const row = (db.all("transactions") as TransactionRow[]).find((t) => t.id === "TX-1");
  assertEqual(row?.voided, true, "voided");
  assertEqual(row?.status, "reversed", "status reversed");
});

test("txn-void: an already voided transaction is a no op the second time", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1", { voided: true, status: "reversed" as const })]);

  const preview = await execute(db, txnVoid, voidScope("TX-1"), opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(
    preview.result.skips.some((s) => s.reason === "already_applied" && s.detail === "already voided"),
    "reported as already voided",
  );
});

test("txn-void: an unknown transaction is refused", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());

  const preview = await execute(db, txnVoid, voidScope("TX-GHOST"), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "TXN_VOID_UNKNOWN_TRANSACTION"),
    "named error code",
  );
});

test("txn-void: a cleared transaction is allowed to void, with no refusal", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1", { categoryId: null, cascadeLevel: null, ruleId: null, cleared: true })]);

  const preview = await execute(db, txnVoid, voidScope("TX-1"), opts("preview"));
  assertEqual(preview.status, "completed", "completed, not refused, by product decision");
});

test("txn-void: undo reverses the reversal and flips voided/status back", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1")]);
  const postPreview = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("apply", { previewRunId: postPreview.executionId }));

  const preview = await execute(db, txnVoid, voidScope("TX-1"), opts("preview"));
  const applied = await execute(db, txnVoid, voidScope("TX-1"), opts("apply", { previewRunId: preview.executionId }));

  const undone = await executeUndo(db, txnVoid, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");

  const row = (db.all("transactions") as TransactionRow[]).find((t) => t.id === "TX-1");
  assertEqual(row?.voided, false, "voided reverted");
  assertEqual(row?.status, "active", "status reverted to active");
  assertEqual(balanceOf(db, "1010"), BigInt(-5000), "the original posting is back");
  assertEqual(balanceOf(db, "6100"), BigInt(5000), "both sides");
});
