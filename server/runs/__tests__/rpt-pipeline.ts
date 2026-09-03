/**
 * Module 8 pipeline. Close the period, build the package, flag the variances,
 * rebuild the forecast, compose the narrative, and check that the narrative
 * describes what the other three found.
 *
 * The single assertion worth the whole file is the last one. A narrative that
 * named some of the failures and some of the variances would be worse than no
 * narrative at all, because a reader would believe they had seen the list. So
 * this test seeds several of each and demands every one of them by name.
 */

import { assert, assertEqual, test } from "./harness";
import { CLIENT_A1, FIRM_A } from "./fixtures";
import { PERIOD, PERIOD_END, addAccount, gateResult, seedEntry } from "./close-fixtures";
import {
  applyReport,
  budget,
  forecastsOf,
  lockPeriod,
  narrativeText,
  narrativesOf,
  packagesOf,
  payroll,
  previewReport,
  reportDb,
  reportScope,
  sectionsOf,
  variancesOf,
  weeksOf,
} from "./rpt-fixtures";
import { rptBuildPackage } from "../runs/rpt-build-package";
import { rptFlagVariances } from "../runs/rpt-flag-variances";
import { rptRebuildForecast } from "../runs/rpt-rebuild-forecast";
import { rptComposeNarrative } from "../runs/rpt-compose-narrative";
import { REPORTING_ORDER, lookupRun } from "../registry";

const basis = { ...reportScope(), comparisonBasis: "prior_period" as const };
const scenario = { ...reportScope(), scenario: "base" as const };
const audience = {
  ...reportScope(),
  audience: "owner" as const,
  maxSentencesPerSection: 5,
};

/**
 * A period that closed badly, on purpose.
 *
 * Two failed gates, three accounts over threshold in two different directions,
 * one account with no budget at all, and a payroll big enough to put the cash
 * forecast under water. Every one of those has to reach the narrative.
 */
function troubledDb() {
  const db = reportDb();
  addAccount(db, "6200", "Contract labour");
  addAccount(db, "6300", "Software");
  addAccount(db, "6400", "Travel");
  seedEntry(db, "JE-LABOUR", "2026-01-21", [
    ["6200", BigInt(220000)],
    ["1010", BigInt(-220000)],
  ]);
  seedEntry(db, "JE-SOFTWARE", "2026-01-22", [
    ["6300", BigInt(15000)],
    ["1010", BigInt(-15000)],
  ]);
  seedEntry(db, "JE-TRAVEL", "2026-01-23", [
    ["6400", BigInt(140000)],
    ["1010", BigInt(-140000)],
  ]);
  db.seed("budgets", [
    budget("BUD-4100", "4100", BigInt(-40000)),
    budget("BUD-6100", "6100", BigInt(40000)),
    budget("BUD-6200", "6200", BigInt(60000)),
    budget("BUD-6300", "6300", BigInt(15000)),
  ]);
  db.seed("close_gate_results", [
    gateResult("GR-01", "G01", { outcome: "fail", blockingCount: 2 }),
    gateResult("GR-09", "G09", { outcome: "fail", blockingCount: 5 }),
    gateResult("GR-12", "G12", { outcome: "pass" }),
    gateResult("GR-14", "G14", { outcome: "not_applicable" }),
  ]);
  db.seed("payroll_approvals", [payroll("PAY-1", "2026-02-14", BigInt(900000))]);
  lockPeriod(db, {
    closedWithExceptions: true,
    exceptionNote: "Two gates were overridden by the partner.",
  });
  return db;
}

async function runPipeline(db: ReturnType<typeof reportDb>): Promise<void> {
  await applyReport(db, rptBuildPackage, basis);
  await applyReport(db, rptFlagVariances, reportScope());
  await applyReport(db, rptRebuildForecast, scenario);
  await applyReport(db, rptComposeNarrative, audience);
}

test("the registry knows all four reporting runs and their order", () => {
  assertEqual(REPORTING_ORDER.length, 4, "four runs in the module");
  for (const type of REPORTING_ORDER) {
    assert(lookupRun(type) !== null, `${type} is registered`);
  }
  assertEqual(
    REPORTING_ORDER[3],
    "RPT-COMPOSE-NARRATIVE",
    "the narrative is last, because it describes what the others found",
  );
});

test("the whole pipeline runs on a closed period and writes every table", async () => {
  const db = troubledDb();
  await runPipeline(db);
  assertEqual(packagesOf(db).length, 1, "one package");
  assertEqual(sectionsOf(db).length, 9, "nine sections");
  assertEqual(variancesOf(db).length, 5, "five accounts evaluated");
  assertEqual(forecastsOf(db).length, 1, "one forecast header");
  assertEqual(weeksOf(db).length, 13, "thirteen weeks");
  assertEqual(narrativesOf(db).length, 1, "one narrative");
});

test("the pipeline writes nothing to the ledger of a locked period", async () => {
  const db = troubledDb();
  const before = db.all("journal_entries").length;
  await runPipeline(db);
  assertEqual(
    db.all("journal_entries").length,
    before,
    "the ledger has exactly as many entries as it started with",
  );
  assertEqual(
    db.all("period_locks").filter((l) => l.unlockedAt !== null).length,
    0,
    "and the lock was never lifted to make room",
  );
});

test("the narrative names every gate that failed", async () => {
  const db = troubledDb();
  await runPipeline(db);
  const text = narrativeText(db);
  assert(text.includes("G01"), "the first failed gate is named");
  assert(text.includes("G09"), "the second failed gate is named");
  assert(!text.includes("G12"), "a gate that passed is not called a failure");
  assert(!text.includes("G14"), "and neither is one that was out of scope");
});

test("the narrative names every variance over the threshold", async () => {
  const db = troubledDb();
  await runPipeline(db);
  const text = narrativeText(db);
  const flagged = variancesOf(db).filter((v) => v.flagged);
  assert(flagged.length >= 3, "several accounts crossed the threshold");
  for (const row of flagged) {
    assert(
      text.includes(row.accountNumber),
      `account ${row.accountNumber} is named in the narrative`,
    );
  }
  const quiet = variancesOf(db).filter((v) => !v.flagged);
  for (const row of quiet) {
    assert(
      !text.includes(row.accountNumber),
      `account ${row.accountNumber} was inside its threshold and is not called a variance`,
    );
  }
});

test("the narrative names the close exception and the cash shortfall", async () => {
  const db = troubledDb();
  await runPipeline(db);
  const text = narrativeText(db);
  assert(
    text.includes("closed with exceptions recorded"),
    "the exception is stated up front",
  );
  assert(
    text.includes("Two gates were overridden by the partner."),
    "with the note somebody actually wrote",
  );
  assert(
    text.includes("negative closing balance in week"),
    "and the forecast shortfall is stated",
  );
  const header = forecastsOf(db)[0];
  assert(header.firstShortfallWeek !== null, "which the forecast header agrees with");
});

test("the package, the variances, and the forecast all agree on the ledger", async () => {
  const db = troubledDb();
  await runPipeline(db);
  const fingerprint = packagesOf(db)[0].ledgerFingerprint;
  assertEqual(
    forecastsOf(db)[0].ledgerFingerprint,
    fingerprint,
    "the forecast was built over the same ledger as the package",
  );
  assertEqual(
    narrativesOf(db)[0].ledgerFingerprint,
    fingerprint,
    "and so was the narrative, so the three cannot describe different books",
  );
});

test("rerunning the whole pipeline changes nothing", async () => {
  const db = troubledDb();
  await runPipeline(db);
  const before = narrativeText(db);
  for (const [run, scope] of [
    [rptBuildPackage, basis],
    [rptFlagVariances, reportScope()],
    [rptRebuildForecast, scenario],
    [rptComposeNarrative, audience],
  ] as const) {
    const again = await previewReport(db, run as never, scope as never);
    assertEqual(
      again.result.proposals.length,
      0,
      `${(run as { type: string }).type} proposes nothing on a rerun`,
    );
  }
  assertEqual(narrativeText(db), before, "and the words are unchanged");
});

test("a posting after the pipeline makes every downstream run rebuild", async () => {
  const db = troubledDb();
  await runPipeline(db);
  const before = {
    package: packagesOf(db)[0].contentChecksum,
    narrative: narrativesOf(db)[0].contentChecksum,
  };
  // A late correction, of the kind a redate into a locked period produces.
  seedEntry(db, "JE-CORRECTION", "2026-01-31", [
    ["6400", BigInt(60000)],
    ["1010", BigInt(-60000)],
  ]);
  await runPipeline(db);
  assert(
    packagesOf(db)[0].contentChecksum !== before.package,
    "the package is rebuilt rather than served stale",
  );
  assert(
    narrativesOf(db)[0].contentChecksum !== before.narrative,
    "and so is the narrative",
  );
});

test("an override anywhere in the pipeline stops that run and only that run", async () => {
  const db = troubledDb();
  await runPipeline(db);
  db.seed("cash_forecast_runs", [{ ...forecastsOf(db)[0], manualOverride: true }]);
  seedEntry(db, "JE-CORRECTION", "2026-01-31", [
    ["6400", BigInt(60000)],
    ["1010", BigInt(-60000)],
  ]);
  const forecast = await previewReport(db, rptRebuildForecast, scenario);
  assertEqual(forecast.result.proposals.length, 0, "the forecast is left alone");
  const report = await previewReport(db, rptBuildPackage, basis);
  assert(report.result.proposals.length > 0, "while the package still rebuilds");
});

test("the whole module sends nothing but audit rows", async () => {
  const db = troubledDb();
  await runPipeline(db);
  const events = db.all("report_audit_events");
  assertEqual(events.length, 2, "two events for a full pipeline");
  assertEqual(
    events
      .map((e) => e.action)
      .sort()
      .join(","),
    "narrative_available,report_available",
    "one for the package and one for the narrative, and nothing else",
  );
  for (const event of events) {
    assertEqual(event.firmId, FIRM_A, "each carries the firm");
    assertEqual(event.clientId, CLIENT_A1, "and the client");
    assert(
      !JSON.stringify(event).includes("@"),
      "and no address of any kind, because nothing is sent anywhere",
    );
  }
});

test("every report row is stamped with the period it belongs to", async () => {
  const db = troubledDb();
  await runPipeline(db);
  assertEqual(packagesOf(db)[0].periodStart, PERIOD, "the package");
  assertEqual(packagesOf(db)[0].periodEnd, PERIOD_END, "and its close date");
  assert(
    variancesOf(db).every((v) => v.periodStart === PERIOD),
    "every variance row",
  );
  assertEqual(forecastsOf(db)[0].periodStart, PERIOD, "the forecast header");
  assertEqual(narrativesOf(db)[0].periodStart, PERIOD, "and the narrative");
});

test("a second client in the same firm is untouched by the pipeline", async () => {
  const db = troubledDb();
  await runPipeline(db);
  assert(
    packagesOf(db).every((p) => p.clientId === CLIENT_A1),
    "the package belongs to one client",
  );
  assert(
    weeksOf(db).every((w) => w.clientId === CLIENT_A1),
    "and so does every forecast week",
  );
  const other = await previewReport(db, rptBuildPackage, {
    ...basis,
    clientId: "CLI-B1",
  });
  assert(
    other.scopeHash !== (await previewReport(db, rptBuildPackage, basis)).scopeHash,
    "and another client is a different scope entirely",
  );
});
