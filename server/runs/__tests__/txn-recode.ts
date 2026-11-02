/**
 * TXN-RECODE tests. An unposted transaction just gets a new category; an
 * already posted one reverses its entry and reposts correctly under the
 * new category on TXN-POST-CODED's next run; a category that fails
 * categoryChecks skips that row rather than refusing the whole bulk call;
 * a reject on an already promoted rule demotes it automatically; a bulk
 * reject applies one category to several rows and tallies rejected_count
 * correctly; an already manually overridden row is left alone; an unknown
 * or inactive target category refuses the whole run, since every row in
 * one call shares the same target; undo reverses both halves.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { isJournalEntry } from "../contract";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, opts, scopeFor, txn } from "./fixtures";
import { codingDb, rule, standardCategories } from "./coding-fixtures";
import { txnRecode, recodeReversalEntryIdFor, recodePostedEntryIdFor } from "../runs/txn-recode";
import { txnPostCoded, postedEntryIdFor } from "../runs/txn-post-coded";
import type { RuleRow, TransactionRow } from "../tables";

function ruleCodedTxn(id: string, ruleId: string | null = "RULE-1", extra: Record<string, unknown> = {}): TransactionRow {
  return {
    ...txn(id, FIRM_A, CLIENT_A1, "BA-A1-CARD", "2026-01-15", BigInt(-5000)),
    categoryId: "CAT-software",
    categoryVersion: 1,
    cascadeLevel: ruleId ? 6 : null,
    ruleId,
    ruleVersion: ruleId ? 1 : null,
    ...extra,
  };
}

function recodeScope(transactionIds: string[], categoryId: string, reason = "wrong category") {
  return { clientId: CLIENT_A1, transactionIds, categoryId, reason };
}

function balanceOf(db: ReturnType<typeof codingDb>, accountNumber: string): bigint {
  let total = BigInt(0);
  for (const l of db.all("journal_lines")) {
    if (l.accountNumber === accountNumber) total += l.amountCents;
  }
  return total;
}

function ruleRow(db: ReturnType<typeof codingDb>, id: string): RuleRow | undefined {
  return (db.all("rules") as RuleRow[]).find((r) => r.id === id);
}

function transactionRow(db: ReturnType<typeof codingDb>, id: string): TransactionRow | undefined {
  return (db.all("transactions") as TransactionRow[]).find((t) => t.id === id);
}

test("txn-recode: an unposted transaction gets the new category, posted directly, no reversal needed", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("rules", [rule("RULE-1")]);
  db.seed("transactions", [ruleCodedTxn("TX-1", "RULE-1", { journalEntryId: null })]);

  const preview = await execute(db, txnRecode, recodeScope(["TX-1"], "CAT-meals"), opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, txnRecode, recodeScope(["TX-1"], "CAT-meals"), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const t = transactionRow(db, "TX-1");
  assertEqual(t?.categoryId, "CAT-meals", "recategorized");
  assertEqual(t?.cascadeLevel, 0, "LEVEL.manualOverride");
  assertEqual(t?.ruleId, null, "rule attribution cleared");
  assertEqual(t?.manualOverride, true, "manual override set");
  assertEqual(t?.ruleReviewOutcome, "rejected", "marked rejected");
  assertEqual(applied.result.proposals.filter(isJournalEntry).length, 1, "one posting, nothing to reverse");
  assertEqual(t?.journalEntryId, recodePostedEntryIdFor("TX-1"), "posted under its own entry id");
  assertEqual(balanceOf(db, "6200"), BigInt(5000), "posted straight to meals");

  const r = ruleRow(db, "RULE-1");
  assertEqual(r?.rejectedCount, 1, "rejected count incremented");
});

test("txn-recode: an already posted transaction reverses the old entry and posts the new one, in the same apply", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("rules", [rule("RULE-1")]);
  db.seed("transactions", [ruleCodedTxn("TX-1")]);
  const postPreview = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("apply", { previewRunId: postPreview.executionId }));
  assertEqual(balanceOf(db, "6100"), BigInt(5000), "posted to software first");

  const preview = await execute(db, txnRecode, recodeScope(["TX-1"], "CAT-meals"), opts("preview"));
  const applied = await execute(db, txnRecode, recodeScope(["TX-1"], "CAT-meals"), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries.length, 2, "one reversal, one new posting");
  const reversal = entries.find((e) => e.reversalOf !== undefined);
  assertEqual(reversal?.targetId, recodeReversalEntryIdFor("TX-1"), "a deterministic reversal id");
  assertEqual(reversal?.reversalOf, postedEntryIdFor("TX-1"), "pointing at the entry it reverses");

  assertEqual(balanceOf(db, "6100"), BigInt(0), "software reversed back to zero");
  assertEqual(balanceOf(db, "6200"), BigInt(5000), "reposted straight to meals, the corrected category");

  const t = transactionRow(db, "TX-1");
  assertEqual(t?.journalEntryId, recodePostedEntryIdFor("TX-1"), "pointing at the new posting, not null");
});

test("txn-recode: a category that fails categoryChecks skips that row, not the whole run", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("rules", [rule("RULE-1")]);
  db.seed("transactions", [
    ruleCodedTxn("TX-1"),
    // CAT-sales is a credit normal side category; this debit-signed transaction
    // (money out) disagrees with it, so categoryChecks blocks it.
  ]);

  const preview = await execute(db, txnRecode, recodeScope(["TX-1"], "CAT-sales"), opts("preview"));
  assertEqual(preview.status, "no_op", "the one candidate was skipped, nothing to apply");
  assertEqual(preview.result.errors.length, 0, "a bad category fit is a skip, not a refusal");
  assert(preview.result.skips.some((s) => s.rowId === "TX-1"), "the row was skipped");
});

test("txn-recode: a reject demotes an already promoted rule automatically", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("rules", [rule("RULE-1", { acceptedCount: 30, rejectedCount: 0, autoPostEnabled: true, autoPostEnabledBy: ACTOR })]);
  db.seed("transactions", [ruleCodedTxn("TX-1")]);

  const preview = await execute(db, txnRecode, recodeScope(["TX-1"], "CAT-meals"), opts("preview"));
  const applied = await execute(db, txnRecode, recodeScope(["TX-1"], "CAT-meals"), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const r = ruleRow(db, "RULE-1");
  assertEqual(r?.rejectedCount, 1, "rejected count incremented");
  assertEqual(r?.autoPostEnabled, false, "demoted automatically");
  assertEqual(r?.autoPostEnabledBy, null, "approver cleared with it");
});

test("txn-recode: a bulk reject applies one category to several rows and tallies rejected_count once", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("rules", [rule("RULE-1", { rejectedCount: 2 })]);
  db.seed("transactions", [
    ruleCodedTxn("TX-1"),
    ruleCodedTxn("TX-2"),
  ]);

  const preview = await execute(db, txnRecode, recodeScope(["TX-1", "TX-2"], "CAT-meals"), opts("preview"));
  const applied = await execute(db, txnRecode, recodeScope(["TX-1", "TX-2"], "CAT-meals"), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  assertEqual(transactionRow(db, "TX-1")?.categoryId, "CAT-meals", "TX-1 recoded");
  assertEqual(transactionRow(db, "TX-2")?.categoryId, "CAT-meals", "TX-2 recoded");
  assertEqual(ruleRow(db, "RULE-1")?.rejectedCount, 4, "two plus two, not two plus one twice");
});

test("txn-recode: an already manually overridden row is left alone", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [
    ruleCodedTxn("TX-1", null, { manualOverride: true, manualOverrideBy: ACTOR, manualOverrideAt: NOW.toISOString(), cascadeLevel: 0 }),
  ]);

  const preview = await execute(db, txnRecode, recodeScope(["TX-1"], "CAT-meals"), opts("preview"));
  assertEqual(preview.status, "no_op", "nothing recoded");
  assert(
    preview.result.skips.some((s) => s.rowId === "TX-1" && s.reason === "manual_override"),
    "skipped as already overridden",
  );
});

test("txn-recode: an unknown target category refuses the whole run", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1")]);

  const preview = await execute(db, txnRecode, recodeScope(["TX-1"], "CAT-GHOST"), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === "TXN_RECODE_UNKNOWN_CATEGORY"), "named error code");
});

test("txn-recode: an inactive target category refuses the whole run", async () => {
  const db = codingDb();
  db.seed("categories", [...standardCategories(), { ...standardCategories()[0], id: "CAT-retired", isActive: false }]);
  db.seed("transactions", [ruleCodedTxn("TX-1")]);

  const preview = await execute(db, txnRecode, recodeScope(["TX-1"], "CAT-retired"), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === "TXN_RECODE_INACTIVE_CATEGORY"), "named error code");
});

test("txn-recode: undo reverses the ledger effect fully but leaves the correction itself in place", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("rules", [rule("RULE-1")]);
  db.seed("transactions", [ruleCodedTxn("TX-1")]);
  const postPreview = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("apply", { previewRunId: postPreview.executionId }));

  const preview = await execute(db, txnRecode, recodeScope(["TX-1"], "CAT-meals"), opts("preview"));
  const applied = await execute(db, txnRecode, recodeScope(["TX-1"], "CAT-meals"), opts("apply", { previewRunId: preview.executionId }));

  const undone = await executeUndo(db, txnRecode, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");

  // The register side is terminal, by the same invariant 8 that protects a
  // manually overridden row from everything else -- categoryId, cascadeLevel,
  // and ruleId are all watched fields, and this run's own field write is
  // what set manual_override true on this very row, so its own undo is
  // blocked by the guard the same as any other run would be.
  const t = transactionRow(db, "TX-1");
  assertEqual(t?.categoryId, "CAT-meals", "the correction stands");
  assertEqual(t?.manualOverride, true, "still manually overridden");

  // The ledger side reverses cleanly regardless: both postings this run
  // made cancel out, so the net financial effect is back to exactly what
  // it was before the recode.
  assertEqual(balanceOf(db, "6100"), BigInt(5000), "the original posting is back");
  assertEqual(balanceOf(db, "6200"), BigInt(0), "the corrected posting's effect is reversed");

  // The rule's own field write has no override guard and reverts normally.
  assertEqual(ruleRow(db, "RULE-1")?.rejectedCount, 0, "rejected count reverted");
});
