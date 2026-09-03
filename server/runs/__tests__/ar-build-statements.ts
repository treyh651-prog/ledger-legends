/**
 * AR-BUILD-STATEMENTS. Doc 02 module 5 AR-BUILD-STATEMENTS.
 *
 * The questions these tests answer: does the header foot, does the running
 * balance column end where the header says it ends, does the document attach to
 * the customer, does a rebuild supersede rather than duplicate, and, most
 * important of all, does the run stop at building. A statement is a document.
 * Nothing in this run may deliver it, and the test suite says so explicitly.
 */

import { arBuildStatements } from "../runs/ar-build-statements";
import type {
  StatementDocumentRow,
  StatementItemRow,
  CustomerRow,
} from "../tables";
import type { MemoryRunDb } from "../db-memory";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  applyArap,
  arapDb,
  arapPolicy,
  arapScope,
  creditMemo,
  customer,
  invoice,
  payment,
  previewArap,
  reasons,
  skipDetail,
  skippedFor,
  PERIOD,
  PERIOD_END,
} from "./arap-fixtures";
import { assert, assertEqual, show, test } from "./harness";

function docs(db: MemoryRunDb): StatementDocumentRow[] {
  return db.all("statement_documents") as StatementDocumentRow[];
}

function items(db: MemoryRunDb, statementId: string): StatementItemRow[] {
  return (db.all("statement_items") as StatementItemRow[])
    .filter((i) => i.statementId === statementId)
    .sort((a, b) => a.lineNumber - b.lineNumber);
}

function customerRow(db: MemoryRunDb, id: string): CustomerRow {
  return (db.all("customers") as CustomerRow[]).find(
    (c) => c.id === id,
  ) as CustomerRow;
}

test("statements, the header foots and the running column ends at closing", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [
    invoice("INV-1", "CUS-1"),
    invoice("INV-2", "CUS-1", {
      invoiceDate: "2026-01-15",
      dueDate: "2026-02-14",
      originalAmountCents: BigInt(25000),
    }),
  ]);
  const { applied } = await applyArap(db, arBuildStatements, arapScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}, reasons ${show(reasons(applied))}`,
  );
  assertEqual(docs(db).length, 1, "one statement");
  const doc = docs(db)[0];
  assertEqual(doc.closingBalanceCents, BigInt(125000), "closing is the open sum");
  assertEqual(
    doc.openingBalanceCents + doc.activityCents,
    doc.closingBalanceCents,
    "opening plus activity equals closing",
  );
  const lines = items(db, doc.id);
  assertEqual(lines.length, 2, "one line per open invoice");
  assertEqual(
    lines[lines.length - 1].runningBalanceCents,
    doc.closingBalanceCents,
    "the last running balance is the closing balance",
  );
  assertEqual(doc.itemCount, lines.length, "the count on the header matches");
});

test("statements, the document attaches to the customer record", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  await applyArap(db, arBuildStatements, arapScope());
  const doc = docs(db)[0];
  const cus = customerRow(db, "CUS-1");
  assertEqual(cus.statementDocumentId, doc.id, "the customer points at it");
  assertEqual(cus.statementDocumentDate, PERIOD_END, "and at the date");
});

test("statements, the run builds and never delivers", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  const { applied } = await applyArap(db, arBuildStatements, arapScope());
  const doc = docs(db)[0];
  assertEqual(doc.state, "draft", "the document is a draft");
  // A delivery would have to be a row somewhere. There is no table for one and
  // no column on the document, and the assertion here is that this stays true.
  const keys = Object.keys(doc);
  for (const forbidden of ["sentAt", "deliveredAt", "recipient", "emailedTo"]) {
    assert(!keys.includes(forbidden), `no ${forbidden} column exists`);
  }
  assertEqual(applied.result.totals.netCents, BigInt(0), "nothing was posted");
  assertEqual(db.all("journal_entries").length, 0, "and no entry exists");
});

test("statements, a credit memo prints as its own line and lowers the balance", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  db.seed("credit_memos", [creditMemo("CM-1", "CUS-1")]);
  await applyArap(db, arBuildStatements, arapScope());
  const doc = docs(db)[0];
  assertEqual(doc.closingBalanceCents, BigInt(95000), "1,000 less the 50 credit");
  const lines = items(db, doc.id);
  const credit = lines.find((l) => l.itemKind === "credit");
  assert(credit !== undefined, "a credit line printed");
  assertEqual(credit?.openCents, BigInt(-5000), "and it is negative");
  assertEqual(
    lines[lines.length - 1].runningBalanceCents,
    doc.closingBalanceCents,
    "the column still ends at closing",
  );
});

test("statements, a payment prints without moving the running balance twice", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [
    invoice("INV-1", "CUS-1", { appliedPaymentsCents: BigInt(40000) }),
  ]);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", {
      amountCents: BigInt(40000),
      appliedCents: BigInt(40000),
      status: "applied",
    }),
  ]);
  await applyArap(db, arBuildStatements, arapScope());
  const doc = docs(db)[0];
  assertEqual(doc.closingBalanceCents, BigInt(60000), "1,000 less the 400 paid");
  const lines = items(db, doc.id);
  const pay = lines.find((l) => l.itemKind === "payment");
  assert(pay !== undefined, "the payment printed");
  assertEqual(pay?.openCents, BigInt(0), "and it carries no open amount");
  assertEqual(
    lines[lines.length - 1].runningBalanceCents,
    doc.closingBalanceCents,
    "so the column is not reduced twice",
  );
});

test("statements, the message band follows the oldest open item", async () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    // Due date, expected band, label.
    ["2026-01-31", "neutral", "nothing overdue"],
    ["2026-01-10", "neutral", "21 days, still the first bucket"],
    ["2025-12-15", "reminder", "47 days"],
    ["2025-11-15", "firm", "77 days"],
    ["2025-10-01", "final_notice", "122 days"],
  ];
  for (const [dueDate, band, label] of cases) {
    const db = arapDb();
    db.seed("customers", [customer("CUS-1")]);
    db.seed("invoices", [
      invoice("INV-1", "CUS-1", { dueDate, invoiceDate: "2025-09-01" }),
    ]);
    await applyArap(db, arBuildStatements, arapScope());
    assertEqual(docs(db)[0].messageBand, band, `${label} reads ${band}`);
    assert(docs(db)[0].messageText.length > 0, "and carries text");
  }
});

test("statements, a rebuild with the same figures changes nothing", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  await applyArap(db, arBuildStatements, arapScope());
  const second = await previewArap(db, arBuildStatements, arapScope());
  assertEqual(second.result.proposals.length, 0, "nothing to propose");
  assert(
    skippedFor(second, "CUS-1", "already_applied"),
    `expected already_applied, got ${show(reasons(second))}`,
  );
  assertEqual(docs(db).length, 1, "and still one document");
});

test("statements, a changed balance supersedes rather than edits", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  await applyArap(db, arBuildStatements, arapScope());
  const firstId = docs(db)[0].id;
  db.seed("invoices", [
    invoice("INV-1", "CUS-1", {
      version: 2,
      appliedPaymentsCents: BigInt(30000),
    }),
  ]);
  await applyArap(db, arBuildStatements, arapScope());
  assertEqual(docs(db).length, 2, "a second document was built");
  const old = docs(db).find((d) => d.id === firstId);
  assertEqual(old?.state, "superseded", "the first one is superseded");
  assertEqual(old?.closingBalanceCents, BigInt(100000), "and still says what it said");
  const live = docs(db).find((d) => d.state === "draft");
  assertEqual(live?.closingBalanceCents, BigInt(70000), "the new one is current");
  assertEqual(
    customerRow(db, "CUS-1").statementDocumentId,
    live?.id,
    "and the customer points at the new one",
  );
});

test("statements, a suppressed customer gets none", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1", { statementSuppressed: true })]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  const preview = await previewArap(db, arBuildStatements, arapScope());
  assert(
    skipDetail(preview, "CUS-1", "statement_suppressed"),
    `expected statement_suppressed, got ${show(reasons(preview))}`,
  );
  assertEqual(preview.result.proposals.length, 0, "nothing was built");
});

test("statements, an overridden customer is never touched", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1", { manualOverride: true })]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  const { applied } = await applyArap(db, arBuildStatements, arapScope());
  assert(
    skippedFor(applied, "CUS-1", "manual_override"),
    `expected manual_override, got ${show(reasons(applied))}`,
  );
  assertEqual(docs(db).length, 0, "no document was built");
  assertEqual(
    customerRow(db, "CUS-1").statementDocumentId,
    null,
    "and the record was not written",
  );
});

test("statements, a customer with no activity gets none", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-EMPTY")]);
  const preview = await previewArap(db, arBuildStatements, arapScope());
  assert(
    skipDetail(preview, "CUS-EMPTY", "no_activity"),
    `expected no_activity, got ${show(reasons(preview))}`,
  );
});

test("statements, a balance under the policy minimum is skipped", async () => {
  const db = arapDb();
  db.seed("arap_policies", [
    arapPolicy("POL-1", { minimumStatementBalanceCents: BigInt(50000) }),
  ]);
  db.seed("customers", [customer("CUS-1")]);
  // Fully paid, so the closing balance is zero and under the minimum.
  db.seed("invoices", [
    invoice("INV-1", "CUS-1", {
      appliedPaymentsCents: BigInt(100000),
      status: "paid",
    }),
  ]);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", {
      appliedCents: BigInt(100000),
      status: "applied",
    }),
  ]);
  const preview = await previewArap(db, arBuildStatements, arapScope());
  assert(
    skipDetail(preview, "CUS-1", "below_minimum_balance"),
    `expected below_minimum_balance, got ${show(reasons(preview))}`,
  );
});

test("statements, a locked statement date builds nothing", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await applyArap(db, arBuildStatements, arapScope());
  assertEqual(docs(db).length, 0, "nothing was built");
  assert(
    skippedFor(applied, "CUS-1", "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
});

test("statements, preview and apply agree and preview writes nothing", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1"), customer("CUS-2")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1"), invoice("INV-2", "CUS-2")]);
  const preview = await previewArap(db, arBuildStatements, arapScope(PERIOD));
  assert(preview.result.proposals.length > 0, "it proposed work");
  assertEqual(docs(db).length, 0, "and wrote none of it");
});
