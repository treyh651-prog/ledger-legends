/**
 * ARAP-REFRESH-AGING. Doc 02 module 5 rules 1 through 6.
 *
 * The questions these tests answer: does a document land in the bucket its age
 * says it does, does the tie row state the difference between the subledger and
 * the control account rather than hiding it, does a second run against the same
 * date change nothing, and does a run against a different date produce a second
 * report rather than overwriting the first.
 */

import { arapRefreshAging } from "../runs/ar-refresh-aging";
import type { AgingSnapshotRow } from "../tables";
import type { MemoryRunDb } from "../db-memory";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  applyArap,
  arapDb,
  arapPolicy,
  bill,
  customer,
  creditMemo,
  invoice,
  previewArap,
  reasons,
  seedArControl,
  skipDetail,
  skippedFor,
  vendor,
  PERIOD,
  PERIOD_END,
} from "./arap-fixtures";
import { assert, assertEqual, show, test } from "./harness";

function snapshots(db: MemoryRunDb): AgingSnapshotRow[] {
  return db.all("aging_snapshots") as AgingSnapshotRow[];
}

function bucketOf(db: MemoryRunDb, documentId: string): string {
  const row = snapshots(db).find((r) => r.documentId === documentId);
  return row === undefined ? "missing" : row.bucket;
}

function tieRow(db: MemoryRunDb, side: string): AgingSnapshotRow | undefined {
  return snapshots(db).find((r) => r.bucket === "tie" && r.side === side);
}

/** One customer, one invoice, and a control account that agrees with it. */
function seedTied(db: MemoryRunDb): void {
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  seedArControl(db, "JE-1", BigInt(100000));
}

test("aging, an invoice lands in the bucket its age says", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [
    // Due the 31st. Not yet late on the 31st, so current.
    invoice("INV-CUR", "CUS-1", { dueDate: "2026-01-31" }),
    // Due the 10th. 21 days late on the 31st.
    invoice("INV-21", "CUS-1", { dueDate: "2026-01-10" }),
    // Due 1 December. 61 days late.
    invoice("INV-61", "CUS-1", {
      invoiceDate: "2025-11-01",
      dueDate: "2025-12-01",
    }),
    // Due 1 October. 122 days late.
    invoice("INV-122", "CUS-1", {
      invoiceDate: "2025-09-01",
      dueDate: "2025-10-01",
    }),
  ]);
  const { applied } = await applyArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  });
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}, reasons ${show(reasons(applied))}`,
  );
  assertEqual(bucketOf(db, "INV-CUR"), "current", "not yet due is current");
  assertEqual(bucketOf(db, "INV-21"), "b1_30", "21 days is the first bucket");
  assertEqual(bucketOf(db, "INV-61"), "b61_90", "61 days is the third bucket");
  assertEqual(bucketOf(db, "INV-122"), "b91_plus", "122 days is the last one");
});

test("aging, the bucket edges fall where doc 02 puts them", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [
    // Exactly 30 days late on the 31st.
    invoice("INV-30", "CUS-1", { dueDate: "2026-01-01" }),
    // Exactly 31 days late.
    invoice("INV-31", "CUS-1", { dueDate: "2025-12-31" }),
    // Exactly 60 days late.
    invoice("INV-60", "CUS-1", { dueDate: "2025-12-02" }),
    // Exactly 90 days late.
    invoice("INV-90", "CUS-1", { dueDate: "2025-11-02" }),
    // Exactly 91 days late.
    invoice("INV-91", "CUS-1", { dueDate: "2025-11-01" }),
  ]);
  await applyArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  });
  assertEqual(bucketOf(db, "INV-30"), "b1_30", "30 is still the first bucket");
  assertEqual(bucketOf(db, "INV-31"), "b31_60", "31 opens the second");
  assertEqual(bucketOf(db, "INV-60"), "b31_60", "60 closes the second");
  assertEqual(bucketOf(db, "INV-90"), "b61_90", "90 closes the third");
  assertEqual(bucketOf(db, "INV-91"), "b91_plus", "91 opens the last");
});

test("aging, the tie row states the difference instead of hiding it", async () => {
  const db = arapDb();
  seedTied(db);
  await applyArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  });
  const tie = tieRow(db, "receivable");
  assert(tie !== undefined, "a receivable tie row was written");
  assertEqual(tie?.controlAccount, "1100", "it names the control account");
  assertEqual(tie?.controlBalanceCents, BigInt(100000), "control balance");
  assertEqual(tie?.openBalanceCents, BigInt(100000), "subledger total");
  assertEqual(tie?.tieDifferenceCents, BigInt(0), "the two agree");
  assertEqual(tie?.subledgerOutOfTie, false, "so the gate is clear");
});

test("aging, a subledger out of tie is flagged with the signed difference", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  // The control account says 900.00 and the subledger says 1,000.00.
  seedArControl(db, "JE-1", BigInt(90000));
  await applyArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  });
  const tie = tieRow(db, "receivable");
  assertEqual(tie?.tieDifferenceCents, BigInt(10000), "subledger is 100 higher");
  assertEqual(tie?.subledgerOutOfTie, true, "and the row says so");
});

test("aging, a credit memo is its own line and never nets into a bucket", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  db.seed("credit_memos", [creditMemo("CM-1", "CUS-1")]);
  seedArControl(db, "JE-1", BigInt(95000));
  await applyArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  });
  assertEqual(bucketOf(db, "CM-1"), "credits", "the memo has its own line");
  const memoRow = snapshots(db).find((r) => r.documentId === "CM-1");
  assertEqual(memoRow?.openBalanceCents, BigInt(-5000), "and it is negative");
  assertEqual(bucketOf(db, "INV-1"), "b1_30", "the invoice is still fully late");
  const tie = tieRow(db, "receivable");
  assertEqual(tie?.openBalanceCents, BigInt(95000), "the total is net of it");
  assertEqual(tie?.tieDifferenceCents, BigInt(0), "which ties to control");
});

test("aging, a second run against the same date changes nothing", async () => {
  const db = arapDb();
  seedTied(db);
  const scope = {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  };
  await applyArap(db, arapRefreshAging, scope);
  const first = snapshots(db).length;
  const second = await previewArap(db, arapRefreshAging, scope);
  assertEqual(second.result.proposals.length, 0, "nothing left to propose");
  assert(
    second.result.skips.some((s) => s.reason === "already_applied"),
    `expected already_applied, got ${show(reasons(second))}`,
  );
  assertEqual(snapshots(db).length, first, "and no duplicate rows appeared");
});

test("aging, a moved balance rewrites the row rather than adding a second", async () => {
  const db = arapDb();
  seedTied(db);
  const scope = {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  };
  await applyArap(db, arapRefreshAging, scope);
  const before = snapshots(db).length;
  // The customer paid 400.00 of it.
  db.seed("invoices", [
    invoice("INV-1", "CUS-1", {
      version: 2,
      appliedPaymentsCents: BigInt(40000),
    }),
  ]);
  await applyArap(db, arapRefreshAging, scope);
  assertEqual(snapshots(db).length, before, "still one row per document");
  const row = snapshots(db).find((r) => r.documentId === "INV-1");
  assertEqual(row?.openBalanceCents, BigInt(60000), "rewritten in place");
});

test("aging, two dates are two reports and neither overwrites the other", async () => {
  const db = arapDb();
  seedTied(db);
  await applyArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  });
  await applyArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: "2026-02-01",
    side: "receivable" as const,
  });
  const dates = new Set(snapshots(db).map((r) => r.asOfDate));
  assertEqual(dates.size, 2, `two as of dates, got ${show([...dates])}`);
  const january = snapshots(db).filter(
    (r) => r.asOfDate === PERIOD_END && r.documentId === "INV-1",
  );
  const february = snapshots(db).filter(
    (r) => r.asOfDate === "2026-02-28" && r.documentId === "INV-1",
  );
  assertEqual(january.length, 1, "one January row");
  assertEqual(february.length, 1, "one February row");
  assertEqual(january[0].ageDays, 21, "21 days late at the end of January");
  assertEqual(february[0].ageDays, 49, "49 days late at the end of February");
});

test("aging, an overridden invoice is skipped and never aged", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [invoice("INV-1", "CUS-1", { manualOverride: true })]);
  const preview = await previewArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  });
  assert(
    skippedFor(preview, "INV-1", "manual_override"),
    `expected a manual_override skip, got ${show(reasons(preview))}`,
  );
  const rows = preview.result.proposals.filter(
    (p) => p.kind === "row_insert" && p.row.documentId === "INV-1",
  );
  assertEqual(rows.length, 0, "no snapshot was proposed for it");
});

test("aging, a locked as of date writes nothing", async () => {
  const db = arapDb();
  seedTied(db);
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await applyArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  });
  assertEqual(snapshots(db).length, 0, "no snapshot row was written");
  assert(
    applied.result.skips.every((s) => s.reason === "locked_period"),
    `every skip is locked_period, got ${show(reasons(applied))}`,
  );
});

test("aging, the payable side ages bills against the payable control", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor("VEN-1")]);
  db.seed("bills", [bill("BILL-1", "VEN-1")]);
  // A payable carries a credit balance, which is negative in this ledger.
  db.seed("journal_entries", [
    {
      id: "JE-AP",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      entryDate: "2026-01-05",
      memo: "bill",
      posted: true,
      reversalOf: null,
      reversedByEntryId: null,
      redatedFromLockedPeriod: null,
      reversesOn: null,
      linkedDocumentId: null,
      accrualTemplateId: null,
      sourceTable: "bills",
      sourceRowId: "BILL-1",
      sourceVersion: 1,
      createdByRunId: "RUNX-SEED",
      runType: "SEED",
      runVersion: 1,
    },
  ]);
  db.seed("journal_lines", [
    {
      id: "JL-AP-1",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      entryId: "JE-AP",
      accountNumber: "2000",
      categoryId: null,
      amountCents: BigInt(-100000),
      memo: "payable",
      entryDate: "2026-01-05",
      classId: null,
      locationId: null,
      programId: null,
      restriction: null,
    },
    {
      id: "JL-AP-2",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      entryId: "JE-AP",
      accountNumber: "6100",
      categoryId: null,
      amountCents: BigInt(100000),
      memo: "expense",
      entryDate: "2026-01-05",
      classId: null,
      locationId: null,
      programId: null,
      restriction: null,
    },
  ]);
  await applyArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "payable" as const,
  });
  const row = snapshots(db).find((r) => r.documentId === "BILL-1");
  assertEqual(row?.side, "payable", "the bill is on the payable side");
  assertEqual(row?.bucket, "current", "not yet due on the 31st");
  const tie = tieRow(db, "payable");
  assertEqual(tie?.controlBalanceCents, BigInt(100000), "sign corrected");
  assertEqual(tie?.tieDifferenceCents, BigInt(0), "and it ties");
  assertEqual(tieRow(db, "receivable"), undefined, "no receivable rows");
});

test("aging, a document dated after the as of date is out of scope", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  db.seed("invoices", [
    invoice("INV-FEB", "CUS-1", {
      invoiceDate: "2026-02-05",
      dueDate: "2026-03-07",
    }),
  ]);
  const preview = await previewArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  });
  assert(
    skipDetail(preview, "INV-FEB", "document_after_as_of"),
    `expected document_after_as_of, got ${show(reasons(preview))}`,
  );
});

test("aging, the policy can age on invoice date instead of due date", async () => {
  const db = arapDb();
  db.seed("arap_policies", [arapPolicy("POL-1", { agingBasis: "invoice_date" })]);
  db.seed("customers", [customer("CUS-1")]);
  // Invoiced 11 December, due 10 January. On due date basis that is 21 days
  // late, and on invoice date basis it is 51.
  db.seed("invoices", [invoice("INV-1", "CUS-1")]);
  await applyArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  });
  const row = snapshots(db).find((r) => r.documentId === "INV-1");
  assertEqual(row?.ageDays, 51, "aged from the invoice date");
  assertEqual(row?.bucket, "b31_60", "which is a different bucket");
});

test("aging, preview writes nothing", async () => {
  const db = arapDb();
  seedTied(db);
  const preview = await previewArap(db, arapRefreshAging, {
    clientId: CLIENT_A1,
    period: PERIOD,
    side: "receivable" as const,
  });
  assert(preview.result.proposals.length > 0, "it did propose work");
  assertEqual(snapshots(db).length, 0, "and wrote none of it");
});
