/**
 * CFG-CREATE-BUDGET-LINES, version 1.
 *
 * Audit fix, 2026-11-06 (problem 7, one of seven missing setup-data
 * creators -- the audit's own "budgets"). report.budgets has carried its
 * full shape since reporting was built, and rpt-shared.ts's loadReportData
 * has always read whatever budgets_for_period finds -- but apply-writer.ts
 * had no insert case for the table, so RPT-FLAG-VARIANCES and every report
 * package's variance section have always had nothing to compare against,
 * on every client, regardless of whether the firm actually budgeted.
 *
 * Bulk, like SETUP-IMPORT-BALANCES's own lines: a budget is entered one
 * period at a time, every account at once, not one line at a time.
 *
 * accountNumber is checked against the client's real chart, the same
 * reasoning every other CFG-CREATE-* run in this file gives. The natural
 * key is the period plus the account plus the optional class/location/
 * program dimensions -- a line that already exists for that exact
 * combination is reported rather than silently duplicated.
 *
 * Manual tier: entering a budget is a judgment a person makes once per
 * period.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
} from "../contract";
import { applyProposals, NOW_PLACEHOLDER, requireTx } from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";

const newBudgetLineFieldsSchema = z.object({
  accountNumber: z.string().regex(/^[0-9]{4}$/),
  classId: z.string().min(1).nullable().default(null),
  locationId: z.string().min(1).nullable().default(null),
  programId: z.string().min(1).nullable().default(null),
  budgetCents: z.number().int().safe(),
});

export const createBudgetLinesScopeSchema = z.object({
  clientId: z.string().min(1),
  periodStart: z.string().min(10),
  periodEnd: z.string().min(10),
  lines: z.array(newBudgetLineFieldsSchema).min(1),
});

export type CreateBudgetLinesScope = z.infer<typeof createBudgetLinesScopeSchema>;

export const ERR_BUDGET_UNKNOWN_ACCOUNT = "CFG-BUDGET-UNKNOWN-ACCOUNT";

export function budgetLineIdFor(
  clientId: string,
  periodStart: string,
  line: z.infer<typeof newBudgetLineFieldsSchema>,
): string {
  return derivedId(
    `${clientId}:${periodStart}:${line.accountNumber}:${line.classId ?? ""}:${line.locationId ?? ""}:${line.programId ?? ""}`,
    "cfg-create-budget-lines",
    0,
  );
}

export const cfgCreateBudgetLines: Run<CreateBudgetLinesScope, Proposal> = {
  type: "CFG-CREATE-BUDGET-LINES",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:budget-lines:${scope.periodStart}`,
  scopeSchema: createBudgetLinesScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateBudgetLinesScope>> {
    const candidateIds = scope.lines.map((l) => budgetLineIdFor(scope.clientId, scope.periodStart, l));
    const versions = [{ id: "CFG-CREATE-BUDGET-LINES", version: 1 }];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: scope.periodStart,
      periodEnd: scope.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions, period: scope.periodStart }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const skips: Skip[] = [];
    const proposals: Proposal[] = [];

    const existing = await tx.query("budgets_for_period", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      periodStart: scope.periodStart,
    });
    const existingIds = new Set(existing.map((b) => b.id));

    const chart = await tx.query("chart_accounts_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const knownNumbers = new Set(chart.map((a) => a.accountNumber));

    for (const line of scope.lines) {
      const id = budgetLineIdFor(scope.clientId, scope.periodStart, line);
      if (existingIds.has(id)) {
        skips.push({
          rowId: id,
          reason: "already_applied",
          detail: `a budget line for account ${line.accountNumber} already exists for ${scope.periodStart}`,
        });
        continue;
      }
      if (!knownNumbers.has(line.accountNumber)) {
        errors.push({
          rowId: id,
          code: ERR_BUDGET_UNKNOWN_ACCOUNT,
          message: `account ${line.accountNumber} is not on client ${scope.clientId}'s chart`,
          retryable: false,
        });
        continue;
      }
      proposals.push({
        kind: "row_insert",
        table: "budgets",
        rowId: id,
        row: {
          firmId: ctx.firmId,
          clientId: scope.clientId,
          version: 1,
          periodStart: scope.periodStart,
          periodEnd: scope.periodEnd,
          accountNumber: line.accountNumber,
          classId: line.classId,
          locationId: line.locationId,
          programId: line.programId,
          budgetCents: BigInt(line.budgetCents),
          source: "entered",
          createdAt: NOW_PLACEHOLDER,
          manualOverride: false,
        },
        provenance: { cascadeLevel: null },
      });
    }

    if (errors.length > 0) return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    return makeResult<Proposal>(1, proposals, skips, [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-BUDGET-LINES", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
