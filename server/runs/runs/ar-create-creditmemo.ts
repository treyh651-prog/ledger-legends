/**
 * AR-CREATE-CREDITMEMO. Credit a customer's balance and post the reversal.
 *
 * Not one of doc 02's documented module 5 runs, for the same reason
 * AR-CREATE-INVOICE is not: nothing in the original run set, and nothing in
 * apply-writer's insert table, ever created a credit memo. The gap ran one
 * layer deeper than the others this session found: subledger.credit_memos
 * (migration 0014) carried no GL account columns at all, unlike invoices'
 * ar_account/revenue_account pair or bills' ap_account/expense_account pair,
 * so there was nowhere on the row to say what the offsetting entry touched.
 * Migration 0042 added the identical pair before this run could exist.
 *
 * The entry is AR-CREATE-INVOICE's entry with every sign reversed. Credit
 * the receivable control account for the full memo amount, debit revenue
 * for the amount net of tax, and debit the sales tax payable account for
 * the tax portion when there is one -- the same three lines, crediting a
 * sale rather than billing one.
 *
 * Idempotency. subledger.credit_memos carries no unique constraint on
 * memo_number, unlike bills and invoices (migration 0014 never added one),
 * so the guarantee here is app level only: the deterministic id this run
 * derives from (client, memoNumber) is what a repeat call collides on.
 *
 * Manual tier: crediting a customer's balance is the decision itself, the
 * same reasoning AR-CREATE-INVOICE gives for billing one.
 */

import { z } from "zod";
import {
  makeResult,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedJournalEntry,
  type ProposedLine,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import { ACTOR_PLACEHOLDER, applyProposals, requireTx } from "../apply-writer";
import { isIsoDay, isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import type { CreditMemoRow } from "../tables";
import { resolvePolicy } from "./arap-shared";

const centsString = z.string().regex(/^[0-9]+$/);

export const createCreditMemoScopeSchema = z.object({
  clientId: z.string().min(1),
  customerId: z.string().min(1),
  memoNumber: z.string().min(1),
  memoDate: z.string().min(10),
  /** The full credited amount, tax included. Never negative. */
  amountCents: centsString,
  /** The portion of amountCents that is sales tax. Defaults to none. */
  taxCents: centsString.default("0"),
  revenueAccount: z.string().regex(/^[0-9]{4}$/),
});

export type CreateCreditMemoScope = z.infer<typeof createCreditMemoScopeSchema>;

export function creditMemoIdFor(clientId: Ulid, memoNumber: string): Ulid {
  return derivedId(`${clientId}:${memoNumber}`, "ar-create-creditmemo", 0);
}

export const arCreateCreditMemo: Run<CreateCreditMemoScope, Proposal> = {
  type: "AR-CREATE-CREDITMEMO",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:ar-create-creditmemo:${scope.memoNumber}`,
  scopeSchema: createCreditMemoScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateCreditMemoScope>> {
    const tx = requireTx(ctx);
    const memoId = creditMemoIdFor(scope.clientId, scope.memoNumber);
    const memos = await tx.query("credit_memos_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const candidateIds = [memoId];
    const versions = [
      { id: "AR-CREATE-CREDITMEMO", version: 1 },
      ...memos.map((m) => ({ id: m.id, version: m.version })),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: scope.memoDate,
      periodEnd: scope.memoDate,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: memos.filter((m) => m.manualOverride).map((m) => m.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const memoId = creditMemoIdFor(frozen.clientId, scope.memoNumber);
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const refuse = (code: string, message: string): RunResult<Proposal> => {
      errors.push({ rowId: memoId, code, message, retryable: false });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    };

    if (!isIsoDay(scope.memoDate)) {
      return refuse("MEMO_DATE_NOT_A_DAY", `memoDate ${scope.memoDate} must be an ISO day`);
    }

    const amount = BigInt(scope.amountCents);
    const tax = BigInt(scope.taxCents);
    if (amount <= BigInt(0)) {
      return refuse("MEMO_AMOUNT_NOT_POSITIVE", `amountCents ${scope.amountCents} must be greater than zero`);
    }
    if (tax < BigInt(0) || tax > amount) {
      return refuse("TAX_OUTSIDE_AMOUNT", `taxCents ${scope.taxCents} must be between 0 and amountCents ${scope.amountCents}`);
    }

    const memos = await tx.query("credit_memos_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (memos.some((m) => m.memoNumber === scope.memoNumber)) {
      skips.push({
        rowId: memoId,
        reason: "already_applied",
        detail: `memo number ${scope.memoNumber} already exists for this client`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const customers = await tx.query("customers_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const customer = customers.find((c) => c.id === scope.customerId);
    if (!customer) {
      return refuse("UNKNOWN_CUSTOMER", `customer ${scope.customerId} does not belong to client ${frozen.clientId}`);
    }

    const accounts = await tx.query("chart_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (!accounts.some((a) => a.accountNumber === scope.revenueAccount)) {
      return refuse("ACCOUNT_NOT_ON_CHART", `revenue account ${scope.revenueAccount} is not on the client's chart`);
    }

    const policyRows = await tx.query("arap_policy", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const policy = resolvePolicy(policyRows);
    if (!accounts.some((a) => a.accountNumber === policy.accounts.arControl)) {
      return refuse("ACCOUNT_NOT_ON_CHART", `receivable control account ${policy.accounts.arControl} is not on the client's chart`);
    }
    if (tax > BigInt(0)) {
      if (policy.accounts.salesTax === null) {
        return refuse("MISSING_SALES_TAX_ACCOUNT", "taxCents is greater than zero but no sales tax account is configured for this client");
      }
      if (!accounts.some((a) => a.accountNumber === policy.accounts.salesTax)) {
        return refuse("ACCOUNT_NOT_ON_CHART", `sales tax account ${policy.accounts.salesTax} is not on the client's chart`);
      }
    }

    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (isLockedDay(locks, scope.memoDate)) {
      skips.push({
        rowId: memoId,
        reason: "locked_period",
        detail: `memo date ${scope.memoDate} falls inside a locked period`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const netRevenue = amount - tax;
    const lines: ProposedLine[] = [
      {
        accountNumber: policy.accounts.arControl,
        categoryId: null,
        amountCents: -amount,
        memo: `Credit memo ${scope.memoNumber}`,
        dimensions: {},
      },
    ];
    if (netRevenue > BigInt(0)) {
      lines.push({
        accountNumber: scope.revenueAccount,
        categoryId: null,
        amountCents: netRevenue,
        memo: `Credit memo ${scope.memoNumber}`,
        dimensions: {},
      });
    }
    if (tax > BigInt(0) && policy.accounts.salesTax !== null) {
      lines.push({
        accountNumber: policy.accounts.salesTax,
        categoryId: null,
        amountCents: tax,
        memo: `Sales tax reversed by credit memo ${scope.memoNumber}`,
        dimensions: {},
      });
    }

    const entry: ProposedJournalEntry = {
      kind: "journal_entry",
      targetId: memoId,
      entryDate: scope.memoDate,
      lines,
      sourceRef: { table: "credit_memos", rowId: memoId, version: 1 },
    };

    const row: CreditMemoRow = {
      id: memoId,
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      customerId: scope.customerId,
      memoNumber: scope.memoNumber,
      memoDate: scope.memoDate,
      amountCents: amount,
      appliedCents: BigInt(0),
      status: "open",
      manualOverride: false,
      arAccount: policy.accounts.arControl,
      revenueAccount: scope.revenueAccount,
      createdBy: ACTOR_PLACEHOLDER,
    };
    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "credit_memos",
      rowId: memoId,
      row: row as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };

    const net: Cents = lines.reduce((sum, l) => sum + l.amountCents, BigInt(0));
    return makeResult<Proposal>(1, [entry, insert], skips, errors, net);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "AR-CREATE-CREDITMEMO",
      runVersion: 1,
    });
  },

  /**
   * No undo plan. A credit memo that has been applied to an invoice cannot
   * be quietly un-posted; a mistake is corrected with a void, a person's
   * decision this run version does not implement.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
