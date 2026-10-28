/**
 * TXN-POST-CODED. Post the register's own simple coding to the ledger.
 *
 * Not one of doc 02's documented nine coding runs, and the deepest "nothing
 * creates the first row" gap this engagement found: migration 0011's own
 * comment on ledger.transactions states the architecture plainly --
 * "It is not the ledger. A register row becomes accounting when
 * journal_entry_id is filled in, and the ledger stays the authority on
 * balances." -- but nothing in the original nine ever filled it in for the
 * common case.
 *
 * TXN-APPLY-RULES, TXN-APPLY-VENDORDEFAULTS, and TXN-MAP-BANKCODES (levels 6
 * through 8) only set category_id as a field write. None of the three posts.
 * TXN-SWEEP-SUSPENSE's own doc 02 spec deliberately skips a row with a
 * resolved category, reason "resolved", because doc 02 never names the run
 * that was supposed to post it. The four runs that do post a transaction --
 * TXN-PAIR-TRANSFERS, TXN-SPLIT-SETTLEMENTS, TXN-APPLY-RECURRING, and
 * TXN-SWEEP-SUSPENSE itself -- cover transfers, settlements, recurring
 * template matches, and suspense. A transaction resolved only by a rule, a
 * vendor default, or a bank code -- the three most common, everyday coding
 * paths for an ordinary expense or deposit -- fell through every one of
 * them. It would categorize correctly in the UI and never appear on an
 * income statement, a balance sheet, or any report built from journal_lines,
 * because every one of them reads only journal_lines, never transactions.
 *
 * This run is the floor doc 05 Part 4's "there is never a second ledger"
 * decision requires: the register and the ledger are one source of truth,
 * never two that can disagree, so a coded row has to become a real posting
 * rather than a second, informal ledger that reports quietly ignore.
 *
 * The entry. Two lines, the same shape TXN-SWEEP-SUSPENSE posts: the bank
 * line exactly as the register observed it, and the balancing line to the
 * category's own mapped account, carrying the category id for provenance.
 * Always balances by construction, because the second line is the negation
 * of the first.
 *
 * Scope. Resolved by category, not posted yet, and not claimed by one of
 * the four runs that post their own way: no suspense reason, no transfer
 * pairing, no settlement link, no recurring template. Those four already
 * have their own reliable "already handled" signal and this run never
 * touches them.
 *
 * Idempotency. transactions.journal_entry_id, finally. Set the moment this
 * run posts a row, and the first thing this run checks before it ever
 * proposes one.
 *
 * Runs after TXN-SWEEP-SUSPENSE, level ten of a cascade doc 02 described as
 * nine. A row has to finish being coded, suspense included, before this run
 * decides there is nothing left to post.
 */

import {
  makeResult,
  isFieldWrite,
  isJournalEntry,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedJournalEntry,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId } from "../ids";
import { reverseEntry, revertFieldWrite } from "../undo";
import type { BankAccountRow, CategoryRow, TransactionRow } from "../tables";
import {
  categoryIndex,
  codingScopeSchema,
  freezeCodingScope,
  iterationOrder,
  overrideSkips,
  type CodingScope,
} from "./coding-cascade";

export function postedEntryIdFor(transactionId: string): string {
  return derivedId(transactionId, "txn-post-coded", 0);
}

function postEntry(
  t: TransactionRow,
  account: BankAccountRow,
  category: CategoryRow,
  entryId: string,
): ProposedJournalEntry {
  const memo = `coded ${category.name}`;
  return {
    kind: "journal_entry",
    targetId: entryId,
    entryDate: t.postedDate,
    lines: [
      {
        accountNumber: account.accountNumber,
        categoryId: null,
        amountCents: t.amountCents,
        memo,
        dimensions: {},
      },
      {
        accountNumber: category.accountNumber,
        categoryId: category.id,
        amountCents: -t.amountCents,
        memo,
        dimensions: {},
      },
    ],
    sourceRef: { table: "transactions", rowId: t.id, version: t.version },
  };
}

function postWrite(t: TransactionRow, entryId: string): ProposedFieldWrite {
  return {
    kind: "field_write",
    table: "transactions",
    rowId: t.id,
    before: { journalEntryId: t.journalEntryId },
    after: { journalEntryId: entryId },
    provenance: { cascadeLevel: null },
  };
}

export const txnPostCoded: Run<CodingScope, Proposal> = {
  type: "TXN-POST-CODED",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => scope.clientId,
  scopeSchema: codingScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CodingScope>> {
    const tx = requireTx(ctx);
    const categories = await tx.query("categories_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    return freezeCodingScope(scope, ctx, "TXN-POST-CODED", 1, [
      ...categories.map((c) => ({ id: c.id, version: c.version })),
    ]);
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const proposals: Proposal[] = [];
    const skips: Skip[] = overrideSkips(frozen.overriddenIds);
    const errors: RunError[] = [];

    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const categories = categoryIndex(
      await tx.query("categories_for_client", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
      }),
    );
    const bankAccounts = await tx.query("bank_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const accountById = new Map(bankAccounts.map((a) => [a.id, a]));
    const candidates = await tx.query("transactions_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: scope.from,
      to: scope.to,
      bankAccountIds: scope.bankAccountIds,
      includeOverridden: false,
    });

    let net: Cents = BigInt(0);
    for (const t of candidates.slice().sort(iterationOrder)) {
      if (t.journalEntryId !== null) {
        skips.push({ rowId: t.id, reason: "already_applied", detail: "already_posted" });
        continue;
      }
      if (
        t.suspenseReason !== null ||
        t.pairedWithId !== null ||
        t.settlementOfTransactionId !== null ||
        t.isProcessorSettlement ||
        t.templateId !== null
      ) {
        skips.push({
          rowId: t.id,
          reason: "already_applied",
          detail: "posted_by_a_different_cascade_step",
        });
        continue;
      }
      if (t.categoryId === null) {
        skips.push({ rowId: t.id, reason: "missing_prerequisite", detail: "not_yet_coded" });
        continue;
      }
      const category = categories.get(t.categoryId);
      if (!category) {
        errors.push({
          rowId: t.id,
          code: "MISSING_ACCOUNT",
          message: `transaction ${t.id} is coded to category ${t.categoryId} which is not on this client`,
          retryable: false,
        });
        continue;
      }
      const account = accountById.get(t.bankAccountId);
      if (!account) {
        errors.push({
          rowId: t.id,
          code: "UNKNOWN_BANK_ACCOUNT",
          message: `transaction ${t.id} names bank account ${t.bankAccountId} which is not on this client`,
          retryable: false,
        });
        continue;
      }
      if (isLockedDay(locks, t.postedDate)) {
        skips.push({
          rowId: t.id,
          reason: "locked_period",
          detail: `posted ${t.postedDate} falls inside a locked period`,
        });
        continue;
      }

      const entryId = postedEntryIdFor(t.id);
      const entry = postEntry(t, account, category, entryId);
      proposals.push(entry);
      for (const l of entry.lines) net += l.amountCents;
      proposals.push(postWrite(t, entryId));
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, net);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "TXN-POST-CODED",
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
