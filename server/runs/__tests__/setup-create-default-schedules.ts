/**
 * SETUP-CREATE-DEFAULT-SCHEDULES tests. Audit fix, problem 5: nothing ever
 * inserted a client's first sched.schedules row. The insert, the no-op
 * repeat, and the proof that matters most -- that every schedule this run
 * creates actually parses against the scope server/sched/runner.ts's own
 * runWindow() builds, not just against this run's own happy path.
 *
 * Extended in the smaller-issues cleanup round to cover the eight run types
 * the scheduler's `period`/`asOfDate` fixes made mechanically reachable,
 * per the user's own choice (auto-schedule the non-destructive ones).
 * CLOSE-CHECK-GATES/RPT-BUILD-PACKAGE/SUB-TIEOUT-ACCOUNTS stay deliberately
 * out of DEFAULT_SCHEDULES -- see the plan file's own entry for why.
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
import { refreshAgingScopeSchema } from "../runs/ar-refresh-aging";
import { trackW9ScopeSchema } from "../runs/w9-track";
import { generateWorkScopeSchema } from "../runs/prc-generate-work";
import { nudgeRequestsScopeSchema } from "../runs/prc-nudge-requests";
import { escalateOverdueScopeSchema } from "../runs/prc-escalate-overdue";
import { flagVariancesScopeSchema } from "../runs/rpt-flag-variances";
import { rebuildForecastScopeSchema } from "../runs/rpt-rebuild-forecast";
import { composeNarrativeScopeSchema } from "../runs/rpt-compose-narrative";
import { priorPeriodStartOf } from "../dates";
import type { SchedScheduleRow } from "../tables";

function scopeFor(extra: Partial<CreateDefaultSchedulesScope> = {}): CreateDefaultSchedulesScope {
  return { clientId: CLIENT_A1, ...extra };
}

const DAILY_RUN_TYPES = [
  "TXN-NORMALIZE-VENDORS",
  "TXN-DETECT-DUPLICATES",
  "TXN-APPLY-RULES",
  "TXN-APPLY-VENDORDEFAULTS",
  "TXN-MAP-BANKCODES",
  "REC-FLAG-STALE",
  "ARAP-REFRESH-AGING",
  "TAX-TRACK-W9",
  "PRAC-GENERATE-TASKS",
  "PRAC-NUDGE-REQUESTS",
  "PRAC-ESCALATE-OVERDUE",
];
const MONTHLY_RUN_TYPES = ["RPT-FLAG-VARIANCES", "RPT-REBUILD-FORECAST", "RPT-COMPOSE-NARRATIVE"];
const EXPECTED_RUN_TYPES = [...DAILY_RUN_TYPES, ...MONTHLY_RUN_TYPES];

test("setup-create-default-schedules: creates fourteen schedules, one per auto-scheduled run type", async () => {
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
  assertEqual(rows.length, 14, "fourteen default schedules");
  for (const runType of EXPECTED_RUN_TYPES) {
    const row = rows.find((r) => r.runType === runType);
    assert(row !== undefined, `${runType} has a schedule`);
    assertEqual(row?.id, defaultScheduleIdFor(CLIENT_A1, runType), "id is derived, not random");
    assertEqual(row?.tier, "unattended", `${runType} is scheduled at its real tier`);
    assertEqual(row?.executionMode, "apply", "unattended schedules in apply mode");
    assertEqual(row?.enabled, true, "enabled from the start");
    assertEqual(row?.firmId, FIRM_A, "firm carried through");
  }
  for (const runType of DAILY_RUN_TYPES) {
    const row = rows.find((r) => r.runType === runType);
    assertEqual(row?.cadence, "daily", `${runType} is daily`);
    assertEqual(row?.dayOfMonth, null, `${runType} carries no day of month`);
  }
  for (const runType of MONTHLY_RUN_TYPES) {
    const row = rows.find((r) => r.runType === runType);
    assertEqual(row?.cadence, "monthly_day", `${runType} is monthly`);
    assertEqual(row?.dayOfMonth, 1, `${runType} fires on the 1st`);
  }

  // Five minutes apart, in doc 02's own documented cascade order.
  const minutes = DAILY_RUN_TYPES.slice(0, 5).map((t) => rows.find((r) => r.runType === t)?.localMinute);
  assertEqual(minutes, [0, 5, 10, 15, 20], "the coding cascade runs five minutes apart in order");
});

test("setup-create-default-schedules: running it twice is a no op the second time", async () => {
  const db = baseDb();
  const scope = scopeFor();
  const first = await execute(db, setupCreateDefaultSchedules, scope, opts("preview"));
  await execute(db, setupCreateDefaultSchedules, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, setupCreateDefaultSchedules, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assertEqual(second.result.skips.length, 14, "all fourteen already applied");
  assert(
    second.result.skips.every((s) => s.reason === "already_applied"),
    "every skip is already_applied",
  );
});

const SCHEMA_FOR_RUN_TYPE: Record<string, { safeParse: (v: unknown) => { success: boolean } }> = {
  "REC-FLAG-STALE": flagStaleScopeSchema,
  "ARAP-REFRESH-AGING": refreshAgingScopeSchema,
  "TAX-TRACK-W9": trackW9ScopeSchema,
  "PRAC-GENERATE-TASKS": generateWorkScopeSchema,
  "PRAC-NUDGE-REQUESTS": nudgeRequestsScopeSchema,
  "PRAC-ESCALATE-OVERDUE": escalateOverdueScopeSchema,
  "RPT-FLAG-VARIANCES": flagVariancesScopeSchema,
  "RPT-REBUILD-FORECAST": rebuildForecastScopeSchema,
  "RPT-COMPOSE-NARRATIVE": composeNarrativeScopeSchema,
};

test("setup-create-default-schedules: every created schedule's scope actually validates against what the scheduler builds", async () => {
  // Mirrors server/sched/runner.ts's runWindow() verbatim:
  //   { ...schedule.scopeJson, firmId, clientId, from, to, asOf, asOfDate, period }
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
      asOfDate: localDay,
      period: priorPeriodStartOf(localDay),
    };
    const schema = SCHEMA_FOR_RUN_TYPE[row.runType] ?? codingScopeSchema;
    const result = schema.safeParse(builtScope);
    assert(result.success, `${row.runType}'s own schema accepts what the scheduler builds`);
  }
});
