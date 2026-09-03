/**
 * PRAC-NUDGE-REQUESTS. Move the next check date on every open document request
 * that has passed its escalation window, and write down why.
 *
 * Spec: docs/02-run-specifications.md Module 9 PRAC-NUDGE-REQUESTS.
 *
 * SENDS. None, and this is the run where that sentence carries the most weight,
 * because the word nudge sounds like a message. It is not one. This run writes
 * a row saying a request is due for a check and computes the day of the next
 * one. There is no recipient address on the row, no message body, no template
 * render, no mail client, no portal push, and no external call in this file. A
 * person reads the rows and decides what to say. Doc 05 D3 keeps the firm out
 * of the client's inbox, and this is how.
 *
 * The schedule. Doc 02 rule 2 puts nudges at half the escalation window rounded
 * down, at the window, and at the window plus seven, and then the schedule is
 * exhausted. With the standard ten day window that is day five, day ten, and
 * day seventeen. After the third the run writes a call task for the engagement
 * lead instead, because a request nobody has answered in seventeen days is not
 * going to be answered by a fourth written reminder.
 *
 * The quiet rules, all of them reasons not to bother somebody. A satisfied or
 * waived request is done. A request the client replied to inside the last two
 * days is already moving. A firm owned request is the firm's own homework and
 * asking the client about it is noise. A system owned request clears itself. A
 * client with nudges paused has asked the firm to stop, and the firm stops.
 *
 * Batching. Doc 02 rule 3 allows at most one message per client per day, which
 * this run honors by writing at most one nudge row per request per day and
 * ordering them age descending so whoever reads them sees the oldest first.
 *
 * Idempotency. The nudge row id is derived from the request and the nudge
 * number, so a second execution on the same day finds the row and reports
 * already applied rather than writing a second one.
 *
 * Locked periods. A request is about paperwork rather than about the ledger, so
 * a locked period changes nothing here. What stops the run is a paused
 * engagement.
 *
 * CONSTRAINT. No model, no score, no string distance. A nudge day is integer
 * day arithmetic against a stored window.
 */

import { z } from "zod";
import {
  isFieldWrite,
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import {
  applyProposals,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  requireTx,
} from "../apply-writer";
import { dayGap } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { DocumentRequestRow, RequestNudgeRow } from "../tables";
import { ZERO } from "./close-shared";
import { ESCALATION_DAYS } from "./sub-raise-requests";
import {
  nudgeDaysFor,
  nudgeNumberFor,
  nextCheckFor,
  repliedRecently,
  shiftToBusinessDay,
  loadPracticeData,
  type PracticeData,
} from "./prc-shared";
import { periodWindow } from "./per-shared";

export const nudgeRequestsScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  /** The day the schedule is measured against. Defaults to the period end. */
  asOfDate: z.string().min(10).optional(),
});

export type NudgeRequestsScope = z.infer<typeof nudgeRequestsScopeSchema>;

export const prcNudgeRequests: Run<NudgeRequestsScope, Proposal> = {
  type: "PRAC-NUDGE-REQUESTS",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:nudge:${scope.period.slice(0, 7)}`,
  scopeSchema: nudgeRequestsScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<NudgeRequestsScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadPracticeData(tx, ctx.firmId, scope.clientId, scope.period);
    const asOf = scope.asOfDate ?? window.periodEnd;
    const due = nudgeableRequests(data, asOf);
    const candidateIds = due.map((r) => r.id);
    const versions = [
      { id: "PRAC-NUDGE-REQUESTS", version: 1 },
      ...due.map((r) => ({ id: r.id, version: r.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // Period plus the as of day. The same request checked on two days is two
      // scopes, which is what lets the run be scheduled daily.
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds: [...candidateIds, `AS-OF:${asOf}`],
        versions,
      }),
      versions,
      overriddenIds: data.requests.filter((r) => r.manualOverride).map((r) => r.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const data = await loadPracticeData(tx, frozen.firmId, frozen.clientId, frozen.input.period);
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const asOf = frozen.input.asOfDate ?? window.periodEnd;
    const state = data.state;

    if (state !== null && state.nudgesPaused) {
      skips.push({
        rowId: frozen.clientId,
        reason: "out_of_scope_engagement",
        detail: "nudges_paused for this client, so nothing was checked",
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }
    if (state !== null && state.engagementPaused) {
      skips.push({
        rowId: frozen.clientId,
        reason: "out_of_scope_engagement",
        detail: "engagement_paused, so nothing was checked",
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const nudgeById = new Map<string, RequestNudgeRow>(data.nudges.map((n) => [n.id, n]));

    for (const request of nudgeableRequests(data, asOf)) {
      if (request.manualOverride) {
        skips.push({
          rowId: request.id,
          reason: "manual_override",
          detail: `request ${request.subjectKey} carries manual_override`,
        });
        continue;
      }
      if (request.status !== "open") {
        skips.push({
          rowId: request.id,
          reason: "already_applied",
          detail:
            request.status === "waived"
              ? `explicitly_waived for ${request.subjectKey}`
              : `request_satisfied for ${request.subjectKey}`,
        });
        continue;
      }
      /*
       * Doc 02 rule 5. A firm owned request is the firm's own homework. Asking
       * the client to chase it teaches them to ignore the ones that are real.
       */
      if (request.owner === "firm") {
        skips.push({
          rowId: request.id,
          reason: "out_of_scope_engagement",
          detail: `firm_owned_not_client_facing for ${request.subjectKey}`,
        });
        continue;
      }
      if (request.owner === "system") {
        skips.push({
          rowId: request.id,
          reason: "out_of_scope_engagement",
          detail: `system_owned_self_clearing for ${request.subjectKey}`,
        });
        continue;
      }
      if (repliedRecently(request, asOf)) {
        skips.push({
          rowId: request.id,
          reason: "already_applied",
          detail: `recent_client_reply on ${request.subjectKey}, so no check was scheduled`,
        });
        continue;
      }

      const window2 = escalationWindowFor(request);
      const age = Math.max(0, dayGap(request.openedOn, asOf));
      const number = nudgeNumberFor(age, window2);

      if (number === 0) {
        skips.push({
          rowId: request.id,
          reason: "already_applied",
          detail: `first check on ${request.subjectKey} is not due until day ${nudgeDaysFor(window2)[0]}`,
        });
        continue;
      }

      const next = nextCheckFor(request.openedOn, age, window2);
      const exhausted = next === null;
      const rowId = nudgeIdOf(frozen.clientId, request.id, number);
      const prior = nudgeById.get(rowId);
      if (prior !== undefined) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `nudge ${number} for ${request.subjectKey} is already recorded`,
        });
        continue;
      }

      /*
       * Doc 02 rule 2. After the third check the written schedule is exhausted
       * and a call task goes to the engagement lead. The call task is a row on
       * the same table with a different action, so the history of one request
       * stays in one place.
       */
      const action: RequestNudgeRow["action"] = exhausted ? "call_task" : "nudge_due";
      // A check that lands on a weekend moves to the next permitted day, which
      // is the quiet hours rule doc 02 rule 6 states in calendar terms.
      const nextCheckOn = next ?? shiftToBusinessDay(asOf);

      proposals.push(
        insertNudge(frozen, rowId, {
          requestId: request.id,
          asOfDate: asOf,
          nudgeNumber: number,
          escalationAgeDays: window2,
          ageDays: age,
          nextCheckOn,
          action,
          detail: exhausted
            ? `${request.subjectKey} has been open ${age} days and the written schedule ` +
              `is exhausted. A call task goes to the engagement lead.`
            : `${request.subjectKey} has been open ${age} days. Check ${number} of ` +
              `${nudgeDaysFor(window2).length} is due. The next check falls on ${nextCheckOn}.`,
        }),
      );

      // The audit row on the request itself, so the request carries its own
      // refresh count rather than requiring a join to know it was looked at.
      proposals.push({
        kind: "field_write",
        table: "document_requests",
        rowId: request.id,
        before: {
          lastRefreshedOn: request.lastRefreshedOn,
          refreshCount: request.refreshCount,
          asOfDate: request.asOfDate,
          agingDays: request.agingDays,
        },
        after: {
          lastRefreshedOn: asOf,
          refreshCount: request.refreshCount + 1,
          asOfDate: asOf,
          agingDays: age,
        },
        provenance: { cascadeLevel: null },
      });
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "PRAC-NUDGE-REQUESTS",
      runVersion: 1,
    });
  },

  /** The refresh reverts. The nudge record stands, because it is history. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function nudgeIdOf(clientId: Ulid, requestId: Ulid, number: number): Ulid {
  return derivedId(`${clientId}:${requestId}`, "prc-nudge", number);
}

/**
 * The escalation window of one request.
 *
 * The request machinery in module 6 states a three step ladder in days. The
 * first step is the window this run schedules against, so the two modules agree
 * on what late means rather than each having their own idea of it.
 */
export function escalationWindowFor(request: DocumentRequestRow): number {
  switch (request.escalation) {
    case "second":
      return ESCALATION_DAYS.second;
    case "final":
      return ESCALATION_DAYS.final;
    default:
      return ESCALATION_DAYS.first;
  }
}

/**
 * The requests worth checking, ordered by doc 02 rule 8: age descending, then
 * request id ascending. Client name is the outer key in the spec and one
 * execution covers one client, so it drops out.
 */
export function nudgeableRequests(
  data: PracticeData,
  asOf: string,
): DocumentRequestRow[] {
  return [...data.requests].sort((a, b) => {
    const aa = dayGap(a.openedOn, asOf);
    const ab = dayGap(b.openedOn, asOf);
    if (aa !== ab) return ab - aa;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

interface NudgeContent {
  requestId: Ulid;
  asOfDate: string;
  nudgeNumber: number;
  escalationAgeDays: number;
  ageDays: number;
  nextCheckOn: string;
  action: RequestNudgeRow["action"];
  detail: string;
}

function insertNudge(
  frozen: FrozenScope<NudgeRequestsScope>,
  rowId: Ulid,
  content: NudgeContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "request_nudges",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      ...content,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}
