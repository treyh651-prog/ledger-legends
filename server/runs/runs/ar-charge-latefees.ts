/**
 * AR-CHARGE-LATEFEES. Prepare late fee invoices under the customer's own terms.
 *
 * Spec: docs/02-run-specifications.md Module 5 AR-CHARGE-LATEFEES.
 *
 * A late fee is a term of an agreement between the client and the client's
 * customer. It is not something a bookkeeping run decides to impose. So the run
 * charges nothing unless the customer record says fees are enabled, and it
 * computes the fee from the rate stored on that customer rather than from any
 * firm default. A customer with fees enabled and no rate is a data problem and
 * is reported as one, not filled in with a guess.
 *
 * The run prepares a fee invoice. It posts no journal entry. Doc 02 is explicit
 * that this run proposes and never posts, and a fee invoice sitting in draft is
 * exactly the artifact a person needs in order to decide whether to issue it. A
 * fee that has been reviewed and issued becomes revenue through the ordinary
 * invoicing path, not through this run.
 *
 * Double charging is the failure mode that matters here, and it is prevented by
 * arithmetic rather than by a flag. Every fee invoice records the parent invoice
 * and how many thirty day blocks it charged. A second execution sums the blocks
 * already charged against that parent and charges only the difference. Running
 * the same period twice charges nothing the second time. Running it a month
 * later charges exactly one more block.
 *
 * Nothing here computes interest for tax purposes, asserts that a fee is
 * lawful, or produces a notice. Whether a given rate is enforceable is a
 * question for the client's own advisor.
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
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { CustomerRow, InvoiceRow } from "../tables";
import { periodWindow } from "./per-shared";
import {
  ageDaysFor,
  basisDateOf,
  clampFee,
  feeBlocksPastGrace,
  graceFor,
  invoiceIsOpen,
  invoiceOpen,
  lateFeeFromFlat,
  lateFeeFromRate,
  resolvePolicy,
  ZERO,
  type ArapPolicy,
} from "./arap-shared";

export const LATE_FEE_ERROR_CODES = {
  missingRate: "AR_LATEFEE_RATE_MISSING",
} as const;

export const chargeLateFeesScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type ChargeLateFeesScope = z.infer<typeof chargeLateFeesScopeSchema>;

export const arChargeLateFees: Run<ChargeLateFeesScope, Proposal> = {
  type: "AR-CHARGE-LATEFEES",
  version: 1,
  // No entry is posted. The run produces a document for a person to decide on.
  writesLedger: false,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) =>
    `${scope.clientId}:latefees:${scope.period.slice(0, 7)}`,
  scopeSchema: chargeLateFeesScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ChargeLateFeesScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const invoices = await tx.query("invoices_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const customers = await tx.query("customers_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });

    // Only real invoices are candidates. A fee invoice is not itself subject to
    // a fee, because compounding a fee on a fee is a decision nobody made.
    const chargeable = invoices.filter((i) => !i.isLateFee);
    const candidateIds = chargeable.map((i) => i.id);
    const versions = [
      { id: "AR-CHARGE-LATEFEES", version: 1 },
      ...chargeable.map((i) => ({ id: i.id, version: i.version })),
      ...customers.map((c) => ({ id: c.id, version: c.version })),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // The period is in the hash. The same invoices at the same versions are a
      // different fee run in a different month, and without the period the
      // second month would key to the first and be deduplicated away.
      scopeHash: scopeHashFor({
        period: window.periodEnd,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: [
        ...invoices.filter((i) => i.manualOverride).map((i) => i.id),
        ...customers.filter((c) => c.manualOverride).map((c) => c.id),
      ],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const asOf = window.periodEnd;
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const policy = resolvePolicy(
      await tx.query("arap_policy", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
      }),
    );
    const customers = await tx.query("customers_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const invoices = await tx.query("invoices_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    const customerById = new Map<string, CustomerRow>(
      customers.map((c) => [c.id, c]),
    );
    // Blocks already charged against each parent invoice, summed over every fee
    // invoice that references it. This is what stops a rerun from doubling.
    const chargedBlocks = new Map<string, number>();
    const feeCountByParent = new Map<string, number>();
    for (const fee of invoices) {
      if (!fee.isLateFee || fee.parentInvoiceId === null) continue;
      if (fee.status === "void") continue;
      chargedBlocks.set(
        fee.parentInvoiceId,
        (chargedBlocks.get(fee.parentInvoiceId) ?? 0) + (fee.feeMonths ?? 0),
      );
      feeCountByParent.set(
        fee.parentInvoiceId,
        (feeCountByParent.get(fee.parentInvoiceId) ?? 0) + 1,
      );
    }

    const locked = isLockedDay(locks, asOf);

    for (const inv of invoices) {
      if (inv.isLateFee) continue;
      if (inv.manualOverride) {
        skips.push({
          rowId: inv.id,
          reason: "manual_override",
          detail: `invoice ${inv.invoiceNumber} carries manual_override`,
        });
        continue;
      }
      const customer = customerById.get(inv.customerId);
      if (customer === undefined) {
        skips.push({
          rowId: inv.id,
          reason: "missing_prerequisite",
          detail: `customer_missing for invoice ${inv.invoiceNumber}`,
        });
        continue;
      }
      if (customer.manualOverride) {
        skips.push({
          rowId: inv.id,
          reason: "manual_override",
          detail: `customer ${customer.name} carries manual_override`,
        });
        continue;
      }
      // The gate the task states plainly: only if enabled at the customer.
      if (!customer.lateFeeEnabled || customer.lateFeeExempt) {
        skips.push({
          rowId: inv.id,
          reason: "missing_prerequisite",
          detail: `late_fee_not_enabled for ${customer.name}`,
        });
        continue;
      }
      // A customer on a payment plan is already keeping to an arrangement the
      // client agreed to, and charging a late fee against that arrangement
      // would contradict it.
      if (customer.paymentPlanActive) {
        skips.push({
          rowId: inv.id,
          reason: "missing_prerequisite",
          detail: `payment_plan_active for ${customer.name}`,
        });
        continue;
      }
      if (inv.inDispute) {
        skips.push({
          rowId: inv.id,
          reason: "missing_prerequisite",
          detail: `invoice_in_dispute, ${inv.invoiceNumber} is under discussion`,
        });
        continue;
      }
      if (!invoiceIsOpen(inv)) {
        skips.push({
          rowId: inv.id,
          reason: "already_applied",
          detail: `invoice_closed, ${inv.invoiceNumber} owes nothing`,
        });
        continue;
      }

      const grace = graceFor(policy, customer);
      const age = ageDaysFor(
        basisDateOf(policy, inv.invoiceDate, inv.dueDate),
        asOf,
      );
      const blocks = feeBlocksPastGrace(age, grace);
      if (blocks <= 0) {
        skips.push({
          rowId: inv.id,
          reason: "missing_prerequisite",
          detail: `within_grace_window, ${inv.invoiceNumber} is ${age} days past due against a grace of ${grace}`,
        });
        continue;
      }

      const already = chargedBlocks.get(inv.id) ?? 0;
      const owedBlocks = blocks - already;
      if (owedBlocks <= 0) {
        skips.push({
          rowId: inv.id,
          reason: "already_applied",
          detail: `fee_already_charged, ${already} of ${blocks} blocks already billed on ${inv.invoiceNumber}`,
        });
        continue;
      }

      const base = invoiceOpen(inv);
      const feeResult = feeFor(policy, customer, base, owedBlocks);
      if ("code" in feeResult) {
        errors.push({
          rowId: inv.id,
          code: feeResult.code,
          message: feeResult.message,
          retryable: false,
        });
        continue;
      }
      if (feeResult.cents <= ZERO) {
        skips.push({
          rowId: inv.id,
          reason: "missing_prerequisite",
          detail: `fee_below_minimum on ${inv.invoiceNumber}`,
        });
        continue;
      }
      if (locked) {
        skips.push({
          rowId: inv.id,
          reason: "locked_period",
          detail: `fee date ${asOf} falls inside a locked period`,
        });
        continue;
      }

      const ordinal = feeCountByParent.get(inv.id) ?? 0;
      const feeId = derivedId(
        `${inv.id}:${asOf}`,
        "ar-charge-latefees",
        ordinal,
      );
      proposals.push({
        kind: "row_insert",
        table: "invoices",
        rowId: feeId,
        row: {
          firmId: frozen.firmId,
          clientId: frozen.clientId,
          version: 1,
          customerId: inv.customerId,
          invoiceNumber: `${inv.invoiceNumber}-LF${ordinal + 1}`,
          invoiceDate: asOf,
          dueDate: asOf,
          originalAmountCents: feeResult.cents,
          // A late fee carries no sales tax. Whether a fee is taxable depends
          // on the jurisdiction and on the nature of the charge, and this run
          // does not answer tax questions.
          taxCents: ZERO,
          appliedPaymentsCents: ZERO,
          appliedCreditsCents: ZERO,
          writtenOffCents: ZERO,
          // Draft, not posted. A person decides whether to issue it.
          status: "draft",
          inDispute: false,
          collectionAttempts: 0,
          parentInvoiceId: inv.id,
          isLateFee: true,
          feeMonths: owedBlocks,
          writeoffApproved: false,
          arAccount: inv.arAccount,
          revenueAccount:
            policy.accounts.lateFeeRevenue ?? inv.revenueAccount,
          manualOverride: false,
        },
        provenance: { cascadeLevel: null },
      });
      chargedBlocks.set(inv.id, already + owedBlocks);
      feeCountByParent.set(inv.id, ordinal + 1);
    }

    return makeResult<Proposal>(
      frozen.candidateIds.length,
      proposals,
      skips,
      errors,
      // No entry is posted, so the run moves nothing on the ledger.
      ZERO,
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "AR-CHARGE-LATEFEES",
      runVersion: 1,
    });
  },

  /**
   * A fee invoice that was prepared and then reconsidered is voided by a person
   * rather than deleted by the engine, because the customer may already have
   * seen it. Undo therefore withdraws no rows.
   */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

interface FeeFailure {
  code: string;
  message: string;
}

/**
 * The fee for one invoice for a stated number of thirty day blocks.
 *
 * A flat fee takes precedence when one is set, because a client who wrote a
 * fixed charge into an agreement meant that number and not a rate. Otherwise
 * the annualized rate applies, converted with integer arithmetic and rounded
 * once at the end.
 */
function feeFor(
  policy: ArapPolicy,
  customer: CustomerRow,
  base: Cents,
  blocks: number,
): { cents: Cents } | FeeFailure {
  if (customer.flatFeeCents !== null && customer.flatFeeCents > ZERO) {
    return { cents: clampFee(policy, lateFeeFromFlat(customer.flatFeeCents, blocks)) };
  }
  if (customer.annualizedRateBp === null || customer.annualizedRateBp <= 0) {
    return {
      code: LATE_FEE_ERROR_CODES.missingRate,
      message: `customer ${customer.id} has late fees enabled and no rate, so no fee can be computed`,
    };
  }
  return {
    cents: clampFee(
      policy,
      lateFeeFromRate(base, customer.annualizedRateBp, blocks),
    ),
  };
}

/** Exported so the pipeline test can assert the fee arithmetic directly. */
export function feeForInvoice(
  policy: ArapPolicy,
  customer: CustomerRow,
  invoice: InvoiceRow,
  asOf: string,
): Cents {
  const grace = graceFor(policy, customer);
  const age = ageDaysFor(
    basisDateOf(policy, invoice.invoiceDate, invoice.dueDate),
    asOf,
  );
  const blocks = feeBlocksPastGrace(age, grace);
  const result = feeFor(policy, customer, invoiceOpen(invoice), blocks);
  return "code" in result ? ZERO : result.cents;
}
