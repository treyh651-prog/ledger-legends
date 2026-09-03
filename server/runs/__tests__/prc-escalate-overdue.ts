/**
 * PRAC-ESCALATE-OVERDUE tests.
 *
 * The ladder is the whole run, so most of these walk it: which rung a given age
 * reaches, which rungs fire on the way there, who each one reaches, and what a
 * moved due date does to the climb. The workload notice is asserted separately,
 * because it is a per member roll up rather than a per task decision.
 */

import { assert, assertEqual, test } from "./harness";
import { isFieldWrite, isRowInsert } from "../contract";
import {
  CLIENT_A1,
  LEAD,
  PARTNER,
  PERIOD,
  PREPARER,
  applyPractice,
  escalationsOf,
  escalationRow,
  lockJanuary,
  noticeRow,
  noticesOf,
  practiceDb,
  practiceScope,
  practiceState,
  previewPractice,
  shapeOf,
  task,
  tasksOf,
} from "./prc-fixtures";
import {
  escalationIdOf,
  noticeIdOf,
  prcEscalateOverdue,
} from "../runs/prc-escalate-overdue";

const AS_OF = "2026-02-20";

/** The scope with an explicit as of day, so the ladder is not calendar bound. */
function escScope(extra: Partial<{ asOfDate: string; period: string }> = {}) {
  return { clientId: CLIENT_A1, period: PERIOD, asOfDate: AS_OF, ...extra };
}

/** One overdue task at a chosen age. */
function overdue(dueDate: string, extra = {}) {
  return task("TSK-BANKREC", "BANKREC", dueDate, extra);
}

test("preview and apply propose the same rows", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [overdue("2026-02-10")]);
  const { preview, applied } = await applyPractice(db, prcEscalateOverdue, escScope());
  assertEqual(
    shapeOf(preview.result?.proposals ?? []),
    shapeOf(applied.result?.proposals ?? []),
    "the ladder climbs the same way on both passes",
  );
  assert(escalationsOf(db).length > 0, "and rungs landed");
});

test("ids are derived, so a rerun is a no operation", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [overdue("2026-02-10")]);
  await applyPractice(db, prcEscalateOverdue, escScope());
  const count = escalationsOf(db).length;
  const again = await previewPractice(db, prcEscalateOverdue, escScope());
  assertEqual((again.result?.proposals ?? []).length, 0, "nothing fires twice");
  assertEqual(escalationsOf(db).length, count, "and no duplicate rungs appeared");
  assert(
    (again.result?.skips ?? []).some((s) => s.detail.includes("rung_already_fired")),
    "the run says the rung has already fired",
  );
});

test("the notice id is derived from the client, the day, and the member", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [overdue("2026-02-10")]);
  await applyPractice(db, prcEscalateOverdue, escScope());
  assertEqual(
    noticesOf(db)[0].id,
    noticeIdOf(CLIENT_A1, AS_OF, PREPARER),
    "the notice sits at the derived id",
  );
  assertEqual(
    escalationsOf(db)[0].id,
    escalationIdOf(CLIENT_A1, AS_OF, 1),
    "and the first rung is ordinal one",
  );
});

test("two periods do not collide because the period is in the scope hash", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [overdue("2026-02-10")]);
  const a = await previewPractice(db, prcEscalateOverdue, escScope());
  const b = await previewPractice(db, prcEscalateOverdue, escScope({ period: "2026-02-01" }));
  assert(a.scopeHash !== b.scopeHash, "January and February are different scopes");
});

test("an overridden task is never escalated", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [overdue("2026-02-10", { manualOverride: true })]);
  const out = await previewPractice(db, prcEscalateOverdue, escScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "no rung fired");
  assert(
    (out.result?.skips ?? []).some((s) => s.reason === "manual_override"),
    "the run reports the override",
  );
});

test("an overridden notice is never rewritten", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [overdue("2026-02-10")]);
  db.seed("workload_notices", [
    noticeRow(noticeIdOf(CLIENT_A1, AS_OF, PREPARER), PREPARER, {
      asOfDate: AS_OF,
      overdueCount: 99,
      manualOverride: true,
    }),
  ]);
  await applyPractice(db, prcEscalateOverdue, escScope());
  assertEqual(noticesOf(db)[0].overdueCount, 99, "the hand set count stands");
});

test("a locked period still escalates, because the ladder is about a person", async () => {
  const db = practiceDb();
  lockJanuary(db);
  db.seed("practice_tasks", [overdue("2026-02-10")]);
  const { applied } = await applyPractice(db, prcEscalateOverdue, escScope());
  assert(escalationsOf(db).length > 0, "the rung fired anyway");
  assert(
    (applied.result?.skips ?? []).every((s) => s.reason !== "locked_period"),
    "and no skip blamed the lock, because no ledger row was written",
  );
});

test("a paused engagement escalates nothing", async () => {
  const db = practiceDb();
  db.seed("practice_states", [practiceState({ engagementPaused: true })]);
  db.seed("practice_tasks", [overdue("2026-01-05")]);
  const out = await previewPractice(db, prcEscalateOverdue, escScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "no rung fired");
  assertEqual((out.result?.skips ?? []).length, 1, "one skip, about the client");
  assertEqual(
    (out.result?.skips ?? [])[0].detail,
    "engagement_paused, so no rung fired",
    "and it names the pause",
  );
});

test("a task not yet past the first rung is left alone", async () => {
  const db = practiceDb();
  // The ladder is widened to three days, so a task one day past its date sits
  // below the first rung and nothing should reach anybody.
  db.seed("practice_states", [practiceState({ escalationAssigneeDays: 3 })]);
  db.seed("practice_tasks", [overdue("2026-02-19")]);
  const out = await previewPractice(db, prcEscalateOverdue, escScope());
  assertEqual(
    (out.result?.proposals ?? []).filter(isRowInsert).filter(
      (p) => p.table === "practice_escalations",
    ).length,
    0,
    "nothing fires below the first rung",
  );
  assert(
    (out.result?.skips ?? []).some((sk) => sk.detail.includes("not_overdue enough")),
    "and the run says the task is not old enough yet",
  );
});

test("every rung on the way up fires, not just the one reached", async () => {
  const db = practiceDb();
  // Eight days overdue passes assignee at one, lead at three, partner at seven.
  db.seed("practice_tasks", [overdue("2026-02-12")]);
  await applyPractice(db, prcEscalateOverdue, escScope());
  const rungs = escalationsOf(db).map((e) => e.rung);
  assertEqual(
    JSON.stringify(rungs),
    JSON.stringify(["assignee", "lead", "partner"]),
    "the climb is recorded rung by rung rather than as one jump",
  );
  assertEqual(tasksOf(db)[0].escalationRung, "partner", "and the task rests at the top");
});

test("each rung reaches the right person", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [overdue("2026-02-01")]);
  await applyPractice(db, prcEscalateOverdue, escScope());
  const byRung = new Map(escalationsOf(db).map((e) => [e.rung, e.recipientId]));
  assertEqual(byRung.get("assignee"), PREPARER, "the assignee rung reaches the assignee");
  assertEqual(byRung.get("lead"), LEAD, "the lead rung reaches the lead");
  assertEqual(byRung.get("partner"), PARTNER, "the partner rung reaches the partner");
  assert(byRung.has("at_risk"), "and nineteen days over reaches the at risk rung");
});

test("a blocked task escalates against the owner of what is blocking it", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [
    task("TSK-BANKREC", "BANKREC", "2026-02-05", { assigneeId: LEAD, state: "open" }),
    task("TSK-TIEOUT", "TIEOUT", "2026-02-19", {
      state: "blocked",
      blockedByCode: "BANKREC",
      assigneeId: PREPARER,
    }),
  ]);
  await applyPractice(db, prcEscalateOverdue, escScope());
  const blocked = escalationsOf(db).find(
    (e) => e.taskId === "TSK-TIEOUT" && e.rung === "assignee",
  );
  assertEqual(blocked?.recipientId, LEAD, "the rung went to the blocking task's owner");
  assertEqual(
    blocked?.recipientRole,
    "predecessor_owner",
    "and the row says that is the role it reached",
  );
});

test("an out of office assignee skips the assignee rung to the lead", async () => {
  const db = practiceDb();
  db.seed("practice_states", [practiceState({ outOfOfficeMemberIds: [PREPARER] })]);
  db.seed("practice_tasks", [overdue("2026-02-19")]);
  await applyPractice(db, prcEscalateOverdue, escScope());
  const first = escalationsOf(db)[0];
  assertEqual(first.rung, "assignee", "the rung reached is still the first one");
  assertEqual(first.recipientId, LEAD, "but the person reached is the lead");
  assert(
    first.reason.includes("out of office"),
    "and the reason on the row says why",
  );
});

test("a due date moved after the last rung resets the ladder and logs the slide", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [
    overdue("2026-02-15", {
      escalationRung: "lead",
      lastEscalatedOn: "2026-02-01",
      dueDateSetOn: "2026-02-05",
    }),
  ]);
  await applyPractice(db, prcEscalateOverdue, escScope());
  const rows = escalationsOf(db);
  assertEqual(rows.length, 1, "one row, and it is the reset");
  assertEqual(rows[0].rung, "due_date_reset", "the reset is a rung of its own");
  assertEqual(rows[0].priorRung, "lead", "and it records where the ladder was");
  assertEqual(rows[0].resetToDueDate, "2026-02-15", "and where the date moved to");
  assertEqual(tasksOf(db)[0].escalationRung, "none", "the task is back at the bottom");
});

test("one workload notice per member, carrying the count and the oldest", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [
    task("TSK-A", "BANKREC", "2026-02-01", { assigneeId: PREPARER }),
    task("TSK-B", "TIEOUT", "2026-02-10", { assigneeId: PREPARER }),
    task("TSK-C", "REVIEW", "2026-02-12", { assigneeId: LEAD, role: "reviewer" }),
  ]);
  await applyPractice(db, prcEscalateOverdue, escScope());
  const notices = noticesOf(db);
  assertEqual(notices.length, 2, "two members carry overdue work");
  const prep = notices.find((n) => n.memberId === PREPARER);
  assertEqual(prep?.overdueCount, 2, "the preparer carries two");
  assertEqual(prep?.oldestDueDate, "2026-02-01", "and the oldest is the first of February");
  assertEqual(prep?.oldestTaskId, "TSK-A", "which the notice names");
  assertEqual(prep?.maxDaysOverdue, 19, "nineteen days past");
});

test("unassigned overdue work still lands on somebody's notice", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [overdue("2026-02-10", { assigneeId: null })]);
  await applyPractice(db, prcEscalateOverdue, escScope());
  const notices = noticesOf(db);
  assertEqual(notices.length, 1, "the work is counted rather than dropped");
  assertEqual(notices[0].memberId, LEAD, "and it lands on the lead");
  assertEqual(notices[0].memberRole, "lead", "in the lead's own role");
});

test("a completed task is not overdue, however old the due date is", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [
    overdue("2026-01-02", { state: "complete", completedOn: "2026-01-02" }),
  ]);
  const out = await previewPractice(db, prcEscalateOverdue, escScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "finished work escalates nothing");
});

test("a rung that already fired is refreshed onto the notice but not fired again", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [
    overdue("2026-02-10", { escalationRung: "at_risk", lastEscalatedOn: "2026-02-19" }),
  ]);
  db.seed("practice_escalations", [escalationRow("ESC-OLD", "TSK-BANKREC")]);
  await applyPractice(db, prcEscalateOverdue, escScope());
  assertEqual(escalationsOf(db).length, 1, "only the seeded history is there");
  assertEqual(noticesOf(db).length, 1, "but the person is still told they are behind");
  assertEqual(noticesOf(db)[0].overdueCount, 1, "and the count is right");
});

test("a notice that has changed moves fields rather than stacking a second row", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [overdue("2026-02-10")]);
  await applyPractice(db, prcEscalateOverdue, escScope());
  db.seed("practice_tasks", [
    ...db.all("practice_tasks"),
    task("TSK-EXTRA", "TIEOUT", "2026-02-11"),
  ]);
  const out = await previewPractice(db, prcEscalateOverdue, escScope());
  const moves = (out.result?.proposals ?? [])
    .filter(isFieldWrite)
    .filter((p) => p.table === "workload_notices");
  assertEqual(moves.length, 1, "the existing notice moved rather than a second landing");
  assertEqual(moves[0].after.overdueCount, 2, "carrying the new count");
  assertEqual(moves[0].before.overdueCount, 1, "and the old one, so the move is reversible");
  assertEqual(noticesOf(db).length, 1, "there is still one notice for the member");
});
