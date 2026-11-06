/**
 * Audit fix, 2026-11-05 (problem 1 of the external action audit). Chains
 * real runs together the way the audit itself ran the app, rather than
 * hand-seeding a transaction already carrying the field under test --
 * exactly the gap the audit named as the reason 1216 passing tests missed
 * this: a test that inserts data no real run would ever produce still
 * passes while the real chain is broken.
 *
 * TXN-SWEEP-SUSPENSE, TXN-PAIR-TRANSFERS, TXN-SPLIT-SETTLEMENTS, and
 * TXN-APPLY-RECURRING all post a journal entry for a transaction without
 * ever writing that entry's id back onto the row. TXN-VOID and TXN-RECODE
 * only reverse an existing entry when journalEntryId names one, so
 * voiding or recoding a row coded by any of those four found nothing to
 * reverse and (for recode) posted a second entry on top of the first,
 * double counting cash. The suspense case is the one the audit actually
 * ran end to end and reproduced; the other three are checked here the
 * same way, confirming journalEntryId lands on the entry each run itself
 * posted.
 */

import { isJournalEntry } from "../contract";
import type { TransactionRow } from "../tables";
import { CLIENT_A1, FIRM_A, scopeFor, txn } from "./fixtures";
import {
  applyCoding,
  clientPolicy,
  codingDb,
  settlementRow,
  split,
  standardCategories,
  template,
} from "./coding-fixtures";
import { txnSweepSuspense, suspenseEntryIdFor } from "../runs/txn-sweep-suspense";
import { txnPairTransfers, transferEntryIdFor } from "../runs/txn-pair-transfers";
import { txnSplitSettlements, settlementEntryIdFor } from "../runs/txn-split-settlements";
import { txnApplyRecurring, recurringMatchEntryIdFor } from "../runs/txn-apply-recurring";
import { txnVoid } from "../runs/txn-void";
import { txnRecode } from "../runs/txn-recode";
import { assert, assertEqual, show, test } from "./harness";

function balanceOf(db: ReturnType<typeof codingDb>, accountNumber: string): bigint {
  let total = BigInt(0);
  for (const l of db.all("journal_lines")) {
    if (l.accountNumber === accountNumber) total += l.amountCents;
  }
  return total;
}

function rowOf(db: ReturnType<typeof codingDb>, id: string): TransactionRow {
  return (db.all("transactions") as TransactionRow[]).find((t) => t.id === id)!;
}

test("audit fix: a suspense-coded transaction can actually be voided, cash and suspense both return to zero", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("transactions", [
    txn("TX-MYSTERY", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-4200), {
      normalizedVendor: "SOME PLACE",
    }),
  ]);

  await applyCoding(db, txnSweepSuspense, scopeFor(CLIENT_A1));
  const sweptRow = rowOf(db, "TX-MYSTERY");
  assertEqual(sweptRow.journalEntryId, suspenseEntryIdFor("TX-MYSTERY"), "the suspense entry's id is on the row");
  assertEqual(balanceOf(db, "1010"), BigInt(-4200), "the bank side posted");
  assertEqual(balanceOf(db, "1990"), BigInt(4200), "the whole amount sits in suspense");

  await applyCoding(db, txnVoid, { clientId: CLIENT_A1, transactionId: "TX-MYSTERY", reason: "duplicate entry" });

  assertEqual(balanceOf(db, "1010"), BigInt(0), "the bank side is back to zero, not left posted");
  assertEqual(balanceOf(db, "1990"), BigInt(0), "suspense actually clears instead of sitting there forever");
  const entries = db.all("journal_entries");
  assertEqual(entries.length, 2, "the original suspense entry plus its reversal, never a third stray entry");
});

test("audit fix: recoding a suspense-coded transaction reverses suspense and posts exactly one real entry, not two", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("transactions", [
    txn("TX-MYSTERY", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-4200), {
      normalizedVendor: "SOME PLACE",
    }),
  ]);

  await applyCoding(db, txnSweepSuspense, scopeFor(CLIENT_A1));
  assertEqual(balanceOf(db, "1990"), BigInt(4200), "starts in suspense");

  const { applied } = await applyCoding(db, txnRecode, {
    clientId: CLIENT_A1,
    transactionIds: ["TX-MYSTERY"],
    categoryId: "CAT-software",
    reason: "it was software all along",
  });
  assertEqual(applied.status, "completed", `status ${show(applied.status)}`);

  // The audit's whole point: before this fix, the bank side below would
  // read -8400 (the original suspense posting plus a second, fresh one),
  // not -4200. One real economic event must net to exactly one posting.
  assertEqual(balanceOf(db, "1010"), BigInt(-4200), "the bank side reflects the one real event, not two");
  assertEqual(balanceOf(db, "1990"), BigInt(0), "suspense cleared, reversed rather than left stranded");
  assertEqual(balanceOf(db, "6100"), BigInt(4200), "the corrected category took the expense, once");

  const row = rowOf(db, "TX-MYSTERY");
  assertEqual(row.categoryId, "CAT-software", "recoded to the named category");
  assert(row.journalEntryId !== suspenseEntryIdFor("TX-MYSTERY"), "points at the new posting, not the reversed one");
});

test("audit fix: a paired transfer leg carries its own posted entry's id on both sides", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [
    txn("TX-OUT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000)),
    txn("TX-IN", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-11", BigInt(25000)),
  ]);

  await applyCoding(db, txnPairTransfers, scopeFor(CLIENT_A1));

  assertEqual(rowOf(db, "TX-OUT").journalEntryId, transferEntryIdFor("TX-OUT"), "the outbound leg's own entry id");
  assertEqual(rowOf(db, "TX-IN").journalEntryId, transferEntryIdFor("TX-IN"), "the inbound leg's own entry id");

  // Confirms TXN-VOID can now find and reverse a paired leg at all -- before
  // this fix it found journalEntryId null and silently left the clearing
  // entry standing while marking the row voided. Each leg is its own
  // transaction with its own entry, so voiding only the outbound leg
  // correctly reverses only that leg's own posting (1920 nets to -25000,
  // the still-posted inbound leg) -- voiding both brings it back to zero.
  await applyCoding(db, txnVoid, { clientId: CLIENT_A1, transactionId: "TX-OUT", reason: "wrong account" });
  assertEqual(balanceOf(db, "1920"), BigInt(-25000), "only the outbound leg's own posting reversed, the inbound leg's is untouched");
  await applyCoding(db, txnVoid, { clientId: CLIENT_A1, transactionId: "TX-IN", reason: "wrong account" });
  assertEqual(balanceOf(db, "1920"), BigInt(0), "with both legs voided, the clearing account is back to zero");
});

test("audit fix: a split processor settlement carries its posted entry's id on the deposit", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("settlement_rows", [settlementRow("SET-1")]);
  db.seed("transactions", [
    txn("TX-DEP", FIRM_A, CLIENT_A1, "BA-A1-PROC", "2026-01-15", BigInt(97100), {
      accountNumber: "1910",
      description: "STRIPE TRANSFER PO-1",
      normalizedVendor: "TRANSFER PO 1",
    }),
  ]);

  await applyCoding(db, txnSplitSettlements, scopeFor(CLIENT_A1));

  assertEqual(rowOf(db, "TX-DEP").journalEntryId, settlementEntryIdFor("TX-DEP"), "the split entry's id is on the deposit");

  await applyCoding(db, txnVoid, { clientId: CLIENT_A1, transactionId: "TX-DEP", reason: "duplicate payout" });
  const entries = db.all("journal_entries");
  assertEqual(entries.length, 2, "the split entry plus its reversal, confirming void could find it at all");
});

test("audit fix: a recurring-matched transaction carries its posted entry's id", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [
    txn("TX-SUB", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-14", BigInt(-10000), {
      normalizedVendor: "GITHUB",
    }),
  ]);
  db.seed("recurring_templates", [template("TPL-1")]);
  db.seed("recurring_splits", [split("RS-1", "TPL-1", 1)]);

  await applyCoding(db, txnApplyRecurring, scopeFor(CLIENT_A1));

  assertEqual(rowOf(db, "TX-SUB").journalEntryId, recurringMatchEntryIdFor("TX-SUB"), "the template match's own entry id is on the row");

  await applyCoding(db, txnVoid, { clientId: CLIENT_A1, transactionId: "TX-SUB", reason: "cancelled subscription" });
  assertEqual(balanceOf(db, "1010"), BigInt(0), "the bank side reverses instead of sitting there permanently posted");
});
