/**
 * Shared reading and arithmetic for module 10, the practice management runs.
 *
 * Spec: docs/02-run-specifications.md Module 9 Practice Management.
 *
 * Three runs live on top of this file. PRAC-GENERATE-TASKS builds the standard
 * workload for a client and a period, PRAC-ESCALATE-OVERDUE walks the ladder on
 * work that has slipped, and PRAC-NUDGE-REQUESTS moves the next check date on
 * open document requests. All three write rows. None of them sends anything.
 *
 * SENDS. There is no outbox in this module, no recipient address on any row, no
 * message body, and no external call anywhere in the three runs or in this
 * file. An escalation is a row that says who should be told and why. A nudge is
 * a row that says the request is due for a check. Somebody reads them. Nothing
 * transmits them.
 *
 * Four things live here rather than in the three run files.
 *
 * 1. One read. loadPracticeData reads the practice state, the catalog, the
 *    tasks, the escalation history, the notices, the nudges, and the close data
 *    once per execution.
 *
 * 2. Business day arithmetic. Doc 02 module 9 says a due date landing on a
 *    weekend shifts forward to Monday and there is no holiday calendar. The
 *    codebase had no business day helper before this module, so one is written
 *    here rather than three times inside the runs. See NOTES.md entry 116 for
 *    why a holiday calendar is out of scope.
 *
 * 3. The escalation ladder, resolved per client. The defaults are 1 day to the
 *    assignee, 3 to the lead, 7 to the partner, and 14 to an at risk flag, and
 *    every one of them is a column on the practice state row so a client with a
 *    different cadence does not need a code change.
 *
 * 4. The nudge schedule. Doc 02 says nudges land at half the escalation window
 *    rounded down, at the window, and at the window plus seven, and then the
 *    schedule is exhausted and a call task goes to the engagement lead.
 *
 * CONSTRAINT. No model, no score, no learned parameter, no string distance. Due
 * dates are integer day arithmetic, assignments are stored member ids, and the
 * ladder is a comparison of two integers.
 */

import type { Ulid } from "../contract";
import type { RunTx } from "../db";
import { addDays, dayGap, dayToUtcMs } from "../dates";
import type {
  DocumentRequestRow,
  PracticeEscalationRow,
  PracticeStateRow,
  PracticeTaskCatalogRow,
  PracticeTaskRow,
  RequestNudgeRow,
  WorkloadNoticeRow,
} from "../tables";
import { loadCloseData, type CloseData } from "./close-shared";
import { periodWindow } from "./per-shared";

/**
 * Doc 02 PRAC-ESCALATE-OVERDUE rule 1. The ladder, in days past the due date.
 * These are the defaults a client inherits when nobody has set their own.
 */
export const LADDER_DEFAULTS = {
  assignee: 1,
  lead: 3,
  partner: 7,
  atRisk: 14,
} as const;

/**
 * Doc 02 PRAC-NUDGE-REQUESTS rule 2. Nudges land at half the escalation window
 * rounded down, at the window, and at the window plus this many days. After the
 * third the schedule is exhausted.
 */
export const NUDGE_TAIL_DAYS = 7;

/** Doc 02 PRAC-NUDGE-REQUESTS rule 4. A client reply inside this many days quiets a nudge. */
export const RECENT_REPLY_DAYS = 2;

/** Saturday and Sunday, in the day of week numbering the platform uses. */
const SATURDAY = 6;
const SUNDAY = 0;

/**
 * The day of the week of an ISO day, computed from the epoch rather than from a
 * local Date, so a run executed in Denver and one executed in a UTC container
 * agree on whether a due date is a Saturday.
 */
export function dayOfWeek(day: string): number {
  return new Date(dayToUtcMs(day)).getUTCDay();
}

export function isWeekend(day: string): boolean {
  const dow = dayOfWeek(day);
  return dow === SATURDAY || dow === SUNDAY;
}

/**
 * Shift a day forward to the next business day.
 *
 * Doc 02 module 9 rule 3. Saturday and Sunday shift to Monday. There is no
 * holiday calendar, and pretending there is one would be worse than not having
 * one, because a wrong holiday list moves real deadlines.
 */
export function shiftToBusinessDay(day: string): string {
  let result = day;
  while (isWeekend(result)) {
    result = addDays(result, 1);
  }
  return result;
}

/** Count business days forward from a day, skipping weekends. D9 production window. */
export function addBusinessDays(day: string, count: number): string {
  let result = day;
  let remaining = count;
  while (remaining > 0) {
    result = addDays(result, 1);
    if (!isWeekend(result)) remaining -= 1;
  }
  return result;
}

/** Everything module 10 reads, read once. */
export interface PracticeData {
  close: CloseData;
  firmId: Ulid;
  clientId: Ulid;
  periodStart: string;
  periodEnd: string;
  nextPeriodStart: string;
  state: PracticeStateRow | null;
  catalog: readonly PracticeTaskCatalogRow[];
  tasks: readonly PracticeTaskRow[];
  escalations: readonly PracticeEscalationRow[];
  notices: readonly WorkloadNoticeRow[];
  nudges: readonly RequestNudgeRow[];
  requests: readonly DocumentRequestRow[];
}

export async function loadPracticeData(
  tx: RunTx,
  firmId: Ulid,
  clientId: Ulid,
  period: string,
): Promise<PracticeData> {
  const window = periodWindow(period);
  const close = await loadCloseData(tx, firmId, clientId, period);
  const key = { firmId, clientId };
  const states = await tx.query("practice_state_for_client", key);
  const catalog = await tx.query("practice_catalog_for_client", key);
  const tasks = await tx.query("practice_tasks_for_client", key);
  const escalations = await tx.query("practice_escalations_for_client", key);
  const notices = await tx.query("workload_notices_for_client", key);
  const nudges = await tx.query("request_nudges_for_client", key);
  return {
    close,
    firmId,
    clientId,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    nextPeriodStart: window.nextPeriodStart,
    state: states.length === 0 ? null : states[0],
    catalog,
    tasks,
    escalations,
    notices,
    nudges,
    requests: close.requests,
  };
}

/** The four rungs of one client's ladder, defaults filled in. */
export interface Ladder {
  assignee: number;
  lead: number;
  partner: number;
  atRisk: number;
}

export function ladderFor(state: PracticeStateRow | null): Ladder {
  if (state === null) return { ...LADDER_DEFAULTS };
  return {
    assignee: state.escalationAssigneeDays,
    lead: state.escalationLeadDays,
    partner: state.escalationPartnerDays,
    atRisk: state.escalationAtRiskDays,
  };
}

/**
 * The highest rung the age has reached.
 *
 * Doc 02 rule 2. Each rung fires exactly once per task per due date, so the
 * comparison is against the rung already recorded on the task rather than
 * against the whole history. Ten daily runs on one task that stays overdue fire
 * four notifications and no more.
 */
export function rungFor(
  daysOverdue: number,
  ladder: Ladder,
): "none" | "assignee" | "lead" | "partner" | "at_risk" {
  if (daysOverdue >= ladder.atRisk) return "at_risk";
  if (daysOverdue >= ladder.partner) return "partner";
  if (daysOverdue >= ladder.lead) return "lead";
  if (daysOverdue >= ladder.assignee) return "assignee";
  return "none";
}

export const RUNG_ORDER: readonly ("none" | "assignee" | "lead" | "partner" | "at_risk")[] = [
  "none",
  "assignee",
  "lead",
  "partner",
  "at_risk",
];

export function rungIndex(rung: string): number {
  const index = RUNG_ORDER.indexOf(rung as (typeof RUNG_ORDER)[number]);
  return index < 0 ? 0 : index;
}

/**
 * The rungs between the one already fired and the one the age has reached.
 *
 * A task that sat unseen for two weeks and then got its first run fires every
 * rung it passed, in order, rather than jumping straight to at risk. The people
 * on the lower rungs still need the record that their turn came and went.
 */
export function rungsToFire(
  priorRung: string,
  reached: string,
): ("assignee" | "lead" | "partner" | "at_risk")[] {
  const from = rungIndex(priorRung);
  const to = rungIndex(reached);
  const out: ("assignee" | "lead" | "partner" | "at_risk")[] = [];
  for (let i = from + 1; i <= to; i += 1) {
    const rung = RUNG_ORDER[i];
    if (rung === "none") continue;
    out.push(rung);
  }
  return out;
}

/** Who a rung reaches, given the client's roster. */
export function recipientFor(
  rung: "assignee" | "lead" | "partner" | "at_risk",
  task: PracticeTaskRow,
  state: PracticeStateRow | null,
): { recipientId: Ulid | null; role: PracticeEscalationRow["recipientRole"] } {
  switch (rung) {
    case "assignee":
      return { recipientId: task.assigneeId, role: "assignee" };
    case "lead":
      return { recipientId: state === null ? null : state.leadId, role: "lead" };
    case "partner":
      return { recipientId: state === null ? null : state.partnerId, role: "partner" };
    case "at_risk":
      return { recipientId: null, role: "firm" };
  }
}

/**
 * The nudge schedule for one escalation window.
 *
 * Doc 02 rule 2 with an escalation window of ten days puts nudges on day five,
 * day ten, and day seventeen, and then stops. Integer division, floor, no
 * rounding surprises.
 */
export function nudgeDaysFor(escalationDays: number): number[] {
  const half = Math.floor(escalationDays / 2);
  return [half, escalationDays, escalationDays + NUDGE_TAIL_DAYS];
}

/** Which nudge number an age has reached, zero when none has come due yet. */
export function nudgeNumberFor(ageDays: number, escalationDays: number): number {
  const days = nudgeDaysFor(escalationDays);
  let number = 0;
  for (const day of days) {
    if (ageDays >= day) number += 1;
  }
  return number;
}

/** The day the next check falls, or null when the schedule is exhausted. */
export function nextCheckFor(
  openedOn: string,
  ageDays: number,
  escalationDays: number,
): string | null {
  for (const day of nudgeDaysFor(escalationDays)) {
    if (ageDays < day) return shiftToBusinessDay(addDays(openedOn, day));
  }
  return null;
}

/** Doc 02 rule 4. A client reply inside two days quiets the next nudge. */
export function repliedRecently(request: DocumentRequestRow, asOf: string): boolean {
  if (request.lastRefreshedOn === null) return false;
  if (request.ownerChangedOn === null) return false;
  return dayGap(request.ownerChangedOn, asOf) <= RECENT_REPLY_DAYS;
}

/** Doc 02 module 9. A client the firm is actually serving this period. */
export function isLiveClient(state: PracticeStateRow | null): boolean {
  if (state === null) return false;
  return state.stage === "active" || state.stage === "onboarding";
}

/**
 * Whether a catalog row's frequency lands in a period.
 *
 * Monthly lands every period. Quarterly lands in March, June, September, and
 * December. Annual lands in December. Any fiscal year other than the calendar
 * year is out of scope for this module, and doc 02 says so.
 */
export function frequencyLandsIn(
  frequency: PracticeTaskCatalogRow["frequency"],
  periodStart: string,
): boolean {
  const month = Number(periodStart.slice(5, 7));
  if (frequency === "monthly") return true;
  if (frequency === "quarterly") return month % 3 === 0;
  return month === 12;
}

/** Sort helper. Catalog code ascending, which is doc 02 rule 8's inner key. */
export function byCatalogCode(
  a: PracticeTaskCatalogRow,
  b: PracticeTaskCatalogRow,
): number {
  if (a.catalogCode !== b.catalogCode) {
    return a.catalogCode < b.catalogCode ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
