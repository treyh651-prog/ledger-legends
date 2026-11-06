/**
 * SETUP-CREATE-DEFAULT-SCHEDULES tests. Audit fix, problem 5: nothing ever
 * inserted a client's first sched.schedules row. The insert, the no-op
 * repeat, and the proof that matters most -- that every schedule this run
 * creates actually parses against the scope server/sched/runner.ts's own
 * runWindow() builds, not just against this run's own happy path. (A
 * schedule row existing is not the same claim as a schedule row the
 * scheduler can actually fire -- see the plan file's own "Problem 5" entry
 * for the nine run types that fail this exact check today and are
 * deliberately left out of DEFAULT_SCHEDULES.)
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, baseDb, opts } from "./fixtures";
import {
  defaultScheduleIdFor,
  setupCreateDefaultSchedules,
  type CreateDefaultSchedulesScope,
} from "../runs/setup-create-default-schedules";
import { codingScopeSchema } from "../runs/coding-cascade";
import { flagStaleScopeSchema } from "../runs/rec-flag-stale";
import type { SchedScheduleRow } from "../tables";

function scopeFor(extra: Partial<CreateDefaultSchedulesScope> = {}): CreateDefaultSchedulesScope {
  return { clientId: CLIENT_A1, ...extra };
}

const EXPECTED_RUN_TYPES = [
  "TXN-NORMALIZE-VENDORS",
  "TXN-DETECT-DUPLICATES",
  "TXN-APPLY-RULES",
  "TXN-APPLY-VENDORDEFAULTS",
  "TXN-MAP-BANKCODES",
  "REC-FLAG-STALE",
];

test("setup-create-default-schedules: creates six schedules, one per mechanically schedulable unattended run", async () => {
  const db = baseDb();
  const scope = scopeFor();
  const preview = await execute(db, setupCreateDefaultSchedules, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(
    db,
    setupCreateDefaultSchedules,
    scope,
    opts("apply", { previewRunId: preview.executionId }),
  );
  assertEqual(applied.status, "completed", "apply completed");

  const rows = (db.all("sched_schedules") as SchedScheduleRow[]).filter((s) => s.clientId === CLIENT_A1);
  assertEqual(rows.length, 6, "six default schedules");
  for (const runType of EXPECTED_RUN_TYPES) {
    const row = rows.find((r) => r.runType === runType);
    assert(row !== undefined, `${runType} has a schedule`);
    assertEqual(row?.id, defaultScheduleIdFor(CLIENT_A1, runType), "id is derived, not random");
    assertEqual(row?.tier, "unattended", `${runType} is scheduled at its real tier`);
    assertEqual(row?.executionMode, "apply", "unattended schedules in apply mode");
    assertEqual(row?.cadence, "daily", "daily cadence");
    assertEqual(row?.enabled, true, "enabled from the start");
    assertEqual(row?.firmId, FIRM_A, "firm carried through");
  }

  // Five minutes apart, in doc 02's own documented cascade order.
  const minutes = EXPECTED_RUN_TYPES.slice(0, 5).map((t) => rows.find((r) => r.runType === t)?.localMinute);
  assertEqual(minutes, [0, 5, 10, 15, 20], "the coding cascade runs five minutes apart in order");
});

test("setup-create-default-schedules: running it twice is a no op the second time", async () => {
  const db = baseDb();
  const scope = scopeFor();
  const first = await execute(db, setupCreateDefaultSchedules, scope, opts("preview"));
  await execute(db, setupCreateDefaultSchedules, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, setupCreateDefaultSchedules, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assertEqual(second.result.skips.length, 6, "all six already applied");
  assert(
    second.result.skips.every((s) => s.reason === "already_applied"),
    "every skip is already_applied",
  );
});

test("setup-create-default-schedules: every created schedule's scope actually validates against what the scheduler builds", async () => {
  // Mirrors server/sched/runner.ts's runWindow() verbatim:
  //   { ...schedule.scopeJson, firmId, clientId, from, to, asOf }
  // This is the exact mechanical-compatibility claim the audit fix rests
  // on -- a schedule row existing proves nothing on its own if the run it
  // names would refuse the scope the runner actually hands it.
  const db = baseDb();
  const scope = scopeFor();
  const preview = await execute(db, setupCreateDefaultSchedules, scope, opts("preview"));
  await execute(db, setupCreateDefaultSchedules, scope, opts("apply", { previewRunId: preview.executionId }));

  const rows = (db.all("sched_schedules") as SchedScheduleRow[]).filter((s) => s.clientId === CLIENT_A1);
  const localDay = "2026-01-15";

  for (const row of rows) {
    const builtScope = {
      ...row.scopeJson,
      firmId: row.firmId,
      clientId: row.clientId,
      from: localDay,
      to: localDay,
      asOf: localDay,
    };
    const schema = row.runType === "REC-FLAG-STALE" ? flagStaleScopeSchema : codingScopeSchema;
    const result = schema.safeParse(builtScope);
    assert(result.success, `${row.runType}'s own schema accepts what the scheduler builds`);
  }
});
