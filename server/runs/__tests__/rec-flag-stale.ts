/**
 * REC-FLAG-STALE tests.
 *
 * The rule that matters most here is the negative one: the run flags a row and
 * never recodes it. Half of these tests are about what the run leaves alone.
 */

import { isFieldWrite, isRowInsert, isSuspenseRouting } from "../contract";
import { canonicalJson, toJsonValue } from "../ids";
import { DEFAULT_STALE_DAYS, recFlagStale } from "../runs/rec-flag-stale";
import { SUS_STALE_UNCLEARED } from "../runs/rec-shared";
import { CLIENT_A1, FIRM_A, lock, txn } from "./fixtures";
import {
  ACCOUNT,
  applyRec,
  previewRec,
  recDb,
  skipDetails,
  skippedFor,
  staleScope,
  txnById,
} from "./rec-fixtures";
import { assert, assertEqual, show, test } from "./harness";

const book = (
  id: string,
  postedDate: string,
  amountCents: bigint,
  extra: Parameters<typeof txn>[6] = {},
) => txn(id, FIRM_A, CLIENT_A1, ACCOUNT, postedDate, amountCents, extra);

// As of is 2026-02-10. A row posted 2025-11-01 is one hundred and one days old,
// which is past every threshold in the table.
const OLD = "2025-11-01";
const RECENT = "2026-02-05";

// Happy path. Flagged, owned, and given a follow up date.
test("rec stale, an old outstanding item is flagged and given an owner", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-OLD", OLD, BigInt(-25000))]);

  const { applied } = await applyRec(db, recFlagStale, staleScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );

  const row = txnById(db, "TX-OLD");
  assertEqual(row.staleFlagged, true, "flagged");
  assertEqual(row.staleFlaggedOn, "2026-02-10", "on the as of date");
  assertEqual(row.staleOwner, "firm", "SUS-18 is firm owned");
  assertEqual(row.staleEscalatesOn, "2026-03-12", "thirty days out");

  const items = db.all("suspense_items").filter((i) => i.transactionId === "TX-OLD");
  assertEqual(items.length, 1, "one work item");
  assertEqual(items[0].reasonCode, SUS_STALE_UNCLEARED, "coded SUS-18");
  assertEqual(items[0].withdrawnByRunId, null, "and standing");

  const requests = db.all("portal_requests").filter((r) => r.transactionId === "TX-OLD");
  assertEqual(requests.length, 1, "one follow up");
  assertEqual(requests[0].dueOn, "2026-03-12", "due on the escalation date");
  assertEqual(requests[0].status, "open", "and open");
});

// Nothing stale at all. The run completes and writes nothing.
test("rec stale, a clean account produces no flags at all", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-NEW", RECENT, BigInt(-25000)),
    book("TX-CLEARED", OLD, BigInt(-9000), {
      cleared: true,
      clearedDate: "2025-11-03",
    }),
  ]);

  const { applied } = await applyRec(db, recFlagStale, staleScope());
  assertEqual(txnById(db, "TX-NEW").staleFlagged, false, "too recent to be stale");
  assertEqual(txnById(db, "TX-CLEARED").staleFlagged, false, "cleared is not outstanding");
  assertEqual(applied.result.proposals.length, 0, "nothing was proposed");
  assertEqual(db.all("suspense_items").length, 0, "no items raised");
  assertEqual(db.all("portal_requests").length, 0, "no follow ups raised");
  assert(
    skippedFor(applied, "TX-NEW", "missing_prerequisite"),
    `expected the young row reported, got ${show(applied.result.skips)}`,
  );
});

// The override contract. Not flagged, and above all not recoded.
test("rec stale, an overridden row is skipped and never recoded", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-OVR", OLD, BigInt(-25000), {
      manualOverride: true,
      categoryId: "CAT-OWNER-DRAW",
      cascadeLevel: 0,
      suspenseReason: "SUS-08",
    }),
  ]);

  const { applied } = await applyRec(db, recFlagStale, staleScope());
  assertEqual(applied.overriddenInScope, 1, "the override is counted");
  assert(
    skippedFor(applied, "TX-OVR", "manual_override"),
    `expected manual_override, got ${show(applied.result.skips)}`,
  );
  const row = txnById(db, "TX-OVR");
  assertEqual(row.staleFlagged, false, "not flagged");
  assertEqual(row.categoryId, "CAT-OWNER-DRAW", "and the coding is untouched");
  assertEqual(row.suspenseReason, "SUS-08", "including the suspense reason");
  assertEqual(row.cascadeLevel, 0, "and the level");
  assertEqual(db.all("suspense_items").length, 0, "no item was raised against it");
});

// Tier ordering, as it reaches this run: a matched and cleared row is not stale
// however it was matched, and the tier 1 row is the one that stopped being an
// outstanding item.
test("rec stale, a cleared tier 1 row is not stale and its unmatched twin is", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-CLEARED-T1", OLD, BigInt(-30000), {
      cleared: true,
      clearedDate: "2025-11-02",
      matchTier: 1,
      matchConfidence: 100,
    }),
    book("TX-STILL-OUT", OLD, BigInt(-30000)),
  ]);

  await applyRec(db, recFlagStale, staleScope());
  assertEqual(
    txnById(db, "TX-CLEARED-T1").staleFlagged,
    false,
    "the matched and cleared row is settled",
  );
  assertEqual(
    txnById(db, "TX-STILL-OUT").staleFlagged,
    true,
    "the identical row the bank never showed is stale",
  );
});

test("rec stale, no coding column is ever written", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-A", OLD, BigInt(-25000), { categoryId: "CAT-SUPPLIES", cascadeLevel: 3 }),
    book("TX-B", OLD, BigInt(4000), { categoryId: "CAT-INCOME", cascadeLevel: 3 }),
  ]);

  const { applied } = await applyRec(db, recFlagStale, staleScope());
  const coding = ["categoryId", "categoryVersion", "cascadeLevel", "classId", "suspenseReason"];
  for (const p of applied.result.proposals) {
    if (!isFieldWrite(p)) continue;
    for (const field of Object.keys(p.after)) {
      assert(!coding.includes(field), `proposal wrote coding field ${field}`);
    }
  }
  assertEqual(txnById(db, "TX-A").categoryId, "CAT-SUPPLIES", "coding survives intact");
  assertEqual(txnById(db, "TX-A").cascadeLevel, 3, "and so does the level");
  assertEqual(txnById(db, "TX-B").categoryId, "CAT-INCOME", "on both rows");
});

test("rec stale, thresholds are per instrument by default", async () => {
  const db = recDb();
  // Twenty days old at the as of date. Past deposit at ten, past electronic at
  // thirty only if you ignore the instrument, under check at ninety.
  db.seed("transactions", [
    book("TX-DEP", "2026-01-21", BigInt(9000), { instrumentType: "deposit" }),
    book("TX-ACH", "2026-01-21", BigInt(-9000), { instrumentType: "electronic" }),
    book("TX-CHK", "2026-01-21", BigInt(-9000), {
      instrumentType: "issued_check",
      checkNumber: "1042",
    }),
  ]);

  await applyRec(db, recFlagStale, staleScope());
  assertEqual(txnById(db, "TX-DEP").staleFlagged, true, "a deposit at ten days is stale");
  assertEqual(txnById(db, "TX-ACH").staleFlagged, false, "an ACH at thirty is not yet");
  assertEqual(txnById(db, "TX-CHK").staleFlagged, false, "a check at ninety is not yet");
});

test("rec stale, an explicit threshold overrides every instrument default", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-CHK", "2026-01-21", BigInt(-9000), {
      instrumentType: "issued_check",
      checkNumber: "1042",
    }),
  ]);

  await applyRec(db, recFlagStale, staleScope({ thresholdDays: 15 }));
  assertEqual(
    txnById(db, "TX-CHK").staleFlagged,
    true,
    "fifteen days beats the ninety day check default",
  );
});

test("rec stale, the default threshold in the brief is sixty days", async () => {
  assertEqual(DEFAULT_STALE_DAYS, 60, "the documented default");
  const db = recDb();
  // Fifty nine days and sixty one days, either side of the line, both coded to
  // the other bucket so the sixty day default is the one being tested.
  db.seed("transactions", [
    book("TX-59", "2025-12-13", BigInt(-9000), { instrumentType: "other" }),
    book("TX-61", "2025-12-11", BigInt(-9000), { instrumentType: "other" }),
  ]);
  await applyRec(db, recFlagStale, staleScope());
  assertEqual(txnById(db, "TX-59").staleFlagged, false, "fifty nine days is not stale");
  assertEqual(txnById(db, "TX-61").staleFlagged, true, "sixty one days is");
});

test("rec stale, a very old item is also marked for escheat review", async () => {
  const db = recDb();
  db.seed("transactions", [
    // Well past one hundred and eighty days.
    book("TX-ANCIENT", "2025-06-01", BigInt(-25000), {
      instrumentType: "issued_check",
      checkNumber: "1001",
    }),
    book("TX-OLD", OLD, BigInt(-25000), {
      instrumentType: "issued_check",
      checkNumber: "1002",
    }),
  ]);

  await applyRec(db, recFlagStale, staleScope());
  assertEqual(txnById(db, "TX-ANCIENT").escheatReview, true, "flagged for review");
  assertEqual(txnById(db, "TX-ANCIENT").staleFlagged, true, "and stale as well");
  assertEqual(
    txnById(db, "TX-OLD").escheatReview,
    false,
    "one hundred and one days is stale but not unclaimed property",
  );
});

test("rec stale, a row posted after the as of date is out of scope entirely", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-OLD", OLD, BigInt(-25000)),
    // Posted after the as of date. An item cannot be outstanding before it
    // exists, so the window query never offers it and nothing is written.
    book("TX-FUTURE", "2026-03-01", BigInt(-25000)),
  ]);
  const { applied } = await applyRec(db, recFlagStale, staleScope());
  assertEqual(txnById(db, "TX-FUTURE").staleFlagged, false, "not flagged");
  assertEqual(txnById(db, "TX-OLD").staleFlagged, true, "the old row still was");
  assertEqual(
    skipDetails(applied, "TX-FUTURE").length,
    0,
    `a row outside the window is not even a candidate, got ${show(applied.result.skips)}`,
  );
  assertEqual(applied.result.totals.candidates, 1, "one candidate, not two");
});

test("rec stale, a second run does not flag or escalate the same row twice", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-OLD", OLD, BigInt(-25000))]);
  await applyRec(db, recFlagStale, staleScope());

  const second = await previewRec(db, recFlagStale, staleScope());
  assertEqual(second.result.proposals.length, 0, "nothing left to propose");
  assert(
    skipDetails(second, "TX-OLD").some((d) => d.includes("stale_flag_exists")),
    `expected stale_flag_exists, got ${show(second.result.skips)}`,
  );
  assertEqual(db.all("suspense_items").length, 1, "still one item");
  assertEqual(db.all("portal_requests").length, 1, "still one follow up");
});

test("rec stale, a row with an open follow up is not asked again", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-OLD", OLD, BigInt(-25000))]);
  await applyRec(db, recFlagStale, staleScope());
  // Clear the flag the way a person might while leaving the request open. The
  // request is the thing that stops a second ask.
  db.seed("transactions", [
    { ...txnById(db, "TX-OLD"), staleFlagged: false, staleFlaggedOn: null },
  ]);

  const again = await previewRec(db, recFlagStale, staleScope());
  assert(
    again.result.proposals.filter(isRowInsert).length === 0,
    "no second follow up was proposed",
  );
  assert(
    skippedFor(again, "TX-OLD", "already_applied"),
    `expected already_applied, got ${show(again.result.skips)}`,
  );
});

test("rec stale, a locked period is skipped and nothing is written", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-OLD", OLD, BigInt(-25000))]);
  db.seed("period_locks", [
    lock("LK-NOV", FIRM_A, CLIENT_A1, "2025-11-01", "2025-11-30"),
  ]);

  const { applied } = await applyRec(db, recFlagStale, staleScope());
  assertEqual(txnById(db, "TX-OLD").staleFlagged, false, "not flagged");
  assert(
    skippedFor(applied, "TX-OLD", "locked_period"),
    `expected locked_period, got ${show(applied.result.skips)}`,
  );
  assertEqual(db.all("suspense_items").length, 0, "and no item was raised");
});

test("rec stale, the bank account filter narrows the scope", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-OP", OLD, BigInt(-25000)),
    txn("TX-SV", FIRM_A, CLIENT_A1, "BA-A1-SV", OLD, BigInt(-11000)),
  ]);

  await applyRec(db, recFlagStale, staleScope({ bankAccountIds: ["BA-A1-SV"] }));
  assertEqual(txnById(db, "TX-OP").staleFlagged, false, "the operating account was out");
  assertEqual(txnById(db, "TX-SV").staleFlagged, true, "the savings account was in");
});

test("rec stale, preview and apply produce identical proposals", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-1", OLD, BigInt(-25000)),
    book("TX-2", "2025-06-01", BigInt(-1200), {
      instrumentType: "issued_check",
      checkNumber: "1001",
    }),
    book("TX-3", RECENT, BigInt(700)),
  ]);
  const { preview, applied } = await applyRec(db, recFlagStale, staleScope());
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

test("rec stale, a preview raises no flag, no item, and no follow up", async () => {
  const db = recDb();
  db.seed("transactions", [book("TX-OLD", OLD, BigInt(-25000))]);
  const preview = await previewRec(db, recFlagStale, staleScope());
  assert(preview.result.proposals.some(isSuspenseRouting), "an item was proposed");
  assertEqual(txnById(db, "TX-OLD").staleFlagged, false, "and nothing was written");
  assertEqual(db.all("suspense_items").length, 0, "no item row");
  assertEqual(db.all("portal_requests").length, 0, "no follow up row");
});

test("rec stale, flagging moves no money", async () => {
  const db = recDb();
  db.seed("transactions", [
    book("TX-1", OLD, BigInt(-25000)),
    book("TX-2", OLD, BigInt(4000)),
  ]);
  const preview = await previewRec(db, recFlagStale, staleScope());
  assertEqual(preview.result.totals.netCents, BigInt(0), "no journal effect");
  assertEqual(preview.result.totals.failed, 0, "and nothing failed");
});
