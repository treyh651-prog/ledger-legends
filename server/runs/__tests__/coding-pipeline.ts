/**
 * The module 2 coding cascade, end to end.
 *
 * The nine runs are only correct together. Each one on its own is tested in its
 * own file, so this file tests the thing no single run can test:
 *   1. The order is data, not folklore. CODING_CASCADE_ORDER is what the pipeline
 *      walks, and the registry has to agree with it.
 *   2. A mixed batch driven through the whole cascade in the documented order
 *      leaves no row undecided. Every row ends with a cascade level and either a
 *      category, a transfer pairing, a settlement split, or a suspense reason and
 *      code. There is no fourth outcome and there is no silent uncoded row.
 *   3. A batch with nothing wrong in it drives gate G01 to zero, that is 1910,
 *      1920, 1930, and 1990 all end at exactly zero.
 *   4. Reordering the cascade breaks it, which is what makes the order a contract
 *      rather than a preference.
 */

import type { MemoryRunDb } from "../db-memory";
import type { Proposal, Run } from "../contract";
import type { RunOutcome } from "../execute";
import type { TransactionRow } from "../tables";
import { CODING_CASCADE_ORDER, cascadePosition, lookupRun } from "../registry";
import { resolvedLevel } from "../runs/coding-cascade";
import { CLIENT_A1, FIRM_A, scopeFor, txn } from "./fixtures";
import {
  applyCoding,
  bankCodeMapping,
  clientPolicy,
  codingDb,
  rule,
  settlementRow,
  split,
  standardCategories,
  template,
  vendor,
} from "./coding-fixtures";
import { assert, assertEqual, show, test } from "./harness";

/** The four accounts gate G01 requires at zero, doc 00 Part 6. */
const G01_ACCOUNTS: readonly string[] = ["1910", "1920", "1930", "1990"];

/** Reference data the whole cascade reads. Seeded once per pipeline test. */
function seedReferenceData(db: MemoryRunDb): void {
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("settlement_rows", [settlementRow("SET-1")]);
  db.seed("recurring_templates", [
    template("TPL-ADOBE", {
      matchNormalizedName: "ADOBE",
      splitMode: "fixed_amount",
      matchAmountCents: BigInt(-30000),
    }),
  ]);
  db.seed("recurring_splits", [
    split("SPL-1", "TPL-ADOBE", 1, { fixedAmountCents: BigInt(20000) }),
    split("SPL-2", "TPL-ADOBE", 2, {
      fixedAmountCents: BigInt(10000),
      categoryId: "CAT-rent",
      accountNumber: "6300",
    }),
  ]);
  db.seed("rules", [rule("RULE-GITHUB")]);
  db.seed("vendors", [vendor("VEN-DEPOT", "OFFICE DEPOT")]);
  db.seed("bank_code_mappings", [bankCodeMapping("BCM-5734", "5734")]);
}

/**
 * The rows that resolve cleanly, one per cascade level that can resolve a row.
 * Every descriptor is written the way a bank would write it, because the pipeline
 * runs the real normalizer and a hand written normalized vendor would be a test
 * of nothing.
 */
function seedCleanBatch(db: MemoryRunDb): void {
  db.seed("transactions", [
    // Level 3, an ordinary transfer between two accounts of the same client.
    txn("TX-XO", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000), {
      bankMerchantName: "INTERNAL TRANSFER",
      normalizedVendor: null,
    }),
    txn("TX-XI", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-11", BigInt(25000), {
      bankMerchantName: "INTERNAL TRANSFER",
      normalizedVendor: null,
    }),
    // Level 4, the processor payout, and the sweep of that payout into the
    // operating account so the processor clearing account comes back to zero.
    txn("TX-DEP", FIRM_A, CLIENT_A1, "BA-A1-PROC", "2026-01-15", BigInt(97100), {
      accountNumber: "1910",
      description: "STRIPE TRANSFER PO-1",
      normalizedVendor: null,
    }),
    txn("TX-PAYOUT", FIRM_A, CLIENT_A1, "BA-A1-PROC", "2026-01-16", BigInt(-97100), {
      accountNumber: "1910",
      bankMerchantName: "INTERNAL TRANSFER",
      normalizedVendor: null,
    }),
    txn("TX-RECV", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-16", BigInt(97100), {
      bankMerchantName: "INTERNAL TRANSFER",
      normalizedVendor: null,
    }),
    // Level 5, a recurring template with two fixed lines.
    txn("TX-ADOBE", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-12", BigInt(-30000), {
      bankMerchantName: "ADOBE",
      normalizedVendor: null,
    }),
    // Level 6, a user rule.
    txn("TX-GH", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-2500), {
      bankMerchantName: "GITHUB",
      normalizedVendor: null,
    }),
    // Level 7, a vendor default.
    txn("TX-DEPOT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-13", BigInt(-8800), {
      bankMerchantName: "OFFICE DEPOT #1042",
      normalizedVendor: null,
    }),
    // Level 8, a bank code mapping and nothing else.
    txn("TX-CODE", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-14", BigInt(-1900), {
      bankMerchantName: "SOME UNKNOWN MERCHANT",
      normalizedVendor: null,
      bankCode: "5734",
      institutionId: "INST-1",
    }),
  ]);
}

/** The rows that cannot resolve cleanly and have to land somewhere on purpose. */
function seedMessyBatch(db: MemoryRunDb): void {
  db.seed("transactions", [
    // Level 2, the same charge twice from a feed that resent a day.
    txn("TX-DUP-A", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-05", BigInt(-1500), {
      bankMerchantName: "COFFEE BAR",
      normalizedVendor: null,
    }),
    txn("TX-DUP-B", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-06", BigInt(-1500), {
      bankMerchantName: "COFFEE BAR",
      normalizedVendor: null,
    }),
    // Level 9, nothing anywhere identifies this one.
    txn("TX-WHO", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-07", BigInt(-6600), {
      bankMerchantName: "PMT 4471",
      normalizedVendor: null,
    }),
    // Level 9 by way of the currency check, which outranks everything else.
    txn("TX-EUR", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-08", BigInt(-4500), {
      bankMerchantName: "GITHUB",
      normalizedVendor: null,
      currency: "EUR",
    }),
  ]);
}

/** Walk the cascade in the documented order, previewing then applying each step. */
async function runCascade(
  db: MemoryRunDb,
  order: readonly string[] = CODING_CASCADE_ORDER,
): Promise<Map<string, RunOutcome<Proposal>>> {
  const outcomes = new Map<string, RunOutcome<Proposal>>();
  for (const type of order) {
    const found = lookupRun(type);
    if (!found) throw new Error(`no run registered for ${type}`);
    const { applied } = await applyCoding(
      db,
      found.run as unknown as Run<unknown, Proposal>,
      scopeFor(CLIENT_A1) as unknown,
    );
    outcomes.set(type, applied);
  }
  return outcomes;
}

/** The net movement on one account across everything the cascade posted. */
function balanceOf(db: MemoryRunDb, accountNumber: string): bigint {
  return db
    .all("journal_lines")
    .filter((l) => l.accountNumber === accountNumber)
    .reduce((sum, l) => sum + l.amountCents, BigInt(0));
}

/** How a row was decided, or null when nothing decided it. */
function outcomeOf(t: TransactionRow): string | null {
  if (t.pairedWithId !== null) return "transfer";
  if (t.isProcessorSettlement) return "settlement";
  if (t.categoryId !== null) return "category";
  if (t.suspenseReason !== null) return "suspense";
  return null;
}

test("coding pipeline, the execution order is data and the registry agrees with it", () => {
  assertEqual(CODING_CASCADE_ORDER.length, 9, "nine runs in module 2");
  for (const type of CODING_CASCADE_ORDER) {
    assert(lookupRun(type) !== null, `${type} is registered`);
  }
  const registered = CODING_CASCADE_ORDER.map((type) => cascadePosition(type));
  assertEqual(
    registered.join(","),
    "0,1,2,3,4,5,6,7,8",
    "and every one of them knows where it sits",
  );
  assertEqual(cascadePosition("IMPORT-PARSE-FEED"), null, "an import run is not in the cascade");

  // The four orderings the specification argues for by name, asserted by name.
  const before = (a: string, b: string): boolean =>
    (cascadePosition(a) ?? -1) < (cascadePosition(b) ?? -1);
  assert(
    before("TXN-NORMALIZE-VENDORS", "TXN-DETECT-DUPLICATES"),
    "duplicates compare normalized vendors, so normalization comes first",
  );
  assert(
    before("TXN-PAIR-TRANSFERS", "TXN-APPLY-RULES"),
    "pairing comes before rules, which is the ordering the owner called out",
  );
  assert(
    before("TXN-SPLIT-SETTLEMENTS", "TXN-APPLY-RULES"),
    "and a settlement is split before a rule can see the net deposit",
  );
  assert(
    before("TXN-APPLY-RECURRING", "TXN-APPLY-RULES") &&
      before("TXN-APPLY-RULES", "TXN-APPLY-VENDORDEFAULTS") &&
      before("TXN-APPLY-VENDORDEFAULTS", "TXN-MAP-BANKCODES") &&
      before("TXN-MAP-BANKCODES", "TXN-SWEEP-SUSPENSE"),
    "the coding levels run strongest evidence first and the sweep runs last",
  );
});

test("coding pipeline, a mixed batch ends with every row decided", async () => {
  const db = codingDb();
  seedReferenceData(db);
  seedCleanBatch(db);
  seedMessyBatch(db);

  await runCascade(db);

  const rows = db.all("transactions") as TransactionRow[];
  assertEqual(rows.length, 13, "thirteen rows went in");
  for (const t of rows) {
    const decided = outcomeOf(t);
    assert(
      decided !== null,
      `${t.id} finished the cascade with nothing deciding it, category ${show(t.categoryId)}`,
    );
    assert(
      resolvedLevel(t) !== null,
      `${t.id} was decided as ${show(decided)} but the register cannot say at what level`,
    );
    if (decided === "suspense") {
      assert(t.suspenseReason !== null, `${t.id} is in suspense with no reason code`);
      assert(t.suspenseOwner !== null, `${t.id} is in suspense with no owner`);
      assert(t.suspenseEscalatesOn !== null, `${t.id} is in suspense with no escalation date`);
      assertEqual(t.cascadeLevel, 9, `${t.id} sits at the floor of the cascade`);
    }
  }

  const byId = new Map(rows.map((t) => [t.id, t]));
  const levelOf = (id: string): number | null => {
    const row = byId.get(id);
    return row ? resolvedLevel(row) : null;
  };
  assertEqual(levelOf("TX-XO"), 3, "the transfer resolved at level 3");
  assertEqual(levelOf("TX-DEP"), 4, "the payout split at level 4");
  assertEqual(byId.get("TX-ADOBE")?.templateId, "TPL-ADOBE", "the template decided its row");
  assertEqual(byId.get("TX-GH")?.ruleId, "RULE-GITHUB", "the rule decided its row");
  assertEqual(levelOf("TX-DEPOT"), 7, "the vendor default decided its row");
  assertEqual(levelOf("TX-CODE"), 8, "the bank code decided its row");
  assertEqual(
    byId.get("TX-DUP-B")?.duplicateOfTransactionId,
    "TX-DUP-A",
    "the later copy points at the earlier one, never the other way round",
  );
  assertEqual(
    byId.get("TX-EUR")?.suspenseReason,
    "SUS-11",
    "a foreign currency row is a currency question and not a coding question",
  );

  // Every posted entry still balances, which is the one invariant no cascade
  // ordering argument is allowed to trade away.
  const byEntry = new Map<string, bigint>();
  for (const l of db.all("journal_lines")) {
    byEntry.set(l.entryId, (byEntry.get(l.entryId) ?? BigInt(0)) + l.amountCents);
  }
  for (const [entryId, net] of byEntry) {
    assertEqual(net, BigInt(0), `entry ${entryId} balances`);
  }
});

test("coding pipeline, a clean batch drives gate G01 to zero", async () => {
  const db = codingDb();
  seedReferenceData(db);
  seedCleanBatch(db);

  await runCascade(db);

  const rows = db.all("transactions") as TransactionRow[];
  for (const t of rows) {
    assert(
      t.suspenseReason === null,
      `${t.id} landed in suspense and nothing in this batch should have`,
    );
    assert(outcomeOf(t) !== null, `${t.id} finished the cascade with nothing deciding it`);
  }

  for (const account of G01_ACCOUNTS) {
    assertEqual(
      balanceOf(db, account),
      BigInt(0),
      `gate G01 requires ${account} at exactly zero`,
    );
  }
  assertEqual(
    db.all("journal_lines").filter((l) => l.accountNumber === "1990").length,
    0,
    "and nothing was ever written to suspense in the first place",
  );

  // The coded rows all carry the provenance that answers the six month question.
  for (const t of rows) {
    if (outcomeOf(t) !== "category") continue;
    const source =
      t.ruleId !== null ? "rule" : t.templateId !== null ? "template" : "reference data";
    assert(
      t.cascadeLevel !== null,
      `${t.id} was coded from ${source} without recording the level`,
    );
    assertEqual(t.categoryVersion !== null, true, `${t.id} recorded the category version`);
  }
});

test("coding pipeline, running the sweep early breaks the cascade", async () => {
  // The same clean batch, with the sweep moved to the front. Nothing has been
  // coded yet at that point, so the sweep is the step that decides everything and
  // gate G01 can no longer reach zero. This is why the order is a contract.
  const db = codingDb();
  seedReferenceData(db);
  seedCleanBatch(db);

  const wrongOrder = [
    "TXN-NORMALIZE-VENDORS",
    "TXN-SWEEP-SUSPENSE",
    ...CODING_CASCADE_ORDER.filter(
      (t) => t !== "TXN-NORMALIZE-VENDORS" && t !== "TXN-SWEEP-SUSPENSE",
    ),
  ];
  await runCascade(db, wrongOrder);

  const rows = db.all("transactions") as TransactionRow[];
  const swept = rows.filter((t) => t.suspenseReason !== null);
  assert(
    swept.length > 0,
    "rows that had a rule, a template, and a mapping waiting for them went to suspense",
  );
  assert(
    balanceOf(db, "1990") !== BigInt(0),
    "so 1990 is left holding money and gate G01 fails the close",
  );
});
