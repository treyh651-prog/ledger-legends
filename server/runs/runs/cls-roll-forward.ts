/**
 * CLOSE-ROLL-FORWARD. Open the new period with the prior period's ending
 * balances as its opening balances.
 *
 * Spec: docs/02-run-specifications.md Module 6 CLS-ROLL-FORWARD.
 *
 * Nothing is posted. A roll forward is not an entry, because the ledger already
 * carries every balance forward by construction: a balance through a day is the
 * sum of every line on or before it. What the roll forward produces is the stated
 * opening figure a person compares against, which is what makes a later
 * difference visible instead of arithmetic nobody redid.
 *
 * Only balance sheet accounts roll. Revenue and expense accounts open at zero in
 * a new fiscal year and open at their running total inside one, and either way
 * the number that matters for them is the year to date figure the reporting runs
 * compute. Rolling them here would create a second, competing claim.
 *
 * Idempotency is by content against the row derived from the new period start and
 * the account. A rerun after a prior period correction rewrites the opening figure
 * in place, because two opening balances for one account in one period is exactly
 * the ambiguity the run exists to remove. The source period being locked is
 * expected and is not a reason to skip: the whole point is to write forward.
 */

import { z } from "zod";
import {
  isFieldWrite,
  makeResult,
  type Cents,
  type FrozenScope,
  type Proposal,
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
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import { periodWindow } from "./per-shared";
import {
  ZERO,
  balancesThrough,
  isBalanceSheet,
  loadCloseData,
  priorDayOf,
} from "./close-shared";
import { fiscalYearEndOf, fiscalYearStartOf, periodId } from "./cls-lock-period";

export const rollForwardScopeSchema = z.object({
  clientId: z.string().min(1),
  /** Any day in the period being opened. Its first day is where the roll lands. */
  period: z.string().min(10),
});

export type RollForwardScope = z.infer<typeof rollForwardScopeSchema>;

export const clsRollForward: Run<RollForwardScope, Proposal> = {
  type: "CLOSE-ROLL-FORWARD",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:roll:${scope.period.slice(0, 7)}`,
  scopeSchema: rollForwardScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<RollForwardScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadCloseData(tx, ctx.firmId, scope.clientId, scope.period);
    const accounts = data.chart.filter((a) => isBalanceSheet(a.accountNumber));
    const candidateIds = accounts.map((a) => a.id);
    const versions = [
      { id: "CLOSE-ROLL-FORWARD", version: 1 },
      ...data.openings.map((o) => ({ id: o.id, version: o.version })),
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
      overriddenIds: data.openings.filter((o) => o.manualOverride).map((o) => o.id),
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
    const priorEnd = priorDayOf(data.periodStart);
    const priorStart = periodWindow(priorEnd).periodStart;
    const closing = balancesThrough(data.lines, priorEnd);
    const existing = new Map(data.openings.map((o) => [o.id, o]));

    for (const account of data.chart) {
      if (!isBalanceSheet(account.accountNumber)) continue;
      const opening: Cents = closing.get(account.accountNumber) ?? ZERO;
      const rowId = openingId(data.periodStart, account.accountNumber);
      const prior = existing.get(rowId);
      if (prior === undefined) {
        // A zero opening on an account nobody used is not worth a row. The
        // absence of a row and a row saying zero say the same thing, and the
        // shorter report is the one a person reads.
        if (opening === ZERO) {
          skips.push({
            rowId: account.id,
            reason: "already_applied",
            detail: `${account.accountNumber} closed ${priorEnd} at zero, so no opening balance was written`,
          });
          continue;
        }
        proposals.push({
          kind: "row_insert",
          table: "opening_balances",
          rowId,
          row: {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            version: 1,
            periodStart: data.periodStart,
            accountNumber: account.accountNumber,
            openingBalanceCents: opening,
            sourcePeriodStart: priorStart,
            sourceKind: "prior_period_ending_balance",
            createdByRunId: RUN_ID_PLACEHOLDER,
            createdAt: NOW_PLACEHOLDER,
            manualOverride: false,
          },
          provenance: { cascadeLevel: null },
        });
        continue;
      }
      if (prior.manualOverride) {
        skips.push({
          rowId: account.id,
          reason: "manual_override",
          detail: `opening balance for ${account.accountNumber} carries manual_override`,
        });
        continue;
      }
      if (prior.openingBalanceCents === opening) {
        skips.push({
          rowId: account.id,
          reason: "already_applied",
          detail: `opening_unchanged for ${account.accountNumber} at ${data.periodStart}`,
        });
        continue;
      }
      proposals.push({
        kind: "field_write",
        table: "opening_balances",
        rowId,
        before: { openingBalanceCents: prior.openingBalanceCents },
        after: { openingBalanceCents: opening },
        provenance: { cascadeLevel: null },
      });
    }

    // The period being opened gets a row, so its status is a thing that exists
    // rather than the absence of a lock.
    const period = data.periods.find((p) => p.periodStart === data.periodStart);
    if (period === undefined) {
      const endMonth = data.policy === null ? 12 : data.policy.fiscalYearEndMonth;
      proposals.push({
        kind: "row_insert",
        table: "close_periods",
        rowId: periodId(frozen.clientId, data.periodStart),
        row: {
          firmId: frozen.firmId,
          clientId: frozen.clientId,
          version: 1,
          periodStart: data.periodStart,
          periodEnd: data.periodEnd,
          fiscalYearStart: fiscalYearStartOf(data.periodStart, endMonth),
          fiscalYearEnd: fiscalYearEndOf(data.periodStart, endMonth),
          status: "open",
          openedByRunId: RUN_ID_PLACEHOLDER,
          openedAt: NOW_PLACEHOLDER,
          lockedByRunId: null,
          lockedAt: null,
          rolledFromPeriodStart: priorStart,
          manualOverride: false,
        },
        provenance: { cascadeLevel: null },
      });
    } else {
      skips.push({
        rowId: period.id,
        reason: "already_applied",
        detail: `period ${data.periodStart} is already open`,
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
      runType: "CLOSE-ROLL-FORWARD",
      runVersion: 1,
    });
  },

  /** A restated opening figure reverts. The opened period stands. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function openingId(periodStart: string, accountNumber: string): Ulid {
  return derivedId(`${periodStart}:${accountNumber}`, "cls-roll-forward", 0);
}
