/**
 * CFG-CREATE-ARAP-POLICY, version 1.
 *
 * Audit fix, 2026-11-06 (problem 7, one of seven missing setup-data
 * creators -- the audit's own "AR/AP policies, late fee terms etc.").
 * subledger.arap_policies has carried its full module 5 shape since
 * migration 0014, and AR-CHARGE-LATEFEES/AR-BUILD-STATEMENTS/
 * AR-REFRESH-AGING/AR-WRITEOFF-UNCOLLECTIBLE/AP-APPLY-EARLYDISCOUNT have
 * always been able to read a policy row that exists -- but apply-writer.ts
 * had no insert case for the table at all, and every one of those run's own
 * tests seeds the row directly rather than through any run, the exact tell
 * the action audit's methodology section describes. A real firm had no way
 * to ever set a late fee term, a write off threshold, or which clearing
 * account AR/AP payments land on; every client ran on the hardcoded doc 02
 * module 5 defaults forever, with no path to override even one of them.
 *
 * One row per client (migration 0014's own comment: "absent means every
 * default in doc 02 module 5 applies"). The threshold and behavior fields
 * default to exactly those documented defaults, the same values every
 * existing test fixture seeds, so a firm only has to state what it wants
 * to override. The four control/clearing accounts have no sensible
 * default -- they are the client's own chart -- and are required.
 *
 * A second create for a client that already has a policy is a no-op:
 * there is no edit path in this pass (same "don't retrofit edit, just
 * don't inherit the gap" reasoning every other CFG-CREATE-* run in this
 * file gives), so changing an existing policy is left for later.
 *
 * Manual tier: setting a firm's late fee terms and write off thresholds is
 * a judgment a person makes once.
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

export const newArapPolicyFieldsSchema = z.object({
  agingBasis: z.enum(["due_date", "invoice_date"]).default("due_date"),
  minimumStatementBalanceCents: z.number().int().nonnegative().safe().default(0),
  statementType: z.enum(["open_item", "balance_forward"]).default("open_item"),
  messageNeutral: z.string().nullable().default(null),
  messageReminder: z.string().nullable().default(null),
  messageFirm: z.string().nullable().default(null),
  messageFinal: z.string().nullable().default(null),
  graceDays: z.number().int().nonnegative().default(10),
  lateFeeMinimumCents: z.number().int().nonnegative().safe().default(0),
  lateFeeMaximumCents: z.number().int().nonnegative().safe().nullable().default(null),
  suppressBelowMinimumFee: z.boolean().default(true),
  writeoffAgeDays: z.number().int().nonnegative().default(180),
  writeoffMinimumCents: z.number().int().nonnegative().safe().default(100),
  requiredAttempts: z.number().int().nonnegative().default(3),
  writeoffMethod: z.enum(["allowance", "direct"]).default("direct"),
  approvalTier1Cents: z.number().int().nonnegative().safe().default(100000),
  discountBaseExcludesFreightTax: z.boolean().default(true),
  arControlAccount: z.string().regex(/^[0-9]{4}$/),
  arClearingAccount: z.string().regex(/^[0-9]{4}$/),
  allowanceAccount: z.string().regex(/^[0-9]{4}$/).nullable().default(null),
  badDebtAccount: z.string().regex(/^[0-9]{4}$/).nullable().default(null),
  salesTaxAccount: z.string().regex(/^[0-9]{4}$/).nullable().default(null),
  lateFeeRevenueAccount: z.string().regex(/^[0-9]{4}$/).nullable().default(null),
  apControlAccount: z.string().regex(/^[0-9]{4}$/),
  apClearingAccount: z.string().regex(/^[0-9]{4}$/),
  purchaseDiscountAccount: z.string().regex(/^[0-9]{4}$/).nullable().default(null),
  vendorCreditAccount: z.string().regex(/^[0-9]{4}$/).nullable().default(null),
});

export const createArapPolicyScopeSchema = z.object({
  clientId: z.string().min(1),
  fields: newArapPolicyFieldsSchema,
});

export type CreateArapPolicyScope = z.infer<typeof createArapPolicyScopeSchema>;

export const ERR_ARAP_POLICY_UNKNOWN_ACCOUNT = "CFG-ARAP-POLICY-UNKNOWN-ACCOUNT";

export function arapPolicyIdFor(clientId: string): string {
  return derivedId(clientId, "cfg-create-arap-policy", 0);
}

export const cfgCreateArapPolicy: Run<CreateArapPolicyScope, Proposal> = {
  type: "CFG-CREATE-ARAP-POLICY",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:arap-policy`,
  scopeSchema: createArapPolicyScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateArapPolicyScope>> {
    const candidateIds = [arapPolicyIdFor(scope.clientId)];
    const versions = [{ id: "CFG-CREATE-ARAP-POLICY", version: 1 }];
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
    const id = arapPolicyIdFor(scope.clientId);

    const existing = await tx.query("arap_policy", { firmId: ctx.firmId, clientId: scope.clientId });
    if (existing.length > 0) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: id, reason: "already_applied", detail: "this client already has an AR/AP policy" }],
        [],
        BigInt(0),
      );
    }

    const chart = await tx.query("chart_accounts_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const knownNumbers = new Set(chart.map((a) => a.accountNumber));
    const accountsToCheck: Array<[string, string | null]> = [
      ["AR control", scope.fields.arControlAccount],
      ["AR clearing", scope.fields.arClearingAccount],
      ["AP control", scope.fields.apControlAccount],
      ["AP clearing", scope.fields.apClearingAccount],
      ["allowance", scope.fields.allowanceAccount],
      ["bad debt", scope.fields.badDebtAccount],
      ["sales tax", scope.fields.salesTaxAccount],
      ["late fee revenue", scope.fields.lateFeeRevenueAccount],
      ["purchase discount", scope.fields.purchaseDiscountAccount],
      ["vendor credit", scope.fields.vendorCreditAccount],
    ];
    for (const [label, number] of accountsToCheck) {
      if (number !== null && !knownNumbers.has(number)) {
        errors.push({
          rowId: id,
          code: ERR_ARAP_POLICY_UNKNOWN_ACCOUNT,
          message: `${label} account ${number} is not on client ${scope.clientId}'s chart`,
          retryable: false,
        });
      }
    }
    if (errors.length > 0) return makeResult<Proposal>(1, [], [], errors, BigInt(0));

    const row: Record<string, unknown> = {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      version: 1,
      agingBasis: scope.fields.agingBasis,
      minimumStatementBalanceCents: BigInt(scope.fields.minimumStatementBalanceCents),
      statementType: scope.fields.statementType,
      messageNeutral: scope.fields.messageNeutral,
      messageReminder: scope.fields.messageReminder,
      messageFirm: scope.fields.messageFirm,
      messageFinal: scope.fields.messageFinal,
      graceDays: scope.fields.graceDays,
      lateFeeMinimumCents: BigInt(scope.fields.lateFeeMinimumCents),
      lateFeeMaximumCents: scope.fields.lateFeeMaximumCents === null ? null : BigInt(scope.fields.lateFeeMaximumCents),
      suppressBelowMinimumFee: scope.fields.suppressBelowMinimumFee,
      writeoffAgeDays: scope.fields.writeoffAgeDays,
      writeoffMinimumCents: BigInt(scope.fields.writeoffMinimumCents),
      requiredAttempts: scope.fields.requiredAttempts,
      writeoffMethod: scope.fields.writeoffMethod,
      approvalTier1Cents: BigInt(scope.fields.approvalTier1Cents),
      discountBaseExcludesFreightTax: scope.fields.discountBaseExcludesFreightTax,
      arControlAccount: scope.fields.arControlAccount,
      arClearingAccount: scope.fields.arClearingAccount,
      allowanceAccount: scope.fields.allowanceAccount,
      badDebtAccount: scope.fields.badDebtAccount,
      salesTaxAccount: scope.fields.salesTaxAccount,
      lateFeeRevenueAccount: scope.fields.lateFeeRevenueAccount,
      apControlAccount: scope.fields.apControlAccount,
      apClearingAccount: scope.fields.apClearingAccount,
      purchaseDiscountAccount: scope.fields.purchaseDiscountAccount,
      vendorCreditAccount: scope.fields.vendorCreditAccount,
      manualOverride: false,
    };

    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "arap_policies",
      rowId: id,
      row,
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [insert], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-ARAP-POLICY", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
