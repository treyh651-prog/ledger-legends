/**
 * PER-SPLIT-LOANPAYMENT tests.
 *
 * The run turns one number on the bank register into the three or four numbers
 * the amortization schedule says it is made of. The rule that shapes most of
 * these tests is that it only does that for a payment the bank has confirmed,
 * and that any disagreement between the bank and the schedule goes to a person
 * rather than into interest expense.
 */

import { isSuspenseRouting } from "../contract";
import { canonicalJson, toJsonValue } from "../ids";
import { LOAN_SPLIT_SUSPENSE, perSplitLoan } from "../runs/per-split-loan";
import type { SuspenseItemRow, TransactionRow } from "../tables";
import { CLIENT_A1, FIRM_A, lock, txn } from "./fixtures";
import {
  applyPer,
  balanceOf,
  linesOf,
  loan,
  loanPayment,
  perDb,
  periodScope,
  previewPer,
  reasons,
  skippedFor,
  sumLines,
} from "./per-fixtures";
import { assert, assertEqual, show, test } from "./harness";

const payment = (
  id: string,
  postedDate: string,
  amountCents: bigint,
  extra: Parameters<typeof txn>[6] = {},
): TransactionRow =>
  txn(id, FIRM_A, CLIENT_A1, "BA-A1-OP", postedDate, amountCents, {
    cleared: true,
    description: "First Bank loan payment",
    ...extra,
  });

function seedLoan(db: ReturnType<typeof perDb>): void {
  db.seed("loans", [loan("LN-1")]);
  db.seed("loan_schedule", [loanPayment("LS-1", "LN-1")]);
}

function schedule(db: ReturnType<typeof perDb>, id: string) {
  const row = db.all("loan_schedule").find((r) => r.id === id);
  if (row === undefined) throw new Error(`schedule row ${id} not found`);
  return row;
}

test("per loan split, a cleared payment splits into principal, interest, and cash", async () => {
  const db = perDb();
  seedLoan(db);
  db.seed("transactions", [payment("TX-PMT", "2026-01-15", BigInt(-100000))]);

  const { applied } = await applyPer(db, perSplitLoan, periodScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );

  const entries = db.all("journal_entries");
  assertEqual(entries.length, 1, "one entry");
  assertEqual(entries[0].entryDate, "2026-01-15", "dated the day it cleared");
  const own = linesOf(db, entries[0].id);
  assertEqual(own.length, 3, "principal, interest, and the cash credit");
  assertEqual(sumLines(own), BigInt(0), "the entry balances");
  assertEqual(balanceOf(db, "2750"), BigInt(60000), "the note came down by principal");
  assertEqual(balanceOf(db, "8100"), BigInt(40000), "interest expense took the rest");
  assertEqual(balanceOf(db, "1010"), BigInt(-100000), "and cash paid the whole payment");

  const row = schedule(db, "LS-1");
  assertEqual(row.status, "posted", "the schedule row is posted");
  assertEqual(row.matchedTransactionId, "TX-PMT", "and points at the register row");
  const register = db.all("transactions").find((t) => t.id === "TX-PMT");
  assertEqual(register?.journalEntryId, entries[0].id, "the register points back");
});

test("per loan split, escrow and fees ride on the same entry", async () => {
  const db = perDb();
  db.seed("loans", [loan("LN-E", { escrowAccount: "1310" })]);
  db.seed("loan_schedule", [
    loanPayment("LS-E", "LN-E", {
      paymentCents: BigInt(120000),
      principalCents: BigInt(60000),
      interestCents: BigInt(40000),
      escrowCents: BigInt(15000),
      feesCents: BigInt(5000),
    }),
  ]);
  db.seed("transactions", [payment("TX-E", "2026-01-15", BigInt(-120000))]);

  await applyPer(db, perSplitLoan, periodScope());
  const entries = db.all("journal_entries");
  assertEqual(entries.length, 1, "one entry");
  const own = linesOf(db, entries[0].id);
  assertEqual(own.length, 5, "principal, interest, escrow, fees, and cash");
  assertEqual(sumLines(own), BigInt(0), "and it still balances");
  assertEqual(balanceOf(db, "1310"), BigInt(15000), "escrow was funded");
  assertEqual(balanceOf(db, "8100"), BigInt(45000), "fees sit with interest");
});

test("per loan split, a payment the bank has not confirmed is skipped", async () => {
  const db = perDb();
  seedLoan(db);
  db.seed("transactions", [
    payment("TX-PEND", "2026-01-15", BigInt(-100000), { cleared: false }),
  ]);
  const preview = await previewPer(db, perSplitLoan, periodScope());
  assert(
    skippedFor(preview, "LS-1", "missing_prerequisite"),
    `expected a skip, got ${show(reasons(preview))}`,
  );
  assert(
    preview.result.skips.some((s) => s.detail.includes("payment_not_cleared")),
    `expected the not cleared reason, got ${show(preview.result.skips.map((s) => s.detail))}`,
  );
  assertEqual(preview.result.proposals.length, 0, "nothing was posted");
});

test("per loan split, no register row at all is a different skip reason", async () => {
  const db = perDb();
  seedLoan(db);
  const preview = await previewPer(db, perSplitLoan, periodScope());
  assert(
    preview.result.skips.some((s) => s.detail.includes("no_payment_on_register")),
    `expected no payment, got ${show(preview.result.skips.map((s) => s.detail))}`,
  );
});

test("per loan split, a bank amount that differs from the schedule goes to suspense", async () => {
  const db = perDb();
  seedLoan(db);
  // The rate reset and the bank took two dollars more than the schedule says.
  db.seed("transactions", [payment("TX-VAR", "2026-01-15", BigInt(-100200))]);

  const { applied } = await applyPer(db, perSplitLoan, periodScope());
  assertEqual(db.all("journal_entries").length, 0, "nothing was posted");
  const items = db.all("suspense_items") as SuspenseItemRow[];
  assertEqual(items.length, 1, "one suspense item");
  assertEqual(items[0].reasonCode, LOAN_SPLIT_SUSPENSE.amountVariance, "SUS-14");
  assert(
    skippedFor(applied, "LS-1", "ambiguous_candidate"),
    `expected ambiguous, got ${show(reasons(applied))}`,
  );
  assertEqual(schedule(db, "LS-1").status, "scheduled", "the row waits for a person");
});

test("per loan split, two candidate rows are routed rather than chosen between", async () => {
  const db = perDb();
  seedLoan(db);
  db.seed("transactions", [
    payment("TX-A", "2026-01-15", BigInt(-100000)),
    payment("TX-B", "2026-01-16", BigInt(-100000)),
  ]);
  const { applied } = await applyPer(db, perSplitLoan, periodScope());
  assertEqual(db.all("journal_entries").length, 0, "the run declined to guess");
  const routed = applied.result.proposals.filter(isSuspenseRouting);
  assertEqual(routed.length, 1, "one routing");
  assertEqual(routed[0].reasonCode, "SUS-14", "carrying the variance code");
  assert(
    skippedFor(applied, "LS-1", "ambiguous_candidate"),
    `expected ambiguous, got ${show(reasons(applied))}`,
  );
});

test("per loan split, a schedule row that does not foot posts nothing and is reported", async () => {
  const db = perDb();
  db.seed("loans", [loan("LN-B")]);
  db.seed("loan_schedule", [
    loanPayment("LS-B", "LN-B", {
      paymentCents: BigInt(100000),
      principalCents: BigInt(60000),
      interestCents: BigInt(30000),
    }),
  ]);
  db.seed("transactions", [payment("TX-B", "2026-01-15", BigInt(-100000))]);
  const preview = await previewPer(db, perSplitLoan, periodScope());
  assert(
    preview.result.errors.some(
      (e) => e.code === "PER_LOAN_COMPONENTS_DO_NOT_FOOT",
    ),
    `expected the footing error, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
  const routed = preview.result.proposals.filter(isSuspenseRouting);
  assertEqual(routed.length, 1, "and a routing so a person sees it");
  assertEqual(routed[0].reasonCode, LOAN_SPLIT_SUSPENSE.balanceVariance, "SUS-17");
  assertEqual(preview.status, "refused", "the run refuses on an error");
});

test("per loan split, a balance the schedule contradicts posts and reports the variance", async () => {
  const db = perDb();
  db.seed("loans", [loan("LN-V")]);
  db.seed("loan_schedule", [
    // The split itself foots. The running balance column does not.
    loanPayment("LS-V", "LN-V", { balanceAfterCents: BigInt(930000) }),
  ]);
  db.seed("transactions", [payment("TX-V", "2026-01-15", BigInt(-100000))]);

  const { applied } = await applyPer(db, perSplitLoan, periodScope());
  assertEqual(db.all("journal_entries").length, 1, "the split still posted");
  const items = db.all("suspense_items") as SuspenseItemRow[];
  assertEqual(items.length, 1, "and the disagreement was reported");
  assertEqual(items[0].reasonCode, LOAN_SPLIT_SUSPENSE.balanceVariance, "SUS-17");
  assertEqual(
    sumLines(db.all("journal_lines")),
    BigInt(0),
    "no correcting entry was invented, so the books still foot",
  );
});

test("per loan split, the same period twice splits once", async () => {
  const db = perDb();
  seedLoan(db);
  db.seed("transactions", [payment("TX-PMT", "2026-01-15", BigInt(-100000))]);
  await applyPer(db, perSplitLoan, periodScope());
  const second = await applyPer(db, perSplitLoan, periodScope());
  assertEqual(db.all("journal_entries").length, 1, "still one entry");
  assert(
    skippedFor(second.preview, "LS-1", "already_applied"),
    `expected already_applied, got ${show(reasons(second.preview))}`,
  );
});

test("per loan split, an override anywhere in the chain stops the write", async () => {
  const db = perDb();
  db.seed("loans", [loan("LN-1"), loan("LN-2", { manualOverride: true })]);
  db.seed("loan_schedule", [
    loanPayment("LS-OVR", "LN-1", { manualOverride: true }),
    loanPayment("LS-LOAN", "LN-2", { paymentNumber: 2 }),
    loanPayment("LS-TXN", "LN-1", { paymentNumber: 3 }),
  ]);
  db.seed("transactions", [
    payment("TX-1", "2026-01-15", BigInt(-100000), { manualOverride: true }),
  ]);
  const { applied } = await applyPer(db, perSplitLoan, periodScope());
  assert(skippedFor(applied, "LS-OVR", "manual_override"), "the schedule row");
  assert(skippedFor(applied, "LS-LOAN", "manual_override"), "the loan");
  assert(skippedFor(applied, "LS-TXN", "manual_override"), "the register row");
  assertEqual(db.all("journal_entries").length, 0, "and nothing posted");
});

test("per loan split, a locked clearing day is skipped and never thrown", async () => {
  const db = perDb();
  seedLoan(db);
  db.seed("transactions", [payment("TX-PMT", "2026-01-15", BigInt(-100000))]);
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await applyPer(db, perSplitLoan, periodScope());
  assert(
    skippedFor(applied, "LS-1", "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "nothing reached the books");
});

test("per loan split, a payment that cleared a few days late is still that payment", async () => {
  const db = perDb();
  seedLoan(db);
  db.seed("transactions", [payment("TX-LATE", "2026-01-19", BigInt(-100000))]);
  const preview = await previewPer(db, perSplitLoan, periodScope());
  assertEqual(preview.result.proposals.length > 0, true, "it matched");
  const far = perDb();
  seedLoan(far);
  far.seed("transactions", [payment("TX-FAR", "2026-01-25", BigInt(-100000))]);
  const missed = await previewPer(far, perSplitLoan, periodScope());
  assertEqual(missed.result.proposals.length, 0, "ten days away is a different row");
});

test("per loan split, preview equals apply", async () => {
  const db = perDb();
  seedLoan(db);
  db.seed("transactions", [payment("TX-PMT", "2026-01-15", BigInt(-100000))]);
  const { preview, applied } = await applyPer(db, perSplitLoan, periodScope());
  assertEqual(
    canonicalJson(toJsonValue(preview.result.proposals)),
    canonicalJson(toJsonValue(applied.result.proposals)),
    "the same proposals",
  );
});
