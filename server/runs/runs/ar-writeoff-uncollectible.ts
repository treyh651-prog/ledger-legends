/**
 * AR-WRITEOFF-UNCOLLECTIBLE. Propose write offs for very old receivables.
 *
 * Spec: docs/02-run-specifications.md Module 5 AR-WRITEOFF-UNCOLLECTIBLE.
 *
 * A write off says the client is not going to collect. That is a judgement
 * about a customer relationship and about the client's own willingness to
 * pursue a debt, and it is not a judgement a run is entitled to make. So the
 * gate is absolute: nothing posts unless one of exactly two standing decisions
 * is already on record.
 *
 *   1. The customer is flagged do_not_pursue. Someone decided, at the customer
 *      level, that balances from this customer are not chased.
 *   2. The invoice carries the manual approve flag. Someone decided about this
 *      one invoice.
 *
 * With neither of those, the run still does something useful: it records a
 * proposal with no authority, which is a review item a person can act on. What
 * it does not do is post. There is no threshold, no age, and no amount that
 * makes a write off automatic, and the default age of 180 days is a filter on
 * what gets proposed rather than a permission to post.
 *
 * The sales tax portion comes back out proportionally. Writing the whole
 * balance to bad debt would leave a tax liability standing for revenue that was
 * never collected, and the split is taken from the original invoice proportions
 * so that a partly paid invoice does not shift the mix.
 *
 * The allowance method debits the allowance account and the direct method
 * debits bad debt expense. Which one applies is a policy of the client's books
 * and is read from the policy row. Neither is a tax position: this run does not
 * compute a deduction, does not assert that an amount is deductible, and does
 * not prepare anything that goes on a return.
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
import {
  applyProposals,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  requireTx,
} from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { reverseEntry, revertFieldWrite } from "../undo";
import type { CustomerRow, InvoiceRow } from "../tables";
import { periodWindow } from "./per-shared";
import {
  ageDaysFor,
  approvalRouteFor,
  basisDateOf,
  invoiceIsOpen,
  invoiceOpen,
  resolvePolicy,
  splitTax,
  ZERO,
  type ArapPolicy,
} from "./arap-shared";

export const WRITEOFF_ERROR_CODES = {
  missingBadDebtAccount: "AR_WRITEOFF_ACCOUNT_MISSING",
} as const;

export const writeoffScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  /**
   * Age threshold in days. Stated in the scope so a person can look further
   * back without editing policy, and defaulted to the policy value, which
   * itself defaults to 180.
   */
  ageDays: z.number().int().positive().optional(),
});

export type WriteoffScope = z.infer<typeof writeoffScopeSchema>;

/** Which standing decision permits a posting, if either does. */
type Authority = "do_not_pursue" | "manual_approve" | null;

export const arWriteoffUncollectible: Run<WriteoffScope, Proposal> = {
  type: "AR-WRITEOFF-UNCOLLECTIBLE",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) =>
    `${scope.clientId}:writeoff:${scope.period.slice(0, 7)}`,
  scopeSchema: writeoffScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<WriteoffScope>> {
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

    const candidateIds = invoices.map((i) => i.id);
    const versions = [
      { id: "AR-WRITEOFF-UNCOLLECTIBLE", version: 1 },
      ...invoices.map((i) => ({ id: i.id, version: i.version })),
      // The customer flag is one of the two authorities, so a customer whose
      // flag moved has to change the hash.
      ...customers.map((c) => ({ id: c.id, version: c.version })),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
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
    const threshold = frozen.input.ageDays ?? policy.writeoffAgeDays;
    const customers = await tx.query("customers_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const invoices = await tx.query("invoices_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const priors = await tx.query("writeoff_proposals_for_client", {
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
    const proposedInvoices = new Map(
      priors
        .filter((p) => p.state !== "withdrawn")
        .map((p) => [p.invoiceId, p]),
    );
    const locked = isLockedDay(locks, asOf);
    let net: Cents = ZERO;

    for (const inv of invoices) {
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
      if (!invoiceIsOpen(inv)) {
        skips.push({
          rowId: inv.id,
          reason: "already_applied",
          detail: `invoice_closed, ${inv.invoiceNumber} owes nothing`,
        });
        continue;
      }
      // A disputed invoice is not uncollectible, it is unresolved. Writing it
      // off would close a conversation that is still open.
      if (inv.inDispute) {
        skips.push({
          rowId: inv.id,
          reason: "missing_prerequisite",
          detail: `invoice_in_dispute, ${inv.invoiceNumber} is under discussion`,
        });
        continue;
      }
      if (proposedInvoices.has(inv.id)) {
        skips.push({
          rowId: inv.id,
          reason: "already_applied",
          detail: `writeoff_already_proposed for ${inv.invoiceNumber}`,
        });
        continue;
      }

      const age = ageDaysFor(
        basisDateOf(policy, inv.invoiceDate, inv.dueDate),
        asOf,
      );
      if (age < threshold) {
        skips.push({
          rowId: inv.id,
          reason: "missing_prerequisite",
          detail: `below_age_threshold, ${inv.invoiceNumber} is ${age} days old against a threshold of ${threshold}`,
        });
        continue;
      }
      const open = invoiceOpen(inv);
      if (open < policy.writeoffMinimumCents) {
        skips.push({
          rowId: inv.id,
          reason: "missing_prerequisite",
          detail: `below_minimum_amount, ${open.toString()} is under ${policy.writeoffMinimumCents.toString()}`,
        });
        continue;
      }

      const authority = authorityFor(customer, inv);
      const parts = splitTax(inv, open);
      const route = approvalRouteFor(policy, open);
      const proposalId = derivedId(
        `${inv.id}:${asOf}`,
        "ar-writeoff-uncollectible",
        0,
      );

      // No authority means a review item and nothing more. This is the hard
      // line of the run: no age, no amount, and no number of failed collection
      // attempts substitutes for one of the two standing decisions.
      if (authority === null) {
        proposals.push(
          proposalRow(
            frozen,
            proposalId,
            inv,
            asOf,
            age,
            open,
            parts,
            policy.writeoffMethod,
            route,
            null,
            "proposed",
            null,
          ),
        );
        skips.push({
          rowId: inv.id,
          reason: "missing_prerequisite",
          detail: `no_writeoff_authority, ${inv.invoiceNumber} needs do_not_pursue on the customer or the manual approve flag on the invoice`,
        });
        continue;
      }

      if (locked) {
        skips.push({
          rowId: inv.id,
          reason: "locked_period",
          detail: `write off date ${asOf} falls inside a locked period`,
        });
        continue;
      }

      const debitAccount =
        policy.writeoffMethod === "allowance"
          ? policy.accounts.allowance
          : policy.accounts.badDebt;
      if (debitAccount === null) {
        errors.push({
          rowId: inv.id,
          code: WRITEOFF_ERROR_CODES.missingBadDebtAccount,
          message: `the ${policy.writeoffMethod} method needs an account and the policy names none`,
          retryable: false,
        });
        continue;
      }
      if (parts.tax > ZERO && policy.accounts.salesTax === null) {
        errors.push({
          rowId: inv.id,
          code: WRITEOFF_ERROR_CODES.missingBadDebtAccount,
          message: `invoice ${inv.invoiceNumber} carries tax and the policy names no sales tax account`,
          retryable: false,
        });
        continue;
      }

      const entry = entryFor(policy, inv, asOf, parts, debitAccount);
      proposals.push(entry);
      for (const l of entry.lines) net += l.amountCents;

      proposals.push(
        proposalRow(
          frozen,
          proposalId,
          inv,
          asOf,
          age,
          open,
          parts,
          policy.writeoffMethod,
          route,
          authority,
          "posted",
          entry.targetId,
        ),
      );

      proposals.push({
        kind: "field_write",
        table: "invoices",
        rowId: inv.id,
        before: {
          writtenOffCents: inv.writtenOffCents,
          status: inv.status,
        },
        after: {
          writtenOffCents: inv.writtenOffCents + open,
          status: "written_off",
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
      runType: "AR-WRITEOFF-UNCOLLECTIBLE",
      runVersion: 1,
    });
  },

  /**
   * The entry reverses and the invoice balance comes back. The proposal rows
   * stay, because the fact that a write off was prepared and then reversed is
   * exactly the history a reviewer needs.
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

/**
 * Which of the two standing decisions applies. The customer level flag is
 * checked first, because a client who has decided not to pursue a customer at
 * all has decided about every invoice of that customer.
 */
function authorityFor(customer: CustomerRow, inv: InvoiceRow): Authority {
  if (customer.doNotPursue) return "do_not_pursue";
  if (inv.writeoffApproved) return "manual_approve";
  return null;
}

function proposalRow(
  frozen: FrozenScope<WriteoffScope>,
  id: Ulid,
  inv: InvoiceRow,
  asOf: string,
  age: number,
  open: Cents,
  parts: { net: Cents; tax: Cents },
  method: "allowance" | "direct",
  route: "preparer_and_lead" | "partner",
  authority: Authority,
  state: "proposed" | "posted",
  postedEntryId: Ulid | null,
): Proposal {
  return {
    kind: "row_insert",
    table: "writeoff_proposals",
    rowId: id,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      invoiceId: inv.id,
      customerId: inv.customerId,
      asOfDate: asOf,
      ageDays: age,
      openBalanceCents: open,
      netCents: parts.net,
      taxCents: parts.tax,
      method,
      approvalRoute: route,
      authority,
      collectionAttempts: inv.collectionAttempts,
      state,
      postedEntryId,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

/**
 * The write off entry. Bad debt or the allowance takes the revenue portion, the
 * sales tax account takes back the tax that was never collected, and the
 * receivable control account is credited for the whole open balance.
 */
function entryFor(
  policy: ArapPolicy,
  inv: InvoiceRow,
  asOf: string,
  parts: { net: Cents; tax: Cents },
  debitAccount: string,
): ProposedJournalEntry {
  const memo = `Write off invoice ${inv.invoiceNumber}`;
  const lines: ProposedLine[] = [
    {
      accountNumber: debitAccount,
      categoryId: null,
      amountCents: parts.net,
      memo,
      dimensions: {},
    },
  ];
  if (parts.tax > ZERO && policy.accounts.salesTax !== null) {
    lines.push({
      accountNumber: policy.accounts.salesTax,
      categoryId: null,
      amountCents: parts.tax,
      memo: `Sales tax reversed on ${inv.invoiceNumber}`,
      dimensions: {},
    });
  }
  lines.push({
    accountNumber: inv.arAccount || policy.accounts.arControl,
    categoryId: null,
    amountCents: -(parts.net + parts.tax),
    memo,
    dimensions: {},
  });
  return {
    kind: "journal_entry",
    targetId: derivedId(`${inv.id}:${asOf}`, "ar-writeoff-uncollectible", 1),
    entryDate: asOf,
    lines,
    sourceRef: { table: "invoices", rowId: inv.id, version: inv.version },
  };
}
