/**
 * Shared arithmetic for the six period end runs.
 *
 * Doc 03 Part 4 says a run's numbers have to be reproducible from the rows it
 * read, and every module 4 run needs the same three things to do that: month
 * boundaries, a way to spread a total over periods without losing a cent, and a
 * way to weight the first and last month of a service window by days.
 *
 * Two rules hold everywhere in this file.
 *
 * Money is bigint cents. There is no floating point anywhere in this module,
 * because a prepaid split twelve ways in floating point produces a residual
 * nobody can explain and doc 00 Part 1 forbids it outright.
 *
 * The residual always lands in the last period. Spreading 100000 over twelve
 * months gives eleven months of 8333 and a final month of 8337. Putting the
 * remainder anywhere else, or distributing it a cent at a time across early
 * periods, both produce a schedule that foots. The last period is chosen
 * because it is the only choice that keeps every earlier period equal to every
 * other, which is what a person reading a prepaid schedule expects to see.
 *
 * Dates are ISO days in UTC. The date helpers in dates.ts stop at day
 * arithmetic, so month arithmetic lives here.
 */

import type { Cents } from "../contract";

/** Days in a month, Gregorian, with the leap year rule in full. */
export function daysInMonth(year: number, month1: number): number {
  if (month1 === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month1 - 1];
}

function partsOf(day: string): { y: number; m: number; d: number } {
  return {
    y: Number(day.slice(0, 4)),
    m: Number(day.slice(5, 7)),
    d: Number(day.slice(8, 10)),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n);
}

function makeDay(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

/** "2026-03-17" becomes "2026-03". The key every period end run groups on. */
export function monthKey(day: string): string {
  return day.slice(0, 7);
}

export function startOfMonth(day: string): string {
  return `${monthKey(day)}-01`;
}

export function endOfMonth(day: string): string {
  const { y, m } = partsOf(day);
  return makeDay(y, m, daysInMonth(y, m));
}

/**
 * Add whole months, clamping the day to the length of the target month. The
 * 31st of January plus one month is the 28th or 29th of February, which is the
 * behavior a monthly schedule needs: a payment due on the 31st does not skip
 * February.
 */
export function addMonths(day: string, count: number): string {
  const { y, m, d } = partsOf(day);
  const zero = y * 12 + (m - 1) + count;
  const ny = Math.floor(zero / 12);
  const nm = (zero % 12) + 1;
  return makeDay(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** Whole months from the first day to the second. Negative when it goes back. */
export function monthsBetween(from: string, to: string): number {
  const a = partsOf(from);
  const b = partsOf(to);
  return (b.y - a.y) * 12 + (b.m - a.m);
}

/** The number of calendar months a service window touches, both ends counted. */
export function monthsSpanned(start: string, end: string): number {
  return monthsBetween(start, end) + 1;
}

/**
 * Spread a total over n periods. Every period equal, the remainder in the last.
 *
 * Negative totals are handled by spreading the absolute value and putting the
 * sign back, so that a credit spreads the same way a debit does rather than
 * producing a residual of the opposite sign in the final period.
 */
export function evenSplit(total: Cents, periods: number): Cents[] {
  if (periods <= 0) return [];
  const negative = total < BigInt(0);
  const magnitude = negative ? -total : total;
  const n = BigInt(periods);
  const base = magnitude / n;
  const out: Cents[] = [];
  for (let i = 0; i < periods - 1; i += 1) out.push(base);
  out.push(magnitude - base * BigInt(periods - 1));
  return negative ? out.map((v) => -v) : out;
}

/** One month of a service window, and how many of its days the window covers. */
export interface MonthSlice {
  periodNumber: number;
  periodStart: string;
  periodEnd: string;
  /** Days of this month inside the service window. */
  coveredDays: number;
  /** Days in the month itself. */
  monthDays: number;
}

/**
 * Cut a service window into calendar months, counting the days each month
 * contributes. A prepaid running from the 15th of March to the 14th of March
 * the following year touches thirteen months, seventeen days of the first and
 * fourteen of the last.
 *
 * Both ends are inclusive, because a policy that runs through the 14th covers
 * the 14th.
 */
export function sliceMonths(start: string, end: string): MonthSlice[] {
  const out: MonthSlice[] = [];
  const count = monthsSpanned(start, end);
  for (let i = 0; i < count; i += 1) {
    const cursor = addMonths(startOfMonth(start), i);
    const ms = startOfMonth(cursor);
    const me = endOfMonth(cursor);
    const from = ms < start ? start : ms;
    const to = me > end ? end : me;
    const { y, m } = partsOf(cursor);
    out.push({
      periodNumber: i + 1,
      periodStart: ms,
      periodEnd: me,
      coveredDays: Number(to.slice(8, 10)) - Number(from.slice(8, 10)) + 1,
      monthDays: daysInMonth(y, m),
    });
  }
  return out;
}

/**
 * Weight a total across month slices by covered days, remainder in the last.
 *
 * This is the partial month rule for prepaids. A twelve month policy bought
 * mid month is not twelve equal months, it is a stub, eleven whole months, and
 * a stub, and the two stubs together have to add to one month or the schedule
 * does not foot at the end.
 */
export function weightByDays(total: Cents, slices: readonly MonthSlice[]): Cents[] {
  const totalDays = slices.reduce((acc, s) => acc + s.coveredDays, 0);
  if (totalDays === 0 || slices.length === 0) return slices.map(() => BigInt(0));
  const negative = total < BigInt(0);
  const magnitude = negative ? -total : total;
  const out: Cents[] = [];
  let assigned = BigInt(0);
  for (let i = 0; i < slices.length - 1; i += 1) {
    const share = (magnitude * BigInt(slices[i].coveredDays)) / BigInt(totalDays);
    out.push(share);
    assigned += share;
  }
  out.push(magnitude - assigned);
  return negative ? out.map((v) => -v) : out;
}

/** Half of an amount, rounded down, for the half month convention. */
export function halve(amount: Cents): Cents {
  const negative = amount < BigInt(0);
  const magnitude = negative ? -amount : amount;
  const half = magnitude / BigInt(2);
  return negative ? -half : half;
}

/** Absolute value, since bigint has no built in one. */
export function abs(value: Cents): Cents {
  return value < BigInt(0) ? -value : value;
}

/**
 * The window a period end run works on. Every module 4 scope names a period by
 * its first day, and this turns that into the pair of days every query wants.
 */
export interface PeriodWindow {
  periodStart: string;
  periodEnd: string;
  /** The first day of the following period, where reversals land. */
  nextPeriodStart: string;
}

export function periodWindow(anyDayInPeriod: string): PeriodWindow {
  const periodStart = startOfMonth(anyDayInPeriod);
  return {
    periodStart,
    periodEnd: endOfMonth(anyDayInPeriod),
    nextPeriodStart: addMonths(periodStart, 1),
  };
}

/**
 * Doc 02 module 4 posting date rule. A template posts on the last day of the
 * period, or on a stated day of the month clamped to the month length so that
 * a rule saying the 31st still posts in February.
 */
export function postingDayFor(
  window: PeriodWindow,
  rule: "period_end" | "day_n",
  dayOfMonth: number | null,
): string {
  if (rule === "period_end" || dayOfMonth === null) return window.periodEnd;
  const { y, m } = partsOf(window.periodStart);
  return makeDay(y, m, Math.min(Math.max(dayOfMonth, 1), daysInMonth(y, m)));
}

/**
 * Whether a cadence falls due in a period, counted from the schedule's start
 * month. Monthly is every month, quarterly every third, and so on. Weekly and
 * semi monthly are not period end shapes at all: they post more than once in a
 * period, and a run that fires once per period cannot represent them, so the
 * caller reports them rather than guessing.
 */
export function cadenceDueIn(
  cadence: string,
  startDay: string,
  periodStart: string,
): boolean {
  const elapsed = monthsBetween(startOfMonth(startDay), periodStart);
  if (elapsed < 0) return false;
  switch (cadence) {
    case "monthly":
      return true;
    case "quarterly":
      return elapsed % 3 === 0;
    case "semi_annual":
      return elapsed % 6 === 0;
    case "annual":
      return elapsed % 12 === 0;
    default:
      return false;
  }
}

/** Cadences this module can post. Anything else is reported, never guessed. */
export const SUPPORTED_CADENCES: readonly string[] = [
  "monthly",
  "quarterly",
  "semi_annual",
  "annual",
];
