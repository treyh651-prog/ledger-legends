/**
 * CLOSE-OVERRIDE-GATE, version 1.
 *
 * Audit fix, 2026-11-05 (problem 4). close.gate_results has carried
 * manual_override/override_reason since the close module was built, and
 * CLOSE-LOCK-PERIOD has always read both -- a gate that failed but
 * carries manual_override with a written reason counts as an exception
 * rather than a hard block, and the lock it produces is stamped
 * closed_with_exceptions. Nothing ever wrote either column: apply-writer.ts
 * had a field_write case for the table (CLS-EVALUATE-GATES uses it to
 * refresh an un-overridden result), but no run ever set manual_override
 * to true in the first place. A solo firm -- one person, every run both
 * previewed and applied by the same actor -- trips G18 (separation of
 * duties) on every real close, with no way to accept that and move on,
 * and CLOSE-LOCK-PERIOD refuses outright rather than skipping a failing
 * gate, by design (doc 00 Part 5: a lock is a claim, not a partial one).
 *
 * This is the missing writer, for any gate, not only G18 -- the same
 * reasoning CFG-DISABLE-RULE-AUTOPOST gives for needing no threshold to
 * revoke a privilege: a person should always be able to accept a known,
 * named exception without the engine inventing a business rule for which
 * gates are "allowed" to be overridden.
 *
 * Overriding a gate that is not currently failing is a no-op, not an
 * error: there is nothing to accept an exception for once a gate already
 * passes or does not apply, and a stale override request from a UI that
 * has not refreshed yet should not be treated as a mistake.
 *
 * Manual tier: accepting a known exception and writing down why is a
 * decision a person makes on purpose, the same reasoning every other
 * override-shaped run in this codebase gives.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { periodWindow } from "./per-shared";
import { scopeHashFor } from "../ids";
import { gateResultId } from "./cls-evaluate-gates";
import type { CloseGateResultRow } from "../tables";

export const overrideGateScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  gateCode: z.string().min(1),
  reason: z.string().min(1),
});

export type OverrideGateScope = z.infer<typeof overrideGateScopeSchema>;

export const ERR_GATE_RESULT_NOT_FOUND = "CLOSE_GATE_RESULT_NOT_FOUND";

export const closeOverrideGate: Run<OverrideGateScope, Proposal> = {
  type: "CLOSE-OVERRIDE-GATE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:close-override-gate:${scope.period.slice(0, 7)}:${scope.gateCode}`,
  scopeSchema: overrideGateScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<OverrideGateScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const rowId = gateResultId(scope.clientId, window.periodStart, scope.gateCode);
    const results = await tx.query("close_gate_results_for_period", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      periodStart: window.periodStart,
    });
    const candidateIds = [rowId];
    const versions = [
      { id: "CLOSE-OVERRIDE-GATE", version: 1 },
      ...results.map((r) => ({ id: r.id, version: r.version })),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions, period: scope.reason }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const rowId = gateResultId(scope.clientId, frozen.periodStart, scope.gateCode);
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const results = await tx.query("close_gate_results_for_period", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      periodStart: frozen.periodStart,
    });
    const result: CloseGateResultRow | undefined = results.find((r) => r.gateCode === scope.gateCode);
    if (!result) {
      errors.push({
        rowId,
        code: ERR_GATE_RESULT_NOT_FOUND,
        message: `${scope.gateCode} has no evaluated result for ${frozen.periodStart} -- run CLOSE-CHECK-GATES first`,
        retryable: true,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    if (result.manualOverride) {
      skips.push({
        rowId: result.id,
        reason: "already_applied",
        detail: `${scope.gateCode} already carries manual_override: ${result.overrideReason ?? "no reason recorded"}`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }
    if (result.outcome === "pass" || result.outcome === "not_applicable") {
      skips.push({
        rowId: result.id,
        reason: "already_applied",
        detail: `${scope.gateCode} is already ${result.outcome}, nothing to override`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "close_gate_results",
      rowId: result.id,
      before: { manualOverride: result.manualOverride, overrideReason: result.overrideReason },
      after: { manualOverride: true, overrideReason: scope.reason },
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [write], skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CLOSE-OVERRIDE-GATE", runVersion: 1 });
  },

  /**
   * No undo. The guard that protects a manually overridden row (confirmed
   * live: OVERRIDE_PROTECTED_ROW) blocks every further run-mediated write
   * to it, including this very write's own undo -- the same terminal
   * invariant TXN-RECODE's own undo runs into once manual_override is set
   * on a transaction. An override is a decision a person wrote a reason
   * for; un-deciding it is CLS-EVALUATE-GATES refusing to touch the row
   * again until a person clears manual_override directly, which this
   * codebase has no path for on any table, by design.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
