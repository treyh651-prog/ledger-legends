/**
 * AP-CREATE-BILL. Record a vendor's bill and post the payable.
 *
 * Not one of doc 02's documented module 5 runs, for the same reason
 * AR-CREATE-INVOICE is not: migration 0014 built the payable subledger
 * assuming a bill already existed by the time AP-APPLY-DISCOUNTS or
 * ARAP-REFRESH-AGING ever read it. Nothing in the original run set puts the
 * first bill on the books. This run does, in the one shape AP-APPLY-DISCOUNTS
 * already expects: a posted subledger.bills row and the journal entry that
 * put it there.
 *
 * The entry. Debit the expense account for the full billed amount -- freight
 * and tax included, since bills.expense_account is the only GL destination a
 * bill carries, unlike an invoice's separate sales tax liability line -- and
 * credit the payable control account for the same amount. Always two lines,
 * always net zero.
 *
 * Idempotency. subledger.bills carries a unique constraint on
 * (client_id, bill_number), the vendor's own invoice number, so a repeat of
 * the same number is reported rather than posted a second time regardless of
 * what else changed about the call.
 *
 * Manual tier: recording a vendor's bill is the decision itself, the same
 * reasoning AR-CREATE-INVOICE gives for billing a customer.
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
import type { BillRow } from "../tables";
import { resolvePolicy } from "./arap-shared";

const centsString = z.string().regex(/^[0-9]+$/);

export const createBillScopeSchema = z
  .object({
    clientId: z.string().min(1),
    vendorId: z.string().min(1),
    billNumber: z.string().min(1),
    billDate: z.string().min(10),
    dueDate: z.string().min(10),
    /** The full billed amount, freight and tax included. Never negative. */
    amountCents: centsString,
    freightCents: centsString.default("0"),
    taxCents: centsString.default("0"),
    expenseAccount: z.string().regex(/^[0-9]{4}$/),
    /** 2/10 net 30 is 200, 10, 30. All three or none. */
    discountBps: z.number().int().min(0).max(10000).nullable().default(null),
    discountDays: z.number().int().min(0).nullable().default(null),
    netDays: z.number().int().min(0).nullable().default(null),
  })
  .refine(
    (s) =>
      (s.discountBps === null && s.discountDays === null && s.netDays === null) ||
      (s.discountBps !== null &&
        s.discountDays !== null &&
        s.netDays !== null &&
        s.netDays >= s.discountDays),
    { message: "discountBps, discountDays, and netDays are all three or none, and netDays must be at least discountDays" },
  );

export type CreateBillScope = z.infer<typeof createBillScopeSchema>;

export function billIdFor(clientId: Ulid, billNumber: string): Ulid {
  return derivedId(`${clientId}:${billNumber}`, "ap-create-bill", 0);
}

export const apCreateBill: Run<CreateBillScope, Proposal> = {
  type: "AP-CREATE-BILL",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:ap-create-bill:${scope.billNumber}`,
  scopeSchema: createBillScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateBillScope>> {
    const tx = requireTx(ctx);
    const billId = billIdFor(scope.clientId, scope.billNumber);
    // subledger.vendors carries no version column (migration 0005), unlike
    // subledger.customers, so there is no vendor state to fold into the hash
    // here beyond the existing bills below.
    const bills = await tx.query("bills_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const candidateIds = [billId];
    const versions = [
      { id: "AP-CREATE-BILL", version: 1 },
      ...bills.map((b) => ({ id: b.id, version: b.version })),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: scope.billDate,
      periodEnd: scope.billDate,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: bills.filter((b) => b.manualOverride).map((b) => b.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const billId = billIdFor(frozen.clientId, scope.billNumber);
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const refuse = (code: string, message: string): RunResult<Proposal> => {
      errors.push({ rowId: billId, code, message, retryable: false });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    };

    if (!isIsoDay(scope.billDate) || !isIsoDay(scope.dueDate)) {
      return refuse("BILL_DATE_NOT_A_DAY", `billDate ${scope.billDate} and dueDate ${scope.dueDate} must both be ISO days`);
    }
    if (scope.dueDate < scope.billDate) {
      return refuse("DUE_BEFORE_BILL", `dueDate ${scope.dueDate} falls before billDate ${scope.billDate}`);
    }

    const amount = BigInt(scope.amountCents);
    const freight = BigInt(scope.freightCents);
    const tax = BigInt(scope.taxCents);
    if (amount <= BigInt(0)) {
      return refuse("BILL_AMOUNT_NOT_POSITIVE", `amountCents ${scope.amountCents} must be greater than zero`);
    }
    if (freight < BigInt(0) || tax < BigInt(0) || freight + tax > amount) {
      return refuse("PARTS_OUTSIDE_AMOUNT", `freightCents ${scope.freightCents} plus taxCents ${scope.taxCents} must not exceed amountCents ${scope.amountCents}`);
    }

    const bills = await tx.query("bills_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (bills.some((b) => b.billNumber === scope.billNumber)) {
      skips.push({
        rowId: billId,
        reason: "already_applied",
        detail: `bill number ${scope.billNumber} already exists for this client`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
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
    if (!accounts.some((a) => a.accountNumber === scope.expenseAccount)) {
      return refuse("ACCOUNT_NOT_ON_CHART", `expense account ${scope.expenseAccount} is not on the client's chart`);
    }

    const policyRows = await tx.query("arap_policy", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const policy = resolvePolicy(policyRows);
    if (!accounts.some((a) => a.accountNumber === policy.accounts.apControl)) {
      return refuse("ACCOUNT_NOT_ON_CHART", `payable control account ${policy.accounts.apControl} is not on the client's chart`);
    }

    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (isLockedDay(locks, scope.billDate)) {
      skips.push({
        rowId: billId,
        reason: "locked_period",
        detail: `bill date ${scope.billDate} falls inside a locked period`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const lines: ProposedLine[] = [
      {
        accountNumber: scope.expenseAccount,
        categoryId: null,
        amountCents: amount,
        memo: `Bill ${scope.billNumber}`,
        dimensions: {},
      },
      {
        accountNumber: policy.accounts.apControl,
        categoryId: null,
        amountCents: -amount,
        memo: `Bill ${scope.billNumber}`,
        dimensions: {},
      },
    ];

    const entry: ProposedJournalEntry = {
      kind: "journal_entry",
      targetId: billId,
      entryDate: scope.billDate,
      lines,
      sourceRef: { table: "bills", rowId: billId, version: 1 },
    };

    const row: BillRow = {
      id: billId,
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      vendorId: scope.vendorId,
      billNumber: scope.billNumber,
      billDate: scope.billDate,
      dueDate: scope.dueDate,
      originalAmountCents: amount,
      freightCents: freight,
      taxCents: tax,
      paidCents: BigInt(0),
      discountTakenCents: BigInt(0),
      creditsCents: BigInt(0),
      discountBps: scope.discountBps,
      discountDays: scope.discountDays,
      netDays: scope.netDays,
      status: "posted",
      onHold: false,
      inDispute: false,
      apAccount: policy.accounts.apControl,
      expenseAccount: scope.expenseAccount,
      manualOverride: false,
      createdBy: ACTOR_PLACEHOLDER,
    };
    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "bills",
      rowId: billId,
      row: row as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };

    const net: Cents = lines.reduce((sum, l) => sum + l.amountCents, BigInt(0));
    return makeResult<Proposal>(1, [entry, insert], skips, errors, net);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "AP-CREATE-BILL",
      runVersion: 1,
    });
  },

  /**
   * No undo plan. A bill that has received a payment, a discount, or a credit
   * cannot be quietly un-posted; a billing mistake is corrected with a vendor
   * credit or a void, both of which are a person's decision and neither of
   * which this run version implements.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
