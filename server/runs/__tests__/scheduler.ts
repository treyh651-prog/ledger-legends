/**
 * The scheduler: compliance tiers, zone arithmetic, the catch up bound, and
 * the one constraint everything else rests on.
 *
 * None of this touches Trigger.dev. The tasks in trigger/scheduler.ts are
 * wrappers with no decisions in them, and everything they call is exercised
 * here against the memory port with no network and no clock.
 */

import { MemoryRunDb } from "../db-memory";
import { UniqueViolation } from "../db";
import { execute } from "../execute";
import {
  cadenceFireInstants,
  dayOfMonthIn,
  instantOfLocalTime,
  nthBusinessDayIn,
  weekdayNameOf,
  zonedDay,
  UnknownTimeZoneError,
  type Cadence,
} from "../dates";
import {
  guardScheduledRun,
  RUN_POLICIES,
  scheduledModeFor,
  tierOf,
  TierRefusal,
} from "../policy";
import { registry } from "../registry";
import { txnPairTransfers } from "../runs/txn-pair-transfers";
import type { SchedScheduleRow, SchedWindowRow } from "../tables";
import {
  CATCH_UP_DAYS,
  CATCH_UP_MAX_WINDOWS,
  planWindows,
} from "../../sched/plan";
import { nextFireAt, tick } from "../../sched/runner";
import { schedulerStatus } from "../../sched/status";
import { assert, assertEqual, assertRejects, assertThrows, test } from "./harness";
import { ACTOR, CLIENT_A1, FIRM_A, baseDb, opts } from "./fixtures";

const DENVER = "America/Denver";
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Compliance tiers.
// ---------------------------------------------------------------------------

test("every registered run carries a tier, with no default", () => {
  for (const entry of registry) {
    assert(
      RUN_POLICIES[entry.type] !== undefined,
      `${entry.type} has no compliance tier, and an unclassified run must not be born unattended`,
    );
  }
});

test("no run that posts to the general ledger is unattended", () => {
  for (const entry of registry) {
    if (!entry.writesLedger) continue;
    assert(
      tierOf(entry.type) !== "unattended",
      `${entry.type} posts to the general ledger and is classified unattended`,
    );
  }
});

test("the tier split is twenty one unattended, twenty three propose, thirty three manual", () => {
  const counts = { unattended: 0, propose: 0, manual: 0 };
  for (const entry of registry) {
    const tier = tierOf(entry.type);
    if (tier !== null) counts[tier] += 1;
  }
  assertEqual(registry.length, 77, "the registry holds seventy seven runs");
  assertEqual(counts.unattended, 21, "unattended count");
  assertEqual(counts.propose, 23, "propose count");
  assertEqual(counts.manual, 33, "manual count");
});

test("every tier carries a written reason", () => {
  for (const [type, policy] of Object.entries(RUN_POLICIES)) {
    assert(policy.reason.trim().length > 20, `${type} has no real reason written down`);
  }
});

test("a manual run has no scheduled mode at all", () => {
  assertEqual(scheduledModeFor("manual"), null, "manual is not schedulable");
  assertEqual(scheduledModeFor("propose"), "preview", "propose schedules in preview");
  assertEqual(scheduledModeFor("unattended"), "apply", "unattended schedules in apply");
});

test("the guard refuses a manual run whatever mode is asked for", () => {
  assertThrows(
    () => guardScheduledRun("CLOSE-LOCK-PERIOD", "apply"),
    "TIER_REFUSED",
    "locking a period on a clock",
  );
  assertThrows(
    () => guardScheduledRun("CLOSE-LOCK-PERIOD", "preview"),
    "TIER_REFUSED",
    "previewing a period lock on a clock is still a manual run",
  );
});

test("the guard refuses a propose run asked to apply", () => {
  assertThrows(
    () => guardScheduledRun("PER-POST-DEPRECIATION", "apply"),
    "TIER_REFUSED",
    "a ledger posting run may prepare and may not commit",
  );
  let refused = false;
  try {
    guardScheduledRun("PER-POST-DEPRECIATION", "preview");
  } catch {
    refused = true;
  }
  assert(!refused, "a propose run previews without complaint");
});

test("the guard refuses a run it has never heard of", () => {
  assertThrows(
    () => guardScheduledRun("SOMETHING-NEW", "preview"),
    "TIER_REFUSED",
    "an unclassified run is refused rather than assumed safe",
  );
});

test("the executor refuses an unattended caller the tier forbids", async () => {
  const db = baseDb();
  // TXN-PAIR-TRANSFERS is propose tier, so apply from a clock is refused
  // before the scope is frozen and before any log row exists.
  const outcome = await execute(
    db,
    txnPairTransfers,
    { firmId: FIRM_A, clientId: CLIENT_A1, from: "2026-02-01", to: "2026-02-28" },
    opts("apply", { unattended: true, previewRunId: "RUNX-DOESNOTMATTER" }),
  );
  assertEqual(outcome.status, "refused", "the executor refused it");
  assertEqual(
    outcome.result.errors[0]?.code,
    "TIER_REFUSED",
    "and said why in a code the caller can branch on",
  );
  assertEqual(outcome.entriesCreated, 0, "nothing was written");
});

test("the same call from a person is not refused by the tier", async () => {
  const db = baseDb();
  const preview = await execute(
    db,
    txnPairTransfers,
    { firmId: FIRM_A, clientId: CLIENT_A1, from: "2026-02-01", to: "2026-02-28" },
    opts("preview"),
  );
  assert(preview.status !== "refused", "a human preview runs");
});

// ---------------------------------------------------------------------------
// Zone arithmetic. The two days a year a UTC cron is wrong.
// ---------------------------------------------------------------------------

const nightly: Cadence = { kind: "daily", hour: 6, minute: 0, timeZone: DENVER };

test("spring forward leaves twenty three hours between two six am fires", () => {
  const fires = cadenceFireInstants(
    nightly,
    Date.parse("2026-03-06T00:00:00Z"),
    Date.parse("2026-03-11T00:00:00Z"),
  );
  assertEqual(fires.length, 5, "five mornings");
  const gaps = fires.slice(1).map((t, i) => (t - fires[i]) / HOUR);
  assertEqual(gaps, [24, 23, 24, 24], "the short day is the eighth of March");
  for (const t of fires) {
    assertEqual(
      new Date(t).toISOString().slice(11, 16) === "13:00" ||
        new Date(t).toISOString().slice(11, 16) === "12:00",
      true,
      "every fire is six in the morning in Denver whatever the offset is",
    );
  }
});

test("fall back leaves twenty five hours between two six am fires", () => {
  const fires = cadenceFireInstants(
    nightly,
    Date.parse("2026-10-30T00:00:00Z"),
    Date.parse("2026-11-04T00:00:00Z"),
  );
  const gaps = fires.slice(1).map((t, i) => (t - fires[i]) / HOUR);
  assertEqual(gaps, [24, 25, 24, 24], "the long day is the first of November");
});

test("a daily cadence fires once on the day the clocks move and not twice", () => {
  const spring = cadenceFireInstants(
    nightly,
    Date.parse("2026-03-08T00:00:00Z"),
    Date.parse("2026-03-09T06:00:00Z"),
  ).filter((t) => zonedDay(t, DENVER) === "2026-03-08");
  assertEqual(spring.length, 1, "one fire on the short day");
  const fall = cadenceFireInstants(
    nightly,
    Date.parse("2026-11-01T00:00:00Z"),
    Date.parse("2026-11-02T06:00:00Z"),
  ).filter((t) => zonedDay(t, DENVER) === "2026-11-01");
  assertEqual(fall.length, 1, "one fire on the long day");
});

test("the hour that does not exist resolves adjacent rather than vanishing", () => {
  const t = instantOfLocalTime("2026-03-08", 2, 30, DENVER);
  assertEqual(
    new Date(t).toISOString(),
    "2026-03-08T08:30:00.000Z",
    "02:30 Denver never happens that morning, so it lands on 03:30",
  );
});

test("the hour that happens twice resolves to the earlier of the two", () => {
  const t = instantOfLocalTime("2026-11-01", 1, 30, DENVER);
  assertEqual(
    new Date(t).toISOString(),
    "2026-11-01T07:30:00.000Z",
    "the first 01:30, before the clocks go back",
  );
});

test("a schedule in another zone keeps its own offset", () => {
  const london: Cadence = { kind: "daily", hour: 6, minute: 0, timeZone: "Europe/London" };
  const fires = cadenceFireInstants(
    london,
    Date.parse("2026-03-28T00:00:00Z"),
    Date.parse("2026-03-31T00:00:00Z"),
  );
  const gaps = fires.slice(1).map((t, i) => (t - fires[i]) / HOUR);
  assertEqual(gaps, [23, 24], "British summer time starts on the twenty ninth");
});

test("an unknown zone is refused by name", () => {
  assertThrows(
    () => instantOfLocalTime("2026-01-01", 6, 0, "America/Denvr"),
    "UNKNOWN_TIME_ZONE",
    "a typed zone name",
  );
  assert(
    new UnknownTimeZoneError("x").code === "UNKNOWN_TIME_ZONE",
    "the error carries a code",
  );
});

// ---------------------------------------------------------------------------
// Calendar shapes.
// ---------------------------------------------------------------------------

test("day thirty one clamps to the end of a short month", () => {
  assertEqual(dayOfMonthIn(2026, 4, 31), "2026-04-30", "April has thirty days");
  assertEqual(dayOfMonthIn(2026, 2, 31), "2026-02-28", "February 2026 has twenty eight");
  assertEqual(dayOfMonthIn(2026, 1, 31), "2026-01-31", "January is untouched");
});

test("day twenty nine clamps in a non leap February and does not in a leap one", () => {
  assertEqual(dayOfMonthIn(2026, 2, 29), "2026-02-28", "2026 is not a leap year");
  assertEqual(dayOfMonthIn(2028, 2, 29), "2028-02-29", "2028 is");
});

test("a monthly cadence fires once a month and on the clamped day", () => {
  const cadence: Cadence = {
    kind: "monthly_day",
    hour: 6,
    minute: 0,
    timeZone: DENVER,
    dayOfMonth: 31,
  };
  const fires = cadenceFireInstants(
    cadence,
    Date.parse("2026-03-01T00:00:00Z"),
    Date.parse("2026-07-01T00:00:00Z"),
  ).map((t) => zonedDay(t, DENVER));
  assertEqual(
    fires,
    ["2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"],
    "four months, each on its own last day",
  );
});

test("the nth business day skips weekends and clamps at the end", () => {
  assertEqual(nthBusinessDayIn(2026, 3, 1), "2026-03-02", "the first of March 2026 is a Sunday");
  assertEqual(nthBusinessDayIn(2026, 3, 3), "2026-03-04", "third business day");
  assertEqual(nthBusinessDayIn(2026, 2, 23), "2026-02-27", "February has twenty business days");
  assertEqual(weekdayNameOf("2026-03-02"), "monday", "weekday naming");
});

test("business day three lands on a weekday in every month of a year", () => {
  for (let m = 1; m <= 12; m += 1) {
    const day = nthBusinessDayIn(2026, m, 3);
    const name = weekdayNameOf(day);
    assert(
      name !== "saturday" && name !== "sunday",
      `business day three of month ${String(m)} landed on ${name}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The catch up bound.
// ---------------------------------------------------------------------------

function schedule(over: Partial<SchedScheduleRow> = {}): SchedScheduleRow {
  return {
    id: "SCH-NIGHTLY-A1",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    name: "nightly coding refresh",
    runType: "TXN-APPLY-RULES",
    tier: "unattended",
    executionMode: "apply",
    cadence: "daily",
    weekday: null,
    dayOfMonth: null,
    businessDay: null,
    localHour: 6,
    localMinute: 0,
    timezone: DENVER,
    enabled: true,
    effectiveFrom: "2025-01-01",
    effectiveTo: null,
    scopeJson: {},
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureDetail: null,
    version: 1,
    manualOverride: false,
    ...over,
  };
}

test("a schedule that ran last night owes exactly one window", () => {
  const now = new Date("2026-02-10T13:05:00Z");
  const plan = planWindows(schedule(), "2026-02-09T13:00:00.000Z", now);
  assertEqual(plan.due.length, 1, "one window");
  assertEqual(plan.skipped.length, 0, "nothing skipped");
  assertEqual(plan.due[0].localDay, "2026-02-10", "this morning");
});

test("the window already recorded is never planned a second time", () => {
  const now = new Date("2026-02-10T13:05:00Z");
  const plan = planWindows(schedule(), "2026-02-10T13:00:00.000Z", now);
  assertEqual(plan.due.length, 0, "the interval is half open on the left");
});

test("a three day gap catches up, oldest first", () => {
  const now = new Date("2026-02-10T13:05:00Z");
  const plan = planWindows(schedule(), "2026-02-07T13:00:00.000Z", now);
  assertEqual(
    plan.due.map((w) => w.localDay),
    ["2026-02-08", "2026-02-09", "2026-02-10"],
    "three windows in the order the days happened",
  );
});

test("a twenty day gap runs the newest seven and records the rest as skipped", () => {
  const now = new Date("2026-02-10T13:05:00Z");
  const plan = planWindows(schedule(), "2026-01-21T13:00:00.000Z", now);
  assertEqual(plan.due.length, CATCH_UP_MAX_WINDOWS, "seven windows run");
  assertEqual(plan.due[plan.due.length - 1].localDay, "2026-02-10", "including this morning");
  assert(plan.skipped.length > 0, "the rest are written down");
  for (const s of plan.skipped) {
    assert(
      s.reason === "outside_catch_up_bound" || s.reason === "catch_up_window_limit",
      "every skip carries a reason",
    );
  }
  assertEqual(
    plan.due.length + plan.skipped.length,
    20,
    "no window in the last twenty days is silently dropped",
  );
});

test("nothing older than the bound is ever run", () => {
  const now = new Date("2026-02-10T13:05:00Z");
  const plan = planWindows(schedule(), "2026-01-21T13:00:00.000Z", now);
  const boundMs = now.getTime() - CATCH_UP_DAYS * 86_400_000;
  for (const w of plan.due) {
    assert(
      w.windowStart.getTime() >= boundMs,
      `${w.localDay} is older than the ${String(CATCH_UP_DAYS)} day bound and was going to run`,
    );
  }
});

test("a schedule outside its effective dates owes nothing", () => {
  const now = new Date("2026-02-10T13:05:00Z");
  const past = planWindows(
    schedule({ effectiveTo: "2026-01-31" }),
    "2026-01-30T13:00:00.000Z",
    now,
  );
  assertEqual(past.due.length, 0, "an ended schedule owes nothing");
  const future = planWindows(schedule({ effectiveFrom: "2026-03-01" }), null, now);
  assertEqual(future.due.length, 0, "a schedule that has not started owes nothing");
});

test("a brand new schedule does not manufacture a month of history", () => {
  const now = new Date("2026-02-10T13:05:00Z");
  const plan = planWindows(schedule(), null, now);
  assertEqual(plan.due.length <= CATCH_UP_MAX_WINDOWS, true, "bounded like any other");
});

test("a monthly business day schedule owes one window in a month", () => {
  const now = new Date("2026-03-04T13:30:00Z");
  const plan = planWindows(
    schedule({
      cadence: "monthly_business_day",
      businessDay: 3,
      runType: "RPT-BUILD-PACKAGE",
    }),
    "2026-02-03T13:00:00.000Z",
    now,
  );
  assertEqual(plan.due.length, 1, "one window");
  assertEqual(plan.due[0].localDay, "2026-03-04", "business day three of March 2026");
});

test("the next fire is computed and never stored", () => {
  const next = nextFireAt(schedule(), new Date("2026-02-10T14:00:00Z"));
  assertEqual(
    next === null ? "null" : zonedDay(next.getTime(), DENVER),
    "2026-02-11",
    "tomorrow morning",
  );
});

// ---------------------------------------------------------------------------
// The constraint the whole design rests on.
// ---------------------------------------------------------------------------

function windowRow(over: Partial<SchedWindowRow> = {}): SchedWindowRow {
  return {
    id: "WIN-0001",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    scheduleId: "SCH-NIGHTLY-A1",
    windowStart: "2026-02-10T13:00:00.000Z",
    windowEnd: "2026-02-11T13:00:00.000Z",
    localDay: "2026-02-10",
    status: "running",
    attemptCount: 1,
    runId: null,
    runStatus: null,
    errorCode: null,
    errorDetail: null,
    skipReason: null,
    triggerRunId: null,
    claimedAt: "2026-02-10T13:00:05.000Z",
    startedAt: null,
    finishedAt: null,
    version: 1,
    manualOverride: false,
    ...over,
  };
}

const schedSession = {
  isolation: "repeatable read" as const,
  readOnly: false,
  firmId: FIRM_A,
  clientId: CLIENT_A1,
  actorId: ACTOR,
  actorKind: "schedule" as const,
};

test("a second insert of the same schedule and window start is refused", async () => {
  const db = baseDb();
  await db.tx(schedSession, async (tx) => {
    await tx.insert("sched_windows", [windowRow()]);
  });
  await assertRejects(
    () =>
      db.tx(schedSession, async (tx) => {
        // A different row id, the same window. This is exactly what a
        // Trigger.dev retry of a task that already claimed looks like.
        await tx.insert("sched_windows", [windowRow({ id: "WIN-0002" })]);
      }),
    "window_one_per_schedule_start",
    "the store refuses the duplicate, the task does not have to remember to check",
  );
});

test("a different window start on the same schedule is allowed", async () => {
  const db = baseDb();
  await db.tx(schedSession, async (tx) => {
    await tx.insert("sched_windows", [windowRow()]);
    await tx.insert("sched_windows", [
      windowRow({
        id: "WIN-0002",
        windowStart: "2026-02-11T13:00:00.000Z",
        windowEnd: "2026-02-12T13:00:00.000Z",
        localDay: "2026-02-11",
      }),
    ]);
  });
  const rows = await db.tx({ ...schedSession, readOnly: true }, async (tx) =>
    tx.query("sched_windows_for_schedule", {
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      scheduleId: "SCH-NIGHTLY-A1",
      limit: 10,
    }),
  );
  assertEqual(rows.length, 2, "two nights, two windows");
  assertEqual(rows[0].localDay, "2026-02-11", "newest first");
});

test("the unique violation carries the constraint name a reader can search for", async () => {
  const db = new MemoryRunDb();
  let seen = "";
  try {
    await db.tx(schedSession, async (tx) => {
      await tx.insert("sched_windows", [windowRow()]);
      await tx.insert("sched_windows", [windowRow({ id: "WIN-0003" })]);
    });
  } catch (err) {
    seen = err instanceof UniqueViolation ? err.message : "wrong error";
  }
  assert(
    seen.includes("window_one_per_schedule_start"),
    `expected the constraint name in the message, got ${seen}`,
  );
});

// ---------------------------------------------------------------------------
// A tick, end to end, on the memory port.
// ---------------------------------------------------------------------------

function seedSchedule(db: MemoryRunDb, row: SchedScheduleRow): void {
  db.seed("sched_schedules", [row]);
}

function seedLastNight(db: MemoryRunDb): void {
  // Every tick test below starts from a schedule that ran yesterday, so the
  // plan is one window rather than the seven a brand new schedule is allowed.
  db.seed("sched_windows", [
    windowRow({
      id: "WIN-YESTERDAY",
      windowStart: "2026-02-09T13:00:00.000Z",
      windowEnd: "2026-02-10T13:00:00.000Z",
      localDay: "2026-02-09",
      status: "succeeded",
      finishedAt: "2026-02-09T13:02:00.000Z",
    }),
  ]);
}

test("a tick claims a window, runs it, and closes it", async () => {
  const db = baseDb();
  seedSchedule(db, schedule({ runType: "REC-FLAG-STALE", tier: "unattended" }));
  seedLastNight(db);
  const report = await tick(db, {
    actor: { firmId: FIRM_A, userId: ACTOR },
    now: new Date("2026-02-10T13:05:00Z"),
    cadences: ["daily"],
    triggerRunId: "run_abc123",
  });
  assertEqual(report.schedulesConsidered, 1, "one schedule");
  assertEqual(report.windowsClaimed, 1, "one window claimed");
  assertEqual(report.windowsLostToRace, 0, "no race on an empty table");
  assertEqual(report.outcomes.length, 1, "one outcome");
  assertEqual(report.outcomes[0].status, "succeeded", "and it landed");
});

test("running the same tick twice claims nothing the second time", async () => {
  const db = baseDb();
  seedSchedule(db, schedule({ runType: "REC-FLAG-STALE", tier: "unattended" }));
  seedLastNight(db);
  const now = new Date("2026-02-10T13:05:00Z");
  const first = await tick(db, {
    actor: { firmId: FIRM_A, userId: ACTOR },
    now,
    cadences: ["daily"],
  });
  const second = await tick(db, {
    actor: { firmId: FIRM_A, userId: ACTOR },
    now,
    cadences: ["daily"],
  });
  assertEqual(first.windowsClaimed, 1, "the first tick did the work");
  assertEqual(second.windowsClaimed, 0, "the second claimed nothing");
  assertEqual(second.outcomes.length, 0, "and ran nothing");
});

test("a schedule frozen by hand is left alone", async () => {
  const db = baseDb();
  seedSchedule(
    db,
    schedule({ runType: "REC-FLAG-STALE", tier: "unattended", manualOverride: true }),
  );
  const report = await tick(db, {
    actor: { firmId: FIRM_A, userId: ACTOR },
    now: new Date("2026-02-10T13:05:00Z"),
    cadences: ["daily"],
  });
  assertEqual(report.windowsClaimed, 0, "invariant 8 covers a cadence too");
});

test("a window pointing at a manual run fails the window and posts nothing", async () => {
  const db = baseDb();
  // The database constraint makes this row impossible in Postgres. The memory
  // port has no constraints, which is exactly why the executor guard and the
  // runner guard both exist: the row is here, and nothing runs anyway.
  seedSchedule(
    db,
    schedule({
      runType: "CLOSE-LOCK-PERIOD",
      tier: "unattended",
      executionMode: "apply",
    }),
  );
  seedLastNight(db);
  const report = await tick(db, {
    actor: { firmId: FIRM_A, userId: ACTOR },
    now: new Date("2026-02-10T13:05:00Z"),
    cadences: ["daily"],
  });
  assertEqual(report.windowsFailed, 1, "the window failed");
  assertEqual(report.outcomes[0].errorCode, "TIER_REFUSED", "for the right reason");
});

test("a tick records the skipped windows a long gap produced", async () => {
  const db = baseDb();
  seedSchedule(db, schedule({ runType: "REC-FLAG-STALE", tier: "unattended" }));
  db.seed("sched_windows", [
    windowRow({
      id: "WIN-OLD",
      windowStart: "2026-01-21T13:00:00.000Z",
      windowEnd: "2026-01-22T13:00:00.000Z",
      localDay: "2026-01-21",
      status: "succeeded",
      finishedAt: "2026-01-21T13:02:00.000Z",
    }),
  ]);
  const report = await tick(db, {
    actor: { firmId: FIRM_A, userId: ACTOR },
    now: new Date("2026-02-10T13:05:00Z"),
    cadences: ["daily"],
  });
  assertEqual(report.windowsClaimed, CATCH_UP_MAX_WINDOWS, "the newest seven ran");
  assert(report.windowsSkipped > 0, "and the gap was written down rather than forgotten");
});

test("the status read leads with what needs a person", async () => {
  const db = baseDb();
  seedSchedule(
    db,
    schedule({
      runType: "AR-BUILD-STATEMENTS",
      tier: "propose",
      executionMode: "preview",
      consecutiveFailures: 3,
      lastFailureAt: "2026-02-09T13:00:00.000Z",
      lastFailureDetail: "the statement template is missing",
    }),
  );
  db.seed("sched_windows", [
    windowRow({
      id: "WIN-SKIP",
      status: "skipped",
      skipReason: "outside_catch_up_bound",
      finishedAt: "2026-02-10T13:00:01.000Z",
    }),
  ]);
  const status = await schedulerStatus(
    db,
    { firmId: FIRM_A, userId: ACTOR },
    new Date("2026-02-10T14:00:00Z"),
  );
  assertEqual(status.failing.length, 1, "one failing schedule");
  assertEqual(status.missed.length, 1, "one missed window");
  assert(
    (status.missed[0].detail ?? "").includes("catch up bound"),
    "and the reason is in words rather than a code",
  );
  assertEqual(status.catchUpDays, CATCH_UP_DAYS, "the bound is reported");
  assertEqual(status.schedules[0].tier, "propose", "the tier is on the surface");
  assert(
    status.schedules[0].cadence.includes("every day at 06:00"),
    "and the cadence is in words",
  );
});
