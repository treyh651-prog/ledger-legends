/**
 * The module 3 pipeline. Match, clear, flag, in that order, against one mixed
 * batch, and the question at the end is the only one gate G03 asks: what is the
 * difference, and can a person sign it off.
 *
 * The batch below is built so the answer is a number you can post to. Every
 * statement line is explained by exactly one tier, the two rows the bank never
 * showed are outstanding items rather than errors, and the difference that is
 * left is one cent, the exact cent tier 3 absorbed and recorded. One cent with a
 * name on it is postable. An unexplained difference is not, and the last test in
 * this file shows what that one looks like instead.
 */

import { recClearMatched } from "../runs/rec-clear-matched";
import { recFlagStale } from "../runs/rec-flag-stale";
import { recMatchTiered } from "../runs/rec-match-tiered";
import { RECONCILIATION_ORDER } from "../registry";
import { SUS_STALE_UNCLEARED, TIER } from "../runs/rec-shared";
import { CLIENT_A1, FIRM_A, txn } from "./fixtures";
import {
  ACCOUNT,
  BATCH_ID,
  applyRec,
  batchRow,
  clearScope,
  confirmLine,
  lineById,
  matchScope,
  recDb,
  staleScope,
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

/**
 * The mixed batch.
 *
 * On the statement, five lines:
 *   SL-RENT      -250000  tier 1, exact amount on the exact date
 *   SL-PAYROLL   -180000  tier 2, three days after the book date
 *   SL-ACME       -42501  tier 3, one cent off, vendor agrees
 *   SL-DEPOSIT    +75000  tier 4, two invoices summing to it
 *   SL-FEE          -3500 tier 1, and the row it matches is overridden
 *
 * In the book but not on the statement:
 *   TX-CHECK-OLD  -12000  issued check, outstanding since October, stale
 *   TX-CHECK-NEW   -6000  issued check, written in late January, still timing
 *
 * Book side of the five cleared rows: -250000 -180000 -42500 +40000 +35000
 *   -3500 = -401000
 * Bank side of the five lines:         -250000 -180000 -42501 +75000
 *   -3500 = -401001
 * Two outstanding checks, on the books and not at the bank: -12000 -6000
 * So the statement balance is -401001, the cleared ledger balance is -401000,
 * and the difference is one cent: the cent the bank charged on the ACME payment
 * that the books do not carry. The two checks are reconciling items and do not
 * touch the difference, because neither side cleared them.
 */
function mixedBatch(): ReturnType<typeof recDb> {
  const db = recDb();
  db.seed("transactions", [
    book("TX-RENT", "2026-01-05", BigInt(-250000), { normalizedVendor: "LANDLORD LLC" }),
    book("TX-PAYROLL", "2026-01-12", BigInt(-180000), { instrumentType: "electronic" }),
    book("TX-ACME", "2026-01-16", BigInt(-42500), { normalizedVendor: "ACME SUPPLY" }),
    book("TX-INV-1", "2026-01-18", BigInt(40000), { instrumentType: "deposit" }),
    book("TX-INV-2", "2026-01-19", BigInt(35000), { instrumentType: "deposit" }),
    book("TX-FEE", "2026-01-22", BigInt(-3500), {
      manualOverride: true,
      categoryId: "CAT-OWNER-DRAW",
      cascadeLevel: 0,
      normalizedVendor: "BANK FEE",
    }),
    book("TX-CHECK-OLD", "2025-10-04", BigInt(-12000), {
      instrumentType: "issued_check",
      checkNumber: "1031",
    }),
    book("TX-CHECK-NEW", "2026-01-28", BigInt(-6000), {
      instrumentType: "issued_check",
      checkNumber: "1044",
    }),
  ]);
  db.seed("statement_lines", [
    statementLine("SL-RENT", "2026-01-05", BigInt(-250000), {
      normalizedVendor: "LANDLORD LLC",
    }),
    statementLine("SL-PAYROLL", "2026-01-15", BigInt(-180000)),
    statementLine("SL-ACME", "2026-01-17", BigInt(-42501), {
      normalizedVendor: "ACME SUPPLY",
    }),
    statementLine("SL-DEPOSIT", "2026-01-21", BigInt(75000)),
    statementLine("SL-FEE", "2026-01-22", BigInt(-3500), {
      normalizedVendor: "BANK FEE",
    }),
  ]);
  return db;
}

const STATEMENT_BALANCE = BigInt(-401001);
/** What the books show for the same five rows, one cent off the bank. */
const CLEARED_LEDGER = BigInt(-401000);

test("rec pipeline, every tier fires once on the mixed batch", async () => {
  const db = mixedBatch();
  const { applied } = await applyRec(db, recMatchTiered, matchScope(STATEMENT_BALANCE));
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}: ${show(applied.result.errors)}`,
  );

  assertEqual(lineById(db, "SL-RENT").matchTier, TIER.exactDate, "rent at tier 1");
  assertEqual(lineById(db, "SL-PAYROLL").matchTier, TIER.exactWindow, "payroll at tier 2");
  assertEqual(lineById(db, "SL-ACME").matchTier, TIER.tolerantVendor, "acme at tier 3");
  assertEqual(lineById(db, "SL-DEPOSIT").matchTier, TIER.sumToSum, "deposit at tier 4");
  assertEqual(lineById(db, "SL-FEE").matchTier, TIER.exactDate, "the fee at tier 1");

  assertEqual(lineById(db, "SL-ACME").matchDiffCents, BigInt(-1), "the cent is recorded");
  assertEqual(lineById(db, "SL-DEPOSIT").matchedTransactionCount, 2, "two invoices");
  assertEqual(txnById(db, "TX-CHECK-OLD").matchTier, null, "the old check is unmatched");
  assertEqual(txnById(db, "TX-CHECK-NEW").matchTier, null, "so is the new one");
  assertEqual(batchRow(db).id, BATCH_ID, "and one batch is open on the statement");
});

test("rec pipeline, the difference resolves to a value you can post to", async () => {
  const db = mixedBatch();
  await applyRec(db, recMatchTiered, matchScope(STATEMENT_BALANCE));
  // Tiers 2 through 4 are proposals. A person accepts them on the reconcile
  // screen before they clear, so the pipeline accepts them here.
  for (const id of ["SL-PAYROLL", "SL-ACME", "SL-DEPOSIT"]) confirmLine(db, id);

  const { applied } = await applyRec(db, recClearMatched, clearScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}: ${show(applied.result.errors)}`,
  );

  const batch = batchRow(db);
  assertEqual(
    batch.clearedLedgerBalanceCents,
    CLEARED_LEDGER,
    "the cleared ledger balance is what the books show for the cleared rows",
  );
  assertEqual(batch.diffCents, BigInt(-1), "the difference is one cent");
  assertEqual(batch.state, "out_of_balance", "which is not a clean reconciliation");
  assert(batch.closedAt !== null, "and the batch still closed on that number");

  // One cent, and the run can say where it came from: tier 3 recorded it on the
  // ACME line when it absorbed it. That is a journal entry a person can post,
  // which is the whole point of surfacing the number instead of hiding it.
  const explained = db
    .all("statement_lines")
    .reduce((sum, l) => sum + (l.matchDiffCents ?? BigInt(0)), BigInt(0));
  assertEqual(explained, batch.diffCents, "the difference is fully explained");
  assertEqual(lineById(db, "SL-ACME").matchDiffCents, BigInt(-1), "by the ACME cent");

  // The two uncleared checks are reconciling items behind that number, still
  // outstanding, and they do not move it.
  assertEqual(txnById(db, "TX-CHECK-OLD").cleared, false, "the old check is outstanding");
  assertEqual(txnById(db, "TX-CHECK-NEW").cleared, false, "and so is the new one");
  const clearedTotal = db
    .all("transactions")
    .filter((t) => t.cleared)
    .reduce((sum, t) => sum + t.amountCents, BigInt(0));
  assertEqual(clearedTotal, CLEARED_LEDGER, "and the cleared rows foot to the books");
  assertEqual(
    clearedTotal + (batch.diffCents ?? BigInt(0)),
    STATEMENT_BALANCE,
    "books plus the posting entry equals the bank",
  );
});

test("rec pipeline, the clearing dates all come from the bank", async () => {
  const db = mixedBatch();
  await applyRec(db, recMatchTiered, matchScope(STATEMENT_BALANCE));
  for (const id of ["SL-PAYROLL", "SL-ACME", "SL-DEPOSIT"]) confirmLine(db, id);
  await applyRec(db, recClearMatched, clearScope());

  assertEqual(txnById(db, "TX-PAYROLL").clearedDate, "2026-01-15", "payroll cleared late");
  assertEqual(txnById(db, "TX-PAYROLL").postedDate, "2026-01-12", "and posted early");
  assertEqual(txnById(db, "TX-ACME").clearedDate, "2026-01-17", "acme at the bank date");
  assertEqual(txnById(db, "TX-INV-1").clearedDate, "2026-01-21", "both halves of the");
  assertEqual(txnById(db, "TX-INV-2").clearedDate, "2026-01-21", "deposit on its date");
});

test("rec pipeline, the stale run flags only the old check", async () => {
  const db = mixedBatch();
  await applyRec(db, recMatchTiered, matchScope(STATEMENT_BALANCE));
  for (const id of ["SL-PAYROLL", "SL-ACME", "SL-DEPOSIT"]) confirmLine(db, id);
  await applyRec(db, recClearMatched, clearScope());

  const { applied } = await applyRec(db, recFlagStale, staleScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}: ${show(applied.result.errors)}`,
  );

  const old = txnById(db, "TX-CHECK-OLD");
  assertEqual(old.staleFlagged, true, "the October check is stale");
  assertEqual(old.staleOwner, "firm", "and firm owned");
  assertEqual(old.staleEscalatesOn, "2026-03-12", "on a thirty day clock");
  assertEqual(
    txnById(db, "TX-CHECK-NEW").staleFlagged,
    false,
    "the January check is a timing difference, not a stale item",
  );

  const flagged = db.all("transactions").filter((t) => t.staleFlagged);
  assertEqual(flagged.length, 1, "one row flagged in the whole batch");
  const items = db.all("suspense_items");
  assertEqual(items.length, 1, "one SUS-18 item");
  assertEqual(items[0].reasonCode, SUS_STALE_UNCLEARED, "coded SUS-18");
  assertEqual(items[0].transactionId, "TX-CHECK-OLD", "against the old check");
});

test("rec pipeline, the whole chain leaves the difference where clearing put it", async () => {
  const db = mixedBatch();
  await applyRec(db, recMatchTiered, matchScope(STATEMENT_BALANCE));
  for (const id of ["SL-PAYROLL", "SL-ACME", "SL-DEPOSIT"]) confirmLine(db, id);
  await applyRec(db, recClearMatched, clearScope());
  const before = batchRow(db).diffCents;
  await applyRec(db, recFlagStale, staleScope());
  assertEqual(batchRow(db).diffCents, before, "flagging does not disturb the difference");
  assertEqual(batchRow(db).diffCents, BigInt(-1), "which is still the one cent");
  assertEqual(batchRow(db).state, "out_of_balance", "and the state is unchanged");
});

test("rec pipeline, the override row is matched, cleared, and never recoded", async () => {
  const db = mixedBatch();
  await applyRec(db, recMatchTiered, matchScope(STATEMENT_BALANCE));
  for (const id of ["SL-PAYROLL", "SL-ACME", "SL-DEPOSIT"]) confirmLine(db, id);
  await applyRec(db, recClearMatched, clearScope());
  await applyRec(db, recFlagStale, staleScope());

  const fee = txnById(db, "TX-FEE");
  assertEqual(fee.matchTier, TIER.exactDate, "matched, because the bank showed it");
  assertEqual(fee.cleared, true, "cleared, because clearing is not coding");
  assertEqual(fee.clearedDate, "2026-01-22", "at the bank's date");
  assertEqual(fee.categoryId, "CAT-OWNER-DRAW", "and the coding a person chose stands");
  assertEqual(fee.cascadeLevel, 0, "at the level a person chose");
  assertEqual(fee.manualOverride, true, "with the flag still set");
});

test("rec pipeline, running the whole chain twice changes nothing", async () => {
  const db = mixedBatch();
  await applyRec(db, recMatchTiered, matchScope(STATEMENT_BALANCE));
  for (const id of ["SL-PAYROLL", "SL-ACME", "SL-DEPOSIT"]) confirmLine(db, id);
  await applyRec(db, recClearMatched, clearScope());
  await applyRec(db, recFlagStale, staleScope());

  const clearedIds = db
    .all("transactions")
    .filter((t) => t.cleared)
    .map((t) => t.id)
    .sort()
    .join(",");

  const match2 = await applyRec(db, recMatchTiered, matchScope(STATEMENT_BALANCE));
  assertEqual(match2.applied.result.proposals.length, 0, "matching has nothing left");
  const stale2 = await applyRec(db, recFlagStale, staleScope());
  assertEqual(stale2.applied.result.proposals.length, 0, "flagging has nothing left");

  assertEqual(
    db
      .all("transactions")
      .filter((t) => t.cleared)
      .map((t) => t.id)
      .sort()
      .join(","),
    clearedIds,
    "the same rows are cleared and no others",
  );
  assertEqual(db.all("rec_batches").length, 1, "still one batch");
  assertEqual(db.all("suspense_items").length, 1, "still one item");
  assertEqual(db.all("portal_requests").length, 1, "still one follow up");
  assertEqual(batchRow(db).diffCents, BigInt(-1), "and the difference is unchanged");
});

test("rec pipeline, a statement the books never saw surfaces its whole balance", async () => {
  const db = recDb();
  // The books have nothing for this account in January, and the bank has one
  // line. This is the case the firm has to see, not the case that quietly passes.
  db.seed("statement_lines", [statementLine("SL-MYSTERY", "2026-01-14", BigInt(-88800))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-88800)));
  await applyRec(db, recClearMatched, clearScope());

  const batch = batchRow(db);
  assertEqual(batch.clearedLedgerBalanceCents, BigInt(0), "nothing cleared");
  assertEqual(batch.diffCents, BigInt(-88800), "the whole statement is the difference");
  assertEqual(batch.state, "out_of_balance", "and the batch says out of balance");
});

test("rec pipeline, the registry states the order the runs go in", () => {
  assertEqual(
    RECONCILIATION_ORDER.join(","),
    "REC-MATCH-TIERED,REC-CLEAR-MATCHED,REC-FLAG-STALE",
    "match, then clear, then flag",
  );
  assertEqual(recMatchTiered.type, "REC-MATCH-TIERED", "the matching run");
  assertEqual(recClearMatched.type, "REC-CLEAR-MATCHED", "the clearing run");
  assertEqual(recFlagStale.type, "REC-FLAG-STALE", "the flagging run");
});
