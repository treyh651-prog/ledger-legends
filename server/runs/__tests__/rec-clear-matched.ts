/**
 * REC-CLEAR-MATCHED tests.
 *
 * The run has two jobs and both are tested here: the cleared flag and date on
 * the register, and the difference on the batch. The difference is the one that
 * matters most, because gate G03 is a question about that single number.
 */

import { isFieldWrite } from "../contract";
import { canonicalJson, toJsonValue } from "../ids";
import { recClearMatched } from "../runs/rec-clear-matched";
import { recMatchTiered } from "../runs/rec-match-tiered";
import { TIER } from "../runs/rec-shared";
import { CLIENT_A1, FIRM_A, lock, txn } from "./fixtures";
import {
  ACCOUNT,
  BATCH_ID,
  applyRec,
  batchRow,
  clearScope,
  confirmLine,
  matchScope,
  previewRec,
  recBatch,
  recDb,
  skippedFor,
  statementLine,
  txnById,
} from "./rec-fixtures";
import { assert, assertEqual, show, test } from "./harness";

const book = (
  id: string,
  postedDate: string,
  amountCents: bigint,
  extra: Parameters<typeof txn>[6] = {},
) => txn(id, FIRM_A, CLIENT_A1, ACCOUNT, postedDate, amountCents, extra);

// Happy path. One tier 1 match, cleared, and the batch balances to zero.
test("rec clear, a tier 1 match clears and the batch reconciles to zero", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));

  const { applied } = await applyRec(db, recClearMatched, clearScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );

  const row = txnById(db, "TX-1");
  assertEqual(row.cleared, true, "the row is cleared");
  assertEqual(row.clearedDate, "2026-01-10", "at the statement date, not the book date");

  const batch = batchRow(db);
  assertEqual(batch.clearedLedgerBalanceCents, BigInt(-25000), "cleared ledger balance");
  assertEqual(batch.diffCents, BigInt(0), "the difference is zero");
  assertEqual(batch.state, "reconciled", "so the batch is reconciled");
  assert(batch.closedAt !== null, "and it closed");
});

test("rec clear, the cleared date comes from the statement and not the book", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-08", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-12", BigInt(-25000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  confirmLine(db, "SL-1"); // tier 2 needs a person to accept it

  await applyRec(db, recClearMatched, clearScope());
  const row = txnById(db, "TX-1");
  assertEqual(row.clearedDate, "2026-01-12", "the bank decides when money moved");
  assertEqual(row.postedDate, "2026-01-08", "and the book date is left alone");
});

// No matches at all. The batch closes with the whole statement balance surfaced
// as the difference, which is the honest answer and not a failure.
test("rec clear, an empty batch closes with the whole statement diff surfaced", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-UNSEEN", "2026-01-20", BigInt(-4000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-25", BigInt(-99999))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-99999)));

  const { applied } = await applyRec(db, recClearMatched, clearScope());
  const batch = batchRow(db);
  assertEqual(batch.clearedLedgerBalanceCents, BigInt(0), "nothing was cleared");
  assertEqual(batch.diffCents, BigInt(-99999), "so the whole statement is the difference");
  assertEqual(batch.state, "out_of_balance", "and the batch says so");
  assert(batch.closedAt !== null, "it still closed, because a person needs the number");
  assertEqual(txnById(db, "TX-UNSEEN").cleared, false, "and nothing was cleared");
  assert(
    skippedFor(applied, "SL-1", "missing_prerequisite"),
    `expected the unmatched line reported, got ${show(applied.result.skips)}`,
  );
});

// The override contract. Cleared, and still not recoded.
test("rec clear, an overridden row clears and is never recoded", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-OVR", "2026-01-10", BigInt(-25000), {
      manualOverride: true,
      categoryId: "CAT-OWNER-DRAW",
      cascadeLevel: 0,
      suspenseReason: "SUS-08",
    }),
  ]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));

  const { applied } = await applyRec(db, recClearMatched, clearScope());
  const row = txnById(db, "TX-OVR");
  assertEqual(row.cleared, true, "the bank's fact was recorded");
  assertEqual(row.clearedDate, "2026-01-10", "with the statement date");
  assertEqual(row.categoryId, "CAT-OWNER-DRAW", "and the coding is untouched");
  assertEqual(row.cascadeLevel, 0, "including the level it was decided at");
  assertEqual(row.suspenseReason, "SUS-08", "and the suspense reason it carried");
  assertEqual(batchRow(db).diffCents, BigInt(0), "the account still reconciles");

  for (const p of applied.result.proposals) {
    if (!isFieldWrite(p) || p.table !== "transactions") continue;
    assertEqual(
      Object.keys(p.after).sort().join(","),
      "cleared,clearedDate",
      "the only register fields written are the two clearing fields",
    );
  }
});

// Tier ordering, carried through to clearing: the T1 row is the one that clears.
test("rec clear, the tier 1 row clears and the tier 4 group is left alone", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-EXACT", "2026-01-10", BigInt(-30000)),
    book("TX-PART-A", "2026-01-08", BigInt(-10000)),
    book("TX-PART-B", "2026-01-09", BigInt(-20000)),
  ]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-30000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-30000)));

  await applyRec(db, recClearMatched, clearScope());
  assertEqual(txnById(db, "TX-EXACT").cleared, true, "the tier 1 row cleared");
  assertEqual(txnById(db, "TX-PART-A").cleared, false, "the group did not");
  assertEqual(txnById(db, "TX-PART-B").cleared, false, "neither half of it");
  // Statement 30000 out, cleared ledger 30000 out, and the two outstanding rows
  // are outstanding items which is exactly what a difference of zero means here.
  assertEqual(batchRow(db).diffCents, BigInt(0), "and the account reconciles");
});

test("rec clear, an unconfirmed tier 2 match is not cleared by default", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-08", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-12", BigInt(-25000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));

  const { applied } = await applyRec(db, recClearMatched, clearScope());
  assertEqual(txnById(db, "TX-1").cleared, false, "not cleared without acceptance");
  assert(
    skippedFor(applied, "SL-1", "ambiguous_candidate"),
    `expected match_not_confirmed reported, got ${show(applied.result.skips)}`,
  );
  assertEqual(
    batchRow(db).diffCents,
    BigInt(-25000),
    "and the whole amount surfaces as the difference",
  );
});

test("rec clear, a firm may opt in to clearing unconfirmed tiers", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-08", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-12", BigInt(-25000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));

  await applyRec(db, recClearMatched, clearScope({ clearUnconfirmed: true }));
  assertEqual(txnById(db, "TX-1").cleared, true, "cleared under the opt in");
  assertEqual(batchRow(db).diffCents, BigInt(0), "and the account reconciles");
});

test("rec clear, a tier 4 group clears every member together", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-INV-1", "2026-01-08", BigInt(40000)),
    book("TX-INV-2", "2026-01-09", BigInt(35000)),
  ]);
  db.seed("statement_lines", [statementLine("SL-DEP", "2026-01-12", BigInt(75000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(75000)));
  confirmLine(db, "SL-DEP");

  await applyRec(db, recClearMatched, clearScope());
  assertEqual(txnById(db, "TX-INV-1").cleared, true, "first member cleared");
  assertEqual(txnById(db, "TX-INV-2").cleared, true, "second member cleared");
  assertEqual(txnById(db, "TX-INV-1").clearedDate, "2026-01-12", "at the bank's date");
  assertEqual(batchRow(db).clearedLedgerBalanceCents, BigInt(75000), "the whole deposit");
  assertEqual(batchRow(db).diffCents, BigInt(0), "and it reconciles");
});

test("rec clear, an already cleared row from an earlier period still counts", async () => {
  const db = recDb();
  db.seed("transactions", [
    // Cleared last December. A balance is cumulative, so it belongs in this one.
    book("TX-OLD", "2025-12-20", BigInt(-5000), {
      cleared: true,
      clearedDate: "2025-12-22",
    }),
    book("TX-1", "2026-01-10", BigInt(-25000)),
  ]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-30000)));

  await applyRec(db, recClearMatched, clearScope());
  const batch = batchRow(db);
  assertEqual(batch.clearedLedgerBalanceCents, BigInt(-30000), "both cleared rows");
  assertEqual(batch.diffCents, BigInt(0), "so the statement balance agrees");
  assertEqual(batch.state, "reconciled", "and the batch reconciles");
});

test("rec clear, one cent out is out of balance and not reconciled", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-25001)));

  await applyRec(db, recClearMatched, clearScope());
  const batch = batchRow(db);
  assertEqual(batch.diffCents, BigInt(-1), "one cent of difference");
  assertEqual(batch.state, "out_of_balance", "which is not reconciled");
});

test("rec clear, clearing without a batch is refused", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  const preview = await previewRec(db, recClearMatched, clearScope());
  assertEqual(preview.status, "refused", "matching opens the batch, not clearing");
  assert(
    preview.result.errors.some((e) => e.code === "REC_NO_OPEN_BATCH"),
    `expected REC_NO_OPEN_BATCH, got ${show(preview.result.errors)}`,
  );
});

test("rec clear, a closed batch is never reopened or re closed", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-1", "2026-01-10", BigInt(-25000), {
      cleared: true,
      clearedDate: "2026-01-10",
    }),
  ]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  db.seed("rec_batches", [
    recBatch({
      statementBalanceCents: BigInt(-25000),
      clearedLedgerBalanceCents: BigInt(-25000),
      diffCents: BigInt(0),
      state: "reconciled",
      closedAt: "2026-02-01T00:00:00.000Z",
      closedByRunId: "RUNX-SEED",
    }),
  ]);
  const preview = await previewRec(db, recClearMatched, clearScope());
  assertEqual(preview.status, "refused", "a signed off difference is history");
  assert(
    preview.result.errors.some((e) => e.code === "REC_BATCH_ALREADY_CLOSED"),
    `expected REC_BATCH_ALREADY_CLOSED, got ${show(preview.result.errors)}`,
  );
  assertEqual(batchRow(db).diffCents, BigInt(0), "the closed batch is unchanged");
});

test("rec clear, a locked posted date is skipped and never cleared", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);

  const { applied } = await applyRec(db, recClearMatched, clearScope());
  assertEqual(txnById(db, "TX-1").cleared, false, "nothing was cleared");
  assert(
    skippedFor(applied, "SL-1", "locked_period") ||
      skippedFor(applied, "TX-1", "locked_period"),
    `expected a locked_period skip, got ${show(applied.result.skips)}`,
  );
  assertEqual(
    batchRow(db).diffCents,
    BigInt(-25000),
    "and the difference reports what was not cleared",
  );
});

test("rec clear, a second clearing run clears nothing twice", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  await applyRec(db, recClearMatched, clearScope());

  const second = await previewRec(db, recClearMatched, clearScope());
  assertEqual(second.status, "refused", "the batch it would write is closed");
  assertEqual(txnById(db, "TX-1").clearedDate, "2026-01-10", "and nothing moved");
});

test("rec clear, preview and apply produce identical proposals", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-1", "2026-01-10", BigInt(-25000)),
    book("TX-2", "2026-01-14", BigInt(9000)),
  ]);
  db.seed("statement_lines", [
    statementLine("SL-1", "2026-01-10", BigInt(-25000)),
    statementLine("SL-2", "2026-01-14", BigInt(9000)),
  ]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-16000)));

  const { preview, applied } = await applyRec(db, recClearMatched, clearScope());
  assertEqual(
    canonicalJson(toJsonValue(preview.result.proposals)),
    canonicalJson(toJsonValue(applied.result.proposals)),
    "the two modes proposed the same set, difference included",
  );
  assertEqual(preview.scopeHash, applied.scopeHash, "and the same scope hash");
});

test("rec clear, a preview writes no cleared flag and no difference", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));

  const preview = await previewRec(db, recClearMatched, clearScope());
  assert(preview.result.proposals.length > 0, "the preview did propose work");
  assertEqual(txnById(db, "TX-1").cleared, false, "no flag survived the preview");
  assertEqual(batchRow(db).diffCents, null, "and no difference was stored");
  assertEqual(batchRow(db).id, BATCH_ID, "the batch is the one matching opened");
  assertEqual(
    preview.result.proposals.filter((p) => isFieldWrite(p) && p.table === "rec_batches")
      .length,
    1,
    "exactly one batch write is proposed, whatever else happens",
  );
});

test("rec clear, the tier the match used is carried through unchanged", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  await applyRec(db, recClearMatched, clearScope());
  const row = txnById(db, "TX-1");
  assertEqual(row.matchTier, TIER.exactDate, "clearing does not rewrite the tier");
  assertEqual(row.recBatchId, BATCH_ID, "nor the batch pointer");
});
