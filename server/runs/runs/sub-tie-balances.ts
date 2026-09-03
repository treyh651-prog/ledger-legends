/**
 * SUB-TIEOUT-ACCOUNTS. Compare every substantiated balance sheet account to the
 * thing outside the ledger that is supposed to support it.
 *
 * Spec: docs/02-run-specifications.md Module 6 SUB-TIE-BALANCES. The file name
 * follows the task brief and the run type follows the closed union in
 * contract.ts, which already named this run SUB-TIEOUT-ACCOUNTS. See NOTES.md
 * entry 82.
 *
 * A balance is not a fact because the ledger says so. It is a fact when a
 * statement, an aging, a schedule, a roll forward, or a count says the same
 * thing. This run states that comparison for every account and refuses to leave
 * a gap: an account whose support is missing is written as unsupported rather
 * than left out of the report, because the account nobody produced a row for is
 * the account that carries the error.
 *
 * The run posts nothing. It never proposes a journal entry, so it is safe on a
 * locked period and the lock is not consulted at all. Idempotency is by content
 * against the row derived from the period and the account number: the first
 * execution inserts, a later execution rewrites only the fields that moved, and
 * an execution that finds nothing moved reports already applied.
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
import type { SubTieoutRow, TieoutSourceKind } from "../tables";
import { periodWindow } from "./per-shared";
import {
  ZERO,
  balanceOf,
  isBalanceSheet,
  loadCloseData,
  normalSideOf,
  tieSourceFor,
} from "./close-shared";

export const tieBalancesScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type TieBalancesScope = z.infer<typeof tieBalancesScopeSchema>;

/** The comparable content of one tie out row. */
interface TieoutContent {
  accountNumber: string;
  accountName: string;
  sourceKind: TieoutSourceKind;
  sourceRef: string | null;
  ledgerBalanceCents: Cents;
  supportedBalanceCents: Cents | null;
  varianceCents: Cents | null;
  tied: boolean;
  wrongSideNoReason: boolean;
  state: "computed_tied" | "unsupported" | "variance_open";
  detail: string;
}

export const subTieBalances: Run<TieBalancesScope, Proposal> = {
  type: "SUB-TIEOUT-ACCOUNTS",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:tieout:${scope.period.slice(0, 7)}`,
  scopeSchema: tieBalancesScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<TieBalancesScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadCloseData(tx, ctx.firmId, scope.clientId, scope.period);
    const accounts = data.chart.filter((a) => isBalanceSheet(a.accountNumber));
    const candidateIds = accounts.map((a) => a.id);
    const versions = [
      { id: "SUB-TIEOUT-ACCOUNTS", version: 1 },
      ...data.loans.map((l) => ({ id: l.id, version: l.version })),
      ...data.deferrals.map((d) => ({ id: d.id, version: d.version })),
      ...data.assets.map((a) => ({ id: a.id, version: a.version })),
      ...data.recBatches.map((b) => ({ id: b.id, version: b.version })),
      ...data.substantiation.map((r) => ({ id: r.id, version: r.version })),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // The period is in the hash because a tie out is a statement about one
      // period end, and the same chart tied on two dates is two reports.
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: data.tieouts.filter((t) => t.manualOverride).map((t) => t.id),
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
    const priorById = new Map<string, SubTieoutRow>(
      data.tieouts.map((t) => [t.id, t]),
    );

    for (const account of data.chart) {
      if (!isBalanceSheet(account.accountNumber)) continue;
      const source = tieSourceFor(data, account);
      const ledger = balanceOf(data.through, account.accountNumber);
      const supported = source.supportedCents;
      const variance = supported === null ? null : ledger - supported;
      const tied = variance !== null && variance === ZERO;
      const state: TieoutContent["state"] =
        supported === null ? "unsupported" : tied ? "computed_tied" : "variance_open";
      const content: TieoutContent = {
        accountNumber: account.accountNumber,
        accountName: account.name,
        sourceKind: source.sourceKind,
        sourceRef: source.sourceRef,
        ledgerBalanceCents: ledger,
        supportedBalanceCents: supported,
        varianceCents: variance,
        tied,
        wrongSideNoReason: onWrongSide(account.accountNumber, ledger),
        state,
        detail: source.detail,
      };
      const rowId = tieoutId(data.periodStart, account.accountNumber);
      const prior = priorById.get(rowId);
      if (prior === undefined) {
        proposals.push(insertTieout(frozen, data.periodStart, data.periodEnd, rowId, content));
        continue;
      }
      if (prior.manualOverride) {
        skips.push({
          rowId: account.id,
          reason: "manual_override",
          detail: `tie out row for ${account.accountNumber} carries manual_override`,
        });
        continue;
      }
      const changed = changedFields(prior, content);
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId: account.id,
          reason: "already_applied",
          detail: `tieout_unchanged for ${account.accountNumber} at ${data.periodEnd}`,
        });
        continue;
      }
      proposals.push({
        kind: "field_write",
        table: "sub_tieouts",
        rowId,
        before: changed.before,
        after: changed.after,
        // A tie out is not a coding decision, so it claims no cascade level, on
        // the same reasoning the reconciliation and aging writes use.
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
      runType: "SUB-TIEOUT-ACCOUNTS",
      runVersion: 1,
    });
  },

  /**
   * The comparison happened, and a person may already have read it. The inserted
   * rows stand and only the field writes revert, exactly as the aging refresh
   * decided for the same reason.
   */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function tieoutId(periodStart: string, accountNumber: string): Ulid {
  return derivedId(`${periodStart}:${accountNumber}`, "sub-tie-balances", 0);
}

/**
 * A balance sitting on the side its block does not belong on. Zero is never on
 * the wrong side. This is the input to gate G15 in the doc 00 numbering and it
 * is computed here rather than in the gate, because the gate should read a fact
 * the substantiation run already stated.
 */
function onWrongSide(accountNumber: string, balance: Cents): boolean {
  if (balance === ZERO) return false;
  return normalSideOf(accountNumber) === "debit" ? balance < ZERO : balance > ZERO;
}

function insertTieout(
  frozen: FrozenScope<TieBalancesScope>,
  periodStart: string,
  periodEnd: string,
  rowId: Ulid,
  content: TieoutContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "sub_tieouts",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      periodStart,
      periodEnd,
      ...content,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

function changedFields(
  prior: SubTieoutRow,
  next: TieoutContent,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const keys = Object.keys(next) as (keyof TieoutContent)[];
  for (const k of keys) {
    const priorValue = (prior as unknown as Record<string, unknown>)[k];
    if (priorValue !== next[k]) {
      before[k] = priorValue;
      after[k] = next[k];
    }
  }
  return { before, after };
}
