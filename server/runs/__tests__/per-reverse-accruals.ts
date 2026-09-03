/**
 * PER-REVERSE-ACCRUALS tests.
 *
 * The run opens a period by undoing what the last one accrued. Line for line is
 * the whole promise: same accounts, same dimensions, opposite signs, dated the
 * first day of the new period. The two ways it is allowed to decline are an
 * accrual a real document has already replaced, and an accrual something has
 * already reversed.
 */

import { isJournalEntry } from "../contract";
import { canonicalJson, toJsonValue } from "../ids";
import { perPostAccruals } from "../runs/per-post-accruals";
import { perReverseAccruals } from "../runs/per-reverse-accruals";
import type { JournalEntryRow } from "../tables";
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

/** January accrues, by running the real accrual run rather than by hand. */
async function accrueJanuary(
  db: ReturnType<typeof perDb>,
  extra: Parameters<typeof accrualTemplate>[1] = {},
): Promise<JournalEntryRow> {
  db.seed("accrual_templates", [accrualTemplate("AT-RENT", extra)]);
  await applyPer(db, perPostAccruals, periodScope("2026-01-01"));
  const posted = db.all("journal_entries").find((e) => e.entryDate === "2026-01-31");
  if (posted === undefined) throw new Error("January did not accrue");
  return posted;
}

test("per reverse, last period's accrual reverses line for line on the first", async () => {
  const db = perDb();
  const original = await accrueJanuary(db);
  const { applied } = await applyPer(db, perReverseAccruals, periodScope("2026-02-01"));
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `status ${applied.status}`,
  );

  const reversals = db.all("journal_entries").filter((e) => e.reversalOf !== null);
  assertEqual(reversals.length, 1, "one reversal");
  assertEqual(reversals[0].entryDate, "2026-02-01", "on the first of the new period");
  assertEqual(reversals[0].reversalOf, original.id, "pointing at the accrual");

  const before = linesOf(db, original.id);
  const after = linesOf(db, reversals[0].id);
  assertEqual(after.length, before.length, "the same number of lines");
  for (const line of before) {
    const mirror = after.find((l) => l.accountNumber === line.accountNumber);
    assert(mirror !== undefined, `account ${line.accountNumber} was reversed`);
    assertEqual(mirror?.amountCents, -line.amountCents, "with the opposite sign");
  }
  assertEqual(balanceOf(db, "6100"), BigInt(0), "the expense is back to zero");
  assertEqual(balanceOf(db, "2200"), BigInt(0), "and so is the liability");
  assertEqual(sumLines(db.all("journal_lines")), BigInt(0), "the books foot");
});

test("per reverse, dimensions and categories ride along unchanged", async () => {
  const db = perDb();
  db.seed("journal_entries", [
    entry("JE-DIM", "2026-01-31", {
      reversesOn: "2026-02-01",
      accrualTemplateId: "AT-DIM",
    }),
  ]);
  db.seed("journal_lines", [
    jline("JL-D1", "JE-DIM", "6100", BigInt(40000), "2026-01-31", {
      categoryId: "CAT-RENT",
      classId: "CLS-WEST",
      programId: "PRG-OPS",
    }),
    jline("JL-D2", "JE-DIM", "2200", BigInt(-40000), "2026-01-31", {
      categoryId: "CAT-RENT",
      classId: "CLS-WEST",
      programId: "PRG-OPS",
    }),
  ]);
  await applyPer(db, perReverseAccruals, periodScope("2026-02-01"));
  const reversal = db.all("journal_entries").find((e) => e.reversalOf === "JE-DIM");
  assert(reversal !== undefined, "the reversal posted");
  const lines = linesOf(db, reversal?.id ?? "");
  assertEqual(lines.length, 2, "two lines");
  for (const line of lines) {
    assertEqual(line.categoryId, "CAT-RENT", "the category came along");
    assertEqual(line.classId, "CLS-WEST", "and the class");
    assertEqual(line.programId, "PRG-OPS", "and the program");
  }
});

test("per reverse, an accrual superseded by a real document is not reversed", async () => {
  const db = perDb();
  db.seed("journal_entries", [
    entry("JE-SUP", "2026-01-31", {
      reversesOn: "2026-02-01",
      linkedDocumentId: "BILL-77",
    }),
  ]);
  db.seed("journal_lines", [
    jline("JL-S1", "JE-SUP", "6100", BigInt(50000), "2026-01-31"),
    jline("JL-S2", "JE-SUP", "2200", BigInt(-50000), "2026-01-31"),
  ]);
  const { applied } = await applyPer(db, perReverseAccruals, periodScope("2026-02-01"));
  assert(
    skippedFor(applied, "JE-SUP", "superseded_version"),
    `expected superseded, got ${show(reasons(applied))}`,
  );
  assertEqual(
    db.all("journal_entries").filter((e) => e.reversalOf !== null).length,
    0,
    "nothing was reversed",
  );
});

test("per reverse, an accrual something already reversed is left alone", async () => {
  const db = perDb();
  const original = await accrueJanuary(db);
  // A person reversed it by hand before the run got there.
  db.seed("journal_entries", [
    entry("JE-HAND", "2026-02-01", { reversalOf: original.id }),
  ]);
  const { applied } = await applyPer(db, perReverseAccruals, periodScope("2026-02-01"));
  assert(
    skippedFor(applied, original.id, "already_applied"),
    `expected already_applied, got ${show(reasons(applied))}`,
  );
  assertEqual(
    db.all("journal_entries").filter((e) => e.reversalOf === original.id).length,
    1,
    "there is still only one reversal",
  );
});

test("per reverse, running the same period twice reverses once", async () => {
  const db = perDb();
  await accrueJanuary(db);
  await applyPer(db, perReverseAccruals, periodScope("2026-02-01"));
  const second = await applyPer(db, perReverseAccruals, periodScope("2026-02-01"));
  assertEqual(
    db.all("journal_entries").filter((e) => e.reversalOf !== null).length,
    1,
    "still one reversal",
  );
  assertEqual(second.applied.result.proposals.length, 0, "nothing left to propose");
});

test("per reverse, an entry that carries no reversal date is not a candidate", async () => {
  const db = perDb();
  await accrueJanuary(db, { autoReverse: false });
  const preview = await previewPer(db, perReverseAccruals, periodScope("2026-02-01"));
  assertEqual(preview.result.totals.candidates, 0, "nothing is due to reverse");
  assertEqual(preview.result.proposals.length, 0, "and nothing was proposed");
});

test("per reverse, an original with no lines is reported rather than skipped quietly", async () => {
  const db = perDb();
  db.seed("journal_entries", [
    entry("JE-EMPTY", "2026-01-31", { reversesOn: "2026-02-01" }),
  ]);
  const preview = await previewPer(db, perReverseAccruals, periodScope("2026-02-01"));
  assert(
    preview.result.errors.some(
      (e) => e.code === "PER_REVERSAL_ORIGINAL_HAS_NO_LINES",
    ),
    `expected the empty error, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
  assertEqual(preview.status, "refused", "the run refuses");
});

test("per reverse, an original that does not balance is never mirrored", async () => {
  const db = perDb();
  db.seed("journal_entries", [
    entry("JE-BENT", "2026-01-31", { reversesOn: "2026-02-01" }),
  ]);
  db.seed("journal_lines", [
    jline("JL-X1", "JE-BENT", "6100", BigInt(50000), "2026-01-31"),
    jline("JL-X2", "JE-BENT", "2200", BigInt(-40000), "2026-01-31"),
  ]);
  const preview = await previewPer(db, perReverseAccruals, periodScope("2026-02-01"));
  assert(
    preview.result.errors.some((e) => e.code === "PER_REVERSAL_ORIGINAL_UNBALANCED"),
    `expected the unbalanced error, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
  assertEqual(
    preview.result.proposals.filter(isJournalEntry).length,
    0,
    "a bent entry does not get a bent mirror",
  );
});

test("per reverse, a locked new period is skipped and never thrown", async () => {
  const db = perDb();
  await accrueJanuary(db);
  db.seed("period_locks", [
    lock("LK-FEB", FIRM_A, CLIENT_A1, "2026-02-01", "2026-02-28"),
  ]);
  const { applied } = await applyPer(db, perReverseAccruals, periodScope("2026-02-01"));
  assert(
    applied.result.skips.some((s) => s.reason === "locked_period"),
    `expected locked_period, got ${show(reasons(applied))}`,
  );
  assertEqual(
    db.all("journal_entries").filter((e) => e.reversalOf !== null).length,
    0,
    "nothing was posted into the locked period",
  );
});

test("per reverse, an accrual due in a later period is not pulled forward", async () => {
  const db = perDb();
  await accrueJanuary(db);
  const preview = await previewPer(db, perReverseAccruals, periodScope("2026-03-01"));
  assertEqual(preview.result.totals.candidates, 0, "March sees nothing of January");
});

test("per reverse, preview equals apply", async () => {
  const db = perDb();
  await accrueJanuary(db);
  const { preview, applied } = await applyPer(
    db,
    perReverseAccruals,
    periodScope("2026-02-01"),
  );
  assertEqual(
    canonicalJson(toJsonValue(preview.result.proposals)),
    canonicalJson(toJsonValue(applied.result.proposals)),
    "the same proposals",
  );
});

test("per reverse, another client's accrual is never touched", async () => {
  const db = perDb();
  await accrueJanuary(db);
  const preview = await previewPer(
    db,
    perReverseAccruals,
    periodScope("2026-02-01", "CLI-A2"),
  );
  assertEqual(preview.result.totals.candidates, 0, "no candidates for the neighbour");
});
