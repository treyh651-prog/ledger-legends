/**
 * REC-MATCH-TIERED tests.
 *
 * The four the brief requires, plus the ones the tiers themselves force: the
 * window boundary, the vendor requirement that makes the cent tolerance safe,
 * the ambiguity rule, and the group match that only tier 4 can explain.
 */

import { isFieldWrite, isRowInsert, type Proposal } from "../contract";
import { canonicalJson, toJsonValue } from "../ids";
import { recMatchTiered, matchTieredScopeSchema } from "../runs/rec-match-tiered";
import { CONFIDENCE, TIER } from "../runs/rec-shared";
import { CLIENT_A1, FIRM_A, lock, txn } from "./fixtures";
import {
  ACCOUNT,
  BATCH_ID,
  applyRec,
  batchRow,
  lineById,
  matchScope,
  previewRec,
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

// Happy path. One line, one book row, same day, same cents.
test("rec match, tier 1 matches an exact amount on the same date", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);

  const { applied } = await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );

  const line = lineById(db, "SL-1");
  assertEqual(line.matchTier, TIER.exactDate, "tier 1");
  assertEqual(line.matchConfidence, CONFIDENCE[TIER.exactDate], "confidence 100");
  assertEqual(line.matchDiffCents, BigInt(0), "no cent difference absorbed");
  assertEqual(line.matchConfirmed, true, "tier 1 is identity, so it is confirmed");
  assertEqual(line.matchedTransactionId, "TX-1", "the register row it names");
  assertEqual(line.matchedTransactionCount, 1, "one row");
  assertEqual(line.recBatchId, BATCH_ID, "and it belongs to the batch");

  const row = txnById(db, "TX-1");
  assertEqual(row.matchTier, TIER.exactDate, "the register row carries the tier");
  assertEqual(row.statementLineId, "SL-1", "and points back at the line");
  assertEqual(row.statementDate, "2026-01-10", "and carries the bank's date");
  assertEqual(row.recBatchId, BATCH_ID, "and the batch");
  assertEqual(row.cleared, false, "matching does not clear, clearing clears");

  const batch = batchRow(db);
  assertEqual(batch.state, "open", "the batch is opened, not closed");
  assertEqual(batch.statementBalanceCents, BigInt(-25000), "with the statement balance");
  assertEqual(batch.diffCents, null, "and no difference yet");
});

// No matches at all. The batch still opens, which is what lets the difference
// surface when REC-CLEAR-MATCHED closes it.
test("rec match, a statement that matches nothing still opens the batch", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-FAR", "2026-01-01", BigInt(-11111))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-25", BigInt(-99999))]);

  const { applied } = await applyRec(db, recMatchTiered, matchScope(BigInt(-99999)));
  const line = lineById(db, "SL-1");
  assertEqual(line.matchTier, null, "the line is unmatched");
  assertEqual(txnById(db, "TX-FAR").statementLineId, null, "and so is the book row");
  assert(
    skippedFor(applied, "SL-1", "missing_prerequisite"),
    `expected a missing_prerequisite skip, got ${show(applied.result.skips)}`,
  );
  const batch = batchRow(db);
  assertEqual(batch.state, "open", "the batch exists and is open");
  assertEqual(batch.statementBalanceCents, BigInt(-99999), "carrying the whole balance");
});

// The override contract. Matched, and not recoded.
test("rec match, an overridden row is matched and never recoded", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-OVR", "2026-01-10", BigInt(-25000), {
      manualOverride: true,
      categoryId: "CAT-OWNER-DRAW",
      cascadeLevel: 0,
      classId: "CLS-OWNER",
    }),
  ]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);

  const { applied } = await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );
  assertEqual(applied.overriddenInScope, 1, "the override is reported, not hidden");

  const row = txnById(db, "TX-OVR");
  assertEqual(row.matchTier, TIER.exactDate, "the row was matched");
  assertEqual(row.statementLineId, "SL-1", "and linked to the line");
  // The coding is untouched, which is the whole point.
  assertEqual(row.categoryId, "CAT-OWNER-DRAW", "its category is unchanged");
  assertEqual(row.cascadeLevel, 0, "its cascade level is unchanged");
  assertEqual(row.classId, "CLS-OWNER", "its class is unchanged");
  assertEqual(row.manualOverride, true, "and it still carries the flag");

  // Nothing in the proposal set touches a coding column.
  const coding = ["categoryId", "categoryVersion", "cascadeLevel", "classId", "suspenseReason"];
  for (const p of applied.result.proposals) {
    if (!isFieldWrite(p)) continue;
    for (const field of Object.keys(p.after)) {
      assert(!coding.includes(field), `proposal wrote coding field ${field}`);
    }
  }
});

// Tier ordering. T1 wins over T4 when both explain the same line.
test("rec match, tier 1 wins over tier 4 when both are possible", async () => {
  const db = recDb();
  db.seed("transactions", [
    // The tier 1 answer: one row, exact cents, same date.
    book("TX-EXACT", "2026-01-10", BigInt(-30000)),
    // The tier 4 answer: two rows in the window summing to the same amount.
    book("TX-PART-A", "2026-01-08", BigInt(-10000)),
    book("TX-PART-B", "2026-01-09", BigInt(-20000)),
  ]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-30000))]);

  const { applied } = await applyRec(db, recMatchTiered, matchScope(BigInt(-30000)));
  const line = lineById(db, "SL-1");
  assertEqual(line.matchTier, TIER.exactDate, "tier 1 took it");
  assertEqual(line.matchedTransactionId, "TX-EXACT", "the exact same day row");
  assertEqual(line.matchedTransactionCount, 1, "one row, not a group of two");
  assertEqual(txnById(db, "TX-PART-A").matchTier, null, "the group was not used");
  assertEqual(txnById(db, "TX-PART-B").matchTier, null, "neither half of it");
  assert(
    applied.result.proposals.filter(isFieldWrite).length === 2,
    "one line write and one register write, nothing more",
  );
});

test("rec match, tier 2 matches an exact amount inside the window", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-08", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-12", BigInt(-25000))]);

  await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  const line = lineById(db, "SL-1");
  assertEqual(line.matchTier, TIER.exactWindow, "tier 2, four days apart");
  assertEqual(line.matchConfidence, CONFIDENCE[TIER.exactWindow], "confidence 90");
  assertEqual(
    line.matchConfirmed,
    false,
    "tier 2 is a proposal a person accepts, not identity",
  );
});

test("rec match, the window is inclusive and one day past it is no match", async () => {
  const inside = recDb();
  inside.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  inside.seed("statement_lines", [statementLine("SL-1", "2026-01-15", BigInt(-25000))]);
  await applyRec(inside, recMatchTiered, matchScope(BigInt(-25000)));
  assertEqual(lineById(inside, "SL-1").matchTier, TIER.exactWindow, "five days matches");

  const outside = recDb();
  outside.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  outside.seed("statement_lines", [statementLine("SL-1", "2026-01-16", BigInt(-25000))]);
  await applyRec(outside, recMatchTiered, matchScope(BigInt(-25000)));
  assertEqual(lineById(outside, "SL-1").matchTier, null, "six days does not");
});

test("rec match, tier 3 needs the cent tolerance and the vendor together", async () => {
  const withVendor = recDb();
  withVendor.seed("transactions", [
    book("TX-1", "2026-01-10", BigInt(-25000), { normalizedVendor: "ACME SUPPLY" }),
  ]);
  withVendor.seed("statement_lines", [
    statementLine("SL-1", "2026-01-11", BigInt(-25001), {
      normalizedVendor: "ACME SUPPLY",
    }),
  ]);
  await applyRec(withVendor, recMatchTiered, matchScope(BigInt(-25001)));
  const line = lineById(withVendor, "SL-1");
  assertEqual(line.matchTier, TIER.tolerantVendor, "tier 3 took the one cent");
  assertEqual(line.matchDiffCents, BigInt(-1), "and recorded the exact difference");
  assertEqual(line.matchConfidence, CONFIDENCE[TIER.tolerantVendor], "confidence 80");

  // Same cent difference, different vendor. A tolerance without a vendor test
  // would match unrelated money, so it does not match at all.
  const wrongVendor = recDb();
  wrongVendor.seed("transactions", [
    book("TX-1", "2026-01-10", BigInt(-25000), { normalizedVendor: "ACME SUPPLY" }),
  ]);
  wrongVendor.seed("statement_lines", [
    statementLine("SL-1", "2026-01-11", BigInt(-25001), {
      normalizedVendor: "SOMEONE ELSE",
    }),
  ]);
  await applyRec(wrongVendor, recMatchTiered, matchScope(BigInt(-25001)));
  assertEqual(lineById(wrongVendor, "SL-1").matchTier, null, "no vendor, no tier 3");
});

test("rec match, tier 4 matches one deposit against several invoices", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-INV-1", "2026-01-08", BigInt(40000)),
    book("TX-INV-2", "2026-01-09", BigInt(35000)),
    book("TX-UNRELATED", "2026-01-09", BigInt(-500)),
  ]);
  db.seed("statement_lines", [statementLine("SL-DEP", "2026-01-12", BigInt(75000))]);

  await applyRec(db, recMatchTiered, matchScope(BigInt(75000)));
  const line = lineById(db, "SL-DEP");
  assertEqual(line.matchTier, TIER.sumToSum, "tier 4");
  assertEqual(line.matchedTransactionCount, 2, "two rows in the group");
  assertEqual(line.matchedTransactionId, null, "a group carries no single id");
  assertEqual(txnById(db, "TX-INV-1").statementLineId, "SL-DEP", "first invoice linked");
  assertEqual(txnById(db, "TX-INV-2").statementLineId, "SL-DEP", "second invoice linked");
  assertEqual(
    txnById(db, "TX-UNRELATED").statementLineId,
    null,
    "the opposite sign row was never considered",
  );
});

test("rec match, a tie at a tier is reported and no weaker tier is tried", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-A", "2026-01-10", BigInt(-25000)),
    book("TX-B", "2026-01-10", BigInt(-25000)),
  ]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);

  const { applied } = await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  assertEqual(lineById(db, "SL-1").matchTier, null, "nothing was matched");
  assert(
    skippedFor(applied, "SL-1", "ambiguous_candidate"),
    `expected ambiguous_candidate, got ${show(applied.result.skips)}`,
  );
  assertEqual(txnById(db, "TX-A").matchTier, null, "neither candidate was written");
  assertEqual(txnById(db, "TX-B").matchTier, null, "nor the other");
});

test("rec match, a second run over the same statement matches nothing new", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));

  const second = await previewRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  assertEqual(second.result.proposals.length, 0, "nothing left to propose");
  assert(
    skippedFor(second, "SL-1", "already_applied"),
    `expected already_applied, got ${show(second.result.skips)}`,
  );
  assert(
    skippedFor(second, BATCH_ID, "already_applied"),
    "and the batch is reported as already open rather than opened twice",
  );
  assertEqual(db.all("rec_batches").length, 1, "still one batch row");
});

test("rec match, preview and apply produce identical proposals", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-1", "2026-01-10", BigInt(-25000)),
    book("TX-2", "2026-01-12", BigInt(-1000), { normalizedVendor: "ACME SUPPLY" }),
    book("TX-3", "2026-01-14", BigInt(9000)),
  ]);
  db.seed("statement_lines", [
    statementLine("SL-1", "2026-01-10", BigInt(-25000)),
    statementLine("SL-2", "2026-01-13", BigInt(-1001), {
      normalizedVendor: "ACME SUPPLY",
    }),
    statementLine("SL-3", "2026-01-20", BigInt(-777)),
  ]);
  const { preview, applied } = await applyRec(
    db,
    recMatchTiered,
    matchScope(BigInt(-17778)),
  );
  assertEqual(
    canonicalJson(toJsonValue(preview.result.proposals)),
    canonicalJson(toJsonValue(applied.result.proposals)),
    "the two modes proposed the same set",
  );
  assertEqual(
    canonicalJson(toJsonValue(preview.result.skips)),
    canonicalJson(toJsonValue(applied.result.skips)),
    "and the same skips",
  );
  assertEqual(preview.scopeHash, applied.scopeHash, "and the same scope hash");
});

test("rec match, a preview writes nothing at all", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  const preview = await previewRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  assert(preview.result.proposals.length > 0, "the preview did propose work");
  assertEqual(db.all("rec_batches").length, 0, "no batch row was inserted");
  assertEqual(lineById(db, "SL-1").matchTier, null, "no line write survived");
  assertEqual(txnById(db, "TX-1").matchTier, null, "no register write survived");
});

test("rec match, a locked statement date is skipped and never written", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await applyRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  assertEqual(lineById(db, "SL-1").matchTier, null, "nothing was matched");
  assert(
    skippedFor(applied, "SL-1", "locked_period"),
    `expected locked_period, got ${show(applied.result.skips)}`,
  );
});

test("rec match, the money side never becomes a number", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  db.seed("statement_lines", [statementLine("SL-1", "2026-01-10", BigInt(-25000))]);
  const preview = await previewRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  for (const p of preview.result.proposals) {
    if (isRowInsert(p)) {
      assertEqual(
        typeof p.row.statementBalanceCents,
        "bigint",
        "the batch balance is bigint",
      );
    }
    if (isFieldWrite(p) && p.table === "statement_lines") {
      assertEqual(typeof p.after.matchDiffCents, "bigint", "the diff is bigint");
    }
  }
  assertEqual(preview.result.totals.netCents, BigInt(0), "matching moves no money");
});

test("rec match, the scope schema rejects a malformed scope", () => {
  const badBalance = matchTieredScopeSchema.safeParse({
    ...matchScope(BigInt(0)),
    statementBalanceCents: "-250.00",
  });
  assert(!badBalance.success, "a decimal balance is refused, cents are integers");
  const badPeriod = matchTieredScopeSchema.safeParse({
    ...matchScope(BigInt(0)),
    statementPeriod: "January",
  });
  assert(!badPeriod.success, "a period that is not YYYY-MM is refused");
  const good = matchTieredScopeSchema.safeParse(matchScope(BigInt(-25000)));
  assert(good.success, "a well formed scope passes");
});

test("rec match, a statement with no lines is an error and applies nothing", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-1", "2026-01-10", BigInt(-25000))]);
  const preview = await previewRec(db, recMatchTiered, matchScope(BigInt(-25000)));
  assertEqual(preview.status, "refused", "the preview is refused");
  assert(
    preview.result.errors.some((e) => e.code === "REC_STATEMENT_HAS_NO_LINES"),
    `expected REC_STATEMENT_HAS_NO_LINES, got ${show(preview.result.errors)}`,
  );
  const proposals: Proposal[] = preview.result.proposals;
  assert(proposals.length <= 1, "at most the batch insert was proposed");
  assertEqual(db.all("rec_batches").length, 0, "and nothing was written");
});
