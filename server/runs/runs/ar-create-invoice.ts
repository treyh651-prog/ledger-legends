/**
 * AR-CREATE-INVOICE. Bill a client's customer and post the sale.
 *
 * Not one of doc 02's documented module 5 runs, for the same reason
 * AR-CREATE-CUSTOMER is not: migration 0014 built the receivable subledger
 * assuming an invoice already existed by the time AR-APPLY-PAYMENTS,
 * AR-CHARGE-LATEFEES, AR-WRITEOFF-UNCOLLECTIBLE, ARAP-REFRESH-AGING, or
 * AR-BUILD-STATEMENTS ever read it. Nothing in the original run set puts the
 * first invoice on the books. This run does, in the one shape every later
 * module 5 run already expects: a posted subledger.invoices row and the
 * journal entry that put it there.
 *
 * The entry. Debit the receivable control account for the full billed
 * amount, credit revenue for the amount net of tax, and credit the sales tax
 * payable account for the tax portion when there is one. Three lines when
 * there is tax, two when there is not, and the three always foot to zero
 * because the net line is derived from the other two rather than supplied
 * separately.
 *
 * Idempotency. subledger.invoices carries a unique constraint on
 * (client_id, invoice_number), the same number a firm's own paper invoice
 * carries, so a repeat of the same number is reported rather than posted a
 * second time regardless of what else changed about the call.
 *
 * Manual tier: billing a customer is the decision itself, the same reasoning
 * SETUP-IMPORT-BALANCES gives for the opening entry, and a wrong invoice
 * misstates every aging bucket and every statement built on top of it.
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
import type { InvoiceRow } from "../tables";
import { resolvePolicy } from "./arap-shared";

const centsString = z.string().regex(/^[0-9]+$/);

export const createInvoiceScopeSchema = z.object({
  clientId: z.string().min(1),
  customerId: z.string().min(1),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string().min(10),
  dueDate: z.string().min(10),
  /** The full billed amount, tax included. Never negative. */
  amountCents: centsString,
  /** The portion of amountCents that is sales tax. Defaults to none. */
  taxCents: centsString.default("0"),
  revenueAccount: z.string().regex(/^[0-9]{4}$/),
});

export type CreateInvoiceScope = z.infer<typeof createInvoiceScopeSchema>;

export function invoiceIdFor(clientId: Ulid, invoiceNumber: string): Ulid {
  return derivedId(`${clientId}:${invoiceNumber}`, "ar-create-invoice", 0);
}

export const arCreateInvoice: Run<CreateInvoiceScope, Proposal> = {
  type: "AR-CREATE-INVOICE",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:ar-create-invoice:${scope.invoiceNumber}`,
  scopeSchema: createInvoiceScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateInvoiceScope>> {
    const tx = requireTx(ctx);
    const invoiceId = invoiceIdFor(scope.clientId, scope.invoiceNumber);
    const customers = await tx.query("customers_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const invoices = await tx.query("invoices_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const candidateIds = [invoiceId];
    const versions = [
      { id: "AR-CREATE-INVOICE", version: 1 },
      ...customers.filter((c) => c.id === scope.customerId).map((c) => ({ id: c.id, version: c.version })),
      ...invoices.map((i) => ({ id: i.id, version: i.version })),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: scope.invoiceDate,
      periodEnd: scope.invoiceDate,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: customers.filter((c) => c.manualOverride).map((c) => c.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const invoiceId = invoiceIdFor(frozen.clientId, scope.invoiceNumber);
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const refuse = (code: string, message: string): RunResult<Proposal> => {
      errors.push({ rowId: invoiceId, code, message, retryable: false });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    };

    if (!isIsoDay(scope.invoiceDate) || !isIsoDay(scope.dueDate)) {
      return refuse("INVOICE_DATE_NOT_A_DAY", `invoiceDate ${scope.invoiceDate} and dueDate ${scope.dueDate} must both be ISO days`);
    }
    if (scope.dueDate < scope.invoiceDate) {
      return refuse("DUE_BEFORE_INVOICE", `dueDate ${scope.dueDate} falls before invoiceDate ${scope.invoiceDate}`);
    }

    const amount = BigInt(scope.amountCents);
    const tax = BigInt(scope.taxCents);
    if (amount <= BigInt(0)) {
      return refuse("INVOICE_AMOUNT_NOT_POSITIVE", `amountCents ${scope.amountCents} must be greater than zero`);
    }
    if (tax < BigInt(0) || tax > amount) {
      return refuse("TAX_OUTSIDE_AMOUNT", `taxCents ${scope.taxCents} must be between 0 and amountCents ${scope.amountCents}`);
    }

    const invoices = await tx.query("invoices_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (invoices.some((i) => i.invoiceNumber === scope.invoiceNumber)) {
      skips.push({
        rowId: invoiceId,
        reason: "already_applied",
        detail: `invoice number ${scope.invoiceNumber} already exists for this client`,
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
    if (isLockedDay(locks, scope.invoiceDate)) {
      skips.push({
        rowId: invoiceId,
        reason: "locked_period",
        detail: `invoice date ${scope.invoiceDate} falls inside a locked period`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const netRevenue = amount - tax;
    const lines: ProposedLine[] = [
      {
        accountNumber: policy.accounts.arControl,
        categoryId: null,
        amountCents: amount,
        memo: `Invoice ${scope.invoiceNumber}`,
        dimensions: {},
      },
    ];
    if (netRevenue > BigInt(0)) {
      lines.push({
        accountNumber: scope.revenueAccount,
        categoryId: null,
        amountCents: -netRevenue,
        memo: `Invoice ${scope.invoiceNumber}`,
        dimensions: {},
      });
    }
    if (tax > BigInt(0) && policy.accounts.salesTax !== null) {
      lines.push({
        accountNumber: policy.accounts.salesTax,
        categoryId: null,
        amountCents: -tax,
        memo: `Sales tax on invoice ${scope.invoiceNumber}`,
        dimensions: {},
      });
    }

    const entry: ProposedJournalEntry = {
      kind: "journal_entry",
      targetId: invoiceId,
      entryDate: scope.invoiceDate,
      lines,
      sourceRef: { table: "invoices", rowId: invoiceId, version: 1 },
    };

    const row: InvoiceRow = {
      id: invoiceId,
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      customerId: scope.customerId,
      invoiceNumber: scope.invoiceNumber,
      invoiceDate: scope.invoiceDate,
      dueDate: scope.dueDate,
      originalAmountCents: amount,
      taxCents: tax,
      appliedPaymentsCents: BigInt(0),
      appliedCreditsCents: BigInt(0),
      writtenOffCents: BigInt(0),
      status: "posted",
      inDispute: false,
      collectionAttempts: 0,
      parentInvoiceId: null,
      isLateFee: false,
      feeMonths: null,
      writeoffApproved: false,
      arAccount: policy.accounts.arControl,
      revenueAccount: scope.revenueAccount,
      manualOverride: false,
      createdBy: ACTOR_PLACEHOLDER,
    };
    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "invoices",
      rowId: invoiceId,
      row: row as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };

    const net: Cents = lines.reduce((sum, l) => sum + l.amountCents, BigInt(0));
    return makeResult<Proposal>(1, [entry, insert], skips, errors, net);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "AR-CREATE-INVOICE",
      runVersion: 1,
    });
  },

  /**
   * No undo plan. An invoice that has received a payment, a credit, or a
   * write off cannot be quietly un-posted; a billing mistake is corrected
   * with a credit memo or a void, both of which are a person's decision and
   * neither of which this run version implements.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
