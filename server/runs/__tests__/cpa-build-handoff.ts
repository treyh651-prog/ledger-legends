/**
 * CPA-BUILD-HANDOFF tests.
 *
 * Ledger Legends is not a CPA firm. This run compiles data. It does not file,
 * issue, submit, or transmit any tax document. The compiled data set is
 * provided to the client's CPA for filing.
 *
 * The run builds an archive. It never issues and never files, so the tests here
 * are about what the archive contains, that the ledger fingerprint is inside
 * the scope hash so a late posting produces a new archive rather than a stale
 * dedupe hit, and that a locked period is a fine thing to read from.
 */

import { assert, assertEqual, test } from "./harness";
import { isRowInsert } from "../contract";
import {
  ACTOR,
  CLIENT_A1,
  FIRM_A,
  applyDlv,
  archiveDb,
  handoffsOf,
  lockJanuary,
  previewDlv,
  shapeOf,
} from "./dlv-fixtures";
import { PERIOD, PERIOD_END, request, seedEntry } from "./close-fixtures";
import type { MemoryRunDb } from "../db-memory";
import {
  SCOPE_STATEMENT,
  artifactCatalog,
  cpaBuildHandoff,
  handoffIdOf,
  openItemsOf,
  rangeFor,
} from "../runs/cpa-build-handoff";
import { dataSetIdOf } from "../runs/tax-build-1099";
import { COMPILATION_ONLY_BANNER } from "../runs/tax-shared";

const DECEMBER = "2026-12-01";

function handoffScope(extra: Partial<{ period: string; scopeKind: "period" | "fiscal_year" }> = {}) {
  return { clientId: CLIENT_A1, period: PERIOD, scopeKind: "period" as const, ...extra };
}

/** A compiled 1099 data set for the year, so the year end path has one to find. */
function seedDataSet(db: MemoryRunDb, taxYear = 2026, extra: Record<string, unknown> = {}): void {
  db.seed("tax_data_sets", [
    {
      id: dataSetIdOf(CLIENT_A1, taxYear),
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      version: 1,
      taxYear,
      periodStart: `${taxYear}-01-01`,
      periodEnd: `${taxYear}-12-31`,
      thresholdCents: BigInt(200000),
      thresholdEffectiveFrom: "2026-01-01",
      thresholdEffectiveTo: null,
      payeeCount: 9,
      reportableCount: 4,
      approachingCount: 1,
      excludedCount: 3,
      backupWithholdingCount: 1,
      reportableTotalCents: BigInt(1090000),
      excludedCardTotalCents: BigInt(400000),
      state: "compiled",
      compilationOnly: true,
      handoffStatement: COMPILATION_ONLY_BANNER,
      contentChecksum: "seeded",
      ledgerFingerprint: "seeded",
      vaultObjectKey: `clients/${CLIENT_A1}/tax/${taxYear}/1099-data-set.zip`,
      vaultObjectLockMode: "GOVERNANCE",
      vaultRetentionStartsOn: `${taxYear}-12-31`,
      vaultObjectLockUntil: `${taxYear + 7}-12-31`,
      builtByRunId: null,
      builtAt: "2027-01-05T00:00:00.000Z",
      manualOverride: false,
      ...extra,
    },
  ]);
}

test("preview and apply propose the same rows", async () => {
  const db = archiveDb();
  const { preview, applied } = await applyDlv(db, cpaBuildHandoff, handoffScope());
  assertEqual(
    shapeOf(preview.result?.proposals ?? []),
    shapeOf(applied.result?.proposals ?? []),
    "the archive is the same on both passes",
  );
  assertEqual(handoffsOf(db).length, 1, "one handoff row landed");
  assertEqual(handoffsOf(db)[0].status, "complete", "at status complete");
});

test("ids are derived from the client, the range start, and the kind", async () => {
  const db = archiveDb();
  await applyDlv(db, cpaBuildHandoff, handoffScope());
  assertEqual(
    handoffsOf(db)[0].id,
    handoffIdOf(CLIENT_A1, PERIOD, "period"),
    "the row sits at its derived id",
  );
  assert(
    handoffIdOf(CLIENT_A1, PERIOD, "period") !==
      handoffIdOf(CLIENT_A1, "2026-01-01", "fiscal_year"),
    "a month archive and a year archive are two different rows",
  );
  const again = await previewDlv(db, cpaBuildHandoff, handoffScope());
  assert(
    (again.result?.skips ?? []).some((s) => s.detail.includes("handoff_unchanged")),
    "and an unchanged rebuild proposes nothing",
  );
});

test("the period is in the scope hash", async () => {
  const db = archiveDb();
  const a = await previewDlv(db, cpaBuildHandoff, handoffScope());
  const b = await previewDlv(db, cpaBuildHandoff, handoffScope({ period: "2026-02-01" }));
  assert(a.scopeHash !== b.scopeHash, "two months are two scopes");
});

test("the ledger fingerprint is in the scope hash, so a late posting rebuilds", async () => {
  const db = archiveDb();
  const before = await previewDlv(db, cpaBuildHandoff, handoffScope());
  seedEntry(db, "JE-LATE", "2026-01-20", [
    ["6100", BigInt(4200)],
    ["1010", BigInt(-4200)],
  ]);
  const after = await previewDlv(db, cpaBuildHandoff, handoffScope());
  assert(
    before.scopeHash !== after.scopeHash,
    "a posting inside the range produces a new scope hash rather than a stale dedupe hit",
  );
});

test("a posting outside the range leaves the archive alone", async () => {
  const db = archiveDb();
  const before = await previewDlv(db, cpaBuildHandoff, handoffScope());
  seedEntry(db, "JE-MAR", "2026-03-04", [
    ["6100", BigInt(900)],
    ["1010", BigInt(-900)],
  ]);
  const after = await previewDlv(db, cpaBuildHandoff, handoffScope());
  assertEqual(
    before.scopeHash,
    after.scopeHash,
    "March is outside a January archive, so the archive is unchanged",
  );
});

test("an overridden handoff is never rebuilt over", async () => {
  const db = archiveDb();
  await applyDlv(db, cpaBuildHandoff, handoffScope());
  const row = handoffsOf(db)[0];
  db.seed("cpa_handoffs", [{ ...row, manualOverride: true, artifactCount: 1 }]);
  seedEntry(db, "JE-LATE", "2026-01-20", [
    ["6100", BigInt(4200)],
    ["1010", BigInt(-4200)],
  ]);
  const out = await previewDlv(db, cpaBuildHandoff, handoffScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was proposed");
  assert(
    (out.result?.skips ?? []).some((s) => s.reason === "manual_override"),
    "the run reports the override",
  );
  assertEqual(handoffsOf(db)[0].artifactCount, 1, "and the hand set row stands");
});

test("a locked period is read fine, because reading is not writing to the ledger", async () => {
  const db = archiveDb();
  lockJanuary(db);
  await applyDlv(db, cpaBuildHandoff, handoffScope());
  assertEqual(handoffsOf(db).length, 1, "the archive was built from the closed month");
  assert(handoffsOf(db)[0].artifactCount > 0, "with artifacts in it");
  assertEqual(cpaBuildHandoff.writesLedger, false, "the run writes no ledger rows");
  assertEqual(cpaBuildHandoff.requiresOpenPeriod, false, "and needs no open period");
});

test("the archive carries every schedule doc 05 Part 5 names", async () => {
  const db = archiveDb();
  await applyDlv(db, cpaBuildHandoff, handoffScope());
  const kinds = new Set(handoffsOf(db)[0].artifacts.map((a) => a.artifactKind));
  for (const wanted of [
    "trial_balance",
    "general_ledger",
    "financial_statement",
    "subledger",
    "fixed_assets",
    "prepaids",
    "loans",
    "closing_entries",
    "open_items",
    "scope_statement",
  ]) {
    assert(kinds.has(wanted), `the archive contains the ${wanted} artifact`);
  }
});

test("every artifact is an open format with a row count and a checksum", async () => {
  const db = archiveDb();
  await applyDlv(db, cpaBuildHandoff, handoffScope());
  const artifacts = handoffsOf(db)[0].artifacts;
  assert(artifacts.length > 0, "there are artifacts");
  for (const a of artifacts) {
    assert(["csv", "json", "pdf", "txt"].includes(a.fileFormat), `${a.path} is an open format`);
    assert(a.checksum.length > 0, `${a.path} carries a checksum`);
    assert(a.rowCount >= 0, `${a.path} carries a row count`);
  }
  const paths = artifacts.map((a) => a.path);
  assertEqual(
    JSON.stringify(paths),
    JSON.stringify([...paths].sort()),
    "and the catalog is in a fixed sorted order",
  );
});

test("a fiscal year archive covers the year and picks up the 1099 data set", async () => {
  const db = archiveDb();
  seedDataSet(db);
  await applyDlv(db, cpaBuildHandoff, handoffScope({ scopeKind: "fiscal_year" }));
  const row = handoffsOf(db)[0];
  assertEqual(row.periodStart, "2026-01-01", "the range starts at the year start");
  assertEqual(row.periodEnd, "2026-12-31", "and ends at the year end");
  assertEqual(row.isFiscalYearEnd, true, "it is a year end archive");
  assertEqual(row.taxDataSetId, dataSetIdOf(CLIENT_A1, 2026), "and it names the data set");
  assert(
    row.artifacts.some((a) => a.path === "1099-data-set.csv"),
    "the compiled data set is in the archive",
  );
  assert(
    row.artifacts.some((a) => a.path === "w9-exceptions.csv"),
    "and so is the W-9 exception list",
  );
});

test("a month archive that is not a year end carries no 1099 data set", async () => {
  const db = archiveDb();
  seedDataSet(db);
  await applyDlv(db, cpaBuildHandoff, handoffScope());
  const row = handoffsOf(db)[0];
  assertEqual(row.isFiscalYearEnd, false, "January is not a year end");
  assertEqual(row.taxDataSetId, null, "so no data set is attached");
  assert(
    !row.artifacts.some((a) => a.path === "1099-data-set.csv"),
    "and the archive does not contain one",
  );
  assertEqual(rangeFor(handoffScope()).rangeEnd, PERIOD_END, "and the range is the month");
});

test("a year end with no compiled data set builds anyway and says what is missing", async () => {
  const db = archiveDb();
  const out = await previewDlv(db, cpaBuildHandoff, handoffScope({ scopeKind: "fiscal_year" }));
  const skips = out.result?.skips ?? [];
  assertEqual(skips[0].reason, "missing_prerequisite", "the missing data set is reported");
  assert(skips[0].detail.includes("TAX-BUILD-1099"), "and the run to fix it is named");
  assertEqual(
    (out.result?.proposals ?? []).length,
    1,
    "the archive is still built, just without that file",
  );
});

test("the run never compiles a 1099 data set of its own", async () => {
  const db = archiveDb();
  await applyDlv(db, cpaBuildHandoff, handoffScope({ scopeKind: "fiscal_year" }));
  assertEqual(db.all("tax_data_sets").length, 0, "no data set was written");
  assertEqual(db.all("tax_data_lines").length, 0, "and no lines were written");
});

test("open items are collected so the CPA sees them before filing", async () => {
  const db = archiveDb();
  db.seed("document_requests", [
    request("REQ-OPEN", "bank-statement", { status: "open" }),
    request("REQ-DONE", "invoice", { status: "satisfied" }),
  ]);
  await applyDlv(db, cpaBuildHandoff, handoffScope());
  const items = handoffsOf(db)[0].openItems;
  assert(
    items.some((i) => i.subjectId === "REQ-OPEN"),
    "the open request is on the log",
  );
  assert(
    !items.some((i) => i.subjectId === "REQ-DONE"),
    "and the closed one is not",
  );
  assertEqual(handoffsOf(db)[0].openItemCount, items.length, "the count matches the log");
  for (const item of items) {
    assert(typeof item.amountCents === "bigint", "every amount is integer cents");
  }
});

test("the archive is a zip in the vault, under governance lock, with D7 retention", async () => {
  const db = archiveDb();
  const out = await previewDlv(db, cpaBuildHandoff, handoffScope());
  const inserted = (out.result?.proposals ?? []).filter(isRowInsert);
  assertEqual(inserted.length, 1, "one row is proposed and no document row alongside it");
  assertEqual(inserted[0].table, "cpa_handoffs", "into the handoff table");
  const row = inserted[0].row;
  assert(String(row.vaultObjectKey).endsWith("handoff.zip"), "the archive is a zip");
  assert(String(row.vaultObjectKey).includes(CLIENT_A1), "under the client's own prefix");
  assertEqual(row.vaultObjectLockMode, "GOVERNANCE", "locked in the vault");
  assertEqual(row.vaultRetentionStartsOn, PERIOD_END, "with retention counting from period end");
});

test("the scope statement says what the firm did and did not do", async () => {
  const db = archiveDb();
  await applyDlv(db, cpaBuildHandoff, handoffScope());
  const statement = handoffsOf(db)[0].scopeStatement;
  assertEqual(statement, SCOPE_STATEMENT, "the row carries the statement");
  assert(statement.includes("not an audit"), "it disclaims an audit");
  assert(statement.includes("not a review"), "and a review");
  assert(statement.includes(COMPILATION_ONLY_BANNER), "and carries the compliance banner");
  assert(statement.includes("The client's CPA files."), "and says who files");
});

test("both bases are reported, because doc 05 Part 5 asks for both", async () => {
  const db = archiveDb();
  await applyDlv(db, cpaBuildHandoff, handoffScope());
  assertEqual(handoffsOf(db)[0].reportingBasis, "both", "the header states both bases");
  const paths = handoffsOf(db)[0].artifacts.map((a) => a.path);
  assert(paths.includes("trial-balance-accrual.csv"), "an accrual trial balance");
  assert(paths.includes("trial-balance-cash.csv"), "and a cash one");
});

test("the catalog and the open item log are pure functions of the close data", async () => {
  const db = archiveDb();
  const out = await previewDlv(db, cpaBuildHandoff, handoffScope());
  const row = (out.result?.proposals ?? []).filter(isRowInsert)[0].row;
  assertEqual(
    row.artifactCount,
    (row.artifacts as { path: string }[]).length,
    "the count and the catalog agree",
  );
  assertEqual(
    row.openItemCount,
    (row.openItems as unknown[]).length,
    "and so do the open item count and its log",
  );
  assert(typeof artifactCatalog === "function", "the catalog is exported for reuse");
  assert(typeof openItemsOf === "function", "and so is the open item log");
  assertEqual(row.builtAt !== null, true, "and the row records when it was built");
  assertEqual(row.manualOverride, false, "with no override on a machine built row");
  assert(String(row.ledgerFingerprint).length > 0, "and it carries the ledger fingerprint");
  assert(ACTOR.length > 0, "under a named actor");
});
