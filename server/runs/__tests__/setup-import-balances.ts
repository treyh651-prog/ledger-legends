/**
 * SETUP-IMPORT-BALANCES tests.
 *
 * The framework invariants, then the one thing this run exists to get right:
 * the entry foots or nothing is written. There is no third outcome and there is
 * no plug. Half of what follows is about refusing to post.
 */

import { assert, assertEqual, assertRejects, test } from "./harness";
import { isJournalEntry, isRowInsert } from "../contract";
import type { MemoryRunDb } from "../db-memory";
import {
  CUTOVER,
  INTAKE_CLIENT,
  PERIOD,
  applyIntake,
  balanceOf,
  balancedLines,
  balancesScope,
  chartScope,
  entriesOf,
  errorCodes,
  footingOf,
  intakeDb,
  linesOf,
  lockFirstPeriod,
  openingBalancesOf,
  previewIntake,
  shapeOf,
} from "./intake-fixtures";
import {
  balanceAgainstOpeningEquity,
  mergeLines,
  openingEntryId,
  setupImportBalances,
} from "../runs/setup-import-balances";
import { intakeBuildChart } from "../runs/intake-build-chart";
import { OPENING_BALANCE_EQUITY_ACCOUNT } from "../runs/intake-shared";

/**
 * The chart has to exist first, because the run refuses an account it cannot
 * find. Building it with the real run rather than seeding rows by hand is the
 * point: this is the order the wizard finishes in.
 */
async function withChart(): Promise<MemoryRunDb> {
  const db = intakeDb();
  await applyIntake(db, intakeBuildChart, chartScope());
  return db;
}

/** The signed total of the supplied lines, which the 3900 line has to negate. */
function suppliedTotal(): bigint {
  let total = BigInt(0);
  for (const [, cents] of balancedLines()) total += cents;
  return total;
}

test("import balances, preview and apply propose the identical set", async () => {
  const db = await withChart();
  const { preview, applied } = await applyIntake(
    db,
    setupImportBalances,
    balancesScope(balancedLines()),
  );
  assertEqual(
    shapeOf(applied.result.proposals),
    shapeOf(preview.result.proposals),
    "apply proposed exactly what preview showed",
  );
});

test("import balances, one entry per client per cutover", async () => {
  const db = await withChart();
  await applyIntake(db, setupImportBalances, balancesScope(balancedLines()));
  const entries = entriesOf(db);
  assertEqual(entries.length, 1, "exactly one opening entry");
  assertEqual(entries[0]?.entryDate, CUTOVER, "dated the cutover");
  assertEqual(
    entries[0]?.id,
    openingEntryId(INTAKE_CLIENT, CUTOVER),
    "and carrying the derived id",
  );
  assert(entries[0]?.posted === true, "and posted rather than left in a draft state");
});

test("import balances, the entry foots to exactly zero", async () => {
  const db = await withChart();
  await applyIntake(db, setupImportBalances, balancesScope(balancedLines()));
  assertEqual(footingOf(db), BigInt(0), "the lines sum to zero cents");
});

test("import balances, the offset lands on opening balance equity", async () => {
  const db = await withChart();
  await applyIntake(db, setupImportBalances, balancesScope(balancedLines()));
  assertEqual(
    balanceOf(db, OPENING_BALANCE_EQUITY_ACCOUNT),
    -suppliedTotal(),
    "3900 carries the negation of everything else and nothing more",
  );
});

test("import balances, every supplied account keeps the figure the firm typed", async () => {
  const db = await withChart();
  await applyIntake(db, setupImportBalances, balancesScope(balancedLines()));
  for (const [accountNumber, cents] of balancedLines()) {
    assertEqual(balanceOf(db, accountNumber), cents, `${accountNumber} posted as supplied`);
  }
});

test("import balances, an opening balance row lands per posted line", async () => {
  const db = await withChart();
  await applyIntake(db, setupImportBalances, balancesScope(balancedLines()));
  const rows = openingBalancesOf(db);
  assertEqual(rows.length, balancedLines().length + 1, "one per account plus the offset");
  assert(
    rows.every((r) => r.periodStart === PERIOD && r.sourcePeriodStart === CUTOVER),
    "and every one is stamped with the cutover it came from",
  );
  assert(
    rows.every((r) => r.sourceKind === "wizard_trial_balance"),
    "and says where it came from",
  );
  assert(rows.every((r) => r.manualOverride === false), "and none is an override");
});

test("import balances, a trial balance whose equity line disagrees is refused", async () => {
  const db = await withChart();
  const outcome = await previewIntake(
    db,
    setupImportBalances,
    // The supplied 3900 figure is nowhere near what the other lines offset to.
    // A plug would hide that. This run does not plug.
    balancesScope([
      ...balancedLines(),
      [OPENING_BALANCE_EQUITY_ACCOUNT, BigInt(-100000)],
    ]),
  );
  assertEqual(
    errorCodes(outcome).join(","),
    "OPENING_EQUITY_DISAGREES",
    "the run named the disagreement rather than absorbing it",
  );
  assertEqual(outcome.result.proposals.length, 0, "and proposed nothing");
  assertEqual(entriesOf(db).length, 0, "nothing was posted");
});

test("import balances, the disagreement message names both numbers", async () => {
  const db = await withChart();
  const outcome = await previewIntake(
    db,
    setupImportBalances,
    balancesScope([...balancedLines(), [OPENING_BALANCE_EQUITY_ACCOUNT, BigInt(-100000)]]),
  );
  const message = outcome.result.errors[0]?.message ?? "";
  assert(message.includes("-100000"), "the figure the firm typed is in the message");
  assert(
    message.includes((-suppliedTotal()).toString()),
    "and so is the figure the rest of the trial balance implies",
  );
});

test("import balances, a supplied equity line that agrees is accepted", async () => {
  const db = await withChart();
  await applyIntake(
    db,
    setupImportBalances,
    balancesScope([...balancedLines(), [OPENING_BALANCE_EQUITY_ACCOUNT, -suppliedTotal()]]),
  );
  assertEqual(entriesOf(db).length, 1, "the entry posted");
  assertEqual(footingOf(db), BigInt(0), "and it foots");
});

test("import balances, an error means apply writes nothing at all", async () => {
  const db = await withChart();
  await applyIntake(
    db,
    setupImportBalances,
    balancesScope([...balancedLines(), [OPENING_BALANCE_EQUITY_ACCOUNT, BigInt(-100000)]]),
  ).catch(() => undefined);
  assertEqual(entriesOf(db).length, 0, "no journal entry");
  assertEqual(linesOf(db).length, 0, "no journal lines");
  assertEqual(openingBalancesOf(db).length, 0, "and no opening balance rows either");
});

test("import balances, an account that is not on the chart is refused", async () => {
  const db = await withChart();
  const outcome = await previewIntake(
    db,
    setupImportBalances,
    balancesScope([
      ["1000", BigInt(10000)],
      ["8888", BigInt(-10000)],
    ]),
  );
  assertEqual(
    errorCodes(outcome).join(","),
    "ACCOUNT_NOT_ON_CHART",
    "the unknown account stopped the run",
  );
  assert(
    outcome.result.errors[0]?.message.includes("8888"),
    "and the message names which one",
  );
  assertEqual(entriesOf(db).length, 0, "nothing was posted");
});

test("import balances, an all zero trial balance is refused", async () => {
  const db = await withChart();
  const outcome = await previewIntake(
    db,
    setupImportBalances,
    balancesScope([
      ["1000", BigInt(0)],
      ["1100", BigInt(0)],
    ]),
  );
  assertEqual(
    errorCodes(outcome).join(","),
    "NO_OPENING_BALANCES",
    "there was nothing to post and the run said so",
  );
});

test("import balances, an empty trial balance never reaches the run", async () => {
  const db = await withChart();
  // A trial balance with no lines is refused by the scope schema, one layer
  // earlier than the footing check. Either refusal is correct. This asserts
  // which one actually happens so a schema change cannot quietly let it in.
  await assertRejects(
    () => previewIntake(db, setupImportBalances, balancesScope([])),
    "lines",
    "the scope schema refused an empty trial balance",
  );
  assertEqual(entriesOf(db).length, 0, "and nothing was posted");
});

test("import balances, a cutover that is not a day never reaches the run", async () => {
  const db = await withChart();
  await assertRejects(
    () =>
      previewIntake(
        db,
        setupImportBalances,
        balancesScope(balancedLines(), { cutoverDate: "2026-07" }),
      ),
    "cutoverDate",
    "a month is not a cutover and the schema said so",
  );
  assertEqual(entriesOf(db).length, 0, "and nothing was posted");
});

test("import balances, a closed cutover is skipped rather than redated", async () => {
  const db = await withChart();
  lockFirstPeriod(db);
  const outcome = await previewIntake(
    db,
    setupImportBalances,
    balancesScope(balancedLines()),
  );
  assertEqual(outcome.result.proposals.length, 0, "nothing proposed");
  assertEqual(outcome.result.skips[0]?.reason, "locked_period", "and the lock is the reason");
});

test("import balances, the second press does not double the books", async () => {
  const db = await withChart();
  await applyIntake(db, setupImportBalances, balancesScope(balancedLines()));
  const again = await previewIntake(db, setupImportBalances, balancesScope(balancedLines()));
  assertEqual(again.result.proposals.length, 0, "nothing left to post");
  assertEqual(again.result.skips[0]?.reason, "already_applied", "the balances are already on");
  assertEqual(entriesOf(db).length, 1, "still exactly one opening entry");
  assertEqual(footingOf(db), BigInt(0), "and the books still foot");
});

test("import balances, a duplicated account row is added rather than refused", () => {
  const merged = mergeLines([
    { accountNumber: "1000", amountCents: "10000" },
    { accountNumber: "1000", amountCents: "25000" },
    { accountNumber: "2000", amountCents: "-35000" },
  ]);
  assertEqual(merged.length, 2, "two accounts");
  assertEqual(merged[0]?.amountCents, BigInt(35000), "and the two 1000 rows were added");
});

test("import balances, merged lines come back account number ascending", () => {
  const merged = mergeLines([
    { accountNumber: "6000", amountCents: "1" },
    { accountNumber: "1000", amountCents: "2" },
    { accountNumber: "3000", amountCents: "3" },
  ]);
  assertEqual(
    merged.map((l) => l.accountNumber).join(","),
    "1000,3000,6000",
    "a deterministic order, so the proposal set is deterministic",
  );
});

test("import balances, a zero line is dropped from the entry", () => {
  const outcome = balanceAgainstOpeningEquity(
    mergeLines([
      { accountNumber: "1000", amountCents: "50000" },
      { accountNumber: "1100", amountCents: "0" },
      { accountNumber: "2000", amountCents: "-50000" },
    ]),
  );
  assertEqual(outcome.error, null, "the set is fine");
  assert(
    !outcome.lines.some((l) => l.accountNumber === "1100"),
    "an account with no opening balance has nothing to say",
  );
});

test("import balances, a set that already offsets needs no equity line", () => {
  const outcome = balanceAgainstOpeningEquity(
    mergeLines([
      { accountNumber: "1000", amountCents: "50000" },
      { accountNumber: "2000", amountCents: "-50000" },
    ]),
  );
  assertEqual(outcome.error, null, "the set is fine");
  assert(
    !outcome.lines.some((l) => l.accountNumber === OPENING_BALANCE_EQUITY_ACCOUNT),
    "and no empty 3900 line was invented",
  );
});

test("import balances, every proposal is the entry or an opening balance row", async () => {
  const db = await withChart();
  const outcome = await previewIntake(db, setupImportBalances, balancesScope(balancedLines()));
  let entries = 0;
  for (const p of outcome.result.proposals) {
    if (isJournalEntry(p)) {
      entries += 1;
      continue;
    }
    assert(isRowInsert(p), "the rest are row inserts");
    if (!isRowInsert(p)) continue;
    assertEqual(p.table, "opening_balances", "into the opening balance table only");
  }
  assertEqual(entries, 1, "and there is exactly one entry in the set");
});

test("import balances, no line carries a float", async () => {
  const db = await withChart();
  const outcome = await previewIntake(db, setupImportBalances, balancesScope(balancedLines()));
  for (const p of outcome.result.proposals) {
    if (!isJournalEntry(p)) continue;
    let total = BigInt(0);
    for (const line of p.lines) {
      assertEqual(typeof line.amountCents, "bigint", "integer cents, never a number");
      total += line.amountCents;
    }
    assertEqual(total, BigInt(0), "and the proposed entry foots before it is ever written");
  }
});
