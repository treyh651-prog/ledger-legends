/**
 * OFFBOARD-BUILD-EXPORT tests.
 *
 * D9. A client who leaves gets the whole history in formats that do not need
 * this firm's software to read, produced inside fifteen business days. The
 * tests hold the production window, the open format rule, the history range,
 * and the fingerprint in the scope hash.
 */

import { assert, assertEqual, test } from "./harness";
import { isRowInsert } from "../contract";
import {
  CLIENT_A1,
  applyDlv,
  archiveDb,
  exportsOf,
  lockJanuary,
  previewDlv,
  shapeOf,
} from "./dlv-fixtures";
import { PERIOD, PERIOD_END, seedEntry } from "./close-fixtures";
import {
  PRODUCTION_DAYS,
  exportIdOf,
  fileCatalog,
  historyRange,
  offboardBuildExport,
} from "../runs/offboard-build-export";
import { addBusinessDays } from "../runs/prc-shared";

const REQUESTED_ON = "2026-02-12";

function exportScope(extra: Partial<{ period: string; requestedOn: string }> = {}) {
  return { clientId: CLIENT_A1, period: PERIOD, requestedOn: REQUESTED_ON, ...extra };
}

test("preview and apply propose the same rows", async () => {
  const db = archiveDb();
  const { preview, applied } = await applyDlv(db, offboardBuildExport, exportScope());
  assertEqual(
    shapeOf(preview.result?.proposals ?? []),
    shapeOf(applied.result?.proposals ?? []),
    "the export is the same on both passes",
  );
  assertEqual(exportsOf(db).length, 1, "one export row landed");
  assertEqual(exportsOf(db)[0].status, "complete", "at status complete");
});

test("ids are derived from the client and the day the client asked", async () => {
  const db = archiveDb();
  await applyDlv(db, offboardBuildExport, exportScope());
  assertEqual(
    exportsOf(db)[0].id,
    exportIdOf(CLIENT_A1, REQUESTED_ON),
    "the row sits at its derived id",
  );
  assert(
    exportIdOf(CLIENT_A1, REQUESTED_ON) !== exportIdOf(CLIENT_A1, "2026-03-01"),
    "a second request on a later day is a second export",
  );
  const again = await previewDlv(db, offboardBuildExport, exportScope());
  assert(
    (again.result?.skips ?? []).some((s) => s.detail.includes("export_unchanged")),
    "and an unchanged rebuild proposes nothing",
  );
});

test("the period is in the scope hash", async () => {
  const db = archiveDb();
  const a = await previewDlv(db, offboardBuildExport, exportScope());
  const b = await previewDlv(db, offboardBuildExport, exportScope({ period: "2026-02-01" }));
  assert(a.scopeHash !== b.scopeHash, "two periods are two scopes");
});

test("the ledger fingerprint is in the scope hash, so a late posting rebuilds", async () => {
  const db = archiveDb();
  const before = await previewDlv(db, offboardBuildExport, exportScope());
  seedEntry(db, "JE-LATE", "2026-01-22", [
    ["6100", BigInt(2500)],
    ["1010", BigInt(-2500)],
  ]);
  const after = await previewDlv(db, offboardBuildExport, exportScope());
  assert(
    before.scopeHash !== after.scopeHash,
    "a departing client gets the books as they actually are, not a stale archive",
  );
});

test("an overridden export is never rebuilt over", async () => {
  const db = archiveDb();
  await applyDlv(db, offboardBuildExport, exportScope());
  const row = exportsOf(db)[0];
  db.seed("offboard_exports", [{ ...row, manualOverride: true, fileCount: 1 }]);
  seedEntry(db, "JE-LATE", "2026-01-22", [
    ["6100", BigInt(2500)],
    ["1010", BigInt(-2500)],
  ]);
  const out = await previewDlv(db, offboardBuildExport, exportScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was proposed");
  assert(
    (out.result?.skips ?? []).some((s) => s.reason === "manual_override"),
    "the run reports the override",
  );
  assertEqual(exportsOf(db)[0].fileCount, 1, "and the hand set row stands");
});

test("a locked period is read fine, because an export reads and never posts", async () => {
  const db = archiveDb();
  lockJanuary(db);
  await applyDlv(db, offboardBuildExport, exportScope());
  assertEqual(exportsOf(db).length, 1, "the export was built over the closed month");
  assert(exportsOf(db)[0].fileCount > 0, "with files in it");
  assertEqual(offboardBuildExport.writesLedger, false, "the run writes no ledger rows");
  assertEqual(offboardBuildExport.requiresOpenPeriod, false, "and needs no open period");
});

test("the production window is fifteen business days from the request", async () => {
  const db = archiveDb();
  await applyDlv(db, offboardBuildExport, exportScope());
  const row = exportsOf(db)[0];
  assertEqual(row.productionDays, 15, "D9 says fifteen and the row says fifteen");
  assertEqual(PRODUCTION_DAYS, 15, "and the constant agrees");
  assertEqual(row.requestedOn, REQUESTED_ON, "counted from the day the client asked");
  assertEqual(row.dueOn, addBusinessDays(REQUESTED_ON, 15), "to the derived due date");
  assert(row.dueOn > REQUESTED_ON, "which is later than the request");
});

test("the window skips weekends, so fifteen business days is more than fifteen days", async () => {
  const db = archiveDb();
  await applyDlv(db, offboardBuildExport, exportScope());
  const due = new Date(`${exportsOf(db)[0].dueOn}T00:00:00.000Z`);
  const asked = new Date(`${REQUESTED_ON}T00:00:00.000Z`);
  const calendarDays = Math.round((due.getTime() - asked.getTime()) / 86400000);
  assert(calendarDays > 15, `fifteen business days spans ${calendarDays} calendar days`);
  assert(calendarDays <= 23, "and no more than three weekends worth");
  assert(due.getUTCDay() !== 0 && due.getUTCDay() !== 6, "the due date is a business day");
});

test("the production window is not a knob a caller can turn", async () => {
  const db = archiveDb();
  const out = await previewDlv(db, offboardBuildExport, exportScope());
  const row = (out.result?.proposals ?? []).filter(isRowInsert)[0].row;
  assertEqual(row.productionDays, 15, "the proposed row is fifteen");
  const parsed = offboardBuildExport.scopeSchema.safeParse({
    ...exportScope(),
    productionDays: 30,
  });
  assert(parsed.success, "an extra key parses");
  assert(
    !("productionDays" in (parsed.success ? parsed.data : {})),
    "but the scope drops it, so it never reaches the row",
  );
});

test("every file is an open format", async () => {
  const db = archiveDb();
  await applyDlv(db, offboardBuildExport, exportScope());
  const files = exportsOf(db)[0].files;
  assert(files.length > 0, "there are files");
  for (const f of files) {
    assert(["csv", "json", "pdf"].includes(f.fileFormat), `${f.path} is CSV, JSON, or PDF`);
    assert(f.checksum.length > 0, `${f.path} carries a checksum`);
  }
  assertEqual(exportsOf(db)[0].fileCount, files.length, "the count matches the catalog");
});

test("the export covers the whole client history, not one period", async () => {
  const db = archiveDb();
  await applyDlv(db, offboardBuildExport, exportScope());
  const row = exportsOf(db)[0];
  assertEqual(row.historyStart, "2026-01-15", "starting at the first entry ever posted");
  assertEqual(row.historyEnd, "2026-02-11", "and running past the requested period");
  assertEqual(row.periodStart, PERIOD, "while still recording the period asked for");
  assertEqual(row.periodEnd, PERIOD_END, "at both ends");
  assert(row.historyEnd > row.periodEnd, "the history reaches beyond that period");
});

test("a client with no ledger history still gets an export", async () => {
  const range = historyRange(
    {
      entries: [],
      lines: [],
      chart: [],
      transactions: [],
      aging: [],
      vendors: [],
      assets: [],
      depreciation: [],
      deferralLines: [],
      loanSchedule: [],
      periods: [],
      locks: [],
      runLog: [],
      requests: [],
      suspense: [],
      tieouts: [],
    } as unknown as Parameters<typeof historyRange>[0],
    PERIOD_END,
  );
  assertEqual(range.start, null, "there is no first entry");
  assertEqual(range.end, PERIOD_END, "so the range ends at the period end");
  assertEqual(range.years.length, 0, "and no years are covered");
});

test("the ledger, the registers, and the provenance are all in the catalog", async () => {
  const db = archiveDb();
  await applyDlv(db, offboardBuildExport, exportScope());
  const kinds = new Set(exportsOf(db)[0].files.map((f) => f.artifactKind));
  for (const wanted of ["chart", "ledger", "register", "statement", "provenance", "open_items"]) {
    assert(kinds.has(wanted), `the export contains the ${wanted} files`);
  }
  const paths = exportsOf(db)[0].files.map((f) => f.path);
  assert(paths.includes("journal-entries.csv"), "the entries are there");
  assert(paths.includes("journal-lines.csv"), "and the lines");
  assert(paths.includes("run-log.json"), "and the run log, so decisions stay traceable");
});

test("the manifest checksums the catalog, so a changed file changes the header", async () => {
  const db = archiveDb();
  await applyDlv(db, offboardBuildExport, exportScope());
  const first = exportsOf(db)[0].manifestChecksum;
  const second = archiveDb();
  seedEntry(second, "JE-EXTRA", "2026-02-12", [
    ["6100", BigInt(700)],
    ["1010", BigInt(-700)],
  ]);
  await applyDlv(second, offboardBuildExport, exportScope());
  assert(
    exportsOf(second)[0].manifestChecksum !== first,
    "an extra entry changes a row count, which changes the manifest",
  );
  assertEqual(
    exportsOf(db)[0].totalRowCount,
    exportsOf(db)[0].files.reduce((sum, f) => sum + f.rowCount, 0),
    "and the total row count is the sum of the catalog",
  );
});

test("the export is a zip in the vault, under governance lock", async () => {
  const db = archiveDb();
  const out = await previewDlv(db, offboardBuildExport, exportScope());
  const inserted = (out.result?.proposals ?? []).filter(isRowInsert);
  assertEqual(inserted.length, 1, "one row and no document row alongside it");
  assertEqual(inserted[0].table, "offboard_exports", "into the export table");
  const row = inserted[0].row;
  assert(String(row.vaultObjectKey).endsWith("export.zip"), "the export is a zip");
  assert(String(row.vaultObjectKey).includes("offboarding"), "under the offboarding prefix");
  assertEqual(row.vaultObjectLockMode, "GOVERNANCE", "locked in the vault");
  assertEqual(
    row.vaultRetentionStartsOn,
    "2026-02-11",
    "with D7 retention counting from the last period the export covers",
  );
});

test("nothing is sent, the run only builds", async () => {
  const db = archiveDb();
  await applyDlv(db, offboardBuildExport, exportScope());
  assertEqual(db.all("journal_entries").length, 2, "the ledger is exactly as it was");
  assertEqual(db.all("journal_lines").length, 4, "and so are its lines");
  assert(typeof fileCatalog === "function", "the catalog is a pure exported function");
});
