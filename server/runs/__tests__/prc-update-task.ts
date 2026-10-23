/**
 * PRAC-UPDATE-TASK tests. The framework invariants, then the four things the
 * run has to get right: complete sets completed_on, reassign keeps the state,
 * an unchanged request proposes nothing, and a blocked task refuses to close.
 */

import { assert, assertEqual, test } from "./harness";
import { isFieldWrite } from "../contract";
import { LEAD, PREPARER, applyPractice, practiceDb, previewPractice, shapeOf, task, tasksOf } from "./prc-fixtures";
import { ERR_TASK_BLOCKED, ERR_TASK_NOT_FOUND, prcUpdateTask } from "../runs/prc-update-task";
import { CLIENT_A1 } from "./fixtures";

function dbWithTask(extra: Parameters<typeof task>[3] = {}) {
  const db = practiceDb();
  db.seed("practice_tasks", [task("TASK-BANKREC", "BANKREC", "2025-02-05", extra)]);
  return db;
}

test("preview and apply propose the same write, and complete stamps completed_on", async () => {
  const db = dbWithTask();
  const scope = { clientId: CLIENT_A1, taskId: "TASK-BANKREC", state: "complete" as const };
  const { preview, applied } = await applyPractice(db, prcUpdateTask, scope);
  assertEqual(shapeOf(preview.result?.proposals ?? []), shapeOf(applied.result?.proposals ?? []), "same shape both passes");
  const row = tasksOf(db)[0];
  assertEqual(row.state, "complete", "state moved");
  assert(row.completedOn !== null, "completed_on is set");
  assertEqual(row.manualOverride, true, "a hand touched row is marked so");
  assertEqual(row.assigneeId, PREPARER, "the assignee is untouched");
});

test("reassign keeps the state and records why", async () => {
  const db = dbWithTask();
  await applyPractice(db, prcUpdateTask, { clientId: CLIENT_A1, taskId: "TASK-BANKREC", assigneeId: LEAD });
  const row = tasksOf(db)[0];
  assertEqual(row.assigneeId, LEAD, "new assignee");
  assertEqual(row.state, "open", "state unchanged");
  assert(row.assignmentReason.includes("board"), "the reason says a person did it");
});

test("asking for what the task already has proposes nothing", async () => {
  const db = dbWithTask({ manualOverride: true });
  const out = await previewPractice(db, prcUpdateTask, { clientId: CLIENT_A1, taskId: "TASK-BANKREC", state: "open" });
  assertEqual((out.result?.proposals ?? []).length, 0, "no proposal");
  assertEqual((out.result?.skips ?? []).length, 1, "one skip");
});

test("a blocked task cannot be completed by hand, and a missing task is named", async () => {
  const db = dbWithTask({ state: "blocked", blockedByCode: "BANKREC" });
  const out = await previewPractice(db, prcUpdateTask, { clientId: CLIENT_A1, taskId: "TASK-BANKREC", state: "complete" });
  assertEqual(out.result?.errors[0]?.code, ERR_TASK_BLOCKED, "blocked refused");
  const missing = await previewPractice(db, prcUpdateTask, { clientId: CLIENT_A1, taskId: "NOPE", state: "complete" });
  assertEqual(missing.result?.errors[0]?.code, ERR_TASK_NOT_FOUND, "missing named");
});

test("undo restores the before image", async () => {
  const db = dbWithTask();
  const { applied } = await applyPractice(db, prcUpdateTask, { clientId: CLIENT_A1, taskId: "TASK-BANKREC", state: "complete" });
  const writes = (applied.result?.proposals ?? []).filter(isFieldWrite);
  const plan = await prcUpdateTask.undoPlan(writes, {} as never);
  assertEqual(plan.length, 1, "one revert");
  const revert = plan[0];
  assert(isFieldWrite(revert) && revert.after.state === "open", "the revert reopens the task");
});
