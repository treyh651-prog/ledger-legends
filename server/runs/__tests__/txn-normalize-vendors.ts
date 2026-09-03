/**
 * TXN-NORMALIZE-VENDORS tests. Cascade step 1.
 *
 * Three things are covered:
 *   1. Happy path. The seven documented steps run in order and the register row
 *      comes back with a normalized vendor and the version stamp that says which
 *      normalizer produced it.
 *   2. Skip path. A row already carrying the current version is skipped with the
 *      reason recorded, so a rerun over a month that is already normalized is a
 *      no op rather than a rewrite.
 *   3. Ordering. This run has to come before TXN-APPLY-RULES. The proof is that
 *      a rule which would otherwise match cannot fire until this run has written
 *      the vendor key the rule reads.
 */

import { isFieldWrite } from "../contract";
import type { TransactionRow } from "../tables";
import { txnApplyRules } from "../runs/txn-apply-rules";
import {
  normalizeVendor,
  txnNormalizeVendors,
  VENDOR_NORMALIZATION_VERSION,
} from "../runs/txn-normalize-vendors";
import { CLIENT_A1, FIRM_A, lock, scopeFor, txn } from "./fixtures";
import {
  applyCoding,
  codingDb,
  previewCoding,
  rule,
  skipDetails,
  skippedFor,
  standardCategories,
} from "./coding-fixtures";
import { assert, assertEqual, show, test } from "./harness";

test("normalize vendors, happy path runs the seven steps in order", async () => {
  const db = codingDb();
  db.seed("transactions", [
    txn("TX-1", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-05", BigInt(-1875), {
      description: "tst* joe's pizza #0042",
      normalizedVendor: null,
    }),
    txn("TX-2", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-06", BigInt(-4200), {
      description: "ignored because the feed sent a merchant name",
      bankMerchantName: "SQ *BLUE  BOTTLE   COFFEE  STORE 17",
      normalizedVendor: null,
    }),
  ]);

  const { applied } = await applyCoding(db, txnNormalizeVendors, scopeFor(CLIENT_A1));
  assertEqual(applied.status, "completed", `status ${show(applied.status)}`);
  assertEqual(applied.result.proposals.length, 2, "one write per row");
  assert(
    applied.result.proposals.every(isFieldWrite),
    "the run writes fields and never posts",
  );

  const rows = db.all("transactions") as TransactionRow[];
  const one = rows.find((r) => r.id === "TX-1");
  const two = rows.find((r) => r.id === "TX-2");
  assertEqual(one?.normalizedVendor, "JOE S PIZZA", "prefix and terminal stripped");
  assertEqual(two?.normalizedVendor, "BLUE BOTTLE COFFEE", "merchant name preferred");
  for (const row of [one, two]) {
    assertEqual(
      row?.vendorNormalizationVersion,
      VENDOR_NORMALIZATION_VERSION,
      "the version stamp says which normalizer produced the value",
    );
    assertEqual(row?.normalizationDegraded, false, "neither row degraded");
  }
  assertEqual(db.all("journal_entries").length, 0, "no ledger effect");
});

test("normalize vendors, the normalizer is pure and covers every step", () => {
  assertEqual(normalizeVendor("PAYPAL *GITHUB.COM").value, "GITHUB COM", "step 4");
  assertEqual(normalizeVendor("SQ TST DINER 9").value, "TST DINER", "one prefix only");
  assertEqual(normalizeVendor("SQUARE THINGS").value, "SQUARE THINGS", "space needed");
  assertEqual(normalizeVendor("ACME TERM 123456").value, "ACME", "step 5 with TERM");
  assertEqual(normalizeVendor("ACME 1234567").value, "ACME 1234567", "seven digits stay");
  const degraded = normalizeVendor("#0042");
  assertEqual(degraded.value, "0042", "step 7 keeps the step 3 text");
  assertEqual(degraded.degraded, true, "and flags the row rather than emptying it");
  assertEqual(
    normalizeVendor("tst* joe's pizza #0042").value,
    normalizeVendor("TST* JOE'S PIZZA #0042").value,
    "same input in any case, same output",
  );
});

test("normalize vendors, skip path records why the row was left alone", async () => {
  const db = codingDb();
  db.seed("transactions", [
    txn("TX-DONE", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-05", BigInt(-1000), {
      normalizedVendor: "ALREADY DONE",
      vendorNormalizationVersion: VENDOR_NORMALIZATION_VERSION,
    }),
    txn("TX-LOCKED", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-06", BigInt(-1000), {
      normalizedVendor: null,
    }),
    txn("TX-OVR", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-07", BigInt(-1000), {
      normalizedVendor: "HANDS OFF",
      manualOverride: true,
    }),
  ]);
  db.seed("period_locks", [
    lock("LK-JAN6", FIRM_A, CLIENT_A1, "2026-01-06", "2026-01-06"),
  ]);

  const preview = await previewCoding(db, txnNormalizeVendors, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "nothing left to normalize");
  assert(
    skippedFor(preview, "TX-DONE", "already_applied"),
    `expected already_applied, got ${show(skipDetails(preview, "TX-DONE"))}`,
  );
  assert(
    skipDetails(preview, "TX-DONE")[0].includes("already_normalized_current_version"),
    "and the detail names the version that was already stamped",
  );
  assert(
    skippedFor(preview, "TX-LOCKED", "locked_period"),
    `expected locked_period, got ${show(skipDetails(preview, "TX-LOCKED"))}`,
  );
  assert(
    skippedFor(preview, "TX-OVR", "manual_override"),
    `expected manual_override, got ${show(skipDetails(preview, "TX-OVR"))}`,
  );
  assertEqual(preview.overriddenInScope, 1, "the override is counted, not written");
});

test("normalize vendors, ordering, a rule cannot fire before the vendor key exists", async () => {
  const seed = (): ReturnType<typeof codingDb> => {
    const db = codingDb();
    db.seed("categories", standardCategories());
    db.seed("rules", [rule("RULE-GITHUB")]);
    db.seed("transactions", [
      txn("TX-GH", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
        description: "PAYPAL *GITHUB",
        normalizedVendor: null,
      }),
    ]);
    return db;
  };

  // Rules first, which is the wrong order. The vendor key is not there yet.
  const outOfOrder = seed();
  const early = await previewCoding(outOfOrder, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(early.result.proposals.length, 0, "the rule cannot fire yet");
  assert(
    skippedFor(early, "TX-GH", "missing_prerequisite"),
    `expected missing_prerequisite, got ${show(skipDetails(early, "TX-GH"))}`,
  );

  // Documented order. Normalize, then rules, and now the rule matches.
  const inOrder = seed();
  await applyCoding(inOrder, txnNormalizeVendors, scopeFor(CLIENT_A1));
  const normalized = (inOrder.all("transactions") as TransactionRow[])[0];
  assertEqual(normalized.normalizedVendor, "GITHUB", "the key is written first");
  const late = await previewCoding(inOrder, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(late.result.proposals.length, 1, "and only now does the rule fire");
});
