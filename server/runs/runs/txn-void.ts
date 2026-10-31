/**
 * TXN-VOID. Kill a transaction outright -- no replacement.
 *
 * ledger.transactions has carried voided, void_of_transaction_id, and
 * reissue_of_transaction_id since migration 0011, and nothing has ever
 * written any of the three: transactions.tsx is 100% read only by design
 * comment ("Recategorizing a transaction is a run, not a browser edit, so
 * this screen has no category pickers until that run exists" -- the same
 * reasoning applies to voiding).
 *
 * If the transaction was already posted (journal_entry_id set), this run
 * reverses that entry the same way PER-REVERSE-ACCRUALS reverses a posted
 * accrual: by reading the entry's own stored lines back from the ledger and
 * mirroring every sign, not by replaying an in-memory proposal. undo.ts's
 * own makeUndoRun/executeUndo cannot serve a void -- "Undo is refused, not
 * forced... A run is the unit of reversal" (undo.ts's own file comment), and
 * TXN-POST-CODED's one execution can post many transactions in the same run,
 * so undoing that execution would un-post every one of them, not just this
 * row. A void has to reverse one transaction's own entry directly.
 *
 * Voiding an already cleared or reconciled transaction is allowed, not
 * blocked -- a deliberate product decision, even though migration 0011's own
 * comment on batch reversal ("reversible as a unit until any row in it is
 * reconciled") suggests the opposite precedent. The firm's UI carries the
 * warning instead of this run refusing on it.
 */

import { z } from "zod";
import {
  isFieldWrite,
  isJournalEntry,
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
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import type { RunTx } from "../db";
import { derivedId, scopeHashFor } from "../ids";
import { applyReversalDating, reverseEntry, revertFieldWrite } from "../undo";
import type { JournalEntryRow, JournalLineRow, TransactionRow } from "../tables";

export function voidReversalEntryIdFor(transactionId: string): string {
  return derivedId(transactionId, "txn-void", 0);
}

export const voidScopeSchema = z.object({
  clientId: z.string().min(1),
  transactionId: z.string().min(1),
  reason: z.string().min(1),
});

export type VoidScope = z.infer<typeof voidScopeSchema>;

/**
 * The mirror image of a posted entry, read back from its own stored lines --
 * the same shape PER-REVERSE-ACCRUALS builds in reversalFor, because that is
 * the only honest way to reverse what was actually posted rather than what a
 * template says should have been.
 */
export function reversalOfPostedEntry(
  original: JournalEntryRow,
  originalLines: readonly JournalLineRow[],
  entryDate: string,
  transactionId: string,
): ProposedJournalEntry {
  const lines: ProposedLine[] = originalLines.map((l) => ({
    accountNumber: l.accountNumber,
    categoryId: l.categoryId,
    amountCents: -l.amountCents,
    memo: `voided: ${l.memo}`,
    dimensions: {
      ...(l.classId === null ? {} : { classId: l.classId }),
      ...(l.locationId === null ? {} : { locationId: l.locationId }),
      ...(l.programId === null ? {} : { programId: l.programId }),
    },
  }));
  return {
    kind: "journal_entry",
    targetId: voidReversalEntryIdFor(transactionId),
    entryDate,
    lines,
    reversalOf: original.id,
    sourceRef: { table: original.sourceTable, rowId: original.sourceRowId, version: original.sourceVersion },
  };
}

/**
 * The field write every void makes on the original row. TXN-VOID-AND-REISSUE
 * reuses this with voidOfTransactionId in extra so the one write carries both
 * changes, rather than two field writes racing on the same row.
 */
export function voidWrite(t: TransactionRow, extra: Record<string, unknown> = {}): ProposedFieldWrite {
  return {
    kind: "field_write",
    table: "transactions",
    rowId: t.id,
    before: { voided: t.voided, status: t.status, voidOfTransactionId: t.voidOfTransactionId },
    after: { voided: true, status: "reversed", voidOfTransactionId: t.voidOfTransactionId, ...extra },
    provenance: { cascadeLevel: null },
  };
}

/**
 * The void-side proposals any void makes on the original row: the field
 * write, plus a reversal of its posted entry if it had one. Shared with
 * TXN-VOID-AND-REISSUE so the "load the entry, reverse it" logic exists
 * once. extraFieldWrite lets the reissue run fold voidOfTransactionId into
 * the same write instead of a second one racing on the same row.
 */
export async function buildVoidProposals(
  tx: RunTx,
  firmId: string,
  clientId: string,
  transaction: TransactionRow,
  extraFieldWrite: Record<string, unknown> = {},
): Promise<{ proposals: Proposal[]; error: RunError | null }> {
  const proposals: Proposal[] = [voidWrite(transaction, extraFieldWrite)];
  if (transaction.journalEntryId !== null) {
    const entries = await tx.query("journal_entries_for_client", { firmId, clientId });
    const original = entries.find((e) => e.id === transaction.journalEntryId);
    if (!original) {
      return {
        proposals: [],
        error: {
          rowId: transaction.id,
          code: "TXN_VOID_ENTRY_MISSING",
          message: `transaction ${transaction.id} names journal entry ${transaction.journalEntryId} which does not exist`,
          retryable: false,
        },
      };
    }
    const lines = await tx.query("journal_lines_for_entries", {
      firmId,
      clientId,
      entryIds: [original.id],
    });
    proposals.push(reversalOfPostedEntry(original, lines, transaction.postedDate, transaction.id));
  }
  return { proposals, error: null };
}

export const txnVoid: Run<VoidScope, Proposal> = {
  type: "TXN-VOID",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:txn-void:${scope.transactionId}`,
  scopeSchema: voidScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<VoidScope>> {
    const tx = requireTx(ctx);
    const transactions = await tx.query("transactions_by_ids", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      ids: [scope.transactionId],
    });
    const transaction = transactions.find((t) => t.id === scope.transactionId);
    const day = transaction?.postedDate ?? ctx.now.toISOString().slice(0, 10);
    const candidateIds = [scope.transactionId];
    const versions = [
      { id: "TXN-VOID", version: 1 },
      ...(transaction ? [{ id: transaction.id, version: transaction.version }] : []),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: day,
      periodEnd: day,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const refuse = (code: string, message: string): RunResult<Proposal> => {
      errors.push({ rowId: scope.transactionId, code, message, retryable: false });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    };

    const transactions = await tx.query("transactions_by_ids", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      ids: [scope.transactionId],
    });
    const transaction = transactions.find((t) => t.id === scope.transactionId);
    if (!transaction) {
      return refuse("TXN_VOID_UNKNOWN_TRANSACTION", `transaction ${scope.transactionId} does not belong to client ${frozen.clientId}`);
    }
    if (transaction.voided) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: transaction.id, reason: "already_applied", detail: "already voided" }],
        [],
        BigInt(0),
      );
    }

    const built = await buildVoidProposals(tx, frozen.firmId, frozen.clientId, transaction);
    if (built.error !== null) {
      errors.push(built.error);
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }
    const plan = built.proposals;

    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const dated = applyReversalDating(plan, locks);
    if (dated.errors.length > 0) {
      return makeResult<Proposal>(1, [], [], dated.errors, BigInt(0));
    }

    let net: Cents = BigInt(0);
    for (const p of dated.plan) {
      if (!isJournalEntry(p)) continue;
      for (const line of p.lines) net += line.amountCents;
    }
    return makeResult<Proposal>(1, dated.plan, [], [], net);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "TXN-VOID", runVersion: 1 });
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
