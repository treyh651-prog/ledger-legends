/**
 * The module 5 pipeline. All six AR and AP runs, in the AR_AP_ORDER order,
 * against one January for one client.
 *
 * The batch is built so every number in it can be checked by hand. Four
 * receivable invoices and one credit memo open the period, and one payable bill
 * sits on 2/10 net 30 terms:
 *
 *   INV-CUR    100000  CUS-1, due 10 January, paid in full by PAY-1
 *   INV-LATE    60000  CUS-1, due 15 November, 77 days old, fees enabled
 *   INV-BAD     40000  CUS-2, due 1 June, and CUS-2 is do_not_pursue
 *   INV-PLAIN   25000  CUS-3, due 1 June, and nobody has approved anything
 *   CM-1         5000  CUS-1, an open credit memo
 *   BILL-1     100000  VEN-1, dated 5 January, paid on the 12th
 *
 * So the receivable control opens at 220000, being 225000 of invoices less the
 * 5000 credit. The payment takes 100000 out of it and the write off takes
 * 40000, which leaves 80000. That 80000 is the number every one of the last
 * three runs has to agree with: the aging total, the tie row, and the sum of
 * the statement closing balances.
 *
 * The late fee is prepared as a draft invoice and posts no entry, so it is
 * deliberately absent from all three of those totals. That is the point of it
 * being a draft.
 */

import { AR_AP_ORDER } from "../registry";
import { apApplyEarlyDiscount } from "../runs/ap-apply-earlydiscount";
import { arApplyPayments } from "../runs/ar-apply-payments";
import { arBuildStatements } from "../runs/ar-build-statements";
import { arChargeLateFees } from "../runs/ar-charge-latefees";
import { arapRefreshAging } from "../runs/ar-refresh-aging";
import { arWriteoffUncollectible } from "../runs/ar-writeoff-uncollectible";
import type {
  AgingSnapshotRow,
  BillRow,
  InvoiceRow,
  StatementDocumentRow,
} from "../tables";
import type { MemoryRunDb } from "../db-memory";
import { CLIENT_A1 } from "./fixtures";
import {
  applyArap,
  arEntry,
  arLine,
  arapDb,
  arapScope,
  balanceOf,
  bill,
  creditMemo,
  customer,
  invoice,
  payment,
  seedArControl,
  sumLines,
  vendor,
  PERIOD,
  PERIOD_END,
} from "./arap-fixtures";
import { assert, assertEqual, show, test } from "./harness";

const OPENING_AR = BigInt(220000);
const PAID = BigInt(100000);
const WRITTEN_OFF = BigInt(40000);
/** What the receivable is worth once the cash and the write off have landed. */
const CLOSING_AR = OPENING_AR - PAID - WRITTEN_OFF;
const DISCOUNT = BigInt(2000);
const BILL_TOTAL = BigInt(100000);

/** One entry that puts a payable on the books, so the payable side can tie. */
function seedApControl(db: MemoryRunDb, id: string, amountCents: bigint): void {
  db.seed("journal_entries", [...db.all("journal_entries"), arEntry(id, "2026-01-05")]);
  db.seed("journal_lines", [
    ...db.all("journal_lines"),
    arLine(`${id}-L1`, id, "2000", -amountCents, "2026-01-05"),
    arLine(`${id}-L2`, id, "6100", amountCents, "2026-01-05"),
  ]);
}

function pipelineDb(): MemoryRunDb {
  const db = arapDb();
  db.seed("customers", [
    customer("CUS-1", { lateFeeEnabled: true, annualizedRateBp: 1800 }),
    customer("CUS-2", { doNotPursue: true }),
    customer("CUS-3"),
  ]);
  db.seed("invoices", [
    invoice("INV-CUR", "CUS-1"),
    invoice("INV-LATE", "CUS-1", {
      invoiceDate: "2025-10-15",
      dueDate: "2025-11-15",
      originalAmountCents: BigInt(60000),
    }),
    invoice("INV-BAD", "CUS-2", {
      invoiceDate: "2025-05-01",
      dueDate: "2025-06-01",
      originalAmountCents: BigInt(40000),
    }),
    invoice("INV-PLAIN", "CUS-3", {
      invoiceDate: "2025-05-01",
      dueDate: "2025-06-01",
      originalAmountCents: BigInt(25000),
    }),
  ]);
  db.seed("credit_memos", [creditMemo("CM-1", "CUS-1")]);
  db.seed("customer_payments", [
    payment("PAY-1", "CUS-1", { amountCents: PAID, matchHint: "INV-CUR" }),
  ]);
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [bill("BILL-1", "VEN-1")]);
  // The opening ledger: the four invoices as debits and the credit memo back
  // out again, plus the bill as a payable.
  seedArControl(db, "JE-INV", BigInt(225000));
  seedArControl(db, "JE-CM", BigInt(-5000));
  seedApControl(db, "JE-BILL", BILL_TOTAL);
  return db;
}

/** Every run in the module, in the registry order, in apply mode. */
async function runAll(db: MemoryRunDb): Promise<void> {
  await applyArap(db, arApplyPayments, arapScope());
  await applyArap(db, apApplyEarlyDiscount, {
    clientId: CLIENT_A1,
    period: PERIOD,
    payDay: "2026-01-12",
  });
  await applyArap(db, arChargeLateFees, arapScope());
  await applyArap(db, arWriteoffUncollectible, arapScope());
  await applyArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "both" as const,
  });
  await applyArap(db, arBuildStatements, arapScope());
}

function snapshots(db: MemoryRunDb): AgingSnapshotRow[] {
  return db.all("aging_snapshots") as AgingSnapshotRow[];
}

function documentRows(db: MemoryRunDb): StatementDocumentRow[] {
  return (db.all("statement_documents") as StatementDocumentRow[]).filter(
    (d) => d.state === "draft",
  );
}

function invoiceRow(db: MemoryRunDb, id: string): InvoiceRow {
  return (db.all("invoices") as InvoiceRow[]).find(
    (i) => i.id === id,
  ) as InvoiceRow;
}

function feeInvoices(db: MemoryRunDb): InvoiceRow[] {
  return (db.all("invoices") as InvoiceRow[]).filter((i) => i.isLateFee);
}

test("pipeline, the order the module runs in is the order the registry states", () => {
  assertEqual(
    show(AR_AP_ORDER),
    show([
      "AR-APPLY-PAYMENTS",
      "AP-APPLY-DISCOUNTS",
      "AR-CHARGE-LATEFEES",
      "AR-WRITEOFF-UNCOLLECTIBLE",
      "ARAP-REFRESH-AGING",
      "AR-BUILD-STATEMENTS",
    ]),
    "cash, then discounts, then fees, then write offs, then the reports",
  );
});

test("pipeline, the whole module leaves the books footing", async () => {
  const db = pipelineDb();
  await runAll(db);
  assertEqual(
    sumLines(db.all("journal_lines")),
    BigInt(0),
    "every entry in the module balances and so does the batch",
  );
});

test("pipeline, the receivable control ends where the arithmetic says", async () => {
  const db = pipelineDb();
  assertEqual(balanceOf(db, "1100"), OPENING_AR, "the opening receivable");
  await runAll(db);
  assertEqual(
    balanceOf(db, "1100"),
    CLOSING_AR,
    "less the cash applied and the balance written off",
  );
  assertEqual(CLOSING_AR, BigInt(80000), "which is 80000");
});

test("pipeline, the aging total ties to the receivable control", async () => {
  const db = pipelineDb();
  await runAll(db);
  const receivable = snapshots(db).filter((r) => r.side === "receivable");
  const detail = receivable.filter((r) => r.bucket !== "tie");
  let total = BigInt(0);
  for (const row of detail) total += row.openBalanceCents;
  assertEqual(total, CLOSING_AR, "the aging buckets sum to the control");

  const tie = receivable.find((r) => r.bucket === "tie");
  assert(tie !== undefined, "a tie row was written");
  assertEqual(tie?.openBalanceCents, CLOSING_AR, "the tie row agrees");
  assertEqual(tie?.controlBalanceCents, CLOSING_AR, "so does the ledger");
  assertEqual(tie?.tieDifferenceCents, BigInt(0), "there is no difference");
  assertEqual(tie?.subledgerOutOfTie, false, "so nothing is flagged");
});

test("pipeline, the payable side ties once the bill is settled", async () => {
  const db = pipelineDb();
  await runAll(db);
  assertEqual(balanceOf(db, "2000"), BigInt(0), "the payable is discharged");
  const tie = snapshots(db).find(
    (r) => r.side === "payable" && r.bucket === "tie",
  );
  if (tie !== undefined) {
    assertEqual(tie.tieDifferenceCents, BigInt(0), "and the tie row agrees");
    assertEqual(tie.subledgerOutOfTie, false, "so nothing is flagged");
  }
});

test("pipeline, the statement closing balances sum to the aging total", async () => {
  const db = pipelineDb();
  await runAll(db);
  let closing = BigInt(0);
  for (const doc of documentRows(db)) closing += doc.closingBalanceCents;
  assertEqual(
    closing,
    CLOSING_AR,
    "the customers between them owe what the control says",
  );
  const one = documentRows(db).find((d) => d.customerId === "CUS-1");
  assertEqual(
    one?.closingBalanceCents,
    BigInt(55000),
    "and the one with a credit memo is net of it",
  );
});

test("pipeline, every statement header foots on its own", async () => {
  const db = pipelineDb();
  await runAll(db);
  for (const doc of documentRows(db)) {
    assertEqual(
      doc.openingBalanceCents + doc.activityCents,
      doc.closingBalanceCents,
      `the header of ${doc.customerId} foots`,
    );
  }
});

test("pipeline, a statement is built and nothing is sent", async () => {
  const db = pipelineDb();
  await runAll(db);
  assert(documentRows(db).length > 0, "documents were built");
  const columns = Object.keys(documentRows(db)[0]).join(" ").toLowerCase();
  for (const banned of ["sent", "email", "deliver", "recipient"]) {
    assert(
      !columns.includes(banned),
      `a statement document carries no ${banned} field`,
    );
  }
});

test("pipeline, the AP discount reduces the bill balance without breaking foot", async () => {
  const db = pipelineDb();
  await runAll(db);
  const row = (db.all("bills") as BillRow[])[0];
  assertEqual(row.discountTakenCents, DISCOUNT, "two percent was taken");
  assertEqual(row.paidCents, BILL_TOTAL - DISCOUNT, "and the net was paid");
  assertEqual(
    row.originalAmountCents - row.paidCents - row.discountTakenCents - row.creditsCents,
    BigInt(0),
    "so the bill owes nothing",
  );
  assertEqual(balanceOf(db, "8200"), -DISCOUNT, "the discount is income");
  assertEqual(balanceOf(db, "1010"), -(BILL_TOTAL - DISCOUNT), "cash paid the net");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "and foot holds");
});

test("pipeline, late fees do not double when the module runs twice", async () => {
  const db = pipelineDb();
  await runAll(db);
  const first = feeInvoices(db);
  assertEqual(first.length, 1, "one fee was prepared");
  assertEqual(first[0].parentInvoiceId, "INV-LATE", "on the one late invoice");
  assertEqual(first[0].feeMonths, 2, "two thirty day blocks past grace");
  assertEqual(first[0].status, "draft", "and it waits for a person");
  const charged = first[0].originalAmountCents;

  await runAll(db);
  const second = feeInvoices(db);
  assertEqual(second.length, 1, "the second pass prepared nothing new");
  let months = 0;
  let total = BigInt(0);
  for (const f of second) {
    months += f.feeMonths ?? 0;
    total += f.originalAmountCents;
  }
  assertEqual(months, 2, "still two blocks");
  assertEqual(total, charged, "and still the same amount");
});

test("pipeline, a fee posts nothing and stays out of the aging and the statements", async () => {
  const db = pipelineDb();
  await runAll(db);
  assertEqual(balanceOf(db, "4200"), BigInt(0), "no fee revenue was recognised");
  const feeId = feeInvoices(db)[0].id;
  assert(
    !snapshots(db).some((r) => r.documentId === feeId),
    "the draft fee is not in the aging",
  );
  assertEqual(
    documentRows(db).find((d) => d.customerId === "CUS-1")
      ?.closingBalanceCents,
    BigInt(55000),
    "nor in the statement balance",
  );
});

test("pipeline, write offs touch only the flagged rows", async () => {
  const db = pipelineDb();
  await runAll(db);
  assertEqual(
    invoiceRow(db, "INV-BAD").status,
    "written_off",
    "the do_not_pursue customer's invoice went",
  );
  assertEqual(
    invoiceRow(db, "INV-PLAIN").status,
    "posted",
    "and the one with no authority did not",
  );
  assertEqual(
    invoiceRow(db, "INV-LATE").writtenOffCents,
    BigInt(0),
    "nor did the merely late one",
  );
  assertEqual(balanceOf(db, "6800"), WRITTEN_OFF, "bad debt took only the one");
});

test("pipeline, the second pass proposes nothing anywhere", async () => {
  const db = pipelineDb();
  await runAll(db);
  const entries = db.all("journal_entries").length;
  const ar = balanceOf(db, "1100");
  await runAll(db);
  assertEqual(
    db.all("journal_entries").length,
    entries,
    "no run posted a second entry",
  );
  assertEqual(balanceOf(db, "1100"), ar, "and the receivable did not move");
  assertEqual(
    snapshots(db).filter((r) => r.side === "receivable" && r.bucket === "tie")
      .length,
    1,
    "the aging rebuilt in place rather than piling up",
  );
  assertEqual(documentRows(db).length, 2, "and so did the statements");
});

test("pipeline, the aging is dated to the period end and not to today", async () => {
  const db = pipelineDb();
  await runAll(db);
  for (const row of snapshots(db)) {
    assertEqual(row.asOfDate, PERIOD_END, "every row is as of the period end");
  }
  for (const doc of documentRows(db)) {
    assertEqual(doc.statementDate, PERIOD_END, "and so is every statement");
  }
});
