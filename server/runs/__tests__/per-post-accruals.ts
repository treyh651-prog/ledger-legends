/**
 * PER-POST-ACCRUALS tests.
 *
 * Two things carry the weight here. The entry has to be stamped so that
 * PER-REVERSE-ACCRUALS can find it next month, and an accrual has to stand
 * aside when the real bill already landed inside the period, because the second
 * copy of a cost is the failure mode that a period end module has to design
 * against.
 */

import { isJournalEntry } from "../contract";
import { canonicalJson, toJsonValue } from "../ids";
import { perPostAccruals } from "../runs/per-post-accruals";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  accrualTemplate,
  applyPer,
  balanceOf,
  entry,
  jline,
  linesOf,
  perDb,
  periodScope,
  previewPer,
  reasons,
  skippedFor,
  sumLines,
} from "./per-fixtures";
import { assert, assertEqual, show, test } from "./harness";

test("per accruals, a fixed amount template posts a balanced entry stamped to reverse", async () => {
  const db = perDb();
  db.seed("accrual_templates", [accrualTemplate("AT-RENT")]);
  const { applied } = await applyPer(db, perPostAccruals, periodScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );

  const entries = db.all("journal_entries");
  assertEqual(entries.length, 1, "one entry");
  assertEqual(entries[0].entryDate, "2026-01-31", "dated the period end");
  assertEqual(entries[0].reversesOn, "2026-02-01", "and stamped to reverse on the first");
  assertEqual(entries[0].accrualTemplateId, "AT-RENT", "the template is named on it");
  assertEqual(entries[0].linkedDocumentId, null, "nothing has superseded it yet");
  assertEqual(sumLines(linesOf(db, entries[0].id)), BigInt(0), "it balances");
  assertEqual(balanceOf(db, "6100"), BigInt(50000), "the expense took the debit");
  assertEqual(balanceOf(db, "2200"), BigInt(-50000), "the liability took the credit");
});

test("per accruals, a wages accrual never touches cash", async () => {
  const db = perDb();
  db.seed("accrual_templates", [
    accrualTemplate("AT-WAGE", {
      accrualKind: "wages_earned_not_paid",
      debitAccount: "6100",
      creditAccount: "2210",
      fixedAmountCents: BigInt(180000),
      entryMemo: "Wages earned not paid",
    }),
  ]);
  await applyPer(db, perPostAccruals, periodScope());
  assertEqual(balanceOf(db, "2210"), BigInt(-180000), "accrued wages carry the credit");
  assertEqual(balanceOf(db, "1010"), BigInt(0), "operating cash was never touched");
  assertEqual(balanceOf(db, "1020"), BigInt(0), "nor any other bank account");
});

test("per accruals, a daily rate template multiplies out to the cent", async () => {
  const db = perDb();
  db.seed("accrual_templates", [
    accrualTemplate("AT-DAILY", {
      basis: "daily_rate_x_days",
      fixedAmountCents: null,
      dailyRateCents: BigInt(1234),
      dayCount: 11,
    }),
  ]);
  await applyPer(db, perPostAccruals, periodScope());
  assertEqual(balanceOf(db, "6100"), BigInt(13574), "1234 a day for eleven days");
});

test("per accruals, a percent of base template uses basis points", async () => {
  const db = perDb();
  db.seed("accrual_templates", [
    accrualTemplate("AT-PCT", {
      basis: "percent_of_base",
      fixedAmountCents: null,
      baseCents: BigInt(1000000),
      percentBps: 725,
    }),
  ]);
  await applyPer(db, perPostAccruals, periodScope());
  assertEqual(balanceOf(db, "6100"), BigInt(72500), "725 bps of 1000000");
});

test("per accruals, a revenue accrual debits the receivable and credits revenue", async () => {
  const db = perDb();
  db.seed("accrual_templates", [
    accrualTemplate("AT-REV", {
      accrualKind: "revenue_earned_not_billed",
      debitAccount: "1200",
      creditAccount: "4100",
      fixedAmountCents: BigInt(90000),
      entryMemo: "Revenue earned not billed",
    }),
  ]);
  await applyPer(db, perPostAccruals, periodScope());
  assertEqual(balanceOf(db, "1200"), BigInt(90000), "the receivable");
  assertEqual(balanceOf(db, "4100"), BigInt(-90000), "and the revenue");
});

test("per accruals, a template with no amount inputs is reported rather than guessed", async () => {
  const db = perDb();
  db.seed("accrual_templates", [
    accrualTemplate("AT-EMPTY", {
      basis: "daily_rate_x_days",
      fixedAmountCents: null,
    }),
  ]);
  const preview = await previewPer(db, perPostAccruals, periodScope());
  assert(
    preview.result.errors.some((e) => e.code === "PER_ACCRUAL_BASIS_INPUTS_MISSING"),
    `expected the inputs error, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
  assertEqual(preview.status, "refused", "and the run refuses");
});

test("per accruals, an accrual that computes to zero posts nothing", async () => {
  const db = perDb();
  db.seed("accrual_templates", [
    accrualTemplate("AT-ZERO", { fixedAmountCents: BigInt(0) }),
  ]);
  const preview = await previewPer(db, perPostAccruals, periodScope());
  assert(
    preview.result.errors.some((e) => e.code === "PER_ACCRUAL_AMOUNT_IS_ZERO"),
    `expected the zero error, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "nothing was posted");
});

test("per accruals, a real bill already in the period suppresses the accrual", async () => {
  const db = perDb();
  db.seed("accrual_templates", [accrualTemplate("AT-RENT")]);
  db.seed("journal_entries", [
    entry("JE-BILL", "2026-01-20", {
      sourceTable: "bills",
      sourceRowId: "BILL-9",
      memo: "January rent bill",
    }),
  ]);
  db.seed("journal_lines", [
    jline("JL-B1", "JE-BILL", "6100", BigInt(50000), "2026-01-20"),
    jline("JL-B2", "JE-BILL", "2200", BigInt(-50000), "2026-01-20"),
  ]);
  const { applied } = await applyPer(db, perPostAccruals, periodScope());
  assert(
    skippedFor(applied, "AT-RENT", "already_applied"),
    `expected already_applied, got ${show(reasons(applied))}`,
  );
  assert(
    applied.result.skips.some((s) =>
      s.detail.includes("source_document_already_posted"),
    ),
    "and the reason names the document",
  );
  assertEqual(db.all("journal_entries").length, 1, "only the bill is on the books");
  assertEqual(balanceOf(db, "6100"), BigInt(50000), "the cost is in the period once");
});

test("per accruals, a bill for a different amount does not suppress the accrual", async () => {
  const db = perDb();
  db.seed("accrual_templates", [accrualTemplate("AT-RENT")]);
  db.seed("journal_entries", [
    entry("JE-BILL", "2026-01-20", { sourceTable: "bills", sourceRowId: "BILL-9" }),
  ]);
  db.seed("journal_lines", [
    jline("JL-B1", "JE-BILL", "6100", BigInt(12000), "2026-01-20"),
    jline("JL-B2", "JE-BILL", "2200", BigInt(-12000), "2026-01-20"),
  ]);
  const { applied } = await applyPer(db, perPostAccruals, periodScope());
  assertEqual(applied.result.proposals.filter(isJournalEntry).length, 1, "it accrued");
  assertEqual(balanceOf(db, "6100"), BigInt(62000), "both amounts are in the period");
});

test("per accruals, the same period twice accrues once", async () => {
  const db = perDb();
  db.seed("accrual_templates", [accrualTemplate("AT-RENT")]);
  await applyPer(db, perPostAccruals, periodScope());
  const second = await applyPer(db, perPostAccruals, periodScope());
  assertEqual(db.all("journal_entries").length, 1, "still one entry");
  assert(
    skippedFor(second.preview, "AT-RENT", "already_applied"),
    `expected already_applied, got ${show(reasons(second.preview))}`,
  );
});

test("per accruals, autoReverse false leaves the entry permanent", async () => {
  const db = perDb();
  db.seed("accrual_templates", [
    accrualTemplate("AT-PERM", { autoReverse: false }),
  ]);
  await applyPer(db, perPostAccruals, periodScope());
  const entries = db.all("journal_entries");
  assertEqual(entries[0].reversesOn, null, "nothing will reverse it");
  assertEqual(entries[0].accrualTemplateId, "AT-PERM", "though it is still traceable");
});

test("per accruals, an inactive or overridden template is left alone", async () => {
  const db = perDb();
  db.seed("accrual_templates", [
    accrualTemplate("AT-OFF", { isActive: false }),
    accrualTemplate("AT-OVR", { manualOverride: true }),
  ]);
  const { applied } = await applyPer(db, perPostAccruals, periodScope());
  assert(skippedFor(applied, "AT-OFF", "missing_prerequisite"), "the inactive one");
  assert(skippedFor(applied, "AT-OVR", "manual_override"), "the overridden one");
  assertEqual(applied.overriddenInScope, 1, "and the override is counted");
  assertEqual(db.all("journal_entries").length, 0, "neither posted");
});

test("per accruals, a locked period is skipped and never thrown", async () => {
  const db = perDb();
  db.seed("accrual_templates", [accrualTemplate("AT-RENT")]);
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await applyPer(db, perPostAccruals, periodScope());
  assert(
    skippedFor(applied, "AT-RENT", "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "and nothing was written");
});

test("per accruals, preview equals apply and preview writes nothing", async () => {
  const db = perDb();
  db.seed("accrual_templates", [
    accrualTemplate("AT-RENT"),
    accrualTemplate("AT-OVR", { manualOverride: true }),
  ]);
  const first = await previewPer(db, perPostAccruals, periodScope());
  assertEqual(db.all("journal_entries").length, 0, "the preview posted nothing");
  assert(first.result.proposals.length > 0, "though it proposed work");

  const { preview, applied } = await applyPer(db, perPostAccruals, periodScope());
  assertEqual(
    canonicalJson(toJsonValue(preview.result.proposals)),
    canonicalJson(toJsonValue(applied.result.proposals)),
    "the same proposals",
  );
  assertEqual(
    canonicalJson(toJsonValue(preview.result.skips)),
    canonicalJson(toJsonValue(applied.result.skips)),
    "and the same skips",
  );
});

test("per accruals, another client in the same firm sees none of these templates", async () => {
  const db = perDb();
  db.seed("accrual_templates", [accrualTemplate("AT-RENT")]);
  const preview = await previewPer(
    db,
    perPostAccruals,
    periodScope("2026-01-01", "CLI-A2"),
  );
  assertEqual(preview.result.totals.candidates, 0, "no candidates");
  assertEqual(preview.result.proposals.length, 0, "and nothing proposed");
});
