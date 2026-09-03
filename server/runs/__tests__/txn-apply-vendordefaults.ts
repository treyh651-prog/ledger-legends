/**
 * TXN-APPLY-VENDORDEFAULTS tests. Cascade step 7.
 *
 * Three things are covered:
 *   1. Happy path. Exactly one active vendor default on the normalized key codes
 *      the row at level 7 and records which vendor decided it.
 *   2. Skip path. No default on the key, and an inactive vendor, are each
 *      reported with the reason recorded.
 *   3. Ordering. This run comes after TXN-APPLY-RULES. A rule is a standing
 *      instruction a person wrote for this client and it outranks the vendor
 *      master, so a row a rule already coded is left exactly as the rule left it.
 */

import { isFieldWrite, isSuspenseRouting } from "../contract";
import type { TransactionRow } from "../tables";
import { txnApplyRules } from "../runs/txn-apply-rules";
import {
  SUS_VENDOR_CONFLICT,
  txnApplyVendorDefaults,
  VENDORDEFAULTS_AUTO_POST_ELIGIBLE,
} from "../runs/txn-apply-vendordefaults";
import { CLIENT_A1, FIRM_A, scopeFor, txn } from "./fixtures";
import {
  applyCoding,
  category,
  clientPolicy,
  codingDb,
  previewCoding,
  rule,
  skipDetails,
  skippedFor,
  standardCategories,
  vendor,
} from "./coding-fixtures";
import { assert, assertEqual, show, test } from "./harness";

function seedCharge(db: ReturnType<typeof codingDb>): void {
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("transactions", [
    txn("TX-GH", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
      normalizedVendor: "GITHUB",
    }),
  ]);
}

test("apply vendor defaults, happy path codes at level 7 and names the vendor", async () => {
  const db = codingDb();
  seedCharge(db);
  db.seed("vendors", [vendor("VEN-GH", "GITHUB")]);

  const { applied } = await applyCoding(
    db,
    txnApplyVendorDefaults,
    scopeFor(CLIENT_A1),
  );
  assertEqual(applied.status, "completed", `status ${show(applied.status)}`);
  assertEqual(applied.result.proposals.filter(isFieldWrite).length, 1, "one write");

  const row = (db.all("transactions") as TransactionRow[])[0];
  assertEqual(row.categoryId, "CAT-software", "the vendor default is applied");
  assertEqual(row.cascadeLevel, 7, "at cascade level 7");
  assertEqual(row.vendorId, "VEN-GH", "and the vendor that decided is recorded");
  assertEqual(row.ruleId, null, "no rule was involved");
  assertEqual(
    row.autoPostedUnderRulePromotion,
    false,
    "a vendor default never auto posts",
  );
  assertEqual(
    VENDORDEFAULTS_AUTO_POST_ELIGIBLE,
    false,
    "and the run says so in one place rather than by accident",
  );
  assertEqual(db.all("journal_entries").length, 0, "no entry was posted");
});

test("apply vendor defaults, the key match is exact equality and nothing looser", async () => {
  const db = codingDb();
  seedCharge(db);
  // Close enough for a person, not close enough for a standing instruction.
  db.seed("vendors", [vendor("VEN-GH", "GITHUB INC")]);
  const preview = await previewCoding(db, txnApplyVendorDefaults, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "GITHUB is not GITHUB INC");
  assertEqual(
    skipDetails(preview, "TX-GH")[0],
    "missing_prerequisite:no_vendor_default",
    "and the row passes down to the bank code step",
  );
});

test("apply vendor defaults, two active defaults on one key route SUS-19", async () => {
  const db = codingDb();
  seedCharge(db);
  db.seed("vendors", [
    vendor("VEN-A", "GITHUB"),
    vendor("VEN-B", "GITHUB", { defaultCategoryId: "CAT-meals" }),
  ]);

  const preview = await previewCoding(db, txnApplyVendorDefaults, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.filter(isFieldWrite).length, 0, "no coding");
  const routings = preview.result.proposals.filter(isSuspenseRouting);
  assertEqual(routings.length, 1, "one routing");
  assertEqual(routings[0].reasonCode, SUS_VENDOR_CONFLICT, "SUS-19, not a coin flip");
  assertEqual(
    (routings[0].relatedIds ?? []).slice().sort().join(","),
    "VEN-A,VEN-B",
    "and both vendor ids are named because the master data is the real problem",
  );
});

test("apply vendor defaults, skip path records an inactive vendor and a vendor with no default", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("vendors", [
    vendor("VEN-OFF", "GITHUB", { isActive: false }),
    vendor("VEN-NONE", "STRIPE", { defaultCategoryId: null, defaultCategoryVersion: null }),
  ]);
  db.seed("transactions", [
    txn("TX-GH", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
      normalizedVendor: "GITHUB",
    }),
    txn("TX-ST", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-2500), {
      normalizedVendor: "STRIPE",
    }),
    txn("TX-CODED", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-11", BigInt(-2500), {
      normalizedVendor: "GITHUB",
      categoryId: "CAT-meals",
      categoryVersion: 1,
      cascadeLevel: 6,
      ruleId: "RULE-EARLIER",
      ruleVersion: 1,
    }),
  ]);

  const preview = await previewCoding(db, txnApplyVendorDefaults, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "nothing to apply");
  assertEqual(
    skipDetails(preview, "TX-GH")[0],
    "missing_prerequisite:no_vendor_default",
    "an inactive vendor is not a default",
  );
  assertEqual(
    skipDetails(preview, "TX-ST")[0],
    "missing_prerequisite:no_vendor_default",
    "and a vendor with no default category is not one either",
  );
  assert(
    skippedFor(preview, "TX-CODED", "already_applied"),
    `expected already_applied, got ${show(skipDetails(preview, "TX-CODED"))}`,
  );
});

test("apply vendor defaults, an inactive target category routes SUS-03", async () => {
  const db = codingDb();
  db.seed("categories", [category("CAT-software", "6100", { isActive: false })]);
  db.seed("client_policies", [clientPolicy()]);
  db.seed("vendors", [vendor("VEN-GH", "GITHUB")]);
  db.seed("transactions", [
    txn("TX-GH", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
      normalizedVendor: "GITHUB",
    }),
  ]);
  const preview = await previewCoding(db, txnApplyVendorDefaults, scopeFor(CLIENT_A1));
  const routings = preview.result.proposals.filter(isSuspenseRouting);
  assertEqual(routings.length, 1, "one routing");
  assertEqual(routings[0].reasonCode, "SUS-03", "a retired category is not a destination");
});

test("apply vendor defaults, ordering, a rule outranks the vendor master", async () => {
  const seed = (): ReturnType<typeof codingDb> => {
    const db = codingDb();
    seedCharge(db);
    db.seed("vendors", [vendor("VEN-GH", "GITHUB", { defaultCategoryId: "CAT-meals" })]);
    db.seed("rules", [rule("RULE-GITHUB", { targetCategoryId: "CAT-software" })]);
    return db;
  };

  // Vendor defaults first, which is the wrong order. The weaker instruction wins.
  const outOfOrder = seed();
  await applyCoding(outOfOrder, txnApplyVendorDefaults, scopeFor(CLIENT_A1));
  const wrong = (outOfOrder.all("transactions") as TransactionRow[])[0];
  assertEqual(
    wrong.categoryId,
    "CAT-meals",
    "the vendor master decided, which is the defect being guarded",
  );
  assertEqual(
    wrong.vendorId,
    "VEN-GH",
    "and the register now says a vendor default decided a row a rule owned",
  );
  // Running the rule step afterwards does not leave things clean either. The
  // coding gets rewritten, so the register shows a changed category with no
  // explanation beyond two runs having disagreed, which is exactly the churn the
  // documented order exists to prevent.
  const ruleAfter = await previewCoding(outOfOrder, txnApplyRules, scopeFor(CLIENT_A1));
  const rewrites = ruleAfter.result.proposals.filter(isFieldWrite);
  assertEqual(rewrites.length, 1, "the rule step has to undo the vendor decision");
  assertEqual(
    rewrites[0].before.categoryId,
    "CAT-meals",
    "rewriting a coding that was already written and shown to a person",
  );

  // Documented order. Rules first, then vendor defaults stand down.
  const inOrder = seed();
  await applyCoding(inOrder, txnApplyRules, scopeFor(CLIENT_A1));
  const late = await previewCoding(inOrder, txnApplyVendorDefaults, scopeFor(CLIENT_A1));
  assertEqual(late.result.proposals.length, 0, "the vendor step proposes nothing");
  assertEqual(
    skipDetails(late, "TX-GH")[0],
    "already_applied:already_resolved_level_6",
    "and it records that level 6 already decided the row",
  );
  const right = (inOrder.all("transactions") as TransactionRow[])[0];
  assertEqual(right.categoryId, "CAT-software", "the rule decision survives");
  assertEqual(right.ruleId, "RULE-GITHUB", "with its provenance intact");
});
