/**
 * INTAKE-OPEN-REQUESTS. Raise the opening document asks for a new client.
 *
 * Spec: docs/02-run-specifications.md Module 1, and the document request
 * machinery SUB-RAISE-REQUESTS already owns in Module 6.
 *
 * What the run does. It opens the six records the firm needs before it can keep
 * books at all: the owner's Form W-9, the EIN assignment letter, the prior year
 * trial balance, the opening bank statements, the formation document, and the
 * chart of authorization. Each one becomes a row in document_requests, the same
 * table the close uses, so the open items page shows intake asks and close asks
 * in one list instead of two.
 *
 * Idempotency. The row id is derived from the client and the subject key,
 * exactly the rule SUB-RAISE-REQUESTS uses, so an intake ask and a close ask
 * about the same subject are the same row rather than two. A second execution
 * finds every subject present and reports request exists.
 *
 * Never overwrites. There is no field write path here. A request whose owner a
 * person moved, or which somebody already satisfied or waived, keeps its state.
 * SUB-RAISE-REQUESTS is the run that ages an open request, and this one only
 * opens what does not exist.
 *
 * COMPLIANCE. Every detail line names a record the firm needs in order to keep
 * books. None of them tells the client what entity to be, what to file, or when
 * to file it. The firm is not a CPA, is not a registered agent, and this run
 * does not register, file, or submit anything.
 *
 * SENDS. None. A request is a row on a page the client signs in to read. No
 * address is read, no message is queued, nothing leaves the process.
 *
 * CONSTRAINT. No model. The catalog is a table in intake-shared.ts.
 */

import { z } from "zod";
import {
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
import { addDays } from "../dates";
import { scopeHashFor } from "../ids";
import type { DocumentRequestRow } from "../tables";
import { ZERO } from "./close-shared";
import { periodWindow } from "./per-shared";
import { requestId } from "./sub-raise-requests";
import {
  STANDARD_REQUESTS,
  loadIntakeData,
  type StandardRequest,
} from "./intake-shared";

/** Doc 02 Module 6. An opening ask gets the same first rung window as any other. */
export const INTAKE_ESCALATION_DAYS = 7;

export const openRequestsScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  /** The day the asks are dated from, normally the cutover date. */
  openedOn: z.string().min(10),
  scopeKeys: z.array(z.string().min(1)).default([]),
  excludeSubjectKeys: z.array(z.string().min(1)).default([]),
});

export type OpenRequestsScope = z.infer<typeof openRequestsScopeSchema>;

export const intakeOpenRequests: Run<OpenRequestsScope, Proposal> = {
  type: "INTAKE-OPEN-REQUESTS",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:intake-requests`,
  scopeSchema: openRequestsScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<OpenRequestsScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadIntakeData(
      tx,
      ctx.firmId,
      scope.clientId,
      scope.period,
      window.periodStart,
    );
    const wanted = wantedRequests(scope);
    const candidateIds = wanted.map((r) => requestId(scope.clientId, r.subjectKey));
    const versions = [
      { id: "INTAKE-OPEN-REQUESTS", version: 1 },
      ...data.requests.map((r) => ({ id: r.id, version: r.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [
          window.periodStart,
          scope.openedOn,
          [...scope.scopeKeys].sort().join("|"),
          [...scope.excludeSubjectKeys].sort().join("|"),
        ].join("/"),
      }),
      versions,
      overriddenIds: data.requests.filter((r) => r.manualOverride).map((r) => r.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const data = await loadIntakeData(
      tx,
      frozen.firmId,
      frozen.clientId,
      frozen.input.period,
      window.periodStart,
    );
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const bySubject = new Map<string, DocumentRequestRow>(
      data.requests.map((r) => [r.subjectKey, r]),
    );
    const byId = new Map<string, DocumentRequestRow>(data.requests.map((r) => [r.id, r]));

    for (const ask of wantedRequests(frozen.input)) {
      const rowId = requestId(frozen.clientId, ask.subjectKey);
      const prior = byId.get(rowId) ?? bySubject.get(ask.subjectKey);
      if (prior !== undefined && prior.manualOverride) {
        skips.push({
          rowId,
          reason: "manual_override",
          detail: `request ${ask.subjectKey} carries manual_override`,
        });
        continue;
      }
      if (prior !== undefined) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `request_exists for ${ask.subjectKey}, status ${prior.status}`,
        });
        continue;
      }
      proposals.push(insertRequest(frozen, rowId, ask));
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "INTAKE-OPEN-REQUESTS",
      runVersion: 1,
    });
  },

  /** Nothing reverts. Withdrawing an ask would hide an open item. */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};

/** The opening asks this scope wants, subject key ascending. */
export function wantedRequests(scope: OpenRequestsScope): StandardRequest[] {
  const excluded = new Set(scope.excludeSubjectKeys);
  const answered = new Set(scope.scopeKeys);
  return STANDARD_REQUESTS.filter((r) => !excluded.has(r.subjectKey))
    .filter((r) => r.scopeKey === null || answered.has(r.scopeKey))
    .slice()
    .sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0));
}

function insertRequest(
  frozen: FrozenScope<OpenRequestsScope>,
  rowId: Ulid,
  ask: StandardRequest,
): ProposedRowInsert {
  const openedOn = frozen.input.openedOn;
  return {
    kind: "row_insert",
    table: "document_requests",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      subjectKey: ask.subjectKey,
      catalogCode: ask.catalogCode,
      owner: ask.owner,
      accountNumber: ask.accountNumber,
      periodStart: frozen.periodStart,
      linkedItemId: null,
      detail: ask.detail,
      status: "open",
      openedOn,
      asOfDate: openedOn,
      agingDays: 0,
      escalatesOn: addDays(openedOn, INTAKE_ESCALATION_DAYS),
      escalation: "none",
      ownerChangedOn: null,
      lastRefreshedOn: null,
      refreshCount: 0,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}
