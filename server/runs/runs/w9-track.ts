/**
 * COMPILATION ONLY. This run tracks paperwork state. It sends nothing.
 *
 * Ledger Legends is not a CPA firm. This run compiles data. It does not file,
 * issue, submit, or transmit any tax document. The compiled data set is
 * provided to the client's CPA for filing.
 *
 * TAX-TRACK-W9. Track the W-9 collection state of every payee.
 *
 * Spec: docs/02-run-specifications.md Module 8 TAX-TRACK-W9, and
 * docs/05-decisions.md D4.
 *
 * What the run does. For every vendor it resolves one of five collection
 * stages, not requested, requested, received, on file, or expired, records the
 * doc 02 severity code alongside it, ages any open request, and raises a
 * document request through the existing SUB-RAISE-REQUESTS machinery when the
 * form is missing. It is idempotent per vendor because both the state row id
 * and the request row id are derived from the vendor rather than generated.
 *
 * Why it reuses the request machinery rather than inventing a second one.
 * SUB-RAISE-REQUESTS already raises a W9 catalog code request per vendor keyed
 * on the subject key w9 plus the vendor id, and the request id function is
 * exported from that file. This run imports that function, so a request raised
 * by either run is the same row and the two runs cannot ask a client for the
 * same form twice. See NOTES.md entry 113.
 *
 * SENDS. None. Raising a request writes a row. Escalating writes a field on
 * that row. There is no mail, no portal push, no webhook, and no external call
 * anywhere in this file, which is the same rule the whole codebase runs on.
 *
 * Overdue escalates once, to the engagement lead, and never as a second
 * request. Doc 02 rule 3. A second request would look like a new ask about a
 * form the client has already been asked for, and the client cannot tell the
 * two apart.
 *
 * PRIVACY. Only the last four digits of a taxpayer identification number are
 * copied onto the state row. Nothing here reads, logs, or narrates a full one,
 * and no column in this schema can hold one.
 *
 * CONSTRAINT. No model, no score, no string distance. Every state is a
 * comparison of stored dates and stored flags.
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
import type { DocumentRequestRow, VendorRow, W9StateRow } from "../tables";
import { ZERO } from "./close-shared";
import { changedFieldsOf } from "./rpt-shared";
import { requestId as sharedRequestId } from "./sub-raise-requests";
import {
  W9_ESCALATION_DAYS,
  loadTaxData,
  severityOf,
  w9StageOf,
  w9StatusOf,
  yearWindowOf,
  type TaxData,
} from "./tax-shared";

export const trackW9ScopeSchema = z.object({
  clientId: z.string().min(1),
  /** Any day inside the calendar year being tracked. */
  period: z.string().min(10),
});

export type TrackW9Scope = z.infer<typeof trackW9ScopeSchema>;

/** The comparable content of one state row. */
interface StateContent {
  taxYear: number;
  vendorId: Ulid;
  vendorName: string;
  state: W9StateRow["state"];
  statusCode: W9StateRow["statusCode"];
  requestedOn: string | null;
  receivedOn: string | null;
  expiresOn: string | null;
  onFile: boolean;
  requestId: Ulid | null;
  escalation: "none" | "lead";
  ageDays: number;
  tinLast4: string | null;
  asOfDate: string;
  detail: string;
}

export const w9Track: Run<TrackW9Scope, Proposal> = {
  type: "TAX-TRACK-W9",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:w9:${scope.period.slice(0, 4)}`,
  scopeSchema: trackW9ScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<TrackW9Scope>> {
    const tx = requireTx(ctx);
    const taxYear = Number(scope.period.slice(0, 4));
    const window = yearWindowOf(taxYear);
    const data = await loadTaxData(tx, ctx.firmId, scope.clientId, taxYear);
    const vendors = trackedVendors(data);
    const candidateIds = vendors.map((v) => v.id);
    const versions = [
      { id: "TAX-TRACK-W9", version: 1 },
      ...data.w9States.map((s) => ({ id: s.id, version: s.version })),
      ...data.requests
        .filter((r) => r.catalogCode === "W9")
        .map((r) => ({ id: r.id, version: r.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.yearStart,
      periodEnd: window.yearEnd,
      candidateIds,
      // The year is in the hash so tracking 2025 and 2026 are different scopes.
      // No ledger fingerprint here: this run reads paperwork state, not the
      // ledger, so a posting has nothing to say about it.
      scopeHash: scopeHashFor({
        period: window.yearStart,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: data.w9States.filter((s) => s.manualOverride).map((s) => s.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const taxYear = Number(frozen.input.period.slice(0, 4));
    const window = yearWindowOf(taxYear);
    const data = await loadTaxData(tx, frozen.firmId, frozen.clientId, taxYear);
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const asOf = window.yearEnd;

    const stateById = new Map<string, W9StateRow>(data.w9States.map((s) => [s.id, s]));
    const requestBySubject = new Map<string, DocumentRequestRow>();
    for (const request of data.requests) {
      if (request.catalogCode !== "W9") continue;
      requestBySubject.set(request.subjectKey, request);
    }

    const vendors = trackedVendors(data);
    // Doc 02 rule 6. Worst status first, then payee name ascending, so the
    // proposal order says something and is still deterministic.
    const ordered = [...vendors].sort((a, b) => {
      const sa = severityOf(w9StatusOf(a, requestBySubject.get(`w9:${a.id}`), asOf));
      const sb = severityOf(w9StatusOf(b, requestBySubject.get(`w9:${b.id}`), asOf));
      if (sa !== sb) return sa - sb;
      if (a.legalName !== b.legalName) return a.legalName < b.legalName ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    for (const vendor of ordered) {
      const subjectKey = `w9:${vendor.id}`;
      const request = requestBySubject.get(subjectKey);
      const status = w9StatusOf(vendor, request, asOf);
      const stage = w9StageOf(vendor, request, asOf);
      const rowId = stateIdOf(frozen.clientId, taxYear, vendor.id);
      const prior = stateById.get(rowId);

      if (prior !== undefined && prior.manualOverride) {
        skips.push({
          rowId,
          reason: "manual_override",
          detail: `w9 state for ${vendor.legalName} carries manual_override`,
        });
        continue;
      }

      const age = request === undefined ? 0 : Math.max(0, dayGap(request.openedOn, asOf));
      const overdue = status === "requested_overdue";
      const content: StateContent = {
        taxYear,
        vendorId: vendor.id,
        vendorName: vendor.legalName,
        state: stage,
        statusCode: status,
        requestedOn: request === undefined ? null : request.openedOn,
        receivedOn:
          request !== undefined && request.status === "satisfied"
            ? request.lastRefreshedOn
            : null,
        expiresOn: vendor.w9ExpiresOn,
        onFile: vendor.w9OnFile,
        requestId: request === undefined ? null : request.id,
        // Doc 02 rule 3. Overdue escalates once, to the engagement lead. It
        // never becomes a second request.
        escalation: overdue ? "lead" : "none",
        ageDays: age,
        // Four digits, and only ever four.
        tinLast4: vendor.tinLast4,
        asOfDate: asOf,
        detail: detailFor(vendor, status, age),
      };

      if (prior === undefined) {
        proposals.push(insertState(frozen, rowId, content));
      } else {
        const changed = changedFieldsOf(
          prior as unknown as Record<string, unknown>,
          content as unknown as Record<string, unknown>,
        );
        if (Object.keys(changed.after).length === 0) {
          skips.push({
            rowId,
            reason: "already_applied",
            detail: `w9_state_unchanged for ${vendor.legalName} at ${asOf}`,
          });
        } else {
          changed.after.lastRefreshedOn = asOf;
          changed.before.lastRefreshedOn = prior.lastRefreshedOn;
          changed.after.refreshCount = prior.refreshCount + 1;
          changed.before.refreshCount = prior.refreshCount;
          proposals.push({
            kind: "field_write",
            table: "w9_states",
            rowId,
            before: changed.before,
            after: changed.after,
            provenance: { cascadeLevel: null },
          });
        }
      }

      /*
       * The request. Missing means no form and no open ask, so one is raised
       * through the shared machinery. The id is derived from the same subject
       * key SUB-RAISE-REQUESTS uses, so the two runs share one row and the
       * client is never asked twice for one form.
       */
      if (status === "missing") {
        const requestRowId = sharedRequestId(frozen.clientId, subjectKey);
        if (requestBySubject.has(subjectKey)) {
          skips.push({
            rowId: vendor.id,
            reason: "already_applied",
            detail: `request_exists for ${vendor.legalName}`,
          });
        } else {
          proposals.push(raiseRequest(frozen, requestRowId, vendor, subjectKey, asOf));
        }
        continue;
      }

      if (status === "on_file_complete") {
        skips.push({
          rowId: vendor.id,
          reason: "already_applied",
          detail: `w9_on_file_complete for ${vendor.legalName}`,
        });
      }
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "TAX-TRACK-W9", runVersion: 1 });
  },

  /** State refreshes revert. A raised request stands, the same call module 6 made. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function stateIdOf(clientId: Ulid, taxYear: number, vendorId: Ulid): Ulid {
  return derivedId(`${clientId}:${taxYear}:${vendorId}`, "w9-track", 0);
}

/**
 * The vendors worth tracking.
 *
 * Active vendors only. Iteration order
 * for the candidate list is vendor id ascending so the frozen scope is stable
 * regardless of what the status happens to be on the day it froze.
 */
export function trackedVendors(data: TaxData): VendorRow[] {
  return data.vendors
    .filter((v) => v.isActive)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function detailFor(vendor: VendorRow, status: string, age: number): string {
  switch (status) {
    case "on_file_complete":
      return `W-9 on file for ${vendor.legalName} with a recorded TIN.`;
    case "on_file_incomplete":
      return `W-9 on file for ${vendor.legalName} with no TIN recorded.`;
    case "requested_pending":
      return `W-9 requested from ${vendor.legalName}, open ${age} days.`;
    case "requested_overdue":
      return (
        `W-9 requested from ${vendor.legalName}, open ${age} days, past the ` +
        `${W9_ESCALATION_DAYS} day window. Escalated to the engagement lead.`
      );
    default:
      return `No W-9 on file for ${vendor.legalName} and no open request.`;
  }
}

function insertState(
  frozen: FrozenScope<TrackW9Scope>,
  rowId: Ulid,
  content: StateContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "w9_states",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      ...content,
      lastRefreshedOn: null,
      refreshCount: 0,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

/**
 * Raise the ask, write nothing else.
 *
 * The row shape is the one SUB-RAISE-REQUESTS writes, field for field, because
 * both runs write the same table and a request that looks different depending
 * on who raised it is a request the escalation logic cannot age consistently.
 */
function raiseRequest(
  frozen: FrozenScope<TrackW9Scope>,
  rowId: Ulid,
  vendor: VendorRow,
  subjectKey: string,
  asOf: string,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "document_requests",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      subjectKey,
      catalogCode: "W9",
      // The client holds the form. The firm cannot produce it.
      owner: "client",
      accountNumber: null,
      periodStart: frozen.periodStart,
      linkedItemId: vendor.id,
      detail: `no W-9 on file for ${vendor.legalName}`,
      status: "open",
      openedOn: asOf,
      asOfDate: asOf,
      agingDays: 0,
      escalatesOn: asOf,
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
