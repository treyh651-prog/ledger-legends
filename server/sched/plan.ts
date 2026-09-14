/**
 * Which windows a schedule owes, and which ones it is no longer going to run.
 *
 * Pure arithmetic. Nothing here reads or writes the database, so the catch up
 * bound and the daylight saving behaviour can be tested without a store, and
 * the part that is easy to get wrong is the part with no side effects.
 *
 * THE CATCH UP BOUND, and why it is seven.
 *
 * Trigger.dev will miss windows. Their side has outages, a deployment can be
 * mid promotion when a tick was due, and a task that throws past its retries
 * leaves a window unfinished. So the sweep exists, and the sweep needs a
 * limit, because the alternative is a system that comes back from a long
 * outage and starts a hundred runs at once.
 *
 * Two numbers, whichever binds first: seven days of lookback, and seven
 * windows per schedule per sweep.
 *
 * Seven days, because of what these runs are. A nightly derived refresh is
 * idempotent in the useful sense: rerunning last Tuesday's vendor
 * normalization lands on the same answer it would have landed on that night,
 * so replaying a week of them costs seven runs and produces one correct state.
 * Ninety days does not have that property. A run that far back re derives
 * history whose inputs have since changed, and it does so in a period that may
 * now be locked, so the sweep would be manufacturing work whose output is
 * wrong in a way nobody would notice.
 *
 * Seven windows, because a daily schedule and a weekly schedule and a monthly
 * schedule all share this bound, and seven days of a daily cadence is seven
 * windows while seven days of a monthly cadence is at most one. The window
 * count is the one that binds for a schedule that fires more often than daily,
 * if one is ever added.
 *
 * And the part that matters more than either number: a gap longer than the
 * bound is not papered over. Every window outside it is written down as
 * skipped with the reason attached, so npm run sched:status shows a person
 * exactly what did not run. An outage longer than a week is an event somebody
 * should look at, not something a sweep quietly absorbs at 3am.
 */

import {
  cadenceFireInstants,
  zonedDay,
  type Cadence,
} from "../runs/dates";
import type { SchedScheduleRow } from "../runs/tables";

/** Days of history a sweep will reach back into. */
export const CATCH_UP_DAYS = 7;

/** Windows one schedule may be given in one sweep. */
export const CATCH_UP_MAX_WINDOWS = 7;

/**
 * How far back the planner enumerates at all, so that windows outside the
 * catch up bound can be named rather than silently omitted. Beyond this the
 * gap is an outage whose shape is in the operator's own records, and
 * enumerating a year of a daily cadence to write a year of skip rows would be
 * its own kind of noise.
 */
export const SKIP_RECORD_DAYS = 30;

const DAY_MS = 86_400_000;

export type SkipReason = "outside_catch_up_bound" | "catch_up_window_limit";

export interface PlannedWindow {
  /** The instant the cadence fired at, in UTC. */
  windowStart: Date;
  /** The instant the next fire lands on. Half open, so the pair never overlap. */
  windowEnd: Date;
  /** The local calendar day the window belongs to, in the schedule's zone. */
  localDay: string;
}

export interface WindowPlan {
  /** Oldest first, so a catch up replays in the order the days happened. */
  due: PlannedWindow[];
  /** Recorded rather than run, each with the reason it was passed over. */
  skipped: Array<PlannedWindow & { reason: SkipReason }>;
}

/** The cadence a schedule row describes, in the shape dates.ts works in. */
export function cadenceOf(schedule: SchedScheduleRow): Cadence {
  return {
    kind: schedule.cadence,
    hour: schedule.localHour,
    minute: schedule.localMinute,
    timeZone: schedule.timezone,
    weekday: schedule.weekday,
    dayOfMonth: schedule.dayOfMonth,
    businessDay: schedule.businessDay,
  };
}

/**
 * The instant a window closes, which is the next time the same cadence fires.
 *
 * Looked forward rather than assumed, because "a day later" is 23 or 25 hours
 * twice a year and "a month later" is between 28 and 31 days. Four hundred
 * days of lookahead covers the longest gap any of the four cadences can leave.
 */
function nextFireAfter(cadence: Cadence, startMs: number): Date {
  const ahead = cadenceFireInstants(cadence, startMs, startMs + 400 * DAY_MS);
  if (ahead.length > 0) return new Date(ahead[0]);
  // Unreachable for the four cadences that exist. A window with no end would
  // break the window_order constraint, so fall back to a day rather than
  // write a row the database will refuse.
  return new Date(startMs + DAY_MS);
}

function plannedFrom(cadence: Cadence, startMs: number): PlannedWindow {
  return {
    windowStart: new Date(startMs),
    windowEnd: nextFireAfter(cadence, startMs),
    localDay: zonedDay(startMs, cadence.timeZone),
  };
}

/**
 * Every window this schedule owes, given where it left off.
 *
 * `lastWindowStart` is the newest window already recorded, whatever its
 * status. A window that exists is never planned again: the database refuses
 * the duplicate anyway, but planning it again would mean every tick tried and
 * lost the same race.
 *
 * The interval is half open on the left, so the window already recorded is not
 * reproduced, and closed on the right, so a tick running at exactly the fire
 * instant sees the window it came for.
 */
export function planWindows(
  schedule: SchedScheduleRow,
  lastWindowStart: string | null,
  now: Date,
): WindowPlan {
  const cadence = cadenceOf(schedule);
  const nowMs = now.getTime();
  const boundMs = nowMs - CATCH_UP_DAYS * DAY_MS;

  // The effective dates are a property of the schedule and not of the bound.
  // A window before a schedule started is not late, it never existed.
  const startedMs = Date.parse(`${schedule.effectiveFrom}T00:00:00Z`) - DAY_MS;
  const endedMs =
    schedule.effectiveTo === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(`${schedule.effectiveTo}T23:59:59Z`) + DAY_MS;

  const resumeMs =
    lastWindowStart === null
      ? Math.max(nowMs - SKIP_RECORD_DAYS * DAY_MS, startedMs)
      : Math.max(Date.parse(lastWindowStart), startedMs);
  const enumerateFromMs = Math.max(resumeMs, nowMs - SKIP_RECORD_DAYS * DAY_MS);

  const fires = cadenceFireInstants(cadence, enumerateFromMs, nowMs).filter(
    (t) => t <= endedMs,
  );

  const skipped: WindowPlan["skipped"] = [];
  const inBound: number[] = [];
  for (const t of fires) {
    if (t < boundMs) {
      skipped.push({ ...plannedFrom(cadence, t), reason: "outside_catch_up_bound" });
    } else {
      inBound.push(t);
    }
  }

  // When more windows are inside the bound than one sweep will run, the newest
  // are the ones that get run. A stale nightly refresh is worth less than
  // tonight's, and running the oldest first would mean a long gap never caught
  // up at all.
  const excess = inBound.length - CATCH_UP_MAX_WINDOWS;
  const due: PlannedWindow[] = [];
  inBound.forEach((t, i) => {
    if (i < excess) {
      skipped.push({ ...plannedFrom(cadence, t), reason: "catch_up_window_limit" });
    } else {
      due.push(plannedFrom(cadence, t));
    }
  });

  skipped.sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime());
  return { due, skipped };
}

/** Human wording for a skip reason, used by the operator surface. */
export function skipReasonText(reason: SkipReason): string {
  return reason === "outside_catch_up_bound"
    ? `older than the ${CATCH_UP_DAYS} day catch up bound, so it was recorded and not run`
    : `beyond the ${CATCH_UP_MAX_WINDOWS} window limit for one sweep, so the newer windows ran first`;
}
