/**
 * PER-POST-RECURRING tests.
 *
 * The run has one promise that matters more than the rest: one entry per
 * template per period, no matter how many times it is asked. Everything else
 * here is the shape of the entry it produces and the reasons it declines.
 */

import { isJournalEntry } from "../contract";
import { canonicalJson, toJsonValue } from "../ids";
import { perPostRecurring } from "../runs/per-post-recurring";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  PERIOD,
  applyPer,
  balanceOf,
  generatedTemplate,
  linesOf,
  periodScope,
  previewPer,
  perDb,
  reasons,
  skippedFor,
  split,
  sumLines,
} from "./per-fixtures";
import { assert, assertEqual, show, test } from "./harness";

/** Rent: 2500.00 of expense against the accrued liability account. */
function seedRent(db: ReturnType<typeof perDb>): void {
  db.seed("recurring_templates", [
    generatedTemplate("RT-RENT", { name: "Office rent" }),
  ]);
  db.seed("recurring_splits", [
    split("RS-RENT-1", "RT-RENT", 1, "6100", {
      fixedAmountCents: BigInt(250000),
    }),
    split("RS-RENT-2", "RT-RENT", 2, "2200", {
      fixedAmountCents: BigInt(-250000),
    }),
  ]);
}

test("per recurring, a monthly template posts one balanced entry on the last day", async () => {
  const db = perDb();
  seedRent(db);
  const { applied } = await applyPer(db, perPostRecurring, periodScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );

  const entries = db.all("journal_entries");
  assertEqual(entries.length, 1, "one entry for one template");
  assertEqual(entries[0].entryDate, "2026-01-31", "posted on the period end");
  assertEqual(entries[0].sourceTable, "recurring_templates", "source table");
  assertEqual(entries[0].sourceRowId, "RT-RENT", "source row");

  const own = linesOf(db, entries[0].id);
  assertEqual(own.length, 2, "two lines");
  assertEqual(sumLines(own), BigInt(0), "the entry balances");
  assertEqual(balanceOf(db, "6100"), BigInt(250000), "rent expense took the debit");
  assertEqual(balanceOf(db, "2200"), BigInt(-250000), "the liability took the credit");
});

test("per recurring, the same period twice posts nothing the second time", async () => {
  const db = perDb();
  seedRent(db);
  await applyPer(db, perPostRecurring, periodScope());
  const second = await applyPer(db, perPostRecurring, periodScope());

  assertEqual(db.all("journal_entries").length, 1, "still one entry");
  assertEqual(second.applied.result.proposals.length, 0, "nothing left to propose");
  assert(
    skippedFor(second.preview, "RT-RENT", "already_applied"),
    `expected already_applied, got ${show(reasons(second.preview))}`,
  );
});

test("per recurring, the next period posts its own entry", async () => {
  const db = perDb();
  seedRent(db);
  await applyPer(db, perPostRecurring, periodScope());
  await applyPer(db, perPostRecurring, periodScope("2026-02-01"));

  const entries = db.all("journal_entries").slice().sort((a, b) =>
    a.entryDate < b.entryDate ? -1 : 1,
  );
  assertEqual(entries.length, 2, "one entry per period");
  assertEqual(entries[0].entryDate, "2026-01-31", "January");
  assertEqual(entries[1].entryDate, "2026-02-28", "February, on its own last day");
  assert(entries[0].id !== entries[1].id, "and the derived ids differ");
});

test("per recurring, a day_n rule posts on that day and clamps to the month", async () => {
  const db = perDb();
  db.seed("recurring_templates", [
    generatedTemplate("RT-SUB", {
      postingDateRule: "day_n",
      dayOfMonth: 31,
    }),
  ]);
  db.seed("recurring_splits", [
    split("RS-SUB-1", "RT-SUB", 1, "6300", { fixedAmountCents: BigInt(9900) }),
    split("RS-SUB-2", "RT-SUB", 2, "2200", { fixedAmountCents: BigInt(-9900) }),
  ]);
  await applyPer(db, perPostRecurring, periodScope("2026-02-01"));
  const entries = db.all("journal_entries");
  assertEqual(entries.length, 1, "one entry");
  assertEqual(entries[0].entryDate, "2026-02-28", "the 31st clamps to the 28th");
});

test("per recurring, basis point splits use the driver and the remainder closes it", async () => {
  const db = perDb();
  db.seed("recurring_templates", [
    generatedTemplate("RT-INS", { driverAmountCents: BigInt(100000) }),
  ]);
  db.seed("recurring_splits", [
    split("RS-INS-1", "RT-INS", 1, "6200", { percentBps: 3333 }),
    split("RS-INS-2", "RT-INS", 2, "6300", { percentBps: 3333 }),
    split("RS-INS-3", "RT-INS", 3, "2200", { isRemainder: true }),
  ]);
  const { applied } = await applyPer(db, perPostRecurring, periodScope());
  const entries = db.all("journal_entries");
  assertEqual(entries.length, 1, "one entry");
  const own = linesOf(db, entries[0].id);
  assertEqual(sumLines(own), BigInt(0), "the entry balances to the cent");
  assertEqual(balanceOf(db, "6200"), BigInt(33330), "3333 bps of 100000");
  assertEqual(balanceOf(db, "6300"), BigInt(33330), "and the same again");
  assertEqual(balanceOf(db, "2200"), BigInt(-66660), "the remainder takes the rest");
  assertEqual(applied.result.totals.netCents, BigInt(0), "reported net is zero");
});

test("per recurring, basis point splits with no driver amount are an error", async () => {
  const db = perDb();
  db.seed("recurring_templates", [generatedTemplate("RT-NODRIVER")]);
  db.seed("recurring_splits", [
    split("RS-ND-1", "RT-NODRIVER", 1, "6200", { percentBps: 10000 }),
    split("RS-ND-2", "RT-NODRIVER", 2, "2200", { isRemainder: true }),
  ]);
  const preview = await previewPer(db, perPostRecurring, periodScope());
  assertEqual(preview.status, "refused", "an error refuses the run");
  assert(
    preview.result.errors.some(
      (e) => e.code === "PER_TEMPLATE_MISSING_DRIVER_AMOUNT",
    ),
    `expected the driver error, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
});

test("per recurring, splits that do not sum to zero are reported, not plugged", async () => {
  const db = perDb();
  db.seed("recurring_templates", [generatedTemplate("RT-BAD")]);
  db.seed("recurring_splits", [
    split("RS-BAD-1", "RT-BAD", 1, "6100", { fixedAmountCents: BigInt(250000) }),
    split("RS-BAD-2", "RT-BAD", 2, "2200", { fixedAmountCents: BigInt(-240000) }),
  ]);
  const preview = await previewPer(db, perPostRecurring, periodScope());
  assert(
    preview.result.errors.some((e) => e.code === "PER_TEMPLATE_UNBALANCED"),
    `expected the unbalanced error, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "and nothing was posted");
});

test("per recurring, a quarterly template posts only in its own months", async () => {
  const db = perDb();
  db.seed("recurring_templates", [
    generatedTemplate("RT-QTR", { cadence: "quarterly", startDate: "2026-01-01" }),
  ]);
  db.seed("recurring_splits", [
    split("RS-Q-1", "RT-QTR", 1, "6300", { fixedAmountCents: BigInt(30000) }),
    split("RS-Q-2", "RT-QTR", 2, "2200", { fixedAmountCents: BigInt(-30000) }),
  ]);
  const january = await previewPer(db, perPostRecurring, periodScope("2026-01-01"));
  assertEqual(january.result.proposals.length, 1, "January is a quarter month");
  const february = await previewPer(db, perPostRecurring, periodScope("2026-02-01"));
  assertEqual(february.result.proposals.length, 0, "February is not");
  assert(
    skippedFor(february, "RT-QTR", "missing_prerequisite"),
    `expected not due, got ${show(reasons(february))}`,
  );
  const april = await previewPer(db, perPostRecurring, periodScope("2026-04-01"));
  assertEqual(april.result.proposals.length, 1, "April is the next one");
});

test("per recurring, a weekly cadence is reported rather than guessed", async () => {
  const db = perDb();
  db.seed("recurring_templates", [
    generatedTemplate("RT-WK", { cadence: "weekly" }),
  ]);
  db.seed("recurring_splits", [
    split("RS-W-1", "RT-WK", 1, "6300", { fixedAmountCents: BigInt(1000) }),
    split("RS-W-2", "RT-WK", 2, "2200", { fixedAmountCents: BigInt(-1000) }),
  ]);
  const preview = await previewPer(db, perPostRecurring, periodScope());
  assert(
    skippedFor(preview, "RT-WK", "ambiguous_candidate"),
    `expected ambiguous, got ${show(reasons(preview))}`,
  );
  assertEqual(preview.result.proposals.length, 0, "nothing was invented");
});

test("per recurring, a template outside its start and end dates is skipped", async () => {
  const db = perDb();
  db.seed("recurring_templates", [
    generatedTemplate("RT-LATER", { startDate: "2026-06-01" }),
    generatedTemplate("RT-ENDED", {
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    }),
  ]);
  const preview = await previewPer(db, perPostRecurring, periodScope());
  assert(skippedFor(preview, "RT-LATER", "missing_prerequisite"), "not started");
  assert(skippedFor(preview, "RT-ENDED", "missing_prerequisite"), "ended");
  assertEqual(preview.result.proposals.length, 0, "neither posts");
});

test("per recurring, an inactive template and a transaction match template stand aside", async () => {
  const db = perDb();
  seedRent(db);
  db.seed("recurring_templates", [
    generatedTemplate("RT-OFF", { isActive: false }),
    generatedTemplate("RT-MATCH", { matchKind: "transaction_match" }),
  ]);
  const preview = await previewPer(db, perPostRecurring, periodScope());
  assert(skippedFor(preview, "RT-OFF", "missing_prerequisite"), "the inactive one");
  assert(
    !preview.result.skips.some((s) => s.rowId === "RT-MATCH"),
    "a transaction match template is not even a candidate for this run",
  );
  assertEqual(preview.result.proposals.length, 1, "only rent posts");
});

test("per recurring, an overridden template is never posted over", async () => {
  const db = perDb();
  seedRent(db);
  db.seed("recurring_templates", [
    generatedTemplate("RT-OVR", { manualOverride: true }),
  ]);
  const { applied } = await applyPer(db, perPostRecurring, periodScope());
  assert(skippedFor(applied, "RT-OVR", "manual_override"), "reported as a skip");
  assertEqual(applied.overriddenInScope, 1, "and counted on the outcome");
  assertEqual(db.all("journal_entries").length, 1, "only the clean template posted");
});

test("per recurring, a locked period is skipped and never thrown", async () => {
  const db = perDb();
  seedRent(db);
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await applyPer(db, perPostRecurring, periodScope());
  assert(
    skippedFor(applied, "RT-RENT", "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "and nothing reached the books");
});

test("per recurring, preview and apply produce identical proposals", async () => {
  const db = perDb();
  seedRent(db);
  db.seed("recurring_templates", [
    generatedTemplate("RT-OVR", { manualOverride: true }),
    generatedTemplate("RT-WK", { cadence: "weekly" }),
  ]);
  const { preview, applied } = await applyPer(db, perPostRecurring, periodScope());
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

test("per recurring, the entry id is derived from the template and the period", async () => {
  const db = perDb();
  seedRent(db);
  const preview = await previewPer(db, perPostRecurring, periodScope());
  const entries = preview.result.proposals.filter(isJournalEntry);
  assertEqual(entries.length, 1, "one entry proposal");
  const first = entries[0].targetId;
  const again = await previewPer(db, perPostRecurring, periodScope("2026-01-17"));
  const secondEntries = again.result.proposals.filter(isJournalEntry);
  assertEqual(
    secondEntries[0].targetId,
    first,
    "any day inside the period derives the same id",
  );
});

test("per recurring, another client in the same firm is untouched", async () => {
  const db = perDb();
  seedRent(db);
  const preview = await previewPer(db, perPostRecurring, periodScope(PERIOD, "CLI-A2"));
  assertEqual(preview.result.totals.candidates, 0, "no candidates for the neighbour");
  assertEqual(preview.result.proposals.length, 0, "and nothing proposed");
});
