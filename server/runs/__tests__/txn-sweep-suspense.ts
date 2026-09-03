/**
 * TXN-SWEEP-SUSPENSE tests. Cascade step 9, the floor of the cascade.
 *
 * Three things are covered:
 *   1. Happy path. An uncoded row is posted to 1990 with a mandatory reason code,
 *      an owner, an opened date, and an escalation date, and the entry balances.
 *   2. Skip path. A row an earlier step resolved, a row already in suspense, and
 *      a row in a locked period are each reported with the reason recorded.
 *   3. Ordering. This run comes last. A row TXN-MAP-BANKCODES coded must never be
 *      swept, and a code an earlier step chose is carried rather than recomputed.
 */

import { isJournalEntry, isFieldWrite, isRowInsert } from "../contract";
import type { PortalRequestRow, TransactionRow } from "../tables";
import {
  CHARGEBACK_TOKENS,
  decideReason,
  txnSweepSuspense,
} from "../runs/txn-sweep-suspense";
import { txnMapBankCodes } from "../runs/txn-map-bankcodes";
import { CLIENT_A1, FIRM_A, lock, scopeFor, txn } from "./fixtures";
import {
  applyCoding,
  bankCodeMapping,
  clientPolicy,
  codingDb,
  previewCoding,
  skipDetails,
  skippedFor,
  standardCategories,
  suspenseItem,
  portalRequestRow,
} from "./coding-fixtures";
import { assert, assertEqual, show, test } from "./harness";

const SWEEP_INPUTS = {
  functionalCurrency: "USD",
  capitalizeOverCents: BigInt(250000),
  isProcessorDestination: false,
  hasSettlementRow: false,
  locked: false,
};

test("sweep suspense, happy path posts to 1990 with a complete suspense record", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("transactions", [
    txn("TX-MYSTERY", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-4200), {
      normalizedVendor: "SOME PLACE",
    }),
  ]);

  const { applied } = await applyCoding(db, txnSweepSuspense, scopeFor(CLIENT_A1));
  assertEqual(applied.status, "completed", `status ${show(applied.status)}`);

  const lines = db.all("journal_lines");
  assertEqual(lines.length, 2, "the bank line as observed plus the balancing line");
  let net = BigInt(0);
  for (const l of lines) net += l.amountCents;
  assertEqual(net, BigInt(0), "and the entry balances to exactly zero");
  const suspenseLine = lines.find((l) => l.accountNumber === "1990");
  assertEqual(suspenseLine?.amountCents, BigInt(4200), "the whole amount sits in 1990");

  const row = (db.all("transactions") as TransactionRow[])[0];
  assertEqual(row.suspenseReason, "SUS-01", "money out with no vendor is SUS-01");
  assertEqual(row.suspenseOwner, "firm", "the catalog owner is written, not guessed");
  assertEqual(row.suspenseOpenedOn, "2026-01-09", "opened on the posted date");
  assertEqual(row.suspenseEscalatesOn, "2026-01-14", "and it escalates five days later");
  assertEqual(row.cascadeLevel, 9, "at cascade level 9, the floor");
  assert(row.categoryId === null, "suspense is an account, not a category");
});

test("sweep suspense, the reason code decision list is ordered and total", () => {
  const base = (
    extra: Parameters<typeof txn>[6] = {},
    amountCents: bigint = BigInt(-4200),
  ): TransactionRow =>
    txn("TX-1", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", amountCents, {
      normalizedVendor: "SOME PLACE",
      ...extra,
    });

  assertEqual(
    decideReason(base({ currency: "EUR" }), SWEEP_INPUTS).reasonCode,
    "SUS-11",
    "currency is checked first, because nothing else can be trusted until it is",
  );
  assertEqual(
    decideReason(base({ currency: "EUR" }), { ...SWEEP_INPUTS, locked: true }).reasonCode,
    "SUS-11",
    "and it outranks even a locked period",
  );
  assertEqual(
    decideReason(base(), { ...SWEEP_INPUTS, locked: true }).reasonCode,
    "SUS-20",
    "a locked period is next",
  );
  assertEqual(
    decideReason(base({}, BigInt(-250000)), SWEEP_INPUTS).reasonCode,
    "SUS-09",
    "the capitalization threshold is at or above, not strictly above",
  );
  assertEqual(
    decideReason(base(), { ...SWEEP_INPUTS, isProcessorDestination: true }).reasonCode,
    "SUS-12",
    "a processor account with no settlement row is SUS-12",
  );
  assertEqual(
    decideReason(base(), {
      ...SWEEP_INPUTS,
      isProcessorDestination: true,
      hasSettlementRow: true,
    }).reasonCode,
    "SUS-01",
    "and once the settlement row is loaded that reason no longer applies",
  );
  assertEqual(
    decideReason(base({ normalizedVendor: "SQ CHARGEBACK FEE" }), SWEEP_INPUTS).reasonCode,
    "SUS-13",
    "a chargeback token in the descriptor is SUS-13",
  );
  assert(
    CHARGEBACK_TOKENS.includes("NSF"),
    "and a returned item counts as one of those tokens",
  );
  assertEqual(
    decideReason(base({}, BigInt(4200)), SWEEP_INPUTS).reasonCode,
    "SUS-02",
    "money in with no source is SUS-02",
  );
  assertEqual(
    decideReason(base({ vendorId: "VEN-GH" }), SWEEP_INPUTS).reasonCode,
    "SUS-03",
    "a known vendor with no determinable purpose falls to SUS-03",
  );
});

test("sweep suspense, a client owned code opens exactly one portal request", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("transactions", [
    // A known vendor, so the reason is SUS-03, which the catalog says the client owns.
    txn("TX-ASK", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-4200), {
      normalizedVendor: "SOME PLACE",
      vendorId: "VEN-SP",
    }),
  ]);

  const { applied } = await applyCoding(db, txnSweepSuspense, scopeFor(CLIENT_A1));
  assertEqual(applied.result.proposals.filter(isRowInsert).length, 1, "one request");
  const requests = db.all("portal_requests") as PortalRequestRow[];
  assertEqual(requests.length, 1, "written once");
  assertEqual(requests[0].reasonCode, "SUS-03", "carrying the reason it is asking about");
  assertEqual(requests[0].transactionId, "TX-ASK", "and the row it is asking about");
  assertEqual(requests[0].dueOn, "2026-01-16", "due on the escalation date, seven days out");

  // Same question, already open. Asking twice is how a portal stops being read.
  const again = codingDb();
  again.seed("categories", standardCategories());
  again.seed("client_policies", [clientPolicy()]);
  again.seed("transactions", [
    txn("TX-ASK", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-4200), {
      normalizedVendor: "SOME PLACE",
      vendorId: "VEN-SP",
    }),
  ]);
  again.seed("portal_requests", [portalRequestRow("PR-1", "TX-ASK", "SUS-03")]);
  const second = await previewCoding(again, txnSweepSuspense, scopeFor(CLIENT_A1));
  assertEqual(
    second.result.proposals.filter(isRowInsert).length,
    0,
    "the open request already covers it",
  );
  assert(
    second.result.proposals.some(isJournalEntry),
    "and the posting to 1990 still happens, because the money has to go somewhere",
  );
});

test("sweep suspense, a firm owned code opens no portal request", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("transactions", [
    txn("TX-MYSTERY", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-4200), {
      normalizedVendor: "SOME PLACE",
    }),
  ]);
  const preview = await previewCoding(db, txnSweepSuspense, scopeFor(CLIENT_A1));
  assertEqual(
    preview.result.proposals.filter(isRowInsert).length,
    0,
    "SUS-01 is the firm's own work and the client is not asked about it",
  );
});

test("sweep suspense, an earlier step's reason code is carried, not recomputed", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("transactions", [
    txn("TX-DUP", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-4200), {
      normalizedVendor: "SOME PLACE",
    }),
  ]);
  // Two earlier codes, so the tie break matters and has to be deterministic.
  db.seed("suspense_items", [
    suspenseItem("SI-1", "TX-DUP", "SUS-19"),
    suspenseItem("SI-2", "TX-DUP", "SUS-05"),
  ]);

  await applyCoding(db, txnSweepSuspense, scopeFor(CLIENT_A1));
  const row = (db.all("transactions") as TransactionRow[])[0];
  assertEqual(
    row.suspenseReason,
    "SUS-05",
    "the lowest earlier code wins, so a rerun picks the same one every time",
  );
  assertEqual(row.suspenseEscalatesOn, "2026-01-12", "with that code's own escalation clock");
});

test("sweep suspense, skip path records the resolved row, the swept row, and the lock", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("transactions", [
    txn("TX-CODED", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-4200), {
      normalizedVendor: "GITHUB",
      categoryId: "CAT-software",
      categoryVersion: 1,
      cascadeLevel: 6,
      ruleId: "RULE-GITHUB",
      ruleVersion: 1,
    }),
    txn("TX-ALREADY", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-4200), {
      normalizedVendor: "SOME PLACE",
      cascadeLevel: 9,
      suspenseReason: "SUS-01",
      suspenseOwner: "firm",
      suspenseOpenedOn: "2026-01-10",
    }),
    txn("TX-LOCKED", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-20", BigInt(-4200), {
      normalizedVendor: "SOME PLACE",
    }),
  ]);
  db.seed("period_locks", [lock("LK-JAN20", FIRM_A, CLIENT_A1, "2026-01-20", "2026-01-20")]);

  const preview = await previewCoding(db, txnSweepSuspense, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "nothing needs sweeping");
  assertEqual(
    skipDetails(preview, "TX-CODED")[0],
    "already_applied:resolved",
    "a coded row is never swept, which is what keeps the cascade from eating its own work",
  );
  assertEqual(
    skipDetails(preview, "TX-ALREADY")[0],
    "already_applied:already_in_suspense",
    "and a row already in suspense is not posted there twice",
  );
  assert(
    skippedFor(preview, "TX-LOCKED", "locked_period"),
    `a locked row waits rather than being redated, got ${show(skipDetails(preview, "TX-LOCKED"))}`,
  );
});

test("sweep suspense, a paired transfer and a split settlement are both left alone", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("client_policies", [clientPolicy()]);
  db.seed("transactions", [
    txn("TX-XFER", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-25000), {
      pairedWithId: "TX-XFER-IN",
      cascadeLevel: 3,
    }),
    txn("TX-SETTLE", FIRM_A, CLIENT_A1, "BA-A1-PROC", "2026-01-15", BigInt(97100), {
      normalizedVendor: "STRIPE",
      isProcessorSettlement: true,
      cascadeLevel: 4,
    }),
  ]);

  const preview = await previewCoding(db, txnSweepSuspense, scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "neither row is swept");
  for (const id of ["TX-XFER", "TX-SETTLE"]) {
    assertEqual(
      skipDetails(preview, id)[0],
      "already_applied:resolved",
      `${id} carries its coding on the entry rather than on a category column`,
    );
  }
});

test("sweep suspense, ordering, a bank code decision is never swept away", async () => {
  const seed = (): ReturnType<typeof codingDb> => {
    const db = codingDb();
    db.seed("categories", standardCategories());
    db.seed("client_policies", [clientPolicy()]);
    db.seed("bank_code_mappings", [bankCodeMapping("BCM-1", "5734")]);
    db.seed("transactions", [
      txn("TX-ANON", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-09", BigInt(-4200), {
        normalizedVendor: "UNKNOWN MERCHANT",
        bankCode: "5734",
        institutionId: "INST-1",
      }),
    ]);
    return db;
  };

  // Sweeping first, which is the wrong order. A row that had a perfectly good
  // mapping lands in suspense and somebody gets asked a question for nothing.
  const outOfOrder = seed();
  await applyCoding(outOfOrder, txnSweepSuspense, scopeFor(CLIENT_A1));
  const wrong = (outOfOrder.all("transactions") as TransactionRow[])[0];
  assertEqual(
    wrong.suspenseReason,
    "SUS-01",
    "the row is in suspense, which is the defect being guarded",
  );
  // Running the mapping afterwards does not repair it. The row gets a category,
  // but the posting to 1990 is already on the books and this run does not reverse
  // entries, so the row is coded twice and 1990 never clears.
  await applyCoding(outOfOrder, txnMapBankCodes, scopeFor(CLIENT_A1));
  const late = (outOfOrder.all("transactions") as TransactionRow[])[0];
  assertEqual(late.categoryId, "CAT-software", "the mapping writes a category anyway");
  assert(
    late.suspenseReason !== null,
    "while the row still carries a suspense reason, which is a contradiction",
  );
  const stranded = outOfOrder
    .all("journal_lines")
    .filter((l) => l.accountNumber === "1990")
    .reduce((sum, l) => sum + l.amountCents, BigInt(0));
  assertEqual(
    stranded,
    BigInt(4200),
    "and 1990 is left holding money, so gate G01 can never reach zero",
  );

  // Documented order. Bank codes first, then the sweep finds nothing to do.
  const inOrder = seed();
  await applyCoding(inOrder, txnMapBankCodes, scopeFor(CLIENT_A1));
  const swept = await previewCoding(inOrder, txnSweepSuspense, scopeFor(CLIENT_A1));
  assertEqual(swept.result.proposals.length, 0, "the sweep proposes nothing");
  assertEqual(
    skipDetails(swept, "TX-ANON")[0],
    "already_applied:resolved",
    "because the row was already resolved above it",
  );
  const right = (inOrder.all("transactions") as TransactionRow[])[0];
  assertEqual(right.categoryId, "CAT-software", "the mapping decision survives");
  assert(right.suspenseReason === null, "and nothing was ever put into suspense");
  assertEqual(
    inOrder.all("journal_lines").filter((l) => l.accountNumber === "1990").length,
    0,
    "so 1990 stays empty, which is what gate G01 measures",
  );
});
