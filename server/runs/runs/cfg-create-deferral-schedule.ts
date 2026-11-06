/**
 * CFG-CREATE-DEFERRAL-SCHEDULE, version 1.
 *
 * Audit fix, 2026-11-06 (problem 7, one of seven missing setup-data
 * creators -- the audit's own "prepaid schedules"). subledger.deferral_schedules
 * has carried its full doc 04 Part 3 shape since migration 0005 and covers
 * prepaids, intangible amortization, deferred revenue, and stored accruals
 * under one kind column -- but apply-writer.ts had no insert case for the
 * table, so nothing could ever put a real policy, subscription, or
 * deferred-revenue contract on the books.
 *
 * This run writes the header only. per-amortize-prepaids.ts's own header
 * comment says the allocation table is built once, lazily, the first time
 * that run sees a schedule with no deferral_lines yet -- "building it here
 * rather than leaving the schedule empty is the difference between a
 * prepaid that amortizes and a prepaid that quietly does nothing." A
 * second writer for the lines here would duplicate that exact arithmetic
 * (day weighted, residual absorbed in the final period) with a real risk
 * of the two copies drifting apart; this run deliberately leaves the lines
 * to the run that already owns them.
 *
 * balanceAccount/releaseAccount are each checked against the client's real
 * chart; accumAccount only when given, since not every kind uses one.
 *
 * Manual tier: naming a prepaid policy, a deferred revenue contract, or an
 * intangible's amortization term is a one time setup decision, the same
 * reasoning every other CFG-CREATE-* run in this file gives.
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
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { canonicalJson, derivedId, scopeHashFor } from "../ids";

export const newDeferralScheduleFieldsSchema = z.object({
  kind: z.enum(["prepaid", "intangible_amortization", "deferred_revenue", "accrual"]),
  description: z.string().min(1),
  balanceAccount: z.string().regex(/^[0-9]{4}$/),
  releaseAccount: z.string().regex(/^[0-9]{4}$/),
  accumAccount: z.string().regex(/^[0-9]{4}$/).nullable().default(null),
  totalCents: z.number().int().positive().safe(),
  serviceStart: z.string().min(10),
  serviceEnd: z.string().min(10),
  method: z.enum(["straight_line_monthly", "straight_line_daily", "custom"]),
  periods: z.number().int().positive(),
  sourceTransactionId: z.string().min(1).nullable().default(null),
  sourceDocumentId: z.string().min(1).nullable().default(null),
});

export const createDeferralScheduleScopeSchema = z.object({
  clientId: z.string().min(1),
  fields: newDeferralScheduleFieldsSchema,
});

export type CreateDeferralScheduleScope = z.infer<typeof createDeferralScheduleScopeSchema>;

export const ERR_DEFERRAL_UNKNOWN_ACCOUNT = "CFG-DEFERRAL-UNKNOWN-ACCOUNT";
export const ERR_DEFERRAL_DATE_ORDER = "CFG-DEFERRAL-DATE-ORDER";

export function deferralScheduleIdFor(
  clientId: string,
  fields: z.infer<typeof newDeferralScheduleFieldsSchema>,
): string {
  return derivedId(`${clientId}:${canonicalJson(fields)}`, "cfg-create-deferral-schedule", 0);
}

export const cfgCreateDeferralSchedule: Run<CreateDeferralScheduleScope, Proposal> = {
  type: "CFG-CREATE-DEFERRAL-SCHEDULE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:deferral-schedule:${deferralScheduleIdFor(scope.clientId, scope.fields)}`,
  scopeSchema: createDeferralScheduleScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateDeferralScheduleScope>> {
    const candidateIds = [deferralScheduleIdFor(scope.clientId, scope.fields)];
    const versions = [{ id: "CFG-CREATE-DEFERRAL-SCHEDULE", version: 1 }];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions, period: canonicalJson(scope.fields) }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const id = deferralScheduleIdFor(scope.clientId, scope.fields);

    const existing = await tx.query("deferral_schedules_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      kinds: [scope.fields.kind],
    });
    if (existing.some((s) => s.id === id)) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: id, reason: "already_applied", detail: "an identical deferral schedule already exists for this client" }],
        [],
        BigInt(0),
      );
    }

    const chart = await tx.query("chart_accounts_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const knownNumbers = new Set(chart.map((a) => a.accountNumber));
    const accountsToCheck: Array<[string, string | null]> = [
      ["balance", scope.fields.balanceAccount],
      ["release", scope.fields.releaseAccount],
      ["accumulated", scope.fields.accumAccount],
    ];
    for (const [label, number] of accountsToCheck) {
      if (number !== null && !knownNumbers.has(number)) {
        errors.push({
          rowId: id,
          code: ERR_DEFERRAL_UNKNOWN_ACCOUNT,
          message: `${label} account ${number} is not on client ${scope.clientId}'s chart`,
          retryable: false,
        });
      }
    }
    if (errors.length > 0) return makeResult<Proposal>(1, [], [], errors, BigInt(0));

    if (scope.fields.serviceEnd < scope.fields.serviceStart) {
      errors.push({
        rowId: id,
        code: ERR_DEFERRAL_DATE_ORDER,
        message: `serviceEnd (${scope.fields.serviceEnd}) is before serviceStart (${scope.fields.serviceStart})`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const row: Record<string, unknown> = {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      kind: scope.fields.kind,
      description: scope.fields.description,
      balanceAccount: scope.fields.balanceAccount,
      releaseAccount: scope.fields.releaseAccount,
      accumAccount: scope.fields.accumAccount,
      totalCents: BigInt(scope.fields.totalCents),
      serviceStart: scope.fields.serviceStart,
      serviceEnd: scope.fields.serviceEnd,
      method: scope.fields.method,
      periods: scope.fields.periods,
      status: "active",
      sourceTransactionId: scope.fields.sourceTransactionId,
      sourceDocumentId: scope.fields.sourceDocumentId,
      linkedDocumentId: null,
      manualOverride: false,
      version: 1,
    };

    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "deferral_schedules",
      rowId: id,
      row,
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [insert], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-DEFERRAL-SCHEDULE", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
