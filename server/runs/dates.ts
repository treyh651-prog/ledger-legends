/**
 * Day arithmetic on ISO YYYY-MM-DD strings. UTC only, no locale, no library.
 * Every run receives its clock through ctx.now, so nothing here reads the clock.
 */

import type { PeriodLockRow } from "./tables";

const DAY_MS = 86400000;

export function isIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function dayToUtcMs(day: string): number {
  const [y, m, d] = day.split("-").map((p) => Number(p));
  return Date.UTC(y, m - 1, d);
}

export function utcMsToDay(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(day: string, count: number): string {
  return utcMsToDay(dayToUtcMs(day) + count * DAY_MS);
}

/** Absolute calendar day gap. */
export function dayGap(a: string, b: string): number {
  return Math.abs(dayToUtcMs(a) - dayToUtcMs(b)) / DAY_MS;
}

export function isoDayOf(value: Date): string {
  return utcMsToDay(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

/** Only locks with a null unlockedAt are in force. */
export function activeLocks(locks: readonly PeriodLockRow[]): PeriodLockRow[] {
  return locks.filter((l) => l.unlockedAt === null);
}

export function lockCovering(
  locks: readonly PeriodLockRow[],
  day: string,
): PeriodLockRow | null {
  for (const lock of activeLocks(locks)) {
    if (day >= lock.periodStart && day <= lock.periodEnd) return lock;
  }
  return null;
}

export function isLockedDay(
  locks: readonly PeriodLockRow[],
  day: string,
): boolean {
  return lockCovering(locks, day) !== null;
}

/**
 * First day of the earliest open period at or after a locked day, per the
 * reversal dating table in doc 03 Part 7. Returns null when every later day is
 * locked as well, which is one of the three cases where undo is refused.
 */
export function firstDayOfEarliestOpenPeriod(
  locks: readonly PeriodLockRow[],
  fromDay: string,
  horizonDays = 366,
): string | null {
  // The horizon is what makes the refusal real. Without it a lock running to the
  // end of the century would hand back a reversal dated in the next century,
  // which is not a correction, it is a mess. A reversal that cannot land within a
  // year of the original is a decision for a person, not for a run.
  const limit = addDays(fromDay, horizonDays);
  let candidate = fromDay;
  for (let hops = 0; hops < 512; hops += 1) {
    const lock = lockCovering(locks, candidate);
    if (!lock) return candidate <= limit ? candidate : null;
    candidate = addDays(lock.periodEnd, 1);
    if (candidate > limit) return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Named zone arithmetic, added for the scheduler in migration 0022.
//
// Everything above this line is UTC day arithmetic, which is the right tool
// for a posting date: a journal entry dated 2026-03-08 is dated that day in
// every zone. A schedule is the opposite kind of fact. The firm is in Denver
// and a 6am nightly refresh means 6am in Denver, which is 13:00 UTC for most
// of the year and 12:00 UTC for the rest of it. The interval between two
// consecutive fires is therefore 23 hours once a year and 25 hours once a
// year, and a cron expression written in UTC is wrong for one of those halves
// no matter which hour it names.
//
// So window boundaries are computed here, in the named zone, and stored as
// UTC instants. Trigger.dev's own cron does support a timezone, and the
// declared ticks use it, but their cron is a wake up call and not the record
// of what was due. The record is `sched.windows`, and its window_start comes
// from this code.
//
// No library. `Intl.DateTimeFormat` with a `timeZone` already carries the
// full IANA rule set in Node's ICU data, and a second copy of the daylight
// saving rules is a second thing to keep current.
// ---------------------------------------------------------------------------

/** Wall clock fields of an instant, read in a named zone. */
export interface ZonedFields {
  year: number;
  month: number; // 1 to 12
  day: number;
  hour: number; // 0 to 23
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, made);
  return made;
}

/** Raised when a schedule names a zone this runtime does not know. */
export class UnknownTimeZoneError extends Error {
  readonly code = "UNKNOWN_TIME_ZONE";
  constructor(readonly timeZone: string) {
    super(
      `unknown_time_zone: ${timeZone} is not an IANA zone this runtime knows. Use a name such as America/Denver.`,
    );
  }
}

export function assertTimeZone(timeZone: string): void {
  try {
    zoneFormatter(timeZone);
  } catch {
    throw new UnknownTimeZoneError(timeZone);
  }
}

export function zonedFields(instantMs: number, timeZone: string): ZonedFields {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(instantMs));
  const pick = (type: string): number => {
    for (const p of parts) if (p.type === type) return Number(p.value);
    return 0;
  };
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

/** Offset of the zone from UTC at an instant, in milliseconds, east positive. */
export function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const f = zonedFields(instantMs, timeZone);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  // Second resolution is enough. No IANA zone has ever had a sub second offset.
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The local calendar day an instant falls on, as YYYY-MM-DD. */
export function zonedDay(instantMs: number, timeZone: string): string {
  const f = zonedFields(instantMs, timeZone);
  return `${String(f.year).padStart(4, "0")}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}`;
}

/**
 * The instant at which a wall clock time occurs in a named zone.
 *
 * Two passes. The first guesses the offset using the naive UTC reading of the
 * wall clock, the second corrects it using the offset in force at the guessed
 * instant. That is what makes the hour either side of a transition come out
 * right, and one pass is not enough because the offset it looks up can be the
 * one on the wrong side of the change.
 *
 * Two edge cases, both stated rather than hidden:
 *
 *   The hour that does not exist. On the second Sunday in March local time
 *   jumps from 01:59 to 03:00, so 02:30 never happens. This returns the
 *   instant the arithmetic implies, which reads as 03:30 local. The schedule
 *   still fires exactly once that day. A firm that wants a schedule inside
 *   that hour has chosen the one hour a year that is not a real time, and the
 *   honest answer is to fire adjacent to it rather than to skip a day.
 *
 *   The hour that happens twice. On the first Sunday in November 01:30 occurs
 *   twice. This returns the first, the one before the clocks go back, because
 *   the earlier of two candidates is the one a person means by "1:30 that
 *   morning" and because picking the later one would put the fire after a
 *   window that a later schedule in the same day already covers.
 */
export function instantOfLocalTime(
  day: string,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  assertTimeZone(timeZone);
  const [y, m, d] = day.split("-").map((p) => Number(p));
  const naive = Date.UTC(y, m - 1, d, hour, minute, 0);
  const firstGuess = naive - zoneOffsetMs(naive, timeZone);
  const corrected = naive - zoneOffsetMs(firstGuess, timeZone);
  // The ambiguous hour. Both candidates read back as the requested wall clock
  // time, so prefer the earlier one.
  if (corrected !== firstGuess) {
    const earlier = Math.min(corrected, firstGuess);
    const later = Math.max(corrected, firstGuess);
    const reads = (t: number): boolean => {
      const f = zonedFields(t, timeZone);
      return (
        f.year === y &&
        f.month === m &&
        f.day === d &&
        f.hour === hour &&
        f.minute === minute
      );
    };
    if (reads(earlier)) return earlier;
    if (reads(later)) return later;
  }
  return corrected;
}

// ---------------------------------------------------------------------------
// Calendar shapes a close calendar is written in.
// ---------------------------------------------------------------------------

export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoOf(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The nth day of a month, clamped to the last day the month has.
 *
 * A schedule set to the 31st is a schedule that means "the end of the month",
 * so in April it fires on the 30th and in February on the 28th or the 29th. A
 * schedule set to the 29th is the same shape of statement about February, so
 * in a non leap year it fires on the 28th. Rolling into the next month would
 * move a close deadline into the period it is closing.
 */
export function dayOfMonthIn(
  year: number,
  month: number,
  dayOfMonth: number,
): string {
  const last = lastDayOfMonth(year, month);
  return isoOf(year, month, Math.min(dayOfMonth, last));
}

/** 0 is Sunday, matching Date.getUTCDay. */
export function weekdayIndexOf(day: string): number {
  return new Date(dayToUtcMs(day)).getUTCDay();
}

export const WEEKDAY_NAMES: readonly string[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function weekdayNameOf(day: string): string {
  return WEEKDAY_NAMES[weekdayIndexOf(day)];
}

/**
 * The nth business day of a month, counting Monday to Friday only.
 *
 * There is deliberately no holiday calendar. A holiday list is a per firm,
 * per year, per jurisdiction fact that nothing in this database holds, and a
 * guessed list is worse than a stated omission: a close calendar that quietly
 * shifts by a day because somebody's idea of a holiday differs from the
 * firm's is harder to find than one that fires on Independence Day. The
 * omission is written into docs/SCHEDULING.md so the operator can move a
 * schedule by hand in the years it matters.
 *
 * Clamps to the last business day of the month, so asking for the 23rd
 * business day of February is the last one rather than a date in March.
 */
export function nthBusinessDayIn(
  year: number,
  month: number,
  nth: number,
): string {
  const last = lastDayOfMonth(year, month);
  let seen = 0;
  let lastBusiness = isoOf(year, month, 1);
  for (let d = 1; d <= last; d += 1) {
    const iso = isoOf(year, month, d);
    const wd = weekdayIndexOf(iso);
    if (wd === 0 || wd === 6) continue;
    seen += 1;
    lastBusiness = iso;
    if (seen === nth) return iso;
  }
  return lastBusiness;
}

// ---------------------------------------------------------------------------
// Cadences, and the instants they fire at.
// ---------------------------------------------------------------------------

export type CadenceKind =
  | "daily"
  | "weekly"
  | "monthly_day"
  | "monthly_business_day";

export interface Cadence {
  kind: CadenceKind;
  /** Local hour of the fire, 0 to 23, in the cadence's own zone. */
  hour: number;
  minute: number;
  timeZone: string;
  /** Lower case weekday name, for kind weekly. */
  weekday?: string | null;
  /** 1 to 31, for kind monthly_day. Clamped to the month's length. */
  dayOfMonth?: number | null;
  /** 1 to 23, for kind monthly_business_day. Clamped to the month's length. */
  businessDay?: number | null;
}

/** Does this cadence fire on this local calendar day. */
export function cadenceFiresOn(cadence: Cadence, localDay: string): boolean {
  const [y, m] = localDay.split("-").map((p) => Number(p));
  switch (cadence.kind) {
    case "daily":
      return true;
    case "weekly":
      return weekdayNameOf(localDay) === (cadence.weekday ?? "");
    case "monthly_day":
      return localDay === dayOfMonthIn(y, m, cadence.dayOfMonth ?? 1);
    case "monthly_business_day":
      return localDay === nthBusinessDayIn(y, m, cadence.businessDay ?? 1);
    default:
      return false;
  }
}

/**
 * Every instant this cadence fires at in the half open interval (after,
 * through].
 *
 * Half open on the left so that resuming from the last window that completed
 * cannot produce that same window again, and closed on the right so that a
 * sweep running exactly on the minute sees the window it is there to run.
 *
 * The walk is over local calendar days and each day's instant is computed on
 * its own, which is what keeps a daylight saving day from shifting the days
 * around it. A day either side of the range is included in the walk because
 * the zone offset can move a local day's fire across a UTC boundary.
 */
export function cadenceFireInstants(
  cadence: Cadence,
  afterMs: number,
  throughMs: number,
): number[] {
  assertTimeZone(cadence.timeZone);
  if (throughMs <= afterMs) return [];
  const first = addDays(zonedDay(afterMs, cadence.timeZone), -1);
  const last = addDays(zonedDay(throughMs, cadence.timeZone), 1);
  const out: number[] = [];
  let day = first;
  // A guard rather than a while true. Ten years of days is far past any catch
  // up bound and is the point at which a caller has passed a wrong range.
  for (let i = 0; i < 3700 && day <= last; i += 1) {
    if (cadenceFiresOn(cadence, day)) {
      const at = instantOfLocalTime(day, cadence.hour, cadence.minute, cadence.timeZone);
      if (at > afterMs && at <= throughMs) out.push(at);
    }
    day = addDays(day, 1);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** The fire at or before an instant, which is the window a sweep resumes from. */
export function previousFireInstant(
  cadence: Cadence,
  atMs: number,
  lookBackDays = 400,
): number | null {
  const from = atMs - lookBackDays * DAY_MS;
  const all = cadenceFireInstants(cadence, from, atMs);
  return all.length === 0 ? null : all[all.length - 1];
}
