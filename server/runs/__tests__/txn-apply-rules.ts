/**
 * TXN-APPLY-RULES tests. Cascade step 6.
 *
 * Four things are covered:
 *   1. Happy path. A rule matches on the six allowed condition types, the tie
 *      break of doc 00 Part 3 picks a winner, and the register row records the
 *      rule id, the rule version, and the conditions that matched.
 *   2. Skip path. A disabled rule, an unmatched row, and a pending duplicate are
 *      each reported with the reason recorded.
 *   3. Ordering against TXN-PAIR-TRANSFERS. A paired transfer must never be
 *      recoded by a rule, and this is the test that would fail loudly if it were.
 *   4. Auto post. All five conditions of doc 02 Part D or no flag.
 */

import { isFieldWrite, isSuspenseRouting } from "../contract";
import type { TransactionRow } from "../tables";
import {
  autoPostAllowed,
  conditionMatches,
  ruleMatches,
  SUS_RULE_CONFLICT,
  tieBreakOrder,
  tokenPrefixMatches,
  txnApplyRules,
} from "../runs/txn-apply-rules";
import { txnPairTransfers } from "../runs/txn-pair-transfers";
import { CLIENT_A1, FIRM_A, lock, scopeFor, txn } from "./fixtures";
import {
  applyCoding,
  category,
  clientPolicy,
  codingDb,
  documentLink,
  previewCoding,
  rule,
  skipDetails,
  skippedFor,
  standardCategories,
} from "./coding-fixtures";
import { assert, assertEqual, show, test } from "./harness";

function seedCharge(db: ReturnType<typeof codingDb>): void {
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("transactions", [
    txn("TX-GH", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
      normalizedVendor: "GITHUB",
      vendorId: "VEN-GH",
      bankCode: "5734",
      institutionId: "INST-1",
    }),
  ]);
}

test("apply rules, happy path applies the winner and records the provenance", async () => {
  const db = codingDb();
  seedCharge(db);
  db.seed("rules", [
    rule("RULE-BROAD", {
      priority: 100,
      conditions: [{ type: "vendor_prefix", value: "GITHUB" }],
      targetCategoryId: "CAT-meals",
    }),
    rule("RULE-TIGHT", {
      priority: 100,
      conditions: [
        { type: "vendor_equals", value: "GITHUB" },
        { type: "sign", value: "debit" },
        { type: "amount_range", minCents: BigInt(1), maxCents: BigInt(500000) },
      ],
      targetCategoryId: "CAT-software",
    }),
  ]);

  const { applied } = await applyCoding(db, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(applied.status, "completed", `status ${show(applied.status)}`);
  assertEqual(applied.result.proposals.filter(isFieldWrite).length, 1, "one write");

  const row = (db.all("transactions") as TransactionRow[])[0];
  assertEqual(
    row.categoryId,
    "CAT-software",
    "the more specific rule wins on condition count",
  );
  assertEqual(row.ruleId, "RULE-TIGHT", "the rule id is recorded on the row");
  assertEqual(row.ruleVersion, 1, "with the version of the rule that decided");
  assertEqual(row.categoryVersion, 1, "and the version of the category it chose");
  assertEqual(row.cascadeLevel, 6, "at cascade level 6");
  assert(row.matchedConditions !== null, "the conditions that matched are kept");
  assertEqual(
    row.autoPostedUnderRulePromotion,
    false,
    "and nothing auto posted, because the rule was never promoted",
  );
  assertEqual(db.all("journal_entries").length, 0, "the rule step writes no entry");
});

test("apply rules, the six condition types are exact and conjunctive", () => {
  const t = txn("TX-1", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
    normalizedVendor: "JOE S PIZZA",
    bankCode: "5812",
  });
  assert(conditionMatches(t, { type: "vendor_equals", value: "JOE S PIZZA" }), "equals");
  assert(!conditionMatches(t, { type: "vendor_equals", value: "JOE" }), "not a prefix");
  assert(conditionMatches(t, { type: "vendor_prefix", value: "JOE" }), "prefix");
  assert(!conditionMatches(t, { type: "vendor_prefix", value: "JO" }), "token boundary");
  assert(tokenPrefixMatches("JOE S PIZZA", "JOE"), "JOE matches JOE S PIZZA");
  assert(!tokenPrefixMatches("JOEL", "JOE"), "and JOE does not match JOEL");
  assert(
    conditionMatches(t, { type: "amount_range", minCents: BigInt(2500), maxCents: BigInt(2500) }),
    "the range is inclusive and reads the absolute amount",
  );
  assert(conditionMatches(t, { type: "sign", value: "debit" }), "money out is a debit");
  assert(!conditionMatches(t, { type: "sign", value: "credit" }), "and not a credit");
  assert(conditionMatches(t, { type: "bank_account", value: "BA-A1-OP" }), "account");
  assert(conditionMatches(t, { type: "bank_code", value: "5812" }), "bank code");

  const twoConditions = rule("RULE-2", {
    conditions: [
      { type: "vendor_equals", value: "JOE S PIZZA" },
      { type: "sign", value: "credit" },
    ],
  });
  assert(!ruleMatches(t, twoConditions), "one condition failing fails the rule");
});

test("apply rules, the tie break is priority, then condition count, then id", () => {
  const a = rule("RULE-A", { priority: 100, conditions: [{ type: "sign", value: "debit" }] });
  const b = rule("RULE-B", { priority: 200, conditions: [{ type: "sign", value: "debit" }] });
  const c = rule("RULE-C", {
    priority: 100,
    conditions: [
      { type: "sign", value: "debit" },
      { type: "vendor_equals", value: "GITHUB" },
    ],
  });
  const ordered = [a, b, c].sort(tieBreakOrder).map((r) => r.id);
  assertEqual(
    ordered.join(","),
    "RULE-B,RULE-C,RULE-A",
    "higher priority first, then more conditions, then the lower id",
  );
  const sameShape = [rule("RULE-Z"), rule("RULE-Y")].sort(tieBreakOrder);
  assertEqual(sameShape[0].id, "RULE-Y", "identical shape falls back to id ascending");
});

test("apply rules, a conflict on different categories applies nothing and routes SUS-19", async () => {
  const db = codingDb();
  seedCharge(db);
  db.seed("rules", [
    rule("RULE-ONE", { targetCategoryId: "CAT-software" }),
    rule("RULE-TWO", { targetCategoryId: "CAT-meals" }),
  ]);

  const preview = await previewCoding(db, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.filter(isFieldWrite).length, 0, "no coding");
  const routings = preview.result.proposals.filter(isSuspenseRouting);
  assertEqual(routings.length, 1, "one routing");
  assertEqual(routings[0].reasonCode, SUS_RULE_CONFLICT, "SUS-19 rather than a guess");
  assertEqual(
    (routings[0].relatedIds ?? []).slice().sort().join(","),
    "RULE-ONE,RULE-TWO",
    "and every surviving rule id is surfaced so a person can fix the rules",
  );
});

test("apply rules, a tie on the same category is applied and is not a conflict", async () => {
  const db = codingDb();
  seedCharge(db);
  db.seed("rules", [
    rule("RULE-ONE", { targetCategoryId: "CAT-software" }),
    rule("RULE-TWO", { targetCategoryId: "CAT-software" }),
  ]);
  const { applied } = await applyCoding(db, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(applied.result.proposals.filter(isSuspenseRouting).length, 0, "no routing");
  const row = (db.all("transactions") as TransactionRow[])[0];
  assertEqual(row.categoryId, "CAT-software", "there was nothing to decide");
  assertEqual(row.ruleId, "RULE-ONE", "the lower id is the recorded winner");
});

test("apply rules, skip path records the disabled rule, the miss, and the duplicate", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("rules", [rule("RULE-OFF", { isActive: false })]);
  db.seed("transactions", [
    txn("TX-MISS", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
      normalizedVendor: "GITHUB",
    }),
    txn("TX-DUP", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-2500), {
      normalizedVendor: "GITHUB",
      duplicateFlag: true,
      duplicateOfTransactionId: "TX-MISS",
    }),
    txn("TX-LOCKED", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-20", BigInt(-2500), {
      normalizedVendor: "GITHUB",
    }),
  ]);
  db.seed("period_locks", [
    lock("LK-JAN20", FIRM_A, CLIENT_A1, "2026-01-20", "2026-01-20"),
  ]);

  const preview = await previewCoding(db, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "a disabled rule decides nothing");
  assertEqual(
    skipDetails(preview, "TX-MISS")[0],
    "missing_prerequisite:no_rule_matched",
    "the unmatched row passes down the cascade",
  );
  assertEqual(
    skipDetails(preview, "TX-DUP")[0],
    "already_applied:already_resolved_level_2",
    "a flagged duplicate is left to the duplicate review, not coded",
  );
  assert(
    skippedFor(preview, "TX-LOCKED", "locked_period"),
    `expected locked_period, got ${show(skipDetails(preview, "TX-LOCKED"))}`,
  );
});

test("apply rules, ordering, a paired transfer is never recoded by a rule", async () => {
  const seed = (): ReturnType<typeof codingDb> => {
    const db = codingDb();
    db.seed("categories", standardCategories());
    db.seed("client_policies", [clientPolicy()]);
    // A rule a person could easily write, and one that is wrong on a transfer.
    db.seed("rules", [
      rule("RULE-XFER", {
        conditions: [{ type: "vendor_equals", value: "INTERNAL TRANSFER" }],
        targetCategoryId: "CAT-software",
      }),
    ]);
    db.seed("transactions", [
      txn("TX-OUT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000)),
      txn("TX-IN", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-11", BigInt(25000)),
    ]);
    return db;
  };

  // Rules first, which is the wrong order. One leg of the transfer becomes an
  // expense and 1920 would never come back to zero.
  const outOfOrder = seed();
  const early = await previewCoding(outOfOrder, txnApplyRules, scopeFor(CLIENT_A1));
  const strayWrites = early.result.proposals.filter(isFieldWrite);
  assertEqual(strayWrites.length, 1, "the outbound leg gets coded");
  assertEqual(
    strayWrites[0].rowId,
    "TX-OUT",
    "one leg of the transfer becomes software expense, which is the defect being guarded",
  );
  assertEqual(
    strayWrites[0].after.categoryId,
    "CAT-software",
    "and 1920 would then never come back to zero",
  );

  // Documented order. Pairing first, then rules.
  const inOrder = seed();
  await applyCoding(inOrder, txnPairTransfers, scopeFor(CLIENT_A1));
  const paired = inOrder.all("transactions") as TransactionRow[];
  assert(
    paired.every((t) => t.pairedWithId !== null),
    "both legs are paired",
  );
  const late = await previewCoding(inOrder, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(late.result.proposals.length, 0, "the rule step proposes nothing at all");
  for (const id of ["TX-OUT", "TX-IN"]) {
    assertEqual(
      skipDetails(late, id)[0],
      "already_applied:already_resolved_level_3",
      `${id} records that level 3 already decided it`,
    );
  }
  const after = inOrder.all("transactions") as TransactionRow[];
  assert(
    after.every((t) => t.ruleId === null),
    "no rule id was written over the transfer provenance",
  );
  const clearing = inOrder.all("journal_lines").filter((l) => l.accountNumber === "1920");
  assertEqual(
    clearing.reduce((sum, l) => sum + l.amountCents, BigInt(0)),
    BigInt(0),
    "so the transfer clearing account still nets to zero",
  );
});

test("apply rules, auto post needs all five conditions of doc 02 Part D", () => {
  const promoted = rule("RULE-P", {
    autoPostEnabled: true,
    autoPostEnabledBy: "USR-PARTNER",
    acceptedCount: 25,
    rejectedCount: 0,
  });
  const cat = category("CAT-software", "6100");
  const base = {
    rule: promoted,
    category: cat,
    amountCents: BigInt(-2500),
    cleanupEngagement: false,
  };
  assert(autoPostAllowed(base), "all five conditions hold");
  assert(
    !autoPostAllowed({ ...base, rule: rule("RULE-P", { ...promoted, autoPostEnabled: false }) }),
    "condition 1, the switch has to be on",
  );
  assert(
    !autoPostAllowed({ ...base, rule: rule("RULE-P", { ...promoted, autoPostEnabledBy: null }) }),
    "condition 1, and a named person has to have turned it on",
  );
  assert(
    !autoPostAllowed({ ...base, rule: rule("RULE-P", { ...promoted, acceptedCount: 24 }) }),
    "condition 2, twenty five accepted at the current version",
  );
  assert(
    !autoPostAllowed({ ...base, rule: rule("RULE-P", { ...promoted, rejectedCount: 1 }) }),
    "condition 2, and no rejections at all",
  );
  assert(
    !autoPostAllowed({
      ...base,
      category: category("CAT-draw", "3100", { taxTreatment: "owner_draw" }),
    }),
    "condition 3, an owner draw never auto posts",
  );
  assert(
    !autoPostAllowed({ ...base, amountCents: BigInt(-250001) }),
    "condition 4, over the ceiling",
  );
  assert(
    !autoPostAllowed({ ...base, cleanupEngagement: true }),
    "condition 5, a cleanup engagement never auto posts",
  );
});

test("apply rules, a promoted rule stamps the auto post flag on the register row", async () => {
  const db = codingDb();
  seedCharge(db);
  db.seed("rules", [
    rule("RULE-P", {
      autoPostEnabled: true,
      autoPostEnabledBy: "USR-PARTNER",
      acceptedCount: 40,
      rejectedCount: 0,
    }),
  ]);
  await applyCoding(db, txnApplyRules, scopeFor(CLIENT_A1));
  const row = (db.all("transactions") as TransactionRow[])[0];
  assertEqual(
    row.autoPostedUnderRulePromotion,
    true,
    "so a review can tell what a person accepted from what a rule posted",
  );
});

test("apply rules, a missing receipt raises an exception and still codes the row", async () => {
  const db = codingDb();
  db.seed("categories", [
    category("CAT-software", "6100", { requiresReceiptOverCents: BigInt(1000) }),
    category("CAT-meals", "6200", { requiresClass: true }),
  ]);
  db.seed("client_policies", [clientPolicy()]);
  db.seed("rules", [rule("RULE-GITHUB")]);
  db.seed("transactions", [
    txn("TX-GH", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
      normalizedVendor: "GITHUB",
    }),
  ]);

  const { applied } = await applyCoding(db, txnApplyRules, scopeFor(CLIENT_A1));
  const row = (db.all("transactions") as TransactionRow[])[0];
  assertEqual(row.categoryId, "CAT-software", "the coding is right, so it is written");
  assertEqual(
    db.all("documentation_exceptions").length,
    1,
    "and the missing receipt is a documentation exception",
  );
  assertEqual(
    applied.result.proposals.filter(isSuspenseRouting).length,
    1,
    "with a SUS-06 alongside it so somebody chases the receipt",
  );

  const withReceipt = codingDb();
  withReceipt.seed("categories", [
    category("CAT-software", "6100", { requiresReceiptOverCents: BigInt(1000) }),
  ]);
  withReceipt.seed("client_policies", [clientPolicy()]);
  withReceipt.seed("rules", [rule("RULE-GITHUB")]);
  withReceipt.seed("transactions", [
    txn("TX-GH", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
      normalizedVendor: "GITHUB",
    }),
  ]);
  withReceipt.seed("document_links", [documentLink("DL-1", "TX-GH")]);
  const clean = await previewCoding(withReceipt, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(
    clean.result.proposals.filter(isSuspenseRouting).length,
    0,
    "a linked receipt raises nothing",
  );
});

test("apply rules, a sign that disagrees with the category blocks the coding", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("rules", [rule("RULE-GITHUB")]);
  db.seed("transactions", [
    // Money in, coded to an expense category. That is a question, not a coding.
    txn("TX-REFUND", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(2500), {
      normalizedVendor: "GITHUB",
    }),
  ]);
  const preview = await previewCoding(db, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.filter(isFieldWrite).length, 0, "nothing coded");
  const routings = preview.result.proposals.filter(isSuspenseRouting);
  assertEqual(routings.length, 1, "one routing");
  assertEqual(routings[0].reasonCode, "SUS-10", "a tax relevant category makes it SUS-10");
});

test("apply rules, a foreign currency row is left for the sweep", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("rules", [rule("RULE-GITHUB")]);
  db.seed("transactions", [
    txn("TX-EUR", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
      normalizedVendor: "GITHUB",
      currency: "EUR",
    }),
  ]);
  const preview = await previewCoding(db, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "a matching rule is not applied");
  assert(
    skippedFor(preview, "TX-EUR", "out_of_scope_engagement"),
    `expected the currency skip, got ${show(skipDetails(preview, "TX-EUR"))}`,
  );
  assert(
    skipDetails(preview, "TX-EUR")[0].includes("SUS-11"),
    "and the detail names the only outcome the register constraint allows",
  );
});
