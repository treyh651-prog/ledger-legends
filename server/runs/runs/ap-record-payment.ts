/**
 * AP-RECORD-PAYMENT. Put the subledger record of a bill payment on the books.
 *
 * The payable mirror of AR-RECORD-PAYMENT, for the same gap: migration 0057's
 * own comment on subledger.vendor_payments states the precondition AR-RECORD-
 * PAYMENT already established -- a payment arrives on the register coded to
 * the payable clearing account -- and nothing in the original run set ever
 * created that row on the payable side. AP-APPLY-DISCOUNTS only ever settles
 * a bill carrying discount terms, and always closes the whole balance at
 * once; an ordinary bill payment had no modeled write path at all.
 *
 * This run posts nothing. The cash already posted when the withdrawal itself
 * was coded to the clearing account, the same two-leg shape every coded
 * transaction already posts. What this run adds is the subledger wrapper
 * AP-APPLY-PAYMENTS reads: which vendor the cash belongs to, and which
 * register row it came from.
 *
 * The transaction supplies its own amount and date rather than taking them as
 * separate inputs, so the payment can never disagree with the cash that
 * actually left. A withdrawal is negative in the register (doc 04, money out
 * of the account), so the stored amount is the negated transaction amount --
 * vendor_payments.amount_cents is a positive magnitude, the same convention
 * customer_payments already uses for a deposit.
 *
 * Idempotency. The payment id is derived from the transaction id alone, never
 * from the vendor, so a second call naming the same transaction is reported
 * rather than creating a second payment against the same cash.
 *
 * Manual tier: naming which vendor a withdrawal belongs to is a decision a
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
import type { VendorPaymentRow } from "../tables";

export const apRecordPaymentScopeSchema = z.object({
  clientId: z.string().min(1),
  vendorId: z.string().min(1),
  /** The register row the cash left on. Required: see the file comment. */
  transactionId: z.string().min(1),
  /** One bill number, named up front rather than left to tier 4. */
  matchHint: z.string().nullable().default(null),
  onHold: z.boolean().default(false),
});

export type ApRecordPaymentScope = z.infer<typeof apRecordPaymentScopeSchema>;

export function vendorPaymentIdFor(clientId: Ulid, transactionId: Ulid): Ulid {
  return derivedId(`${clientId}:${transactionId}`, "ap-record-payment", 0);
}

export const apRecordPayment: Run<ApRecordPaymentScope, Proposal> = {
  type: "AP-RECORD-PAYMENT",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:ap-record-payment:${scope.transactionId}`,
  scopeSchema: apRecordPaymentScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ApRecordPaymentScope>> {
    const tx = requireTx(ctx);
    const paymentId = vendorPaymentIdFor(scope.clientId, scope.transactionId);
    const payments = await tx.query("vendor_payments_for_client", {
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
      { id: "AP-RECORD-PAYMENT", version: 1 },
      ...payments.map((p) => ({ id: p.id, version: p.version })),
      ...transactions.map((t) => ({ id: t.id, version: t.version })),
    ];
    const runDay = ctx.now.toISOString().slice(0, 10);
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      // Recording which vendor a withdrawal belongs to has no period of its
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
    const paymentId = vendorPaymentIdFor(frozen.clientId, scope.transactionId);
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const refuse = (code: string, message: string): RunResult<Proposal> => {
      errors.push({ rowId: paymentId, code, message, retryable: false });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    };

    const payments = await tx.query("vendor_payments_for_client", {
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
    if (transaction.amountCents >= BigInt(0)) {
      return refuse("TRANSACTION_NOT_A_WITHDRAWAL", `transaction ${scope.transactionId} is not money out, amountCents ${transaction.amountCents.toString()}`);
    }
    if (transaction.categoryId === null) {
      return refuse("TRANSACTION_NOT_CODED", `transaction ${scope.transactionId} has not been coded to a clearing account yet`);
    }

    const vendors = await tx.query("vendors_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const vendor = vendors.find((v) => v.id === scope.vendorId);
    if (!vendor) {
      return refuse("UNKNOWN_VENDOR", `vendor ${scope.vendorId} does not belong to client ${frozen.clientId}`);
    }

    const accounts = await tx.query("chart_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (!accounts.some((a) => a.accountNumber === transaction.categoryId)) {
      return refuse("ACCOUNT_NOT_ON_CHART", `clearing account ${transaction.categoryId} is not on the client's chart`);
    }

    const row: VendorPaymentRow = {
      id: paymentId,
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      vendorId: scope.vendorId,
      paymentDate: transaction.postedDate,
      amountCents: -transaction.amountCents,
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
      table: "vendor_payments",
      rowId: paymentId,
      row: row as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [proposal], skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "AP-RECORD-PAYMENT",
      runVersion: 1,
    });
  },

  /**
   * No undo, same reasoning as AR-RECORD-PAYMENT: a payment already applied to
   * a bill cannot be quietly un-created, and one with nothing applied is
   * harmless to leave.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
