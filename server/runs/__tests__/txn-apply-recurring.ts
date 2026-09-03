/**
 * TXN-APPLY-RECURRING tests. Cascade step 5.
 *
 * Three things are covered:
 *   1. Happy path. A template matches, the fixed, percent, and remainder split
 *      modes each allocate to the cent, and the entry balances.
 *   2. Skip path. An inactive template, a row with no template, and a row a
 *      template already coded are each reported with the reason recorded.
 *   3. Ordering. This run comes before TXN-APPLY-RULES, because a template that
 *      splits a charge three ways is stronger evidence than a rule that codes the
 *      whole charge to one category.
 */

import { isJournalEntry, isSuspenseRouting } from "../contract";
import type { TransactionRow } from "../tables";
import { txnApplyRules } from "../runs/txn-apply-rules";
import {
  allocateByBasisPoints,
  dayOfMonthDistance,
  SUS_TEMPLATE_AMOUNT,
  SUS_TEMPLATE_CONFLICT,
  txnApplyRecurring,
} from "../runs/txn-apply-recurring";
import { CLIENT_A1, FIRM_A, scopeFor, txn } from "./fixtures";
import {
  applyCoding,
  codingDb,
  previewCoding,
  rule,
  skipDetails,
  skippedFor,
  split,
  standardCategories,
  template,
} from "./coding-fixtures";
import { assert, assertEqual, show, test } from "./harness";

function seedCharge(
  db: ReturnType<typeof codingDb>,
  amountCents = BigInt(-10000),
): void {
  db.seed("categories", standardCategories());
  db.seed("transactions", [
    txn("TX-SUB", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-14", amountCents, {
      normalizedVendor: "GITHUB",
    }),
  ]);
}

test("apply recurring, happy path splits a charge by percent to the cent", async () => {
  const db = codingDb();
  seedCharge(db, BigInt(-10001));
  db.seed("recurring_templates", [
    template("TPL-1", {
      splitMode: "fixed_percent",
      amountMode: "variable_amount",
      matchAmountCents: null,
      amountFloorCents: BigInt(1),
      amountCeilingCents: BigInt(100000),
    }),
  ]);
  db.seed("recurring_splits", [
    split("SPL-1", "TPL-1", 1, { percentBps: 3333 }),
    split("SPL-2", "TPL-1", 2, { percentBps: 3333, categoryId: "CAT-rent", accountNumber: "6300" }),
    split("SPL-3", "TPL-1", 3, { percentBps: 3334, categoryId: "CAT-fees", accountNumber: "6110" }),
  ]);

  const { applied } = await applyCoding(db, txnApplyRecurring, scopeFor(CLIENT_A1));
  assertEqual(applied.status, "completed", `status ${show(applied.status)}`);
  const lines = db.all("journal_lines");
  assertEqual(lines.length, 4, "three split lines plus the bank line");
  let net = BigInt(0);
  for (const l of lines) net += l.amountCents;
  assertEqual(net, BigInt(0), "the entry balances to exactly zero");

  const splitTotal = lines
    .filter((l) => l.accountNumber !== "1010")
    .reduce((sum, l) => sum + l.amountCents, BigInt(0));
  assertEqual(
    splitTotal,
    BigInt(10001),
    "every cent of the charge is allocated, none rounded away",
  );

  const row = (db.all("transactions") as TransactionRow[])[0];
  assertEqual(row.templateId, "TPL-1", "the register records which template decided");
  assertEqual(row.templateVersion, 1, "and which version of it");
  assertEqual(row.cascadeLevel, 5, "at cascade level 5");
});

test("apply recurring, allocation is largest remainder with ties to the last line", () => {
  const splits = [
    split("A", "T", 1, { percentBps: 3333 }),
    split("B", "T", 2, { percentBps: 3333 }),
    split("C", "T", 3, { percentBps: 3334 }),
  ];
  const out = allocateByBasisPoints(BigInt(-10000), splits);
  assertEqual(out.length, 3, "one allocation per line");
  assertEqual(
    out.reduce((sum, a) => sum + a.amountCents, BigInt(0)),
    BigInt(-10000),
    "the allocations sum to the whole amount",
  );
  assert(
    out.every((a) => a.amountCents < BigInt(0)),
    "a debit splits into debits, the sign is put back after the arithmetic",
  );
  const one = allocateByBasisPoints(BigInt(-1), [
    split("A", "T", 1, { percentBps: 5000 }),
    split("B", "T", 2, { percentBps: 5000 }),
  ]);
  assertEqual(one[1].amountCents, BigInt(-1), "a tie puts the odd cent on the last line");
  assertEqual(one[0].amountCents, BigInt(0), "and nothing on the first");
});

test("apply recurring, the day of month distance wraps around the month boundary", () => {
  assertEqual(dayOfMonthDistance("2026-02-01", 31), 1, "the 1st is one day from the 31st");
  assertEqual(dayOfMonthDistance("2026-01-14", 15), 1, "and an ordinary gap is itself");
  assertEqual(dayOfMonthDistance("2026-01-14", 14), 0, "an exact hit is zero");
});

test("apply recurring, a fixed split that does not reconcile routes SUS-17", async () => {
  const db = codingDb();
  seedCharge(db);
  db.seed("recurring_templates", [template("TPL-1", { splitMode: "fixed_amount" })]);
  db.seed("recurring_splits", [
    split("SPL-1", "TPL-1", 1, { fixedAmountCents: BigInt(4000) }),
    split("SPL-2", "TPL-1", 2, { fixedAmountCents: BigInt(5000), categoryId: "CAT-rent", accountNumber: "6300" }),
  ]);

  const preview = await previewCoding(db, txnApplyRecurring, scopeFor(CLIENT_A1));
  const routings = preview.result.proposals.filter(isSuspenseRouting);
  assertEqual(routings.length, 1, "one routing");
  assertEqual(routings[0].reasonCode, SUS_TEMPLATE_AMOUNT, "the split does not add up");
  assertEqual(
    preview.result.proposals.filter(isJournalEntry).length,
    0,
    "and nothing was posted on a plug",
  );
});

test("apply recurring, a remainder line absorbs the difference exactly", async () => {
  const db = codingDb();
  seedCharge(db);
  db.seed("recurring_templates", [template("TPL-1", { splitMode: "fixed_amount" })]);
  db.seed("recurring_splits", [
    split("SPL-1", "TPL-1", 1, { fixedAmountCents: BigInt(4000) }),
    split("SPL-2", "TPL-1", 2, {
      isRemainder: true,
      categoryId: "CAT-rent",
      accountNumber: "6300",
    }),
  ]);

  await applyCoding(db, txnApplyRecurring, scopeFor(CLIENT_A1));
  const lines = db.all("journal_lines");
  const remainder = lines.find((l) => l.accountNumber === "6300");
  assertEqual(remainder?.amountCents, BigInt(6000), "the remainder line takes the rest");
  let net = BigInt(0);
  for (const l of lines) net += l.amountCents;
  assertEqual(net, BigInt(0), "and the entry still balances");
});

test("apply recurring, two matching templates post nothing and route SUS-19", async () => {
  const db = codingDb();
  seedCharge(db);
  db.seed("recurring_templates", [template("TPL-1"), template("TPL-2")]);
  db.seed("recurring_splits", [
    split("SPL-1", "TPL-1", 1),
    split("SPL-2", "TPL-2", 1),
  ]);

  const preview = await previewCoding(db, txnApplyRecurring, scopeFor(CLIENT_A1));
  const routings = preview.result.proposals.filter(isSuspenseRouting);
  assertEqual(routings.length, 1, "one routing rather than a guess");
  assertEqual(routings[0].reasonCode, SUS_TEMPLATE_CONFLICT, "the conflict is surfaced");
  assert(
    (routings[0].relatedIds ?? []).length === 2,
    "and both template ids are named so a person can fix the real problem",
  );
});

test("apply recurring, skip path records the inactive template and the unmatched row", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("recurring_templates", [template("TPL-OFF", { isActive: false })]);
  db.seed("recurring_splits", [split("SPL-1", "TPL-OFF", 1)]);
  db.seed("transactions", [
    txn("TX-SUB", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-14", BigInt(-10000), {
      normalizedVendor: "GITHUB",
    }),
    txn("TX-DONE", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-15", BigInt(-10000), {
      normalizedVendor: "GITHUB",
      templateId: "TPL-OFF",
      templateVersion: 1,
    }),
  ]);

  const preview = await previewCoding(db, txnApplyRecurring, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "an inactive template decides nothing");
  assert(
    skippedFor(preview, "TPL-OFF", "out_of_scope_engagement"),
    `expected the template skip, got ${show(skipDetails(preview, "TPL-OFF"))}`,
  );
  assertEqual(
    skipDetails(preview, "TPL-OFF")[0],
    "out_of_scope_engagement:template_inactive",
    "and the detail says the template is switched off",
  );
  assertEqual(
    skipDetails(preview, "TX-SUB")[0],
    "missing_prerequisite:no_recurring_template",
    "the charge is simply unmatched, and the next cascade step gets it",
  );
  assertEqual(
    skipDetails(preview, "TX-DONE")[0],
    "already_applied:already_resolved_level_5",
    "a row a template already coded is never coded twice",
  );
});

test("apply recurring, ordering, a rule may not overwrite a template split", async () => {
  const seed = (): ReturnType<typeof codingDb> => {
    const db = codingDb();
    seedCharge(db);
    db.seed("recurring_templates", [template("TPL-1", { splitMode: "fixed_amount" })]);
    db.seed("recurring_splits", [
      split("SPL-1", "TPL-1", 1, { fixedAmountCents: BigInt(4000) }),
      split("SPL-2", "TPL-1", 2, {
        fixedAmountCents: BigInt(6000),
        categoryId: "CAT-rent",
        accountNumber: "6300",
      }),
    ]);
    db.seed("rules", [rule("RULE-GITHUB")]);
    return db;
  };

  // Rules first, which is the wrong order. The whole charge lands on one line.
  const outOfOrder = seed();
  const early = await previewCoding(outOfOrder, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(early.result.proposals.length, 1, "the rule would code the whole charge");

  // Documented order. The template splits it, then the rule stands down.
  const inOrder = seed();
  await applyCoding(inOrder, txnApplyRecurring, scopeFor(CLIENT_A1));
  const late = await previewCoding(inOrder, txnApplyRules, scopeFor(CLIENT_A1));
  assertEqual(late.result.proposals.length, 0, "the rule step proposes nothing");
  assertEqual(
    skipDetails(late, "TX-SUB")[0],
    "already_applied:already_resolved_level_5",
    "and it records that level 5 already decided the row",
  );
  const row = (inOrder.all("transactions") as TransactionRow[])[0];
  assertEqual(row.ruleId, null, "no rule id was written over the template provenance");
  assertEqual(row.templateId, "TPL-1", "the template provenance survives");
  assertEqual(inOrder.all("journal_lines").length, 3, "and the split is still two lines plus bank");
});
