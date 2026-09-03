/**
 * AR-APPLY-PAYMENTS. Apply received customer payments to open invoices.
 *
 * Spec: docs/02-run-specifications.md Module 5 AR-APPLY-PAYMENTS.
 *
 * The cash has already arrived and it is already on the register, coded to the
 * receivable clearing account. Nothing in this run moves money. What it does is
 * decide which invoices the cash pays, and then move the amount out of the
 * clearing account and into the receivable control account so that the
 * subledger and the ledger say the same thing.
 *
 * Four tiers, in order, and the first one that answers wins.
 *
 *   1. Structured remittance advice. The payer said which invoices, so the run
 *      does not guess. A multi invoice remittance is the normal case here, and
 *      the sum of the named lines has to agree with the payment within one cent
 *      for each invoice named.
 *   2. A match hint naming one invoice.
 *   3. A unique combination of two or three open invoices that sums to the
 *      payment. Unique is the whole condition: two combinations that both fit
 *      mean the run does not know, and a guess that lands on the wrong invoice
 *      produces a false aging and a statement a client will dispute.
 *   4. Oldest first, which is the default when nothing above identified the
 *      invoices.
 *
 * The tolerance is one cent for each invoice named, and it exists for a
 * practical reason: a payer who rounds each line of a five line remittance can
 * be five cents out in total, and leaving real cash unapplied over an amount
 * smaller than the cost of asking about it serves nobody. The tolerance is
 * never applied to what gets posted. The posting is the actual cash.
 *
 * An overpayment stays unapplied. The run does not invent a credit memo, does
 * not refund anything, and does not push cash onto an invoice that does not owe
 * it. The remainder sits in the clearing account where a person can see it.
 */

import { z } from "zod";
import {
  isFieldWrite,
  isJournalEntry,
  makeResult,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedJournalEntry,
  type ProposedLine,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import { applyProposals, RUN_ID_PLACEHOLDER, requireTx } from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { reverseEntry, revertFieldWrite } from "../undo";
import type {
  CustomerPaymentRow,
  InvoiceRow,
  RemittanceLineRow,
} from "../tables";
import { periodWindow } from "./per-shared";
import {
  combinationsSummingTo,
  invoiceIsOpen,
  invoiceOpen,
  oldestFirst,
  remittanceTolerance,
  resolvePolicy,
  ZERO,
  type ArapPolicy,
} from "./arap-shared";

export const applyPaymentsScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type ApplyPaymentsScope = z.infer<typeof applyPaymentsScopeSchema>;

/** One decision about one payment. */
interface Allocation {
  invoiceId: Ulid;
  invoiceNumber: string;
  amountCents: Cents;
}

interface Resolution {
  tier: number;
  allocations: Allocation[];
}

interface Refusal {
  reason: "ambiguous_candidate" | "missing_prerequisite";
  detail: string;
}

export const arApplyPayments: Run<ApplyPaymentsScope, Proposal> = {
  type: "AR-APPLY-PAYMENTS",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) =>
    `${scope.clientId}:arapply:${scope.period.slice(0, 7)}`,
  scopeSchema: applyPaymentsScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ApplyPaymentsScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const payments = await tx.query("customer_payments_in_window", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      from: window.periodStart,
      to: window.periodEnd,
    });
    const invoices = await tx.query("invoices_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });

    const candidateIds = payments.map((p) => p.id);
    const versions = [
      { id: "AR-APPLY-PAYMENTS", version: 1 },
      ...payments.map((p) => ({ id: p.id, version: p.version })),
      // An invoice that moved changes which invoices a payment should pay, so
      // the invoice versions belong in the hash even though they are not
      // candidates.
      ...invoices.map((i) => ({ id: i.id, version: i.version })),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: [
        ...payments.filter((p) => p.manualOverride).map((p) => p.id),
        ...invoices.filter((i) => i.manualOverride).map((i) => i.id),
      ],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
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
    const payments = await tx.query("customer_payments_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: window.periodStart,
      to: window.periodEnd,
    });
    const priorApplications = await tx.query(
      "payment_applications_for_client",
      { firmId: frozen.firmId, clientId: frozen.clientId },
    );
    const remittance =
      payments.length === 0
        ? []
        : await tx.query("remittance_lines_for_payments", {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            paymentIds: payments.map((p) => p.id),
          });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    const overriddenCustomers = new Set(
      customers.filter((c) => c.manualOverride).map((c) => c.id),
    );
    const appliedPaymentIds = new Set(
      priorApplications
        .filter((a) => a.state !== "reversed")
        .map((a) => a.paymentId),
    );
    const invoiceById = new Map(invoices.map((i) => [i.id, i]));
    // Remaining open balance per invoice, carried across payments so that two
    // payments in one execution cannot both consume the same open amount.
    const remainingOpen = new Map<string, Cents>();
    for (const inv of invoices) {
      if (invoiceIsOpen(inv) && !inv.manualOverride) {
        remainingOpen.set(inv.id, invoiceOpen(inv));
      }
    }
    const invoicePatched = new Map<string, Cents>();
    let net: Cents = ZERO;

    for (const payment of payments) {
      if (payment.manualOverride) {
        skips.push({
          rowId: payment.id,
          reason: "manual_override",
          detail: `payment ${payment.id} carries manual_override`,
        });
        continue;
      }
      if (payment.status === "void") {
        skips.push({
          rowId: payment.id,
          reason: "missing_prerequisite",
          detail: `payment_void for ${payment.id}`,
        });
        continue;
      }
      if (payment.onHold) {
        skips.push({
          rowId: payment.id,
          reason: "missing_prerequisite",
          detail: `payment_on_hold for ${payment.id}`,
        });
        continue;
      }
      if (payment.status === "applied" || appliedPaymentIds.has(payment.id)) {
        skips.push({
          rowId: payment.id,
          reason: "already_applied",
          detail: `payment_already_applied for ${payment.id}`,
        });
        continue;
      }
      if (overriddenCustomers.has(payment.customerId)) {
        skips.push({
          rowId: payment.id,
          reason: "manual_override",
          detail: `customer ${payment.customerId} carries manual_override`,
        });
        continue;
      }
      if (isLockedDay(locks, payment.paymentDate)) {
        skips.push({
          rowId: payment.id,
          reason: "locked_period",
          detail: `payment date ${payment.paymentDate} falls inside a locked period`,
        });
        continue;
      }

      const remaining = payment.amountCents - payment.appliedCents;
      if (remaining <= ZERO) {
        skips.push({
          rowId: payment.id,
          reason: "already_applied",
          detail: `nothing_left_to_apply on ${payment.id}`,
        });
        continue;
      }

      const open = openFor(
        invoices,
        payment.customerId,
        remainingOpen,
      );
      if (open.length === 0) {
        skips.push({
          rowId: payment.id,
          reason: "missing_prerequisite",
          detail: `no_open_invoices for customer ${payment.customerId}`,
        });
        continue;
      }

      const resolved = resolvePayment(
        policy,
        payment,
        open,
        remainingOpen,
        remittance.filter((r) => r.paymentId === payment.id),
        remaining,
      );
      if ("reason" in resolved) {
        skips.push({
          rowId: payment.id,
          reason: resolved.reason,
          detail: resolved.detail,
        });
        continue;
      }

      const total = resolved.allocations.reduce(
        (sum, a) => sum + a.amountCents,
        ZERO,
      );
      if (total <= ZERO) {
        skips.push({
          rowId: payment.id,
          reason: "missing_prerequisite",
          detail: `nothing_to_apply for ${payment.id}`,
        });
        continue;
      }

      const entry = entryFor(policy, payment, resolved.allocations);
      proposals.push(entry);
      for (const l of entry.lines) net += l.amountCents;

      resolved.allocations.forEach((alloc, index) => {
        const inv = invoiceById.get(alloc.invoiceId) as InvoiceRow;
        const priorPatch = invoicePatched.get(inv.id) ?? ZERO;
        const beforeApplied = inv.appliedPaymentsCents + priorPatch;
        const afterApplied = beforeApplied + alloc.amountCents;
        const stillOpen =
          inv.originalAmountCents -
          afterApplied -
          inv.appliedCreditsCents -
          inv.writtenOffCents;
        invoicePatched.set(inv.id, priorPatch + alloc.amountCents);
        remainingOpen.set(
          inv.id,
          (remainingOpen.get(inv.id) ?? ZERO) - alloc.amountCents,
        );

        proposals.push({
          kind: "field_write",
          table: "invoices",
          rowId: inv.id,
          before: {
            appliedPaymentsCents: beforeApplied,
            status: inv.status,
          },
          after: {
            appliedPaymentsCents: afterApplied,
            status: stillOpen <= ZERO ? "paid" : inv.status,
          },
          // Applying cash to an invoice is not a coding decision, so it claims
          // no cascade level, on the same reasoning as the reconciliation
          // writes.
          provenance: { cascadeLevel: null },
        });

        proposals.push({
          kind: "row_insert",
          table: "payment_applications",
          rowId: derivedId(
            `${payment.id}:${inv.id}`,
            "ar-apply-payments",
            index + 1,
          ),
          row: {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            version: 1,
            paymentId: payment.id,
            invoiceId: inv.id,
            appliedCents: alloc.amountCents,
            applicationDate: payment.paymentDate,
            tier: resolved.tier,
            state: "applied",
            postedEntryId: entry.targetId,
            createdByRunId: RUN_ID_PLACEHOLDER,
            manualOverride: false,
          },
          provenance: { cascadeLevel: null },
        });
      });

      const appliedAfter = payment.appliedCents + total;
      proposals.push({
        kind: "field_write",
        table: "customer_payments",
        rowId: payment.id,
        before: {
          appliedCents: payment.appliedCents,
          status: payment.status,
          appliedTier: payment.appliedTier,
        },
        after: {
          appliedCents: appliedAfter,
          status:
            appliedAfter >= payment.amountCents ? "applied" : "partially_applied",
          appliedTier: resolved.tier,
        },
        provenance: { cascadeLevel: null },
      });
    }

    return makeResult<Proposal>(
      frozen.candidateIds.length,
      proposals,
      skips,
      errors,
      net,
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "AR-APPLY-PAYMENTS",
      runVersion: 1,
    });
  },

  /**
   * The entry reverses and the balances revert. The application rows stay, in
   * the state the reversal leaves them: a record that the run applied the cash
   * and that the application was undone is more useful than a gap.
   */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isJournalEntry(p) && p.targetId !== null) {
        plan.push(reverseEntry(p, p.targetId));
      } else if (isFieldWrite(p)) {
        plan.push(revertFieldWrite(p));
      }
    }
    return plan;
  },
};

/** The open invoices of one customer, in oldest first order. */
function openFor(
  invoices: readonly InvoiceRow[],
  customerId: Ulid,
  remainingOpen: Map<string, Cents>,
): InvoiceRow[] {
  return invoices.filter(
    (i) =>
      i.customerId === customerId &&
      (remainingOpen.get(i.id) ?? ZERO) > ZERO &&
      !i.manualOverride,
  );
}

/**
 * The four tiers, in order. Each tier either answers or declines, and a decline
 * falls through to the next one. Only tier 3 can refuse outright, because an
 * ambiguous combination is the one case where continuing would mean guessing.
 */
function resolvePayment(
  policy: ArapPolicy,
  payment: CustomerPaymentRow,
  open: readonly InvoiceRow[],
  remainingOpen: Map<string, Cents>,
  advice: readonly RemittanceLineRow[],
  remaining: Cents,
): Resolution | Refusal {
  const byNumber = new Map(open.map((i) => [i.invoiceNumber, i]));
  const openOf = (inv: InvoiceRow): Cents => remainingOpen.get(inv.id) ?? ZERO;

  // Tier 1. The payer named the invoices.
  if (advice.length > 0) {
    const allocations: Allocation[] = [];
    let stated = ZERO;
    for (const line of advice) {
      const inv = byNumber.get(line.invoiceNumber);
      if (inv === undefined) {
        return {
          reason: "ambiguous_candidate",
          detail: `remittance_invoice_unknown, payment ${payment.id} names ${line.invoiceNumber} which is not open`,
        };
      }
      stated += line.amountCents;
      const take = line.amountCents < openOf(inv) ? line.amountCents : openOf(inv);
      if (take > ZERO) {
        allocations.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amountCents: take,
        });
      }
    }
    const tolerance = remittanceTolerance(advice.length);
    const gap = stated - remaining;
    const absGap = gap < ZERO ? -gap : gap;
    if (absGap > tolerance) {
      return {
        reason: "ambiguous_candidate",
        detail: `remittance_sum_mismatch, advice states ${stated.toString()} against a payment of ${remaining.toString()} with a tolerance of ${tolerance.toString()}`,
      };
    }
    return { tier: 1, allocations: capTo(allocations, remaining) };
  }

  // Tier 2. A hint naming one invoice.
  if (payment.matchHint !== null) {
    const inv = byNumber.get(payment.matchHint);
    if (inv === undefined) {
      return {
        reason: "ambiguous_candidate",
        detail: `match_hint_unknown, payment ${payment.id} points at ${payment.matchHint} which is not open`,
      };
    }
    const take = remaining < openOf(inv) ? remaining : openOf(inv);
    return {
      tier: 2,
      allocations: [
        {
          invoiceId: inv.id,
          invoiceNumber: inv.invoiceNumber,
          amountCents: take,
        },
      ],
    };
  }

  // Tier 3. A unique combination of up to three invoices.
  const ordered = oldestFirst(open, policy);
  const amounts = ordered.map((i) => openOf(i));
  const tolerance = remittanceTolerance(1);
  const hits = combinationsSummingTo(amounts, remaining, tolerance);
  if (hits.length === 1) {
    const chosen = hits[0];
    return {
      tier: 3,
      allocations: capTo(
        chosen.map((index) => ({
          invoiceId: ordered[index].id,
          invoiceNumber: ordered[index].invoiceNumber,
          amountCents: amounts[index],
        })),
        remaining,
      ),
    };
  }
  if (hits.length > 1) {
    return {
      reason: "ambiguous_candidate",
      detail: `combination_not_unique, ${hits.length} combinations of open invoices sum to ${remaining.toString()}`,
    };
  }

  // Tier 4. Oldest first, which is the stated default.
  const allocations: Allocation[] = [];
  let left = remaining;
  for (const inv of ordered) {
    if (left <= ZERO) break;
    const take = left < openOf(inv) ? left : openOf(inv);
    if (take <= ZERO) continue;
    allocations.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      amountCents: take,
    });
    left -= take;
  }
  return { tier: 4, allocations };
}

/**
 * Never allocate more than the payment. The tolerance exists so that a
 * remittance a few cents out is still usable, and this is where it stops: what
 * posts is the cash that arrived, not what the advice claimed.
 */
function capTo(allocations: Allocation[], remaining: Cents): Allocation[] {
  const out: Allocation[] = [];
  let left = remaining;
  for (const a of allocations) {
    if (left <= ZERO) break;
    const take = a.amountCents < left ? a.amountCents : left;
    if (take <= ZERO) continue;
    out.push({ ...a, amountCents: take });
    left -= take;
  }
  return out;
}

/**
 * One entry per payment. The clearing account is relieved once and the control
 * account is credited once for each invoice, so the entry itself shows which
 * invoices the cash went to.
 */
function entryFor(
  policy: ArapPolicy,
  payment: CustomerPaymentRow,
  allocations: readonly Allocation[],
): ProposedJournalEntry {
  const total = allocations.reduce((sum, a) => sum + a.amountCents, ZERO);
  const lines: ProposedLine[] = [
    {
      accountNumber: payment.clearingAccount || policy.accounts.arClearing,
      categoryId: null,
      amountCents: total,
      memo: `Apply payment ${payment.id}`,
      dimensions: {},
    },
  ];
  for (const a of allocations) {
    lines.push({
      accountNumber: policy.accounts.arControl,
      categoryId: null,
      amountCents: -a.amountCents,
      memo: `Applied to invoice ${a.invoiceNumber}`,
      dimensions: {},
    });
  }
  return {
    kind: "journal_entry",
    targetId: derivedId(payment.id, "ar-apply-payments", 0),
    entryDate: payment.paymentDate,
    lines,
    sourceRef: {
      table: "customer_payments",
      rowId: payment.id,
      version: payment.version,
    },
  };
}
