/**
 * AR-CHARGE-LATEFEES. Doc 02 module 5 AR-CHARGE-LATEFEES.
 *
 * The questions these tests answer: is a fee charged only when the customer
 * agreed to fees, is the grace window respected exactly, is the arithmetic the
 * stated arithmetic, and above all does a rerun charge nothing twice. Double
 * charging is the failure that costs a client a customer, so it gets more than
 * one test.
 */

import { arChargeLateFees } from "../runs/ar-charge-latefees";
import type { InvoiceRow } from "../tables";
import type { MemoryRunDb } from "../db-memory";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  applyArap,
  arapDb,
  arapPolicy,
  arapScope,
  customer,
  invoice,
  previewArap,
  reasons,
  skipDetail,
  skippedFor,
} from "./arap-fixtures";
import { assert, assertEqual, show, test } from "./harness";

function fees(db: MemoryRunDb): InvoiceRow[] {
  return (db.all("invoices") as InvoiceRow[]).filter((i) => i.isLateFee);
}

function feeTotal(db: MemoryRunDb): bigint {
  let total = BigInt(0);
  for (const f of fees(db)) total += f.originalAmountCents;
  return total;
}

/** A customer on 18 percent a year with fees enabled, and one old invoice. */
function seedFeeCase(db: MemoryRunDb, extra: Partial<InvoiceRow> = {}): void {
  db.seed("customers", [
    customer("CUS-1", { lateFeeEnabled: true, annualizedRateBp: 1800 }),
  ]);
  db.seed("invoices", [
    invoice("INV-1", "CUS-1", {
      // Due 1 December, so 61 days late at the end of January. One whole
      // thirty day block past a grace of ten.
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
      ...extra,
    }),
  ]);
}

test("late fees, a fee invoice is prepared and no entry is posted", async () => {
  const db = arapDb();
  seedFeeCase(db);
  const { applied } = await applyArap(db, arChargeLateFees, arapScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}, reasons ${show(reasons(applied))}`,
  );
  assertEqual(fees(db).length, 1, "one fee invoice");
  const fee = fees(db)[0];
  assertEqual(fee.parentInvoiceId, "INV-1", "it names its parent");
  assertEqual(fee.status, "draft", "and waits for a person");
  assertEqual(fee.feeMonths, 1, "one thirty day block was charged");
  assertEqual(db.all("journal_entries").length, 0, "nothing was posted");
  assertEqual(applied.result.totals.netCents, BigInt(0), "and nothing moved");
});

test("late fees, the amount is the stated arithmetic", async () => {
  const db = arapDb();
  seedFeeCase(db);
  await applyArap(db, arChargeLateFees, arapScope());
  // 1,000.00 at 1,800 basis points a year for one thirty day block:
  // 100000 times 1800 times 30, over 10,000 times 365, rounded half away.
  assertEqual(fees(db)[0].originalAmountCents, BigInt(1479), "1,479 cents");
  assertEqual(fees(db)[0].taxCents, BigInt(0), "and a fee carries no tax");
});

test("late fees, nothing is charged unless the customer enabled them", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [
    invoice("INV-1", "CUS-1", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
    }),
  ]);
  const preview = await previewArap(db, arChargeLateFees, arapScope());
  assert(
    skipDetail(preview, "INV-1", "late_fee_not_enabled"),
    `expected late_fee_not_enabled, got ${show(reasons(preview))}`,
  );
  assertEqual(preview.result.proposals.length, 0, "no fee was prepared");
});

test("late fees, an enabled customer with no rate is an error and not a guess", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1", { lateFeeEnabled: true })]);
  db.seed("invoices", [
    invoice("INV-1", "CUS-1", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
    }),
  ]);
  const preview = await previewArap(db, arChargeLateFees, arapScope());
  assert(
    preview.result.errors.some((e) => e.code === "AR_LATEFEE_RATE_MISSING"),
    `expected AR_LATEFEE_RATE_MISSING, got ${show(
      preview.result.errors.map((e) => e.code),
    )}`,
  );
  assertEqual(preview.status, "refused", "and the run refuses to apply");
});

test("late fees, the grace window is respected to the day", async () => {
  // A grace of ten and a block of thirty means 39 days late is nothing and 40
  // days late is one block.
  const cases: ReadonlyArray<readonly [string, number, string]> = [
    ["2025-12-23", 0, "39 days late"],
    ["2025-12-22", 1, "40 days late"],
  ];
  for (const [dueDate, expected, label] of cases) {
    const db = arapDb();
    db.seed("customers", [
      customer("CUS-1", { lateFeeEnabled: true, annualizedRateBp: 1800 }),
    ]);
    db.seed("invoices", [
      invoice("INV-1", "CUS-1", { invoiceDate: "2025-11-01", dueDate }),
    ]);
    await applyArap(db, arChargeLateFees, arapScope());
    assertEqual(fees(db).length, expected, `${label} charges ${expected}`);
  }
});

test("late fees, a rerun of the same period charges nothing", async () => {
  const db = arapDb();
  seedFeeCase(db);
  await applyArap(db, arChargeLateFees, arapScope());
  const charged = feeTotal(db);
  const second = await previewArap(db, arChargeLateFees, arapScope());
  assertEqual(second.result.proposals.length, 0, "nothing to charge again");
  assert(
    skipDetail(second, "INV-1", "fee_already_charged"),
    `expected fee_already_charged, got ${show(reasons(second))}`,
  );
  assertEqual(feeTotal(db), charged, "and the total did not move");
  assertEqual(fees(db).length, 1, "still one fee invoice");
});

test("late fees, a month later charges exactly one more block", async () => {
  const db = arapDb();
  seedFeeCase(db);
  await applyArap(db, arChargeLateFees, arapScope());
  assertEqual(fees(db)[0].feeMonths, 1, "one block in January");
  // The end of February is 89 days past due, which is two whole blocks past a
  // grace of ten, so exactly one more block is owed.
  await applyArap(db, arChargeLateFees, arapScope("2026-02-01"));
  assertEqual(fees(db).length, 2, "a second fee invoice");
  let months = 0;
  for (const f of fees(db)) months += f.feeMonths ?? 0;
  assertEqual(months, 2, "two blocks charged in total, not three");
  assertEqual(feeTotal(db), BigInt(2958), "and the amounts add up");
});

test("late fees, a fee invoice is never itself charged a fee", async () => {
  const db = arapDb();
  seedFeeCase(db);
  await applyArap(db, arChargeLateFees, arapScope());
  const feeId = fees(db)[0].id;
  const second = await previewArap(db, arChargeLateFees, arapScope("2026-06-01"));
  const proposedParents = second.result.proposals
    .filter((p) => p.kind === "row_insert")
    .map((p) => (p.row as { parentInvoiceId: string }).parentInvoiceId);
  assert(
    !proposedParents.includes(feeId),
    `a fee was charged on a fee: ${show(proposedParents)}`,
  );
});

test("late fees, a paid invoice and a disputed invoice are both left alone", async () => {
  const db = arapDb();
  db.seed("customers", [
    customer("CUS-1", { lateFeeEnabled: true, annualizedRateBp: 1800 }),
  ]);
  db.seed("invoices", [
    invoice("INV-PAID", "CUS-1", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
      appliedPaymentsCents: BigInt(100000),
      status: "paid",
    }),
    invoice("INV-DISPUTE", "CUS-1", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
      inDispute: true,
    }),
  ]);
  const preview = await previewArap(db, arChargeLateFees, arapScope());
  assert(
    skipDetail(preview, "INV-PAID", "invoice_closed"),
    `expected invoice_closed, got ${show(reasons(preview))}`,
  );
  assert(
    skipDetail(preview, "INV-DISPUTE", "invoice_in_dispute"),
    `expected invoice_in_dispute, got ${show(reasons(preview))}`,
  );
  assertEqual(preview.result.proposals.length, 0, "neither was charged");
});

test("late fees, a payment plan and an exemption both stop the fee", async () => {
  const db = arapDb();
  db.seed("customers", [
    customer("CUS-PLAN", {
      lateFeeEnabled: true,
      annualizedRateBp: 1800,
      paymentPlanActive: true,
    }),
    customer("CUS-EXEMPT", {
      lateFeeEnabled: true,
      annualizedRateBp: 1800,
      lateFeeExempt: true,
    }),
  ]);
  db.seed("invoices", [
    invoice("INV-PLAN", "CUS-PLAN", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
    }),
    invoice("INV-EXEMPT", "CUS-EXEMPT", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
    }),
  ]);
  const preview = await previewArap(db, arChargeLateFees, arapScope());
  assert(
    skipDetail(preview, "INV-PLAN", "payment_plan_active"),
    `expected payment_plan_active, got ${show(reasons(preview))}`,
  );
  assert(
    skipDetail(preview, "INV-EXEMPT", "late_fee_not_enabled"),
    `expected the exemption to stop it, got ${show(reasons(preview))}`,
  );
});

test("late fees, a flat fee overrides the rate", async () => {
  const db = arapDb();
  db.seed("customers", [
    customer("CUS-1", {
      lateFeeEnabled: true,
      annualizedRateBp: 1800,
      flatFeeCents: BigInt(2500),
    }),
  ]);
  db.seed("invoices", [
    invoice("INV-1", "CUS-1", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
    }),
  ]);
  await applyArap(db, arChargeLateFees, arapScope());
  assertEqual(fees(db)[0].originalAmountCents, BigInt(2500), "the flat amount");
});

test("late fees, the policy minimum and maximum both bind", async () => {
  const low = arapDb();
  low.seed("arap_policies", [
    arapPolicy("POL-1", { lateFeeMinimumCents: BigInt(5000) }),
  ]);
  seedFeeCase(low);
  const preview = await previewArap(low, arChargeLateFees, arapScope());
  assert(
    skipDetail(preview, "INV-1", "fee_below_minimum"),
    `expected fee_below_minimum, got ${show(reasons(preview))}`,
  );

  const high = arapDb();
  high.seed("arap_policies", [
    arapPolicy("POL-1", { lateFeeMaximumCents: BigInt(1000) }),
  ]);
  seedFeeCase(high);
  await applyArap(high, arChargeLateFees, arapScope());
  assertEqual(fees(high)[0].originalAmountCents, BigInt(1000), "capped");
});

test("late fees, the customer grace overrides the policy grace", async () => {
  const db = arapDb();
  db.seed("customers", [
    customer("CUS-1", {
      lateFeeEnabled: true,
      annualizedRateBp: 1800,
      // A grace of 45 days puts a 61 day old invoice back inside the window.
      graceDays: 45,
    }),
  ]);
  db.seed("invoices", [
    invoice("INV-1", "CUS-1", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
    }),
  ]);
  const preview = await previewArap(db, arChargeLateFees, arapScope());
  assert(
    skipDetail(preview, "INV-1", "within_grace_window"),
    `expected within_grace_window, got ${show(reasons(preview))}`,
  );
});

test("late fees, an overridden invoice or customer is never charged", async () => {
  const db = arapDb();
  db.seed("customers", [
    customer("CUS-1", { lateFeeEnabled: true, annualizedRateBp: 1800 }),
    customer("CUS-2", {
      lateFeeEnabled: true,
      annualizedRateBp: 1800,
      manualOverride: true,
    }),
  ]);
  db.seed("invoices", [
    invoice("INV-1", "CUS-1", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
      manualOverride: true,
    }),
    invoice("INV-2", "CUS-2", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
    }),
  ]);
  const { applied } = await applyArap(db, arChargeLateFees, arapScope());
  assert(
    skippedFor(applied, "INV-1", "manual_override"),
    `expected manual_override on the invoice, got ${show(reasons(applied))}`,
  );
  assert(
    skippedFor(applied, "INV-2", "manual_override"),
    "and on the invoice of an overridden customer",
  );
  assertEqual(fees(db).length, 0, "no fee was prepared");
});

test("late fees, a locked fee date prepares nothing", async () => {
  const db = arapDb();
  seedFeeCase(db);
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await applyArap(db, arChargeLateFees, arapScope());
  assert(
    skippedFor(applied, "INV-1", "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
  assertEqual(fees(db).length, 0, "nothing was written");
});
