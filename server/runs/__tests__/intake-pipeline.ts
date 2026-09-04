/**
 * The module 1 pipeline.
 *
 * The four setup runs against one fresh client, in INTAKE_ORDER, the way the
 * wizard controller finishes. The assertion at the end is the one the brief
 * asks for: the client is fully set up. A chart is present, the workload is
 * scheduled, the opening asks are raised, and the opening balance entry foots.
 *
 * The second half runs the whole pipeline again on the same client. That is the
 * property that makes a Finish button safe to press twice by somebody who lost
 * the tab and was not sure the first press landed. The books have to be
 * identical afterwards, and the pipeline has to report that there was nothing
 * to do rather than failing.
 */

import { assert, assertEqual, test } from "./harness";
import type { MemoryRunDb } from "../db-memory";
import { execute } from "../execute";
import type { Proposal, Run } from "../contract";
import { INTAKE_ORDER } from "../registry";
import {
  CUTOVER,
  PERIOD,
  PERIOD_END,
  STANDARD_SUBJECT_KEYS,
  accountNumbersOf,
  accountsOf,
  balanceOf,
  catalogOf,
  categoriesOf,
  entriesOf,
  footingOf,
  intakeDb,
  intakeOpts,
  linesOf,
  openingBalancesOf,
  requestsOf,
  tasksOf,
} from "./intake-fixtures";
import { intakeBuildChart } from "../runs/intake-build-chart";
import { intakeSeedTasks } from "../runs/intake-seed-tasks";
import { intakeOpenRequests } from "../runs/intake-open-requests";
import { setupImportBalances } from "../runs/setup-import-balances";
import { OPENING_BALANCE_EQUITY_ACCOUNT } from "../runs/intake-shared";
import { INTAKE_CLIENT } from "./intake-fixtures";

/** Northgate Mechanical's opening trial balance at its 2026-07-01 cutover. */
const OPENING: ReadonlyArray<readonly [string, bigint]> = [
  ["1000", BigInt(1240000)],
  ["1100", BigInt(315000)],
  ["1300", BigInt(90000)],
  ["2000", BigInt(-227500)],
  ["2100", BigInt(-110000)],
];

interface PipelineOutcome {
  /** The run types that actually applied, in the order they applied. */
  order: string[];
  /** Every error code any step reported. Empty is the happy path. */
  errors: string[];
  /** How many proposals the whole pipeline made. Zero on a second press. */
  proposed: number;
}

/**
 * One wizard finish. Preview then apply, in published order, stopping at the
 * first run that reports an error rather than pressing on into a client whose
 * chart never landed.
 */
async function runIntake(
  db: MemoryRunDb,
  balanceLines: ReadonlyArray<readonly [string, bigint]> = OPENING,
): Promise<PipelineOutcome> {
  const order: string[] = [];
  const errors: string[] = [];
  let proposed = 0;

  const step = async <S>(run: Run<S, Proposal>, scope: S): Promise<void> => {
    if (errors.length > 0) return;
    const preview = await execute<S, Proposal>(db, run, scope, intakeOpts("preview"));
    proposed += preview.result.proposals.length;
    for (const e of preview.result.errors) errors.push(e.code);
    if (preview.result.errors.length > 0) return;
    await execute<S, Proposal>(
      db,
      run,
      scope,
      intakeOpts("apply", { previewRunId: preview.executionId }),
    );
    order.push(run.type);
  };

  await step(intakeBuildChart, {
    clientId: INTAKE_CLIENT,
    period: PERIOD,
    industry: "services",
    scopeKeys: ["fixed_assets"],
    excludeAccountNumbers: [],
    addAccounts: [],
  });
  await step(intakeSeedTasks, {
    clientId: INTAKE_CLIENT,
    period: PERIOD,
    scopeKeys: ["fixed_assets"],
    excludeCatalogCodes: [],
  });
  await step(intakeOpenRequests, {
    clientId: INTAKE_CLIENT,
    period: PERIOD,
    openedOn: CUTOVER,
    scopeKeys: ["fixed_assets"],
    excludeSubjectKeys: [],
  });
  await step(setupImportBalances, {
    clientId: INTAKE_CLIENT,
    period: PERIOD,
    cutoverDate: CUTOVER,
    lines: balanceLines.map(([accountNumber, amountCents]) => ({
      accountNumber,
      amountCents: amountCents.toString(),
    })),
    sourceKind: "wizard_trial_balance",
  });

  return { order, errors, proposed };
}

test("intake pipeline, the four runs execute in the published order", async () => {
  const db = intakeDb();
  const outcome = await runIntake(db);
  assertEqual(outcome.errors.length, 0, "no run reported an error");
  assertEqual(outcome.order.join(" "), INTAKE_ORDER.join(" "), "and they ran in INTAKE_ORDER");
  assertEqual(INTAKE_ORDER.length, 4, "the published order is the four setup runs");
});

test("intake pipeline, the client ends up fully set up", async () => {
  const db = intakeDb();
  await runIntake(db);

  // One. A chart is present.
  const accounts = accountsOf(db);
  assert(accounts.length > 40, "the chart of accounts is present");
  const numbers = new Set(accountNumbersOf(db));
  assert(numbers.has("1990"), "including the suspense account every later run needs");
  assert(numbers.has(OPENING_BALANCE_EQUITY_ACCOUNT), "and opening balance equity");
  assert(categoriesOf(db).length > 10, "the category spine is present");

  // Two. The workload is scheduled.
  assert(catalogOf(db).length > 5, "the task catalog is present");
  const tasks = tasksOf(db);
  assert(tasks.length > 0, "the first period is scheduled");
  assert(
    tasks.every((t) => t.periodStart === PERIOD && t.periodEnd === PERIOD_END),
    "against the first period and no other",
  );

  // Three. The opening asks are raised.
  const requests = requestsOf(db);
  assertEqual(requests.length, STANDARD_SUBJECT_KEYS.length, "all six asks are on record");
  assert(
    requests.every((r) => r.status === "open"),
    "and every one is open",
  );

  // Four. The opening balance entry foots.
  assertEqual(entriesOf(db).length, 1, "exactly one opening entry");
  assertEqual(footingOf(db), BigInt(0), "and it foots to zero cents");
  assertEqual(linesOf(db).length, OPENING.length + 1, "one line per account plus the offset");
  assertEqual(
    openingBalancesOf(db).length,
    OPENING.length + 1,
    "with an opening balance row for each",
  );
});

test("intake pipeline, the opening entry offsets to opening balance equity", async () => {
  const db = intakeDb();
  await runIntake(db);
  let supplied = BigInt(0);
  for (const [, cents] of OPENING) supplied += cents;
  assertEqual(
    balanceOf(db, OPENING_BALANCE_EQUITY_ACCOUNT),
    -supplied,
    "3900 carries the whole difference and no account was plugged",
  );
  for (const [accountNumber, cents] of OPENING) {
    assertEqual(balanceOf(db, accountNumber), cents, `${accountNumber} posted as supplied`);
  }
});

test("intake pipeline, every posted line points at an account on the chart", async () => {
  const db = intakeDb();
  await runIntake(db);
  const numbers = new Set(accountNumbersOf(db));
  for (const line of linesOf(db)) {
    assert(numbers.has(line.accountNumber), `${line.accountNumber} is on the chart`);
  }
});

test("intake pipeline, every task points at a catalog row that was seeded", async () => {
  const db = intakeDb();
  await runIntake(db);
  const codes = new Set(catalogOf(db).map((c) => c.catalogCode));
  for (const task of tasksOf(db)) {
    assert(codes.has(task.catalogCode), `${task.catalogCode} is on the catalog`);
  }
});

test("intake pipeline, pressing finish twice leaves the books identical", async () => {
  const db = intakeDb();
  await runIntake(db);
  const before = {
    accounts: accountsOf(db).length,
    categories: categoriesOf(db).length,
    catalog: catalogOf(db).length,
    tasks: tasksOf(db).length,
    requests: requestsOf(db).length,
    entries: entriesOf(db).length,
    lines: linesOf(db).length,
    balances: openingBalancesOf(db).length,
    footing: footingOf(db),
  };

  const second = await runIntake(db);
  assertEqual(second.errors.length, 0, "the second pass reported no error");
  assertEqual(second.proposed, 0, "and proposed nothing at all, because nothing was missing");

  assertEqual(accountsOf(db).length, before.accounts, "the chart did not grow");
  assertEqual(categoriesOf(db).length, before.categories, "nor the categories");
  assertEqual(catalogOf(db).length, before.catalog, "nor the catalog");
  assertEqual(tasksOf(db).length, before.tasks, "nor the workload");
  assertEqual(requestsOf(db).length, before.requests, "nor the open asks");
  assertEqual(entriesOf(db).length, before.entries, "and the books were not doubled");
  assertEqual(linesOf(db).length, before.lines, "line for line");
  assertEqual(openingBalancesOf(db).length, before.balances, "nor the opening balance rows");
  assertEqual(footingOf(db), before.footing, "and the books still foot");
});

test("intake pipeline, a trial balance that disagrees stops at the last step", async () => {
  const db = intakeDb();
  const outcome = await runIntake(db, [
    ...OPENING,
    // The equity figure the firm typed does not agree with its own accounts.
    [OPENING_BALANCE_EQUITY_ACCOUNT, BigInt(-100)],
  ]);

  assertEqual(
    outcome.errors.join(","),
    "OPENING_EQUITY_DISAGREES",
    "the run that refuses to plug is the one that stopped",
  );
  assertEqual(entriesOf(db).length, 0, "no entry was posted");
  assertEqual(openingBalancesOf(db).length, 0, "and no opening balance row either");

  // This is the reason opening balances go last in INTAKE_ORDER. A finish that
  // fails on the trial balance still leaves the firm a client it can work with,
  // and the firm can fix the numbers and press Finish again.
  assert(accountsOf(db).length > 40, "the chart still landed");
  assert(catalogOf(db).length > 5, "the catalog still landed");
  assertEqual(requestsOf(db).length, STANDARD_SUBJECT_KEYS.length, "and the asks are raised");
  assertEqual(
    outcome.order.join(" "),
    INTAKE_ORDER.slice(0, 3).join(" "),
    "three of the four applied",
  );
});

test("intake pipeline, fixing the trial balance and finishing again completes the client", async () => {
  const db = intakeDb();
  await runIntake(db, [...OPENING, [OPENING_BALANCE_EQUITY_ACCOUNT, BigInt(-100)]]);
  assertEqual(entriesOf(db).length, 0, "the first attempt posted nothing");

  const second = await runIntake(db);
  assertEqual(second.errors.length, 0, "the corrected numbers were accepted");
  assertEqual(
    second.order.join(" "),
    INTAKE_ORDER.join(" "),
    "all four ran again, because a run with nothing to do is not a failure",
  );
  assertEqual(
    second.proposed,
    OPENING.length + 2,
    "and only the step that had failed proposed anything: one line per account, the equity offset, and the entry itself",
  );
  assertEqual(entriesOf(db).length, 1, "the opening entry posted");
  assertEqual(footingOf(db), BigInt(0), "and the books foot");
});

test("intake pipeline, module 1 writes to seven record tables and no delivery table", async () => {
  const db = intakeDb();
  await runIntake(db);
  const written = [
    "chart_accounts",
    "categories",
    "practice_task_catalog",
    "practice_tasks",
    "document_requests",
    "opening_balances",
    "journal_entries",
    "journal_lines",
  ];
  for (const table of written) {
    assert(
      db.all(table as "chart_accounts").length > 0,
      `${table} has rows, so it is one of the tables module 1 owns`,
    );
  }
  // No request carries an address or a delivery stamp, because nothing in this
  // build sends anything to anybody.
  for (const r of requestsOf(db)) {
    const keys = Object.keys(r).map((k) => k.toLowerCase());
    for (const forbidden of ["email", "recipient", "sentat", "deliveredat", "queuedat"]) {
      assert(!keys.includes(forbidden), `no ${forbidden} column exists on a request`);
    }
  }
});
