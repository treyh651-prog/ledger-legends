/**
 * AP-APPLY-PAYMENTS. The payable mirror of ar-apply-payments.ts's own test
 * file, same four tiers, same questions: does a payment reach the right
 * bills, does a multi bill remittance sum to the payment inside the stated
 * tolerance, does an ambiguous case refuse rather than guess, and does the
 * entry move exactly the cash that left and nothing else. Plus the one
 * genuinely new behavior this round adds: the AP control line each
 * allocation credits is tagged cash, dated the payment date, pointing
 * cashSourceLine at the bill's own expense line.
 */

import { apApplyPayments } from "../runs/ap-apply-payments";
import type { BillApplicationRow, BillRow, JournalLineRow, VendorPaymentRow } from "../tables";
import type { MemoryRunDb } from "../db-memory";
import { isJournalEntry } from "../contract";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  applyArap,
  arapDb,
  arapScope,
  arEntry,
  arLine,
  balanceOf,
  bill,
  previewArap,
  reasons,
  skipDetail,
  skippedFor,
  sumLines,
  vendor,
  vendorPayment,
  vendorRemittance,
} from "./arap-fixtures";
import { assert, assertEqual, show, test } from "./harness";

function billRow(db: MemoryRunDb, id: string): BillRow {
  return (db.all("bills") as BillRow[]).find((b) => b.id === id) as BillRow;
}

function paymentRow(db: MemoryRunDb, id: string): VendorPaymentRow {
  return (db.all("vendor_payments") as VendorPaymentRow[]).find(
    (p) => p.id === id,
  ) as VendorPaymentRow;
}

function applications(db: MemoryRunDb): BillApplicationRow[] {
  return db.all("bill_applications") as BillApplicationRow[];
}

/** Two open bills, the older one for 300.00 and the newer for 700.00. */
function seedTwo(db: MemoryRunDb): void {
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [
    bill("BILL-OLD", "VEN-1", {
      billDate: "2025-11-01",
      dueDate: "2025-12-01",
      originalAmountCents: BigInt(30000),
    }),
    bill("BILL-NEW", "VEN-1", {
      billDate: "2025-12-11",
      dueDate: "2026-01-10",
      originalAmountCents: BigInt(70000),
    }),
  ]);
}

test("ap payments, tier 4 applies oldest first", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("vendor_payments", [
    vendorPayment("PAY-1", "VEN-1", { amountCents: BigInt(50000) }),
  ]);
  const { applied } = await applyArap(db, apApplyPayments, arapScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}, reasons ${show(reasons(applied))}`,
  );
  assertEqual(
    billRow(db, "BILL-OLD").paidCents,
    BigInt(30000),
    "the older bill was cleared first",
  );
  assertEqual(billRow(db, "BILL-OLD").status, "paid", "and is marked paid");
  assertEqual(
    billRow(db, "BILL-NEW").paidCents,
    BigInt(20000),
    "the remainder went to the newer one",
  );
  assertEqual(billRow(db, "BILL-NEW").status, "posted", "which stays open");
  assertEqual(paymentRow(db, "PAY-1").appliedTier, 4, "tier 4 resolved it");
  assertEqual(paymentRow(db, "PAY-1").status, "applied", "fully applied");
});

test("ap payments, the entry moves the clearing account to the control account", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("vendor_payments", [
    vendorPayment("PAY-1", "VEN-1", { amountCents: BigInt(50000) }),
  ]);
  const { applied } = await applyArap(db, apApplyPayments, arapScope());
  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries.length, 1, "one entry for one payment");
  assertEqual(
    sumLines(db.all("journal_lines")),
    BigInt(0),
    "the books still foot",
  );
  assertEqual(balanceOf(db, "1910"), BigInt(-50000), "clearing takes the credit");
  assertEqual(balanceOf(db, "2000"), BigInt(50000), "control takes the debit");
});

test("ap payments, the control lines are tagged cash at the payment date", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [bill("BILL-1", "VEN-1", { originalAmountCents: BigInt(50000) })]);
  // The posted bill entry AP-CREATE-BILL would have made: its id is the
  // bill's own id, debit expense, credit AP control.
  db.seed("journal_entries", [arEntry("BILL-1", "2026-01-05", { sourceTable: "bills" })]);
  db.seed("journal_lines", [
    arLine("JL-BILL-1-EXP", "BILL-1", "6100", BigInt(50000), "2026-01-05"),
    arLine("JL-BILL-1-AP", "BILL-1", "2000", BigInt(-50000), "2026-01-05"),
  ]);
  db.seed("vendor_payments", [
    vendorPayment("PAY-1", "VEN-1", { amountCents: BigInt(50000), paymentDate: "2026-01-25" }),
  ]);
  await applyArap(db, apApplyPayments, arapScope());
  const lines = db.all("journal_lines") as JournalLineRow[];
  const controlLine = lines.find(
    (l) => l.accountNumber === "2000" && l.entryId !== "BILL-1",
  );
  assert(controlLine !== undefined, "the control line posted");
  assertEqual(controlLine?.cashEffect, "cash", "tagged cash, not the generic accrual_only a payable block would otherwise get");
  assertEqual(controlLine?.cashEventDate, "2026-01-25", "dated the payment date, not the bill date");
  const expenseLine = lines.find(
    (l) => l.entryId === "BILL-1" && l.accountNumber === "6100",
  );
  assertEqual(controlLine?.cashSourceLine, expenseLine?.id, "pointing at the bill's own expense line");
});

test("ap payments, tier 2 follows a match hint naming one bill", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("vendor_payments", [
    vendorPayment("PAY-1", "VEN-1", {
      amountCents: BigInt(30000),
      matchHint: "BILL-NEW",
    }),
  ]);
  await applyArap(db, apApplyPayments, arapScope());
  assertEqual(
    billRow(db, "BILL-OLD").paidCents,
    BigInt(0),
    "the older bill was left alone",
  );
  assertEqual(
    billRow(db, "BILL-NEW").paidCents,
    BigInt(30000),
    "the named bill took it",
  );
  assertEqual(paymentRow(db, "PAY-1").appliedTier, 2, "tier 2 resolved it");
});

test("ap payments, tier 1 splits a multi bill remittance", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("vendor_payments", [
    vendorPayment("PAY-1", "VEN-1", { amountCents: BigInt(100000) }),
  ]);
  db.seed("vendor_remittance_lines", [
    vendorRemittance("REM-1", "PAY-1", 1, "BILL-OLD", BigInt(30000)),
    vendorRemittance("REM-2", "PAY-1", 2, "BILL-NEW", BigInt(70000)),
  ]);
  await applyArap(db, apApplyPayments, arapScope());
  assertEqual(
    billRow(db, "BILL-OLD").paidCents,
    BigInt(30000),
    "the advice split it",
  );
  assertEqual(
    billRow(db, "BILL-NEW").paidCents,
    BigInt(70000),
    "line by line",
  );
  assertEqual(paymentRow(db, "PAY-1").appliedTier, 1, "tier 1 resolved it");
  assertEqual(applications(db).length, 2, "one application row per bill");
  assert(
    applications(db).every((a) => a.tier === 1),
    "and each records the tier",
  );
});

test("ap payments, a remittance well out of tolerance is refused", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("vendor_payments", [
    vendorPayment("PAY-1", "VEN-1", { amountCents: BigInt(90000) }),
  ]);
  db.seed("vendor_remittance_lines", [
    vendorRemittance("REM-1", "PAY-1", 1, "BILL-OLD", BigInt(30000)),
    vendorRemittance("REM-2", "PAY-1", 2, "BILL-NEW", BigInt(70000)),
  ]);
  const preview = await previewArap(db, apApplyPayments, arapScope());
  assert(
    skippedFor(preview, "PAY-1", "ambiguous_candidate"),
    `expected ambiguous_candidate, got ${show(reasons(preview))}`,
  );
  assert(
    skipDetail(preview, "PAY-1", "remittance_sum_mismatch"),
    "and it says which check failed",
  );
  assertEqual(preview.result.proposals.length, 0, "nothing was proposed");
});

test("ap payments, an ambiguous combination refuses rather than guesses", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  // Two bills of the same amount, so 500.00 could be either one.
  db.seed("bills", [
    bill("BILL-A", "VEN-1", {
      billDate: "2025-11-01",
      dueDate: "2025-12-01",
      originalAmountCents: BigInt(50000),
    }),
    bill("BILL-B", "VEN-1", {
      billDate: "2025-11-02",
      dueDate: "2025-12-02",
      originalAmountCents: BigInt(50000),
    }),
  ]);
  db.seed("vendor_payments", [
    vendorPayment("PAY-1", "VEN-1", { amountCents: BigInt(50000) }),
  ]);
  const preview = await previewArap(db, apApplyPayments, arapScope());
  assert(
    skipDetail(preview, "PAY-1", "combination_not_unique"),
    `expected combination_not_unique, got ${show(reasons(preview))}`,
  );
  assertEqual(preview.result.proposals.length, 0, "nothing was applied");
});

test("ap payments, an overpayment applies what it can and leaves the rest unapplied", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [bill("BILL-1", "VEN-1")]);
  db.seed("vendor_payments", [
    vendorPayment("PAY-1", "VEN-1", { amountCents: BigInt(150000) }),
  ]);
  await applyArap(db, apApplyPayments, arapScope());
  assertEqual(
    billRow(db, "BILL-1").paidCents,
    BigInt(100000),
    "the bill took its own balance and no more",
  );
  const pay = paymentRow(db, "PAY-1");
  assertEqual(pay.appliedCents, BigInt(100000), "and the payment says so");
  assertEqual(pay.status, "partially_applied", "the rest stays unapplied");
  assertEqual(balanceOf(db, "1910"), BigInt(-100000), "only what was applied");
});

test("ap payments, a second run applies nothing twice", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("vendor_payments", [
    vendorPayment("PAY-1", "VEN-1", { amountCents: BigInt(30000) }),
  ]);
  await applyArap(db, apApplyPayments, arapScope());
  const first = balanceOf(db, "2000");
  const second = await previewArap(db, apApplyPayments, arapScope());
  assertEqual(second.result.proposals.length, 0, "nothing left to apply");
  assert(
    skippedFor(second, "PAY-1", "already_applied"),
    `expected already_applied, got ${show(reasons(second))}`,
  );
  assertEqual(balanceOf(db, "2000"), first, "and the control did not move");
});

test("ap payments, an overridden payment or bill is never touched", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [
    bill("BILL-LOCK", "VEN-1", {
      manualOverride: true,
      billDate: "2025-11-01",
      dueDate: "2025-12-01",
    }),
    bill("BILL-OK", "VEN-1", { originalAmountCents: BigInt(20000) }),
  ]);
  db.seed("vendor_payments", [
    vendorPayment("PAY-OVR", "VEN-1", {
      amountCents: BigInt(10000),
      manualOverride: true,
    }),
    vendorPayment("PAY-OK", "VEN-1", { amountCents: BigInt(20000) }),
  ]);
  const { applied } = await applyArap(db, apApplyPayments, arapScope());
  assert(
    skippedFor(applied, "PAY-OVR", "manual_override"),
    `expected manual_override, got ${show(reasons(applied))}`,
  );
  assertEqual(
    billRow(db, "BILL-LOCK").paidCents,
    BigInt(0),
    "the overridden bill was never allocated to",
  );
  assertEqual(
    billRow(db, "BILL-OK").paidCents,
    BigInt(20000),
    "and the ordinary one still worked",
  );
});

test("ap payments, a locked payment date posts nothing", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("vendor_payments", [
    vendorPayment("PAY-1", "VEN-1", { amountCents: BigInt(30000) }),
  ]);
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await applyArap(db, apApplyPayments, arapScope());
  assert(
    skippedFor(applied, "PAY-1", "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "nothing posted");
});

test("ap payments, a payment on hold waits for a person", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("vendor_payments", [
    vendorPayment("PAY-1", "VEN-1", { amountCents: BigInt(30000), onHold: true }),
  ]);
  const preview = await previewArap(db, apApplyPayments, arapScope());
  assert(
    skipDetail(preview, "PAY-1", "payment_on_hold"),
    `expected payment_on_hold, got ${show(reasons(preview))}`,
  );
});

test("ap payments, two payments in one run cannot consume the same balance", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [bill("BILL-1", "VEN-1")]);
  db.seed("vendor_payments", [
    vendorPayment("PAY-A", "VEN-1", {
      amountCents: BigInt(60000),
      paymentDate: "2026-01-15",
    }),
    vendorPayment("PAY-B", "VEN-1", {
      amountCents: BigInt(60000),
      paymentDate: "2026-01-20",
    }),
  ]);
  await applyArap(db, apApplyPayments, arapScope());
  assertEqual(
    billRow(db, "BILL-1").paidCents,
    BigInt(100000),
    "the bill never took more than it was owed",
  );
  assertEqual(balanceOf(db, "2000"), BigInt(100000), "and the control agrees");
});
