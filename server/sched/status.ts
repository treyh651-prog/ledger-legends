/**
 * What the operator needs to see, and nothing else.
 *
 * The question a person actually asks in the morning is not "what ran". It is
 * "did anything not run, and is anything waiting for me". So this read path
 * leads with the two answers that require action and puts the history behind
 * them:
 *
 *   failing      two or more consecutive failures, which is the line between
 *                a bad night and a broken thing.
 *   waiting      propose tier windows that succeeded, which means a proposal
 *                set is sitting there with nobody's decision on it.
 *   missed       windows recorded and skipped, each carrying the reason.
 *   stalled      claimed and never finished, which a sweep will take back.
 *
 * Read only, and derived. There is no stored next_run_at to go stale: the next
 * fire is computed from the cadence every time it is asked for.
 */

import type { RunDb } from "../runs/db";
import { tierOf, tierReasonOf } from "../runs/policy";
import type { SchedScheduleRow, SchedWindowRow } from "../runs/tables";
import { CATCH_UP_DAYS, skipReasonText, type SkipReason } from "./plan";
import { ALL_CLIENTS, nextFireAt, STALE_CLAIM_MS, type SchedulerActor } from "./runner";

const DAY_MS = 86_400_000;

export interface ScheduleStatus {
  scheduleId: string;
  name: string;
  runType: string;
  tier: string;
  tierReason: string;
  cadence: string;
  timezone: string;
  executionMode: string;
  enabled: boolean;
  frozenByHand: boolean;
  nextFireAt: string | null;
  lastWindowStart: string | null;
  lastWindowStatus: string | null;
  lastRunId: string | null;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastFailureDetail: string | null;
}

export interface WindowNote {
  scheduleName: string;
  runType: string;
  localDay: string;
  windowStart: string;
  status: string;
  runId: string | null;
  detail: string | null;
}

export interface SchedulerStatus {
  asOf: string;
  catchUpDays: number;
  schedules: ScheduleStatus[];
  failing: ScheduleStatus[];
  waitingForApproval: WindowNote[];
  missed: WindowNote[];
  stalled: WindowNote[];
  recent: WindowNote[];
  counts: {
    schedules: number;
    enabled: number;
    succeeded: number;
    failed: number;
    skipped: number;
    outstanding: number;
  };
}

/** Plain English for a cadence, because a person reads this at 7am. */
export function cadenceText(s: SchedScheduleRow): string {
  const at = `${String(s.localHour).padStart(2, "0")}:${String(s.localMinute).padStart(2, "0")}`;
  switch (s.cadence) {
    case "daily":
      return `every day at ${at}`;
    case "weekly":
      return `every ${String(s.weekday)} at ${at}`;
    case "monthly_day":
      return `day ${String(s.dayOfMonth)} of each month at ${at}, clamped to the last day of short months`;
    case "monthly_business_day":
      return `business day ${String(s.businessDay)} of each month at ${at}, weekends only, no holiday calendar`;
    default:
      return s.cadence;
  }
}

function noteOf(
  window: SchedWindowRow,
  schedules: Map<string, SchedScheduleRow>,
  detail: string | null,
): WindowNote {
  const s = schedules.get(window.scheduleId);
  return {
    scheduleName: s?.name ?? window.scheduleId,
    runType: s?.runType ?? "unknown",
    localDay: window.localDay,
    windowStart: window.windowStart,
    status: window.status,
    runId: window.runId,
    detail,
  };
}

export async function schedulerStatus(
  db: RunDb,
  actor: SchedulerActor,
  now: Date,
  historyDays = CATCH_UP_DAYS,
): Promise<SchedulerStatus> {
  const session = {
    isolation: "repeatable read" as const,
    readOnly: true,
    firmId: actor.firmId,
    clientId: ALL_CLIENTS,
    actorId: actor.userId,
    actorKind: "schedule" as const,
  };
  const since = new Date(now.getTime() - historyDays * DAY_MS).toISOString();

  const { schedules, recent } = await db.tx(session, async (tx) => ({
    schedules: await tx.query("sched_due_schedules_for_firm", {
      firmId: actor.firmId,
      onDay: now.toISOString().slice(0, 10),
    }),
    recent: await tx.query("sched_recent_windows_for_firm", {
      firmId: actor.firmId,
      since,
      limit: 200,
    }),
  }));

  const byId = new Map(schedules.map((s) => [s.id, s]));
  const newestFor = new Map<string, SchedWindowRow>();
  for (const w of recent) {
    const held = newestFor.get(w.scheduleId);
    if (held === undefined || w.windowStart > held.windowStart) {
      newestFor.set(w.scheduleId, w);
    }
  }

  const rows: ScheduleStatus[] = schedules.map((s) => {
    const last = newestFor.get(s.id) ?? null;
    const next = nextFireAt(s, now);
    return {
      scheduleId: s.id,
      name: s.name,
      runType: s.runType,
      tier: tierOf(s.runType) ?? "unclassified",
      tierReason: tierReasonOf(s.runType) ?? "no policy entry, so a clock may not start it",
      cadence: cadenceText(s),
      timezone: s.timezone,
      executionMode: s.executionMode,
      enabled: s.enabled,
      frozenByHand: s.manualOverride,
      nextFireAt: next === null ? null : next.toISOString(),
      lastWindowStart: last?.windowStart ?? null,
      lastWindowStatus: last?.status ?? null,
      lastRunId: last?.runId ?? null,
      consecutiveFailures: s.consecutiveFailures,
      lastFailureAt: s.lastFailureAt,
      lastFailureDetail: s.lastFailureDetail,
    };
  });

  const waiting: WindowNote[] = [];
  const missed: WindowNote[] = [];
  const stalled: WindowNote[] = [];
  const counts = {
    schedules: schedules.length,
    enabled: schedules.filter((s) => s.enabled).length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    outstanding: 0,
  };

  for (const w of recent) {
    const s = byId.get(w.scheduleId);
    if (w.status === "succeeded") {
      counts.succeeded += 1;
      if (s !== undefined && s.executionMode === "preview") {
        waiting.push(
          noteOf(w, byId, "a proposal set is prepared and nothing is posted until a person approves it"),
        );
      }
    } else if (w.status === "failed") {
      counts.failed += 1;
    } else if (w.status === "skipped") {
      counts.skipped += 1;
      const reason = (w.skipReason ?? "outside_catch_up_bound") as SkipReason;
      missed.push(noteOf(w, byId, skipReasonText(reason)));
    } else {
      counts.outstanding += 1;
      const claimedAt = w.claimedAt === null ? 0 : Date.parse(w.claimedAt);
      const stale = w.status === "running" && now.getTime() - claimedAt >= STALE_CLAIM_MS;
      stalled.push(
        noteOf(
          w,
          byId,
          stale
            ? "claimed and not finished, so the next sweep will take it back"
            : "waiting for the next tick",
        ),
      );
    }
  }

  return {
    asOf: now.toISOString(),
    catchUpDays: CATCH_UP_DAYS,
    schedules: rows,
    failing: rows
      .filter((r) => r.consecutiveFailures >= 2)
      .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures),
    waitingForApproval: waiting,
    missed,
    stalled,
    recent: recent
      .slice(0, 40)
      .map((w) => noteOf(w, byId, w.errorDetail ?? w.skipReason)),
    counts,
  };
}
