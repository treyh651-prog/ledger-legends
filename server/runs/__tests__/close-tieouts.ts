/**
 * SUB-TIEOUT-ACCOUNTS. Doc 02 module 6 SUB-TIE-BALANCES.
 *
 * The questions these tests answer: does every substantiated balance sheet
 * account get a row, does each row compare the ledger to the source its block
 * names rather than to itself, is the sign right on the liabilities, does an
 * account with no source say unsupported instead of tied, and does a rerun over
 * an unchanged book write nothing.
 *
 * The run never posts, so every test also gets to assert that the ledger came
 * out the other side untouched.
 */

import { subTieBalances, tieoutId } from "../runs/sub-tie-balances";
import type { MemoryRunDb } from "../db-memory";
import type { SubTieoutRow } from "../tables";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  addAccount,
  applyClose,
  closeDb,
  closeScope,
  previewClose,
  recBatch,
  seedEntry,
  substantiation,
  tieout,
  tieoutsOf,
  PERIOD,
  PERIOD_END,
} from "./close-fixtures";
import { assert, assertEqual, test } from "./harness";

function rowFor(db: MemoryRunDb, accountNumber: string): SubTieoutRow | undefined {
  return tieoutsOf(db).find((r) => r.accountNumber === accountNumber);
}

test("tie out, every balance sheet account gets a row and no income account does", async () => {
  const db = closeDb();
  await applyClose(db, subTieBalances, closeScope());
  const numbers = tieoutsOf(db).map((r) => r.accountNumber);
  assertEqual(numbers, ["1010", "1990", "3200"], "the balance sheet accounts");
});

test("tie out, cash ties to the statement balance on the batch", async () => {
  const db = closeDb();
  await applyClose(db, subTieBalances, closeScope());
  const cash = rowFor(db, "1010");
  assertEqual(cash?.sourceKind, "statement_balance", "the source is the statement");
  assertEqual(cash?.ledgerBalanceCents, BigInt(100000), "the ledger balance");
  assertEqual(cash?.supportedBalanceCents, BigInt(100000), "the statement balance");
  assertEqual(cash?.varianceCents, BigInt(0), "no variance");
  assertEqual(cash?.tied, true, "tied");
  assertEqual(cash?.state, "computed_tied", "the state says so");
});

test("tie out, a statement that disagrees produces a signed variance", async () => {
  const db = closeDb();
  db.seed("rec_batches", [
    recBatch("RB-JAN", { statementBalanceCents: BigInt(97500) }),
  ]);
  await applyClose(db, subTieBalances, closeScope());
  const cash = rowFor(db, "1010");
  assertEqual(cash?.varianceCents, BigInt(2500), "ledger less supported");
  assertEqual(cash?.tied, false, "not tied");
  assertEqual(cash?.state, "variance_open", "the variance is open");
});

test("tie out, an account whose block carries no source is unsupported", async () => {
  const db = closeDb();
  await applyClose(db, subTieBalances, closeScope());
  const equity = rowFor(db, "3200");
  assertEqual(equity?.state, "unsupported", "equity has no substantiation source");
  assertEqual(equity?.supportedBalanceCents, null, "and no supported balance");
  assertEqual(equity?.varianceCents, null, "so no variance can be stated");
  assertEqual(equity?.tied, false, "an unsupported account is never tied");
});

test("tie out, cash with no statement loaded is unsupported rather than tied", async () => {
  const db = closeDb();
  db.seed("rec_batches", []);
  await applyClose(db, subTieBalances, closeScope());
  // Seeding an empty list leaves the earlier batch in place, so the batch is
  // pushed out of the window instead.
  const moved = closeDb();
  moved.seed("rec_batches", [
    recBatch("RB-JAN", { periodEnd: "2026-03-31", statementPeriod: "2026-03" }),
  ]);
  await applyClose(moved, subTieBalances, closeScope());
  const cash = rowFor(moved, "1010");
  assertEqual(cash?.state, "unsupported", "no statement means no support");
  assert(
    (cash?.detail ?? "").includes("no statement is loaded"),
    "the row says why",
  );
});

test("tie out, the receivable ties to the aging total", async () => {
  const db = closeDb();
  addAccount(db, "1100", "Accounts receivable");
  seedEntry(db, "JE-AR", "2026-01-18", [
    ["1100", BigInt(50000)],
    ["4100", BigInt(-50000)],
  ]);
  db.seed("aging_snapshots", [
    {
      id: "AG-AR",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      version: 1,
      asOfDate: PERIOD_END,
      side: "receivable",
      agingBasis: "due_date",
      partyId: "CUS-1",
      partyName: "customer one",
      documentId: "INV-1",
      documentNumber: "INV-1",
      documentDate: "2026-01-18",
      basisDate: "2026-01-18",
      ageDays: 13,
      bucket: "current",
      openBalanceCents: BigInt(50000),
      controlAccount: "1100",
      controlBalanceCents: BigInt(50000),
      tieDifferenceCents: BigInt(0),
      subledgerOutOfTie: false,
      createdByRunId: "RUNX-SEED",
      createdAt: "2026-02-01T00:00:00.000Z",
      manualOverride: false,
    },
  ]);
  await applyClose(db, subTieBalances, closeScope());
  const ar = rowFor(db, "1100");
  assertEqual(ar?.sourceKind, "aging_total", "the source is the aging");
  assertEqual(ar?.supportedBalanceCents, BigInt(50000), "a debit balance");
  assertEqual(ar?.tied, true, "tied");
});

test("tie out, a liability schedule is compared on the credit side", async () => {
  const db = closeDb();
  addAccount(db, "2700", "Note payable");
  seedEntry(db, "JE-LOAN", "2026-01-03", [
    ["1010", BigInt(500000)],
    ["2700", BigInt(-500000)],
  ]);
  db.seed("loans", [
    {
      id: "LN-1",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      lenderName: "a bank",
      loanType: "term",
      principalAccountLt: "2700",
      principalAccountCp: null,
      interestAccount: "8100",
      fundingAccount: "1010",
      escrowAccount: null,
      originalPrincipalCents: BigInt(500000),
      originationDate: "2026-01-03",
      firstPaymentDate: "2026-02-03",
      termMonths: 60,
      annualRateBps: 600,
      paymentCents: BigInt(10000),
      status: "active",
      manualOverride: false,
      version: 1,
    },
  ]);
  await applyClose(db, subTieBalances, closeScope());
  const loan = rowFor(db, "2700");
  assertEqual(loan?.supportedBalanceCents, BigInt(-500000), "stated as a credit");
  assertEqual(loan?.varianceCents, BigInt(0), "which is what makes it tie");
  assertEqual(loan?.sourceKind, "schedule_remaining", "from the amortization");
});

test("tie out, inventory ties to the physical count", async () => {
  const db = closeDb();
  addAccount(db, "1200", "Inventory");
  seedEntry(db, "JE-INV", "2026-01-12", [
    ["1200", BigInt(40000)],
    ["1010", BigInt(-40000)],
  ]);
  db.seed("substantiation_records", [
    substantiation("SR-INV", "inventory_count", "1200", BigInt(38000)),
  ]);
  await applyClose(db, subTieBalances, closeScope());
  const inventory = rowFor(db, "1200");
  assertEqual(inventory?.sourceKind, "physical_count", "counted, not computed");
  assertEqual(inventory?.varianceCents, BigInt(2000), "the shrink is stated");
  assertEqual(inventory?.state, "variance_open", "and left open");
});

test("tie out, a balance on the wrong side is flagged", async () => {
  const db = closeDb();
  seedEntry(db, "JE-OVERDRAWN", "2026-01-28", [
    ["1010", BigInt(-150000)],
    ["4100", BigInt(150000)],
  ]);
  await applyClose(db, subTieBalances, closeScope());
  assertEqual(rowFor(db, "1010")?.wrongSideNoReason, true, "cash went credit");
});

test("tie out, the run posts nothing", async () => {
  const db = closeDb();
  const before = db.all("journal_lines").length;
  await applyClose(db, subTieBalances, closeScope());
  assertEqual(db.all("journal_lines").length, before, "no line was written");
  assertEqual(db.all("journal_entries").length, 1, "no entry was written");
});

test("tie out, preview proposes what apply writes", async () => {
  const db = closeDb();
  const preview = await previewClose(db, subTieBalances, closeScope());
  assertEqual(db.all("sub_tieouts").length, 0, "preview wrote nothing");
  const { applied } = await applyClose(db, subTieBalances, closeScope());
  assertEqual(
    applied.result.proposals.length,
    preview.result.proposals.length,
    "the same proposal count",
  );
  assertEqual(db.all("sub_tieouts").length, 3, "and three rows landed");
});

test("tie out, a rerun over an unchanged book proposes nothing", async () => {
  const db = closeDb();
  await applyClose(db, subTieBalances, closeScope());
  const second = await previewClose(db, subTieBalances, closeScope());
  assertEqual(second.result.proposals.length, 0, "nothing left to propose");
  assertEqual(
    second.result.skips.filter((s) => s.reason === "already_applied").length,
    3,
    "each account was unchanged",
  );
});

test("tie out, a changed statement restates the row rather than adding one", async () => {
  const db = closeDb();
  await applyClose(db, subTieBalances, closeScope());
  // The batch version moves with the restatement, which is what tells the run
  // its scope changed rather than repeating itself.
  db.seed("rec_batches", [
    recBatch("RB-JAN", { statementBalanceCents: BigInt(90000), version: 2 }),
  ]);
  await applyClose(db, subTieBalances, closeScope());
  assertEqual(db.all("sub_tieouts").length, 3, "still three rows");
  assertEqual(rowFor(db, "1010")?.varianceCents, BigInt(10000), "restated");
});

test("tie out, a row carrying manual override is left alone", async () => {
  const db = closeDb();
  db.seed("sub_tieouts", [
    tieout(tieoutId(PERIOD, "1010"), "1010", {
      manualOverride: true,
      detail: "a person tied this by hand",
    }),
  ]);
  const { applied } = await applyClose(db, subTieBalances, closeScope());
  assert(
    applied.result.skips.some((s) => s.reason === "manual_override"),
    "the override was reported",
  );
  assertEqual(
    rowFor(db, "1010")?.detail,
    "a person tied this by hand",
    "and the row was not rewritten",
  );
});

test("tie out, a locked period is tied out because the run only reads", async () => {
  const db = closeDb();
  db.seed("period_locks", [
    lock("LOCK-JAN", FIRM_A, CLIENT_A1, PERIOD, PERIOD_END),
  ]);
  const { applied } = await applyClose(db, subTieBalances, closeScope());
  assertEqual(applied.status, "completed", "the run completed");
  assertEqual(db.all("sub_tieouts").length, 3, "and wrote its rows");
});

test("tie out, the period is part of the scope hash", async () => {
  const db = closeDb();
  const january = await previewClose(db, subTieBalances, closeScope(PERIOD));
  const february = await previewClose(db, subTieBalances, closeScope("2026-02-01"));
  assert(
    january.scopeHash !== february.scopeHash,
    "two periods are two scopes",
  );
});
