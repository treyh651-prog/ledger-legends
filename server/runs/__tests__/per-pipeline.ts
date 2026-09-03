/**
 * The module 4 pipeline. All six period end runs, in the registry order, against
 * one January for one client, and then the February open that reverses what
 * January accrued.
 *
 * The batch is built so every number in it is one you can check by hand:
 *
 *   recurring rent           250000  expense 6100, credit accrued 2200
 *   prepaid insurance         10191  expense 6200, release from prepaid 1310
 *   loan payment interest     40000  expense 8100
 *   loan payment principal    60000  note 2750, cash 1010 pays the whole 100000
 *   accrued rent              50000  expense 6100, credit accrued 2200
 *   depreciation             100000  expense 6700, contra 1590
 *
 * So the period's effect on net income is the sum of the five expense pieces,
 * 450191, and nothing else in the module touches the profit and loss: the
 * principal split moves one balance sheet account to another, and the reversal
 * next period gives the accrual back exactly.
 *
 * The prepaid number is the one that looks arbitrary and is not. The schedule
 * runs a full year and the run weights each month by its days, so January takes
 * thirty one three hundred sixty fifths of 120000, which is 10191 with the
 * residual carried to the last month rather than smeared.
 */

import { canonicalJson, toJsonValue } from "../ids";
import { PERIOD_END_ORDER } from "../registry";
import { perAmortizePrepaids } from "../runs/per-amortize-prepaids";
import { perPostAccruals } from "../runs/per-post-accruals";
import { perPostDepreciation } from "../runs/per-post-depreciation";
import { perPostRecurring } from "../runs/per-post-recurring";
import { perReverseAccruals } from "../runs/per-reverse-accruals";
import { perSplitLoan } from "../runs/per-split-loan";
import type { MemoryRunDb } from "../db-memory";
import type { JournalLineRow } from "../tables";
import { CLIENT_A1, FIRM_A, txn } from "./fixtures";
import {
  accrualTemplate,
  applyPer,
  asset,
  balanceOf,
  generatedTemplate,
  linesOf,
  loan,
  loanPayment,
  perDb,
  periodScope,
  prepaid,
  split,
  sumLines,
} from "./per-fixtures";
import { assert, assertEqual, show, test } from "./harness";

const RENT = BigInt(250000);
const PREPAID_JANUARY = BigInt(10191);
const INTEREST = BigInt(40000);
const PRINCIPAL = BigInt(60000);
const ACCRUAL = BigInt(50000);
const DEPRECIATION = BigInt(100000);
/** Every piece of this module that lands in the profit and loss. */
const EXPENSE_EFFECT = RENT + PREPAID_JANUARY + INTEREST + ACCRUAL + DEPRECIATION;

/** The accounts that close into net income in this chart. */
const PL_PREFIXES = ["4", "5", "6", "7", "8"];

function isPl(line: JournalLineRow): boolean {
  return PL_PREFIXES.includes(line.accountNumber.slice(0, 1));
}

/**
 * Net income is revenue less expense. Revenue lines are credits and carry a
 * negative sign, expenses are debits and carry a positive one, so the net of
 * every profit and loss line is net income with the sign flipped.
 */
function netIncome(db: MemoryRunDb): bigint {
  return -sumLines(db.all("journal_lines").filter(isPl));
}

/** Nothing in a double entry book ever nets to anything but zero. */
function books(db: MemoryRunDb): bigint {
  return sumLines(db.all("journal_lines"));
}

function januaryBatch(): MemoryRunDb {
  const db = perDb();

  db.seed("recurring_templates", [
    generatedTemplate("RT-RENT", { name: "Office rent" }),
  ]);
  db.seed("recurring_splits", [
    split("RS-RENT-1", "RT-RENT", 1, "6100", { fixedAmountCents: RENT }),
    split("RS-RENT-2", "RT-RENT", 2, "2200", { fixedAmountCents: -RENT }),
  ]);

  db.seed("deferral_schedules", [prepaid("DS-INS")]);

  db.seed("loans", [loan("LN-1")]);
  db.seed("loan_schedule", [loanPayment("LS-1", "LN-1")]);
  db.seed("transactions", [
    txn("TX-PMT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-15", BigInt(-100000), {
      cleared: true,
      description: "First Bank loan payment",
    }),
  ]);

  db.seed("accrual_templates", [accrualTemplate("AT-RENT")]);
  db.seed("fixed_assets", [asset("FA-1")]);
  return db;
}

/** The six runs, in the order the registry publishes, against one period. */
async function runPeriod(db: MemoryRunDb, period: string): Promise<void> {
  await applyPer(db, perReverseAccruals, periodScope(period));
  await applyPer(db, perPostRecurring, periodScope(period));
  await applyPer(db, perAmortizePrepaids, periodScope(period));
  await applyPer(db, perSplitLoan, periodScope(period));
  await applyPer(db, perPostAccruals, periodScope(period));
  await applyPer(db, perPostDepreciation, periodScope(period));
}

test("per pipeline, the registry order names all six runs once", () => {
  assertEqual(PERIOD_END_ORDER.length, 6, "six runs");
  assertEqual(
    new Set(PERIOD_END_ORDER).size,
    6,
    "and no run is named twice",
  );
  const types = [
    perReverseAccruals.type,
    perPostRecurring.type,
    perAmortizePrepaids.type,
    perSplitLoan.type,
    perPostAccruals.type,
    perPostDepreciation.type,
  ];
  for (const type of types) {
    assert(PERIOD_END_ORDER.includes(type), `${type} is in the order`);
  }
  assertEqual(
    canonicalJson(toJsonValue([...PERIOD_END_ORDER])),
    canonicalJson(toJsonValue(types)),
    "and the order in the registry is the order this pipeline runs",
  );
});

test("per pipeline, net income moves by exactly the sum of the module's effects", async () => {
  const db = januaryBatch();
  const opening = netIncome(db);
  assertEqual(opening, BigInt(0), "the period opens flat");

  await runPeriod(db, "2026-01-01");

  assertEqual(
    opening - netIncome(db),
    EXPENSE_EFFECT,
    "net income fell by the five expense pieces and by nothing else",
  );
  assertEqual(balanceOf(db, "6100"), RENT + ACCRUAL, "rent carries the two rent pieces");
  assertEqual(balanceOf(db, "6200"), PREPAID_JANUARY, "insurance carries one month");
  assertEqual(balanceOf(db, "8100"), INTEREST, "interest carries the loan interest");
  assertEqual(balanceOf(db, "6700"), DEPRECIATION, "and depreciation its month");
});

test("per pipeline, the balance sheet moves the way the entries say it does", async () => {
  const db = januaryBatch();
  await runPeriod(db, "2026-01-01");

  assertEqual(balanceOf(db, "1010"), BigInt(-100000), "cash paid the loan payment");
  assertEqual(balanceOf(db, "2750"), PRINCIPAL, "the note came down by principal");
  assertEqual(balanceOf(db, "1310"), -PREPAID_JANUARY, "the prepaid released a month");
  assertEqual(balanceOf(db, "1590"), -DEPRECIATION, "the contra took the depreciation");
  assertEqual(
    balanceOf(db, "2200"),
    -(RENT + ACCRUAL),
    "and the accrued liability carries both credits",
  );
  assertEqual(balanceOf(db, "1990"), BigInt(0), "nothing went to suspense");
});

test("per pipeline, the books foot after every run and every entry balances", async () => {
  const db = januaryBatch();
  const runs = [
    perReverseAccruals,
    perPostRecurring,
    perAmortizePrepaids,
    perSplitLoan,
    perPostAccruals,
    perPostDepreciation,
  ] as const;
  for (const run of runs) {
    await applyPer(db, run, periodScope("2026-01-01"));
    assertEqual(books(db), BigInt(0), `the books foot after ${run.type}`);
  }
  for (const entry of db.all("journal_entries")) {
    assertEqual(
      sumLines(linesOf(db, entry.id)),
      BigInt(0),
      `entry ${entry.id} balances on its own`,
    );
  }
  assertEqual(db.all("journal_entries").length, 5, "five entries for five effects");
});

test("per pipeline, no run refused and no error was reported", async () => {
  const db = januaryBatch();
  const runs = [
    perReverseAccruals,
    perPostRecurring,
    perAmortizePrepaids,
    perSplitLoan,
    perPostAccruals,
    perPostDepreciation,
  ] as const;
  for (const run of runs) {
    const { applied } = await applyPer(db, run, periodScope("2026-01-01"));
    // A no_op is a finish too. January has nothing to reverse, because the
    // accruals it is opening on top of do not exist yet.
    assert(
      applied.status === "completed" ||
        applied.status === "completed_with_skips" ||
        applied.status === "no_op",
      `${run.type} finished, got ${applied.status}`,
    );
    assertEqual(
      show(applied.result.errors.map((e) => e.code)),
      "[]",
      `${run.type} reported no errors`,
    );
  }
});

test("per pipeline, running the whole module twice changes nothing", async () => {
  const db = januaryBatch();
  await runPeriod(db, "2026-01-01");
  const after = {
    entries: db.all("journal_entries").length,
    lines: db.all("journal_lines").length,
    income: netIncome(db),
  };
  await runPeriod(db, "2026-01-01");
  assertEqual(db.all("journal_entries").length, after.entries, "the same entries");
  assertEqual(db.all("journal_lines").length, after.lines, "the same lines");
  assertEqual(netIncome(db), after.income, "and the same net income");
});

test("per pipeline, February's reversal cancels January's accrual line for line", async () => {
  const db = januaryBatch();
  await runPeriod(db, "2026-01-01");
  const accrual = db
    .all("journal_entries")
    .find((e) => e.accrualTemplateId === "AT-RENT");
  assert(accrual !== undefined, "January accrued");
  const before = linesOf(db, accrual?.id ?? "");
  const incomeAfterJanuary = netIncome(db);

  await applyPer(db, perReverseAccruals, periodScope("2026-02-01"));

  const reversal = db.all("journal_entries").find((e) => e.reversalOf === accrual?.id);
  assert(reversal !== undefined, "and February reversed it");
  const after = linesOf(db, reversal?.id ?? "");
  assertEqual(after.length, before.length, "line for line");
  for (const line of before) {
    const mirror = after.find((l) => l.accountNumber === line.accountNumber);
    assert(mirror !== undefined, `account ${line.accountNumber} was reversed`);
    assertEqual(mirror?.amountCents, -line.amountCents, "with the opposite sign");
    assertEqual(mirror?.categoryId ?? null, line.categoryId ?? null, "same category");
  }
  assertEqual(
    netIncome(db) - incomeAfterJanuary,
    ACCRUAL,
    "so February opens with the accrual handed back",
  );
  assertEqual(balanceOf(db, "6100"), RENT, "only the recurring rent is left in January");
  assertEqual(books(db), BigInt(0), "and the books still foot");
});

test("per pipeline, February runs the whole module again on its own numbers", async () => {
  const db = januaryBatch();
  await runPeriod(db, "2026-01-01");
  const januaryEntries = db.all("journal_entries").length;
  await runPeriod(db, "2026-02-01");

  assertEqual(books(db), BigInt(0), "the books foot");
  // February has no loan payment on the register and no second accrual template
  // to post twice, so it adds the reversal, the rent, the prepaid month, and
  // the depreciation month.
  assertEqual(
    db.all("journal_entries").length,
    januaryEntries + 4,
    "four new entries in February",
  );
  assertEqual(balanceOf(db, "6700"), DEPRECIATION * BigInt(2), "two months of depreciation");
  assertEqual(balanceOf(db, "6100"), RENT * BigInt(2), "two months of rent and no accrual");
  assert(
    balanceOf(db, "6200") > PREPAID_JANUARY,
    "and a second month of the prepaid",
  );
});
