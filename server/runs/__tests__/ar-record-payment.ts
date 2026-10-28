/**
 * AR-RECORD-PAYMENT tests. The insert pulls its amount and date from the
 * register transaction rather than taking them as separate inputs, a repeat
 * naming the same transaction is a no-op, and the run refuses cleanly on an
 * unknown transaction, money moving the wrong direction, an uncoded
 * transaction, and an unknown customer. The last test is the proof that
 * matters most: once this run has recorded a payment, AR-APPLY-PAYMENTS can
 * actually apply it, which was impossible before this run existed because
 * nothing ever put a customer_payments row on the books at all.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, txn } from "./fixtures";
import { arapDb, customer, invoice } from "./arap-fixtures";
import { opts } from "./fixtures";
import {
  arRecordPayment,
  paymentIdFor,
  type RecordPaymentScope,
} from "../runs/ar-record-payment";
import { arApplyPayments } from "../runs/ar-apply-payments";
import type { CustomerPaymentRow } from "../tables";

const CUSTOMER_ID = "CUS-1";
const TRANSACTION_ID = "TX-DEPOSIT-1";

function seedDeposit(
  amountCents: bigint = BigInt(100000),
  extra: Record<string, unknown> = {},
) {
  return txn(TRANSACTION_ID, FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-20", amountCents, {
    categoryId: "1200",
    ...extra,
  });
}

function scopeFor(extra: Partial<RecordPaymentScope> = {}): RecordPaymentScope {
  return {
    clientId: CLIENT_A1,
    customerId: CUSTOMER_ID,
    transactionId: TRANSACTION_ID,
    matchHint: null,
    onHold: false,
    ...extra,
  };
}

test("ar-record-payment: a new payment is inserted from the transaction's own amount and date", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  db.seed("transactions", [seedDeposit()]);
  const scope = scopeFor();
  const preview = await execute(db, arRecordPayment, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, arRecordPayment, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const row = (db.all("customer_payments") as CustomerPaymentRow[]).find(
    (p) => p.id === paymentIdFor(CLIENT_A1, TRANSACTION_ID),
  );
  assert(row !== undefined, "the payment row exists");
  assertEqual(row?.customerId, CUSTOMER_ID, "customer carried through");
  assertEqual(row?.amountCents, BigInt(100000), "amount came from the transaction");
  assertEqual(row?.paymentDate, "2026-01-20", "date came from the transaction");
  assertEqual(row?.clearingAccount, "1200", "clearing account came from the transaction's own coding");
  assertEqual(row?.status, "unapplied", "unapplied on creation");
  assertEqual(db.all("journal_entries").length, 0, "this run posts nothing -- the cash already posted when the transaction was coded");
});

test("ar-record-payment: the same transaction twice is a no op the second time", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  db.seed("transactions", [seedDeposit()]);
  const scope = scopeFor();
  const first = await execute(db, arRecordPayment, scope, opts("preview"));
  await execute(db, arRecordPayment, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, arRecordPayment, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(
    second.result.skips.some((s) => s.reason === "already_applied"),
    "reported as already applied",
  );
  assertEqual((db.all("customer_payments") as CustomerPaymentRow[]).length, 1, "only one row exists");
});

test("ar-record-payment: an unknown transaction is refused", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  const scope = scopeFor({ transactionId: "TX-DOES-NOT-EXIST" });
  const preview = await execute(db, arRecordPayment, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "UNKNOWN_TRANSACTION"),
    "named error code",
  );
});

test("ar-record-payment: money going out is refused, not recorded as a payment", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  db.seed("transactions", [seedDeposit(BigInt(-5000))]);
  const scope = scopeFor();
  const preview = await execute(db, arRecordPayment, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "TRANSACTION_NOT_A_DEPOSIT"),
    "named error code",
  );
});

test("ar-record-payment: an uncoded transaction is refused", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  db.seed("transactions", [seedDeposit(BigInt(100000), { categoryId: null })]);
  const scope = scopeFor();
  const preview = await execute(db, arRecordPayment, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "TRANSACTION_NOT_CODED"),
    "named error code",
  );
});

test("ar-record-payment: an unknown customer is refused", async () => {
  const db = arapDb();
  db.seed("transactions", [seedDeposit()]);
  const scope = scopeFor({ customerId: "CUS-DOES-NOT-EXIST" });
  const preview = await execute(db, arRecordPayment, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "UNKNOWN_CUSTOMER"),
    "named error code",
  );
});

test("ar-record-payment: once recorded, AR-APPLY-PAYMENTS can actually apply it", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  db.seed("invoices", [invoice("INV-1", CUSTOMER_ID, { originalAmountCents: BigInt(100000) })]);
  db.seed("transactions", [seedDeposit()]);
  const recordPreview = await execute(db, arRecordPayment, scopeFor(), opts("preview"));
  await execute(db, arRecordPayment, scopeFor(), opts("apply", { previewRunId: recordPreview.executionId }));

  const applyPreview = await execute(
    db,
    arApplyPayments,
    { clientId: CLIENT_A1, period: "2026-01-20" },
    opts("preview"),
  );
  assertEqual(applyPreview.status, "completed", "AR-APPLY-PAYMENTS finds the payment this run recorded");
  await execute(db, arApplyPayments, { clientId: CLIENT_A1, period: "2026-01-20" }, opts("apply", { previewRunId: applyPreview.executionId }));

  const payment = (db.all("customer_payments") as CustomerPaymentRow[]).find(
    (p) => p.id === paymentIdFor(CLIENT_A1, TRANSACTION_ID),
  );
  assertEqual(payment?.status, "applied", "the payment this run put on the books is now applied, which was impossible before it existed");
});
