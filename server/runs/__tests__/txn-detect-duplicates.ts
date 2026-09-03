/**
 * TXN-DETECT-DUPLICATES tests. Cascade step 2.
 *
 * Three things are covered:
 *   1. Happy path. Two rows on the same account with the same absolute amount,
 *      the same normalized vendor, and a gap inside the window produce one flag
 *      on the later row, one pointer at the earlier row, and one SUS-05 item.
 *   2. Skip path. A row a person already confirmed as a legitimate repeat is
 *      skipped with the reason recorded, and so is a row already flagged.
 *   3. Ordering. This run comes after TXN-NORMALIZE-VENDORS, because the match
 *      key is the normalized vendor. Two rows the bank described differently only
 *      resemble each other after normalization has run.
 */

import { isFieldWrite, isSuspenseRouting } from "../contract";
import type { SuspenseItemRow, TransactionRow } from "../tables";
import {
  DUPLICATE_WINDOW_DAYS,
  SUS_POSSIBLE_DUPLICATE,
  txnDetectDuplicates,
} from "../runs/txn-detect-duplicates";
import { txnNormalizeVendors } from "../runs/txn-normalize-vendors";
import { CLIENT_A1, FIRM_A, scopeFor, txn } from "./fixtures";
import {
  applyCoding,
  codingDb,
  previewCoding,
  skipDetails,
  skippedFor,
} from "./coding-fixtures";
import { assert, assertEqual, show, test } from "./harness";

test("detect duplicates, happy path flags the later row and points at the earlier", async () => {
  const db = codingDb();
  db.seed("transactions", [
    txn("TX-A", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-4999), {
      normalizedVendor: "ACME SUPPLY",
    }),
    txn("TX-B", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-12", BigInt(-4999), {
      normalizedVendor: "ACME SUPPLY",
    }),
    txn("TX-C", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-13", BigInt(-4999), {
      normalizedVendor: "ACME SUPPLY",
    }),
  ]);

  const { applied } = await applyCoding(db, txnDetectDuplicates, scopeFor(CLIENT_A1));
  assertEqual(applied.status, "completed", `status ${show(applied.status)}`);
  assertEqual(
    applied.result.proposals.filter(isFieldWrite).length,
    2,
    "two later rows flagged, the earliest is the retained original",
  );
  assertEqual(
    applied.result.proposals.filter(isSuspenseRouting).length,
    2,
    "one SUS-05 per flagged row",
  );

  const rows = db.all("transactions") as TransactionRow[];
  const original = rows.find((r) => r.id === "TX-A");
  assertEqual(original?.duplicateFlag, false, "the original is never flagged");
  for (const id of ["TX-B", "TX-C"]) {
    const row = rows.find((r) => r.id === id);
    assertEqual(row?.duplicateFlag, true, `${id} is flagged`);
    assertEqual(
      row?.duplicateOfTransactionId,
      "TX-A",
      `${id} points at the earliest row, not at a chain`,
    );
    assertEqual(row?.cascadeLevel, 2, `${id} records cascade level 2`);
  }
  const items = db.all("suspense_items") as SuspenseItemRow[];
  assert(
    items.every((i) => i.reasonCode === SUS_POSSIBLE_DUPLICATE),
    `every item carries ${SUS_POSSIBLE_DUPLICATE}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "nothing was posted or netted");
});

test("detect duplicates, the window is 3 calendar days and the amount is exact", async () => {
  const far = codingDb();
  far.seed("transactions", [
    txn("TX-A", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-4999), {
      normalizedVendor: "ACME SUPPLY",
    }),
    txn("TX-B", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-14", BigInt(-4999), {
      normalizedVendor: "ACME SUPPLY",
    }),
  ]);
  const outside = await previewCoding(far, txnDetectDuplicates, scopeFor(CLIENT_A1));
  assertEqual(
    outside.result.proposals.length,
    0,
    `a gap of ${String(DUPLICATE_WINDOW_DAYS + 1)} days is not a duplicate`,
  );

  const cent = codingDb();
  cent.seed("transactions", [
    txn("TX-A", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-4999), {
      normalizedVendor: "ACME SUPPLY",
    }),
    txn("TX-B", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-11", BigInt(-5000), {
      normalizedVendor: "ACME SUPPLY",
    }),
  ]);
  const nearMiss = await previewCoding(cent, txnDetectDuplicates, scopeFor(CLIENT_A1));
  assertEqual(nearMiss.result.proposals.length, 0, "one cent apart is not a duplicate");

  const otherAccount = codingDb();
  otherAccount.seed("transactions", [
    txn("TX-A", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-4999), {
      normalizedVendor: "ACME SUPPLY",
    }),
    txn("TX-B", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-10", BigInt(-4999), {
      normalizedVendor: "ACME SUPPLY",
    }),
  ]);
  const split = await previewCoding(
    otherAccount,
    txnDetectDuplicates,
    scopeFor(CLIENT_A1),
  );
  assertEqual(split.result.proposals.length, 0, "two accounts is not a duplicate");
});

test("detect duplicates, skip path records the confirmed repeat", async () => {
  const db = codingDb();
  db.seed("transactions", [
    txn("TX-A", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-4999), {
      normalizedVendor: "ACME SUPPLY",
    }),
    txn("TX-REPEAT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-11", BigInt(-4999), {
      normalizedVendor: "ACME SUPPLY",
      legitimateRepeat: true,
    }),
    txn("TX-FLAGGED", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-12", BigInt(-4999), {
      normalizedVendor: "ACME SUPPLY",
      duplicateFlag: true,
      duplicateOfTransactionId: "TX-A",
    }),
  ]);

  const preview = await previewCoding(db, txnDetectDuplicates, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "nothing left to flag");
  assert(
    skippedFor(preview, "TX-REPEAT", "already_applied"),
    `expected already_applied, got ${show(skipDetails(preview, "TX-REPEAT"))}`,
  );
  assertEqual(
    skipDetails(preview, "TX-REPEAT")[0],
    "already_applied:confirmed_repeat",
    "and the detail says a person already confirmed the repeat",
  );
  assertEqual(
    skipDetails(preview, "TX-FLAGGED")[0],
    "already_applied:duplicate_flag_exists",
    "an already flagged row is not flagged twice",
  );
});

test("detect duplicates, ordering, the match key does not exist before normalization", async () => {
  const seed = (): ReturnType<typeof codingDb> => {
    const db = codingDb();
    db.seed("transactions", [
      txn("TX-A", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-4999), {
        description: "SQ *ACME SUPPLY 0012",
        normalizedVendor: null,
      }),
      txn("TX-B", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-11", BigInt(-4999), {
        description: "sq *acme supply #77",
        normalizedVendor: null,
      }),
    ]);
    return db;
  };

  // Duplicates first, which is the wrong order. The two descriptors are raw and
  // they are not equal, so the run sees nothing.
  const outOfOrder = seed();
  const early = await previewCoding(
    outOfOrder,
    txnDetectDuplicates,
    scopeFor(CLIENT_A1),
  );
  assertEqual(early.result.proposals.length, 0, "raw descriptors do not match");

  // Documented order. Normalize first and the same two rows resemble each other.
  const inOrder = seed();
  await applyCoding(inOrder, txnNormalizeVendors, scopeFor(CLIENT_A1));
  const keys = (inOrder.all("transactions") as TransactionRow[]).map(
    (r) => r.normalizedVendor,
  );
  assertEqual(keys[0], keys[1], "normalization put both rows on one key");
  const late = await previewCoding(inOrder, txnDetectDuplicates, scopeFor(CLIENT_A1));
  assertEqual(
    late.result.proposals.filter(isFieldWrite).length,
    1,
    "and only now is the later row flagged",
  );
});
