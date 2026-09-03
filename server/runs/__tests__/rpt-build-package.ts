/**
 * RPT-BUILD-PACKAGE tests.
 *
 * The package is a snapshot, so most of what these tests assert is that the same
 * ledger produces the same snapshot and a different ledger produces a different
 * one. The rest assert the things a person would be hurt by if they were wrong:
 * a statement that omits an account, a package that says accrual when the reader
 * assumed cash, a draft that does not say it is a draft.
 */

import { assert, assertEqual, test } from "./harness";
import { CLIENT_A1 } from "./fixtures";
import { PERIOD, PERIOD_END, addAccount, seedEntry } from "./close-fixtures";
import {
  applyReport,
  lockPeriod,
  packagesOf,
  previewReport,
  reportDb,
  reportScope,
  sectionsOf,
  shapeOf,
} from "./rpt-fixtures";
import {
  packageIdOf,
  rptBuildPackage,
  sectionIdOf,
} from "../runs/rpt-build-package";

const scope = { ...reportScope(), comparisonBasis: "prior_period" as const };

test("package preview and apply propose the same rows", async () => {
  const db = reportDb();
  const { preview, applied } = await applyReport(db, rptBuildPackage, scope);
  assertEqual(applied.status, "completed", "the apply completed");
  assertEqual(
    shapeOf(applied.result.proposals),
    shapeOf(preview.result.proposals),
    "apply proposed exactly what preview showed",
  );
});

test("package writes one header and nine sections", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, scope);
  const packages = packagesOf(db);
  assertEqual(packages.length, 1, "one package header");
  assertEqual(packages[0].sectionCount, 9, "nine sections counted on the header");
  const sections = sectionsOf(db);
  assertEqual(sections.length, 9, "nine section rows written");
  assertEqual(
    sections.map((s) => s.sectionCode).join(","),
    "COVER,BALANCE_SHEET,INCOME_STATEMENT,CASH_FLOW,STATEMENT_OF_EQUITY,AR_AGING,AP_AGING,NOTES,CHANGE_LOG",
    "the sections come out in reading order",
  );
});

test("package ids are derived, so a rerun is a no operation", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, scope);
  const first = packagesOf(db)[0];
  const second = await previewReport(db, rptBuildPackage, scope);
  assertEqual(
    second.result.proposals.length,
    0,
    "the second call proposes nothing",
  );
  assert(
    second.result.skips.every((s) => s.reason === "already_applied"),
    "and says the package is already applied",
  );
  assertEqual(
    first.id,
    packageIdOf(PERIOD, "prior_period"),
    "the id is derived from the period and the comparison basis",
  );
});

test("two periods do not collide because the period is in the scope hash", async () => {
  const db = reportDb();
  const first = await previewReport(db, rptBuildPackage, scope);
  const second = await previewReport(db, rptBuildPackage, {
    ...scope,
    period: "2026-02-01",
  });
  assert(
    first.scopeHash !== second.scopeHash,
    "January and February hash differently",
  );
  assert(
    packageIdOf(PERIOD, "prior_period") !== packageIdOf("2026-02-01", "prior_period"),
    "and the two packages are different rows",
  );
});

test("a posting changes the ledger fingerprint and so changes the scope hash", async () => {
  const db = reportDb();
  const before = await previewReport(db, rptBuildPackage, scope);
  seedEntry(db, "JE-LATE", "2026-01-28", [
    ["1010", BigInt(5000)],
    ["4100", BigInt(-5000)],
  ]);
  const after = await previewReport(db, rptBuildPackage, scope);
  assert(
    before.scopeHash !== after.scopeHash,
    "a posting inside the period is a new scope, so a rebuild is not a stale hit",
  );
});

test("a posting after a build produces a fresh package rather than a stale one", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, scope);
  const firstChecksum = packagesOf(db)[0].contentChecksum;
  seedEntry(db, "JE-LATE", "2026-01-28", [
    ["1010", BigInt(5000)],
    ["4100", BigInt(-5000)],
  ]);
  await applyReport(db, rptBuildPackage, scope);
  const rebuilt = packagesOf(db)[0];
  assert(
    rebuilt.contentChecksum !== firstChecksum,
    "the rebuilt package has a different checksum",
  );
  assertEqual(packagesOf(db).length, 1, "and it is the same row, not a second one");
});

test("an overridden package is not touched, and neither are its sections", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, scope);
  const packageId = packageIdOf(PERIOD, "prior_period");
  db.seed("report_packages", [
    { ...packagesOf(db)[0], manualOverride: true, sectionCount: 2 },
  ]);
  const again = await previewReport(db, rptBuildPackage, scope);
  assertEqual(again.result.proposals.length, 0, "nothing is proposed");
  assertEqual(
    again.result.skips.length,
    10,
    "the header and all nine sections are skipped",
  );
  assert(
    again.result.skips.every((s) => s.reason === "manual_override"),
    "every skip names the override",
  );
  assertEqual(
    again.result.skips[0].rowId,
    packageId,
    "and the first skip is the header itself",
  );
});

test("an overridden section is left alone while the rest rebuild", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, scope);
  const packageId = packageIdOf(PERIOD, "prior_period");
  const notesId = sectionIdOf(packageId, "NOTES");
  db.seed(
    "report_sections",
    sectionsOf(db).map((s) =>
      s.id === notesId ? { ...s, manualOverride: true, lines: [] } : s,
    ),
  );
  seedEntry(db, "JE-LATE", "2026-01-28", [
    ["1010", BigInt(5000)],
    ["4100", BigInt(-5000)],
  ]);
  const again = await previewReport(db, rptBuildPackage, scope);
  assert(
    again.result.skips.some(
      (s) => s.rowId === notesId && s.reason === "manual_override",
    ),
    "the overridden section is skipped",
  );
  assert(
    again.result.proposals.some((p) => "rowId" in p && p.rowId !== notesId),
    "and the other sections still rebuild",
  );
});

test("a locked period is read, never written", async () => {
  const db = reportDb();
  lockPeriod(db);
  const { applied } = await applyReport(db, rptBuildPackage, scope);
  assertEqual(applied.status, "completed", "the run completes on a locked period");
  assert(
    applied.result.proposals.every(
      (p) => p.kind === "row_insert" || p.kind === "field_write",
    ),
    "and proposes no journal entry against the locked ledger",
  );
  assertEqual(db.all("journal_entries").length, 2, "the ledger is untouched");
});

test("an open period is watermarked and a closed one is not", async () => {
  const open = reportDb();
  await applyReport(open, rptBuildPackage, scope);
  assertEqual(
    packagesOf(open)[0].watermark,
    "DRAFT. Period not closed.",
    "an open period says so on every page",
  );
  const closed = reportDb();
  lockPeriod(closed);
  await applyReport(closed, rptBuildPackage, scope);
  assertEqual(
    packagesOf(closed)[0].watermark,
    null,
    "a closed period carries no draft watermark",
  );
});

test("the package states the basis of accounting in words", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, scope);
  assertEqual(packagesOf(db)[0].basis, "accrual", "the header says accrual");
  const cover = sectionsOf(db).find((s) => s.sectionCode === "COVER");
  assert(cover !== undefined, "there is a cover");
  assert(
    (cover?.lines ?? []).some((l) => l.note?.includes("Accrual basis")),
    "and the cover states the basis in words, per decision D3",
  );
});

test("the balance sheet carries the cash balance and the income statement does not", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, scope);
  const balanceSheet = sectionsOf(db).find((s) => s.sectionCode === "BALANCE_SHEET");
  const incomeStatement = sectionsOf(db).find(
    (s) => s.sectionCode === "INCOME_STATEMENT",
  );
  assert(
    (balanceSheet?.lines ?? []).some((l) => l.accountNumber === "1010"),
    "cash is on the balance sheet",
  );
  assert(
    !(incomeStatement?.lines ?? []).some((l) => l.accountNumber === "1010"),
    "and not on the income statement",
  );
  assert(
    (incomeStatement?.lines ?? []).some((l) => l.accountNumber === "4100"),
    "revenue is on the income statement",
  );
});

test("a memo account is kept out of every published statement", async () => {
  const db = reportDb();
  addAccount(db, "9100", "Memo only");
  seedEntry(db, "JE-MEMO", "2026-01-22", [
    ["9100", BigInt(7000)],
    ["9200", BigInt(-7000)],
  ]);
  addAccount(db, "9200", "Memo contra");
  await applyReport(db, rptBuildPackage, scope);
  const published = sectionsOf(db).filter((s) =>
    ["BALANCE_SHEET", "INCOME_STATEMENT", "STATEMENT_OF_EQUITY"].includes(
      s.sectionCode,
    ),
  );
  assert(
    published.every(
      (s) => !s.lines.some((l) => (l.accountNumber ?? "").startsWith("9")),
    ),
    "the nine thousand block is outside published statements, per doc 00 Part 3",
  );
});

test("the vault attachment carries seven year governance retention from the period end", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, scope);
  const row = packagesOf(db)[0];
  assertEqual(
    row.vaultObjectLockMode,
    "GOVERNANCE",
    "the object lock mode is governance, per decision D7",
  );
  assertEqual(
    row.vaultRetentionStartsOn,
    PERIOD_END,
    "retention starts at the period end, not at the build date",
  );
  assertEqual(
    row.vaultObjectLockUntil,
    "2033-01-31",
    "and runs seven years from there",
  );
});

test("the only delivery is an audit row, written once", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, scope);
  const events = db.all("report_audit_events");
  assertEqual(events.length, 1, "one audit event");
  assertEqual(events[0].action, "report_available", "and it is report_available");
  assertEqual(
    events[0].clientId,
    CLIENT_A1,
    "carrying the client it belongs to and no address of any kind",
  );
  await applyReport(db, rptBuildPackage, scope);
  assertEqual(
    db.all("report_audit_events").length,
    1,
    "a second build does not announce the package twice",
  );
});

test("the change log lists applied runs and never the reporting run itself", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, scope);
  const changeLog = sectionsOf(db).find((s) => s.sectionCode === "CHANGE_LOG");
  assert(changeLog !== undefined, "there is a change log");
  assert(
    !(changeLog?.lines ?? []).some((l) => l.label.startsWith("RPT-")),
    "a package does not describe the run that built it",
  );
});
