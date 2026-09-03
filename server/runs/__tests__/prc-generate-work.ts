/**
 * PRAC-GENERATE-TASKS tests.
 *
 * The framework invariants, then the four things the generator has to get right:
 * which catalog rows land in this period, when each is due, who it goes to, and
 * what happens to work a person has already touched.
 */

import { assert, assertEqual, test } from "./harness";
import { isFieldWrite, isRowInsert } from "../contract";
import {
  CLIENT_A1,
  DECEMBER,
  LEAD,
  PARTNER,
  PERIOD,
  PERIOD_END,
  PREPARER,
  applyPractice,
  catalogRow,
  lockJanuary,
  practiceDb,
  practiceScope,
  practiceState,
  previewPractice,
  shapeOf,
  task,
  taskFor,
  tasksOf,
} from "./prc-fixtures";
import { prcGenerateWork, taskIdOf } from "../runs/prc-generate-work";

test("preview and apply propose the same rows", async () => {
  const db = practiceDb();
  const { preview, applied } = await applyPractice(db, prcGenerateWork, practiceScope());
  assertEqual(
    shapeOf(preview.result?.proposals ?? []),
    shapeOf(applied.result?.proposals ?? []),
    "the generated workload is the same on both passes",
  );
  assertEqual(tasksOf(db).length, 3, "the three monthly catalog rows landed");
});

test("ids are derived, so a rerun is a no operation", async () => {
  const db = practiceDb();
  await applyPractice(db, prcGenerateWork, practiceScope());
  const again = await previewPractice(db, prcGenerateWork, practiceScope());
  assertEqual((again.result?.proposals ?? []).length, 0, "nothing was proposed twice");
  assert(
    (again.result?.skips ?? []).every((s) => s.detail.includes("task_exists")),
    "every catalog code reports itself already there",
  );
  assertEqual(tasksOf(db).length, 3, "and no duplicate tasks appeared");
});

test("the task id is derived from the client, the period, and the catalog code", async () => {
  const db = practiceDb();
  await applyPractice(db, prcGenerateWork, practiceScope());
  assertEqual(
    taskFor(db, "BANKREC")?.id,
    taskIdOf(CLIENT_A1, PERIOD, "BANKREC"),
    "the row sits at the derived id",
  );
});

test("two periods do not collide because the period is in the scope hash", async () => {
  const db = practiceDb();
  const a = await previewPractice(db, prcGenerateWork, practiceScope(PERIOD));
  const b = await previewPractice(db, prcGenerateWork, practiceScope("2026-02-01"));
  assert(a.scopeHash !== b.scopeHash, "January and February are different scopes");
  const aIds = (a.result?.proposals ?? []).filter(isRowInsert).map((p) => p.rowId);
  const bIds = (b.result?.proposals ?? []).filter(isRowInsert).map((p) => p.rowId);
  assert(
    aIds.every((id) => !bIds.includes(id)),
    "and no task id is shared between them",
  );
});

test("an overridden task is never rewritten", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [
    task(taskIdOf(CLIENT_A1, PERIOD, "BANKREC"), "BANKREC", "2099-01-01", {
      manualOverride: true,
    }),
  ]);
  const out = await previewPractice(db, prcGenerateWork, practiceScope());
  assert(
    (out.result?.skips ?? []).some((s) => s.reason === "manual_override"),
    "the run reports the override",
  );
  assert(
    (out.result?.proposals ?? []).every(
      (p) => !("rowId" in p) || p.rowId !== taskIdOf(CLIENT_A1, PERIOD, "BANKREC"),
    ),
    "and proposes nothing against that row",
  );
});

test("a locked period gets no new work, and the skip names the lock", async () => {
  const db = practiceDb();
  lockJanuary(db);
  const { applied } = await applyPractice(db, prcGenerateWork, practiceScope());
  assertEqual(tasksOf(db).length, 0, "no task was generated into a closed period");
  const skips = applied.result?.skips ?? [];
  assert(skips.length > 0, "the run said why");
  assert(
    skips.every((s) => s.reason === "locked_period"),
    "and every skip blames the lock",
  );
});

test("a paused client gets no workload at all", async () => {
  const db = practiceDb();
  db.seed("practice_states", [practiceState({ stage: "paused" })]);
  const out = await previewPractice(db, prcGenerateWork, practiceScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was generated");
  assertEqual(
    (out.result?.skips ?? []).length,
    1,
    "and the reason is one row about the client, not one per catalog code",
  );
  assertEqual(
    (out.result?.skips ?? [])[0].reason,
    "out_of_scope_engagement",
    "which is the engagement reason",
  );
});

test("an onboarding client is live and gets the standard workload", async () => {
  const db = practiceDb();
  db.seed("practice_states", [practiceState({ stage: "onboarding" })]);
  const out = await previewPractice(db, prcGenerateWork, practiceScope());
  assert((out.result?.proposals ?? []).length > 0, "onboarding still gets work");
});

test("due dates are the catalog offset off period end, shifted off a weekend", async () => {
  const db = practiceDb();
  await applyPractice(db, prcGenerateWork, practiceScope());
  // 2026-01-31 plus five days is 2026-02-05, a Thursday.
  assertEqual(taskFor(db, "BANKREC")?.dueDate, "2026-02-05", "five days out");
  // Plus eight days is 2026-02-08, a Sunday, which shifts to the Monday.
  assertEqual(taskFor(db, "TIEOUT")?.dueDate, "2026-02-09", "a Sunday shifts to Monday");
  assertEqual(
    taskFor(db, "BANKREC")?.dueDateSetOn,
    PERIOD_END,
    "and the day the clock started is recorded",
  );
});

test("an annual catalog row lands only in the fiscal year end period", async () => {
  const db = practiceDb();
  await applyPractice(db, prcGenerateWork, practiceScope(PERIOD));
  assertEqual(taskFor(db, "ANNUAL1099"), undefined, "January is not year end");
  const december = practiceDb();
  await applyPractice(december, prcGenerateWork, practiceScope(DECEMBER));
  assertEqual(tasksOf(december).length, 4, "December carries the annual row too");
  assert(
    tasksOf(december).some((t) => t.catalogCode === "ANNUAL1099"),
    "and it is the annual one",
  );
});

test("a quarterly catalog row lands only in a quarter end period", async () => {
  const db = practiceDb();
  db.seed("practice_task_catalog", [
    ...db.all("practice_task_catalog"),
    catalogRow("CAT-QTR", "QUARTERLY", { frequency: "quarterly" }),
  ]);
  await applyPractice(db, prcGenerateWork, practiceScope(PERIOD));
  assertEqual(taskFor(db, "QUARTERLY"), undefined, "January is not a quarter end");
  const march = practiceDb();
  march.seed("practice_task_catalog", [
    ...march.all("practice_task_catalog"),
    catalogRow("CAT-QTR", "QUARTERLY", { frequency: "quarterly" }),
  ]);
  await applyPractice(march, prcGenerateWork, practiceScope("2026-03-01"));
  assert(
    tasksOf(march).some((t) => t.catalogCode === "QUARTERLY"),
    "March is",
  );
});

test("preparer work goes to the preparer and review work to the lead", async () => {
  const db = practiceDb();
  await applyPractice(db, prcGenerateWork, practiceScope());
  assertEqual(taskFor(db, "BANKREC")?.assigneeId, PREPARER, "the preparer prepares");
  assertEqual(taskFor(db, "REVIEW")?.assigneeId, LEAD, "and the lead reviews");
  assert(
    (taskFor(db, "REVIEW")?.assignmentReason ?? "").includes("reviewer"),
    "the reason says which role it followed",
  );
  assert(PARTNER.length > 0, "the partner is on the roster for the escalation run");
});

test("an unavailable member leaves the task unassigned with the reason recorded", async () => {
  const db = practiceDb();
  db.seed("practice_states", [practiceState({ unavailableMemberIds: [PREPARER] })]);
  await applyPractice(db, prcGenerateWork, practiceScope());
  assertEqual(taskFor(db, "BANKREC")?.assigneeId, null, "nobody was handed the work");
  assert(
    (taskFor(db, "BANKREC")?.assignmentReason ?? "").includes("unavailable"),
    "and the row says why it is sitting there",
  );
  assertEqual(taskFor(db, "REVIEW")?.assigneeId, LEAD, "the lead is still available");
});

test("a task whose predecessor is not complete is created blocked", async () => {
  const db = practiceDb();
  await applyPractice(db, prcGenerateWork, practiceScope());
  assertEqual(taskFor(db, "TIEOUT")?.state, "blocked", "the dependent task is blocked");
  assertEqual(
    taskFor(db, "TIEOUT")?.blockedByCode,
    "BANKREC",
    "and the row names what is blocking it",
  );
  assertEqual(taskFor(db, "BANKREC")?.state, "open", "the predecessor is open");
});

test("a completed predecessor unblocks the dependent task", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [
    task(taskIdOf(CLIENT_A1, PERIOD, "BANKREC"), "BANKREC", "2026-02-05", {
      state: "complete",
      completedOn: "2026-02-04",
    }),
  ]);
  await applyPractice(db, prcGenerateWork, practiceScope());
  assertEqual(taskFor(db, "TIEOUT")?.state, "open", "the dependent task is open");
  assertEqual(taskFor(db, "TIEOUT")?.blockedByCode, null, "and nothing is blocking it");
});

test("a task somebody has already worked stands", async () => {
  const db = practiceDb();
  db.seed("practice_tasks", [
    task(taskIdOf(CLIENT_A1, PERIOD, "BANKREC"), "BANKREC", "2026-02-20", {
      commentCount: 2,
      assigneeId: LEAD,
    }),
  ]);
  const out = await previewPractice(db, prcGenerateWork, practiceScope());
  assert(
    (out.result?.skips ?? []).some((s) => s.detail.includes("in progress")),
    "the run reports the work in progress",
  );
  await applyPractice(db, prcGenerateWork, practiceScope());
  assertEqual(taskFor(db, "BANKREC")?.dueDate, "2026-02-20", "the hand set date stands");
  assertEqual(taskFor(db, "BANKREC")?.assigneeId, LEAD, "and so does the reassignment");
});

test("an untouched task follows a catalog change, and the clock restarts", async () => {
  const db = practiceDb();
  await applyPractice(db, prcGenerateWork, practiceScope());
  db.seed("practice_task_catalog", [
    ...db.all("practice_task_catalog").filter((c) => c.catalogCode !== "BANKREC"),
    catalogRow("CAT-BANKREC", "BANKREC", { dueOffsetDays: 10 }),
  ]);
  const out = await previewPractice(db, prcGenerateWork, practiceScope());
  const moves = (out.result?.proposals ?? []).filter(isFieldWrite);
  assertEqual(moves.length, 1, "one task moved");
  await applyPractice(db, prcGenerateWork, practiceScope());
  assertEqual(taskFor(db, "BANKREC")?.dueDate, "2026-02-10", "the new offset applies");
  assertEqual(
    taskFor(db, "BANKREC")?.dueDateSetOn,
    PERIOD_END,
    "and the day the clock restarted was written with it",
  );
});

test("an inactive catalog row generates nothing", async () => {
  const db = practiceDb();
  db.seed("practice_task_catalog", [
    ...db.all("practice_task_catalog").filter((c) => c.catalogCode !== "REVIEW"),
    catalogRow("CAT-REVIEW", "REVIEW", { isActive: false }),
  ]);
  await applyPractice(db, prcGenerateWork, practiceScope());
  assertEqual(taskFor(db, "REVIEW"), undefined, "a retired catalog row is retired");
  assertEqual(tasksOf(db).length, 2, "and the rest still generate");
});

test("a gate target carries its gate code onto the task", async () => {
  const db = practiceDb();
  await applyPractice(db, prcGenerateWork, practiceScope());
  assertEqual(taskFor(db, "REVIEW")?.kind, "gate_target", "the kind survives");
  assertEqual(taskFor(db, "REVIEW")?.gateCode, "G1", "and so does the gate it targets");
  assertEqual(taskFor(db, "BANKREC")?.gateCode, null, "a checklist targets no gate");
});
