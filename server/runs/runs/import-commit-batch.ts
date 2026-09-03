/**
 * IMPORT-COMMIT-BATCH. Commit a reviewed staging batch into the register.
 *
 * Spec: docs/05-decisions.md Part 3 decision D2, and docs/02-run-specifications.md
 * Module 3. The rules this run exists to hold:
 *
 *   1. A batch commits as a named unit. Every register row it creates carries
 *      the batch id, so the batch can be reversed as a unit later.
 *   2. Dedup is checked again here against the register, on the bank supplied
 *      id, because time passed between parsing and committing and another feed
 *      may have delivered the same transaction in between.
 *   3. A row held for review is not committed until a person accepts it. That
 *      is the hold for review rule and it is the reason a held row is a skip
 *      and not an error: the batch is fine, one row is waiting on a human.
 *   4. A batch is reversible as a unit until any row in it is reconciled. Once
 *      a row clears on a reconciliation, reversal is blocked.
 *
 * Posting: Yes. This run writes ledger data, because a register row is the
 * client's book of bank facts. It posts no journal entry, because an uncoded
 * transaction has no debit and credit yet. The coding cascade posts the entry
 * once it has a category, and the entry links back through journal_entry_id.
 */

import { z } from "zod";
import {
  makeResult,
  isFieldWrite,
  isJournalEntry,
  isRowInsert,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedRowInsert,
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
import type { StagedRowRow, TransactionRow } from "../tables";
import {
  DESCRIPTOR_NORMALIZATION_VERSION,
  normalizeDescriptor,
} from "./import-parse-feed";

export const COMMIT_ERROR_CODES = {
  unknownBatch: "UNKNOWN_IMPORT_BATCH",
  batchNotReady: "IMPORT_BATCH_NOT_READY",
  unknownBankAccount: "UNKNOWN_BANK_ACCOUNT",
  reversalBlocked: "BATCH_REVERSAL_BLOCKED",
} as const;

/** Batch statuses a commit is allowed to start from. */
export const COMMITTABLE_STATUSES = ["parsed", "in_review"] as const;

export const commitBatchScopeSchema = z.object({
  clientId: z.string().min(1),
  batchId: z.string().min(1),
});

export type CommitBatchScope = z.infer<typeof commitBatchScopeSchema>;

/** Register id for a staged row. Derived so preview and apply agree exactly. */
export function registerIdFor(batchId: Ulid, rowNumber: number): Ulid {
  return derivedId(batchId, "register_row", rowNumber);
}

export const importCommitBatch: Run<CommitBatchScope, Proposal> = {
  type: "IMPORT-COMMIT-BATCH",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.batchId}`,
  scopeSchema: commitBatchScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CommitBatchScope>> {
    const tx = requireTx(ctx);
    const batches = await tx.query("import_batch_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      batchId: scope.batchId,
    });
    const staged = await tx.query("staged_rows_by_batch", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      batchId: scope.batchId,
    });

    const dates = staged
      .map((r) => r.postedOn)
      .filter((d): d is string => d !== null)
      .sort();

    // Every staged row is a candidate, including the ones that will be skipped,
    // so the counts in the run log add up to the file.
    const candidateIds = staged.map((r) => r.id);
    const runDay = ctx.now.toISOString().slice(0, 10);
    const versions = [
      { id: "IMPORT-COMMIT-BATCH", version: 1 },
      {
        id: "DESCRIPTOR-NORMALIZATION",
        version: DESCRIPTOR_NORMALIZATION_VERSION,
      },
      ...batches.map((b) => ({ id: b.id, version: b.version })),
      ...staged.map((r) => ({ id: r.id, version: r.version })),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: dates[0] ?? runDay,
      periodEnd: dates[dates.length - 1] ?? runDay,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const batches = await tx.query("import_batch_by_id", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      batchId: scope.batchId,
    });
    if (batches.length === 0) {
      errors.push({
        rowId: scope.batchId,
        code: COMMIT_ERROR_CODES.unknownBatch,
        message: `import batch ${scope.batchId} does not exist for client ${frozen.clientId}`,
        retryable: false,
      });
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        [],
        skips,
        errors,
        BigInt(0),
      );
    }
    const batch = batches[0];

    if (!COMMITTABLE_STATUSES.some((s) => s === batch.status)) {
      // Committed, reversed, rejected, failed or still parsing. All refusals,
      // and none of them are retryable by the same operator press.
      errors.push({
        rowId: batch.id,
        code: COMMIT_ERROR_CODES.batchNotReady,
        message: `batch ${batch.id} is ${batch.status}, and only ${COMMITTABLE_STATUSES.join(" or ")} can be committed`,
        retryable: false,
      });
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        [],
        skips,
        errors,
        BigInt(0),
      );
    }

    const accounts = await tx.query("bank_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const account = accounts.find((a) => a.id === batch.bankAccountId);
    if (!account) {
      errors.push({
        rowId: batch.id,
        code: COMMIT_ERROR_CODES.unknownBankAccount,
        message: `batch ${batch.id} names bank account ${batch.bankAccountId} which is not on this client`,
        retryable: false,
      });
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        [],
        skips,
        errors,
        BigInt(0),
      );
    }

    const staged = await tx.query("staged_rows_by_batch", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      batchId: scope.batchId,
    });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    const feedBankIds = staged
      .map((r) => r.bankTransactionId)
      .filter((id): id is string => id !== null);
    const posted =
      feedBankIds.length === 0
        ? []
        : await tx.query("transactions_by_bank_ids", {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            bankAccountId: batch.bankAccountId,
            bankTransactionIds: feedBankIds,
          });
    const postedByBankId = new Map<string, Ulid>();
    for (const row of posted) {
      if (row.bankTransactionId) postedByBankId.set(row.bankTransactionId, row.id);
    }

    let committed = 0;
    let net = BigInt(0);

    for (const row of staged) {
      const reason = skipReasonFor(row);
      if (reason) {
        skips.push({ rowId: row.id, reason: reason.reason, detail: reason.detail });
        continue;
      }
      if (row.postedOn === null || row.amountCents === null) {
        // Belt and braces. skipReasonFor already covers the parser errors, so
        // reaching here means a staged row was edited into an invalid state.
        skips.push({
          rowId: row.id,
          reason: "missing_prerequisite",
          detail: "staged row has no date or no amount",
        });
        continue;
      }
      if (isLockedDay(locks, row.postedOn)) {
        skips.push({
          rowId: row.id,
          reason: "locked_period",
          detail: `posted ${row.postedOn} falls inside a locked period`,
        });
        continue;
      }
      if (row.bankTransactionId !== null) {
        const already = postedByBankId.get(row.bankTransactionId);
        if (already) {
          // Dedup on the bank supplied id, checked again at commit time.
          skips.push({
            rowId: row.id,
            reason: "already_applied",
            detail: `bank supplied id ${row.bankTransactionId} is already in the register as ${already}`,
          });
          continue;
        }
      }

      const registerId = registerIdFor(batch.id, row.rowNumber);
      const normalized =
        row.normalizedDescription ??
        normalizeDescriptor(row.description ?? "");
      const register: TransactionRow = {
        id: registerId,
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        bankAccountId: account.id,
        accountNumber: account.accountNumber,
        postedDate: row.postedOn,
        amountCents: row.amountCents,
        currency: row.currency,
        description: row.description ?? "",
        bankMerchantName: null,
        normalizedVendor: normalized,
        // Left null on purpose. The import normalizer is the staging one, not the
        // vendor normalizer, so TXN-NORMALIZE-VENDORS still has work to do and
        // reports the row as unnormalized rather than as already at version.
        vendorNormalizationVersion: null,
        normalizationDegraded: false,
        vendorId: null,
        checkNumber: row.checkNumber,
        bankCode: row.bankCode,
        institutionId: null,
        bankTransactionId: row.bankTransactionId,
        source: "import",
        importBatchId: batch.id,
        stagedRowId: row.id,
        // Uncoded on arrival. The cascade fills these in on a later run.
        categoryId: null,
        categoryVersion: null,
        cascadeLevel: null,
        ruleId: null,
        ruleVersion: null,
        matchedConditions: null,
        autoPostedUnderRulePromotion: false,
        templateId: null,
        templateVersion: null,
        classId: null,
        locationId: null,
        programId: null,
        suspenseReason: null,
        suspenseOwner: null,
        suspenseOpenedOn: null,
        suspenseEscalatesOn: null,
        pairedWithId: null,
        settlementOfTransactionId: null,
        isProcessorSettlement: false,
        duplicateFlag: row.dedupState === "confirmed_repeat",
        duplicateOfTransactionId: row.duplicateOfTransactionId,
        legitimateRepeat: row.dedupState === "confirmed_repeat",
        journalEntryId: null,
        // An imported row arrives uncleared and unreconciled. Migration 0012
        // added the match columns and REC-MATCH-TIERED is the only run that
        // fills them, so every one of them starts null here.
        instrumentType: instrumentFor(row.bankCode, row.checkNumber),
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
        voided: false,
        status: "active",
        manualOverride: false,
        manualOverrideBy: null,
        manualOverrideAt: null,
        version: 1,
      };

      proposals.push({
        kind: "row_insert",
        table: "transactions",
        rowId: registerId,
        row: register as unknown as Record<string, unknown>,
        provenance: { cascadeLevel: 0 },
      });
      proposals.push({
        kind: "field_write",
        table: "staged_rows",
        rowId: row.id,
        before: {
          dedupState: row.dedupState,
          committedTransactionId: row.committedTransactionId,
        },
        after: {
          dedupState: "committed",
          committedTransactionId: registerId,
        },
        provenance: { cascadeLevel: 0 },
      });
      if (row.bankTransactionId !== null) {
        postedByBankId.set(row.bankTransactionId, registerId);
      }
      committed += 1;
      net += row.amountCents;
    }

    proposals.push({
      kind: "field_write",
      table: "import_batches",
      rowId: batch.id,
      before: {
        status: batch.status,
        committedRunId: batch.committedRunId,
        committedAt: batch.committedAt,
      },
      after: {
        status: "committed",
        // Substituted by the writer. See RUN_ID_PLACEHOLDER.
        committedRunId: RUN_ID_PLACEHOLDER,
        committedAt: NOW_PLACEHOLDER,
      },
      provenance: { cascadeLevel: 0 },
    });

    if (committed === 0) {
      // Every row was held, rejected or already in the register. Closing the
      // batch is still the right outcome, and the skips say why.
      skips.push({
        rowId: batch.id,
        reason: "already_applied",
        detail: "no staged row in this batch was eligible to commit",
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
      runType: "IMPORT-COMMIT-BATCH",
      runVersion: 1,
    });
  },

  async undoPlan(proposals, ctx): Promise<Proposal[]> {
    const tx = requireTx(ctx);
    const registerIds = proposals
      .filter(isRowInsert)
      .filter((p) => p.table === "transactions")
      .map((p) => p.rowId);
    const current =
      registerIds.length === 0
        ? []
        : await tx.query("transactions_by_ids", {
            firmId: ctx.firmId,
            clientId: ctx.clientId,
            ids: registerIds,
          });
    const planned = planBatchReversal(proposals, current);
    if (planned.blockedBy.length > 0) {
      // Doc 05 Part 3: a batch is reversible as a unit until any row in it is
      // reconciled. Partial reversal does not exist, so a single cleared row
      // stops the whole reversal and a person unreconciles it first.
      throw new BatchReversalBlocked(planned.blockedBy);
    }
    return planned.plan;
  },
};

export class BatchReversalBlocked extends Error {
  readonly code = COMMIT_ERROR_CODES.reversalBlocked;
  constructor(readonly reconciledIds: readonly Ulid[]) {
    super(
      `batch reversal is blocked because these register rows are reconciled: ${reconciledIds.join(", ")}`,
    );
    this.name = "BatchReversalBlocked";
  }
}

/**
 * Batch reversal as a unit, separated out so it can be reasoned about and
 * tested without an execution around it.
 *
 * A register row is never deleted. It moves to status reversed, which takes it
 * out of every partial index the coding runs select on, and keeps the audit
 * trail of what the bank said intact.
 */
export function planBatchReversal(
  proposals: readonly Proposal[],
  register: readonly TransactionRow[],
): { plan: Proposal[]; blockedBy: Ulid[] } {
  const byId = new Map<Ulid, TransactionRow>();
  for (const row of register) byId.set(row.id, row);

  const blockedBy: Ulid[] = [];
  for (const row of register) {
    if (row.cleared || row.clearedDate !== null) blockedBy.push(row.id);
  }

  const plan: Proposal[] = [];
  for (const p of proposals) {
    if (isJournalEntry(p)) {
      plan.push(reverseEntry(p, p.targetId));
      continue;
    }
    if (isFieldWrite(p)) {
      plan.push(revertFieldWrite(p));
      continue;
    }
    if (!isRowInsert(p)) continue;
    if (p.table !== "transactions") continue;
    plan.push(reverseRegisterRow(p, byId.get(p.rowId) ?? null));
  }
  return { plan, blockedBy: blockedBy.sort() };
}

function reverseRegisterRow(
  insert: ProposedRowInsert,
  current: TransactionRow | null,
): ProposedFieldWrite {
  return {
    kind: "field_write",
    table: "transactions",
    rowId: insert.rowId,
    before: { status: current ? current.status : "active" },
    after: { status: "reversed" },
    provenance: { cascadeLevel: 0 },
  };
}

/** Why a staged row does not commit. Null means it commits. */
function skipReasonFor(
  row: StagedRowRow,
): { reason: Skip["reason"]; detail: string } | null {
  if (row.dedupState === "committed" || row.committedTransactionId !== null) {
    return {
      reason: "already_applied",
      detail: `already committed as ${String(row.committedTransactionId)}`,
    };
  }
  if (row.errorCode !== null) {
    return {
      reason: "missing_prerequisite",
      detail: `${row.errorCode} ${String(row.errorMessage)}`,
    };
  }
  if (row.dedupState === "rejected_duplicate") {
    return {
      reason: "already_applied",
      detail: `rejected at parse time as a repeat of ${String(row.duplicateOfTransactionId)}`,
    };
  }
  if (row.reviewState === "rejected") {
    return {
      reason: "out_of_scope_engagement",
      detail: "a reviewer rejected this row",
    };
  }
  if (row.dedupState === "held_for_review" && row.reviewState !== "accepted") {
    // The hold for review rule. Not an error, and not a commit either.
    return {
      reason: "ambiguous_candidate",
      detail: `held for review against ${String(row.duplicateOfTransactionId)}, waiting for a person to confirm or reject the repeat`,
    };
  }
  return null;
}

/**
 * Migration 0011 gives every register row an instrument type and migration 0012
 * gives REC-FLAG-STALE a per instrument threshold to read it with. A check
 * number means a check was issued, a bank code the feed marked as a credit
 * means a deposit, anything else the feed identifies is electronic, and a row
 * the feed says nothing about is other, which carries the sixty day default.
 */
function instrumentFor(
  bankCode: string | null,
  checkNumber: string | null,
): "issued_check" | "electronic" | "deposit" | "other" {
  if (checkNumber !== null && checkNumber !== "") return "issued_check";
  if (bankCode === null) return "other";
  const code = bankCode.toUpperCase();
  if (code === "DEP" || code === "CREDIT" || code === "DEPOSIT") return "deposit";
  if (code === "ACH" || code === "EFT" || code === "WIRE" || code === "CARD") {
    return "electronic";
  }
  return "other";
}
