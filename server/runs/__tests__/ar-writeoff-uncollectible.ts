/**
 * AR-WRITEOFF-UNCOLLECTIBLE. Doc 02 module 5 AR-WRITEOFF-UNCOLLECTIBLE.
 *
 * The one question that matters here is asked several ways: can anything at all
 * cause a write off to post without either the customer being flagged
 * do_not_pursue or the invoice carrying the manual approve flag. Age does not.
 * Amount does not. Collection attempts do not. The rest of the suite checks the
 * arithmetic and the method, which only run once that gate has opened.
 */

import { arWriteoffUncollectible } from "../runs/ar-writeoff-uncollectible";
import type { InvoiceRow, WriteoffProposalRow } from "../tables";
import type { MemoryRunDb } from "../db-memory";
import { isJournalEntry } from "../contract";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  applyArap,
  arapDb,
  arapPolicy,
  balanceOf,
  customer,
  invoice,
  previewArap,
  reasons,
  skipDetail,
  skippedFor,
  sumLines,
} from "./arap-fixtures";
import { assert, assertEqual, show, test } from "./harness";

/** A period far enough forward that a January invoice is long past 180 days. */
const LATE = { clientId: CLIENT_A1, period: "2026-09-01" };

function proposals(db: MemoryRunDb): WriteoffProposalRow[] {
  return db.all("writeoff_proposals") as WriteoffProposalRow[];
}

function invoiceRow(db: MemoryRunDb, id: string): InvoiceRow {
  return (db.all("invoices") as InvoiceRow[]).find(
    (i) => i.id === id,
  ) as InvoiceRow;
}

function seedOld(
  db: MemoryRunDb,
  customerExtra: Parameters<typeof customer>[1] = {},
  invoiceExtra: Partial<InvoiceRow> = {},
): void {
  db.seed("customers", [customer("CUS-1", customerExtra)]);
  db.seed("invoices", [invoice("INV-1", "CUS-1", invoiceExtra)]);
}

test("writeoff, an old invoice with no authority posts nothing", async () => {
  const db = arapDb();
  seedOld(db);
  const { applied } = await applyArap(db, arWriteoffUncollectible, LATE);
  assert(
    skipDetail(applied, "INV-1", "no_writeoff_authority"),
    `expected no_writeoff_authority, got ${show(reasons(applied))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "nothing was posted");
  assertEqual(
    invoiceRow(db, "INV-1").writtenOffCents,
    BigInt(0),
    "and the invoice still stands",
  );
  assertEqual(proposals(db).length, 1, "but a review item was recorded");
  assertEqual(proposals(db)[0].authority, null, "with no authority");
  assertEqual(proposals(db)[0].state, "proposed", "and in the proposed state");
});

test("writeoff, age alone never opens the gate", async () => {
  const db = arapDb();
  // Five years old, ten times the threshold, and still nothing posts.
  seedOld(db, {}, { invoiceDate: "2021-01-01", dueDate: "2021-02-01" });
  const { applied } = await applyArap(db, arWriteoffUncollectible, LATE);
  assertEqual(db.all("journal_entries").length, 0, "still nothing posted");
  assert(
    skipDetail(applied, "INV-1", "no_writeoff_authority"),
    `expected no_writeoff_authority, got ${show(reasons(applied))}`,
  );
});

test("writeoff, collection attempts alone never open the gate", async () => {
  const db = arapDb();
  seedOld(db, {}, { collectionAttempts: 12 });
  await applyArap(db, arWriteoffUncollectible, LATE);
  assertEqual(db.all("journal_entries").length, 0, "nothing was posted");
  assertEqual(
    proposals(db)[0].collectionAttempts,
    12,
    "the attempts are recorded on the review item",
  );
});

test("writeoff, do_not_pursue on the customer opens the gate", async () => {
  const db = arapDb();
  seedOld(db, { doNotPursue: true });
  await applyArap(db, arWriteoffUncollectible, LATE);
  assertEqual(db.all("journal_entries").length, 1, "one entry was posted");
  assertEqual(proposals(db)[0].authority, "do_not_pursue", "and it says why");
  assertEqual(proposals(db)[0].state, "posted", "and that it posted");
  const inv = invoiceRow(db, "INV-1");
  assertEqual(inv.writtenOffCents, BigInt(100000), "the balance is written off");
  assertEqual(inv.status, "written_off", "and the invoice says so");
});

test("writeoff, the manual approve flag on the invoice opens the gate", async () => {
  const db = arapDb();
  seedOld(db, {}, { writeoffApproved: true });
  await applyArap(db, arWriteoffUncollectible, LATE);
  assertEqual(db.all("journal_entries").length, 1, "one entry was posted");
  assertEqual(proposals(db)[0].authority, "manual_approve", "by that authority");
});

test("writeoff, only the flagged or approved rows are touched", async () => {
  const db = arapDb();
  db.seed("customers", [
    customer("CUS-FLAG", { doNotPursue: true }),
    customer("CUS-PLAIN"),
  ]);
  db.seed("invoices", [
    invoice("INV-FLAG", "CUS-FLAG"),
    invoice("INV-APPROVED", "CUS-PLAIN", { writeoffApproved: true }),
    invoice("INV-PLAIN", "CUS-PLAIN"),
  ]);
  await applyArap(db, arWriteoffUncollectible, LATE);
  assertEqual(
    invoiceRow(db, "INV-FLAG").status,
    "written_off",
    "the flagged customer's invoice went",
  );
  assertEqual(
    invoiceRow(db, "INV-APPROVED").status,
    "written_off",
    "and the approved invoice went",
  );
  assertEqual(
    invoiceRow(db, "INV-PLAIN").status,
    "posted",
    "and the third one is untouched",
  );
  assertEqual(db.all("journal_entries").length, 2, "two entries, not three");
});

test("writeoff, the direct method debits bad debt and credits the receivable", async () => {
  const db = arapDb();
  seedOld(db, { doNotPursue: true });
  const { applied } = await applyArap(db, arWriteoffUncollectible, LATE);
  const entries = applied.result.proposals.filter(isJournalEntry);
  let net = BigInt(0);
  for (const l of entries[0].lines) net += l.amountCents;
  assertEqual(net, BigInt(0), "the entry balances");
  assertEqual(balanceOf(db, "6800"), BigInt(100000), "bad debt takes the charge");
  assertEqual(balanceOf(db, "1100"), BigInt(-100000), "the receivable is cleared");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the books foot");
  assertEqual(proposals(db)[0].method, "direct", "and the method is recorded");
});

test("writeoff, the allowance method debits the allowance instead", async () => {
  const db = arapDb();
  db.seed("arap_policies", [arapPolicy("POL-1", { writeoffMethod: "allowance" })]);
  seedOld(db, { doNotPursue: true });
  await applyArap(db, arWriteoffUncollectible, LATE);
  assertEqual(balanceOf(db, "1150"), BigInt(100000), "the allowance absorbs it");
  assertEqual(balanceOf(db, "6800"), BigInt(0), "and bad debt is untouched");
  assertEqual(balanceOf(db, "1100"), BigInt(-100000), "the receivable is cleared");
});

test("writeoff, sales tax comes back out proportionally", async () => {
  const db = arapDb();
  // 1,000.00 of which 80.00 is tax.
  seedOld(db, { doNotPursue: true }, { taxCents: BigInt(8000) });
  await applyArap(db, arWriteoffUncollectible, LATE);
  assertEqual(balanceOf(db, "2400"), BigInt(8000), "the tax liability reverses");
  assertEqual(balanceOf(db, "6800"), BigInt(92000), "bad debt takes the rest");
  assertEqual(balanceOf(db, "1100"), BigInt(-100000), "the whole balance clears");
  assertEqual(proposals(db)[0].taxCents, BigInt(8000), "and the split is recorded");
  assertEqual(proposals(db)[0].netCents, BigInt(92000), "on both sides");
});

test("writeoff, a partly paid invoice splits tax on the remaining balance", async () => {
  const db = arapDb();
  seedOld(
    db,
    { doNotPursue: true },
    { taxCents: BigInt(10000), appliedPaymentsCents: BigInt(50000) },
  );
  await applyArap(db, arWriteoffUncollectible, LATE);
  // Half the invoice is left, so half the tax comes back.
  assertEqual(balanceOf(db, "2400"), BigInt(5000), "half the tax");
  assertEqual(balanceOf(db, "6800"), BigInt(45000), "and the rest to bad debt");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the books foot");
});

test("writeoff, an invoice under the age threshold is not proposed", async () => {
  const db = arapDb();
  seedOld(db, { doNotPursue: true });
  // The end of January is 21 days past due, far under 180.
  const preview = await previewArap(db, arWriteoffUncollectible, {
    clientId: CLIENT_A1,
    period: "2026-01-01",
  });
  assert(
    skipDetail(preview, "INV-1", "below_age_threshold"),
    `expected below_age_threshold, got ${show(reasons(preview))}`,
  );
  assertEqual(preview.result.proposals.length, 0, "nothing was proposed");
});

test("writeoff, the threshold can be stated in the scope", async () => {
  const db = arapDb();
  seedOld(db, { doNotPursue: true });
  const preview = await previewArap(db, arWriteoffUncollectible, {
    clientId: CLIENT_A1,
    period: "2026-01-01",
    ageDays: 10,
  });
  assert(preview.result.proposals.length > 0, "a lower threshold reaches it");
});

test("writeoff, a disputed invoice is unresolved and not uncollectible", async () => {
  const db = arapDb();
  seedOld(db, { doNotPursue: true }, { inDispute: true });
  const preview = await previewArap(db, arWriteoffUncollectible, LATE);
  assert(
    skipDetail(preview, "INV-1", "invoice_in_dispute"),
    `expected invoice_in_dispute, got ${show(reasons(preview))}`,
  );
});

test("writeoff, an amount under the policy minimum is left alone", async () => {
  const db = arapDb();
  db.seed("arap_policies", [
    arapPolicy("POL-1", { writeoffMinimumCents: BigInt(50000) }),
  ]);
  seedOld(db, { doNotPursue: true }, { originalAmountCents: BigInt(2000) });
  const preview = await previewArap(db, arWriteoffUncollectible, LATE);
  assert(
    skipDetail(preview, "INV-1", "below_minimum_amount"),
    `expected below_minimum_amount, got ${show(reasons(preview))}`,
  );
});

test("writeoff, a large balance routes to the higher approval", async () => {
  const db = arapDb();
  seedOld(db, { doNotPursue: true }, { originalAmountCents: BigInt(500000) });
  await applyArap(db, arWriteoffUncollectible, LATE);
  assertEqual(
    proposals(db)[0].approvalRoute,
    "partner",
    "5,000.00 is over the tier one limit",
  );
});

test("writeoff, a rerun writes nothing off twice", async () => {
  const db = arapDb();
  seedOld(db, { doNotPursue: true });
  await applyArap(db, arWriteoffUncollectible, LATE);
  const charged = balanceOf(db, "6800");
  const second = await previewArap(db, arWriteoffUncollectible, LATE);
  assertEqual(second.result.proposals.length, 0, "nothing left to write off");
  assertEqual(balanceOf(db, "6800"), charged, "and bad debt did not grow");
  assertEqual(db.all("journal_entries").length, 1, "still one entry");
});

test("writeoff, an overridden invoice or customer is never written off", async () => {
  const db = arapDb();
  db.seed("customers", [
    customer("CUS-1", { doNotPursue: true }),
    customer("CUS-2", { doNotPursue: true, manualOverride: true }),
  ]);
  db.seed("invoices", [
    invoice("INV-1", "CUS-1", { manualOverride: true }),
    invoice("INV-2", "CUS-2"),
  ]);
  const { applied } = await applyArap(db, arWriteoffUncollectible, LATE);
  assert(
    skippedFor(applied, "INV-1", "manual_override"),
    `expected manual_override on the invoice, got ${show(reasons(applied))}`,
  );
  assert(
    skippedFor(applied, "INV-2", "manual_override"),
    "and on the invoice of an overridden customer",
  );
  assertEqual(db.all("journal_entries").length, 0, "nothing posted");
});

test("writeoff, a locked period posts nothing", async () => {
  const db = arapDb();
  seedOld(db, { doNotPursue: true });
  db.seed("period_locks", [
    lock("LK-SEP", FIRM_A, CLIENT_A1, "2026-09-01", "2026-09-30"),
  ]);
  const { applied } = await applyArap(db, arWriteoffUncollectible, LATE);
  assert(
    skippedFor(applied, "INV-1", "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "nothing posted");
});

test("writeoff, preview writes nothing", async () => {
  const db = arapDb();
  seedOld(db, { doNotPursue: true });
  const preview = await previewArap(db, arWriteoffUncollectible, LATE);
  assert(preview.result.proposals.length > 0, "it proposed work");
  assertEqual(db.all("journal_entries").length, 0, "and posted none of it");
  assertEqual(proposals(db).length, 0, "and wrote no proposal row");
});
