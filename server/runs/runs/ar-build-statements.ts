/**
 * AR-BUILD-STATEMENTS. Build a customer statement document for a period end.
 *
 * Spec: docs/02-run-specifications.md Module 5 AR-BUILD-STATEMENTS.
 *
 * The run builds a document and attaches it to the customer record. It does not
 * send it. There is no recipient on the document, no delivery column in the
 * table migration 0014 created, and no external call anywhere in this file. A
 * statement is a record of what is open on a date, and deciding whether to put
 * it in front of a client is a decision a person makes afterward.
 *
 * The wording is banded by the age of the oldest open item and by nothing else.
 * A large account that is entirely current is spoken to neutrally, and an
 * account with one very old item is spoken to plainly. No band threatens a step
 * the firm has no standing to take, and no band asserts a legal consequence,
 * because a bookkeeping service is not counsel and a statement is not a notice.
 *
 * The header foots by construction: opening plus activity equals closing, which
 * migration 0014 also enforces with a check constraint. Closing is measured
 * from the open documents on the date, activity is measured from the documents
 * dated inside the period, and opening is the residual. That choice is recorded
 * in NOTES.md along with the two alternatives that were considered.
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
import { revertFieldWrite } from "../undo";
import type {
  CreditMemoRow,
  CustomerRow,
  InvoiceRow,
  StatementDocumentRow,
} from "../tables";
import { periodWindow } from "./per-shared";
import {
  ageDaysFor,
  basisDateOf,
  creditOpen,
  invoiceIsOpen,
  invoiceOpen,
  messageBandFor,
  messageTextFor,
  resolvePolicy,
  ZERO,
  type ArapPolicy,
} from "./arap-shared";

export const buildStatementsScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type BuildStatementsScope = z.infer<typeof buildStatementsScopeSchema>;

/** One printed line of a statement. */
interface StatementLine {
  itemKind: "invoice" | "payment" | "credit";
  documentId: Ulid;
  documentNumber: string;
  documentDate: string;
  originalCents: Cents;
  appliedCents: Cents;
  openCents: Cents;
  runningBalanceCents: Cents;
}

interface StatementDraft {
  customerId: Ulid;
  statementType: "open_item" | "balance_forward";
  openingBalanceCents: Cents;
  activityCents: Cents;
  closingBalanceCents: Cents;
  messageBand: "neutral" | "reminder" | "firm" | "final_notice";
  messageText: string;
  oldestItemAgeDays: number;
  lines: StatementLine[];
}

export const arBuildStatements: Run<BuildStatementsScope, Proposal> = {
  type: "AR-BUILD-STATEMENTS",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:statements:${scope.period.slice(0, 7)}`,
  scopeSchema: buildStatementsScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<BuildStatementsScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const customers = await tx.query("customers_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const invoices = await tx.query("invoices_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });

    const candidateIds = customers.map((c) => c.id);
    const versions = [
      { id: "AR-BUILD-STATEMENTS", version: 1 },
      ...customers.map((c) => ({ id: c.id, version: c.version })),
      // The invoices are in the version list even though the candidates are
      // customers. A statement is a function of the invoices behind it, so an
      // invoice that moved has to change the hash or a stale statement would
      // deduplicate against the fresh one.
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
        period: window.periodEnd,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: customers.filter((c) => c.manualOverride).map((c) => c.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const statementDate = window.periodEnd;
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
    const memos = await tx.query("credit_memos_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const applications = await tx.query("payment_applications_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const payments = await tx.query("customer_payments_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: window.periodStart,
      to: window.periodEnd,
    });
    const existing = await tx.query("statement_documents_for_date", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      statementDate,
    });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    const locked = isLockedDay(locks, statementDate);
    const invoiceById = new Map(invoices.map((i) => [i.id, i]));
    const priorByCustomer = new Map<string, StatementDocumentRow[]>();
    for (const doc of existing) {
      const list = priorByCustomer.get(doc.customerId) ?? [];
      list.push(doc);
      priorByCustomer.set(doc.customerId, list);
    }

    for (const customer of customers) {
      if (customer.manualOverride) {
        skips.push({
          rowId: customer.id,
          reason: "manual_override",
          detail: `customer ${customer.name} carries manual_override`,
        });
        continue;
      }
      if (customer.statementSuppressed) {
        skips.push({
          rowId: customer.id,
          reason: "missing_prerequisite",
          detail: `statement_suppressed for ${customer.name}`,
        });
        continue;
      }
      if (locked) {
        skips.push({
          rowId: customer.id,
          reason: "locked_period",
          detail: `statement date ${statementDate} falls inside a locked period`,
        });
        continue;
      }

      const draft = buildDraft(
        policy,
        customer,
        invoices,
        memos,
        applications
          .filter(
            (a) =>
              a.state !== "reversed" &&
              a.applicationDate >= window.periodStart &&
              a.applicationDate <= window.periodEnd &&
              invoiceById.get(a.invoiceId)?.customerId === customer.id,
          )
          .map((a) => ({
            paymentId: a.paymentId,
            appliedCents: a.appliedCents,
            applicationDate: a.applicationDate,
          })),
        payments.filter((p) => p.customerId === customer.id),
        statementDate,
        window.periodStart,
      );

      if (draft.lines.length === 0) {
        skips.push({
          rowId: customer.id,
          reason: "missing_prerequisite",
          detail: `no_activity for ${customer.name} through ${statementDate}`,
        });
        continue;
      }
      // A statement for a balance nobody will act on costs the client the time
      // it takes to read. The threshold is policy, and zero means print all.
      if (
        draft.closingBalanceCents < policy.minimumStatementBalanceCents &&
        draft.closingBalanceCents <= ZERO
      ) {
        skips.push({
          rowId: customer.id,
          reason: "missing_prerequisite",
          detail: `below_minimum_balance, closing ${draft.closingBalanceCents.toString()} for ${customer.name}`,
        });
        continue;
      }

      const priors = priorByCustomer.get(customer.id) ?? [];
      const live = priors.filter((d) => d.state === "draft");
      const unchanged = live.find((d) => sameFigures(d, draft));
      if (unchanged !== undefined) {
        skips.push({
          rowId: customer.id,
          reason: "already_applied",
          detail: `statement_unchanged, ${unchanged.id} already states ${draft.closingBalanceCents.toString()} on ${statementDate}`,
        });
        continue;
      }

      // A statement already built for this date that no longer states the truth
      // is superseded rather than edited. A person may have read it, so the
      // record of what it said stays and a new document takes its place.
      for (const stale of live) {
        proposals.push({
          kind: "field_write",
          table: "statement_documents",
          rowId: stale.id,
          before: { state: stale.state },
          after: { state: "superseded" },
          provenance: { cascadeLevel: null },
        });
      }

      const ordinal = priors.length;
      const statementId = derivedId(
        `${customer.id}:${statementDate}`,
        "ar-build-statements",
        ordinal,
      );
      proposals.push({
        kind: "row_insert",
        table: "statement_documents",
        rowId: statementId,
        row: {
          firmId: frozen.firmId,
          clientId: frozen.clientId,
          version: 1,
          customerId: customer.id,
          statementDate,
          statementType: draft.statementType,
          state: "draft",
          openingBalanceCents: draft.openingBalanceCents,
          activityCents: draft.activityCents,
          closingBalanceCents: draft.closingBalanceCents,
          messageBand: draft.messageBand,
          messageText: draft.messageText,
          oldestItemAgeDays: draft.oldestItemAgeDays,
          itemCount: draft.lines.length,
          createdByRunId: RUN_ID_PLACEHOLDER,
          createdAt: NOW_PLACEHOLDER,
          manualOverride: false,
        },
        provenance: { cascadeLevel: null },
      });

      draft.lines.forEach((line, index) => {
        proposals.push({
          kind: "row_insert",
          table: "statement_items",
          rowId: derivedId(
            `${statementId}:${index + 1}`,
            "ar-build-statements",
            index + 1,
          ),
          row: {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            statementId,
            lineNumber: index + 1,
            ...line,
          },
          provenance: { cascadeLevel: null },
        });
      });

      // The attachment. This is the only sense in which the run reaches the
      // customer record: it records which document is current and on what date.
      proposals.push({
        kind: "field_write",
        table: "customers",
        rowId: customer.id,
        before: {
          statementDocumentId: customer.statementDocumentId,
          statementDocumentDate: customer.statementDocumentDate,
        },
        after: {
          statementDocumentId: statementId,
          statementDocumentDate: statementDate,
        },
        provenance: { cascadeLevel: null },
      });
    }

    return makeResult<Proposal>(
      frozen.candidateIds.length,
      proposals,
      skips,
      errors,
      ZERO,
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "AR-BUILD-STATEMENTS",
      runVersion: 1,
    });
  },

  /**
   * The documents stay and the attachment reverts. A statement that was built
   * is a fact about what the books said on a date, and deleting it would remove
   * evidence rather than correct it.
   */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p) && p.table === "customers") {
        plan.push(revertFieldWrite(p));
      }
    }
    return plan;
  },
};

interface AppliedInWindow {
  paymentId: Ulid;
  appliedCents: Cents;
  applicationDate: string;
}

/**
 * Build one customer statement.
 *
 * Closing is measured directly: the open invoices on the date less the
 * unapplied credits. Activity is measured directly: what was billed inside the
 * period, less what was applied inside it, less the credits issued inside it.
 * Opening is then the residual, which is what makes the header foot in every
 * case including the first period a customer exists.
 *
 * Payments print as lines and carry no open amount, so they do not move the
 * running balance a second time. The reduction they caused is already inside
 * the open balance of the invoice they were applied to, and counting them twice
 * would make the column disagree with the header.
 */
function buildDraft(
  policy: ArapPolicy,
  customer: CustomerRow,
  invoices: readonly InvoiceRow[],
  memos: readonly CreditMemoRow[],
  appliedInWindow: readonly AppliedInWindow[],
  paymentsInWindow: readonly {
    id: Ulid;
    paymentDate: string;
    amountCents: Cents;
    appliedCents: Cents;
  }[],
  statementDate: string,
  periodStart: string,
): StatementDraft {
  const mine = invoices.filter(
    (i) => i.customerId === customer.id && i.invoiceDate <= statementDate,
  );
  const openInvoices = mine.filter((i) => invoiceIsOpen(i));
  const myMemos = memos.filter(
    (m) =>
      m.customerId === customer.id &&
      m.status !== "void" &&
      m.memoDate <= statementDate,
  );
  const openMemos = myMemos.filter((m) => creditOpen(m) > ZERO);

  let closing = ZERO;
  for (const i of openInvoices) closing += invoiceOpen(i);
  for (const m of openMemos) closing -= creditOpen(m);

  let activity = ZERO;
  for (const i of mine) {
    if (i.invoiceDate >= periodStart && i.status !== "void" && i.status !== "draft") {
      activity += i.originalAmountCents;
    }
  }
  for (const a of appliedInWindow) activity -= a.appliedCents;
  for (const m of myMemos) {
    if (m.memoDate >= periodStart) activity -= m.amountCents;
  }

  const opening = closing - activity;

  const lines: StatementLine[] = [];
  const sortedInvoices = [...openInvoices].sort((a, b) =>
    a.invoiceDate === b.invoiceDate
      ? a.id < b.id
        ? -1
        : 1
      : a.invoiceDate < b.invoiceDate
        ? -1
        : 1,
  );
  // Opening plus the open invoices and credits equals closing, so the running
  // column starts at opening and the last line reads closing exactly.
  let running = closing - (sumOpen(sortedInvoices) - sumCredits(openMemos));

  for (const p of [...paymentsInWindow].sort((a, b) =>
    a.paymentDate === b.paymentDate
      ? a.id < b.id
        ? -1
        : 1
      : a.paymentDate < b.paymentDate
        ? -1
        : 1,
  )) {
    lines.push({
      itemKind: "payment",
      documentId: p.id,
      documentNumber: `PAY ${p.paymentDate}`,
      documentDate: p.paymentDate,
      originalCents: p.amountCents,
      appliedCents: p.appliedCents,
      openCents: ZERO,
      runningBalanceCents: running,
    });
  }

  for (const i of sortedInvoices) {
    const open = invoiceOpen(i);
    running += open;
    lines.push({
      itemKind: "invoice",
      documentId: i.id,
      documentNumber: i.invoiceNumber,
      documentDate: i.invoiceDate,
      originalCents: i.originalAmountCents,
      appliedCents:
        i.appliedPaymentsCents + i.appliedCreditsCents + i.writtenOffCents,
      openCents: open,
      runningBalanceCents: running,
    });
  }

  for (const m of openMemos) {
    const open = creditOpen(m);
    running -= open;
    lines.push({
      itemKind: "credit",
      documentId: m.id,
      documentNumber: m.memoNumber,
      documentDate: m.memoDate,
      originalCents: m.amountCents,
      appliedCents: m.appliedCents,
      openCents: -open,
      runningBalanceCents: running,
    });
  }

  let oldest = 0;
  for (const i of openInvoices) {
    const age = ageDaysFor(
      basisDateOf(policy, i.invoiceDate, i.dueDate),
      statementDate,
    );
    if (age > oldest) oldest = age;
  }
  const band = messageBandFor(oldest);

  return {
    customerId: customer.id,
    statementType: customer.statementType ?? policy.statementType,
    openingBalanceCents: opening,
    activityCents: activity,
    closingBalanceCents: closing,
    messageBand: band,
    messageText: messageTextFor(policy, band),
    oldestItemAgeDays: oldest,
    lines,
  };
}

function sumOpen(invoices: readonly InvoiceRow[]): Cents {
  let total = ZERO;
  for (const i of invoices) total += invoiceOpen(i);
  return total;
}

function sumCredits(memos: readonly CreditMemoRow[]): Cents {
  let total = ZERO;
  for (const m of memos) total += creditOpen(m);
  return total;
}

/** Whether a statement already on file says the same thing as a fresh draft. */
function sameFigures(doc: StatementDocumentRow, draft: StatementDraft): boolean {
  return (
    doc.customerId === draft.customerId &&
    doc.openingBalanceCents === draft.openingBalanceCents &&
    doc.activityCents === draft.activityCents &&
    doc.closingBalanceCents === draft.closingBalanceCents &&
    doc.messageBand === draft.messageBand &&
    doc.itemCount === draft.lines.length &&
    doc.oldestItemAgeDays === draft.oldestItemAgeDays
  );
}
