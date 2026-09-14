/**
 * The scheduler, as seen from inside this process.
 *
 * Trigger.dev owns the clock. Everything below owns what the clock means. The
 * tasks in trigger/scheduler.ts are four lines each and call into here, which
 * is deliberate: a task body is code running on somebody else's platform, in a
 * bundle built by their CLI, and the less of this system lives there the less
 * of it is untestable from here. Every test in server/runs/__tests__ that
 * covers the scheduler runs against this file with the memory port and no
 * network.
 *
 * The shape of a tick:
 *
 *   1. Read every enabled schedule for the firm.
 *   2. For each, read the newest window already recorded.
 *   3. Plan the windows owed, bounded by plan.ts.
 *   4. Insert each window row. The unique constraint on
 *      (schedule_id, window_start) decides who gets it, and losing that race
 *      is a normal outcome rather than an error.
 *   5. Execute the ones we inserted.
 *
 * Step 4 is the whole design. Trigger.dev may retry a task that already did
 * its work, may overlap two ticks, and may fire the nightly task twice from
 * two deployments during a promotion. None of that is prevented by care in the
 * task body. It is prevented by the second insert being refused.
 *
 * The consequence is that this code claims a window before it runs anything,
 * and only ever runs what it claimed.
 */

import { execute } from "../runs/execute";
import { ulid } from "../runs/ids";
import { lookupRun } from "../runs/registry";
import { scheduledModeFor, tierOf } from "../runs/policy";
import { UniqueViolation, type RunDb, type TxSession } from "../runs/db";
import type { Ulid } from "../runs/contract";
import type { SchedScheduleRow, SchedWindowRow } from "../runs/tables";
import {
  CATCH_UP_DAYS,
  cadenceOf,
  planWindows,
  type PlannedWindow,
  type SkipReason,
} from "./plan";
import { cadenceFireInstants } from "../runs/dates";

const DAY_MS = 86_400_000;

/**
 * A window claimed and then abandoned, by a task that was killed, a deploy
 * that cut a run short, or a process that lost its database connection
 * mid flight. After this long the sweep takes it back.
 *
 * Twenty minutes rather than five, because a long import on a large client is
 * a real thing and taking a window back from a run that is still working
 * would mean two of them.
 */
export const STALE_CLAIM_MS = 20 * 60_000;

/**
 * The actor a schedule runs as.
 *
 * A firm scope service membership, not a person. Row level security answers
 * tenancy.has_client_access from this actor's memberships, which is what lets
 * one tick read every client in the firm, and the run log records it so no
 * automated posting is ever attributed to Jose Hernandez or Rosario Rosales.
 */
export interface SchedulerActor {
  userId: Ulid;
  firmId: Ulid;
}

export interface TickOptions {
  actor: SchedulerActor;
  now: Date;
  /** Restrict to schedules of these cadences. The nightly tick passes daily. */
  cadences?: ReadonlyArray<SchedScheduleRow["cadence"]>;
  /** Trigger.dev's run identifier, stored so a trace goes both directions. */
  triggerRunId?: string | null;
  /**
   * True for the sweep. A sweep also reclaims stale claims and re drives
   * windows an earlier tick recorded and did not finish.
   */
  sweep?: boolean;
}

export interface WindowOutcome {
  scheduleId: string;
  scheduleName: string;
  runType: string;
  windowStart: string;
  localDay: string;
  status: SchedWindowRow["status"];
  runId: string | null;
  errorCode: string | null;
  skipReason: string | null;
}

export interface TickReport {
  startedAt: string;
  finishedAt: string;
  schedulesConsidered: number;
  windowsClaimed: number;
  windowsLostToRace: number;
  windowsSucceeded: number;
  windowsFailed: number;
  windowsSkipped: number;
  reclaimedStaleClaims: number;
  outcomes: WindowOutcome[];
}

function writeSession(
  actor: SchedulerActor,
  clientId: Ulid,
  runId?: string,
): TxSession {
  return {
    isolation: "repeatable read",
    readOnly: false,
    firmId: actor.firmId,
    clientId,
    actorId: actor.userId,
    actorKind: "schedule",
    runId,
  };
}

/**
 * The placeholder client id on a firm wide transaction.
 *
 * app.client_id is diagnostic only. Row level security reads the actor's
 * memberships, not this value, so a firm wide read is still correctly
 * filtered. A real client id here would be a lie about what the transaction
 * touched, and an empty string would be harder to recognise in a log.
 */
export const ALL_CLIENTS: Ulid = "00000000000000000000000000";

function readSession(actor: SchedulerActor, clientId: Ulid): TxSession {
  return {
    isolation: "repeatable read",
    readOnly: true,
    firmId: actor.firmId,
    clientId,
    actorId: actor.userId,
    actorKind: "schedule",
  };
}

function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** One tick. Safe to run concurrently with another, by construction. */
export async function tick(db: RunDb, opts: TickOptions): Promise<TickReport> {
  const startedAt = opts.now.toISOString();
  const report: TickReport = {
    startedAt,
    finishedAt: startedAt,
    schedulesConsidered: 0,
    windowsClaimed: 0,
    windowsLostToRace: 0,
    windowsSucceeded: 0,
    windowsFailed: 0,
    windowsSkipped: 0,
    reclaimedStaleClaims: 0,
    outcomes: [],
  };

  const schedules = await db.tx(
    readSession(opts.actor, ALL_CLIENTS),
    async (tx) =>
      tx.query("sched_due_schedules_for_firm", {
        firmId: opts.actor.firmId,
        onDay: isoDay(opts.now),
      }),
  );

  const wanted = opts.cadences
    ? schedules.filter((s) => opts.cadences?.includes(s.cadence))
    : schedules;
  report.schedulesConsidered = wanted.length;

  if (opts.sweep) {
    report.reclaimedStaleClaims = await reclaimStaleClaims(db, opts);
  }

  for (const schedule of wanted) {
    // A schedule a person froze by hand is left alone. Invariant 8 covers
    // rows, and a frozen schedule is the same statement about a cadence.
    if (schedule.manualOverride) continue;

    const recent = await db.tx(
      readSession(opts.actor, schedule.clientId),
      async (tx) =>
        tx.query("sched_windows_for_schedule", {
          firmId: opts.actor.firmId,
          clientId: schedule.clientId,
          scheduleId: schedule.id,
          limit: 1,
        }),
    );
    const lastStart = recent.length > 0 ? recent[0].windowStart : null;
    const plan = planWindows(schedule, lastStart, opts.now);

    for (const skip of plan.skipped) {
      const claimed = await claimWindow(db, opts, schedule, skip, "skipped", skip.reason);
      if (claimed === null) {
        report.windowsLostToRace += 1;
        continue;
      }
      report.windowsSkipped += 1;
      report.outcomes.push({
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        runType: schedule.runType,
        windowStart: skip.windowStart.toISOString(),
        localDay: skip.localDay,
        status: "skipped",
        runId: null,
        errorCode: null,
        skipReason: skip.reason,
      });
    }

    for (const window of plan.due) {
      const claimed = await claimWindow(db, opts, schedule, window, "running", null);
      if (claimed === null) {
        // Another tick, or a retry of this one, already has it. Not an error.
        report.windowsLostToRace += 1;
        continue;
      }
      report.windowsClaimed += 1;
      const outcome = await runWindow(db, opts, schedule, claimed);
      if (outcome.status === "succeeded") report.windowsSucceeded += 1;
      else if (outcome.status === "failed") report.windowsFailed += 1;
      else if (outcome.status === "skipped") report.windowsSkipped += 1;
      report.outcomes.push(outcome);
    }
  }

  if (opts.sweep) {
    const redriven = await redriveOutstanding(db, opts, wanted);
    for (const outcome of redriven) {
      if (outcome.status === "succeeded") report.windowsSucceeded += 1;
      else if (outcome.status === "failed") report.windowsFailed += 1;
      report.outcomes.push(outcome);
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

/**
 * Write the window row, or discover somebody else already did.
 *
 * The return value is the row on success and null when the insert collided,
 * and the caller treats null as an ordinary outcome. That is the contract that
 * makes a Trigger.dev retry harmless: the retry reaches this function, the
 * database refuses it, and the retry does nothing rather than doing the work
 * a second time.
 */
async function claimWindow(
  db: RunDb,
  opts: TickOptions,
  schedule: SchedScheduleRow,
  window: PlannedWindow,
  status: SchedWindowRow["status"],
  skipReason: SkipReason | null,
): Promise<SchedWindowRow | null> {
  const row: SchedWindowRow = {
    id: ulid(opts.now),
    firmId: schedule.firmId,
    clientId: schedule.clientId,
    scheduleId: schedule.id,
    windowStart: window.windowStart.toISOString(),
    windowEnd: window.windowEnd.toISOString(),
    localDay: window.localDay,
    status,
    attemptCount: status === "running" ? 1 : 0,
    runId: null,
    runStatus: null,
    errorCode: null,
    errorDetail: null,
    skipReason,
    triggerRunId: opts.triggerRunId ?? null,
    claimedAt: status === "running" ? opts.now.toISOString() : null,
    startedAt: null,
    finishedAt: status === "skipped" ? opts.now.toISOString() : null,
    version: 1,
    manualOverride: false,
  };
  try {
    await db.tx(writeSession(opts.actor, schedule.clientId), async (tx) => {
      await tx.insert("sched_windows", [row]);
    });
    return row;
  } catch (err) {
    if (err instanceof UniqueViolation) return null;
    throw err;
  }
}

/**
 * Run one claimed window.
 *
 * An unattended schedule still previews before it applies. Doc 03 Part 2 says
 * apply re derives from a preview and never trusts a caller's plan, and that
 * rule does not weaken because the caller is a clock. So the sequence is
 * preview, then apply naming the preview, which is exactly what a person
 * pressing the button does and produces the same two log rows.
 *
 * A propose schedule stops after the preview. That is the tier: the proposals
 * and the log row are there in the morning, and a person decides.
 */
async function runWindow(
  db: RunDb,
  opts: TickOptions,
  schedule: SchedScheduleRow,
  window: SchedWindowRow,
): Promise<WindowOutcome> {
  const base: WindowOutcome = {
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    runType: schedule.runType,
    windowStart: window.windowStart,
    localDay: window.localDay,
    status: "failed",
    runId: null,
    errorCode: null,
    skipReason: null,
  };

  const entry = lookupRun(schedule.runType);
  if (entry === null) {
    await finishWindow(db, opts, schedule, window, {
      status: "failed",
      errorCode: "UNKNOWN_RUN_TYPE",
      errorDetail: `${schedule.runType} is not in the registry, so this schedule points at software that does not exist`,
    });
    return { ...base, errorCode: "UNKNOWN_RUN_TYPE" };
  }

  // The tier is checked here as well as inside the executor. Here it stops the
  // window before a run log row exists, there it stops any caller at all. The
  // duplication is the point: this is the boundary a service outside the
  // process is crossing.
  const tier = tierOf(schedule.runType);
  if (tier === null || tier === "manual") {
    await finishWindow(db, opts, schedule, window, {
      status: "failed",
      errorCode: "TIER_REFUSED",
      errorDetail: `${schedule.runType} is ${tier ?? "unclassified"} and a clock may not start it`,
    });
    return { ...base, errorCode: "TIER_REFUSED" };
  }
  const allowed = scheduledModeFor(tier);
  if (allowed === null || allowed !== schedule.executionMode) {
    await finishWindow(db, opts, schedule, window, {
      status: "failed",
      errorCode: "TIER_REFUSED",
      errorDetail: `${schedule.runType} is ${tier} and may only be scheduled in ${String(allowed)} mode, the schedule asks for ${schedule.executionMode}`,
    });
    return { ...base, errorCode: "TIER_REFUSED" };
  }

  const scope = {
    ...schedule.scopeJson,
    firmId: schedule.firmId,
    clientId: schedule.clientId,
    // The window supplies the dates, so a catch up run covers the day it is
    // catching up on rather than today.
    from: window.localDay,
    to: window.localDay,
    asOf: window.localDay,
  };

  try {
    const preview = await execute(db, entry.run, scope, {
      mode: "preview",
      firmId: schedule.firmId,
      clientId: schedule.clientId,
      actor: { userId: opts.actor.userId, kind: "schedule" },
      now: opts.now,
      source: "cron",
      unattended: true,
    });

    if (schedule.executionMode === "preview") {
      const failed = preview.status === "refused" || preview.status === "failed";
      await finishWindow(db, opts, schedule, window, {
        status: failed ? "failed" : "succeeded",
        runId: preview.executionId,
        runStatus: preview.status,
        errorCode: failed ? firstErrorCode(preview) : null,
        errorDetail: failed ? firstErrorMessage(preview) : null,
      });
      return {
        ...base,
        status: failed ? "failed" : "succeeded",
        runId: preview.executionId,
        errorCode: failed ? firstErrorCode(preview) : null,
      };
    }

    if (preview.status === "refused" || preview.status === "failed") {
      await finishWindow(db, opts, schedule, window, {
        status: "failed",
        runId: preview.executionId,
        runStatus: preview.status,
        errorCode: firstErrorCode(preview),
        errorDetail: firstErrorMessage(preview),
      });
      return {
        ...base,
        runId: preview.executionId,
        errorCode: firstErrorCode(preview),
      };
    }

    const applied = await execute(db, entry.run, scope, {
      mode: "apply",
      firmId: schedule.firmId,
      clientId: schedule.clientId,
      actor: { userId: opts.actor.userId, kind: "schedule" },
      now: opts.now,
      source: "cron",
      previewRunId: preview.executionId,
      unattended: true,
    });
    const failed = applied.status === "refused" || applied.status === "failed";
    await finishWindow(db, opts, schedule, window, {
      status: failed ? "failed" : "succeeded",
      runId: applied.executionId,
      runStatus: applied.status,
      errorCode: failed ? firstErrorCode(applied) : null,
      errorDetail: failed ? firstErrorMessage(applied) : null,
    });
    return {
      ...base,
      status: failed ? "failed" : "succeeded",
      runId: applied.executionId,
      errorCode: failed ? firstErrorCode(applied) : null,
    };
  } catch (err) {
    // A thrown run is a bug or a store failure, and either way the window has
    // to stop being running or the sweep will chase it forever.
    const message = err instanceof Error ? err.message : String(err);
    await finishWindow(db, opts, schedule, window, {
      status: "failed",
      errorCode: "RUN_THREW",
      errorDetail: message.slice(0, 500),
    });
    return { ...base, errorCode: "RUN_THREW" };
  }
}

function firstErrorCode(outcome: { result: { errors: Array<{ code: string }> } }): string {
  return outcome.result.errors.length > 0 ? outcome.result.errors[0].code : "REFUSED";
}

function firstErrorMessage(outcome: {
  result: { errors: Array<{ message: string }> };
}): string | null {
  return outcome.result.errors.length > 0
    ? outcome.result.errors[0].message.slice(0, 500)
    : null;
}

interface Finish {
  status: SchedWindowRow["status"];
  runId?: string | null;
  runStatus?: string | null;
  errorCode?: string | null;
  errorDetail?: string | null;
}

/**
 * Close the window and move the schedule's failure counter.
 *
 * The counter is on the schedule rather than derived, because the operator
 * surface asks "what is broken" far more often than it asks "what happened",
 * and two consecutive failures is the line between a bad night and a thing
 * somebody has to look at.
 */
async function finishWindow(
  db: RunDb,
  opts: TickOptions,
  schedule: SchedScheduleRow,
  window: SchedWindowRow,
  finish: Finish,
): Promise<void> {
  await db.tx(
    writeSession(opts.actor, schedule.clientId, finish.runId ?? undefined),
    async (tx) => {
      await tx.update("sched_windows", window.id, {
        status: finish.status,
        runId: finish.runId ?? null,
        runStatus: finish.runStatus ?? null,
        errorCode: finish.errorCode ?? null,
        errorDetail: finish.errorDetail ?? null,
        startedAt: window.claimedAt,
        finishedAt: opts.now.toISOString(),
      });
      if (finish.status === "succeeded") {
        if (schedule.consecutiveFailures !== 0) {
          await tx.update("sched_schedules", schedule.id, {
            consecutiveFailures: 0,
          });
        }
      } else if (finish.status === "failed") {
        await tx.update("sched_schedules", schedule.id, {
          consecutiveFailures: schedule.consecutiveFailures + 1,
          lastFailureAt: opts.now.toISOString(),
          lastFailureDetail:
            finish.errorDetail ?? finish.errorCode ?? "no detail recorded",
        });
      }
    },
  );
}

/**
 * Windows somebody claimed and never closed.
 *
 * A task killed mid flight leaves status running forever, and nothing else in
 * the system will ever look at it again, so the sweep puts it back to due. The
 * attempt count is not reset, so a window that keeps dying is visible as a
 * window that keeps dying rather than as a fresh one every six hours.
 */
async function reclaimStaleClaims(db: RunDb, opts: TickOptions): Promise<number> {
  const since = new Date(opts.now.getTime() - CATCH_UP_DAYS * DAY_MS).toISOString();
  const outstanding = await db.tx(
    readSession(opts.actor, ALL_CLIENTS),
    async (tx) =>
      tx.query("sched_outstanding_windows_for_firm", {
        firmId: opts.actor.firmId,
        since,
      }),
  );
  let reclaimed = 0;
  for (const w of outstanding) {
    if (w.status !== "running" || w.manualOverride) continue;
    const claimedAt = w.claimedAt === null ? 0 : Date.parse(w.claimedAt);
    if (opts.now.getTime() - claimedAt < STALE_CLAIM_MS) continue;
    await db.tx(writeSession(opts.actor, w.clientId), async (tx) => {
      await tx.update("sched_windows", w.id, {
        status: "due",
        errorCode: "CLAIM_EXPIRED",
        errorDetail: `claimed at ${String(w.claimedAt)} and never finished, so the sweep took it back`,
      });
    });
    reclaimed += 1;
  }
  return reclaimed;
}

/**
 * Windows that exist, are still due, and nobody is running.
 *
 * These are the missed ones. A tick only plans windows newer than the last one
 * recorded, so a window recorded and then abandoned would never be planned
 * again by anything. The sweep is the only thing that picks them up.
 */
async function redriveOutstanding(
  db: RunDb,
  opts: TickOptions,
  schedules: readonly SchedScheduleRow[],
): Promise<WindowOutcome[]> {
  const since = new Date(opts.now.getTime() - CATCH_UP_DAYS * DAY_MS).toISOString();
  const outstanding = await db.tx(
    readSession(opts.actor, ALL_CLIENTS),
    async (tx) =>
      tx.query("sched_outstanding_windows_for_firm", {
        firmId: opts.actor.firmId,
        since,
      }),
  );
  const byId = new Map(schedules.map((s) => [s.id, s]));
  const out: WindowOutcome[] = [];
  let budget = 0;
  for (const w of outstanding) {
    if (w.status !== "due" || w.manualOverride) continue;
    const schedule = byId.get(w.scheduleId);
    if (schedule === undefined || schedule.manualOverride) continue;
    budget += 1;
    if (budget > schedules.length * 2) break;
    const claimed = await db.tx(
      writeSession(opts.actor, w.clientId),
      async (tx) => {
        await tx.update("sched_windows", w.id, {
          status: "running",
          attemptCount: w.attemptCount + 1,
          claimedAt: opts.now.toISOString(),
          triggerRunId: opts.triggerRunId ?? w.triggerRunId,
        });
        return {
          ...w,
          status: "running" as const,
          attemptCount: w.attemptCount + 1,
          claimedAt: opts.now.toISOString(),
        };
      },
    );
    out.push(await runWindow(db, opts, schedule, claimed));
  }
  return out;
}

/**
 * The next time a schedule will fire, computed rather than stored.
 *
 * Nothing writes a next_run_at column, so nothing can leave a stale one
 * behind. The operator surface asks for this when it renders a schedule.
 */
export function nextFireAt(schedule: SchedScheduleRow, now: Date): Date | null {
  const ahead = cadenceFireInstants(
    cadenceOf(schedule),
    now.getTime(),
    now.getTime() + 400 * DAY_MS,
  );
  return ahead.length > 0 ? new Date(ahead[0]) : null;
}
