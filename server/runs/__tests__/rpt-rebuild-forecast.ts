/**
 * RPT-REBUILD-FORECAST tests.
 *
 * Two things carry most of the weight here. The forecast has to foot, week by
 * week, or it is not a forecast. And it has to be deterministic, because a
 * forecast that gives two answers for one ledger cannot be relied on by anybody
 * and would also mean something in the pipeline is learning, which the no
 * artificial intelligence constraint forbids.
 */

import { assert, assertEqual, test } from "./harness";
import { PERIOD, seedEntry } from "./close-fixtures";
import {
  FORECAST_START,
  applyReport,
  billRow,
  forecastsOf,
  invoiceRow,
  lockPeriod,
  payroll,
  previewReport,
  reportDb,
  reportScope,
  shapeOf,
  weeksOf,
} from "./rpt-fixtures";
import {
  COLLECTION_CURVE,
  curveFor,
  forecastIdOf,
  rptRebuildForecast,
  weekIdOf,
} from "../runs/rpt-rebuild-forecast";

const scope = { ...reportScope(), scenario: "base" as const };
const ZERO = BigInt(0);

test("forecast preview and apply propose the same rows", async () => {
  const db = reportDb();
  const { preview, applied } = await applyReport(db, rptRebuildForecast, scope);
  assertEqual(applied.status, "completed", "the apply completed");
  assertEqual(
    shapeOf(applied.result.proposals),
    shapeOf(preview.result.proposals),
    "apply proposed exactly what preview showed",
  );
});

test("forecast ids are derived, so a rerun is a no operation", async () => {
  const db = reportDb();
  await applyReport(db, rptRebuildForecast, scope);
  const header = forecastsOf(db)[0];
  assertEqual(
    header.id,
    forecastIdOf(PERIOD, "base"),
    "the header id is derived from the period and the scenario",
  );
  assertEqual(
    weeksOf(db)[0].id,
    weekIdOf(header.id, 1),
    "and each week id is derived from the header",
  );
  const again = await previewReport(db, rptRebuildForecast, scope);
  assertEqual(again.result.proposals.length, 0, "the second call proposes nothing");
});

test("two periods do not collide because the period is in the scope hash", async () => {
  const db = reportDb();
  const january = await previewReport(db, rptRebuildForecast, scope);
  const february = await previewReport(db, rptRebuildForecast, {
    ...scope,
    period: "2026-02-01",
  });
  assert(january.scopeHash !== february.scopeHash, "the two hashes differ");
  assert(
    forecastIdOf(PERIOD, "base") !== forecastIdOf("2026-02-01", "base"),
    "and the two forecasts are different rows",
  );
});

test("a posting changes the ledger fingerprint and so changes the scope hash", async () => {
  const db = reportDb();
  const before = await previewReport(db, rptRebuildForecast, scope);
  seedEntry(db, "JE-CASH", "2026-01-29", [
    ["1010", BigInt(25000)],
    ["4100", BigInt(-25000)],
  ]);
  const after = await previewReport(db, rptRebuildForecast, scope);
  assert(
    before.scopeHash !== after.scopeHash,
    "opening cash comes from the ledger, so a posting is a new scope",
  );
});

test("an overridden forecast is left alone, header and weeks together", async () => {
  const db = reportDb();
  await applyReport(db, rptRebuildForecast, scope);
  db.seed("cash_forecast_runs", [{ ...forecastsOf(db)[0], manualOverride: true }]);
  const again = await previewReport(db, rptRebuildForecast, scope);
  assertEqual(again.result.proposals.length, 0, "nothing is proposed");
  assertEqual(again.result.skips.length, 1, "one skip covers the whole forecast");
  assertEqual(
    again.result.skips[0].reason,
    "manual_override",
    "and it names the override",
  );
});

test("an overridden invoice is not placed in the forecast", async () => {
  const db = reportDb();
  db.seed("invoices", [{ ...invoiceRow("INV-1"), manualOverride: true }]);
  const preview = await previewReport(db, rptRebuildForecast, scope);
  assert(
    preview.result.skips.some(
      (s) => s.rowId === "INV-1" && s.reason === "manual_override",
    ),
    "the run says it left the overridden invoice out",
  );
});

test("a locked period is read, never written", async () => {
  const db = reportDb();
  lockPeriod(db);
  const { applied } = await applyReport(db, rptRebuildForecast, scope);
  assertEqual(applied.status, "completed", "the run completes on a locked period");
  assertEqual(db.all("journal_entries").length, 2, "and writes nothing to the ledger");
  assertEqual(weeksOf(db).length, 13, "while still writing thirteen weeks");
});

test("the forecast is thirteen weeks starting the day after the period end", async () => {
  const db = reportDb();
  await applyReport(db, rptRebuildForecast, scope);
  const weeks = weeksOf(db);
  assertEqual(weeks.length, 13, "thirteen weeks");
  assertEqual(weeks[0].weekStart, FORECAST_START, "beginning the day after close");
  assertEqual(weeks[0].weekNumber, 1, "numbered from one");
  assertEqual(weeks[12].weekNumber, 13, "through thirteen");
  assertEqual(
    forecastsOf(db)[0].horizonWeeks,
    13,
    "and the header says thirteen weeks",
  );
});

test("every week foots and each opens where the last one closed", async () => {
  const db = reportDb();
  await applyReport(db, rptRebuildForecast, scope);
  const weeks = weeksOf(db);
  for (const w of weeks) {
    assertEqual(
      w.closingCents,
      w.openingCents + w.inflowCents - w.outflowCents,
      `week ${w.weekNumber} closes at opening plus inflow less outflow`,
    );
    assertEqual(
      w.outflowCents,
      w.apOutflowCents + w.recurringOutflowCents + w.loanOutflowCents + w.payrollOutflowCents,
      `week ${w.weekNumber} outflow is the sum of its parts`,
    );
  }
  for (let at = 1; at < weeks.length; at += 1) {
    assertEqual(
      weeks[at].openingCents,
      weeks[at - 1].closingCents,
      `week ${weeks[at].weekNumber} opens where week ${weeks[at - 1].weekNumber} closed`,
    );
  }
  const header = forecastsOf(db)[0];
  assertEqual(
    header.closingCashCents,
    weeks[12].closingCents,
    "and the header closing figure is week thirteen",
  );
});

test("the collection curve is a stated table and nothing fits it", async () => {
  assertEqual(COLLECTION_CURVE.length, 5, "five buckets, written down in the file");
  assertEqual(
    curveFor(0).bucket,
    "current",
    "an invoice not yet due reads the current row",
  );
  assertEqual(curveFor(45).bucket, "31_60", "a forty five day late invoice reads its own row");
  assertEqual(curveFor(200).bucket, "over_90", "and anything older reads the last row");
  const db = reportDb();
  await applyReport(db, rptRebuildForecast, scope);
  assertEqual(
    forecastsOf(db)[0].useHistory,
    false,
    "the header states that no fitted history was used",
  );
});

test("a receivable is spread by the curve rather than landing whole", async () => {
  const db = reportDb();
  await applyReport(db, rptRebuildForecast, scope);
  const weeks = weeksOf(db).filter((w) => w.arInflowCents !== ZERO);
  assert(weeks.length > 1, "a hundred and twenty thousand cent invoice lands over several weeks");
  const total = weeks.reduce((sum, w) => sum + w.arInflowCents, ZERO);
  assertEqual(
    total,
    BigInt(120000),
    "a current invoice is expected in full, spread across three weeks",
  );

  const late = reportDb();
  late.seed("invoices", [invoiceRow("INV-1", { dueDate: "2025-10-10" })]);
  await applyReport(late, rptRebuildForecast, scope);
  const lateTotal = weeksOf(late)
    .filter((w) => w.arInflowCents !== ZERO)
    .reduce((sum, w) => sum + w.arInflowCents, ZERO);
  assert(
    lateTotal < BigInt(120000),
    "an invoice over ninety days late places less than its balance, because not all of it is coming",
  );
  assert(lateTotal > ZERO, "though the curve does not write it off either");
});

test("a bill pays on its due date unless a discount closes earlier", async () => {
  const plain = reportDb();
  await applyReport(plain, rptRebuildForecast, scope);
  const plainWeek = weeksOf(plain).find((w) => w.apOutflowCents !== ZERO);
  assertEqual(plainWeek?.weekStart, "2026-02-15", "a bill due the nineteenth pays that week");

  const discounted = reportDb();
  discounted.seed("bills", [
    billRow("BILL-1", { discountBps: 200, discountDays: 10 }),
  ]);
  await applyReport(discounted, rptRebuildForecast, scope);
  const discountWeek = weeksOf(discounted).find((w) => w.apOutflowCents !== ZERO);
  assertEqual(
    discountWeek?.weekStart,
    FORECAST_START,
    "and a ten day discount on a bill dated the twentieth pays in the first week instead",
  );
});

test("a disputed invoice and a bill on hold are reported, never guessed at", async () => {
  const db = reportDb();
  db.seed("invoices", [invoiceRow("INV-1", { inDispute: true })]);
  db.seed("bills", [billRow("BILL-1", { onHold: true })]);
  const preview = await previewReport(db, rptRebuildForecast, scope);
  const reasons = preview.result.skips
    .filter((s) => s.rowId === "INV-1" || s.rowId === "BILL-1")
    .map((s) => s.reason);
  assertEqual(reasons.length, 2, "both are reported");
  assert(
    reasons.every((r) => r === "ambiguous_candidate"),
    "as candidates with no defensible date, rather than placed on a guess",
  );
});

test("only approved payroll is a committed outflow", async () => {
  const approved = reportDb();
  await applyReport(approved, rptRebuildForecast, scope);
  const paidWeek = weeksOf(approved).find((w) => w.payrollOutflowCents !== ZERO);
  assertEqual(paidWeek?.payrollOutflowCents, BigInt(30000), "the approved run is placed");

  const draft = reportDb();
  draft.seed("payroll_approvals", [
    payroll("PAY-1", "2026-02-14", BigInt(30000), { status: "draft" }),
  ]);
  const preview = await previewReport(draft, rptRebuildForecast, scope);
  assert(
    preview.result.skips.some(
      (s) => s.rowId === "PAY-1" && s.reason === "missing_prerequisite",
    ),
    "and a draft payroll is not a commitment",
  );
});

test("a week closing below zero is named on the header", async () => {
  const db = reportDb();
  db.seed("payroll_approvals", [
    payroll("PAY-1", "2026-02-14", BigInt(900000)),
  ]);
  await applyReport(db, rptRebuildForecast, scope);
  const header = forecastsOf(db)[0];
  assert(header.firstShortfallWeek !== null, "the header names the first short week");
  const week = weeksOf(db).find((w) => w.weekNumber === header.firstShortfallWeek);
  assert((week?.closingCents ?? ZERO) < ZERO, "and that week really does close below zero");
  assertEqual(week?.shortfall, true, "the week row says so itself");
});

test("a scenario states its parameters and changes the answer", async () => {
  const base = reportDb();
  await applyReport(base, rptRebuildForecast, scope);
  const slow = reportDb();
  await applyReport(slow, rptRebuildForecast, { ...scope, scenario: "slow_collections" as const });
  const baseHeader = forecastsOf(base)[0];
  const slowHeader = forecastsOf(slow)[0];
  assertEqual(baseHeader.slowShiftDays, 0, "the base scenario shifts nothing");
  assertEqual(slowHeader.slowShiftDays, 30, "and the slow scenario states thirty days");
  assert(
    slowHeader.scenario !== baseHeader.scenario,
    "the two headers are different scenarios",
  );
  assert(
    forecastIdOf(PERIOD, "base") !== forecastIdOf(PERIOD, "slow_collections"),
    "and they are separate rows, so one never overwrites the other",
  );
});
