/**
 * SUB-RAISE-REQUESTS. Doc 02 module 6 SUB-RAISE-REQUESTS.
 *
 * The questions these tests answer: does each of the six kinds of open item turn
 * into exactly one request, does a second execution refresh the age instead of
 * asking the client the same thing twice, does the escalation ladder move with
 * the age, does a request keep the owner a person assigned to it, and does a
 * locked period stop the run from handing out work on a closed month.
 */

import {
  collectOpenItems,
  escalationFor,
  requestId,
  subRaiseRequests,
  ESCALATION_DAYS,
} from "../runs/sub-raise-requests";
import { subTieBalances } from "../runs/sub-tie-balances";
import { loadCloseData } from "../runs/close-shared";
import type { MemoryRunDb } from "../db-memory";
import type { DocumentRequestRow } from "../tables";
import { CLIENT_A1, FIRM_A, lock, txn } from "./fixtures";
import { suspenseItem, vendor } from "./coding-fixtures";
import {
  applyClose,
  closeDb,
  closeScope,
  previewClose,
  recBatch,
  request,
  requestsOf,
  PERIOD,
  PERIOD_END,
  PREPARER,
} from "./close-fixtures";
import { assert, assertEqual, test } from "./harness";

/** Raise requests and return them keyed by subject. */
async function raise(db: MemoryRunDb): Promise<Map<string, DocumentRequestRow>> {
  await applyClose(db, subRaiseRequests, closeScope());
  return new Map(requestsOf(db).map((r) => [r.subjectKey, r]));
}

function bySubject(
  rows: readonly DocumentRequestRow[],
  subjectKey: string,
): DocumentRequestRow | undefined {
  return rows.find((r) => r.subjectKey === subjectKey);
}

// ---------------------------------------------------------------------------
// The six open item kinds.
// ---------------------------------------------------------------------------

test("requests, a row still in suspense becomes a coding question", async () => {
  const db = closeDb();
  db.seed("transactions", [
    txn("TXN-1", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-06", BigInt(-4500), {
      accountNumber: "1990",
      suspenseOwner: "client",
      suspenseOpenedOn: "2026-01-06",
    }),
  ]);
  db.seed("suspense_items", [suspenseItem("SI-1", "TXN-1", "UNKNOWN_VENDOR")]);
  const rows = await raise(db);
  const row = rows.get("suspense:TXN-1");
  assertEqual(row?.catalogCode, "CODING_QUESTION", "the catalog code");
  assertEqual(row?.owner, "client", "the owner the suspense row named");
  assertEqual(row?.linkedItemId, "TXN-1", "the linked row");
  assertEqual(row?.openedOn, "2026-01-06", "the day it opened");
  assertEqual(row?.agingDays, 25, "the age at the period end");
  assertEqual(row?.escalation, "second", "past fourteen days");
});

test("requests, a bank account with no statement becomes a statement request", async () => {
  const db = closeDb();
  db.seed("rec_batches", [recBatch("RB-JAN", { periodEnd: "2025-12-31" })]);
  const rows = await raise(db);
  const row = rows.get(`statement:BA-A1-OP:${PERIOD}`);
  assertEqual(row?.catalogCode, "BANK_STATEMENT", "the catalog code");
  assertEqual(row?.owner, "client", "the client holds the statement");
  assertEqual(row?.accountNumber, "1010", "against the cash account");
});

test("requests, an accrual with no bill behind it becomes a bill request", async () => {
  const db = closeDb();
  db.seed("accrual_templates", [
    {
      id: "AT-1",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      version: 1,
      name: "January legal fees",
      accrualKind: "bill_received_not_entered",
      basis: "fixed_amount",
      debitAccount: "6100",
      creditAccount: "2200",
      categoryId: null,
      fixedAmountCents: BigInt(75000),
      sourceDocumentId: null,
      sourceDocumentAmountCents: null,
      dailyRateCents: null,
      dayCount: null,
      baseCents: null,
      percentBps: null,
      entryMemo: "accrued legal",
      autoReverse: true,
      isActive: true,
      manualOverride: false,
    },
  ]);
  const rows = await raise(db);
  const row = rows.get("bill:AT-1");
  assertEqual(row?.catalogCode, "VENDOR_BILL", "the catalog code");
  assertEqual(row?.accountNumber, "2200", "against the accrual account");
});

test("requests, a variance left open by the tie out run becomes a variance request", async () => {
  const db = closeDb();
  db.seed("rec_batches", [
    recBatch("RB-JAN", { statementBalanceCents: BigInt(90000) }),
  ]);
  await applyClose(db, subTieBalances, closeScope());
  const rows = await raise(db);
  const row = rows.get(`variance:1010:${PERIOD}`);
  assertEqual(row?.catalogCode, "VARIANCE", "a variance, not a substantiation");
  assertEqual(row?.owner, "firm", "the firm owns its own variance");
  const unsupported = rows.get(`variance:3200:${PERIOD}`);
  assertEqual(unsupported?.catalogCode, "SUBSTANTIATION", "unsupported instead");
  assertEqual(unsupported?.owner, "client", "and the client owns the support");
});

test("requests, a vendor with no W-9 and one with an expired W-9 both get asked", async () => {
  const db = closeDb();
  db.seed("vendors", [
    vendor("VEN-NONE", "no paperwork", { w9OnFile: false }),
    vendor("VEN-STALE", "stale paperwork", {
      w9OnFile: true,
      w9ExpiresOn: "2026-01-15",
    }),
    vendor("VEN-GOOD", "current paperwork", {
      w9OnFile: true,
      w9ExpiresOn: "2027-01-15",
    }),
  ]);
  const rows = await raise(db);
  assert(rows.has("w9:VEN-NONE"), "the vendor with nothing on file was asked");
  assertEqual(
    rows.get("w9:VEN-STALE")?.openedOn,
    "2026-01-15",
    "the expiry day is the day the item opened",
  );
  assert(!rows.has("w9:VEN-GOOD"), "the current vendor was left alone");
});

test("requests, a missing intake document becomes a receipt request", async () => {
  const db = closeDb();
  db.seed("transactions", [
    txn("TXN-2", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-32000)),
  ]);
  db.seed("documentation_exceptions", [
    {
      id: "DE-1",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      transactionId: "TXN-2",
      kind: "missing_receipt",
      categoryId: "CAT-office",
      detail: "over the threshold with no receipt",
      status: "open",
      createdByRunId: "RUNX-SEED",
      openedAt: "2026-01-09T00:00:00.000Z",
    },
  ]);
  const rows = await raise(db);
  assertEqual(rows.get("document:TXN-2")?.catalogCode, "RECEIPT", "a receipt");
});

test("requests, a document already in the vault is not asked for again", async () => {
  const db = closeDb();
  db.seed("transactions", [
    txn("TXN-3", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-32000)),
  ]);
  db.seed("documentation_exceptions", [
    {
      id: "DE-2",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      transactionId: "TXN-3",
      kind: "missing_receipt",
      categoryId: "CAT-office",
      detail: "over the threshold with no receipt",
      status: "open",
      createdByRunId: "RUNX-SEED",
      openedAt: "2026-01-09T00:00:00.000Z",
    },
  ]);
  db.seed("document_links", [
    {
      id: "DL-1",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      transactionId: "TXN-3",
      documentId: "DOC-1",
      documentType: "receipt",
    },
  ]);
  const rows = await raise(db);
  assert(!rows.has("document:TXN-3"), "the linked document closed the question");
});

// ---------------------------------------------------------------------------
// The ladder.
// ---------------------------------------------------------------------------

test("requests, the escalation ladder moves with the age", () => {
  assertEqual(escalationFor(0), "none", "a fresh item");
  assertEqual(escalationFor(ESCALATION_DAYS.first - 1), "none", "day six");
  assertEqual(escalationFor(ESCALATION_DAYS.first), "first", "day seven");
  assertEqual(escalationFor(ESCALATION_DAYS.second), "second", "day fourteen");
  assertEqual(escalationFor(ESCALATION_DAYS.final), "final", "day thirty");
  assertEqual(escalationFor(400), "final", "and it stops at final");
});

test("requests, a fresh item is not escalated on the day it opens", async () => {
  const db = closeDb();
  db.seed("transactions", [
    txn("TXN-NEW", FIRM_A, CLIENT_A1, "BA-A1-OP", PERIOD_END, BigInt(-1000), {
      accountNumber: "1990",
      suspenseOpenedOn: PERIOD_END,
    }),
  ]);
  db.seed("suspense_items", [suspenseItem("SI-NEW", "TXN-NEW", "UNKNOWN_VENDOR")]);
  const rows = await raise(db);
  const row = rows.get("suspense:TXN-NEW");
  assertEqual(row?.agingDays, 0, "no age yet");
  assertEqual(row?.escalation, "none", "and no escalation");
});

// ---------------------------------------------------------------------------
// Idempotence and ownership.
// ---------------------------------------------------------------------------

test("requests, one subject key produces one row per client", async () => {
  const db = closeDb();
  const first = await raise(db);
  const before = first.size;
  await applyClose(db, subRaiseRequests, closeScope());
  assertEqual(requestsOf(db).length, before, "no duplicate row was added");
});

test("requests, a rerun over an unchanged period proposes nothing", async () => {
  const db = closeDb();
  await applyClose(db, subRaiseRequests, closeScope());
  const second = await previewClose(db, subRaiseRequests, closeScope());
  assertEqual(second.result.proposals.length, 0, "nothing left to propose");
  assert(
    second.result.skips.every((s) => s.reason === "already_applied"),
    "every open item was already handled",
  );
});

test("requests, the row id is derived from the client and the subject", () => {
  assertEqual(
    requestId(CLIENT_A1, "w9:VEN-1"),
    requestId(CLIENT_A1, "w9:VEN-1"),
    "the same inputs give the same id",
  );
  assert(
    requestId(CLIENT_A1, "w9:VEN-1") !== requestId(CLIENT_A1, "w9:VEN-2"),
    "two subjects are two rows",
  );
});

test("requests, an owner a person changed is preserved on a refresh", async () => {
  const db = closeDb();
  db.seed("rec_batches", [recBatch("RB-JAN", { periodEnd: "2025-12-31" })]);
  const subjectKey = `statement:BA-A1-OP:${PERIOD}`;
  db.seed("document_requests", [
    request(requestId(CLIENT_A1, subjectKey), subjectKey, {
      catalogCode: "BANK_STATEMENT",
      owner: "firm",
      ownerChangedOn: "2026-01-20",
      agingDays: 1,
      detail: "stale detail",
    }),
  ]);
  await applyClose(db, subRaiseRequests, closeScope());
  const row = bySubject(requestsOf(db), subjectKey);
  assertEqual(row?.owner, "firm", "the reassigned owner stands");
  assert((row?.detail ?? "") !== "stale detail", "but the detail was refreshed");
});

test("requests, a refresh counts itself", async () => {
  const db = closeDb();
  db.seed("rec_batches", [recBatch("RB-JAN", { periodEnd: "2025-12-31" })]);
  const subjectKey = `statement:BA-A1-OP:${PERIOD}`;
  db.seed("document_requests", [
    request(requestId(CLIENT_A1, subjectKey), subjectKey, {
      catalogCode: "BANK_STATEMENT",
      agingDays: 0,
      asOfDate: "2026-01-10",
    }),
  ]);
  await applyClose(db, subRaiseRequests, closeScope());
  const row = bySubject(requestsOf(db), subjectKey);
  assertEqual(row?.refreshCount, 1, "the refresh was counted");
  assertEqual(row?.lastRefreshedOn, PERIOD_END, "and dated");
});

test("requests, a satisfied request is not reopened", async () => {
  const db = closeDb();
  db.seed("rec_batches", [recBatch("RB-JAN", { periodEnd: "2025-12-31" })]);
  const subjectKey = `statement:BA-A1-OP:${PERIOD}`;
  db.seed("document_requests", [
    request(requestId(CLIENT_A1, subjectKey), subjectKey, {
      catalogCode: "BANK_STATEMENT",
      status: "satisfied",
    }),
  ]);
  const { applied } = await applyClose(db, subRaiseRequests, closeScope());
  assertEqual(
    bySubject(requestsOf(db), subjectKey)?.status,
    "satisfied",
    "the answer stands",
  );
  assert(
    applied.result.skips.some((s) => s.detail.includes("is satisfied")),
    "and the run said why it left it alone",
  );
});

test("requests, a request carrying manual override is left alone", async () => {
  const db = closeDb();
  db.seed("rec_batches", [recBatch("RB-JAN", { periodEnd: "2025-12-31" })]);
  const subjectKey = `statement:BA-A1-OP:${PERIOD}`;
  db.seed("document_requests", [
    request(requestId(CLIENT_A1, subjectKey), subjectKey, {
      catalogCode: "BANK_STATEMENT",
      manualOverride: true,
      detail: "a person is handling this",
    }),
  ]);
  const { applied } = await applyClose(db, subRaiseRequests, closeScope());
  assert(
    applied.result.skips.some((s) => s.reason === "manual_override"),
    "the override was reported",
  );
  assertEqual(
    bySubject(requestsOf(db), subjectKey)?.detail,
    "a person is handling this",
    "and the row was untouched",
  );
});

test("requests, a suspense row on an overridden transaction is left alone", async () => {
  const db = closeDb();
  db.seed("transactions", [
    txn("TXN-OV", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-06", BigInt(-4500), {
      accountNumber: "1990",
      manualOverride: true,
    }),
  ]);
  db.seed("suspense_items", [suspenseItem("SI-OV", "TXN-OV", "UNKNOWN_VENDOR")]);
  const rows = await raise(db);
  assert(!rows.has("suspense:TXN-OV"), "no request was raised");
});

// ---------------------------------------------------------------------------
// Locking, posting, and scope.
// ---------------------------------------------------------------------------

test("requests, a locked period raises nothing", async () => {
  const db = closeDb();
  db.seed("rec_batches", [recBatch("RB-JAN", { periodEnd: "2025-12-31" })]);
  db.seed("period_locks", [
    lock("LOCK-JAN", FIRM_A, CLIENT_A1, PERIOD, PERIOD_END),
  ]);
  const { applied } = await applyClose(db, subRaiseRequests, closeScope());
  assertEqual(requestsOf(db).length, 0, "no request was written");
  assert(
    applied.result.skips.every((s) => s.reason === "locked_period"),
    "every item was skipped for the lock",
  );
});

test("requests, the run posts nothing", async () => {
  const db = closeDb();
  db.seed("rec_batches", [recBatch("RB-JAN", { periodEnd: "2025-12-31" })]);
  await applyClose(db, subRaiseRequests, closeScope());
  assertEqual(db.all("journal_entries").length, 1, "the ledger is unchanged");
});

test("requests, preview proposes what apply writes", async () => {
  const db = closeDb();
  db.seed("rec_batches", [recBatch("RB-JAN", { periodEnd: "2025-12-31" })]);
  const preview = await previewClose(db, subRaiseRequests, closeScope());
  assertEqual(requestsOf(db).length, 0, "preview wrote nothing");
  const { applied } = await applyClose(db, subRaiseRequests, closeScope());
  assertEqual(
    applied.result.proposals.length,
    preview.result.proposals.length,
    "the same proposal count",
  );
});

test("requests, open items are collected in a stable order", async () => {
  const db = closeDb();
  db.seed("rec_batches", [recBatch("RB-JAN", { periodEnd: "2025-12-31" })]);
  db.seed("vendors", [vendor("VEN-NONE", "no paperwork", { w9OnFile: false })]);
  const keys = await db.tx<string[]>(
    {
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      actorId: PREPARER,
      actorKind: "human",
      isolation: "repeatable read",
      readOnly: true,
    },
    async (tx) => {
      const data = await loadCloseData(tx, FIRM_A, CLIENT_A1, PERIOD);
      return collectOpenItems(data).map((i) => i.subjectKey);
    },
  );
  assertEqual(keys, [...keys].sort(), "sorted by subject key");
});
