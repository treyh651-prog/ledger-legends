/**
 * RPT-COMPOSE-NARRATIVE tests.
 *
 * Two of these tests exist because of a constraint rather than a defect. One
 * asserts that the same ledger produces the same words character for character,
 * which is the observable difference between a template fill and a generated
 * paragraph. The other asserts that every sentence the module can emit traces to
 * a template in the table, so no sentence can be assembled at runtime.
 *
 * The rest assert the compliance line. A narrative that offered an opinion, an
 * assurance, or a tax conclusion would be a serious problem for a firm that is
 * not a CPA firm, so the vocabulary is checked directly.
 */

import { assert, assertEqual, test } from "./harness";
import { PERIOD, gateResult, recBatch, seedEntry } from "./close-fixtures";
import {
  applyReport,
  lockPeriod,
  narrativeText,
  narrativesOf,
  payroll,
  previewReport,
  reportDb,
  reportScope,
  shapeOf,
} from "./rpt-fixtures";
import { rptFlagVariances } from "../runs/rpt-flag-variances";
import { rptRebuildForecast } from "../runs/rpt-rebuild-forecast";
import {
  NARRATIVE_TEMPLATES,
  fillTemplate,
  money,
  narrativeIdOf,
  rptComposeNarrative,
} from "../runs/rpt-compose-narrative";

const scope = {
  ...reportScope(),
  audience: "owner" as const,
  maxSentencesPerSection: 5,
};

test("narrative preview and apply propose the same rows", async () => {
  const db = reportDb();
  const { preview, applied } = await applyReport(db, rptComposeNarrative, scope);
  assertEqual(applied.status, "completed", "the apply completed");
  assertEqual(
    shapeOf(applied.result.proposals),
    shapeOf(preview.result.proposals),
    "apply proposed exactly what preview showed",
  );
});

test("the narrative id is derived, so a rerun is a no operation", async () => {
  const db = reportDb();
  await applyReport(db, rptComposeNarrative, scope);
  assertEqual(
    narrativesOf(db)[0].id,
    narrativeIdOf(PERIOD, "owner"),
    "the id is derived from the period and the audience",
  );
  const again = await previewReport(db, rptComposeNarrative, scope);
  assertEqual(again.result.proposals.length, 0, "the second call proposes nothing");
  assert(
    again.result.skips.every((s) => s.reason === "already_applied"),
    "and says the narrative is already applied",
  );
});

test("two periods do not collide because the period is in the scope hash", async () => {
  const db = reportDb();
  const january = await previewReport(db, rptComposeNarrative, scope);
  const february = await previewReport(db, rptComposeNarrative, {
    ...scope,
    period: "2026-02-01",
  });
  assert(january.scopeHash !== february.scopeHash, "the two hashes differ");
  assert(
    narrativeIdOf(PERIOD, "owner") !== narrativeIdOf("2026-02-01", "owner"),
    "and the two narratives are different rows",
  );
});

test("a posting changes the ledger fingerprint and so changes the scope hash", async () => {
  const db = reportDb();
  const before = await previewReport(db, rptComposeNarrative, scope);
  seedEntry(db, "JE-MORE", "2026-01-30", [
    ["1010", BigInt(11000)],
    ["4100", BigInt(-11000)],
  ]);
  const after = await previewReport(db, rptComposeNarrative, scope);
  assert(before.scopeHash !== after.scopeHash, "a posting is a new scope");
});

test("an overridden narrative and a hand edited one are both left alone", async () => {
  const overridden = reportDb();
  await applyReport(overridden, rptComposeNarrative, scope);
  overridden.seed("report_narratives", [
    { ...narrativesOf(overridden)[0], manualOverride: true },
  ]);
  seedEntry(overridden, "JE-MORE", "2026-01-30", [
    ["1010", BigInt(11000)],
    ["4100", BigInt(-11000)],
  ]);
  const first = await previewReport(overridden, rptComposeNarrative, scope);
  assertEqual(first.result.proposals.length, 0, "an override stops the run");
  assertEqual(first.result.skips[0].reason, "manual_override", "and says why");

  const edited = reportDb();
  await applyReport(edited, rptComposeNarrative, scope);
  edited.seed("report_narratives", [
    { ...narrativesOf(edited)[0], manualEdit: true, bodyText: "words a person wrote" },
  ]);
  const second = await previewReport(edited, rptComposeNarrative, scope);
  assertEqual(second.result.proposals.length, 0, "a hand edit stops it too");
  assertEqual(
    narrativeText(edited),
    "words a person wrote",
    "and the words somebody wrote are still there",
  );
});

test("a locked period is read, never written", async () => {
  const db = reportDb();
  lockPeriod(db);
  const { applied } = await applyReport(db, rptComposeNarrative, scope);
  assertEqual(applied.status, "completed", "the run completes on a locked period");
  assertEqual(db.all("journal_entries").length, 2, "and writes nothing to the ledger");
  assert(narrativeText(db).length > 0, "while still composing a narrative");
});

test("the same ledger produces the same words, character for character", async () => {
  const first = reportDb();
  await applyReport(first, rptComposeNarrative, scope);
  const second = reportDb();
  await applyReport(second, rptComposeNarrative, scope);
  assertEqual(
    narrativeText(second),
    narrativeText(first),
    "two runs over the same book write the same sentence, which a generated paragraph could not promise",
  );
  assertEqual(
    narrativesOf(second)[0].contentChecksum,
    narrativesOf(first)[0].contentChecksum,
    "and the checksums agree",
  );
});

test("every sentence traces to a template in the table", async () => {
  const db = reportDb();
  lockPeriod(db);
  await applyReport(db, rptComposeNarrative, scope);
  const known = new Set(NARRATIVE_TEMPLATES.map((t) => t.templateId));
  const sentences = narrativesOf(db)[0].sentences;
  assert(sentences.length > 0, "there are sentences");
  assert(
    sentences.every((s) => known.has(s.templateId)),
    "and every one of them names a template that exists in the file",
  );
  assertEqual(
    fillTemplate("a {one} b {two}", { one: "x", two: "y" }),
    "a x b y",
    "the fill is a slot substitution and nothing else",
  );
});

test("the narrative names every gate that failed", async () => {
  const db = reportDb();
  db.seed("close_gate_results", [
    gateResult("GR-1", "G01", { outcome: "fail", blockingCount: 3 }),
    gateResult("GR-2", "G07", { outcome: "fail", blockingCount: 1 }),
    gateResult("GR-3", "G12", { outcome: "pass" }),
  ]);
  await applyReport(db, rptComposeNarrative, scope);
  const text = narrativeText(db);
  assert(text.includes("G01"), "the first failed gate is named");
  assert(text.includes("G07"), "and so is the second");
  assert(!text.includes("G12"), "while a gate that passed is not called a failure");
});

test("a failed gate sentence survives a full section", async () => {
  const db = reportDb();
  db.seed(
    "close_gate_results",
    ["G01", "G02", "G03", "G04", "G05", "G06", "G07"].map((code, at) =>
      gateResult(`GR-${at}`, code, { outcome: "fail", blockingCount: 1 }),
    ),
  );
  await applyReport(db, rptComposeNarrative, {
    ...scope,
    maxSentencesPerSection: 2,
  });
  const text = narrativeText(db);
  for (const code of ["G01", "G02", "G03", "G04", "G05", "G06", "G07"]) {
    assert(text.includes(code), `${code} is named even with a cap of two sentences`);
  }
});

test("the narrative names every variance over the threshold", async () => {
  const db = reportDb();
  await applyReport(db, rptFlagVariances, reportScope());
  await applyReport(db, rptComposeNarrative, scope);
  const text = narrativeText(db);
  assert(text.includes("4100"), "the flagged revenue account is named");
  assert(text.includes("Service revenue"), "with the name a reader would recognise");
  assert(!text.includes("6100"), "and an account inside its threshold is not called a variance");
});

test("a suspense item open more than thirty days is reported", async () => {
  const db = reportDb();
  db.seed("transactions", [
    {
      id: "TXN-OLD",
      firmId: "FIRM-A",
      clientId: "CLI-A1",
      bankAccountId: "BA-A1-OP",
      accountNumber: "1010",
      postedDate: "2025-11-15",
      amountCents: BigInt(-4500),
      description: "unidentified",
      normalizedDescription: "unidentified",
      vendorId: null,
      categoryId: null,
      accountNumberCoded: null,
      status: "needs_review",
      isTransfer: false,
      transferPairId: null,
      duplicateOfId: null,
      version: 1,
      manualOverride: false,
    } as never,
  ]);
  db.seed("suspense_items", [
    {
      id: "SUS-OLD",
      firmId: "FIRM-A",
      clientId: "CLI-A1",
      version: 1,
      transactionId: "TXN-OLD",
      accountNumber: "1990",
      reasonCode: "unidentified_deposit",
      detail: "seeded suspense",
      createdByRunId: "RUNX-SEED",
      createdAt: "2025-11-15T00:00:00.000Z",
      withdrawnByRunId: null,
      manualOverride: false,
    } as never,
  ]);
  await applyReport(db, rptComposeNarrative, scope);
  assert(
    narrativeText(db).includes("suspense items have been open more than 30 days"),
    "an aged suspense item is on the record",
  );
});

test("a reconciliation that never reached reconciled is reported", async () => {
  const db = reportDb();
  db.seed("rec_batches", [
    recBatch("RB-JAN", { state: "out_of_balance", diffCents: BigInt(2500) }),
  ]);
  await applyReport(db, rptComposeNarrative, scope);
  assert(
    narrativeText(db).includes("are not reconciled"),
    "the stale reconciliation is named",
  );
  assert(narrativeText(db).includes("25.00 dollars"), "with the difference stated");
});

test("a forecast shortfall is named with its week and its date", async () => {
  const db = reportDb();
  db.seed("payroll_approvals", [payroll("PAY-1", "2026-02-14", BigInt(900000))]);
  await applyReport(db, rptRebuildForecast, { ...reportScope(), scenario: "base" as const });
  await applyReport(db, rptComposeNarrative, scope);
  const text = narrativeText(db);
  assert(
    text.includes("negative closing balance in week"),
    "the shortfall is stated plainly",
  );
  assert(text.includes("2026-02"), "with the week it happens in");
});

test("the narrative offers no opinion, no assurance, and no tax conclusion", async () => {
  const db = reportDb();
  lockPeriod(db, { closedWithExceptions: true, exceptionNote: "One item unresolved." });
  db.seed("close_gate_results", [
    gateResult("GR-1", "G01", { outcome: "fail", blockingCount: 2 }),
  ]);
  await applyReport(db, rptFlagVariances, reportScope());
  await applyReport(db, rptRebuildForecast, { ...reportScope(), scenario: "base" as const });
  await applyReport(db, rptComposeNarrative, scope);
  const banned = [
    "we recommend",
    "you should",
    "in our opinion",
    "assurance",
    "audit",
    "reviewed",
    "tax",
    "deduct",
    "healthy",
    "strong",
    "concerning",
  ];
  const text = narrativeText(db).toLowerCase();
  for (const word of banned) {
    assert(!text.includes(word), `the narrative never says "${word}"`);
  }
  const templates = NARRATIVE_TEMPLATES.map((t) => t.text.toLowerCase()).join(" ");
  for (const word of banned) {
    assert(!templates.includes(word), `and no template in the table says "${word}" either`);
  }
});

test("the narrative is always a draft and always states the period state", async () => {
  const open = reportDb();
  await applyReport(open, rptComposeNarrative, scope);
  assertEqual(narrativesOf(open)[0].state, "draft", "a run never publishes a narrative");
  assert(
    narrativeText(open).includes("is not closed"),
    "an open period says the figures can still change",
  );
  const closed = reportDb();
  lockPeriod(closed);
  await applyReport(closed, rptComposeNarrative, scope);
  assert(
    narrativeText(closed).includes("closed with all gates passing"),
    "and a clean closed period says that instead",
  );
});

test("the trigger log records rules that did not fire", async () => {
  const db = reportDb();
  await applyReport(db, rptComposeNarrative, scope);
  const log = narrativesOf(db)[0].triggerLog;
  assert(log.length > 0, "there is a log");
  assert(
    log.some((t) => !t.fired),
    "and it holds rules that stayed quiet, so a reader can tell quiet from unexamined",
  );
  assert(
    log.every((t) => t.threshold.length > 0),
    "every entry states what it compared against",
  );
});

test("the only delivery is an audit row, written once", async () => {
  const db = reportDb();
  await applyReport(db, rptComposeNarrative, scope);
  const events = db.all("report_audit_events");
  assertEqual(events.length, 1, "one audit event");
  assertEqual(events[0].action, "narrative_available", "and it is narrative_available");
  await applyReport(db, rptComposeNarrative, scope);
  assertEqual(
    db.all("report_audit_events").length,
    1,
    "a second compose does not announce it twice",
  );
});

test("money reads as prose rather than as a ledger figure", () => {
  assertEqual(money(BigInt(0)), "0.00 dollars", "zero");
  assertEqual(money(BigInt(123456)), "1,234.56 dollars", "thousands are grouped");
  assertEqual(
    money(BigInt(-4500)),
    "negative 45.00 dollars",
    "and a negative is a word, not a mark a reader can miss",
  );
});
