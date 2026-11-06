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
 * window.localDay, to: window.localDay, asOf: window.localDay}` and never
 * supplies a `period` field. Every run whose scope requires `period`
 * (ARAP-REFRESH-AGING, TAX-TRACK-W9, PRAC-GENERATE-TASKS,
 * PRAC-ESCALATE-OVERDUE, CLOSE-CHECK-GATES, RPT-BUILD-PACKAGE,
 * RPT-FLAG-VARIANCES, RPT-REBUILD-FORECAST, RPT-COMPOSE-NARRATIVE,
 * SUB-TIEOUT-ACCOUNTS) is mechanically unreachable from the scheduler right
 * now, even with a perfectly formed schedule row -- scope validation would
 * refuse the window before the run's own logic ever saw it. Guessing at what
 * calendar period a given cron firing date represents, per run type, is a
 * separate, deliberate round of its own: getting it wrong would misdate an
 * automatic close-gate check or report build in a live system, which is a
 * worse failure than the one this run fixes. See the plan file's own
 * "Problem 5" entry for the full list and the reasoning not to guess here.
 *
 * The six run types below are the ones the runner's own scope construction
 * already satisfies verbatim: the five coding-cascade runs share
 * codingScopeSchema ({clientId, from, to, bankAccountIds}, the last field
 * optional and defaulting to null, "every account") and REC-FLAG-STALE uses
 * flagStaleScopeSchema ({clientId, bankAccountIds, asOf, ...}, same optional
 * default). Scheduled daily, five minutes apart in doc 02's own documented
 * cascade order (normalize vendors, detect duplicates, apply rules, apply
 * vendor defaults, map bank codes), with the stale-items check last.
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
        cadence: "daily",
        weekday: null,
        dayOfMonth: null,
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
