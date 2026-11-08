/**
 * SETUP-CREATE-DEFAULT-SCHEDULES. Put the first sched.schedules rows on a
 * client's books.
 *
 * Audit fix, 2026-11-06 (problem 5). sched.schedules has carried a full
 * compliance-tiered shape since migration 0022, and server/sched/runner.ts
 * has always been able to run a schedule that exists -- but nothing, not a
 * run, not a screen, not a migration, ever inserted the first one for a
 * real client. Even once Trigger.dev's own tick is deployed per
 * docs/SCHEDULING.md, every client would sit with zero schedules forever
 * unless someone hand-inserted rows, which is a stronger, code-level version
 * of the same gap this engagement's own memory already flagged.
 *
 * Scoped deliberately narrow: this run only schedules the run types that
 * server/sched/runner.ts's scope construction can actually satisfy today.
 * runWindow() builds `{...schedule.scopeJson, firmId, clientId, from:
 * window.localDay, to: window.localDay, asOf: window.localDay, asOfDate:
 * window.localDay, period: priorPeriodStartOf(window.localDay)}`.
 * CLOSE-CHECK-GATES, RPT-BUILD-PACKAGE, and SUB-TIEOUT-ACCOUNTS are left out
 * on purpose even though their own schemas now accept that scope --
 * scheduling an automatic close-gate check or report build is its own
 * deliberate decision about a client's close cadence, not something this
 * generic setup run should default on for every client.
 *
 * Fourteen run types below, in two groups:
 *
 * The first six are the ones the runner's own scope construction already
 * satisfied before the `period` field existed: the five coding-cascade runs
 * share codingScopeSchema ({clientId, from, to, bankAccountIds}, the last
 * field optional and defaulting to null, "every account") and REC-FLAG-STALE
 * uses flagStaleScopeSchema ({clientId, bankAccountIds, asOf, ...}, same
 * optional default). Scheduled daily, five minutes apart in doc 02's own
 * documented cascade order (normalize vendors, detect duplicates, apply
 * rules, apply vendor defaults, map bank codes), with the stale-items check
 * last.
 *
 * The other eight need `period` and/or `asOfDate`, both of which the
 * scheduler can now supply (the period-gap fix, and the asOfDate fix this
 * same round made to runWindow() -- PRAC-NUDGE-REQUESTS/PRAC-ESCALATE-OVERDUE
 * name that field asOfDate, a different key than the asOf the runner
 * already had, so without that fix both would have silently frozen on the
 * prior month's last day forever instead of advancing daily). User's own
 * choice, asked directly rather than guessed: auto-schedule the
 * non-destructive ones (nothing that posts to the ledger or touches a close
 * gate), confirmed against each run's own write semantics before choosing a
 * cadence, not assumed from the run type name alone:
 *   - ARAP-REFRESH-AGING, TAX-TRACK-W9, PRAC-GENERATE-TASKS,
 *     PRAC-NUDGE-REQUESTS, PRAC-ESCALATE-OVERDUE: all write-idempotent and
 *     explicitly want to run daily in their own header comments (aging stays
 *     fresh, the task/nudge/escalation ladders advance one rung per real
 *     day) -- scheduled daily, in the same early morning slot as the coding
 *     cascade, a few minutes after it.
 *   - RPT-FLAG-VARIANCES, RPT-REBUILD-FORECAST, RPT-COMPOSE-NARRATIVE: all
 *     architecturally monthly concerns (a variance is against a monthly
 *     budget, a narrative is a period-close document) -- scheduled
 *     monthly_day on the 1st, a separate slot from the daily batch, since
 *     `priorPeriodStartOf` resolves "the month that just ended" correctly
 *     from day one of the new month onward.
 *
 * Idempotent per run type: each schedule's id is derived from the client and
 * the run type it schedules, so re-running this for an already-scheduled
 * client reports every one as already_applied rather than doubling the
 * client's automation. Manual tier: deciding a client's books should start
 * running themselves is a one time setup choice a person makes, the same
 * reasoning every other SETUP-* run in this file gives -- a clock has no
 * schedule of its own to invent.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";

export const createDefaultSchedulesScopeSchema = z.object({
  clientId: z.string().min(1),
});

export type CreateDefaultSchedulesScope = z.infer<typeof createDefaultSchedulesScopeSchema>;

interface DefaultScheduleSpec {
  runType: string;
  name: string;
  localHour: number;
  localMinute: number;
  /** Daily unless given, which is every run type in the first group below. */
  cadence?: "daily" | "monthly_day";
  /** Required, and only meaningful, for cadence "monthly_day". */
  dayOfMonth?: number;
}

/**
 * Doc 02's own documented cascade order (levels 0, 1, 5, 6, 7), five minutes
 * apart so one window's apply is well clear of the next before it fires.
 * REC-FLAG-STALE is module 3, not the coding cascade, and runs last in the
 * same early-morning slot since it only measures what is already posted.
 */
const DEFAULT_SCHEDULES: readonly DefaultScheduleSpec[] = [
  { runType: "TXN-NORMALIZE-VENDORS", name: "Normalize vendor descriptors", localHour: 5, localMinute: 0 },
  { runType: "TXN-DETECT-DUPLICATES", name: "Flag possible duplicates", localHour: 5, localMinute: 5 },
  { runType: "TXN-APPLY-RULES", name: "Apply categorization rules", localHour: 5, localMinute: 10 },
  { runType: "TXN-APPLY-VENDORDEFAULTS", name: "Apply vendor default categories", localHour: 5, localMinute: 15 },
  { runType: "TXN-MAP-BANKCODES", name: "Apply bank and card code mappings", localHour: 5, localMinute: 20 },
  { runType: "REC-FLAG-STALE", name: "Flag stale reconciling items", localHour: 5, localMinute: 30 },
  // Daily, non-destructive, write-idempotent -- confirmed against each run's
  // own header comment and write semantics before scheduling, not assumed.
  // A separate slot after the coding cascade/stale check above, so the
  // day's posting activity is in before aging/tasks/nudges/escalation read it.
  { runType: "ARAP-REFRESH-AGING", name: "Refresh AR/AP aging", localHour: 5, localMinute: 40 },
  { runType: "TAX-TRACK-W9", name: "Refresh W-9 tracking", localHour: 5, localMinute: 45 },
  { runType: "PRAC-GENERATE-TASKS", name: "Generate the day's practice tasks", localHour: 5, localMinute: 50 },
  { runType: "PRAC-NUDGE-REQUESTS", name: "Nudge overdue client requests", localHour: 5, localMinute: 55 },
  { runType: "PRAC-ESCALATE-OVERDUE", name: "Escalate overdue practice tasks", localHour: 6, localMinute: 0 },
  // Monthly, on the 1st -- architecturally period-close concerns
  // (a variance is against a monthly budget, a narrative is a period-close
  // document). priorPeriodStartOf correctly names the month that just
  // ended from the 1st of the new month onward. A separate morning slot
  // from the daily batch above, in doc 02's own report-cascade order
  // (variances, then the forecast, then the narrative).
  { runType: "RPT-FLAG-VARIANCES", name: "Flag budget variances for last month", localHour: 6, localMinute: 30, cadence: "monthly_day", dayOfMonth: 1 },
  { runType: "RPT-REBUILD-FORECAST", name: "Rebuild the cash forecast", localHour: 6, localMinute: 35, cadence: "monthly_day", dayOfMonth: 1 },
  { runType: "RPT-COMPOSE-NARRATIVE", name: "Compose last month's narrative", localHour: 6, localMinute: 40, cadence: "monthly_day", dayOfMonth: 1 },
];

export function defaultScheduleIdFor(clientId: Ulid, runType: string): Ulid {
  return derivedId(`${clientId}:${runType}`, "setup-create-default-schedules", 0);
}

export const setupCreateDefaultSchedules: Run<CreateDefaultSchedulesScope, Proposal> = {
  type: "SETUP-CREATE-DEFAULT-SCHEDULES",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:setup-create-default-schedules`,
  scopeSchema: createDefaultSchedulesScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateDefaultSchedulesScope>> {
    const tx = requireTx(ctx);
    const existing = await tx.query("sched_schedules_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const candidateIds = DEFAULT_SCHEDULES.map((d) => defaultScheduleIdFor(scope.clientId, d.runType));
    const versions = [
      { id: "SETUP-CREATE-DEFAULT-SCHEDULES", version: 1 },
      ...existing.map((s) => ({ id: s.id, version: s.version })),
    ];
    const runDay = ctx.now.toISOString().slice(0, 10);
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: runDay,
      periodEnd: runDay,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const skips: Skip[] = [];
    const proposals: Proposal[] = [];

    const existing = await tx.query("sched_schedules_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const existingIds = new Set(existing.map((s) => s.id));
    const runDay = ctx.now.toISOString().slice(0, 10);

    for (const spec of DEFAULT_SCHEDULES) {
      const scheduleId = defaultScheduleIdFor(frozen.clientId, spec.runType);
      if (existingIds.has(scheduleId)) {
        skips.push({
          rowId: scheduleId,
          reason: "already_applied",
          detail: `${frozen.clientId} already has a default schedule for ${spec.runType}`,
        });
        continue;
      }

      const row: Record<string, unknown> = {
        firmId: frozen.firmId,
        clientId: scope.clientId,
        name: spec.name,
        runType: spec.runType,
        tier: "unattended",
        executionMode: "apply",
        cadence: spec.cadence ?? "daily",
        weekday: null,
        dayOfMonth: spec.cadence === "monthly_day" ? (spec.dayOfMonth ?? 1) : null,
        businessDay: null,
        localHour: spec.localHour,
        localMinute: spec.localMinute,
        timezone: "America/Denver",
        enabled: true,
        effectiveFrom: runDay,
        effectiveTo: null,
        scopeJson: {},
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastFailureDetail: null,
        version: 1,
        manualOverride: false,
      };

      const proposal: ProposedRowInsert = {
        kind: "row_insert",
        table: "sched_schedules",
        rowId: scheduleId,
        row,
        provenance: { cascadeLevel: null },
      };
      proposals.push(proposal);
    }

    return makeResult<Proposal>(1, proposals, skips, [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "SETUP-CREATE-DEFAULT-SCHEDULES",
      runVersion: 1,
    });
  },

  /**
   * No undo. A schedule row that has not fired yet is harmless to leave, and
   * one that already has -- by definition, if an undo is being considered at
   * all -- should not be silently deleted out from under windows it already
   * owns. Disabling a schedule is a separate, later decision this run
   * version does not implement, same reasoning SETUP-ADD-BANK-ACCOUNT gives
   * for its own bank account insert.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
