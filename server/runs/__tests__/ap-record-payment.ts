/**
 * AP-RECORD-PAYMENT tests. The payable mirror of ar-record-payment.ts: the
 * insert pulls its amount and date from the register transaction, a repeat
 * naming the same transaction is a no-op, and the run refuses cleanly on an
 * unknown transaction, money moving the wrong direction, an uncoded
 * transaction, and an unknown vendor. The last test is the proof that
 * matters most: once this run has recorded a payment, AP-APPLY-PAYMENTS can
 * actually apply it, which was impossible before either run existed.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, txn } from "./fixtures";
import { arapDb, bill, vendor } from "./arap-fixtures";
import { opts } from "./fixtures";
import {
  apRecordPayment,
  vendorPaymentIdFor,
  type ApRecordPaymentScope,
} from "../runs/ap-record-payment";
import { apApplyPayments } from "../runs/ap-apply-payments";
import type { VendorPaymentRow } from "../tables";

const VENDOR_ID = "VEN-1";
const TRANSACTION_ID = "TX-WITHDRAWAL-1";

function seedWithdrawal(
  amountCents: bigint = BigInt(-100000),
  extra: Record<string, unknown> = {},
) {
  return txn(TRANSACTION_ID, FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-20", amountCents, {
    categoryId: "1910",
    ...extra,
  });
}

function scopeFor(extra: Partial<ApRecordPaymentScope> = {}): ApRecordPaymentScope {
  return {
    clientId: CLIENT_A1,
    vendorId: VENDOR_ID,
    transactionId: TRANSACTION_ID,
    matchHint: null,
    onHold: false,
    ...extra,
  };
}

test("ap-record-payment: a new payment is inserted from the transaction's own amount and date", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor(VENDOR_ID)]);
  db.seed("transactions", [seedWithdrawal()]);
  const scope = scopeFor();
  const preview = await execute(db, apRecordPayment, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, apRecordPayment, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const row = (db.all("vendor_payments") as VendorPaymentRow[]).find(
    (p) => p.id === vendorPaymentIdFor(CLIENT_A1, TRANSACTION_ID),
  );
  assert(row !== undefined, "the payment row exists");
  assertEqual(row?.vendorId, VENDOR_ID, "vendor carried through");
  assertEqual(row?.amountCents, BigInt(100000), "amount is the positive magnitude of the withdrawal");
  assertEqual(row?.paymentDate, "2026-01-20", "date came from the transaction");
  assertEqual(row?.clearingAccount, "1910", "clearing account came from the transaction's own coding");
  assertEqual(row?.status, "unapplied", "unapplied on creation");
  assertEqual(db.all("journal_entries").length, 0, "this run posts nothing -- the cash already posted when the transaction was coded");
});

test("ap-record-payment: the same transaction twice is a no op the second time", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor(VENDOR_ID)]);
  db.seed("transactions", [seedWithdrawal()]);
  const scope = scopeFor();
  const first = await execute(db, apRecordPayment, scope, opts("preview"));
  await execute(db, apRecordPayment, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, apRecordPayment, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(
    second.result.skips.some((s) => s.reason === "already_applied"),
    "reported as already applied",
  );
  assertEqual((db.all("vendor_payments") as VendorPaymentRow[]).length, 1, "only one row exists");
});

test("ap-record-payment: an unknown transaction is refused", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor(VENDOR_ID)]);
  const scope = scopeFor({ transactionId: "TX-DOES-NOT-EXIST" });
  const preview = await execute(db, apRecordPayment, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "UNKNOWN_TRANSACTION"),
    "named error code",
  );
});

test("ap-record-payment: money coming in is refused, not recorded as a bill payment", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor(VENDOR_ID)]);
  db.seed("transactions", [seedWithdrawal(BigInt(5000))]);
  const scope = scopeFor();
  const preview = await execute(db, apRecordPayment, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "TRANSACTION_NOT_A_WITHDRAWAL"),
    "named error code",
  );
});

test("ap-record-payment: an uncoded transaction is refused", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor(VENDOR_ID)]);
  db.seed("transactions", [seedWithdrawal(BigInt(-100000), { categoryId: null })]);
  const scope = scopeFor();
  const preview = await execute(db, apRecordPayment, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "TRANSACTION_NOT_CODED"),
    "named error code",
  );
});

test("ap-record-payment: an unknown vendor is refused", async () => {
  const db = arapDb();
  db.seed("transactions", [seedWithdrawal()]);
  const scope = scopeFor({ vendorId: "VEN-DOES-NOT-EXIST" });
  const preview = await execute(db, apRecordPayment, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "UNKNOWN_VENDOR"),
    "named error code",
  );
});

test("ap-record-payment: once recorded, AP-APPLY-PAYMENTS can actually apply it", async () => {
  const db = arapDb();
  db.seed("vendors", [vendor(VENDOR_ID)]);
  db.seed("bills", [bill("BILL-1", VENDOR_ID, { originalAmountCents: BigInt(100000) })]);
  db.seed("transactions", [seedWithdrawal()]);
  const recordPreview = await execute(db, apRecordPayment, scopeFor(), opts("preview"));
  await execute(db, apRecordPayment, scopeFor(), opts("apply", { previewRunId: recordPreview.executionId }));

  const applyPreview = await execute(
    db,
    apApplyPayments,
    { clientId: CLIENT_A1, period: "2026-01-20" },
    opts("preview"),
  );
  assertEqual(applyPreview.status, "completed", "AP-APPLY-PAYMENTS finds the payment this run recorded");
  await execute(db, apApplyPayments, { clientId: CLIENT_A1, period: "2026-01-20" }, opts("apply", { previewRunId: applyPreview.executionId }));

  const payment = (db.all("vendor_payments") as VendorPaymentRow[]).find(
    (p) => p.id === vendorPaymentIdFor(CLIENT_A1, TRANSACTION_ID),
  );
  assertEqual(payment?.status, "applied", "the payment this run put on the books is now applied, which was impossible before either run existed");
});
