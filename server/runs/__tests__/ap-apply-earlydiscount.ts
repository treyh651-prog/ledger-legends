/**
 * AP-APPLY-DISCOUNTS. Doc 02 module 5 AP-APPLY-DISCOUNTS, the payable side.
 *
 * The questions these tests answer: does the discount window bind to the day,
 * does the bill balance actually fall to zero when the discount is taken, does
 * the entry balance, does the vendor rule decide where the discount lands, and
 * does a rerun take the discount a second time. The last one matters because a
 * discount taken twice is a payable that never settles.
 */

import { apApplyEarlyDiscount } from "../runs/ap-apply-earlydiscount";
import type { BillRow, VendorCreditRow } from "../tables";
import type { MemoryRunDb } from "../db-memory";
import { isJournalEntry } from "../contract";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  applyArap,
  arapDb,
  arapPolicy,
  balanceOf,
  bill,
  previewArap,
  reasons,
  skipDetail,
  skippedFor,
  sumLines,
  vendor,
  PERIOD,
} from "./arap-fixtures";
import { assert, assertEqual, show, test } from "./harness";

function billRow(db: MemoryRunDb, id: string): BillRow {
  return (db.all("bills") as BillRow[]).find((b) => b.id === id) as BillRow;
}

function billOpen(row: BillRow): bigint {
  return (
    row.originalAmountCents -
    row.paidCents -
    row.discountTakenCents -
    row.creditsCents
  );
}

/** The scope. A pay day inside the window unless the test says otherwise. */
function scope(payDay = "2026-01-12"): {
  clientId: string;
  period: string;
  payDay: string;
} {
  return { clientId: CLIENT_A1, period: PERIOD, payDay };
}

test("discount, the bill settles in full and the balance falls to zero", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [bill("BILL-1", "VEN-1")]);
  const { applied } = await applyArap(db, apApplyEarlyDiscount, scope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}, reasons ${show(reasons(applied))}`,
  );
  const row = billRow(db, "BILL-1");
  assertEqual(row.discountTakenCents, BigInt(2000), "two percent of 1,000.00");
  assertEqual(row.paidCents, BigInt(98000), "and the rest was paid");
  assertEqual(billOpen(row), BigInt(0), "so the bill owes nothing");
  assertEqual(row.status, "paid", "and says so");
});

test("discount, the entry balances and the books still foot", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [bill("BILL-1", "VEN-1")]);
  const { applied } = await applyArap(db, apApplyEarlyDiscount, scope());
  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries.length, 1, "one entry");
  let net = BigInt(0);
  for (const l of entries[0].lines) net += l.amountCents;
  assertEqual(net, BigInt(0), "the entry balances");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "and so do the books");
  assertEqual(balanceOf(db, "2000"), BigInt(100000), "the payable is relieved");
  assertEqual(balanceOf(db, "1010"), BigInt(-98000), "cash paid the net");
  assertEqual(balanceOf(db, "8200"), BigInt(-2000), "and the discount is income");
});

test("discount, the window binds to the day", async () => {
  const cases: ReadonlyArray<readonly [string, boolean, string]> = [
    // Bill dated 5 January on 2/10 terms. Day 15 is inside, day 16 is not.
    ["2026-01-15", true, "the last day inside"],
    ["2026-01-16", false, "the first day outside"],
  ];
  for (const [payDay, inside, label] of cases) {
    const db = arapDb();
    db.seed("vendors", [vendor("VEN-1")]);
    db.seed("bills", [bill("BILL-1", "VEN-1")]);
    const outcome = await previewArap(db, apApplyEarlyDiscount, scope(payDay));
    if (inside) {
      assert(outcome.result.proposals.length > 0, `${label} takes the discount`);
    } else {
      assert(
        skipDetail(outcome, "BILL-1", "outside_discount_window"),
        `${label} does not, got ${show(reasons(outcome))}`,
      );
    }
  }
});

test("discount, a bill with no terms is left alone", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [
    bill("BILL-1", "VEN-1", {
      discountBps: null,
      discountDays: null,
      netDays: 30,
    }),
  ]);
  const preview = await previewArap(db, apApplyEarlyDiscount, scope());
  assert(
    skipDetail(preview, "BILL-1", "no_discount_terms"),
    `expected no_discount_terms, got ${show(reasons(preview))}`,
  );
});

test("discount, a partial set of terms is not terms", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [bill("BILL-1", "VEN-1", { discountDays: null })]);
  const preview = await previewArap(db, apApplyEarlyDiscount, scope());
  assert(
    skipDetail(preview, "BILL-1", "no_discount_terms"),
    `expected no_discount_terms, got ${show(reasons(preview))}`,
  );
});

test("discount, freight and tax are outside the base by default", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [
    bill("BILL-1", "VEN-1", {
      originalAmountCents: BigInt(120000),
      freightCents: BigInt(10000),
      taxCents: BigInt(10000),
    }),
  ]);
  await applyArap(db, apApplyEarlyDiscount, scope());
  // Two percent of 1,000.00 of goods, not of the 1,200.00 total.
  assertEqual(
    billRow(db, "BILL-1").discountTakenCents,
    BigInt(2000),
    "the base excluded freight and tax",
  );
});

test("discount, a policy can put freight and tax back into the base", async () => {
  const db = arapDb();
  db.seed("arap_policies", [
    arapPolicy("POL-1", { discountBaseExcludesFreightTax: false }),
  ]);
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [
    bill("BILL-1", "VEN-1", {
      originalAmountCents: BigInt(120000),
      freightCents: BigInt(10000),
      taxCents: BigInt(10000),
    }),
  ]);
  await applyArap(db, apApplyEarlyDiscount, scope());
  assertEqual(
    billRow(db, "BILL-1").discountTakenCents,
    BigInt(2400),
    "two percent of the whole bill",
  );
});

test("discount, the vendor rule can send it to a vendor credit instead", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1", { earlyDiscountRule: "vendor_credit" })]);
  db.seed("bills", [bill("BILL-1", "VEN-1")]);
  await applyArap(db, apApplyEarlyDiscount, scope());
  assertEqual(balanceOf(db, "8200"), BigInt(0), "nothing hit income");
  assertEqual(balanceOf(db, "2050"), BigInt(-2000), "it became a credit");
  const credits = db.all("vendor_credits") as VendorCreditRow[];
  assertEqual(credits.length, 1, "and a credit row was written");
  assertEqual(credits[0].amountCents, BigInt(2000), "for the discount");
  assertEqual(credits[0].billId, "BILL-1", "against the bill it came from");
  assertEqual(credits[0].state, "open", "and it is available to use");
  assertEqual(billOpen(billRow(db, "BILL-1")), BigInt(0), "the bill still settles");
});

test("discount, a rerun never takes the discount twice", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [bill("BILL-1", "VEN-1")]);
  await applyArap(db, apApplyEarlyDiscount, scope());
  const taken = billRow(db, "BILL-1").discountTakenCents;
  const second = await previewArap(db, apApplyEarlyDiscount, scope());
  assertEqual(second.result.proposals.length, 0, "nothing left to do");
  assert(
    skipDetail(second, "BILL-1", "discount_already_taken") ||
      skipDetail(second, "BILL-1", "bill_closed"),
    `expected an already applied reason, got ${show(reasons(second))}`,
  );
  assertEqual(
    billRow(db, "BILL-1").discountTakenCents,
    taken,
    "and the discount did not grow",
  );
  assertEqual(db.all("journal_entries").length, 1, "still one entry");
});

test("discount, a bill on hold or in dispute is not paid early", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [
    bill("BILL-HOLD", "VEN-1", { onHold: true }),
    bill("BILL-DISP", "VEN-1", { inDispute: true }),
  ]);
  const preview = await previewArap(db, apApplyEarlyDiscount, scope());
  assert(
    skipDetail(preview, "BILL-HOLD", "bill_on_hold_or_disputed"),
    `expected the hold to stop it, got ${show(reasons(preview))}`,
  );
  assert(
    skipDetail(preview, "BILL-DISP", "bill_on_hold_or_disputed"),
    "and the dispute too",
  );
  assertEqual(preview.result.proposals.length, 0, "nothing was proposed");
});

test("discount, an overridden bill is never touched", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [bill("BILL-1", "VEN-1", { manualOverride: true })]);
  const { applied } = await applyArap(db, apApplyEarlyDiscount, scope());
  assert(
    skippedFor(applied, "BILL-1", "manual_override"),
    `expected manual_override, got ${show(reasons(applied))}`,
  );
  assertEqual(
    billRow(db, "BILL-1").discountTakenCents,
    BigInt(0),
    "and no discount was taken",
  );
});

test("discount, a locked pay day posts nothing", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [bill("BILL-1", "VEN-1")]);
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await applyArap(db, apApplyEarlyDiscount, scope());
  assert(
    skippedFor(applied, "BILL-1", "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "nothing posted");
});

test("discount, a partly paid bill never discounts more than it owes", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  // Only 10.00 is still open and the stated discount would be 20.00.
  db.seed("bills", [
    bill("BILL-1", "VEN-1", { paidCents: BigInt(99000) }),
  ]);
  await applyArap(db, apApplyEarlyDiscount, scope());
  const row = billRow(db, "BILL-1");
  assertEqual(row.discountTakenCents, BigInt(1000), "capped at the open amount");
  assertEqual(billOpen(row), BigInt(0), "and the bill lands exactly on zero");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the books foot");
});

test("discount, preview writes nothing", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [bill("BILL-1", "VEN-1")]);
  const preview = await previewArap(db, apApplyEarlyDiscount, scope());
  assert(preview.result.proposals.length > 0, "it proposed work");
  assertEqual(db.all("journal_entries").length, 0, "and posted none of it");
  assertEqual(
    billRow(db, "BILL-1").discountTakenCents,
    BigInt(0),
    "and wrote nothing to the bill",
  );
});
