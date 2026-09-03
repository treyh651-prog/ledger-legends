/**
 * TXN-MAP-BANKCODES tests. Cascade step 8, the last chance before suspense.
 *
 * Three things are covered:
 *   1. Happy path. An institution specific mapping codes the row at level 8, and
 *      a wildcard mapping is used only when no institution specific row exists.
 *   2. Skip path. No bank code on the row, and a code nobody has mapped, are
 *      each reported with the reason recorded.
 *   3. Ordering. This run comes after TXN-APPLY-VENDORDEFAULTS. The bank's own
 *      coarse code is the weakest evidence in the cascade, so a vendor default
 *      that already decided the row stands.
 */

import { isFieldWrite, isSuspenseRouting } from "../contract";
import type { TransactionRow } from "../tables";
import {
  BANKCODES_AUTO_POST_ELIGIBLE,
  INSTITUTION_WILDCARD,
  institutionOf,
  mappingsFor,
  txnMapBankCodes,
} from "../runs/txn-map-bankcodes";
import { txnApplyVendorDefaults } from "../runs/txn-apply-vendordefaults";
import { CLIENT_A1, FIRM_A, scopeFor, txn } from "./fixtures";
import {
  applyCoding,
  bankCodeMapping,
  category,
  clientPolicy,
  codingDb,
  previewCoding,
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
    txn("TX-ANON", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
      normalizedVendor: "UNKNOWN MERCHANT",
      bankCode: "5734",
      institutionId: "INST-1",
    }),
  ]);
}

test("map bank codes, happy path codes at level 8 from the institution mapping", async () => {
  const db = codingDb();
  seedCharge(db);
  db.seed("bank_code_mappings", [bankCodeMapping("BCM-1", "5734")]);

  const { applied } = await applyCoding(db, txnMapBankCodes, scopeFor(CLIENT_A1));
  assertEqual(applied.status, "completed", `status ${show(applied.status)}`);
  assertEqual(applied.result.proposals.filter(isFieldWrite).length, 1, "one write");

  const row = (db.all("transactions") as TransactionRow[])[0];
  assertEqual(row.categoryId, "CAT-software", "the mapping decided the row");
  assertEqual(row.cascadeLevel, 8, "at cascade level 8");
  assertEqual(row.ruleId, null, "no rule, because no rule matched");
  assertEqual(
    row.autoPostedUnderRulePromotion,
    false,
    "and a bank code never auto posts",
  );
  assertEqual(BANKCODES_AUTO_POST_ELIGIBLE, false, "which the run states plainly");
  assertEqual(db.all("journal_entries").length, 0, "no entry was posted");
});

test("map bank codes, the wildcard is a fallback and never shadows a real mapping", () => {
  const specific = bankCodeMapping("BCM-SPEC", "5734");
  const wildcard = bankCodeMapping("BCM-ANY", "5734", {
    institutionId: INSTITUTION_WILDCARD,
    categoryId: "CAT-meals",
  });
  const both = mappingsFor([specific, wildcard], "INST-1", "5734");
  assertEqual(both.length, 1, "one survivor");
  assertEqual(both[0].id, "BCM-SPEC", "the institution specific row wins outright");

  const onlyWildcard = mappingsFor([wildcard], "INST-1", "5734");
  assertEqual(onlyWildcard.length, 1, "the firm library is used when nothing else is");
  assertEqual(onlyWildcard[0].id, "BCM-ANY", "and it is the wildcard row");

  const noInstitution = mappingsFor([specific, wildcard], null, "5734");
  assertEqual(noInstitution.length, 1, "a row with no institution still has a fallback");
  assertEqual(noInstitution[0].id, "BCM-ANY", "which can only be the wildcard");

  const inactive = mappingsFor(
    [bankCodeMapping("BCM-OFF", "5734", { isActive: false })],
    "INST-1",
    "5734",
  );
  assertEqual(inactive.length, 0, "an inactive mapping is not a mapping");

  const row = txn("TX-1", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-1), {
    institutionId: "INST-9",
  });
  assertEqual(institutionOf(row), "INST-9", "the institution is read off the register row");
});

test("map bank codes, skip path records a missing code and an unmapped code", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("bank_code_mappings", [bankCodeMapping("BCM-1", "5734")]);
  db.seed("transactions", [
    txn("TX-NOCODE", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
      normalizedVendor: "UNKNOWN MERCHANT",
      institutionId: "INST-1",
    }),
    txn("TX-UNMAPPED", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-2500), {
      normalizedVendor: "UNKNOWN MERCHANT",
      bankCode: "9999",
      institutionId: "INST-1",
    }),
    txn("TX-OTHERBANK", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-11", BigInt(-2500), {
      normalizedVendor: "UNKNOWN MERCHANT",
      bankCode: "5734",
      institutionId: "INST-2",
    }),
  ]);

  const preview = await previewCoding(db, txnMapBankCodes, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "nothing to apply");
  assertEqual(
    skipDetails(preview, "TX-NOCODE")[0],
    "missing_prerequisite:no_bank_code",
    "a feed that sent no code gives this run nothing to work with",
  );
  assertEqual(
    skipDetails(preview, "TX-UNMAPPED")[0],
    "missing_prerequisite:no_code_mapping",
    "and a code nobody mapped is not guessed at",
  );
  assert(
    skippedFor(preview, "TX-OTHERBANK", "missing_prerequisite"),
    `a mapping for another institution does not apply, got ${show(skipDetails(preview, "TX-OTHERBANK"))}`,
  );
});

test("map bank codes, an inactive target category routes SUS-03", async () => {
  const db = codingDb();
  db.seed("categories", [category("CAT-software", "6100", { isActive: false })]);
  db.seed("client_policies", [clientPolicy()]);
  db.seed("bank_code_mappings", [bankCodeMapping("BCM-1", "5734")]);
  db.seed("transactions", [
    txn("TX-ANON", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
      normalizedVendor: "UNKNOWN MERCHANT",
      bankCode: "5734",
      institutionId: "INST-1",
    }),
  ]);
  const preview = await previewCoding(db, txnMapBankCodes, scopeFor(CLIENT_A1));
  const routings = preview.result.proposals.filter(isSuspenseRouting);
  assertEqual(routings.length, 1, "one routing");
  assertEqual(routings[0].reasonCode, "SUS-03", "a retired category is not a destination");
});

test("map bank codes, ordering, a vendor default outranks the bank's own code", async () => {
  const seed = (): ReturnType<typeof codingDb> => {
    const db = codingDb();
    db.seed("categories", standardCategories());
    db.seed("client_policies", [clientPolicy()]);
    db.seed("vendors", [vendor("VEN-GH", "GITHUB", { defaultCategoryId: "CAT-software" })]);
    db.seed("bank_code_mappings", [
      bankCodeMapping("BCM-1", "5734", { categoryId: "CAT-meals" }),
    ]);
    db.seed("transactions", [
      txn("TX-GH", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
        normalizedVendor: "GITHUB",
        bankCode: "5734",
        institutionId: "INST-1",
      }),
    ]);
    return db;
  };

  // Bank codes first, which is the wrong order. The bank's coarse guess wins over
  // the standing instruction the firm actually wrote.
  const outOfOrder = seed();
  await applyCoding(outOfOrder, txnMapBankCodes, scopeFor(CLIENT_A1));
  const wrong = (outOfOrder.all("transactions") as TransactionRow[])[0];
  assertEqual(
    wrong.categoryId,
    "CAT-meals",
    "the bank code decided, which is the defect being guarded",
  );
  assertEqual(wrong.vendorId, null, "and no vendor provenance was recorded at all");

  // Documented order. Vendor defaults first, then bank codes stand down.
  const inOrder = seed();
  await applyCoding(inOrder, txnApplyVendorDefaults, scopeFor(CLIENT_A1));
  const late = await previewCoding(inOrder, txnMapBankCodes, scopeFor(CLIENT_A1));
  assertEqual(late.result.proposals.length, 0, "the bank code step proposes nothing");
  assertEqual(
    skipDetails(late, "TX-GH")[0],
    "already_applied:already_resolved_level_7",
    "and it records that level 7 already decided the row",
  );
  const right = (inOrder.all("transactions") as TransactionRow[])[0];
  assertEqual(right.categoryId, "CAT-software", "the vendor default survives");
  assertEqual(right.vendorId, "VEN-GH", "with its provenance intact");
});
