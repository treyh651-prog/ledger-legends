/**
 * INTAKE-SEED-TASKS tests.
 *
 * The framework invariants, then the four things the seeder has to get right:
 * the catalog it writes, which of those rows land in the first period, what a
 * closed cutover does, and what happens on the second press.
 *
 * One test matters more than the others. The task id derived here has to be the
 * id PRAC-GENERATE-TASKS derives, or a wizard finish followed by the nightly
 * generator produces two copies of the same monthly close.
 */

import { assert, assertEqual, test } from "./harness";
import { isFieldWrite, isRowInsert } from "../contract";
import {
  DECEMBER_PERIOD,
  DECEMBER_PERIOD_END,
  FIRM_A,
  INTAKE_CLIENT,
  NOW,
  PERIOD,
  PERIOD_END,
  QUARTER_PERIOD,
  applyIntake,
  catalogOf,
  intakeDb,
  lockFirstPeriod,
  previewIntake,
  shapeOf,
  tasksScope,
  tasksOf,
} from "./intake-fixtures";
import { catalogIdOf, intakeSeedTasks, wantedCatalog } from "../runs/intake-seed-tasks";
import { taskIdOf } from "../runs/prc-generate-work";
import { STANDARD_TASK_CATALOG } from "../runs/intake-shared";

test("seed tasks, preview and apply propose the identical set", async () => {
  const db = intakeDb();
  const { preview, applied } = await applyIntake(db, intakeSeedTasks, tasksScope());
  assertEqual(
    shapeOf(applied.result.proposals),
    shapeOf(preview.result.proposals),
    "apply proposed exactly what preview showed",
  );
});

test("seed tasks, the standard catalog lands whole", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeSeedTasks, tasksScope());
  const catalog = catalogOf(db);
  assertEqual(catalog.length, wantedCatalog(tasksScope()).length, "every wanted row landed");
  const frequencies = new Set(catalog.map((c) => c.frequency));
  assert(frequencies.has("monthly"), "the monthly close is on the catalog");
  assert(frequencies.has("quarterly"), "the quarterly review is on the catalog");
  assert(frequencies.has("annual"), "the annual close is on the catalog");
  assert(
    catalog.every((c) => c.isActive && c.clientId === INTAKE_CLIENT && c.firmId === FIRM_A),
    "and every row is active and stamped with the client it was seeded for",
  );
});

test("seed tasks, the first period gets its instances", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeSeedTasks, tasksScope());
  const tasks = tasksOf(db);
  assert(tasks.length > 0, "the client opens with a workload");
  assert(
    tasks.every((t) => t.periodStart === PERIOD && t.periodEnd === PERIOD_END),
    "and every task is about the first period and no other",
  );
});

test("seed tasks, only the monthly rows land in a plain month", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeSeedTasks, tasksScope());
  const codes = new Set(tasksOf(db).map((t) => t.catalogCode));
  for (const row of STANDARD_TASK_CATALOG) {
    if (row.frequency === "monthly") continue;
    assert(
      !codes.has(row.catalogCode),
      `${row.catalogCode} is ${row.frequency} and July is not its period`,
    );
  }
  assert(
    [...codes].every((c) => c.startsWith("MC-")),
    "the first period's workload is the monthly close and nothing else",
  );
});

test("seed tasks, a quarter end period gets the quarterly rows too", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeSeedTasks, tasksScope({ period: QUARTER_PERIOD }));
  const codes = new Set(tasksOf(db).map((t) => t.catalogCode));
  assert(
    [...codes].some((c) => c.startsWith("QR-")),
    "September closes a quarter, so the quarterly review is scheduled",
  );
});

test("seed tasks, a December period gets the annual rows", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeSeedTasks, tasksScope({ period: DECEMBER_PERIOD }));
  const tasks = tasksOf(db);
  assert(
    tasks.some((t) => t.catalogCode.startsWith("AC-")),
    "the annual close lands in December",
  );
  assert(
    tasks.every((t) => t.periodEnd === DECEMBER_PERIOD_END),
    "and against the December window",
  );
});

test("seed tasks, the task id agrees with the nightly generator", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeSeedTasks, tasksScope());
  for (const task of tasksOf(db)) {
    assertEqual(
      task.id,
      taskIdOf(INTAKE_CLIENT, PERIOD, task.catalogCode),
      `${task.catalogCode} carries the id PRAC-GENERATE-TASKS would derive`,
    );
  }
});

test("seed tasks, a step with a predecessor is created blocked", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeSeedTasks, tasksScope());
  const waiting = tasksOf(db).filter((t) => t.blockedByCode !== null);
  assert(waiting.length > 0, "at least one step waits on another");
  assert(
    waiting.every((t) => t.state === "blocked"),
    "and every one of them is blocked rather than open",
  );
  const first = tasksOf(db).filter((t) => t.blockedByCode === null);
  assert(first.length > 0, "and the first step is not waiting on anything");
  assert(
    first.every((t) => t.state === "open"),
    "so it is open and somebody can start",
  );
});

test("seed tasks, nothing is assigned before a roster exists", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeSeedTasks, tasksScope());
  assert(
    tasksOf(db).every((t) => t.assigneeId === null),
    "no task was put in somebody's queue by guesswork",
  );
  assert(
    tasksOf(db).every((t) => t.assignmentReason.length > 0),
    "and every one says in words why it is unassigned",
  );
});

test("seed tasks, a closed cutover gets the catalog and no instances", async () => {
  const db = intakeDb();
  lockFirstPeriod(db);
  await applyIntake(db, intakeSeedTasks, tasksScope());
  assert(catalogOf(db).length > 0, "the catalog is not about a period, so it landed");
  assertEqual(tasksOf(db).length, 0, "and no work was created inside a closed period");
});

test("seed tasks, the second press is a no operation", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeSeedTasks, tasksScope());
  const catalogCount = catalogOf(db).length;
  const taskCount = tasksOf(db).length;
  const again = await previewIntake(db, intakeSeedTasks, tasksScope());
  assertEqual(again.result.proposals.length, 0, "nothing left to propose");
  assertEqual(catalogOf(db).length, catalogCount, "the catalog did not grow");
  assertEqual(tasksOf(db).length, taskCount, "and neither did the workload");
});

test("seed tasks, a catalog row a person overrode is never rewritten", async () => {
  const db = intakeDb();
  const code = STANDARD_TASK_CATALOG[0]?.catalogCode ?? "";
  db.seed("practice_task_catalog", [
    {
      id: catalogIdOf(INTAKE_CLIENT, code),
      firmId: FIRM_A,
      clientId: INTAKE_CLIENT,
      version: 1,
      catalogCode: code,
      title: "The version this firm actually uses",
      kind: "checklist",
      role: "preparer",
      scopeKey: null,
      gateCode: null,
      predecessorCode: null,
      dueOffsetDays: 30,
      frequency: "monthly",
      isActive: true,
      createdAt: NOW.toISOString(),
      manualOverride: true,
    },
  ]);
  const outcome = await previewIntake(db, intakeSeedTasks, tasksScope());
  const touched = outcome.result.proposals.some(
    (p) => isRowInsert(p) && p.table === "practice_task_catalog" && p.row.catalogCode === code,
  );
  assert(!touched, "the overridden catalog row was not proposed against");
  assert(
    outcome.result.skips.some((s) => s.reason === "manual_override"),
    "and the skip names the override",
  );
  await applyIntake(db, intakeSeedTasks, tasksScope());
  const row = catalogOf(db).find((c) => c.catalogCode === code);
  assertEqual(row?.dueOffsetDays, 30, "the offset a person set survived");
  assertEqual(row?.title, "The version this firm actually uses", "and so did the title");
});

test("seed tasks, a struck catalog code is not seeded at all", async () => {
  const db = intakeDb();
  const code = STANDARD_TASK_CATALOG[0]?.catalogCode ?? "";
  await applyIntake(db, intakeSeedTasks, tasksScope({ excludeCatalogCodes: [code] }));
  assert(
    !catalogOf(db).some((c) => c.catalogCode === code),
    "the struck row is not on the catalog",
  );
  assert(!tasksOf(db).some((t) => t.catalogCode === code), "and produced no task");
});

test("seed tasks, every due date lands off a weekend", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeSeedTasks, tasksScope());
  for (const task of tasksOf(db)) {
    const day = new Date(`${task.dueDate}T00:00:00.000Z`).getUTCDay();
    assert(day !== 0 && day !== 6, `${task.catalogCode} is not due on a weekend`);
  }
});

test("seed tasks, the run only ever inserts", async () => {
  const db = intakeDb();
  const outcome = await previewIntake(db, intakeSeedTasks, tasksScope());
  assert(outcome.result.proposals.length > 0, "there is something to check");
  assert(
    !outcome.result.proposals.some((p) => isFieldWrite(p)),
    "no existing row is ever amended by the seeder",
  );
  for (const p of outcome.result.proposals) {
    if (!isRowInsert(p)) continue;
    assert(
      p.table === "practice_task_catalog" || p.table === "practice_tasks",
      `${p.table} is one of the two tables this run owns`,
    );
  }
});
