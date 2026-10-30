/**
 * TXN-POST-CODED tests. A rule-coded transaction finally reaches the ledger,
 * a repeat is a no-op, an uncoded row is skipped as not yet coded, and a row
 * already claimed by a different posting path (suspense, a transfer pair, a
 * settlement, a recurring template) is left alone rather than double-posted.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { isJournalEntry } from "../contract";
import { CLIENT_A1, FIRM_A, opts, scopeFor, txn } from "./fixtures";
import { codingDb, standardCategories } from "./coding-fixtures";
import { txnPostCoded, postedEntryIdFor } from "../runs/txn-post-coded";
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

test("txn-post-coded: a rule-coded transaction posts to its own account", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1")]);

  const preview = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries.length, 1, "one entry");
  assertEqual(entries[0].lines.length, 2, "the bank line and the category line");
  assertEqual(balanceOf(db, "1010"), BigInt(-5000), "the card account took the debit side as observed");
  assertEqual(balanceOf(db, "6100"), BigInt(5000), "software expense took the balancing line");

  const row = (db.all("transactions") as TransactionRow[]).find((t) => t.id === "TX-1");
  assertEqual(row?.journalEntryId, postedEntryIdFor("TX-1"), "the register row now points at the entry that made it accounting");
});

test("txn-post-coded: an already posted transaction is a no op the second time", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1")]);
  const first = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("apply", { previewRunId: first.executionId }));

  const second = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(
    second.result.skips.some((s) => s.reason === "already_applied" && s.detail === "already_posted"),
    "reported as already posted",
  );
  assertEqual(db.all("journal_entries").length, 1, "only one entry was ever posted");
});

test("txn-post-coded: an uncoded transaction is skipped, not posted", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1", { categoryId: null, cascadeLevel: null, ruleId: null })]);

  const preview = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(
    preview.result.skips.some((s) => s.reason === "missing_prerequisite" && s.detail === "not_yet_coded"),
    "reported as not yet coded",
  );
});

for (const [label, override] of [
  ["suspense", { suspenseReason: "SUS-01" }],
  ["a transfer pair", { pairedWithId: "TX-OTHER" }],
  ["a settlement", { settlementOfTransactionId: "TX-GROSS" }],
  ["a recurring template", { templateId: "TPL-RENT", templateVersion: 1 }],
] as const) {
  test(`txn-post-coded: a transaction already claimed by ${label} is left alone`, async () => {
    const db = codingDb();
    db.seed("categories", standardCategories());
    db.seed("transactions", [ruleCodedTxn("TX-1", override)]);

    const preview = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
    assertEqual(preview.status, "no_op", "no_op");
    assert(
      preview.result.skips.some(
        (s) => s.reason === "already_applied" && s.detail === "posted_by_a_different_cascade_step",
      ),
      "reported as posted by a different cascade step",
    );
    assertEqual(db.all("journal_entries").length, 0, "nothing posted here");
  });
}

test("txn-post-coded: a transaction coded to an unknown category is refused", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1", { categoryId: "CAT-DOES-NOT-EXIST" })]);

  const preview = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "MISSING_ACCOUNT"),
    "named error code",
  );
});
