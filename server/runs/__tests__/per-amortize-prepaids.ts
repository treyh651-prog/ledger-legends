/**
 * PER-AMORTIZE-PREPAID tests.
 *
 * The interesting part of this run is the allocation table. It is built once
 * from the service window, written down, and read every month after that, so
 * the tests check both halves: the day weighted arithmetic that builds it, and
 * the promise that a stored table is used rather than recomputed.
 */

import { isFieldWrite, isRowInsert } from "../contract";
import { canonicalJson, toJsonValue } from "../ids";
import {
  isAllocationInsert,
  perAmortizePrepaids,
} from "../runs/per-amortize-prepaids";
import type { DeferralLineRow } from "../tables";
import { CLIENT_A1, FIRM_A, lock } from "./fixtures";
import {
  applyPer,
  balanceOf,
  linesOf,
  perDb,
  periodScope,
  prepaid,
  previewPer,
  reasons,
  skippedFor,
  sumLines,
} from "./per-fixtures";
import { assert, assertEqual, show, test } from "./harness";

function tableFor(
  db: ReturnType<typeof perDb>,
  scheduleId: string,
): DeferralLineRow[] {
  return db
    .all("deferral_lines")
    .filter((l) => l.scheduleId === scheduleId)
    .slice()
    .sort((a, b) => a.periodNumber - b.periodNumber);
}

test("per prepaid, a clean twelve month policy builds a table and releases January", async () => {
  const db = perDb();
  db.seed("deferral_schedules", [prepaid("DS-INS")]);
  const { applied } = await applyPer(db, perAmortizePrepaids, periodScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );

  const table = tableFor(db, "DS-INS");
  assertEqual(table.length, 12, "twelve allocation lines");
  assertEqual(
    table.reduce((acc, l) => acc + l.amountCents, BigInt(0)),
    BigInt(120000),
    "and they add to the policy total",
  );
  // 120000 over 365 days, 31 of them in January.
  assertEqual(table[0].amountCents, BigInt(10191), "January is day weighted");
  assertEqual(table[0].status, "posted", "and January is marked posted");
  assertEqual(table[1].status, "scheduled", "February is still waiting");

  const entries = db.all("journal_entries");
  assertEqual(entries.length, 1, "one release entry");
  assertEqual(entries[0].entryDate, "2026-01-31", "dated the period end");
  assertEqual(sumLines(linesOf(db, entries[0].id)), BigInt(0), "it balances");
  assertEqual(balanceOf(db, "6200"), BigInt(10191), "expense took the debit");
  assertEqual(balanceOf(db, "1310"), BigInt(-10191), "the prepaid asset came down");
});

test("per prepaid, the last period releases the residual so the schedule foots", async () => {
  const db = perDb();
  db.seed("deferral_schedules", [prepaid("DS-INS")]);
  let released = BigInt(0);
  for (let month = 1; month <= 12; month += 1) {
    const period = `2026-${month < 10 ? `0${String(month)}` : String(month)}-01`;
    await applyPer(db, perAmortizePrepaids, periodScope(period));
  }
  const table = tableFor(db, "DS-INS");
  for (const line of table) released += line.amountCents;
  assertEqual(released, BigInt(120000), "the table still adds to the total");
  assert(
    table.every((l) => l.status === "posted"),
    "every period released",
  );
  assertEqual(balanceOf(db, "1310"), BigInt(-120000), "the prepaid is fully used");
  assertEqual(balanceOf(db, "6200"), BigInt(120000), "and all of it is expense");
  assertEqual(
    sumLines(db.all("journal_lines")),
    BigInt(0),
    "the books foot after twelve months",
  );
});

test("per prepaid, a mid month policy weights both partial months", async () => {
  const db = perDb();
  db.seed("deferral_schedules", [
    prepaid("DS-MID", {
      serviceStart: "2026-01-15",
      serviceEnd: "2027-01-14",
      periods: 13,
    }),
  ]);
  await applyPer(db, perAmortizePrepaids, periodScope());
  const table = tableFor(db, "DS-MID");
  assertEqual(table.length, 13, "thirteen months are touched");
  // Seventeen days of January out of 365.
  assertEqual(table[0].amountCents, BigInt(5589), "the opening stub");
  assertEqual(table[0].periodStart, "2026-01-01", "stated as a whole month");
  assertEqual(table[12].periodEnd, "2027-01-31", "and the closing month");
  const whole = table[1].amountCents;
  assert(
    whole > table[0].amountCents && whole > table[12].amountCents,
    `a whole month ${whole.toString()} is larger than either stub`,
  );
  assertEqual(
    table.reduce((acc, l) => acc + l.amountCents, BigInt(0)),
    BigInt(120000),
    "the two stubs and eleven whole months add to the total",
  );
});

test("per prepaid, the stored table is used rather than rebuilt", async () => {
  const db = perDb();
  db.seed("deferral_schedules", [prepaid("DS-INS")]);
  await applyPer(db, perAmortizePrepaids, periodScope());
  const february = await previewPer(db, perAmortizePrepaids, periodScope("2026-02-01"));
  assertEqual(
    february.result.proposals.filter(isAllocationInsert).length,
    0,
    "no second table is inserted",
  );
  const { applied } = await applyPer(db, perAmortizePrepaids, periodScope("2026-02-01"));
  assertEqual(applied.status !== "refused", true, "February released");
  assertEqual(tableFor(db, "DS-INS").length, 12, "still twelve lines");
  assertEqual(db.all("journal_entries").length, 2, "two release entries");
});

test("per prepaid, releasing the same period twice posts nothing the second time", async () => {
  const db = perDb();
  db.seed("deferral_schedules", [prepaid("DS-INS")]);
  await applyPer(db, perAmortizePrepaids, periodScope());
  const second = await applyPer(db, perAmortizePrepaids, periodScope());
  assertEqual(db.all("journal_entries").length, 1, "one entry only");
  assertEqual(second.applied.result.proposals.length, 0, "nothing to propose");
  assert(
    second.preview.result.skips.some((s) => s.reason === "already_applied"),
    `expected already_applied, got ${show(reasons(second.preview))}`,
  );
});

test("per prepaid, a schedule superseded by a document does not release", async () => {
  const db = perDb();
  db.seed("deferral_schedules", [
    prepaid("DS-SUP", { linkedDocumentId: "DOC-BILL-9" }),
  ]);
  const preview = await previewPer(db, perAmortizePrepaids, periodScope());
  assert(
    skippedFor(preview, "DS-SUP", "superseded_version"),
    `expected superseded, got ${show(reasons(preview))}`,
  );
  assertEqual(preview.result.proposals.length, 0, "and nothing was proposed");
});

test("per prepaid, a period before the service starts or after it ends is skipped", async () => {
  const db = perDb();
  db.seed("deferral_schedules", [prepaid("DS-INS")]);
  const before = await previewPer(db, perAmortizePrepaids, periodScope("2025-12-01"));
  assert(
    skippedFor(before, "DS-INS", "missing_prerequisite"),
    `expected before start, got ${show(reasons(before))}`,
  );
  const after = await previewPer(db, perAmortizePrepaids, periodScope("2027-03-01"));
  assert(
    skippedFor(after, "DS-INS", "already_applied"),
    `expected complete, got ${show(reasons(after))}`,
  );
});

test("per prepaid, a stored table that does not foot is reported, not patched", async () => {
  const db = perDb();
  db.seed("deferral_schedules", [prepaid("DS-BAD")]);
  db.seed("deferral_lines", [
    {
      id: "DL-BAD-1",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      scheduleId: "DS-BAD",
      scheduleVersion: 1,
      periodNumber: 1,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      amountCents: BigInt(10000),
      remainingAfterCents: BigInt(110000),
      status: "scheduled",
      postedEntryId: null,
      postedRunId: null,
      postedAt: null,
      reversalEntryId: null,
      linkedDocumentId: null,
      manualOverride: false,
      version: 1,
    },
  ]);
  const preview = await previewPer(db, perAmortizePrepaids, periodScope());
  assert(
    preview.result.errors.some((e) => e.code === "PER_PREPAID_LINES_DO_NOT_FOOT"),
    `expected the footing error, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
  assertEqual(preview.status, "refused", "an error refuses the run");
});

test("per prepaid, an overridden schedule and an overridden line are both left alone", async () => {
  const db = perDb();
  db.seed("deferral_schedules", [
    prepaid("DS-OVR", { manualOverride: true }),
    prepaid("DS-LINE"),
  ]);
  db.seed("deferral_lines", [
    {
      id: "DL-LINE-1",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      scheduleId: "DS-LINE",
      scheduleVersion: 1,
      periodNumber: 1,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      amountCents: BigInt(120000),
      remainingAfterCents: BigInt(0),
      status: "scheduled",
      postedEntryId: null,
      postedRunId: null,
      postedAt: null,
      reversalEntryId: null,
      linkedDocumentId: null,
      manualOverride: true,
      version: 1,
    },
  ]);
  const { applied } = await applyPer(db, perAmortizePrepaids, periodScope());
  assert(skippedFor(applied, "DS-OVR", "manual_override"), "the schedule");
  assert(skippedFor(applied, "DL-LINE-1", "manual_override"), "and the line");
  assertEqual(db.all("journal_entries").length, 0, "neither released");
  assertEqual(applied.overriddenInScope, 1, "the schedule is counted as overridden");
});

test("per prepaid, a locked period is skipped and never thrown", async () => {
  const db = perDb();
  db.seed("deferral_schedules", [prepaid("DS-INS")]);
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await applyPer(db, perAmortizePrepaids, periodScope());
  assert(
    applied.result.skips.some((s) => s.reason === "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
  assertEqual(db.all("journal_entries").length, 0, "no entry reached the books");
});

test("per prepaid, preview writes nothing and matches the apply proposal for proposal", async () => {
  const db = perDb();
  db.seed("deferral_schedules", [prepaid("DS-INS")]);
  const preview = await previewPer(db, perAmortizePrepaids, periodScope());
  assertEqual(db.all("deferral_lines").length, 0, "the preview inserted no lines");
  assertEqual(db.all("journal_entries").length, 0, "and posted no entry");
  assert(
    preview.result.proposals.some(isRowInsert),
    "though it did propose the table",
  );
  assert(
    preview.result.proposals.some(isFieldWrite),
    "and the mark posted write",
  );

  const fresh = perDb();
  fresh.seed("deferral_schedules", [prepaid("DS-INS")]);
  const { preview: p2, applied } = await applyPer(
    fresh,
    perAmortizePrepaids,
    periodScope(),
  );
  assertEqual(
    canonicalJson(toJsonValue(p2.result.proposals)),
    canonicalJson(toJsonValue(applied.result.proposals)),
    "preview equals apply",
  );
});

test("per prepaid, a deferred revenue schedule is out of this run's scope", async () => {
  const db = perDb();
  db.seed("deferral_schedules", [
    prepaid("DS-REV", {
      kind: "deferred_revenue",
      balanceAccount: "2200",
      releaseAccount: "4100",
    }),
  ]);
  const preview = await previewPer(db, perAmortizePrepaids, periodScope());
  assertEqual(preview.result.totals.candidates, 0, "not a candidate");
  assertEqual(preview.result.proposals.length, 0, "and nothing proposed");
});
