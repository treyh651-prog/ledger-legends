/**
 * CFG-CREATE-BUDGET-THRESHOLD, version 1.
 *
 * Audit fix, 2026-11-06 (problem 7, one of seven missing setup-data
 * creators -- the other half of the audit's "budgets/thresholds"). A
 * threshold row (report.budget_thresholds) decides what counts as a real
 * variance -- a null account number is the client's own default, a stated
 * account number overrides it for that one line -- but apply-writer.ts had
 * no insert case for the table, so RPT-FLAG-VARIANCES has always run
 * against zero thresholds, which, per its own reader, means the client
 * default from CFG-CREATE-BUDGET-LINES's sibling run file simply never
 * applies.
 *
 * One row per (client, account-or-default), unlike CFG-CREATE-BUDGET-LINES'
 * bulk shape: a threshold is a standing policy a firm sets occasionally,
 * not a period-by-period data entry task.
 *
 * accountNumber is checked against the client's real chart when given;
 * the default row (accountNumber null) needs no such check.
 *
 * Manual tier: deciding what counts as a real variance is a judgment a
 * person makes.
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
import { applyProposals, NOW_PLACEHOLDER, requireTx } from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";

export const newBudgetThresholdFieldsSchema = z.object({
  accountNumber: z.string().regex(/^[0-9]{4}$/).nullable().default(null),
  varianceFloorCents: z.number().int().nonnegative().safe(),
  varianceThresholdBp: z.number().int().nonnegative(),
  note: z.string().min(1),
});

export const createBudgetThresholdScopeSchema = z.object({
  clientId: z.string().min(1),
  fields: newBudgetThresholdFieldsSchema,
});

export type CreateBudgetThresholdScope = z.infer<typeof createBudgetThresholdScopeSchema>;

export const ERR_BUDGET_THRESHOLD_UNKNOWN_ACCOUNT = "CFG-BUDGET-THRESHOLD-UNKNOWN-ACCOUNT";

export function budgetThresholdIdFor(clientId: string, accountNumber: string | null): string {
  return derivedId(`${clientId}:${accountNumber ?? "DEFAULT"}`, "cfg-create-budget-threshold", 0);
}

export const cfgCreateBudgetThreshold: Run<CreateBudgetThresholdScope, Proposal> = {
  type: "CFG-CREATE-BUDGET-THRESHOLD",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:budget-threshold:${budgetThresholdIdFor(scope.clientId, scope.fields.accountNumber)}`,
  scopeSchema: createBudgetThresholdScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateBudgetThresholdScope>> {
    const candidateIds = [budgetThresholdIdFor(scope.clientId, scope.fields.accountNumber)];
    const versions = [{ id: "CFG-CREATE-BUDGET-THRESHOLD", version: 1 }];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const id = budgetThresholdIdFor(scope.clientId, scope.fields.accountNumber);

    const existing = await tx.query("budget_thresholds_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    if (existing.some((t) => t.id === id)) {
      return makeResult<Proposal>(
        1,
        [],
        [{
          rowId: id,
          reason: "already_applied",
          detail: scope.fields.accountNumber === null
            ? "this client already has a default budget threshold"
            : `account ${scope.fields.accountNumber} already has a budget threshold`,
        }],
        [],
        BigInt(0),
      );
    }

    if (scope.fields.accountNumber !== null) {
      const chart = await tx.query("chart_accounts_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
      if (!chart.some((a) => a.accountNumber === scope.fields.accountNumber)) {
        errors.push({
          rowId: id,
          code: ERR_BUDGET_THRESHOLD_UNKNOWN_ACCOUNT,
          message: `account ${scope.fields.accountNumber} is not on client ${scope.clientId}'s chart`,
          retryable: false,
        });
        return makeResult<Proposal>(1, [], [], errors, BigInt(0));
      }
    }

    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "budget_thresholds",
      rowId: id,
      row: {
        firmId: ctx.firmId,
        clientId: scope.clientId,
        version: 1,
        accountNumber: scope.fields.accountNumber,
        varianceFloorCents: BigInt(scope.fields.varianceFloorCents),
        varianceThresholdBp: scope.fields.varianceThresholdBp,
        note: scope.fields.note,
        createdAt: NOW_PLACEHOLDER,
        manualOverride: false,
      },
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [insert], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-BUDGET-THRESHOLD", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
