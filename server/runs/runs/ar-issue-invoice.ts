/**
 * AR-ISSUE-INVOICE. Post a draft invoice, the "ordinary invoicing path" a
 * draft is supposed to become revenue through.
 *
 * Audit finding (rerun, 2026-11-06): AR-CHARGE-LATEFEES deliberately
 * creates its fee invoice as status "draft" ("a person decides whether to
 * issue it") and its own header comment says a reviewed, issued fee
 * "becomes revenue through the ordinary invoicing path, not through this
 * run" -- but nothing in this codebase ever implemented that path.
 * AR-CREATE-INVOICE only ever inserts a brand new row, always posted
 * directly; there was no run that could move an *existing* draft row to
 * posted and give it the journal entry it has never had. A late fee could
 * be created and then never reach the books at all.
 *
 * The entry mirrors AR-CREATE-INVOICE's own exactly: debit the invoice's
 * own stored AR account for the full amount, credit its own stored
 * revenue account for the amount net of tax, and credit the client's sales
 * tax account for the tax portion when there is one -- reusing the
 * arAccount/revenueAccount AR-CHARGE-LATEFEES (or a future draft writer)
 * already validated and stored on the row itself, not re-derived from a
 * fresh scope the way AR-CREATE-INVOICE's own caller has to supply.
 *
 * General purpose, not late-fee specific: any row left in draft, by any
 * writer, past or future, can be issued through here. The only
 * requirement is status draft -- isLateFee is read nowhere in this file.
 *
 * Manual tier: issuing a bill is the decision itself, the same reasoning
 * AR-CREATE-INVOICE gives for its own tier, and a late fee is exactly the
 * kind of charge a person should look at before it becomes revenue.
 */

import { z } from "zod";
import {
  makeResult,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedJournalEntry,
  type ProposedLine,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { resolvePolicy } from "./arap-shared";

export const ISSUE_INVOICE_ERROR_CODES = {
  unknownInvoice: "AR_ISSUE_UNKNOWN_INVOICE",
  accountNotOnChart: "AR_ISSUE_ACCOUNT_NOT_ON_CHART",
  missingSalesTaxAccount: "AR_ISSUE_MISSING_SALES_TAX_ACCOUNT",
} as const;

export const issueInvoiceScopeSchema = z.object({
  clientId: z.string().min(1),
  invoiceId: z.string().min(1),
});

export type IssueInvoiceScope = z.infer<typeof issueInvoiceScopeSchema>;

export function issueInvoiceEntryIdFor(invoiceId: Ulid): Ulid {
  return derivedId(invoiceId, "ar-issue-invoice", 0);
}

export const arIssueInvoice: Run<IssueInvoiceScope, Proposal> = {
  type: "AR-ISSUE-INVOICE",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:ar-issue-invoice:${scope.invoiceId}`,
  scopeSchema: issueInvoiceScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<IssueInvoiceScope>> {
    const tx = requireTx(ctx);
    const invoices = await tx.query("invoices_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const invoice = invoices.find((i) => i.id === scope.invoiceId);
    const candidateIds = [scope.invoiceId];
    const versions = [
      { id: "AR-ISSUE-INVOICE", version: 1 },
      ...(invoice ? [{ id: invoice.id, version: invoice.version }] : []),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: invoice?.invoiceDate ?? ctx.now.toISOString().slice(0, 10),
      periodEnd: invoice?.invoiceDate ?? ctx.now.toISOString().slice(0, 10),
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: invoice?.manualOverride ? [invoice.id] : [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const refuse = (code: string, message: string): RunResult<Proposal> => {
      errors.push({ rowId: scope.invoiceId, code, message, retryable: false });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    };

    const invoices = await tx.query("invoices_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const invoice = invoices.find((i) => i.id === scope.invoiceId);
    if (!invoice) {
      return refuse(ISSUE_INVOICE_ERROR_CODES.unknownInvoice, `invoice ${scope.invoiceId} does not exist for client ${frozen.clientId}`);
    }
    if (invoice.manualOverride) {
      skips.push({
        rowId: invoice.id,
        reason: "manual_override",
        detail: `invoice ${invoice.invoiceNumber} carries manual_override`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }
    if (invoice.status !== "draft") {
      skips.push({
        rowId: invoice.id,
        reason: "already_applied",
        detail: `invoice ${invoice.invoiceNumber} is already ${invoice.status}, not draft`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const accounts = await tx.query("chart_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (!accounts.some((a) => a.accountNumber === invoice.arAccount)) {
      return refuse(ISSUE_INVOICE_ERROR_CODES.accountNotOnChart, `receivable account ${invoice.arAccount} is not on the client's chart`);
    }
    if (!accounts.some((a) => a.accountNumber === invoice.revenueAccount)) {
      return refuse(ISSUE_INVOICE_ERROR_CODES.accountNotOnChart, `revenue account ${invoice.revenueAccount} is not on the client's chart`);
    }
    let salesTaxAccount: string | null = null;
    if (invoice.taxCents > BigInt(0)) {
      const policyRows = await tx.query("arap_policy", { firmId: frozen.firmId, clientId: frozen.clientId });
      const policy = resolvePolicy(policyRows);
      if (policy.accounts.salesTax === null) {
        return refuse(ISSUE_INVOICE_ERROR_CODES.missingSalesTaxAccount, `invoice ${invoice.invoiceNumber} carries tax but no sales tax account is configured`);
      }
      if (!accounts.some((a) => a.accountNumber === policy.accounts.salesTax)) {
        return refuse(ISSUE_INVOICE_ERROR_CODES.accountNotOnChart, `sales tax account ${policy.accounts.salesTax} is not on the client's chart`);
      }
      salesTaxAccount = policy.accounts.salesTax;
    }

    const locks = await tx.query("open_period_locks", { firmId: frozen.firmId, clientId: frozen.clientId });
    if (isLockedDay(locks, invoice.invoiceDate)) {
      skips.push({
        rowId: invoice.id,
        reason: "locked_period",
        detail: `invoice date ${invoice.invoiceDate} falls inside a locked period`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const amount = invoice.originalAmountCents;
    const tax = invoice.taxCents;
    const netRevenue = amount - tax;
    const lines: ProposedLine[] = [
      {
        accountNumber: invoice.arAccount,
        categoryId: null,
        amountCents: amount,
        memo: `Invoice ${invoice.invoiceNumber}`,
        dimensions: {},
      },
    ];
    if (netRevenue > BigInt(0)) {
      lines.push({
        accountNumber: invoice.revenueAccount,
        categoryId: null,
        amountCents: -netRevenue,
        memo: `Invoice ${invoice.invoiceNumber}`,
        dimensions: {},
      });
    }
    if (tax > BigInt(0) && salesTaxAccount !== null) {
      lines.push({
        accountNumber: salesTaxAccount,
        categoryId: null,
        amountCents: -tax,
        memo: `Sales tax on invoice ${invoice.invoiceNumber}`,
        dimensions: {},
      });
    }

    const entryId = issueInvoiceEntryIdFor(invoice.id);
    const entry: ProposedJournalEntry = {
      kind: "journal_entry",
      targetId: entryId,
      entryDate: invoice.invoiceDate,
      lines,
      sourceRef: { table: "invoices", rowId: invoice.id, version: invoice.version },
    };

    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "invoices",
      rowId: invoice.id,
      before: { status: invoice.status },
      after: { status: "posted" },
      provenance: { cascadeLevel: null },
    };

    const net: Cents = lines.reduce((sum, l) => sum + l.amountCents, BigInt(0));
    return makeResult<Proposal>(1, [entry, write], skips, errors, net);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "AR-ISSUE-INVOICE",
      runVersion: 1,
    });
  },

  /**
   * No undo. An issued invoice may already have aged, been seen on a
   * statement, or drawn a payment by the time anyone would want this
   * undone -- the same reasoning AR-CREATE-INVOICE itself gives for having
   * no undo plan.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
