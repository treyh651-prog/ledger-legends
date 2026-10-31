/**
 * TXN-VOID-AND-REISSUE tests. The original voids and reverses the same way
 * TXN-VOID does, a corrected replacement appears carrying the original's
 * coding forward, and that replacement gets posted by TXN-POST-CODED on its
 * own next run with no special casing. A reissue with nothing actually
 * corrected is refused, and reissuing twice is a no op the second time.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { isFieldWrite, isJournalEntry } from "../contract";
import { CLIENT_A1, FIRM_A, opts, scopeFor, txn } from "./fixtures";
import { codingDb, standardCategories } from "./coding-fixtures";
import { txnPostCoded, postedEntryIdFor } from "../runs/txn-post-coded";
import { txnVoidAndReissue, reissuedTransactionIdFor } from "../runs/txn-void-and-reissue";
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

function reissueScope(
  transactionId: string,
  corrections: Record<string, unknown>,
  reason = "wrong amount keyed in",
) {
  return { clientId: CLIENT_A1, transactionId, reason, corrections };
}

test("txn-void-and-reissue: a posted transaction voids, reverses, and a corrected replacement appears", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1")]);
  const postPreview = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("apply", { previewRunId: postPreview.executionId }));

  const scope = reissueScope("TX-1", { amountCents: -7500 });
  const preview = await execute(db, txnVoidAndReissue, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, txnVoidAndReissue, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  assertEqual(applied.result.proposals.filter(isJournalEntry).length, 1, "the original entry reversed");

  const newId = reissuedTransactionIdFor("TX-1");
  const rows = db.all("transactions") as TransactionRow[];
  const original = rows.find((t) => t.id === "TX-1");
  const reissued = rows.find((t) => t.id === newId);

  assertEqual(original?.voided, true, "original voided");
  assertEqual(original?.status, "reversed", "original status reversed");
  assertEqual(original?.voidOfTransactionId, newId, "original points forward at the replacement");

  assert(reissued !== undefined, "the replacement row exists");
  assertEqual(reissued?.amountCents, BigInt(-7500), "the corrected amount");
  assertEqual(reissued?.postedDate, "2026-01-15", "the uncorrected date carried over");
  assertEqual(reissued?.reissueOfTransactionId, "TX-1", "pointing back at the original");
  assertEqual(reissued?.categoryId, "CAT-software", "coding carried forward");
  assertEqual(reissued?.cascadeLevel, 6, "cascade level carried forward");
  assertEqual(reissued?.ruleId, "RULE-1", "rule provenance carried forward");
  assertEqual(reissued?.journalEntryId, null, "not posted yet");
  assertEqual(reissued?.voided, false, "the replacement starts unvoided");
  assertEqual(reissued?.status, "active", "the replacement starts active");
  assertEqual(reissued?.version, 1, "a fresh row starts at version 1");
});

test("txn-void-and-reissue: the replacement gets posted on TXN-POST-CODED's own next run", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1")]);
  const postPreview = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("apply", { previewRunId: postPreview.executionId }));

  const scope = reissueScope("TX-1", { amountCents: -7500 });
  const preview = await execute(db, txnVoidAndReissue, scope, opts("preview"));
  await execute(db, txnVoidAndReissue, scope, opts("apply", { previewRunId: preview.executionId }));

  const secondPostPreview = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  // completed_with_skips, not completed: the voided original is still in the
  // candidate window and is skipped as already posted (its journalEntryId
  // was never cleared, only reversed), alongside the one real proposal that
  // posts the fresh replacement.
  assertEqual(secondPostPreview.status, "completed_with_skips", "the replacement is a fresh candidate to post");
  assertEqual(
    secondPostPreview.result.proposals.filter(isJournalEntry).length,
    1,
    "exactly one new entry, for the replacement",
  );
  await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("apply", { previewRunId: secondPostPreview.executionId }));

  const newId = reissuedTransactionIdFor("TX-1");
  const reissued = (db.all("transactions") as TransactionRow[]).find((t) => t.id === newId);
  assertEqual(reissued?.journalEntryId, postedEntryIdFor(newId), "posted with no code change to TXN-POST-CODED");
});

test("txn-void-and-reissue: an unposted transaction reissues with just a field write and an insert, no journal entry", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1", { categoryId: null, cascadeLevel: null, ruleId: null })]);

  const scope = reissueScope("TX-1", { description: "corrected memo" });
  const preview = await execute(db, txnVoidAndReissue, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  assertEqual(preview.result.proposals.filter(isJournalEntry).length, 0, "nothing to reverse, never posted");
  assertEqual(preview.result.proposals.filter(isFieldWrite).length, 1, "one field write on the original");
});

test("txn-void-and-reissue: nothing actually corrected is refused", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1")]);

  const scope = reissueScope("TX-1", { amountCents: -5000 });
  const preview = await execute(db, txnVoidAndReissue, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "TXN_REISSUE_NO_CHANGE"),
    "named error code",
  );
});

test("txn-void-and-reissue: reissuing an already voided transaction is a no op the second time", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [ruleCodedTxn("TX-1")]);

  const scope = reissueScope("TX-1", { amountCents: -7500 });
  const preview = await execute(db, txnVoidAndReissue, scope, opts("preview"));
  await execute(db, txnVoidAndReissue, scope, opts("apply", { previewRunId: preview.executionId }));

  const second = await execute(db, txnVoidAndReissue, reissueScope("TX-1", { amountCents: -8000 }), opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(
    second.result.skips.some((s) => s.reason === "already_applied" && s.detail === "already voided or reissued"),
    "reported as already voided or reissued",
  );
});
