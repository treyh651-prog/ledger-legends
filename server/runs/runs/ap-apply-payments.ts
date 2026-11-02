/**
 * AP-APPLY-PAYMENTS. Apply vendor payments to open bills.
 *
 * The payable mirror of AR-APPLY-PAYMENTS, same four tiers in the same order,
 * same reasoning throughout -- see that file's own header for the full
 * explanation of each tier and why the tolerance exists. The signs flip
 * because a payable is a liability: the entry debits AP control to relieve
 * each bill (an asset-side relief credits; a liability-side relief debits)
 * and credits the clearing account for the total, the mirror image of how
 * AR-APPLY-PAYMENTS debits clearing and credits AR control.
 *
 * The cash has already left and it is already on the register, coded to the
 * payable clearing account. Nothing in this run moves money twice. What it
 * does is decide which bills the cash paid, and then move the amount out of
 * the clearing account and into the payable control account so the subledger
 * and the ledger say the same thing.
 *
 * An overpayment stays unapplied, same as AR: no credit memo invented, no
 * refund, no cash pushed onto a bill that does not owe it.
 *
 * Doc 05 Part 4 (D3). The AP control line this run debits per bill is tagged
 * explicitly cash, dated the payment date, cashSourceLine pointing at the
 * bill's own expense line -- the same reasoning AR-APPLY-PAYMENTS gives for
 * its own control lines: a generic cash-basis inference can never resurface
 * an expense recognized earlier, at bill time, with no cash leg at all.
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
import type { BillRow, VendorPaymentRow, VendorRemittanceLineRow } from "../tables";
import { periodWindow } from "./per-shared";
import {
  billIsOpen,
  billOpen,
  combinationsSummingTo,
  oldestFirstBills,
  remittanceTolerance,
  resolvePolicy,
  ZERO,
  type ArapPolicy,
} from "./arap-shared";

export const applyApPaymentsScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type ApplyApPaymentsScope = z.infer<typeof applyApPaymentsScopeSchema>;

/** One decision about one payment. */
interface Allocation {
  billId: Ulid;
  billNumber: string;
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

export const apApplyPayments: Run<ApplyApPaymentsScope, Proposal> = {
  type: "AP-APPLY-PAYMENTS",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) =>
    `${scope.clientId}:apapply:${scope.period.slice(0, 7)}`,
  scopeSchema: applyApPaymentsScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ApplyApPaymentsScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const payments = await tx.query("vendor_payments_in_window", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      from: window.periodStart,
      to: window.periodEnd,
    });
    const bills = await tx.query("bills_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });

    const candidateIds = payments.map((p) => p.id);
    const versions = [
      { id: "AP-APPLY-PAYMENTS", version: 1 },
      ...payments.map((p) => ({ id: p.id, version: p.version })),
      // A bill that moved changes which bills a payment should pay, so the
      // bill versions belong in the hash even though they are not candidates.
      ...bills.map((b) => ({ id: b.id, version: b.version })),
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
        ...bills.filter((b) => b.manualOverride).map((b) => b.id),
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
    const bills = await tx.query("bills_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const payments = await tx.query("vendor_payments_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: window.periodStart,
      to: window.periodEnd,
    });
    const priorApplications = await tx.query(
      "bill_applications_for_client",
      { firmId: frozen.firmId, clientId: frozen.clientId },
    );
    const remittance =
      payments.length === 0
        ? []
        : await tx.query("vendor_remittance_lines_for_payments", {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            paymentIds: payments.map((p) => p.id),
          });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    // Each bill's own expense line, found rather than stored: AP-CREATE-BILL
    // sets its entry's id equal to the bill's own id, and every bill has
    // exactly one expense line, so entryId=billId plus the bill's own
    // expenseAccount names it uniquely.
    const billLines =
      bills.length === 0
        ? []
        : await tx.query("journal_lines_for_entries", {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            entryIds: bills.map((b) => b.id),
          });
    const expenseLineByBill = new Map<Ulid, Ulid>();
    for (const bill of bills) {
      const expenseLine = billLines.find(
        (l) => l.entryId === bill.id && l.accountNumber === bill.expenseAccount,
      );
      if (expenseLine) expenseLineByBill.set(bill.id, expenseLine.id);
    }

    const appliedPaymentIds = new Set(
      priorApplications
        .filter((a) => a.state !== "reversed")
        .map((a) => a.paymentId),
    );
    const billById = new Map(bills.map((b) => [b.id, b]));
    // Remaining open balance per bill, carried across payments so that two
    // payments in one execution cannot both consume the same open amount.
    const remainingOpen = new Map<string, Cents>();
    for (const bill of bills) {
      if (billIsOpen(bill) && !bill.manualOverride) {
        remainingOpen.set(bill.id, billOpen(bill));
      }
    }
    const billPatched = new Map<string, Cents>();
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

      const open = openFor(bills, payment.vendorId, remainingOpen);
      if (open.length === 0) {
        skips.push({
          rowId: payment.id,
          reason: "missing_prerequisite",
          detail: `no_open_bills for vendor ${payment.vendorId}`,
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

      const entry = entryFor(policy, payment, resolved.allocations, expenseLineByBill);
      proposals.push(entry);
      for (const l of entry.lines) net += l.amountCents;

      resolved.allocations.forEach((alloc, index) => {
        const bill = billById.get(alloc.billId) as BillRow;
        const priorPatch = billPatched.get(bill.id) ?? ZERO;
        const beforePaid = bill.paidCents + priorPatch;
        const afterPaid = beforePaid + alloc.amountCents;
        const stillOpen =
          bill.originalAmountCents -
          afterPaid -
          bill.discountTakenCents -
          bill.creditsCents;
        billPatched.set(bill.id, priorPatch + alloc.amountCents);
        remainingOpen.set(
          bill.id,
          (remainingOpen.get(bill.id) ?? ZERO) - alloc.amountCents,
        );

        proposals.push({
          kind: "field_write",
          table: "bills",
          rowId: bill.id,
          before: {
            paidCents: beforePaid,
            status: bill.status,
          },
          after: {
            paidCents: afterPaid,
            status: stillOpen <= ZERO ? "paid" : bill.status,
          },
          // Applying cash to a bill is not a coding decision, so it claims no
          // cascade level, on the same reasoning AR-APPLY-PAYMENTS gives.
          provenance: { cascadeLevel: null },
        });

        proposals.push({
          kind: "row_insert",
          table: "bill_applications",
          rowId: derivedId(
            `${payment.id}:${bill.id}`,
            "ap-apply-payments",
            index + 1,
          ),
          row: {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            version: 1,
            paymentId: payment.id,
            billId: bill.id,
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
        table: "vendor_payments",
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
      runType: "AP-APPLY-PAYMENTS",
      runVersion: 1,
    });
  },

  /**
   * The entry reverses and the balances revert. The application rows stay, in
   * the state the reversal leaves them, same reasoning AR-APPLY-PAYMENTS
   * gives: a record that the run applied the cash and that it was undone is
   * more useful than a gap.
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

/** The open bills of one vendor, in oldest first order. */
function openFor(
  bills: readonly BillRow[],
  vendorId: Ulid,
  remainingOpen: Map<string, Cents>,
): BillRow[] {
  return bills.filter(
    (b) =>
      b.vendorId === vendorId &&
      (remainingOpen.get(b.id) ?? ZERO) > ZERO &&
      !b.manualOverride,
  );
}

/**
 * The four tiers, in order, same shape as AR-APPLY-PAYMENTS' own
 * resolvePayment. Only tier 3 can refuse outright.
 */
function resolvePayment(
  policy: ArapPolicy,
  payment: VendorPaymentRow,
  open: readonly BillRow[],
  remainingOpen: Map<string, Cents>,
  advice: readonly VendorRemittanceLineRow[],
  remaining: Cents,
): Resolution | Refusal {
  const byNumber = new Map(open.map((b) => [b.billNumber, b]));
  const openOf = (bill: BillRow): Cents => remainingOpen.get(bill.id) ?? ZERO;

  // Tier 1. The payer named the bills.
  if (advice.length > 0) {
    const allocations: Allocation[] = [];
    let stated = ZERO;
    for (const line of advice) {
      const bill = byNumber.get(line.billNumber);
      if (bill === undefined) {
        return {
          reason: "ambiguous_candidate",
          detail: `remittance_bill_unknown, payment ${payment.id} names ${line.billNumber} which is not open`,
        };
      }
      stated += line.amountCents;
      const take = line.amountCents < openOf(bill) ? line.amountCents : openOf(bill);
      if (take > ZERO) {
        allocations.push({
          billId: bill.id,
          billNumber: bill.billNumber,
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

  // Tier 2. A hint naming one bill.
  if (payment.matchHint !== null) {
    const bill = byNumber.get(payment.matchHint);
    if (bill === undefined) {
      return {
        reason: "ambiguous_candidate",
        detail: `match_hint_unknown, payment ${payment.id} points at ${payment.matchHint} which is not open`,
      };
    }
    const take = remaining < openOf(bill) ? remaining : openOf(bill);
    return {
      tier: 2,
      allocations: [
        {
          billId: bill.id,
          billNumber: bill.billNumber,
          amountCents: take,
        },
      ],
    };
  }

  // Tier 3. A unique combination of up to three bills.
  const ordered = oldestFirstBills(open, policy);
  const amounts = ordered.map((b) => openOf(b));
  const tolerance = remittanceTolerance(1);
  const hits = combinationsSummingTo(amounts, remaining, tolerance);
  if (hits.length === 1) {
    const chosen = hits[0];
    return {
      tier: 3,
      allocations: capTo(
        chosen.map((index) => ({
          billId: ordered[index].id,
          billNumber: ordered[index].billNumber,
          amountCents: amounts[index],
        })),
        remaining,
      ),
    };
  }
  if (hits.length > 1) {
    return {
      reason: "ambiguous_candidate",
      detail: `combination_not_unique, ${hits.length} combinations of open bills sum to ${remaining.toString()}`,
    };
  }

  // Tier 4. Oldest first, which is the stated default.
  const allocations: Allocation[] = [];
  let left = remaining;
  for (const bill of ordered) {
    if (left <= ZERO) break;
    const take = left < openOf(bill) ? left : openOf(bill);
    if (take <= ZERO) continue;
    allocations.push({
      billId: bill.id,
      billNumber: bill.billNumber,
      amountCents: take,
    });
    left -= take;
  }
  return { tier: 4, allocations };
}

/**
 * Never allocate more than the payment. The tolerance exists so a remittance
 * a few cents out is still usable, and this is where it stops: what posts is
 * the cash that actually left, not what the advice claimed.
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
 * One entry per payment. The clearing account is relieved once (credited,
 * the mirror of AR's debit) and the control account is debited once for each
 * bill (the mirror of AR's credit), because AP control is a liability and
 * relieving it is a debit.
 */
function entryFor(
  policy: ArapPolicy,
  payment: VendorPaymentRow,
  allocations: readonly Allocation[],
  expenseLineByBill: ReadonlyMap<Ulid, Ulid>,
): ProposedJournalEntry {
  const total = allocations.reduce((sum, a) => sum + a.amountCents, ZERO);
  const lines: ProposedLine[] = [
    {
      accountNumber: payment.clearingAccount || policy.accounts.apClearing,
      categoryId: null,
      amountCents: -total,
      memo: `Apply payment ${payment.id}`,
      dimensions: {},
    },
  ];
  for (const a of allocations) {
    lines.push({
      accountNumber: policy.accounts.apControl,
      categoryId: null,
      amountCents: a.amountCents,
      memo: `Applied to bill ${a.billNumber}`,
      dimensions: {},
      cashEffect: "cash",
      cashEventDate: payment.paymentDate,
      cashSourceLine: expenseLineByBill.get(a.billId) ?? null,
    });
  }
  return {
    kind: "journal_entry",
    targetId: derivedId(payment.id, "ap-apply-payments", 0),
    entryDate: payment.paymentDate,
    lines,
    sourceRef: {
      table: "vendor_payments",
      rowId: payment.id,
      version: payment.version,
    },
  };
}
