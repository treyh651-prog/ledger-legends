/**
 * ARAP-REFRESH-AGING. Rebuild the aging buckets for a period end date.
 *
 * Spec: docs/02-run-specifications.md Module 5 ARAP-REFRESH-AGING, with the
 * receivable and payable subledger added by migration 0014.
 *
 * An aging report is the answer to one question asked at one moment: on this
 * date, how much is open, whose is it, and how late is it. That makes the as of
 * date part of the identity of every row it produces. Two aging runs against
 * two dates are two different reports and neither supersedes the other, which
 * is why the date is in the derived id and in the scope hash.
 *
 * The run posts nothing. It never touches a journal entry, never moves a
 * balance, and never marks an invoice. It writes snapshot rows and one tie row
 * per side, and the tie row is the point of the whole exercise: a subledger
 * that does not agree with its control account is a subledger nobody can rely
 * on, and the difference has to be stated rather than discovered later by a
 * person footing a report by hand.
 *
 * Idempotency is by content. A second execution against the same date computes
 * the same rows, finds them already present, and reports them as already
 * applied. A second execution after an invoice moved computes a different open
 * balance for that invoice and writes the changed fields in place, because two
 * snapshot rows for one document on one date would make the report ambiguous.
 */

import { z } from "zod";
import {
  isFieldWrite,
  makeResult,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import { applyProposals, NOW_PLACEHOLDER, RUN_ID_PLACEHOLDER, requireTx } from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { AgingSnapshotRow, JournalLineRow } from "../tables";
import { periodWindow } from "./per-shared";
import {
  ageDaysFor,
  basisDateOf,
  billIsOpen,
  billOpen,
  bucketFor,
  creditOpen,
  invoiceIsOpen,
  invoiceOpen,
  resolvePolicy,
  sumArapCents,
  ZERO,
  type ArapPolicy,
  type ArapSide,
} from "./arap-shared";

export const AGING_ERROR_CODES = {
  missingControl: "ARAP_AGING_CONTROL_ACCOUNT_MISSING",
} as const;

export const refreshAgingScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  /** Which side to age. Both is the default because a close needs both. */
  side: z.enum(["receivable", "payable", "both"]).default("both"),
});

export type RefreshAgingScope = z.infer<typeof refreshAgingScopeSchema>;

/** What one snapshot row says. Compared field by field to decide a rewrite. */
interface SnapshotContent {
  side: ArapSide;
  agingBasis: "due_date" | "invoice_date";
  partyId: Ulid | null;
  partyName: string;
  documentId: Ulid | null;
  documentNumber: string | null;
  documentDate: string | null;
  basisDate: string | null;
  ageDays: number | null;
  bucket: string;
  openBalanceCents: Cents;
  controlAccount: string | null;
  controlBalanceCents: Cents | null;
  tieDifferenceCents: Cents | null;
  subledgerOutOfTie: boolean;
}

export const arapRefreshAging: Run<RefreshAgingScope, Proposal> = {
  type: "ARAP-REFRESH-AGING",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:aging:${scope.period.slice(0, 7)}`,
  scopeSchema: refreshAgingScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<RefreshAgingScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const invoices = await tx.query("invoices_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const bills = await tx.query("bills_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const memos = await tx.query("credit_memos_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });

    const wantAr = scope.side !== "payable";
    const wantAp = scope.side !== "receivable";
    const candidateIds = [
      ...(wantAr ? invoices.map((i) => i.id) : []),
      ...(wantAr ? memos.map((m) => m.id) : []),
      ...(wantAp ? bills.map((b) => b.id) : []),
    ];
    const versions = [
      { id: "ARAP-REFRESH-AGING", version: 1 },
      ...(wantAr ? invoices.map((i) => ({ id: i.id, version: i.version })) : []),
      ...(wantAr ? memos.map((m) => ({ id: m.id, version: m.version })) : []),
      ...(wantAp ? bills.map((b) => ({ id: b.id, version: b.version })) : []),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // The as of date is in the hash. The same invoices at the same versions
      // aged on two dates are two different reports, and without the date the
      // second one would key to the first and be deduplicated away.
      scopeHash: scopeHashFor({
        period: window.periodEnd,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: [
        ...invoices.filter((i) => i.manualOverride).map((i) => i.id),
        ...memos.filter((m) => m.manualOverride).map((m) => m.id),
        ...bills.filter((b) => b.manualOverride).map((b) => b.id),
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
    const vendors = await tx.query("vendors_for_client", {
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
    const bills = await tx.query("bills_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const existing = await tx.query("aging_snapshots_for_date", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      asOfDate: asOf,
    });
    const lines = await tx.query("journal_lines_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    const byId = new Map<string, AgingSnapshotRow>(
      existing.map((r) => [r.id, r]),
    );
    const customerName = new Map(customers.map((c) => [c.id, c.name]));
    const vendorName = new Map(vendors.map((v) => [v.id, v.legalName]));
    const wantAr = frozen.input.side !== "payable";
    const wantAp = frozen.input.side !== "receivable";

    // A snapshot dated inside a locked period is still a write, so the lock
    // decides here exactly as it does for a run that posts. Nothing is written
    // and every candidate says why.
    const locked = isLockedDay(locks, asOf);

    const contents: { id: Ulid; content: SnapshotContent; source: Ulid }[] = [];
    const arOpen: Cents[] = [];
    const apOpen: Cents[] = [];

    if (wantAr) {
      for (const inv of invoices) {
        if (inv.manualOverride) {
          skips.push({
            rowId: inv.id,
            reason: "manual_override",
            detail: `invoice ${inv.invoiceNumber} carries manual_override`,
          });
          continue;
        }
        // An invoice dated after the as of date did not exist on that date.
        if (inv.invoiceDate > asOf) {
          skips.push({
            rowId: inv.id,
            reason: "out_of_scope_engagement",
            detail: `document_after_as_of, invoice ${inv.invoiceNumber} is dated ${inv.invoiceDate}`,
          });
          continue;
        }
        if (!invoiceIsOpen(inv)) {
          skips.push({
            rowId: inv.id,
            reason: "already_applied",
            detail: `document_closed, invoice ${inv.invoiceNumber} has no open balance`,
          });
          continue;
        }
        const basisDate = basisDateOf(policy, inv.invoiceDate, inv.dueDate);
        const ageDays = ageDaysFor(basisDate, asOf);
        const open = invoiceOpen(inv);
        arOpen.push(open);
        contents.push({
          id: snapshotId(asOf, "receivable", inv.id),
          source: inv.id,
          content: {
            side: "receivable",
            agingBasis: policy.agingBasis,
            partyId: inv.customerId,
            partyName: customerName.get(inv.customerId) ?? inv.customerId,
            documentId: inv.id,
            documentNumber: inv.invoiceNumber,
            documentDate: inv.invoiceDate,
            basisDate,
            ageDays,
            bucket: bucketFor(ageDays),
            openBalanceCents: open,
            controlAccount: null,
            controlBalanceCents: null,
            tieDifferenceCents: null,
            subledgerOutOfTie: false,
          },
        });
      }

      // An unapplied credit memo is a negative receivable. It goes in its own
      // line rather than into a bucket, because a credit is not late and
      // netting it against the oldest bucket would hide a real overdue invoice.
      for (const memo of memos) {
        if (memo.manualOverride) {
          skips.push({
            rowId: memo.id,
            reason: "manual_override",
            detail: `credit memo ${memo.memoNumber} carries manual_override`,
          });
          continue;
        }
        if (memo.status === "void" || memo.memoDate > asOf) continue;
        const open = creditOpen(memo);
        if (open <= ZERO) continue;
        arOpen.push(-open);
        contents.push({
          id: snapshotId(asOf, "receivable", memo.id),
          source: memo.id,
          content: {
            side: "receivable",
            agingBasis: policy.agingBasis,
            partyId: memo.customerId,
            partyName: customerName.get(memo.customerId) ?? memo.customerId,
            documentId: memo.id,
            documentNumber: memo.memoNumber,
            documentDate: memo.memoDate,
            basisDate: memo.memoDate,
            ageDays: null,
            bucket: "credits",
            openBalanceCents: -open,
            controlAccount: null,
            controlBalanceCents: null,
            tieDifferenceCents: null,
            subledgerOutOfTie: false,
          },
        });
      }
    }

    if (wantAp) {
      for (const bill of bills) {
        if (bill.manualOverride) {
          skips.push({
            rowId: bill.id,
            reason: "manual_override",
            detail: `bill ${bill.billNumber} carries manual_override`,
          });
          continue;
        }
        if (bill.billDate > asOf) {
          skips.push({
            rowId: bill.id,
            reason: "out_of_scope_engagement",
            detail: `document_after_as_of, bill ${bill.billNumber} is dated ${bill.billDate}`,
          });
          continue;
        }
        if (!billIsOpen(bill)) {
          skips.push({
            rowId: bill.id,
            reason: "already_applied",
            detail: `document_closed, bill ${bill.billNumber} has no open balance`,
          });
          continue;
        }
        const basisDate = basisDateOf(policy, bill.billDate, bill.dueDate);
        const ageDays = ageDaysFor(basisDate, asOf);
        const open = billOpen(bill);
        apOpen.push(open);
        contents.push({
          id: snapshotId(asOf, "payable", bill.id),
          source: bill.id,
          content: {
            side: "payable",
            agingBasis: policy.agingBasis,
            partyId: bill.vendorId,
            partyName: vendorName.get(bill.vendorId) ?? bill.vendorId,
            documentId: bill.id,
            documentNumber: bill.billNumber,
            documentDate: bill.billDate,
            basisDate,
            ageDays,
            bucket: bucketFor(ageDays),
            openBalanceCents: open,
            controlAccount: null,
            controlBalanceCents: null,
            tieDifferenceCents: null,
            subledgerOutOfTie: false,
          },
        });
      }
    }

    // The tie rows. One per side, carrying the control balance on the as of
    // date and the signed difference. Absence of a control account is reported
    // rather than assumed, because a tie against an account nobody named is not
    // a tie at all.
    if (wantAr) {
      const control = policy.accounts.arControl;
      const balance = controlBalance(lines, control, asOf);
      const sub = sumArapCents(arOpen);
      contents.push({
        id: tieId(asOf, "receivable"),
        source: frozen.clientId,
        content: tieContent(policy, "receivable", control, balance, sub),
      });
    }
    if (wantAp) {
      const control = policy.accounts.apControl;
      const balance = controlBalance(lines, control, asOf);
      // A payable control account carries a credit balance, which is negative
      // in this ledger's sign convention, so the subledger total is compared
      // against the negated balance and not against the raw one.
      const sub = sumArapCents(apOpen);
      contents.push({
        id: tieId(asOf, "payable"),
        source: frozen.clientId,
        content: tieContent(policy, "payable", control, -balance, sub),
      });
    }

    for (const item of contents) {
      if (locked) {
        skips.push({
          rowId: item.source,
          reason: "locked_period",
          detail: `as of date ${asOf} falls inside a locked period`,
        });
        continue;
      }
      const prior = byId.get(item.id);
      if (prior === undefined) {
        proposals.push(insertSnapshot(frozen, asOf, item.id, item.content));
        continue;
      }
      if (prior.manualOverride) {
        skips.push({
          rowId: item.source,
          reason: "manual_override",
          detail: `aging row ${item.id} carries manual_override`,
        });
        continue;
      }
      const changed = changedFields(prior, item.content);
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId: item.source,
          reason: "already_applied",
          detail: `aging_row_unchanged for ${item.id} on ${asOf}`,
        });
        continue;
      }
      proposals.push({
        kind: "field_write",
        table: "aging_snapshots",
        rowId: item.id,
        before: changed.before,
        after: changed.after,
        // An aging row is not a coding decision, so it claims no cascade level,
        // on the same reasoning the reconciliation writes use.
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
      runType: "ARAP-REFRESH-AGING",
      runVersion: 1,
    });
  },

  /**
   * An aging snapshot is a record of a reading, and the reading did happen.
   * Withdrawing the inserted rows would leave a client unable to reproduce a
   * report someone already looked at, so the inserts stand and only the field
   * writes revert. This is the same choice the tiered matcher makes about the
   * reconciliation batch it opened.
   */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

function snapshotId(asOf: string, side: ArapSide, documentId: Ulid): Ulid {
  return derivedId(`${asOf}:${side}:${documentId}`, "arap-refresh-aging", 0);
}

function tieId(asOf: string, side: ArapSide): Ulid {
  return derivedId(`${asOf}:${side}:tie`, "arap-refresh-aging", 1);
}

function tieContent(
  policy: ArapPolicy,
  side: ArapSide,
  control: string,
  controlBalanceCents: Cents,
  subledgerTotal: Cents,
): SnapshotContent {
  const difference = subledgerTotal - controlBalanceCents;
  return {
    side,
    agingBasis: policy.agingBasis,
    partyId: null,
    partyName: side === "receivable" ? "Receivable control" : "Payable control",
    documentId: null,
    documentNumber: null,
    documentDate: null,
    basisDate: null,
    ageDays: null,
    bucket: "tie",
    openBalanceCents: subledgerTotal,
    controlAccount: control,
    controlBalanceCents,
    tieDifferenceCents: difference,
    subledgerOutOfTie: difference !== ZERO,
  };
}

/**
 * The control account balance on a date. Every line on or before the as of date
 * counts and nothing after it does, because an aging report on the 31st cannot
 * be affected by an entry dated the 1st of the following month.
 */
function controlBalance(
  lines: readonly JournalLineRow[],
  account: string,
  asOf: string,
): Cents {
  let total = ZERO;
  for (const l of lines) {
    if (l.accountNumber === account && l.entryDate <= asOf) {
      total += l.amountCents;
    }
  }
  return total;
}

function insertSnapshot(
  frozen: FrozenScope<RefreshAgingScope>,
  asOf: string,
  id: Ulid,
  content: SnapshotContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "aging_snapshots",
    rowId: id,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      asOfDate: asOf,
      ...content,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

/**
 * Only the fields that actually moved. Writing the whole row every time would
 * make every rerun look like a change and would bury the one number that moved
 * under nine that did not.
 */
function changedFields(
  prior: AgingSnapshotRow,
  next: SnapshotContent,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const keys = Object.keys(next) as (keyof SnapshotContent)[];
  for (const k of keys) {
    const priorValue = (prior as unknown as Record<string, unknown>)[k];
    if (priorValue !== next[k]) {
      before[k] = priorValue;
      after[k] = next[k];
    }
  }
  return { before, after };
}
