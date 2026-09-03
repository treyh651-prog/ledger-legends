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
