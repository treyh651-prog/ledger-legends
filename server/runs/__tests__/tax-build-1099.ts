/**
 * COMPLIANCE. Ledger Legends is not a CPA firm. This run compiles data. It does
 * not file, issue, submit, or transmit any tax document. The compiled data set
 * is provided to the client's CPA for filing.
 *
 * TAX-BUILD-1099 tests.
 *
 * The framework invariants first, then the compilation rules doc 02 module 9
 * states. The compliance boundary is asserted in compliance-tests.ts, because it
 * is a claim about the source file and not about one execution of it.
 */

import { assert, assertEqual, test } from "./harness";
import { isFieldWrite } from "../contract";
import {
  APPROACH,
  ATTORNEY,
  CARDPAYEE,
  CLIENT_A1,
  CONTRACTOR,
  CORP,
  HOLD,
  LANDLORD,
  NOTIN,
  SMALL,
  THRESHOLD_2026,
  THRESHOLD_LEGACY,
  TAX_PERIOD,
  applyTax,
  dataSetsOf,
  lineFor,
  linesOf,
  lockDecember,
  payment,
  previewTax,
  shapeOf,
  taxDb,
  taxScope,
  taxVendor,
  threshold,
} from "./tax-fixtures";
import { seedEntry } from "./close-fixtures";
import { dataSetIdOf, lineIdOf, taxBuild1099 } from "../runs/tax-build-1099";

test("preview and apply propose the same rows", async () => {
  const db = taxDb();
  const { preview, applied } = await applyTax(db, taxBuild1099, taxScope());
  assertEqual(
    shapeOf(preview.result?.proposals ?? []),
    shapeOf(applied.result?.proposals ?? []),
    "the compiled set is the same on both passes",
  );
  assertEqual(dataSetsOf(db).length, 1, "one header row landed");
  assertEqual(linesOf(db).length, 5, "five compiled lines landed");
});

test("ids are derived, so a rerun is a no operation", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  const again = await previewTax(db, taxBuild1099, taxScope());
  const writes = (again.result?.proposals ?? []).length;
  assertEqual(writes, 0, "the second compilation proposes nothing");
  assert(
    (again.result?.skips ?? []).some((s) => s.detail.includes("data_set_unchanged")),
    "the header reports itself unchanged",
  );
  assertEqual(dataSetsOf(db).length, 1, "no second header appeared");
});

test("the data set id is derived from the client and the year", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  const expected = dataSetIdOf(CLIENT_A1, 2026);
  assertEqual(dataSetsOf(db)[0].id, expected, "the header id is the derived one");
  const line = lineFor(db, CONTRACTOR);
  assertEqual(
    line?.id,
    lineIdOf(expected, CONTRACTOR, "NEC-1"),
    "the line id is derived from the set, the payee, and the box",
  );
});

test("two years do not collide because the period is in the scope hash", async () => {
  const db = taxDb();
  const a = await previewTax(db, taxBuild1099, taxScope("2026-12-01"));
  const b = await previewTax(db, taxBuild1099, taxScope("2025-12-01"));
  assert(a.scopeHash !== b.scopeHash, "2025 and 2026 are different scopes");
  assertEqual(dataSetIdOf(CLIENT_A1, 2026) === dataSetIdOf(CLIENT_A1, 2025), false,
    "and they build different data sets");
  assertEqual(
    (b.result?.proposals ?? []).length,
    1,
    "2025 has no payments in it, so only an empty header is compiled",
  );
});

test("a posting changes the ledger fingerprint and so changes the scope hash", async () => {
  const db = taxDb();
  const before = await previewTax(db, taxBuild1099, taxScope());
  seedEntry(db, "JE-LATE", "2026-11-02", [
    ["6100", BigInt(5000)],
    ["1010", BigInt(-5000)],
  ]);
  const after = await previewTax(db, taxBuild1099, taxScope());
  assert(
    before.scopeHash !== after.scopeHash,
    "a posting inside the year produces a fresh scope rather than a stale dedupe hit",
  );
});

test("an overridden data set is never rewritten", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  const rows = dataSetsOf(db);
  db.seed("tax_data_sets", [{ ...rows[0], manualOverride: true, payeeCount: 99 }]);
  const again = await previewTax(db, taxBuild1099, taxScope());
  assertEqual((again.result?.proposals ?? []).length, 0, "nothing was proposed");
  assert(
    (again.result?.skips ?? []).some((s) => s.reason === "manual_override"),
    "the header reports the override",
  );
  assertEqual(dataSetsOf(db)[0].payeeCount, 99, "the hand set value stands");
});

test("a locked period is read, never refused", async () => {
  const db = taxDb();
  lockDecember(db);
  const { applied } = await applyTax(db, taxBuild1099, taxScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    "the compilation ran against a locked year",
  );
  assertEqual(dataSetsOf(db).length, 1, "the header landed anyway");
  assert(
    (applied.result?.skips ?? []).every((s) => s.reason !== "locked_period"),
    "no skip blamed the lock",
  );
});

test("the threshold is the dated one, not a constant", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope("2026-12-01"));
  assertEqual(
    dataSetsOf(db)[0].thresholdCents,
    THRESHOLD_2026,
    "2026 measures against 2,000 dollars",
  );
  const earlier = taxDb();
  await applyTax(earlier, taxBuild1099, taxScope("2025-12-01"));
  assertEqual(
    dataSetsOf(earlier)[0].thresholdCents,
    THRESHOLD_LEGACY,
    "2025 measures against 600 dollars",
  );
});

test("a year with no threshold row is refused rather than defaulted", async () => {
  const db = taxDb();
  // Both dated rows are pushed past the compiled year, so none covers it.
  db.seed("tax_thresholds", [
    threshold("TH-1099-LEGACY", "2030-01-01", null, THRESHOLD_LEGACY),
    threshold("TH-1099-2026", "2030-01-01", null, THRESHOLD_2026),
  ]);
  const out = await previewTax(db, taxBuild1099, taxScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was compiled");
  assert(
    (out.result?.errors ?? []).some((e) => e.message.includes("no 1099 threshold row")),
    "the run says which configuration row is missing",
  );
});

test("a corporation is excluded and an attorney is not", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  assertEqual(lineFor(db, CORP), undefined, "the corporation produced no line");
  const atty = lineFor(db, ATTORNEY);
  assertEqual(atty?.boxCode, "NEC-1", "the attorney landed in the NEC box");
  assertEqual(
    atty?.attorneyExceptionApplied,
    true,
    "and the row records that the exception is why",
  );
});

test("rent and non employee compensation land in different boxes", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  assertEqual(lineFor(db, LANDLORD)?.boxCode, "MISC-1", "rent goes to MISC box 1");
  assertEqual(lineFor(db, LANDLORD)?.formCode, "1099-MISC", "on the MISC form");
  assertEqual(lineFor(db, CONTRACTOR)?.formCode, "1099-NEC", "compensation on the NEC");
});

test("a card payment is left to the processor", async () => {
  const db = taxDb();
  const { applied } = await applyTax(db, taxBuild1099, taxScope());
  assertEqual(lineFor(db, CARDPAYEE), undefined, "the card payee produced no line");
  assertEqual(
    dataSetsOf(db)[0].excludedCardTotalCents,
    BigInt(400000),
    "the excluded card total is stated rather than silently dropped",
  );
  assert(
    (applied.result?.skips ?? []).some((s) =>
      s.detail.includes("reportable_by_processor_1099k"),
    ),
    "the skip names the 1099-K",
  );
});

test("a payee under the threshold is absent and one near it is listed", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  assertEqual(lineFor(db, SMALL), undefined, "50,000 cents produced nothing");
  const near = lineFor(db, APPROACH);
  assertEqual(near?.state, "approaching_threshold", "170,000 cents is approaching");
  assertEqual(
    near?.reportableCents,
    BigInt(0),
    "an approaching payee reports nothing yet",
  );
});

test("a held payee with no W-9 is left out entirely", async () => {
  const db = taxDb();
  const { applied } = await applyTax(db, taxBuild1099, taxScope());
  assertEqual(lineFor(db, HOLD), undefined, "the held payee produced no line");
  assert(
    (applied.result?.skips ?? []).some((s) => s.detail.includes("payment_hold_no_w9")),
    "the skip names the hold and the missing form",
  );
});

test("backup withholding is a flag on a row and never an act", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  const line = lineFor(db, NOTIN);
  assertEqual(line?.backupWithholdingRequired, true, "the flag is set");
  assertEqual(line?.w9State, "missing", "because there is no W-9 behind the payee");
  assertEqual(line?.tinLast4, null, "and no number to record");
  assertEqual(
    dataSetsOf(db)[0].backupWithholdingCount,
    1,
    "the header counts exactly one exposure",
  );
});

test("the header counts and the lines under it describe the same set", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  const header = dataSetsOf(db)[0];
  const lines = linesOf(db);
  const reportable = lines.filter((l) => l.state === "reportable");
  const approaching = lines.filter((l) => l.state === "approaching_threshold");
  assertEqual(header.reportableCount, reportable.length, "reportable counts agree");
  assertEqual(header.approachingCount, approaching.length, "approaching counts agree");
  assertEqual(
    header.reportableTotalCents,
    reportable.reduce((sum, l) => sum + l.reportableCents, BigInt(0)),
    "the reportable total is the sum of the reportable lines",
  );
});

test("payments to one payee aggregate across categories before the threshold test", async () => {
  const db = taxDb();
  db.seed("vendors", [...db.all("vendors"), taxVendor("VEN-SPLIT", "Jensen Trades")]);
  db.seed("transactions", [
    ...db.all("transactions"),
    payment("TXN-SPLIT-A", "VEN-SPLIT", "CAT-contract", BigInt(120000)),
    payment("TXN-SPLIT-B", "VEN-SPLIT", "CAT-rent", BigInt(120000)),
  ]);
  await applyTax(db, taxBuild1099, taxScope());
  const lines = linesOf(db).filter((l) => l.payeeId === "VEN-SPLIT");
  assertEqual(lines.length, 2, "two boxes, because the classes differ");
  assertEqual(
    lines[0].state,
    "reportable",
    "and both are reportable, because 240,000 cents clears the threshold together",
  );
  assertEqual(
    lines[0].payeeTotalCents,
    BigInt(240000),
    "the threshold was measured against the payee level total",
  );
});

test("a refund from a payee nets against the year", async () => {
  const db = taxDb();
  db.seed("transactions", [
    ...db.all("transactions"),
    // A positive amount is money coming back in.
    payment("TXN-REFUND", CONTRACTOR, "CAT-contract", BigInt(-20000)),
  ]);
  await applyTax(db, taxBuild1099, taxScope());
  assertEqual(
    lineFor(db, CONTRACTOR)?.reportableCents,
    BigInt(230000),
    "250,000 paid less 20,000 refunded",
  );
});

test("only the last four digits of a taxpayer number are ever compiled", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  for (const line of linesOf(db)) {
    assert(
      line.tinLast4 === null || line.tinLast4.length === 4,
      `the line for ${line.payeeName} carries at most four digits`,
    );
  }
});

test("a changed year rebuilds in place rather than stacking a second set", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  const first = dataSetsOf(db)[0].reportableTotalCents;
  db.seed("transactions", [
    ...db.all("transactions"),
    payment("TXN-EXTRA", CONTRACTOR, "CAT-contract", BigInt(10000)),
  ]);
  const rebuild = await previewTax(db, taxBuild1099, taxScope());
  const moves = (rebuild.result?.proposals ?? []).filter(isFieldWrite);
  assert(moves.length > 0, "a changed year proposes field moves");
  assert(
    (rebuild.result?.proposals ?? []).every(isFieldWrite),
    "and never a second insert, because a CPA may already hold the archive",
  );
  await applyTax(db, taxBuild1099, taxScope());
  assertEqual(dataSetsOf(db).length, 1, "still one header");
  assertEqual(
    dataSetsOf(db)[0].reportableTotalCents,
    first + BigInt(10000),
    "carrying the new total",
  );
});
