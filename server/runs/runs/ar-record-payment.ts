/**
 * AR-RECORD-PAYMENT. Put the subledger record of a received customer payment
 * on the books.
 *
 * Not one of doc 02's documented module 5 runs, for the same reason
 * AR-CREATE-CUSTOMER and AR-CREATE-INVOICE are not: migration 0014's own
 * comment on subledger.customer_payments states the precondition plainly --
 * "a payment arrives on the register coded to the receivable clearing
 * account" -- and nothing in the original run set, and nothing in
 * apply-writer's insert table, ever created that row. AR-APPLY-PAYMENTS could
 * never apply a payment that did not exist.
 *
 * This run posts nothing. The cash already posted when the transaction itself
 * was coded to the clearing account, the same way any other coded transaction
 * posts (doc 04's transactions.account_number and transactions.category_id are
 * the two legs; no separate journal entry exists for the common case). What
 * this run adds is the subledger wrapper AR-APPLY-PAYMENTS reads: which
 * customer the cash belongs to, and which register row it came from.
 *
 * The transaction supplies its own amount and date rather than taking them as
 * separate inputs, so the payment can never disagree with the cash that
 * actually arrived.
 *
 * Idempotency. The payment id is derived from the transaction id alone, never
 * from the customer, so a second call naming the same transaction is reported
 * rather than creating a second payment against the same cash regardless of
 * what customer it names.
 *
 * Manual tier: naming which customer a deposit belongs to is a decision a
 * person makes once, on purpose, and a clock cannot discover it.
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
  type Skip,
  type Ulid,
} from "../contract";
import { ACTOR_PLACEHOLDER, applyProposals, requireTx } from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";
import type { CustomerPaymentRow } from "../tables";

export const recordPaymentScopeSchema = z.object({
  clientId: z.string().min(1),
  customerId: z.string().min(1),
  /** The register row the cash arrived on. Required: see the file comment. */
  transactionId: z.string().min(1),
  /** One invoice number, named up front rather than left to tier 4. */
  matchHint: z.string().nullable().default(null),
  onHold: z.boolean().default(false),
});

export type RecordPaymentScope = z.infer<typeof recordPaymentScopeSchema>;

export function paymentIdFor(clientId: Ulid, transactionId: Ulid): Ulid {
  return derivedId(`${clientId}:${transactionId}`, "ar-record-payment", 0);
}

export const arRecordPayment: Run<RecordPaymentScope, Proposal> = {
  type: "AR-RECORD-PAYMENT",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:ar-record-payment:${scope.transactionId}`,
  scopeSchema: recordPaymentScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<RecordPaymentScope>> {
    const tx = requireTx(ctx);
    const paymentId = paymentIdFor(scope.clientId, scope.transactionId);
    const payments = await tx.query("customer_payments_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const transactions = await tx.query("transactions_by_ids", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      ids: [scope.transactionId],
    });
    const candidateIds = [paymentId];
    const versions = [
      { id: "AR-RECORD-PAYMENT", version: 1 },
      ...payments.map((p) => ({ id: p.id, version: p.version })),
      ...transactions.map((t) => ({ id: t.id, version: t.version })),
    ];
    const runDay = ctx.now.toISOString().slice(0, 10);
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      // Recording which customer a deposit belongs to has no period of its
      // own; the transaction's own posted date already carries that.
      periodStart: runDay,
      periodEnd: runDay,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const paymentId = paymentIdFor(frozen.clientId, scope.transactionId);
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const refuse = (code: string, message: string): RunResult<Proposal> => {
      errors.push({ rowId: paymentId, code, message, retryable: false });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    };

    const payments = await tx.query("customer_payments_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (payments.some((p) => p.id === paymentId)) {
      skips.push({
        rowId: paymentId,
        reason: "already_applied",
        detail: `a payment already exists for transaction ${scope.transactionId}`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const transactions = await tx.query("transactions_by_ids", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      ids: [scope.transactionId],
    });
    const transaction = transactions.find((t) => t.id === scope.transactionId);
    if (!transaction) {
      return refuse("UNKNOWN_TRANSACTION", `transaction ${scope.transactionId} does not belong to client ${frozen.clientId}`);
    }
    if (transaction.amountCents <= BigInt(0)) {
      return refuse("TRANSACTION_NOT_A_DEPOSIT", `transaction ${scope.transactionId} is not money in, amountCents ${transaction.amountCents.toString()}`);
    }
    if (transaction.categoryId === null) {
      return refuse("TRANSACTION_NOT_CODED", `transaction ${scope.transactionId} has not been coded to a clearing account yet`);
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
    if (!accounts.some((a) => a.accountNumber === transaction.categoryId)) {
      return refuse("ACCOUNT_NOT_ON_CHART", `clearing account ${transaction.categoryId} is not on the client's chart`);
    }

    const row: CustomerPaymentRow = {
      id: paymentId,
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      customerId: scope.customerId,
      paymentDate: transaction.postedDate,
      amountCents: transaction.amountCents,
      appliedCents: BigInt(0),
      onHold: scope.onHold,
      matchHint: scope.matchHint,
      transactionId: scope.transactionId,
      clearingAccount: transaction.categoryId,
      status: "unapplied",
      appliedTier: null,
      manualOverride: false,
      createdBy: ACTOR_PLACEHOLDER,
    };

    const proposal: ProposedRowInsert = {
      kind: "row_insert",
      table: "customer_payments",
      rowId: paymentId,
      row: row as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [proposal], skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "AR-RECORD-PAYMENT",
      runVersion: 1,
    });
  },

  /**
   * No undo. A payment that has been applied to an invoice cannot be quietly
   * un-created, and one with nothing applied is harmless to leave; doc 03
   * Part 6's undo contract covers reverting a run's effects, not deleting a
   * subledger record of real cash.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
