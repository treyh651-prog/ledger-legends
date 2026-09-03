/**
 * TXN-PAIR-TRANSFERS. Pair internal transfers through 1920.
 *
 * Spec: docs/02-run-specifications.md, and the transfer pairing test in
 * docs/00-conventions.md Part 3. The six tests are all hard equalities:
 *
 *   1. Same client.
 *   2. Two different bank or card accounts, both belonging to that client.
 *   3. Equal absolute amount, exact integer cents.
 *   4. Opposite signs.
 *   5. Date difference of 3 calendar days or fewer.
 *   6. Neither side already paired.
 *
 * Mutual uniqueness is required in both directions. If a transaction finds more
 * than one counterparty, or its counterparty finds more than one candidate, no
 * pair is made for any member of that ambiguous set and every member in scope
 * routes to suspense with SUS-04. The engine does not break the tie by date
 * proximity or by anything else, because ambiguity is a human decision.
 *
 * Posting: the outbound side debits 1920 and credits the source bank account,
 * the inbound side debits the destination bank account and credits 1920. Both
 * lines carry CAT-TRANSFER. Net effect on 1920 is exactly zero per pair, which
 * is what gate G01 later verifies. This run is authorized to post because both
 * sides are observed facts in the bank feed and the entry has no income
 * statement effect.
 */

import { z } from "zod";
import {
  makeResult,
  RUN_ERROR_CODES,
  isFieldWrite,
  isJournalEntry,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedJournalEntry,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { addDays, dayGap, isLockedDay } from "../dates";
import { scopeHashFor } from "../ids";
import { reverseEntry, revertFieldWrite } from "../undo";
import type { BankAccountRow, TransactionRow } from "../tables";

export const TRANSFER_CATEGORY = "CAT-TRANSFER";
export const TRANSFER_CLEARING_ACCOUNT = "1920";
export const PAIR_WINDOW_DAYS = 3;
export const SUS_AMBIGUOUS_TRANSFER = "SUS-04" as const;
/** Version of the vendor normalization function in force, stamped on writes. */
export const VENDOR_NORMALIZATION_VERSION = 1;

export const pairTransfersScopeSchema = z.object({
  clientId: z.string().min(1),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bankAccountIds: z.array(z.string().min(1)).nullable().default(null),
});

export type PairTransfersScope = z.infer<typeof pairTransfersScopeSchema>;

function abs(value: bigint): bigint {
  return value < BigInt(0) ? -value : value;
}

/** Doc 02 iteration order for this run. */
function iterationOrder(a: TransactionRow, b: TransactionRow): number {
  if (a.postedDate !== b.postedDate) return a.postedDate < b.postedDate ? -1 : 1;
  const aa = abs(a.amountCents);
  const ba = abs(b.amountCents);
  if (aa !== ba) return aa < ba ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const txnPairTransfers: Run<PairTransfersScope, Proposal> = {
  type: "TXN-PAIR-TRANSFERS",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => scope.clientId,
  scopeSchema: pairTransfersScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<PairTransfersScope>> {
    const tx = requireTx(ctx);
    const candidates = await tx.query("transactions_in_window", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      from: scope.from,
      to: scope.to,
      bankAccountIds: scope.bankAccountIds,
      includeOverridden: false,
    });
    const overridden = await tx.query("overridden_transaction_ids_in_window", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      from: scope.from,
      to: scope.to,
    });
    const pairs = await tx.query("transfer_pairs_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });

    // Overridden ids are part of the frozen candidate list so they are counted
    // and reported, and they never reach a write path because they are only ever
    // classified as a manual_override skip.
    const candidateIds = candidates
      .slice()
      .sort(iterationOrder)
      .map((t) => t.id)
      .concat(overridden.map((o) => o.id));

    const versions = [
      { id: "TXN-PAIR-TRANSFERS", version: 1 },
      { id: TRANSFER_CATEGORY, version: 1 },
      { id: "VENDOR-NORMALIZATION", version: VENDOR_NORMALIZATION_VERSION },
      ...pairs.map((p) => ({ id: p.id, version: p.manuallyConfirmed ? 2 : 1 })),
      ...candidates.map((t) => ({ id: t.id, version: t.version })),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: scope.from,
      periodEnd: scope.to,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: overridden.map((o) => o.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const clearing = await tx.query("chart_account", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      accountNumber: TRANSFER_CLEARING_ACCOUNT,
    });
    const accounts = await tx.query("bank_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const pairs = await tx.query("transfer_pairs_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    if (clearing.length === 0) {
      // Blocked by a missing 1920. A run level error, so apply is refused.
      errors.push({
        rowId: null,
        code: RUN_ERROR_CODES.missingAccount,
        message: `account ${TRANSFER_CLEARING_ACCOUNT} is missing from the chart`,
        retryable: false,
      });
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        [],
        [],
        errors,
        BigInt(0),
      );
    }

    // The counterparty search always spans every account of the client and a
    // 3 day buffer either side, otherwise a filtered run invents false unpaired
    // items at the edges of the window.
    const buffered = await tx.query("transactions_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: addDays(scope.from, -PAIR_WINDOW_DAYS),
      to: addDays(scope.to, PAIR_WINDOW_DAYS),
      bankAccountIds: null,
      includeOverridden: false,
    });

    const accountById = new Map<Ulid, BankAccountRow>();
    for (const a of accounts) accountById.set(a.id, a);

    const linkedIds = new Set<Ulid>();
    for (const p of pairs) {
      linkedIds.add(p.outboundTxnId);
      linkedIds.add(p.inboundTxnId);
    }

    const alreadyPaired = (t: TransactionRow): boolean =>
      t.pairedWithId !== null || linkedIds.has(t.id);

    const inScope = new Set<Ulid>(frozen.candidateIds);
    const overridden = new Set<Ulid>(frozen.overriddenIds);

    for (const id of frozen.overriddenIds) {
      skips.push({
        rowId: id,
        reason: "manual_override",
        detail: "row carries the manual override flag and is invisible to runs",
      });
    }

    const candidates = buffered
      .filter((t) => inScope.has(t.id) && !overridden.has(t.id))
      .sort(iterationOrder);

    const eligible: TransactionRow[] = [];
    for (const t of candidates) {
      if (isLockedDay(locks, t.postedDate)) {
        skips.push({
          rowId: t.id,
          reason: "locked_period",
          detail: `posted ${t.postedDate} falls inside a locked period`,
        });
        continue;
      }
      if (alreadyPaired(t)) {
        skips.push({
          rowId: t.id,
          reason: "already_applied",
          detail: "already_paired",
        });
        continue;
      }
      if (t.duplicateFlag) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: "duplicate_pending, the duplicate question is decided first",
        });
        continue;
      }
      if (!accountById.has(t.bankAccountId)) {
        errors.push({
          rowId: t.id,
          code: "UNKNOWN_BANK_ACCOUNT",
          message: `transaction ${t.id} names bank account ${t.bankAccountId} which is not on this client`,
          retryable: false,
        });
        continue;
      }
      eligible.push(t);
    }

    /** Every counterparty satisfying all six tests. */
    const counterpartiesOf = (t: TransactionRow): TransactionRow[] =>
      buffered
        .filter(
          (u) =>
            u.id !== t.id &&
            u.bankAccountId !== t.bankAccountId &&
            accountById.has(u.bankAccountId) &&
            abs(u.amountCents) === abs(t.amountCents) &&
            (u.amountCents < BigInt(0)) !== (t.amountCents < BigInt(0)) &&
            u.amountCents !== BigInt(0) &&
            dayGap(u.postedDate, t.postedDate) <= PAIR_WINDOW_DAYS &&
            !alreadyPaired(u) &&
            !u.duplicateFlag &&
            !isLockedDay(locks, u.postedDate),
        )
        .sort(iterationOrder);

    const consumed = new Set<Ulid>();

    for (const t of eligible) {
      if (consumed.has(t.id)) continue;
      const found = counterpartiesOf(t);
      if (found.length === 0) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: "no counterparty satisfies the six transfer pairing tests",
        });
        consumed.add(t.id);
        continue;
      }
      if (found.length === 1) {
        const other = found[0];
        const back = counterpartiesOf(other);
        if (back.length === 1 && back[0].id === t.id) {
          const outbound = t.amountCents < BigInt(0) ? t : other;
          const inbound = t.amountCents < BigInt(0) ? other : t;
          proposals.push(
            ...pairProposals(outbound, inbound, accountById),
          );
          consumed.add(t.id);
          consumed.add(other.id);
          continue;
        }
      }
      // Ambiguous set. No pair for any member, SUS-04 for every member in scope.
      const members = [t, ...found].sort(iterationOrder);
      const memberIds = members.map((m) => m.id);
      for (const m of members) {
        consumed.add(m.id);
        if (!inScope.has(m.id)) continue;
        proposals.push({
          kind: "suspense",
          transactionId: m.id,
          reasonCode: SUS_AMBIGUOUS_TRANSFER,
          account: "1990",
          detail: `possible transfer with no single pair, candidates considered: ${memberIds.join(",")}`,
          relatedIds: memberIds.filter((id) => id !== m.id),
        });
      }
    }

    let net = BigInt(0);
    for (const p of proposals) {
      if (!isJournalEntry(p)) continue;
      for (const line of p.lines) net += line.amountCents;
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
      runType: "TXN-PAIR-TRANSFERS",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isJournalEntry(p)) {
        // Shape R3. The posted entry is never deleted, a mirror entry is added.
        plan.push(reverseEntry(p, p.targetId));
        continue;
      }
      if (isFieldWrite(p)) {
        // Shape R2. The pair link and the category go back to their before values.
        plan.push(revertFieldWrite(p));
        continue;
      }
      // A SUS-04 item is a work item for a person, not a ledger effect. Undoing
      // the run does not withdraw it, because the ambiguity it records really
      // happened and a person still has to decide it.
    }
    return plan;
  },
};

function pairProposals(
  outbound: TransactionRow,
  inbound: TransactionRow,
  accountById: Map<Ulid, BankAccountRow>,
): Proposal[] {
  const amount = abs(outbound.amountCents);
  const sourceAccount = accountById.get(outbound.bankAccountId);
  const destAccount = accountById.get(inbound.bankAccountId);
  if (!sourceAccount || !destAccount) {
    throw new Error("pair proposal built without both bank accounts loaded");
  }
  const gap = dayGap(outbound.postedDate, inbound.postedDate);
  const memo = `transfer ${sourceAccount.nickname} to ${destAccount.nickname}, gap ${String(gap)} days`;

  const outboundEntry: ProposedJournalEntry = {
    kind: "journal_entry",
    targetId: null,
    entryDate: outbound.postedDate,
    lines: [
      {
        accountNumber: TRANSFER_CLEARING_ACCOUNT,
        categoryId: TRANSFER_CATEGORY,
        amountCents: amount,
        memo,
        dimensions: {},
      },
      {
        accountNumber: sourceAccount.accountNumber,
        categoryId: TRANSFER_CATEGORY,
        amountCents: -amount,
        memo,
        dimensions: {},
      },
    ],
    sourceRef: {
      table: "transactions",
      rowId: outbound.id,
      version: outbound.version,
    },
  };

  const inboundEntry: ProposedJournalEntry = {
    kind: "journal_entry",
    targetId: null,
    entryDate: inbound.postedDate,
    lines: [
      {
        accountNumber: destAccount.accountNumber,
        categoryId: TRANSFER_CATEGORY,
        amountCents: amount,
        memo,
        dimensions: {},
      },
      {
        accountNumber: TRANSFER_CLEARING_ACCOUNT,
        categoryId: TRANSFER_CATEGORY,
        amountCents: -amount,
        memo,
        dimensions: {},
      },
    ],
    sourceRef: {
      table: "transactions",
      rowId: inbound.id,
      version: inbound.version,
    },
  };

  const link = (
    self: TransactionRow,
    other: TransactionRow,
  ): ProposedFieldWrite => ({
    kind: "field_write",
    table: "transactions",
    rowId: self.id,
    before: { categoryId: self.categoryId, pairedWithId: self.pairedWithId },
    after: { categoryId: TRANSFER_CATEGORY, pairedWithId: other.id },
    provenance: { cascadeLevel: 3 },
  });

  return [outboundEntry, inboundEntry, link(outbound, inbound), link(inbound, outbound)];
}
