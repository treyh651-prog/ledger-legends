/**
 * TXN-SPLIT-SETTLEMENTS. Turn one processor payout into gross sales and fees.
 *
 * Spec: docs/02-run-specifications.md Module 2 TXN-SPLIT-SETTLEMENTS. Level 4 of
 * the cascade, immediately after transfer pairing and before every coding step.
 *
 * The problem. A card processor batches a day of sales, keeps its fee, and wires
 * the difference. The bank feed shows one deposit for the net. Booking that net
 * as revenue understates sales and hides the fee, which is wrong on the income
 * statement and wrong on the sales tax return. The settlement report is the only
 * document that knows the gross and the fee, so this run is the join between the
 * report and the feed.
 *
 * Matching, in order:
 *   1. Normalized payout reference equality. The report carries a batch
 *      reference and the descriptor carries it as a whole token. Exact token
 *      equality, no similarity scoring.
 *   2. Failing that, exact net amount in integer cents plus a payout date within
 *      2 calendar days, and only when exactly one settlement row satisfies both.
 *      Two or more candidates is not a match, it is a question.
 *
 * Arithmetic check. Gross plus fee must equal net exactly, with the fee stored
 * negative. A report that does not add up is a document problem, so the run posts
 * nothing for that payout and routes SUS-17.
 *
 * Posting. One entry per matched payout: debit the bank account for the net,
 * debit the processor fee category for the absolute fee, credit the mapped
 * revenue category for the gross. That is authorized to post because both the
 * deposit and the report are observed facts and the split is arithmetic, not
 * judgment. When the client books gross at sale time the credit goes to 1910
 * instead of revenue, because the revenue was already recognized and what is
 * left is clearing.
 *
 * A processor deposit with no settlement row at all routes SUS-12, the only
 * system owned code in doc 00. It clears without a human when the report is
 * loaded and the run is repeated, which is why nobody is asked anything for it.
 */

import {
  makeResult,
  RUN_ERROR_CODES,
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
  type Ulid,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { addDays, dayGap, isLockedDay } from "../dates";
import { reverseEntry, revertFieldWrite } from "../undo";
import type {
  BankAccountRow,
  SettlementRowRow,
  TransactionRow,
} from "../tables";
import {
  LEVEL,
  PROCESSOR_CLEARING_ACCOUNT,
  abs,
  alreadyResolvedSkip,
  categoryIndex,
  codingScopeSchema,
  freezeCodingScope,
  iterationOrder,
  overrideSkips,
  policyOf,
  resolvedLevel,
  suspenseProposal,
  type CodingScope,
} from "./coding-cascade";
import { normalizeVendor } from "./txn-normalize-vendors";

export const SETTLEMENT_DATE_WINDOW_DAYS = 2;
export const SUS_NOT_SETTLED = "SUS-12";
export const SUS_AMOUNT_DISAGREES = "SUS-17";

/**
 * Token equality on the normalized reference. Containment is measured in whole
 * tokens rather than characters, so payout 41 never matches payout 415.
 */
export function referenceMatches(descriptor: string, reference: string): boolean {
  const ref = normalizeVendor(reference).value;
  if (ref.length === 0) return false;
  const refTokens = ref.split(" ");
  const tokens = normalizeVendor(descriptor).value.split(" ");
  for (let i = 0; i + refTokens.length <= tokens.length; i += 1) {
    let hit = true;
    for (let j = 0; j < refTokens.length; j += 1) {
      if (tokens[i + j] !== refTokens[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

function descriptorOf(t: TransactionRow): string {
  return `${t.description} ${t.bankMerchantName ?? ""}`;
}

export const txnSplitSettlements: Run<CodingScope, Proposal> = {
  type: "TXN-SPLIT-SETTLEMENTS",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => scope.clientId,
  scopeSchema: codingScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CodingScope>> {
    const tx = requireTx(ctx);
    const settlements = await tx.query("settlement_rows_in_window", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      from: addDays(scope.from, -SETTLEMENT_DATE_WINDOW_DAYS),
      to: addDays(scope.to, SETTLEMENT_DATE_WINDOW_DAYS),
    });
    return freezeCodingScope(scope, ctx, "TXN-SPLIT-SETTLEMENTS", 1, [
      ...settlements.map((s) => ({ id: s.id, version: s.version })),
    ]);
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const proposals: Proposal[] = [];
    const skips: Skip[] = overrideSkips(frozen.overriddenIds);
    const errors: RunError[] = [];

    const clearing = await tx.query("chart_account", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      accountNumber: PROCESSOR_CLEARING_ACCOUNT,
    });
    if (clearing.length === 0) {
      errors.push({
        rowId: null,
        code: RUN_ERROR_CODES.missingAccount,
        message: `account ${PROCESSOR_CLEARING_ACCOUNT} is missing from the chart`,
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

    const accounts = await tx.query("bank_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
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
    const policy = policyOf(
      await tx.query("client_policy", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
      }),
    );
    const settlements = await tx.query("settlement_rows_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: addDays(scope.from, -SETTLEMENT_DATE_WINDOW_DAYS),
      to: addDays(scope.to, SETTLEMENT_DATE_WINDOW_DAYS),
    });
    const candidates = await tx.query("transactions_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: scope.from,
      to: scope.to,
      bankAccountIds: scope.bankAccountIds,
      includeOverridden: false,
    });

    const accountById = new Map<Ulid, BankAccountRow>();
    for (const a of accounts) accountById.set(a.id, a);

    const consumedSettlements = new Set<Ulid>();
    for (const s of settlements) {
      if (s.matchedTransactionId !== null) consumedSettlements.add(s.id);
    }

    // Iteration is over deposits, in payout date order then payout id order once
    // a deposit is matched. Deposits themselves walk the default order, so the
    // proposal sequence is stable whichever way the feed arrived.
    for (const t of candidates.slice().sort(iterationOrder)) {
      const account = accountById.get(t.bankAccountId);
      if (!account || !account.isProcessorDestination) {
        skips.push({
          rowId: t.id,
          reason: "out_of_scope_engagement",
          detail: "not_a_processor_account",
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
      const level = resolvedLevel(t);
      if (level !== null && level < LEVEL.processorSettlement) {
        skips.push(alreadyResolvedSkip(t, level));
        continue;
      }
      if (t.isProcessorSettlement || t.settlementOfTransactionId !== null) {
        skips.push({
          rowId: t.id,
          reason: "already_applied",
          detail: "settlement_already_split",
        });
        continue;
      }
      // Only money arriving is a payout. Money leaving a processor account is a
      // chargeback or a transfer and belongs to a different rule.
      if (t.amountCents <= BigInt(0)) {
        skips.push({
          rowId: t.id,
          reason: "out_of_scope_engagement",
          detail: "not_a_processor_payout, amount is not a deposit",
        });
        continue;
      }

      const open = settlements.filter((s) => !consumedSettlements.has(s.id));

      // Step 1. Reference equality.
      let matched: SettlementRowRow | null = null;
      const byReference = open.filter(
        (s) =>
          s.batchReference !== null &&
          referenceMatches(descriptorOf(t), s.batchReference),
      );
      if (byReference.length === 1) matched = byReference[0];

      // Step 2. Amount and date, unique only.
      if (matched === null && byReference.length === 0) {
        const byAmount = open.filter(
          (s) =>
            s.netCents === t.amountCents &&
            dayGap(s.payoutDate, t.postedDate) <= SETTLEMENT_DATE_WINDOW_DAYS,
        );
        if (byAmount.length === 1) matched = byAmount[0];
      }

      if (matched === null) {
        // Doc 02. A processor deposit the report does not cover. System owned,
        // clears on a rerun once the report arrives, nobody is asked anything.
        proposals.push(
          suspenseProposal({
            transactionId: t.id,
            reasonCode: SUS_NOT_SETTLED,
            detail: `processor deposit of ${t.amountCents.toString()} cents on ${t.postedDate} has no settlement row`,
          }),
        );
        continue;
      }

      if (matched.grossCents + matched.feeCents !== matched.netCents) {
        proposals.push(
          suspenseProposal({
            transactionId: t.id,
            reasonCode: SUS_AMOUNT_DISAGREES,
            detail: `settlement ${matched.payoutId} reports gross ${matched.grossCents.toString()} plus fee ${matched.feeCents.toString()} which is not net ${matched.netCents.toString()}`,
            relatedIds: [matched.id],
          }),
        );
        consumedSettlements.add(matched.id);
        continue;
      }

      const feeCategory = categories.get(matched.feeCategoryId);
      const revenueCategory = categories.get(matched.revenueCategoryId);
      if (!feeCategory) {
        errors.push({
          rowId: t.id,
          code: RUN_ERROR_CODES.missingAccount,
          message: `processor fee category ${matched.feeCategoryId} is not on this client`,
          retryable: false,
        });
        continue;
      }
      if (!revenueCategory && !policy.grossAtSaleTime) {
        errors.push({
          rowId: t.id,
          code: RUN_ERROR_CODES.missingAccount,
          message: `revenue category ${matched.revenueCategoryId} is not on this client`,
          retryable: false,
        });
        continue;
      }

      consumedSettlements.add(matched.id);
      proposals.push(
        splitEntry(t, matched, account, {
          feeAccountNumber: feeCategory.accountNumber,
          feeCategoryId: feeCategory.id,
          grossAccountNumber: policy.grossAtSaleTime
            ? PROCESSOR_CLEARING_ACCOUNT
            : (revenueCategory as { accountNumber: string }).accountNumber,
          grossCategoryId: policy.grossAtSaleTime
            ? null
            : matched.revenueCategoryId,
        }),
      );
      proposals.push(markDeposit(t, matched));
      proposals.push(markSettlement(matched, t));
    }

    // A settlement row nobody deposited against. Reported against the report row.
    for (const s of settlements) {
      if (consumedSettlements.has(s.id)) continue;
      if (s.payoutDate < scope.from || s.payoutDate > scope.to) continue;
      skips.push({
        rowId: s.id,
        reason: "missing_prerequisite",
        detail: `awaiting_bank_deposit for payout ${s.payoutId}`,
      });
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
      runType: "TXN-SPLIT-SETTLEMENTS",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
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
    }
    return plan;
  },
};

function splitEntry(
  t: TransactionRow,
  s: SettlementRowRow,
  account: BankAccountRow,
  dest: {
    feeAccountNumber: string;
    feeCategoryId: string;
    grossAccountNumber: string;
    grossCategoryId: string | null;
  },
): ProposedJournalEntry {
  const memo = `processor settlement ${s.payoutId}, gross ${s.grossCents.toString()} fee ${s.feeCents.toString()} net ${s.netCents.toString()}`;
  const fee: Cents = abs(s.feeCents);
  return {
    kind: "journal_entry",
    targetId: null,
    entryDate: t.postedDate,
    lines: [
      {
        accountNumber: account.accountNumber,
        categoryId: null,
        amountCents: s.netCents,
        memo,
        dimensions: {},
      },
      {
        accountNumber: dest.feeAccountNumber,
        categoryId: dest.feeCategoryId,
        amountCents: fee,
        memo,
        dimensions: {},
      },
      {
        accountNumber: dest.grossAccountNumber,
        categoryId: dest.grossCategoryId,
        amountCents: -s.grossCents,
        memo,
        dimensions: {},
      },
    ],
    sourceRef: { table: "transactions", rowId: t.id, version: t.version },
  };
}

function markDeposit(
  t: TransactionRow,
  s: SettlementRowRow,
): ProposedFieldWrite {
  return {
    kind: "field_write",
    table: "transactions",
    rowId: t.id,
    before: {
      cascadeLevel: t.cascadeLevel,
      isProcessorSettlement: t.isProcessorSettlement,
      settlementOfTransactionId: t.settlementOfTransactionId,
    },
    after: {
      cascadeLevel: LEVEL.processorSettlement,
      isProcessorSettlement: true,
      settlementOfTransactionId: null,
    },
    provenance: { cascadeLevel: LEVEL.processorSettlement },
  };
}

/**
 * The report row records which deposit consumed it. This is what makes a second
 * run report settlement_already_split instead of posting the gross twice.
 */
function markSettlement(
  s: SettlementRowRow,
  t: TransactionRow,
): ProposedFieldWrite {
  return {
    kind: "field_write",
    table: "settlement_rows",
    rowId: s.id,
    before: { matchedTransactionId: s.matchedTransactionId },
    after: { matchedTransactionId: t.id },
    provenance: { cascadeLevel: LEVEL.processorSettlement },
  };
}
