/**
 * AP-APPLY-DISCOUNTS. Take the early payment discount on a vendor bill.
 *
 * Spec: docs/02-run-specifications.md Module 5 AP-APPLY-DISCOUNTS. This is the
 * payable side of module 5 and the only one of the six that is not receivable.
 *
 * Terms of 2/10 net 30 mean the vendor will accept two percent less if payment
 * lands within ten days. When it does, the bill is settled for less than it was
 * booked at, and the difference has to go somewhere. It goes to a purchase
 * discount account, or to a vendor credit when the vendor agreement says the
 * discount is held for future purchases rather than taken in cash. Which of the
 * two applies is a term of one vendor agreement, so it is read from the vendor
 * record and never decided here.
 *
 * Terms are three integers on the bill and are never parsed from free text at
 * run time. 2/10 net 30 is 200 basis points, ten days, thirty net days. A bill
 * with a partial set of terms is not a bill with terms.
 *
 * Freight and tax come out of the discount base by default. A vendor offering
 * two percent for early payment is discounting goods, and taking two percent
 * off sales tax the vendor merely collected would understate a liability that
 * was never the vendor's to discount.
 *
 * This run posts. It is the one deviation from doc 02, which describes the
 * discount run as proposing only, and the deviation is deliberate: the bill
 * balance has to actually fall or the payable subledger stops agreeing with the
 * control account. The reasoning and the alternatives are in NOTES.md.
 *
 * The annualized benefit is reported and never posted. Two percent for paying
 * twenty days early is close to thirty six percent a year, which is the number
 * a client needs when deciding whether to fund the early payment, and it is not
 * an amount that belongs on any ledger.
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
} from "../contract";
import { applyProposals, RUN_ID_PLACEHOLDER, requireTx } from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { reverseEntry, revertFieldWrite } from "../undo";
import type { BillRow, VendorRow } from "../tables";
import { periodWindow } from "./per-shared";
import {
  annualizedBenefitBp,
  billIsOpen,
  billOpen,
  discountAmount,
  hasDiscountTerms,
  resolvePolicy,
  withinDiscountWindow,
  ZERO,
  type ArapPolicy,
} from "./arap-shared";

export const DISCOUNT_ERROR_CODES = {
  missingDiscountAccount: "AP_DISCOUNT_ACCOUNT_MISSING",
  missingCreditAccount: "AP_VENDOR_CREDIT_ACCOUNT_MISSING",
} as const;

export const applyEarlyDiscountScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  /**
   * The day the payment lands. Defaults to the period end, which is what a
   * close run wants, and is stated explicitly when a payment run is being
   * modeled for a specific day.
   */
  payDay: z.string().min(10).optional(),
});

export type ApplyEarlyDiscountScope = z.infer<
  typeof applyEarlyDiscountScopeSchema
>;

export const apApplyEarlyDiscount: Run<ApplyEarlyDiscountScope, Proposal> = {
  type: "AP-APPLY-DISCOUNTS",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) =>
    `${scope.clientId}:apdiscount:${scope.period.slice(0, 7)}`,
  scopeSchema: applyEarlyDiscountScopeSchema,

  async resolveScope(
    scope,
    ctx,
  ): Promise<FrozenScope<ApplyEarlyDiscountScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const bills = await tx.query("bills_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const vendors = await tx.query("vendors_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });

    const candidateIds = bills.filter((b) => hasDiscountTerms(b)).map((b) => b.id);
    const versions = [
      { id: "AP-APPLY-DISCOUNTS", version: 1 },
      ...bills.map((b) => ({ id: b.id, version: b.version })),
      // The vendor rule decides where the discount lands, so a vendor whose
      // rule changed has to change the hash.
      ...vendors.map((v) => ({ id: v.id, version: v.normalizerVersion })),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({
        period: scope.payDay ?? window.periodEnd,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: bills.filter((b) => b.manualOverride).map((b) => b.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const payDay = frozen.input.payDay ?? window.periodEnd;
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
    const vendors = await tx.query("vendors_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    const vendorById = new Map<string, VendorRow>(vendors.map((v) => [v.id, v]));
    let net: Cents = ZERO;

    for (const bill of bills) {
      if (bill.manualOverride) {
        skips.push({
          rowId: bill.id,
          reason: "manual_override",
          detail: `bill ${bill.billNumber} carries manual_override`,
        });
        continue;
      }
      if (!hasDiscountTerms(bill)) {
        skips.push({
          rowId: bill.id,
          reason: "missing_prerequisite",
          detail: `no_discount_terms on bill ${bill.billNumber}`,
        });
        continue;
      }
      if (bill.onHold || bill.inDispute) {
        skips.push({
          rowId: bill.id,
          reason: "missing_prerequisite",
          detail: `bill_on_hold_or_disputed, ${bill.billNumber} is not payable`,
        });
        continue;
      }
      if (!billIsOpen(bill)) {
        skips.push({
          rowId: bill.id,
          reason: "already_applied",
          detail: `bill_closed, ${bill.billNumber} owes nothing`,
        });
        continue;
      }
      // A discount already taken is not taken twice. The stored amount is the
      // record, so a rerun sees it and stops.
      if (bill.discountTakenCents > ZERO) {
        skips.push({
          rowId: bill.id,
          reason: "already_applied",
          detail: `discount_already_taken on ${bill.billNumber}`,
        });
        continue;
      }
      if (!withinDiscountWindow(bill, payDay)) {
        skips.push({
          rowId: bill.id,
          reason: "missing_prerequisite",
          detail: `outside_discount_window, ${bill.billNumber} dated ${bill.billDate} against a pay day of ${payDay}`,
        });
        continue;
      }
      if (isLockedDay(locks, payDay)) {
        skips.push({
          rowId: bill.id,
          reason: "locked_period",
          detail: `pay day ${payDay} falls inside a locked period`,
        });
        continue;
      }

      const open = billOpen(bill);
      let discount = discountAmount(policy, bill);
      if (discount <= ZERO) {
        skips.push({
          rowId: bill.id,
          reason: "missing_prerequisite",
          detail: `discount_computes_to_zero on ${bill.billNumber}`,
        });
        continue;
      }
      // A discount can never exceed what is still owed. A partly paid bill with
      // a large stated percentage would otherwise produce a negative payment.
      if (discount > open) discount = open;

      const vendor = vendorById.get(bill.vendorId);
      const rule = vendor?.earlyDiscountRule ?? "purchase_discount_income";
      const account =
        rule === "vendor_credit"
          ? policy.accounts.vendorCredit
          : policy.accounts.purchaseDiscount;
      if (account === null) {
        errors.push({
          rowId: bill.id,
          code:
            rule === "vendor_credit"
              ? DISCOUNT_ERROR_CODES.missingCreditAccount
              : DISCOUNT_ERROR_CODES.missingDiscountAccount,
          message: `bill ${bill.billNumber} needs a ${rule} account and the policy names none`,
          retryable: false,
        });
        continue;
      }

      const payment = open - discount;
      const entry = entryFor(
        policy,
        bill,
        open,
        payment,
        discount,
        account,
        payDay,
      );
      proposals.push(entry);
      for (const l of entry.lines) net += l.amountCents;

      proposals.push({
        kind: "field_write",
        table: "bills",
        rowId: bill.id,
        before: {
          paidCents: bill.paidCents,
          discountTakenCents: bill.discountTakenCents,
          status: bill.status,
        },
        after: {
          paidCents: bill.paidCents + payment,
          discountTakenCents: bill.discountTakenCents + discount,
          // Paid and discounted together settle the bill in full, which is the
          // point: the balance drops to zero and the subledger keeps footing.
          status: "paid",
        },
        provenance: { cascadeLevel: null },
      });

      if (rule === "vendor_credit") {
        proposals.push({
          kind: "row_insert",
          table: "vendor_credits",
          rowId: derivedId(bill.id, "ap-apply-earlydiscount", 1),
          row: {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            version: 1,
            vendorId: bill.vendorId,
            billId: bill.id,
            creditDate: payDay,
            amountCents: discount,
            appliedCents: ZERO,
            state: "open",
            source: `early_payment_discount on ${bill.billNumber}, annualized ${annualizedBenefitBp(bill)} basis points`,
            postedEntryId: entry.targetId,
            createdByRunId: RUN_ID_PLACEHOLDER,
            manualOverride: false,
          },
          provenance: { cascadeLevel: null },
        });
      }
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
      runType: "AP-APPLY-DISCOUNTS",
      runVersion: 1,
    });
  },

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

/**
 * The settlement entry. The payable is relieved in full, the clearing account
 * carries the cash actually paid, and the difference goes to the account the
 * vendor rule chose. Three lines that sum to zero, and the bill balance falls
 * by the whole open amount rather than by the payment alone.
 */
function entryFor(
  policy: ArapPolicy,
  bill: BillRow,
  open: Cents,
  payment: Cents,
  discount: Cents,
  discountAccount: string,
  payDay: string,
): ProposedJournalEntry {
  const memo = `Early payment discount on bill ${bill.billNumber}`;
  const lines: ProposedLine[] = [
    // Debit the payable. In this ledger a payable carries a credit balance, so
    // relieving it is a positive amount.
    {
      accountNumber: bill.apAccount || policy.accounts.apControl,
      categoryId: null,
      amountCents: open,
      memo,
      dimensions: {},
    },
    // Credit the cash the vendor actually receives.
    {
      accountNumber: policy.accounts.apClearing,
      categoryId: null,
      amountCents: -payment,
      memo: `Payment on bill ${bill.billNumber}`,
      dimensions: {},
    },
    // Credit the discount taken, to income or to the vendor credit account.
    {
      accountNumber: discountAccount,
      categoryId: null,
      amountCents: -discount,
      memo: `Discount taken, ${bill.discountBps ?? 0} basis points`,
      dimensions: {},
    },
  ];
  return {
    kind: "journal_entry",
    targetId: derivedId(bill.id, "ap-apply-earlydiscount", 0),
    entryDate: payDay,
    lines,
    sourceRef: { table: "bills", rowId: bill.id, version: bill.version },
  };
}
