/**
 * TXN-SPLIT-SETTLEMENTS tests. Cascade step 4.
 *
 * Three things are covered:
 *   1. Happy path. One net deposit plus one settlement report row becomes one
 *      balanced entry that debits the bank for the net, debits the fee category
 *      for the fee, and credits revenue for the gross.
 *   2. Skip path. A deposit already split is skipped with the reason recorded,
 *      and a report row with no deposit against it is reported as awaiting the
 *      bank rather than posted on faith.
 *   3. Ordering. This run comes before TXN-APPLY-RULES. Left to itself a rule on
 *      the processor descriptor would code the net deposit straight to revenue,
 *      understating sales by the fee. In the documented order the split happens
 *      first and the rule step then leaves the row alone.
 */

import { isJournalEntry, isSuspenseRouting } from "../contract";
import type { SettlementRowRow, SuspenseItemRow, TransactionRow } from "../tables";
import { txnApplyRules } from "../runs/txn-apply-rules";
import {
  SUS_AMOUNT_DISAGREES,
  SUS_NOT_SETTLED,
  txnSplitSettlements,
} from "../runs/txn-split-settlements";
import { CLIENT_A1, FIRM_A, scopeFor, txn } from "./fixtures";
import {
  applyCoding,
  clientPolicy,
  codingDb,
  previewCoding,
  rule,
  settlementRow,
  skipDetails,
  skippedFor,
  standardCategories,
} from "./coding-fixtures";
import { assert, assertEqual, show, test } from "./harness";

/** A 1000.00 gross day, a 29.00 fee, and a 971.00 wire into the processor account. */
function seedPayout(db: ReturnType<typeof codingDb>): void {
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
}

test("split settlements, happy path splits the net deposit into gross and fees", async () => {
  const db = codingDb();
  seedPayout(db);

  const { applied } = await applyCoding(db, txnSplitSettlements, scopeFor(CLIENT_A1));
  assertEqual(applied.status, "completed", `status ${show(applied.status)}`);

  const entries = db.all("journal_entries");
  assertEqual(entries.length, 1, "one entry per matched payout");
  const lines = db.all("journal_lines");
  assertEqual(lines.length, 3, "bank, fee, revenue");

  let net = BigInt(0);
  for (const l of lines) net += l.amountCents;
  assertEqual(net, BigInt(0), "the entry balances to exactly zero");

  const bank = lines.find((l) => l.accountNumber === "1910");
  const fee = lines.find((l) => l.accountNumber === "6110");
  const revenue = lines.find((l) => l.accountNumber === "4000");
  assertEqual(bank?.amountCents, BigInt(97100), "the bank sees the net it received");
  assertEqual(fee?.amountCents, BigInt(2900), "the fee is a debit at its absolute value");
  assertEqual(
    revenue?.amountCents,
    BigInt(-100000),
    "and revenue is credited the gross, not the net",
  );

  const row = (db.all("transactions") as TransactionRow[])[0];
  assertEqual(row.isProcessorSettlement, true, "the deposit is marked as split");
  assertEqual(row.cascadeLevel, 4, "at cascade level 4");
  const report = (db.all("settlement_rows") as SettlementRowRow[])[0];
  assertEqual(
    report.matchedTransactionId,
    "TX-DEP",
    "and the report row records which deposit consumed it",
  );
});

test("split settlements, a report that does not add up posts nothing and routes SUS-17", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("settlement_rows", [
    settlementRow("SET-BAD", { grossCents: BigInt(100000), feeCents: BigInt(-2900), netCents: BigInt(97000) }),
  ]);
  db.seed("transactions", [
    txn("TX-DEP", FIRM_A, CLIENT_A1, "BA-A1-PROC", "2026-01-15", BigInt(97000), {
      accountNumber: "1910",
      description: "STRIPE TRANSFER PO-1",
      normalizedVendor: "TRANSFER PO 1",
    }),
  ]);

  const { applied } = await applyCoding(db, txnSplitSettlements, scopeFor(CLIENT_A1));
  assertEqual(db.all("journal_entries").length, 0, "arithmetic that fails posts nothing");
  const items = db.all("suspense_items") as SuspenseItemRow[];
  assertEqual(items.length, 1, "one routing");
  assertEqual(items[0].reasonCode, SUS_AMOUNT_DISAGREES, "the amounts disagree");
  assertEqual(
    applied.result.proposals.filter(isSuspenseRouting).length,
    1,
    "it was a proposal, not a skip, so the partition holds",
  );
});

test("split settlements, a processor deposit with no report routes SUS-12", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("transactions", [
    txn("TX-DEP", FIRM_A, CLIENT_A1, "BA-A1-PROC", "2026-01-15", BigInt(97100), {
      accountNumber: "1910",
      normalizedVendor: "STRIPE PAYOUT",
    }),
  ]);
  const preview = await previewCoding(db, txnSplitSettlements, scopeFor(CLIENT_A1));
  const routings = preview.result.proposals.filter(isSuspenseRouting);
  assertEqual(routings.length, 1, "one routing");
  assertEqual(routings[0].reasonCode, SUS_NOT_SETTLED, "system owned, clears on rerun");
});

test("split settlements, skip path records an already split deposit and a waiting report", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("settlement_rows", [
    settlementRow("SET-WAITING", { payoutId: "PO-2", batchReference: "PO-2" }),
  ]);
  db.seed("transactions", [
    txn("TX-DONE", FIRM_A, CLIENT_A1, "BA-A1-PROC", "2026-01-15", BigInt(97100), {
      accountNumber: "1910",
      normalizedVendor: "STRIPE PAYOUT",
      isProcessorSettlement: true,
    }),
    txn("TX-NOTPROC", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-16", BigInt(5000), {
      normalizedVendor: "CLIENT DEPOSIT",
    }),
  ]);

  const preview = await previewCoding(db, txnSplitSettlements, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "nothing to split");
  assert(
    skippedFor(preview, "TX-DONE", "already_applied"),
    `expected already_applied, got ${show(skipDetails(preview, "TX-DONE"))}`,
  );
  assertEqual(
    skipDetails(preview, "TX-DONE")[0],
    "already_applied:settlement_already_split",
    "the detail names the reason a rerun does not post the gross twice",
  );
  assert(
    skippedFor(preview, "TX-NOTPROC", "out_of_scope_engagement"),
    "a deposit into an ordinary bank account is not this run's business",
  );
  assert(
    skippedFor(preview, "SET-WAITING", "missing_prerequisite"),
    `expected the report row to wait, got ${show(skipDetails(preview, "SET-WAITING"))}`,
  );
  assert(
    skipDetails(preview, "SET-WAITING")[0].includes("awaiting_bank_deposit"),
    "and the detail says it is waiting on the bank",
  );
});

test("split settlements, ordering, a rule may not code the net deposit as revenue", async () => {
  const seed = (): ReturnType<typeof codingDb> => {
    const db = codingDb();
    seedPayout(db);
    // A perfectly reasonable rule that is nonetheless wrong on this row, because
    // the deposit is the net and revenue is the gross.
    db.seed("rules", [
      rule("RULE-STRIPE", {
        conditions: [{ type: "vendor_prefix", value: "TRANSFER" }],
        targetCategoryId: "CAT-sales",
      }),
    ]);
    return db;
  };

  // Rules first, which is the wrong order. The rule codes the net as revenue.
  const outOfOrder = seed();
  const early = await previewCoding(outOfOrder, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(early.result.proposals.length, 1, "the rule would happily fire");

  // Documented order. Split first, then rules, and the rule now stands down.
  const inOrder = seed();
  await applyCoding(inOrder, txnSplitSettlements, scopeFor(CLIENT_A1));
  const late = await previewCoding(inOrder, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(late.result.proposals.length, 0, "the rule step proposes nothing");
  assertEqual(
    skipDetails(late, "TX-DEP")[0],
    "already_applied:already_resolved_level_4",
    "and it records that level 4 already decided the row",
  );
  const grossLine = inOrder
    .all("journal_lines")
    .find((l) => l.accountNumber === "4000");
  assertEqual(
    grossLine?.amountCents,
    BigInt(-100000),
    "so revenue still carries the gross rather than the net",
  );
  assert(
    late.result.proposals.filter(isJournalEntry).length === 0,
    "and nothing was posted a second time",
  );
});
