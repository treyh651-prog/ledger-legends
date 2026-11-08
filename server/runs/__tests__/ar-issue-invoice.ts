/**
 * AR-ISSUE-INVOICE tests. Audit finding: AR-CHARGE-LATEFEES creates a fee
 * invoice as status draft with no way for it to ever become revenue. These
 * tests prove the gap is actually closed: a real draft invoice, created by
 * the real AR-CHARGE-LATEFEES run (not hand seeded), reaches the ledger
 * through this run and nowhere else.
 */

import { assert, assertEqual, test } from "./harness";
import { isJournalEntry } from "../contract";
import { arChargeLateFees } from "../runs/ar-charge-latefees";
import { arIssueInvoice, issueInvoiceEntryIdFor, type IssueInvoiceScope } from "../runs/ar-issue-invoice";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  applyArap,
  arapDb,
  arapPolicy,
  arapScope,
  balanceOf,
  customer,
  invoice,
  previewArap,
  skippedFor,
  sumLines,
} from "./arap-fixtures";
import type { InvoiceRow } from "../tables";
import type { MemoryRunDb } from "../db-memory";

function scopeFor(invoiceId: string): IssueInvoiceScope {
  return { clientId: CLIENT_A1, invoiceId };
}

function draftFee(db: MemoryRunDb): InvoiceRow {
  return (db.all("invoices") as InvoiceRow[]).find((i) => i.isLateFee)!;
}

/** A real draft late fee, produced by the real run, not hand seeded. */
async function seedRealDraftFee(db: MemoryRunDb): Promise<InvoiceRow> {
  db.seed("customers", [customer("CUS-1", { lateFeeEnabled: true, annualizedRateBp: 1800 })]);
  db.seed("invoices", [
    invoice("INV-1", "CUS-1", { invoiceDate: "2025-11-01", dueDate: "2025-12-01" }),
  ]);
  await applyArap(db, arChargeLateFees, arapScope());
  return draftFee(db);
}

test("ar-issue-invoice: a real late fee draft, created by AR-CHARGE-LATEFEES, is posted and becomes revenue", async () => {
  const db = arapDb();
  const fee = await seedRealDraftFee(db);
  assertEqual(fee.status, "draft", "really a draft, not hand seeded as one");
  assertEqual(db.all("journal_entries").length, 0, "nothing posted yet, the exact audit complaint");

  const preview = await previewArap(db, arIssueInvoice, scopeFor(fee.id));
  assertEqual(preview.status, "completed", "preview completed");
  const { applied } = await applyArap(db, arIssueInvoice, scopeFor(fee.id));
  assertEqual(applied.status, "completed", "apply completed");

  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries.length, 1, "one entry");
  assertEqual(entries[0].targetId, issueInvoiceEntryIdFor(fee.id), "a deterministic entry id");
  assertEqual(entries[0].lines.length, 2, "no tax line, late fees never carry tax");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the books foot");
  assertEqual(balanceOf(db, fee.arAccount), fee.originalAmountCents, "receivable took the debit");
  assertEqual(balanceOf(db, fee.revenueAccount), -fee.originalAmountCents, "the fee is now real revenue");

  const after = (db.all("invoices") as InvoiceRow[]).find((i) => i.id === fee.id)!;
  assertEqual(after.status, "posted", "no longer a draft");
});

test("ar-issue-invoice: tax splits between revenue and the sales tax account", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("arap_policies", [arapPolicy("POL-1")]);
  db.seed("invoices", [
    invoice("INV-DRAFT", "CUS-1", { status: "draft", originalAmountCents: BigInt(108000), taxCents: BigInt(8000) }),
  ]);
  const { applied } = await applyArap(db, arIssueInvoice, scopeFor("INV-DRAFT"));
  assertEqual(applied.status, "completed", "apply completed");
  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries[0].lines.length, 3, "AR, revenue, and sales tax");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the books foot");
  assertEqual(balanceOf(db, "1100"), BigInt(108000), "receivable takes the full amount");
  assertEqual(balanceOf(db, "4100"), BigInt(-100000), "revenue takes the net of tax");
  assertEqual(balanceOf(db, "2400"), BigInt(-8000), "sales tax takes the rest");
});

test("ar-issue-invoice: an unknown invoice id is refused", async () => {
  const db = arapDb();
  const out = await previewArap(db, arIssueInvoice, scopeFor("NOPE"));
  assertEqual(out.status, "refused", "refused");
  assertEqual(out.result.errors[0]?.code, "AR_ISSUE_UNKNOWN_INVOICE", "named");
});

test("ar-issue-invoice: an invoice that is not draft is a no op", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-POSTED", "CUS-1", { status: "posted" })]);
  const out = await previewArap(db, arIssueInvoice, scopeFor("INV-POSTED"));
  assertEqual(out.status, "no_op", "already posted, nothing to do");
  assert(skippedFor(out, "INV-POSTED", "already_applied"), "and it says why");
});

test("ar-issue-invoice: a manually overridden draft is left alone", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-OVR", "CUS-1", { status: "draft", manualOverride: true })]);
  const out = await previewArap(db, arIssueInvoice, scopeFor("INV-OVR"));
  assert(skippedFor(out, "INV-OVR", "manual_override"), "the override guard, not a silent post");
  assertEqual(db.all("journal_entries").length, 0, "nothing posted");
});

test("ar-issue-invoice: a draft whose invoice date is now locked is skipped, not posted into a closed month", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-LOCKED", "CUS-1", { status: "draft", invoiceDate: "2025-12-15" })]);
  db.seed("period_locks", [lock("PL-DEC", FIRM_A, CLIENT_A1, "2025-12-01", "2025-12-31")]);
  const out = await previewArap(db, arIssueInvoice, scopeFor("INV-LOCKED"));
  assert(skippedFor(out, "INV-LOCKED", "locked_period"), "the lock, not a post into a closed month");
});

test("ar-issue-invoice: a missing account on the chart refuses rather than posting a broken entry", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-BAD", "CUS-1", { status: "draft", revenueAccount: "9999" })]);
  const out = await previewArap(db, arIssueInvoice, scopeFor("INV-BAD"));
  assertEqual(out.status, "refused", "refused");
  assertEqual(out.result.errors[0]?.code, "AR_ISSUE_ACCOUNT_NOT_ON_CHART", "named");
});

test("ar-issue-invoice: running it twice issues once", async () => {
  const db = arapDb();
  const fee = await seedRealDraftFee(db);
  await applyArap(db, arIssueInvoice, scopeFor(fee.id));
  const second = await previewArap(db, arIssueInvoice, scopeFor(fee.id));
  assertEqual(second.status, "no_op", "already posted the second time");
  assertEqual(db.all("journal_entries").length, 1, "still only one entry");
});
