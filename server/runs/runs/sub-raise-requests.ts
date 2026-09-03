/**
 * SUB-RAISE-REQUESTS. Turn every open item into one request with an owner, an
 * age, and an escalation.
 *
 * Spec: docs/02-run-specifications.md Module 6 SUB-RAISE-REQUESTS, docs
 * 05-decisions.md D7 for what the vault keeps.
 *
 * Six things count as an open item: a row still sitting in suspense, a bank
 * account with no statement for the period, an accrual still waiting for the
 * real bill, a variance or an unsupported account left by the tie out run, a
 * vendor with no current W-9, and a transaction whose intake document is
 * missing. Each becomes exactly one row keyed by a subject key, which is what
 * makes the run idempotent: a second execution finds the same subject and
 * refreshes the age instead of asking the client twice.
 *
 * A locked period is skipped. The tie out run and the gate evaluator read a
 * locked period happily because they write nothing anybody can act on, but a
 * request is work assigned to a person about a period that is already closed,
 * and that is noise rather than accountability.
 *
 * Nothing here sends anything. There is no mail, no portal push, and no external
 * call in this file. It writes rows, and the practice runs that notify people are
 * a different module.
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
import { addDays, isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { DocumentRequestRow } from "../tables";
import { periodWindow } from "./per-shared";
import { signedDayGap } from "./arap-shared";
import { ZERO, loadCloseData, type CloseData } from "./close-shared";

/**
 * The escalation ladder. Doc 02 module 6 says a request escalates by age without
 * fixing the days, so the ladder is stated once here rather than three times in
 * the body. Seven days is the first nudge because a weekly close cadence is the
 * fastest cadence the practice runs support.
 */
export const ESCALATION_DAYS = { first: 7, second: 14, final: 30 } as const;

export const raiseRequestsScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type RaiseRequestsScope = z.infer<typeof raiseRequestsScopeSchema>;

/** One open item before it becomes a row. */
interface OpenItem {
  subjectKey: string;
  catalogCode: string;
  owner: "firm" | "client" | "system";
  accountNumber: string | null;
  linkedItemId: Ulid | null;
  detail: string;
  /** The day the condition became true, which is what the age counts from. */
  openedOn: string;
  /** The row the skip list names when this item cannot be written. */
  sourceId: Ulid;
}

/** The mutable part of a request row, compared field by field on a rerun. */
interface RequestContent {
  owner: "firm" | "client" | "system";
  detail: string;
  asOfDate: string;
  agingDays: number;
  escalatesOn: string;
  escalation: "none" | "first" | "second" | "final";
}

export const subRaiseRequests: Run<RaiseRequestsScope, Proposal> = {
  type: "SUB-RAISE-REQUESTS",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:requests:${scope.period.slice(0, 7)}`,
  scopeSchema: raiseRequestsScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<RaiseRequestsScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadCloseData(tx, ctx.firmId, scope.clientId, scope.period);
    const items = collectOpenItems(data);
    const candidateIds = items.map((i) => i.sourceId);
    const versions = [
      { id: "SUB-RAISE-REQUESTS", version: 1 },
      ...data.tieouts.map((t) => ({ id: t.id, version: t.version })),
      ...data.requests.map((r) => ({ id: r.id, version: r.version })),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: data.requests.filter((r) => r.manualOverride).map((r) => r.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const data = await loadCloseData(
      tx,
      frozen.firmId,
      frozen.clientId,
      frozen.input.period,
    );
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const locked = isLockedDay(data.locks, data.periodEnd);
    const byId = new Map<string, DocumentRequestRow>(
      data.requests.map((r) => [r.id, r]),
    );
    const asOf = data.periodEnd;

    for (const item of collectOpenItems(data)) {
      if (locked) {
        skips.push({
          rowId: item.sourceId,
          reason: "locked_period",
          detail: `period ending ${asOf} is locked, so no request was raised for ${item.subjectKey}`,
        });
        continue;
      }
      const rowId = requestId(frozen.clientId, item.subjectKey);
      const content = contentFor(item, asOf);
      const prior = byId.get(rowId);
      if (prior === undefined) {
        proposals.push(insertRequest(frozen, rowId, item, content));
        continue;
      }
      if (prior.manualOverride) {
        skips.push({
          rowId: item.sourceId,
          reason: "manual_override",
          detail: `request ${item.subjectKey} carries manual_override`,
        });
        continue;
      }
      // A person who satisfied or waived a request has answered it. Refreshing
      // the age would reopen an answered question, so the row stands and the
      // condition is reported as already handled.
      if (prior.status !== "open") {
        skips.push({
          rowId: item.sourceId,
          reason: "already_applied",
          detail: `request ${item.subjectKey} is ${prior.status}`,
        });
        continue;
      }
      // The owner belongs to whoever changed it last. A run that reassigned a
      // request every time it ran would erase the reassignment G17 checks for.
      const next: RequestContent =
        prior.ownerChangedOn === null ? content : { ...content, owner: prior.owner };
      const changed = changedFields(prior, next);
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId: item.sourceId,
          reason: "already_applied",
          detail: `request_unchanged for ${item.subjectKey} at ${asOf}`,
        });
        continue;
      }
      changed.after.lastRefreshedOn = asOf;
      changed.before.lastRefreshedOn = prior.lastRefreshedOn;
      changed.after.refreshCount = prior.refreshCount + 1;
      changed.before.refreshCount = prior.refreshCount;
      proposals.push({
        kind: "field_write",
        table: "document_requests",
        rowId,
        before: changed.before,
        after: changed.after,
        provenance: { cascadeLevel: null },
      });
    }

    return makeResult<Proposal>(
      frozen.candidateIds.length,
      proposals,
      skips,
      errors,
      ZERO,
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "SUB-RAISE-REQUESTS",
      runVersion: 1,
    });
  },

  /** Ages revert, requests stand. Withdrawing the ask would hide the open item. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function requestId(clientId: Ulid, subjectKey: string): Ulid {
  return derivedId(`${clientId}:${subjectKey}`, "sub-raise-requests", 0);
}

/**
 * The six open item kinds, in a fixed order so the proposal set is deterministic.
 */
export function collectOpenItems(data: CloseData): OpenItem[] {
  const items: OpenItem[] = [];
  const txnById = new Map(data.transactions.map((t) => [t.id, t]));

  // 1. A row still in suspense. The account is 1990 by construction and the
  // owner is whoever the coding cascade assigned when it routed the row.
  for (const item of data.suspense) {
    if (item.withdrawnByRunId !== null) continue;
    const txn = txnById.get(item.transactionId);
    if (txn === undefined) continue;
    if (txn.manualOverride) continue;
    items.push({
      subjectKey: `suspense:${item.transactionId}`,
      catalogCode: "CODING_QUESTION",
      owner: txn.suspenseOwner ?? "firm",
      accountNumber: item.accountNumber,
      linkedItemId: item.transactionId,
      detail: `${item.reasonCode} on ${txn.postedDate} for ${txn.description}`,
      openedOn: txn.suspenseOpenedOn ?? txn.postedDate,
      sourceId: item.transactionId,
    });
  }

  // 2. A bank or card account with no statement covering the period end.
  for (const bank of data.bankAccounts) {
    const covered = data.recBatches.some(
      (b) => b.bankAccountId === bank.id && b.periodEnd >= data.periodEnd,
    );
    if (covered) continue;
    items.push({
      subjectKey: `statement:${bank.id}:${data.periodStart}`,
      catalogCode: "BANK_STATEMENT",
      owner: "client",
      accountNumber: bank.accountNumber,
      linkedItemId: bank.id,
      detail: `no statement is loaded for ${bank.nickname} through ${data.periodEnd}`,
      openedOn: data.periodEnd,
      sourceId: bank.id,
    });
  }

  // 3. An accrual template still waiting for the document it stands in for.
  for (const template of data.accrualTemplates) {
    if (!template.isActive) continue;
    if (template.manualOverride) continue;
    if (template.accrualKind !== "bill_received_not_entered") continue;
    if (template.sourceDocumentId !== null) continue;
    items.push({
      subjectKey: `bill:${template.id}`,
      catalogCode: "VENDOR_BILL",
      owner: "client",
      accountNumber: template.creditAccount,
      linkedItemId: template.id,
      detail: `accrual ${template.name} has no bill behind it`,
      openedOn: data.periodEnd,
      sourceId: template.id,
    });
  }

  // 4. A variance or an unsupported account the tie out run left open.
  for (const tie of data.tieouts) {
    if (tie.state === "computed_tied") continue;
    if (tie.manualOverride) continue;
    items.push({
      subjectKey: `variance:${tie.accountNumber}:${data.periodStart}`,
      catalogCode: tie.state === "unsupported" ? "SUBSTANTIATION" : "VARIANCE",
      owner: tie.state === "unsupported" ? "client" : "firm",
      accountNumber: tie.accountNumber,
      linkedItemId: tie.id,
      detail: `${tie.accountNumber} is ${tie.state}: ${tie.detail}`,
      openedOn: data.periodEnd,
      sourceId: tie.id,
    });
  }

  // 5. A vendor with no W-9 on file or one that has expired. Doc 00 Part 6 ties
  // this to backup withholding, which is why it is a close item and not tidiness.
  for (const vendor of data.vendors) {
    if (!vendor.isActive) continue;
    const expired =
      vendor.w9ExpiresOn !== null && vendor.w9ExpiresOn <= data.periodEnd;
    if (vendor.w9OnFile && !expired) continue;
    items.push({
      subjectKey: `w9:${vendor.id}`,
      catalogCode: "W9",
      owner: "client",
      accountNumber: null,
      linkedItemId: vendor.id,
      detail: vendor.w9OnFile
        ? `W-9 for ${vendor.legalName} expired on ${vendor.w9ExpiresOn ?? "an unknown day"}`
        : `no W-9 is on file for ${vendor.legalName}`,
      openedOn: expired && vendor.w9ExpiresOn !== null ? vendor.w9ExpiresOn : data.periodEnd,
      sourceId: vendor.id,
    });
  }

  // 6. A transaction whose intake document is missing. The coding runs already
  // raised the exception, so this reads their output rather than judging again.
  for (const exception of data.exceptions) {
    if (exception.status !== "open") continue;
    if (exception.kind !== "missing_receipt") continue;
    const txn = txnById.get(exception.transactionId);
    if (txn === undefined) continue;
    const linked = data.documentLinks.some(
      (l) => l.transactionId === exception.transactionId,
    );
    if (linked) continue;
    items.push({
      subjectKey: `document:${exception.transactionId}`,
      catalogCode: "RECEIPT",
      owner: "client",
      accountNumber: txn.accountNumber,
      linkedItemId: exception.transactionId,
      detail: exception.detail,
      openedOn: exception.openedAt.slice(0, 10),
      sourceId: exception.transactionId,
    });
  }

  return items.sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : 1));
}

function contentFor(item: OpenItem, asOf: string): RequestContent {
  const age = Math.max(0, signedDayGap(item.openedOn, asOf));
  return {
    owner: item.owner,
    detail: item.detail,
    asOfDate: asOf,
    agingDays: age,
    escalatesOn: addDays(item.openedOn, ESCALATION_DAYS.first),
    escalation: escalationFor(age),
  };
}

export function escalationFor(age: number): RequestContent["escalation"] {
  if (age >= ESCALATION_DAYS.final) return "final";
  if (age >= ESCALATION_DAYS.second) return "second";
  if (age >= ESCALATION_DAYS.first) return "first";
  return "none";
}

function insertRequest(
  frozen: FrozenScope<RaiseRequestsScope>,
  rowId: Ulid,
  item: OpenItem,
  content: RequestContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "document_requests",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      subjectKey: item.subjectKey,
      catalogCode: item.catalogCode,
      accountNumber: item.accountNumber,
      periodStart: frozen.periodStart,
      linkedItemId: item.linkedItemId,
      status: "open",
      openedOn: item.openedOn,
      ownerChangedOn: null,
      lastRefreshedOn: null,
      refreshCount: 0,
      ...content,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

function changedFields(
  prior: DocumentRequestRow,
  next: RequestContent,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const keys = Object.keys(next) as (keyof RequestContent)[];
  for (const k of keys) {
    const priorValue = (prior as unknown as Record<string, unknown>)[k];
    if (priorValue !== next[k]) {
      before[k] = priorValue;
      after[k] = next[k];
    }
  }
  return { before, after };
}
