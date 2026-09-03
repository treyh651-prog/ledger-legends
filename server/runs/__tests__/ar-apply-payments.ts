/**
 * AR-APPLY-PAYMENTS. Doc 02 module 5 AR-APPLY-PAYMENTS, the four tiers.
 *
 * The questions these tests answer: does a payment reach the right invoices,
 * does a multi invoice remittance sum to the payment inside the stated
 * tolerance, does an ambiguous case refuse rather than guess, and does the
 * entry move exactly the cash that arrived and nothing else.
 */

import { arApplyPayments } from "../runs/ar-apply-payments";
import type {
  CustomerPaymentRow,
  InvoiceRow,
  PaymentApplicationRow,
} from "../tables";
import type { MemoryRunDb } from "../db-memory";
import { isJournalEntry } from "../contract";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  applyArap,
  arapDb,
  arapScope,
  balanceOf,
  customer,
  invoice,
  payment,
  previewArap,
  reasons,
  remittance,
  skipDetail,
  skippedFor,
  sumLines,
} from "./arap-fixtures";
import { assert, assertEqual, show, test } from "./harness";

function invoiceRow(db: MemoryRunDb, id: string): InvoiceRow {
  return (db.all("invoices") as InvoiceRow[]).find(
    (i) => i.id === id,
  ) as InvoiceRow;
}

function paymentRow(db: MemoryRunDb, id: string): CustomerPaymentRow {
  return (db.all("customer_payments") as CustomerPaymentRow[]).find(
    (p) => p.id === id,
  ) as CustomerPaymentRow;
}

function applications(db: MemoryRunDb): PaymentApplicationRow[] {
  return db.all("payment_applications") as PaymentApplicationRow[];
}

/** Two open invoices, the older one for 300.00 and the newer for 700.00. */
function seedTwo(db: MemoryRunDb): void {
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [
    invoice("INV-OLD", "CUS-1", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
      originalAmountCents: BigInt(30000),
    }),
    invoice("INV-NEW", "CUS-1", {
      invoiceDate: "2025-12-11",
      dueDate: "2026-01-10",
      originalAmountCents: BigInt(70000),
    }),
  ]);
}

test("payments, tier 4 applies oldest first", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", { amountCents: BigInt(50000) }),
  ]);
  const { applied } = await applyArap(db, arApplyPayments, arapScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}, reasons ${show(reasons(applied))}`,
  );
  assertEqual(
    invoiceRow(db, "INV-OLD").appliedPaymentsCents,
    BigInt(30000),
    "the older invoice was cleared first",
  );
  assertEqual(invoiceRow(db, "INV-OLD").status, "paid", "and is marked paid");
  assertEqual(
    invoiceRow(db, "INV-NEW").appliedPaymentsCents,
    BigInt(20000),
    "the remainder went to the newer one",
  );
  assertEqual(invoiceRow(db, "INV-NEW").status, "posted", "which stays open");
  assertEqual(paymentRow(db, "PAY-1").appliedTier, 4, "tier 4 resolved it");
  assertEqual(paymentRow(db, "PAY-1").status, "applied", "fully applied");
});

test("payments, the entry moves the clearing account to the control account", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", { amountCents: BigInt(50000) }),
  ]);
  const { applied } = await applyArap(db, arApplyPayments, arapScope());
  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries.length, 1, "one entry for one payment");
  assertEqual(
    sumLines(db.all("journal_lines")),
    BigInt(0),
    "the books still foot",
  );
  assertEqual(balanceOf(db, "1200"), BigInt(50000), "clearing takes the debit");
  assertEqual(balanceOf(db, "1100"), BigInt(-50000), "control takes the credit");
});

test("payments, tier 2 follows a match hint naming one invoice", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", {
      amountCents: BigInt(30000),
      matchHint: "INV-NEW",
    }),
  ]);
  await applyArap(db, arApplyPayments, arapScope());
  assertEqual(
    invoiceRow(db, "INV-OLD").appliedPaymentsCents,
    BigInt(0),
    "the older invoice was left alone",
  );
  assertEqual(
    invoiceRow(db, "INV-NEW").appliedPaymentsCents,
    BigInt(30000),
    "the named invoice took it",
  );
  assertEqual(paymentRow(db, "PAY-1").appliedTier, 2, "tier 2 resolved it");
});

test("payments, tier 1 splits a multi invoice remittance", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", { amountCents: BigInt(100000) }),
  ]);
  db.seed("remittance_lines", [
    remittance("REM-1", "PAY-1", 1, "INV-OLD", BigInt(30000)),
    remittance("REM-2", "PAY-1", 2, "INV-NEW", BigInt(70000)),
  ]);
  await applyArap(db, arApplyPayments, arapScope());
  assertEqual(
    invoiceRow(db, "INV-OLD").appliedPaymentsCents,
    BigInt(30000),
    "the advice split it",
  );
  assertEqual(
    invoiceRow(db, "INV-NEW").appliedPaymentsCents,
    BigInt(70000),
    "line by line",
  );
  assertEqual(paymentRow(db, "PAY-1").appliedTier, 1, "tier 1 resolved it");
  assertEqual(applications(db).length, 2, "one application row per invoice");
  assert(
    applications(db).every((a) => a.tier === 1),
    "and each records the tier",
  );
});

test("payments, a remittance one cent per invoice out is still inside tolerance", async () => {
  const db = arapDb();
  seedTwo(db);
  // Two invoices, so the tolerance is two cents. The advice is two cents high.
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", { amountCents: BigInt(99998) }),
  ]);
  db.seed("remittance_lines", [
    remittance("REM-1", "PAY-1", 1, "INV-OLD", BigInt(30000)),
    remittance("REM-2", "PAY-1", 2, "INV-NEW", BigInt(70000)),
  ]);
  const { applied } = await applyArap(db, arApplyPayments, arapScope());
  assertEqual(paymentRow(db, "PAY-1").appliedTier, 1, "it was accepted");
  const entries = applied.result.proposals.filter(isJournalEntry);
  let total = BigInt(0);
  for (const l of entries[0].lines) if (l.amountCents > BigInt(0)) total += l.amountCents;
  assertEqual(
    total,
    BigInt(99998),
    "and only the cash that arrived was applied",
  );
});

test("payments, a remittance well out of tolerance is refused", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", { amountCents: BigInt(90000) }),
  ]);
  db.seed("remittance_lines", [
    remittance("REM-1", "PAY-1", 1, "INV-OLD", BigInt(30000)),
    remittance("REM-2", "PAY-1", 2, "INV-NEW", BigInt(70000)),
  ]);
  const preview = await previewArap(db, arApplyPayments, arapScope());
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

test("payments, an ambiguous combination refuses rather than guesses", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  // Two invoices of the same amount, so 500.00 could be either one.
  db.seed("invoices", [
    invoice("INV-A", "CUS-1", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
      originalAmountCents: BigInt(50000),
    }),
    invoice("INV-B", "CUS-1", {
      invoiceDate: "2025-11-02",
      dueDate: "2025-12-02",
      originalAmountCents: BigInt(50000),
    }),
  ]);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", { amountCents: BigInt(50000) }),
  ]);
  const preview = await previewArap(db, arApplyPayments, arapScope());
  assert(
    skipDetail(preview, "PAY-1", "combination_not_unique"),
    `expected combination_not_unique, got ${show(reasons(preview))}`,
  );
  assertEqual(preview.result.proposals.length, 0, "nothing was applied");
});

test("payments, tier 3 takes a unique combination", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [
    invoice("INV-A", "CUS-1", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
      originalAmountCents: BigInt(30000),
    }),
    invoice("INV-B", "CUS-1", {
      invoiceDate: "2025-11-02",
      dueDate: "2025-12-02",
      originalAmountCents: BigInt(45000),
    }),
    invoice("INV-C", "CUS-1", {
      invoiceDate: "2025-11-03",
      dueDate: "2025-12-03",
      originalAmountCents: BigInt(81000),
    }),
  ]);
  // 300 plus 450 is the only way to reach 750.00 here.
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", { amountCents: BigInt(75000) }),
  ]);
  await applyArap(db, arApplyPayments, arapScope());
  assertEqual(paymentRow(db, "PAY-1").appliedTier, 3, "tier 3 resolved it");
  assertEqual(invoiceRow(db, "INV-A").status, "paid", "the first is cleared");
  assertEqual(invoiceRow(db, "INV-B").status, "paid", "and so is the second");
  assertEqual(
    invoiceRow(db, "INV-C").appliedPaymentsCents,
    BigInt(0),
    "and the third was never touched",
  );
});

test("payments, an overpayment applies what it can and leaves the rest unapplied", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", { amountCents: BigInt(150000) }),
  ]);
  await applyArap(db, arApplyPayments, arapScope());
  assertEqual(
    invoiceRow(db, "INV-1").appliedPaymentsCents,
    BigInt(100000),
    "the invoice took its own balance and no more",
  );
  const pay = paymentRow(db, "PAY-1");
  assertEqual(pay.appliedCents, BigInt(100000), "and the payment says so");
  assertEqual(pay.status, "partially_applied", "the rest stays unapplied");
  assertEqual(balanceOf(db, "1200"), BigInt(100000), "only what was applied");
});

test("payments, a second run applies nothing twice", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", { amountCents: BigInt(30000) }),
  ]);
  await applyArap(db, arApplyPayments, arapScope());
  const first = balanceOf(db, "1100");
  const second = await previewArap(db, arApplyPayments, arapScope());
  assertEqual(second.result.proposals.length, 0, "nothing left to apply");
  assert(
    skippedFor(second, "PAY-1", "already_applied"),
    `expected already_applied, got ${show(reasons(second))}`,
  );
  assertEqual(balanceOf(db, "1100"), first, "and the control did not move");
});

test("payments, an overridden payment or invoice is never touched", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [
    invoice("INV-LOCK", "CUS-1", {
      manualOverride: true,
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
    }),
    invoice("INV-OK", "CUS-1", { originalAmountCents: BigInt(20000) }),
  ]);
  db.seed("customer_payments", [
    payment("PAY-OVR", "CUS-1", {
      amountCents: BigInt(10000),
      manualOverride: true,
    }),
    payment("PAY-OK", "CUS-1", { amountCents: BigInt(20000) }),
  ]);
  const { applied } = await applyArap(db, arApplyPayments, arapScope());
  assert(
    skippedFor(applied, "PAY-OVR", "manual_override"),
    `expected manual_override, got ${show(reasons(applied))}`,
  );
  assertEqual(
    invoiceRow(db, "INV-LOCK").appliedPaymentsCents,
    BigInt(0),
    "the overridden invoice was never allocated to",
  );
  assertEqual(
    invoiceRow(db, "INV-OK").appliedPaymentsCents,
    BigInt(20000),
    "and the ordinary one still worked",
  );
});

test("payments, a locked payment date posts nothing", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", { amountCents: BigInt(30000) }),
  ]);
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await applyArap(db, arApplyPayments, arapScope());
  assert(
    skippedFor(applied, "PAY-1", "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "nothing posted");
});

test("payments, a payment on hold waits for a person", async () => {
  const db = arapDb();
  seedTwo(db);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", { amountCents: BigInt(30000), onHold: true }),
  ]);
  const preview = await previewArap(db, arApplyPayments, arapScope());
  assert(
    skipDetail(preview, "PAY-1", "payment_on_hold"),
    `expected payment_on_hold, got ${show(reasons(preview))}`,
  );
});

test("payments, two payments in one run cannot consume the same balance", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  db.seed("customer_payments", [
    payment("PAY-A", "CUS-1", {
      amountCents: BigInt(60000),
      paymentDate: "2026-01-15",
    }),
    payment("PAY-B", "CUS-1", {
      amountCents: BigInt(60000),
      paymentDate: "2026-01-20",
    }),
  ]);
  await applyArap(db, arApplyPayments, arapScope());
  assertEqual(
    invoiceRow(db, "INV-1").appliedPaymentsCents,
    BigInt(100000),
    "the invoice never took more than it was owed",
  );
  assertEqual(balanceOf(db, "1100"), BigInt(-100000), "and the control agrees");
});
