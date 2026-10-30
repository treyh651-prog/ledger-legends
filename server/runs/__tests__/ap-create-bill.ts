/**
 * AP-CREATE-BILL tests. The posted entry foots and lands on the right
 * accounts, a repeated bill number is a no-op rather than a double post, and
 * the run refuses cleanly on an unknown vendor, an account the client's
 * chart does not carry, and a locked bill date.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { isJournalEntry } from "../contract";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import { arapDb, balanceOf, sumLines, vendor } from "./arap-fixtures";
import { opts } from "./fixtures";
import { apCreateBill, billIdFor, type CreateBillScope } from "../runs/ap-create-bill";
import type { BillRow } from "../tables";

const VENDOR_ID = "VEN-1";

function scopeFor(extra: Partial<CreateBillScope> = {}): CreateBillScope {
  return {
    clientId: CLIENT_A1,
    vendorId: VENDOR_ID,
    billNumber: "BILL-2001",
    billDate: "2026-01-20",
    dueDate: "2026-02-19",
    amountCents: "60000",
    freightCents: "0",
    taxCents: "0",
    expenseAccount: "6100",
    discountBps: null,
    discountDays: null,
    netDays: null,
    ...extra,
  };
}

test("ap-create-bill: posts a two line entry and inserts a posted bill", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor(VENDOR_ID)]);
  const scope = scopeFor();
  const preview = await execute(db, apCreateBill, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, apCreateBill, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries.length, 1, "one entry");
  assertEqual(entries[0].lines.length, 2, "expense and payable, always two lines");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the books foot");
  assertEqual(balanceOf(db, "6100"), BigInt(60000), "expense takes the debit");
  assertEqual(balanceOf(db, "2000"), BigInt(-60000), "payable control takes the credit");

  const row = (db.all("bills") as BillRow[]).find(
    (b) => b.id === billIdFor(CLIENT_A1, scope.billNumber),
  );
  assert(row !== undefined, "the bill row exists");
  assertEqual(row?.status, "posted", "posted on creation");
  assertEqual(row?.originalAmountCents, BigInt(60000), "amount carried through");
  assertEqual(row?.vendorId, VENDOR_ID, "vendor carried through");
});

test("ap-create-bill: the same bill number twice is a no op the second time", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor(VENDOR_ID)]);
  const scope = scopeFor();
  const first = await execute(db, apCreateBill, scope, opts("preview"));
  await execute(db, apCreateBill, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, apCreateBill, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(
    second.result.skips.some((s) => s.reason === "already_applied"),
    "reported as already applied",
  );
  assertEqual((db.all("bills") as BillRow[]).length, 1, "only one bill exists");
  assertEqual(db.all("journal_entries").length, 1, "and only one entry was ever posted");
});

test("ap-create-bill: an unknown vendor is refused", async () => {
  const db = arapDb();
  const scope = scopeFor({ vendorId: "VEN-DOES-NOT-EXIST" });
  const preview = await execute(db, apCreateBill, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "UNKNOWN_VENDOR"),
    "named error code",
  );
});

test("ap-create-bill: an expense account not on the client's chart is refused", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor(VENDOR_ID)]);
  const scope = scopeFor({ expenseAccount: "6999" });
  const preview = await execute(db, apCreateBill, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "ACCOUNT_NOT_ON_CHART"),
    "named error code",
  );
});

test("ap-create-bill: a bill date inside a locked period is skipped and nothing posts", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor(VENDOR_ID)]);
  db.seed("period_locks", [lock("LOCK-1", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31")]);
  const scope = scopeFor({ billDate: "2026-01-20" });
  const preview = await execute(db, apCreateBill, scope, opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(
    preview.result.skips.some((s) => s.reason === "locked_period"),
    "reported as locked",
  );
  assertEqual((db.all("bills") as BillRow[]).length, 0, "nothing written");
});

test("ap-create-bill: discount terms must be all three or none", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor(VENDOR_ID)]);
  const scope = { ...scopeFor(), discountBps: 200 } as CreateBillScope;
  let threw = false;
  try {
    await execute(db, apCreateBill, scope, opts("preview"));
  } catch {
    threw = true;
  }
  assert(threw, "the scope schema itself refuses a partial set of discount terms");
  assertEqual((db.all("bills") as BillRow[]).length, 0, "nothing written");
});
