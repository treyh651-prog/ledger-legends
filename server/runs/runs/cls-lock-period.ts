/**
 * CLOSE-LOCK-PERIOD. Lock a period once every gate holds.
 *
 * Spec: docs/02-run-specifications.md Module 6 CLS-LOCK-PERIOD, doc 00 Part 5
 * for what locking means and for closing with exceptions.
 *
 * The run has one precondition and it is not negotiable: the gate result set for
 * the period exists, covers all nineteen gates, and every one of them is pass or
 * not applicable. A failing gate refuses the run rather than skipping it, because
 * a lock is a claim that the period is finished and there is no partial version
 * of that claim. An overridden gate counts as satisfied only when a person wrote
 * a reason, which doc 00 Part 5 requires and which the lock then carries as
 * closed with exceptions.
 *
 * The gate set also has to be newer than the last ledger write. A journal row in
 * this schema carries no created at column, so the run compares the ledger
 * fingerprint stored on the gate results to the fingerprint of the ledger as it
 * stands now, and refuses when they differ. See NOTES.md entry 88 for the four
 * options considered.
 *
 * Locking an already locked period is a no op, not an error. A close pipeline
 * that runs twice should end in the same place both times.
 */

import { z } from "zod";
import {
  isFieldWrite,
  isRowInsert,
  makeResult,
  type FrozenScope,
  type Proposal,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import {
  ACTOR_PLACEHOLDER,
  applyProposals,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  requireTx,
} from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type {
  GateSnapshotEntry,
  TrialBalanceEntry,
} from "../tables";
import { periodWindow } from "./per-shared";
import { ZERO, centsText, loadCloseData } from "./close-shared";
import { CLOSE_GATES } from "./cls-evaluate-gates";

export const LOCK_ERROR_CODES = {
  gatesMissing: "CLOSE_GATE_SET_INCOMPLETE",
  gatesFailed: "CLOSE_GATES_FAILED",
  gatesStale: "CLOSE_GATE_SET_STALE",
  overrideWithoutReason: "CLOSE_GATE_OVERRIDE_WITHOUT_REASON",
} as const;

export const lockPeriodScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type LockPeriodScope = z.infer<typeof lockPeriodScopeSchema>;

export const clsLockPeriod: Run<LockPeriodScope, Proposal> = {
  type: "CLOSE-LOCK-PERIOD",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:lock:${scope.period.slice(0, 7)}`,
  scopeSchema: lockPeriodScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<LockPeriodScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const gates = await tx.query("close_gate_results_for_period", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      periodStart: window.periodStart,
    });
    const data = await loadCloseData(tx, ctx.firmId, scope.clientId, scope.period);
    const candidateIds = [lockId(scope.clientId, window.periodStart)];
    const versions = [
      { id: "CLOSE-LOCK-PERIOD", version: 1 },
      ...gates.map((g) => ({ id: g.gateCode, version: g.version })),
    ];
    // Same reasoning as the gate evaluator. A lock is a claim about a whole
    // ledger, so the fingerprint of that ledger belongs in the discriminator.
    // See NOTES.md entry 93.
    const discriminator = `${window.periodStart}:${data.fingerprint}`;
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({
        period: discriminator,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: gates.filter((g) => g.manualOverride).map((g) => g.id),
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
    const rowId = lockId(frozen.clientId, data.periodStart);

    // An existing lock ends the run before anything is examined. Reevaluating a
    // closed period here would invite a second lock row for the same period.
    const already = data.locks.find(
      (l) => l.periodStart === data.periodStart && l.status === "locked",
    );
    if (already !== undefined) {
      skips.push({
        rowId: already.id,
        reason: "already_applied",
        detail: `period ${data.periodStart} was locked at ${already.lockedAt}`,
      });
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        proposals,
        skips,
        errors,
        ZERO,
      );
    }

    const gates = await tx.query("close_gate_results_for_period", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      periodStart: data.periodStart,
    });
    const byCode = new Map(gates.map((g) => [g.gateCode, g]));
    let exceptions = 0;
    const exceptionNotes: string[] = [];

    for (const gate of CLOSE_GATES) {
      const result = byCode.get(gate.code);
      if (result === undefined) {
        errors.push({
          rowId: null,
          code: LOCK_ERROR_CODES.gatesMissing,
          message: `${gate.code} has no evaluated result for ${data.periodStart}, so the gate set is incomplete`,
          retryable: false,
        });
        continue;
      }
      if (result.ledgerFingerprint !== data.fingerprint) {
        errors.push({
          rowId: result.id,
          code: LOCK_ERROR_CODES.gatesStale,
          message: `${gate.code} was evaluated against a different ledger than the one being locked, so the gates must run again`,
          retryable: true,
        });
        continue;
      }
      if (result.outcome === "pass" || result.outcome === "not_applicable") {
        continue;
      }
      if (result.manualOverride) {
        if (result.overrideReason === null || result.overrideReason.trim() === "") {
          errors.push({
            rowId: result.id,
            code: LOCK_ERROR_CODES.overrideWithoutReason,
            message: `${gate.code} is overridden with no written reason, which doc 00 Part 5 does not allow`,
            retryable: false,
          });
          continue;
        }
        exceptions += 1;
        exceptionNotes.push(`${gate.code}: ${result.overrideReason}`);
        continue;
      }
      errors.push({
        rowId: result.id,
        code: LOCK_ERROR_CODES.gatesFailed,
        message: `${gate.code} failed with ${result.blockingCount} blocking rows, so the period cannot be locked`,
        retryable: false,
      });
    }

    if (errors.length > 0) {
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        [],
        skips,
        errors,
        ZERO,
      );
    }

    const gateSnapshot: GateSnapshotEntry[] = CLOSE_GATES.map((gate) => {
      const result = byCode.get(gate.code);
      return {
        gateCode: gate.code,
        outcome: result === undefined ? "fail" : result.outcome,
        blockingCount: result === undefined ? 0 : result.blockingCount,
      };
    });
    const trialBalance: TrialBalanceEntry[] = [...data.through.entries()]
      .map(([accountNumber, balance]) => ({
        accountNumber,
        balanceCents: centsText(balance) ?? "0",
      }))
      .sort((a, b) => (a.accountNumber < b.accountNumber ? -1 : 1));

    proposals.push({
      kind: "row_insert",
      table: "period_locks",
      rowId,
      row: {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        lockedAt: NOW_PLACEHOLDER,
        lockedBy: ACTOR_PLACEHOLDER,
        closedWithExceptions: exceptions > 0,
        exceptionNote: exceptions === 0 ? null : exceptionNotes.join("; "),
        unlockedAt: null,
        unlockedBy: null,
        unlockReason: null,
        status: "locked",
        gateResultsSnapshot: gateSnapshot,
        trialBalanceSnapshot: trialBalance,
        ledgerFingerprint: data.fingerprint,
        lockedByRunId: RUN_ID_PLACEHOLDER,
      },
      provenance: { cascadeLevel: null },
    });

    // The period row is the thing a person opens and closes, so its status moves
    // with the lock. A client that has no period row yet gets one, because a lock
    // without a period would leave the status question unanswerable.
    const period = data.periods.find((p) => p.periodStart === data.periodStart);
    if (period === undefined) {
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
          fiscalYearStart: fiscalYearStartOf(data.periodStart, fiscalEndMonth(data)),
          fiscalYearEnd: fiscalYearEndOf(data.periodStart, fiscalEndMonth(data)),
          status: "locked",
          openedByRunId: null,
          openedAt: null,
          lockedByRunId: RUN_ID_PLACEHOLDER,
          lockedAt: NOW_PLACEHOLDER,
          rolledFromPeriodStart: null,
          manualOverride: false,
        },
        provenance: { cascadeLevel: null },
      });
    } else if (period.manualOverride) {
      skips.push({
        rowId: period.id,
        reason: "manual_override",
        detail: `period row ${period.id} carries manual_override, so its status was left alone`,
      });
    } else if (period.status !== "locked") {
      proposals.push({
        kind: "field_write",
        table: "close_periods",
        rowId: period.id,
        before: {
          status: period.status,
          lockedAt: period.lockedAt,
          lockedByRunId: period.lockedByRunId,
        },
        after: {
          status: "locked",
          lockedAt: NOW_PLACEHOLDER,
          lockedByRunId: RUN_ID_PLACEHOLDER,
        },
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
      runType: "CLOSE-LOCK-PERIOD",
      runVersion: 1,
    });
  },

  /**
   * Unlocking is a decision with a named person and a written reason behind it,
   * per doc 00 Part 5, so undo reverts the period status it moved and leaves the
   * lock row standing. A lock that could be deleted by a run would make the close
   * history unreliable, and the close history is the reason the lock exists.
   */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
      if (isRowInsert(p)) continue;
    }
    return plan;
  },
};

export function lockId(clientId: Ulid, periodStart: string): Ulid {
  return derivedId(`${clientId}:${periodStart}`, "cls-lock-period", 0);
}

export function periodId(clientId: Ulid, periodStart: string): Ulid {
  return derivedId(`${clientId}:${periodStart}`, "cls-period", 0);
}

function fiscalEndMonth(data: { policy: { fiscalYearEndMonth: number } | null }): number {
  return data.policy === null ? 12 : data.policy.fiscalYearEndMonth;
}

/** The first day of the fiscal year a day falls in. */
export function fiscalYearStartOf(day: string, endMonth: number): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const startMonth = (endMonth % 12) + 1;
  const startYear = month >= startMonth ? year : year - 1;
  return `${String(startYear).padStart(4, "0")}-${String(startMonth).padStart(2, "0")}-01`;
}

/** The last day of the fiscal year a day falls in. */
export function fiscalYearEndOf(day: string, endMonth: number): string {
  const start = fiscalYearStartOf(day, endMonth);
  const startYear = Number(start.slice(0, 4));
  const endYear = endMonth === 12 ? startYear : startYear + 1;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return `${String(endYear).padStart(4, "0")}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}
