/**
 * AR-CREATE-CREDITMEMO tests. The posted entry foots and lands on the right
 * accounts with every sign reversed from AR-CREATE-INVOICE, tax splits
 * correctly, a repeated memo number is a no-op rather than a double post,
 * and the run refuses cleanly on an unknown customer, an account the
 * client's chart does not carry, and a locked memo date.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { isJournalEntry } from "../contract";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import { arapDb, balanceOf, customer, sumLines } from "./arap-fixtures";
import { opts } from "./fixtures";
import {
  arCreateCreditMemo,
  creditMemoIdFor,
  type CreateCreditMemoScope,
} from "../runs/ar-create-creditmemo";
import type { CreditMemoRow } from "../tables";

const CUSTOMER_ID = "CUS-1";

function scopeFor(extra: Partial<CreateCreditMemoScope> = {}): CreateCreditMemoScope {
  return {
    clientId: CLIENT_A1,
    customerId: CUSTOMER_ID,
    memoNumber: "CM-3001",
    memoDate: "2026-01-20",
    amountCents: "10000",
    taxCents: "0",
    revenueAccount: "4100",
    ...extra,
  };
}

test("ar-create-creditmemo: posts a two line reversal and inserts an open memo", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  const scope = scopeFor();
  const preview = await execute(db, arCreateCreditMemo, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, arCreateCreditMemo, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries.length, 1, "one entry");
  assertEqual(entries[0].lines.length, 2, "no tax line when there is no tax");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the books foot");
  assertEqual(balanceOf(db, "1100"), BigInt(-10000), "receivable control takes the credit, the reverse of an invoice");
  assertEqual(balanceOf(db, "4100"), BigInt(10000), "revenue takes the debit, the reverse of an invoice");

  const row = (db.all("credit_memos") as CreditMemoRow[]).find(
    (m) => m.id === creditMemoIdFor(CLIENT_A1, scope.memoNumber),
  );
  assert(row !== undefined, "the credit memo row exists");
  assertEqual(row?.status, "open", "open on creation");
  assertEqual(row?.amountCents, BigInt(10000), "amount carried through");
  assertEqual(row?.arAccount, "1100", "the control account it posted against is stored on the row");
});

test("ar-create-creditmemo: tax splits between revenue and the sales tax account", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  const scope = scopeFor({ amountCents: "10800", taxCents: "800" });
  const preview = await execute(db, arCreateCreditMemo, scope, opts("preview"));
  const applied = await execute(db, arCreateCreditMemo, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const entries = applied.result.proposals.filter(isJournalEntry);
  assertEqual(entries[0].lines.length, 3, "AR, revenue, and sales tax");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the books foot");
  assertEqual(balanceOf(db, "1100"), BigInt(-10800), "receivable takes the full credited amount");
  assertEqual(balanceOf(db, "4100"), BigInt(10000), "revenue takes the net of tax");
  assertEqual(balanceOf(db, "2400"), BigInt(800), "sales tax payable is reduced by the tax portion");
});

test("ar-create-creditmemo: the same memo number twice is a no op the second time", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  const scope = scopeFor();
  const first = await execute(db, arCreateCreditMemo, scope, opts("preview"));
  await execute(db, arCreateCreditMemo, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, arCreateCreditMemo, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(
    second.result.skips.some((s) => s.reason === "already_applied"),
    "reported as already applied",
  );
  assertEqual((db.all("credit_memos") as CreditMemoRow[]).length, 1, "only one memo exists");
  assertEqual(db.all("journal_entries").length, 1, "and only one entry was ever posted");
});

test("ar-create-creditmemo: an unknown customer is refused", async () => {
  const db = arapDb();
  const scope = scopeFor({ customerId: "CUS-DOES-NOT-EXIST" });
  const preview = await execute(db, arCreateCreditMemo, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "UNKNOWN_CUSTOMER"),
    "named error code",
  );
});

test("ar-create-creditmemo: a revenue account not on the client's chart is refused", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  const scope = scopeFor({ revenueAccount: "4999" });
  const preview = await execute(db, arCreateCreditMemo, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "ACCOUNT_NOT_ON_CHART"),
    "named error code",
  );
});

test("ar-create-creditmemo: a memo date inside a locked period is skipped and nothing posts", async () => {
  const db = arapDb();
  db.seed("customers", [customer(CUSTOMER_ID)]);
  db.seed("period_locks", [lock("LOCK-1", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31")]);
  const scope = scopeFor({ memoDate: "2026-01-20" });
  const preview = await execute(db, arCreateCreditMemo, scope, opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(
    preview.result.skips.some((s) => s.reason === "locked_period"),
    "reported as locked",
  );
  assertEqual((db.all("credit_memos") as CreditMemoRow[]).length, 0, "nothing written");
});
