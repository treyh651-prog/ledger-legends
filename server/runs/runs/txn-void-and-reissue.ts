/**
 * TXN-VOID-AND-REISSUE. Kill a transaction and insert a corrected
 * replacement linked back to it.
 *
 * The void side is identical to TXN-VOID (buildVoidProposals, reused
 * directly) with one addition: the original row's field write also sets
 * void_of_transaction_id to the replacement's id, a same-row forward
 * pointer so the UI can show "voided, reissued as [link]" with no reverse
 * query. The new row carries reissue_of_transaction_id back at the
 * original -- the natural, unambiguous reading, and the convention every
 * other *_of_transaction_id field on this row already follows
 * (duplicate_of_transaction_id, settlement_of_transaction_id: always on the
 * derived row, pointing at the source row).
 *
 * The new row carries its original coding forward (categoryId,
 * categoryVersion, cascadeLevel, ruleId, ruleVersion, matchedConditions)
 * with journalEntryId left null. TXN-POST-CODED's own skip conditions only
 * check categoryId !== null plus the four "claimed by a different cascade
 * step" fields (all null here), so it posts the replacement automatically
 * on its next run -- no new trigger needed. Every bank-feed/import-lineage
 * field, every reconciliation field, and every suspense/pairing/duplicate
 * field is cleared instead of carried forward: the replacement is not an
 * import, has not cleared the bank, and has not been matched to anything.
 */

import { z } from "zod";
import {
  isFieldWrite,
  isJournalEntry,
  makeResult,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { canonicalJson, derivedId, scopeHashFor } from "../ids";
import { applyReversalDating, reverseEntry, revertFieldWrite } from "../undo";
import type { TransactionRow } from "../tables";
import { buildVoidProposals } from "./txn-void";

export const reissueCorrectionsSchema = z.object({
  postedDate: z.string().min(1).optional(),
  // A plain number, not z.bigint(): the scope arrives as parsed JSON over
  // HTTP, which has no bigint, and JSON.stringify throws on one client side
  // before the request is even sent. amountCents is cast to Cents below,
  // the same safe-integer-number-on-the-wire convention centsSchema uses
  // for every amount a screen reads (shared/api/common.ts).
  amountCents: z.number().int().safe().optional(),
  description: z.string().min(1).optional(),
});

export const voidAndReissueScopeSchema = z.object({
  clientId: z.string().min(1),
  transactionId: z.string().min(1),
  reason: z.string().min(1),
  corrections: reissueCorrectionsSchema,
});

export type VoidAndReissueScope = z.infer<typeof voidAndReissueScopeSchema>;

export function reissuedTransactionIdFor(transactionId: string): string {
  return derivedId(transactionId, "txn-void-and-reissue", 0);
}

/** True when at least one correction actually differs from the original. */
function correctsSomething(t: TransactionRow, corrections: VoidAndReissueScope["corrections"]): boolean {
  if (corrections.postedDate !== undefined && corrections.postedDate !== t.postedDate) return true;
  if (corrections.amountCents !== undefined && BigInt(corrections.amountCents) !== t.amountCents) return true;
  if (corrections.description !== undefined && corrections.description !== t.description) return true;
  return false;
}

function reissuedRow(t: TransactionRow, newId: string, corrections: VoidAndReissueScope["corrections"]): TransactionRow {
  return {
    ...t,
    id: newId,
    postedDate: corrections.postedDate ?? t.postedDate,
    amountCents: corrections.amountCents !== undefined ? BigInt(corrections.amountCents) : t.amountCents,
    description: corrections.description ?? t.description,
    bankMerchantName: t.bankMerchantName,
    checkNumber: null,
    bankCode: null,
    institutionId: null,
    bankTransactionId: null,
    source: "conversion",
    importBatchId: null,
    stagedRowId: null,
    journalEntryId: null,
    cleared: false,
    clearedDate: null,
    statementId: null,
    statementLineId: null,
    statementDate: null,
    matchTier: null,
    matchConfidence: null,
    recBatchId: null,
    staleFlagged: false,
    staleFlaggedOn: null,
    staleOwner: null,
    staleEscalatesOn: null,
    escheatReview: false,
    suspenseReason: null,
    suspenseOwner: null,
    suspenseOpenedOn: null,
    suspenseEscalatesOn: null,
    pairedWithId: null,
    settlementOfTransactionId: null,
    isProcessorSettlement: false,
    duplicateFlag: false,
    duplicateOfTransactionId: null,
    legitimateRepeat: false,
    templateId: null,
    templateVersion: null,
    voided: false,
    voidOfTransactionId: null,
    reissueOfTransactionId: t.id,
    status: "active",
    version: 1,
    manualOverride: t.manualOverride,
    manualOverrideBy: t.manualOverrideBy,
    manualOverrideAt: t.manualOverrideAt,
  };
}

export const txnVoidAndReissue: Run<VoidAndReissueScope, Proposal> = {
  type: "TXN-VOID-AND-REISSUE",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:txn-void-and-reissue:${scope.transactionId}`,
  scopeSchema: voidAndReissueScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<VoidAndReissueScope>> {
    const tx = requireTx(ctx);
    const transactions = await tx.query("transactions_by_ids", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      ids: [scope.transactionId],
    });
    const transaction = transactions.find((t) => t.id === scope.transactionId);
    const day = transaction?.postedDate ?? ctx.now.toISOString().slice(0, 10);
    const newId = reissuedTransactionIdFor(scope.transactionId);
    const candidateIds = [scope.transactionId, newId];
    const versions = [
      { id: "TXN-VOID-AND-REISSUE", version: 1 },
      ...(transaction ? [{ id: transaction.id, version: transaction.version }] : []),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: day,
      periodEnd: day,
      candidateIds,
      // period is reused as a free-text discriminator here, the same idiom
      // CFG-CREATE-MAPPING-PROFILE uses for its own field set: two reissues
      // of the same transaction with different corrections must not hash
      // to the same scope.
      scopeHash: scopeHashFor({ candidateIds, versions, period: canonicalJson(scope.corrections) }),
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
        [{ rowId: transaction.id, reason: "already_applied", detail: "already voided or reissued" }],
        [],
        BigInt(0),
      );
    }
    if (!correctsSomething(transaction, scope.corrections)) {
      return refuse(
        "TXN_REISSUE_NO_CHANGE",
        `the corrections for transaction ${transaction.id} do not differ from what is already on the row`,
      );
    }

    const newId = reissuedTransactionIdFor(transaction.id);
    const built = await buildVoidProposals(tx, frozen.firmId, frozen.clientId, transaction, {
      voidOfTransactionId: newId,
    });
    if (built.error !== null) {
      errors.push(built.error);
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "transactions",
      rowId: newId,
      row: reissuedRow(transaction, newId, scope.corrections) as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };
    const plan: Proposal[] = [...built.proposals, insert];

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
    await applyProposals(proposals, ctx, { runType: "TXN-VOID-AND-REISSUE", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isJournalEntry(p) && p.targetId !== null) {
        plan.push(reverseEntry(p, p.targetId));
      } else if (isFieldWrite(p)) {
        plan.push(revertFieldWrite(p));
      }
      // The inserted replacement row is left alone, same convention every
      // CFG-CREATE-* run already follows: inserts are not undone.
    }
    return plan;
  },
};
