/**
 * RPT-FLAG-VARIANCES. Compare actual to budget, account by account, for one
 * period, and flag what crosses the threshold.
 *
 * Spec: docs/02-run-specifications.md Module 8 RPT-FLAG-VARIANCES.
 *
 * Two conditions decide a flag, not one. The percentage keeps a small account
 * from shouting about a rounding difference and the absolute floor keeps a large
 * account from shouting about a figure nobody would act on. Both are stated on
 * the row, so a flag read six months later says what it was measured against
 * rather than what the thresholds happen to be that day. See NOTES.md entry 99.
 *
 * An account with a zero budget and real activity is not a percentage. There is
 * no percentage of nothing, and reporting zero there would read as no variance
 * when the truth is spending nobody planned. That case is flagged with its own
 * code, unbudgeted_activity, and the percentage column stays null.
 *
 * The run writes a row for every income statement account it evaluated, flagged
 * or not. A report that lists only the flags cannot be checked, because a reader
 * cannot tell the accounts that came in under threshold from the accounts nobody
 * looked at.
 *
 * Income statement accounts only. A budget against a balance sheet account is a
 * cash plan and belongs in the forecast, and the nine thousand block is outside
 * published statements per doc 00 Part 3.
 *
 * The run reads the ledger and writes only report rows, so it is safe on a
 * locked period and requiresOpenPeriod is false. The ledger fingerprint is in
 * the scope hash, so a rebuild after a posting produces fresh flags.
 *
 * SENDS. None.
 *
 * COMPLIANCE. A variance is a difference between two figures already on the
 * books. This run offers no explanation, no opinion, and no advice about any of
 * them.
 */

import { z } from "zod";
import {
  isFieldWrite,
  makeResult,
  type Cents,
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
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { ReportVarianceRow } from "../tables";
import { periodWindow } from "./per-shared";
import { ZERO, balanceOf } from "./close-shared";
import {
  absCents,
  accountNameOf,
  changedFieldsOf,
  isVarianceAccount,
  loadReportData,
  reportingDiscriminator,
  resolveThreshold,
  varianceBpOf,
  varianceDirection,
  type ReportData,
} from "./rpt-shared";

export const flagVariancesScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type FlagVariancesScope = z.infer<typeof flagVariancesScopeSchema>;

/** The comparable content of one variance row. */
interface VarianceContent {
  accountNumber: string;
  accountName: string;
  actualCents: Cents;
  budgetCents: Cents;
  varianceCents: Cents;
  varianceBp: number | null;
  direction: "favorable" | "unfavorable" | "neutral";
  flagged: boolean;
  flagCode: "within_threshold" | "over_threshold" | "unbudgeted_activity";
  floorCents: Cents;
  thresholdBp: number;
  detail: string;
}

export const rptFlagVariances: Run<FlagVariancesScope, Proposal> = {
  type: "RPT-FLAG-VARIANCES",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:report-variance:${scope.period.slice(0, 7)}`,
  scopeSchema: flagVariancesScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<FlagVariancesScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadReportData(tx, ctx.firmId, scope.clientId, scope.period);
    const accounts = evaluatedAccounts(data);
    const candidateIds = accounts.slice();
    const versions = [
      { id: "RPT-FLAG-VARIANCES", version: 1 },
      // The budget rows and the thresholds are both inputs to a flag, so a
      // change to either is a change of scope and not a silent reinterpretation.
      ...data.budgets.map((b) => ({ id: b.id, version: b.version })),
      ...data.thresholds.map((t) => ({ id: t.id, version: t.version })),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      /**
       * Period first so two periods cannot collide, then the ledger fingerprint
       * so a posting inside the period is a new scope rather than a stale hit.
       */
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds: [
          ...candidateIds,
          reportingDiscriminator(
            window.periodStart,
            data.fingerprint,
            "RPT-FLAG-VARIANCES",
          ),
        ],
        versions,
      }),
      versions,
      overriddenIds: data.variances
        .filter((v) => v.manualOverride)
        .map((v) => v.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const data = await loadReportData(
      tx,
      frozen.firmId,
      frozen.clientId,
      frozen.input.period,
    );
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const priorById = new Map<string, ReportVarianceRow>(
      data.variances.map((v) => [v.id, v]),
    );

    for (const accountNumber of evaluatedAccounts(data)) {
      const content = varianceContentFor(data, accountNumber);
      const rowId = varianceIdOf(data.periodStart, accountNumber);
      const prior = priorById.get(rowId);
      if (prior === undefined) {
        proposals.push(insertVariance(frozen, data, rowId, content));
        continue;
      }
      // Invariant 8. A person who decided by hand that this account is not worth
      // flagging has made a decision, and a run does not overturn it.
      if (prior.manualOverride) {
        skips.push({
          rowId,
          reason: "manual_override",
          detail: `variance row for ${accountNumber} carries manual_override`,
        });
        continue;
      }
      // A budget row a person took over is an input, not a target, so the
      // variance is not computed against it at all.
      const budgetRow = data.budgets.find((b) => b.accountNumber === accountNumber);
      if (budgetRow !== undefined && budgetRow.manualOverride) {
        skips.push({
          rowId,
          reason: "manual_override",
          detail: `budget row for ${accountNumber} carries manual_override`,
        });
        continue;
      }
      const changed = changedFieldsOf(
        prior as unknown as Record<string, unknown>,
        content as unknown as Record<string, unknown>,
      );
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `variance_unchanged for ${accountNumber} at ${data.periodEnd}`,
        });
        continue;
      }
      proposals.push({
        kind: "field_write",
        table: "report_variances",
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
      runType: "RPT-FLAG-VARIANCES",
      runVersion: 1,
    });
  },

  /** Inserted flags stand, field writes revert. Same call as the tie out. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function varianceIdOf(periodStart: string, accountNumber: string): Ulid {
  return derivedId(`${periodStart}:${accountNumber}`, "rpt-flag-variances", 0);
}

/**
 * The accounts a variance report covers, account number ascending.
 *
 * The union of the chart accounts that had activity in the period and the
 * accounts that carry a budget. A budgeted account with no activity is the
 * interesting case and would be missing if the list came from the ledger alone.
 */
export function evaluatedAccounts(data: ReportData): string[] {
  const seen = new Set<string>();
  for (const account of data.close.chart) {
    if (!isVarianceAccount(account.accountNumber)) continue;
    if (balanceOf(data.close.inPeriod, account.accountNumber) !== ZERO) {
      seen.add(account.accountNumber);
    }
  }
  for (const budget of data.budgets) {
    if (!isVarianceAccount(budget.accountNumber)) continue;
    seen.add(budget.accountNumber);
  }
  return [...seen].sort();
}

/**
 * One comparison.
 *
 * Variance is actual less budget in the ledger sign convention, so the figure
 * can be read straight against the ledger without knowing which way anybody
 * flipped it. Whether that variance reads as favorable is a separate question
 * and is answered from the account block.
 */
export function varianceContentFor(
  data: ReportData,
  accountNumber: string,
): VarianceContent {
  const actual = balanceOf(data.close.inPeriod, accountNumber);
  const budgetRow = data.budgets.find((b) => b.accountNumber === accountNumber);
  const budget = budgetRow === undefined ? ZERO : budgetRow.budgetCents;
  const variance = actual - budget;
  const bp = varianceBpOf(variance, budget);
  const threshold = resolveThreshold(data.thresholds, accountNumber);
  const overFloor = absCents(variance) >= threshold.floorCents;

  let flagged = false;
  let flagCode: VarianceContent["flagCode"] = "within_threshold";
  let detail = "";
  if (budget === ZERO) {
    // No budget and no activity is nothing to report. No budget with activity is
    // unbudgeted, and there is no percentage to state about it.
    if (actual !== ZERO && overFloor) {
      flagged = true;
      flagCode = "unbudgeted_activity";
      detail = `no budget row for ${accountNumber} and activity of ${actual.toString()} cents`;
    } else {
      detail =
        actual === ZERO
          ? `no budget and no activity for ${accountNumber}`
          : `no budget for ${accountNumber} and activity below the floor`;
    }
  } else if (bp !== null && Math.abs(bp) >= threshold.thresholdBp && overFloor) {
    flagged = true;
    flagCode = "over_threshold";
    detail = `variance of ${bp} basis points against a threshold of ${threshold.thresholdBp}`;
  } else if (bp !== null && Math.abs(bp) >= threshold.thresholdBp) {
    detail = `variance of ${bp} basis points is over the percentage but under the ${threshold.floorCents.toString()} cent floor`;
  } else {
    detail = `variance of ${bp ?? 0} basis points is inside the threshold of ${threshold.thresholdBp}`;
  }

  return {
    accountNumber,
    accountName: accountNameOf(data, accountNumber),
    actualCents: actual,
    budgetCents: budget,
    varianceCents: variance,
    varianceBp: bp,
    direction: varianceDirection(accountNumber, variance),
    flagged,
    flagCode,
    floorCents: threshold.floorCents,
    thresholdBp: threshold.thresholdBp,
    detail,
  };
}

function insertVariance(
  frozen: FrozenScope<FlagVariancesScope>,
  data: ReportData,
  rowId: Ulid,
  content: VarianceContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "report_variances",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      ...content,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}
