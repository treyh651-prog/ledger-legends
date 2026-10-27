/**
 * AR-CREATE-INVOICE tests. The posted entry foots and lands on the right
 * accounts, tax splits correctly, a repeated invoice number is a no-op
 * rather than a double post, and the run refuses cleanly on an unknown
 * customer, an account the client's chart does not carry, and a locked
 * invoice date.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { isJournalEntry } from "../contract";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import { arapDb, balanceOf, customer, sumLines } from "./arap-fixtures";
import { opts } from "./fixtures";
import { arCreateInvoice, invoiceIdFor, type CreateInvoiceScope } from "../runs/ar-create-invoice";
import type { InvoiceRow } from "../tables";

const CUSTOMER_ID = "CUS-1";

function scopeFor(extra: Partial<CreateInvoiceScope> = {}): CreateInvoiceScope {
  return {
    clientId: CLIENT_A1,
    customerId: CUSTOMER_ID,
    invoiceNumber: "INV-1001",
    invoiceDate: "2026-01-15",
    dueDate: "2026-02-14",
    amountCents: "100000",
    taxCents: "0",
    revenueAccount: "4100",
    ...extra,
  };
}

test("ar-create-invoice: posts a two line entry and inserts a posted invoice", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  const scope = scopeFor();
  const preview = await execute(db, arCreateInvoice, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, arCreateInvoice, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries.length, 1, "one entry");
  assertEqual(entries[0].lines.length, 2, "no tax line when there is no tax");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the books foot");
  assertEqual(balanceOf(db, "1100"), BigInt(100000), "receivable control takes the debit");
  assertEqual(balanceOf(db, "4100"), BigInt(-100000), "revenue takes the full credit");

  const row = (db.all("invoices") as InvoiceRow[]).find(
    (i) => i.id === invoiceIdFor(CLIENT_A1, scope.invoiceNumber),
  );
  assert(row !== undefined, "the invoice row exists");
  assertEqual(row?.status, "posted", "posted on creation");
  assertEqual(row?.originalAmountCents, BigInt(100000), "amount carried through");
});

test("ar-create-invoice: tax splits between revenue and the sales tax account", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  const scope = scopeFor({ amountCents: "108000", taxCents: "8000" });
  const preview = await execute(db, arCreateInvoice, scope, opts("preview"));
  const applied = await execute(db, arCreateInvoice, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries[0].lines.length, 3, "AR, revenue, and sales tax");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the books foot");
  assertEqual(balanceOf(db, "1100"), BigInt(108000), "receivable takes the full billed amount");
  assertEqual(balanceOf(db, "4100"), BigInt(-100000), "revenue takes the net of tax");
  assertEqual(balanceOf(db, "2400"), BigInt(-8000), "sales tax payable takes the tax portion");
});

test("ar-create-invoice: the same invoice number twice is a no op the second time", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  const scope = scopeFor();
  const first = await execute(db, arCreateInvoice, scope, opts("preview"));
  await execute(db, arCreateInvoice, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, arCreateInvoice, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(
    second.result.skips.some((s) => s.reason === "already_applied"),
    "reported as already applied",
  );
  assertEqual((db.all("invoices") as InvoiceRow[]).length, 1, "only one invoice exists");
  assertEqual((db.all("journal_entries")).length, 1, "and only one entry was ever posted");
});

test("ar-create-invoice: an unknown customer is refused", async () => {
  const db = arapDb();
  const scope = scopeFor({ customerId: "CUS-DOES-NOT-EXIST" });
  const preview = await execute(db, arCreateInvoice, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "UNKNOWN_CUSTOMER"),
    "named error code",
  );
});

test("ar-create-invoice: a revenue account not on the client's chart is refused", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  const scope = scopeFor({ revenueAccount: "4999" });
  const preview = await execute(db, arCreateInvoice, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "ACCOUNT_NOT_ON_CHART"),
    "named error code",
  );
});

test("ar-create-invoice: an invoice date inside a locked period is skipped and nothing posts", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  db.seed("period_locks", [lock("LOCK-1", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31")]);
  const scope = scopeFor({ invoiceDate: "2026-01-15" });
  const preview = await execute(db, arCreateInvoice, scope, opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(
    preview.result.skips.some((s) => s.reason === "locked_period"),
    "reported as locked",
  );
  assertEqual((db.all("invoices") as InvoiceRow[]).length, 0, "nothing written");
});
