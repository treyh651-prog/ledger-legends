/**
 * TXN-SWEEP-SUSPENSE. Level 9. Nothing leaves the cascade uncoded.
 *
 * Spec: docs/02-run-specifications.md Module 2 TXN-SWEEP-SUSPENSE, reason code
 * catalog and owners from docs/00-conventions.md.
 *
 * This is the floor of the cascade and the reason gate G01 can be a hard zero.
 * Every row that steps 1 through 8 declined to decide posts to 1990 with a reason
 * code, an owner, and an escalation date. There is no such thing as a row that
 * finishes the cascade with a null category and no suspense reason, because that
 * row would be invisible in every report and would surface in eleven months as a
 * surprise.
 *
 * Reason code selection. An earlier step's code always wins. Duplicate detection
 * said SUS-05, settlement splitting said SUS-12 or SUS-17, rules said SUS-19 or
 * SUS-10 or SUS-09, and the sweep carries that forward rather than replacing it
 * with a weaker guess. Only when no earlier step spoke does the sweep decide, and
 * then it walks one ordered list and takes the first match:
 *
 *   1. Amount in a currency other than the functional currency, SUS-11.
 *   2. Dated inside a locked period and still uncoded, SUS-20.
 *   3. At or above the capitalization threshold with no category, SUS-09.
 *   4. Landed in a processor destination account with no settlement row, SUS-12.
 *   5. Descriptor carrying a chargeback or reversal token, SUS-13.
 *   6. Credit sign with no vendor and no identified source, SUS-02.
 *   7. Debit sign with no vendor, SUS-01.
 *   8. Vendor resolved but no category, SUS-03.
 *
 * The list is ordered rather than scored because two codes on one row would leave
 * two people each believing the other owns it.
 *
 * Posting. One entry per transaction: the bank line exactly as the feed observed
 * it, and the balancing line to 1990. The register row then carries the reason
 * code, the owner from doc 00, and an escalation date of the posting date plus the
 * escalation age in calendar days.
 *
 * Locked period rows are the one exception and they are not posted. A run may not
 * write into a closed period, so those rows are reported with a locked period skip
 * and the SUS-20 code waits for the period to open.
 *
 * Client owned codes create exactly one portal request, unless an open request
 * already covers that transaction and code. Asking the same client the same
 * question twice is how a portal stops being read.
 */

import {
  makeResult,
  RUN_ERROR_CODES,
  isFieldWrite,
  isJournalEntry,
  isRowInsert,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedJournalEntry,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import {
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  applyProposals,
  requireTx,
} from "../apply-writer";
import { addDays, isLockedDay } from "../dates";
import { derivedId } from "../ids";
import { reverseEntry, revertFieldWrite } from "../undo";
import type { BankAccountRow, TransactionRow } from "../tables";
import {
  LEVEL,
  SUSPENSE_ACCOUNT,
  abs,
  codingScopeSchema,
  freezeCodingScope,
  iterationOrder,
  overrideSkips,
  policyOf,
  resolvedLevel,
  signOf,
  suspenseSpec,
  type CodingScope,
} from "./coding-cascade";

/** Doc 02 Part D. Authorized to post, because 1990 is a holding place. */
export const SWEEP_AUTO_POST_ELIGIBLE = true;

/**
 * Doc 02 step 5 token list. Exact token equality on the normalized descriptor,
 * not substring containment, so REVERSALWORKS is not read as a reversal.
 */
export const CHARGEBACK_TOKENS: readonly string[] = [
  "CHARGEBACK",
  "CHGBK",
  "REVERSAL",
  "REVERSED",
  "RETURNED",
  "RETURN",
  "DISPUTE",
  "DISPUTED",
  "NSF",
];

export interface SweepDecision {
  reasonCode: string;
  detail: string;
}

export interface SweepInputs {
  functionalCurrency: string;
  capitalizeOverCents: bigint;
  isProcessorDestination: boolean;
  hasSettlementRow: boolean;
  locked: boolean;
}

/**
 * The ordered decision list. Pure, exported, and tested on its own, because the
 * order is the rule and an order that only exists inside a loop is an order nobody
 * can check.
 */
export function decideReason(
  t: TransactionRow,
  input: SweepInputs,
): SweepDecision {
  if (t.currency !== input.functionalCurrency) {
    return {
      reasonCode: "SUS-11",
      detail: `amount is in ${t.currency} and the ledger is kept in ${input.functionalCurrency}`,
    };
  }
  if (input.locked) {
    return {
      reasonCode: "SUS-20",
      detail: `posted ${t.postedDate} is inside a locked period and the row is still uncoded`,
    };
  }
  if (t.categoryId === null && abs(t.amountCents) >= input.capitalizeOverCents) {
    return {
      reasonCode: "SUS-09",
      detail: `amount ${abs(t.amountCents).toString()} is at or above the capitalization threshold ${input.capitalizeOverCents.toString()} and has no category`,
    };
  }
  if (input.isProcessorDestination && !input.hasSettlementRow) {
    return {
      reasonCode: "SUS-12",
      detail: "processor destination account with no settlement row loaded",
    };
  }
  const tokens = (t.normalizedVendor ?? "").split(" ");
  for (const token of tokens) {
    if (CHARGEBACK_TOKENS.includes(token)) {
      return {
        reasonCode: "SUS-13",
        detail: `descriptor carries the token ${token}`,
      };
    }
  }
  if (signOf(t) === "credit" && t.vendorId === null) {
    return {
      reasonCode: "SUS-02",
      detail: "money in with no identified source",
    };
  }
  if (signOf(t) === "debit" && t.vendorId === null) {
    return {
      reasonCode: "SUS-01",
      detail: "money out with no identified vendor",
    };
  }
  return {
    reasonCode: "SUS-03",
    detail: "vendor is resolved and the business purpose is not determinable",
  };
}

export const txnSweepSuspense: Run<CodingScope, Proposal> = {
  type: "TXN-SWEEP-SUSPENSE",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => scope.clientId,
  scopeSchema: codingScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CodingScope>> {
    return freezeCodingScope(scope, ctx, "TXN-SWEEP-SUSPENSE", 1, [
      { id: SUSPENSE_ACCOUNT, version: 1 },
    ]);
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const proposals: Proposal[] = [];
    const skips: Skip[] = overrideSkips(frozen.overriddenIds);
    const errors: RunError[] = [];

    const suspenseAccount = await tx.query("chart_account", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      accountNumber: SUSPENSE_ACCOUNT,
    });
    if (suspenseAccount.length === 0) {
      errors.push({
        rowId: null,
        code: RUN_ERROR_CODES.missingAccount,
        message: `account ${SUSPENSE_ACCOUNT} is missing from the chart`,
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
    const policy = policyOf(
      await tx.query("client_policy", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
      }),
    );
    const candidates = await tx.query("transactions_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: scope.from,
      to: scope.to,
      bankAccountIds: scope.bankAccountIds,
      includeOverridden: false,
    });
    const priorItems = await tx.query("suspense_items_for_transactions", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      transactionIds: candidates.map((t) => t.id),
    });
    const openRequests = await tx.query("open_portal_requests_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    const accountById = new Map<Ulid, BankAccountRow>();
    for (const a of accounts) accountById.set(a.id, a);

    // An earlier step's code always wins. Ties inside the earlier codes go to the
    // lowest code string so a rerun picks the same one every time.
    const earlierCode = new Map<Ulid, string>();
    for (const item of priorItems) {
      if (item.transactionId === null) continue;
      if (item.withdrawnByRunId !== null) continue;
      const seen = earlierCode.get(item.transactionId);
      if (seen === undefined || item.reasonCode < seen) {
        earlierCode.set(item.transactionId, item.reasonCode);
      }
    }

    const coveredRequests = new Set<string>();
    for (const r of openRequests) {
      if (r.transactionId === null) continue;
      coveredRequests.add(`${r.transactionId}\u0000${r.reasonCode}`);
    }

    const settlements = await tx.query("settlement_rows_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: addDays(scope.from, -2),
      to: addDays(scope.to, 2),
    });
    const settledIds = new Set<Ulid>();
    for (const s of settlements) {
      if (s.matchedTransactionId !== null) settledIds.add(s.matchedTransactionId);
    }

    let ordinal = 0;
    for (const t of candidates.slice().sort(iterationOrder)) {
      if (t.suspenseReason !== null) {
        skips.push({
          rowId: t.id,
          reason: "already_applied",
          detail: "already_in_suspense",
        });
        continue;
      }
      const level = resolvedLevel(t);
      if (level !== null && level < LEVEL.suspense && t.categoryId !== null) {
        skips.push({ rowId: t.id, reason: "already_applied", detail: "resolved" });
        continue;
      }
      // A transfer or a settlement is resolved even though the coding sits on the
      // entry rather than on a category column, so those are resolved too.
      if (level === LEVEL.transferPair || level === LEVEL.processorSettlement) {
        skips.push({ rowId: t.id, reason: "already_applied", detail: "resolved" });
        continue;
      }
      const locked = isLockedDay(locks, t.postedDate);
      if (locked) {
        // Doc 02. Not posted. The period is closed and this run does not redate.
        skips.push({
          rowId: t.id,
          reason: "locked_period",
          detail: `posted ${t.postedDate} falls inside a locked period, SUS-20 waits for the period to open`,
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

      const carried = earlierCode.get(t.id);
      const decision =
        carried !== undefined
          ? {
              reasonCode: carried,
              detail: `carried forward from an earlier cascade step, ${suspenseSpec(carried).label}`,
            }
          : decideReason(t, {
              functionalCurrency: policy.functionalCurrency,
              capitalizeOverCents: policy.capitalizeOverCents,
              isProcessorDestination: account.isProcessorDestination,
              hasSettlementRow: settledIds.has(t.id),
              locked,
            });

      const spec = suspenseSpec(decision.reasonCode);
      const openedOn = t.postedDate;
      const escalatesOn = addDays(openedOn, spec.escalationDays);

      proposals.push(sweepEntry(t, account, decision.reasonCode, decision.detail));
      proposals.push(
        sweepWrite(t, {
          reasonCode: decision.reasonCode,
          owner: spec.owner,
          openedOn,
          escalatesOn,
        }),
      );
      if (spec.owner === "client") {
        const key = `${t.id}\u0000${decision.reasonCode}`;
        if (!coveredRequests.has(key)) {
          coveredRequests.add(key);
          ordinal += 1;
          proposals.push(
            portalRequest(t, decision, escalatesOn, openedOn, ordinal),
          );
        }
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
      runType: "TXN-SWEEP-SUSPENSE",
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
      // A portal request already asked the client a question. Undoing the sweep
      // does not unask it, it just stops holding the amount in 1990.
      if (isRowInsert(p)) continue;
    }
    return plan;
  },
};

function sweepEntry(
  t: TransactionRow,
  account: BankAccountRow,
  reasonCode: string,
  detail: string,
): ProposedJournalEntry {
  const memo = `suspense ${reasonCode}, ${detail}`;
  return {
    kind: "journal_entry",
    targetId: null,
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
        accountNumber: SUSPENSE_ACCOUNT,
        categoryId: null,
        amountCents: -t.amountCents,
        memo,
        dimensions: {},
      },
    ],
    sourceRef: { table: "transactions", rowId: t.id, version: t.version },
  };
}

function sweepWrite(
  t: TransactionRow,
  args: {
    reasonCode: string;
    owner: "firm" | "client" | "system";
    openedOn: string;
    escalatesOn: string;
  },
): ProposedFieldWrite {
  return {
    kind: "field_write",
    table: "transactions",
    rowId: t.id,
    before: {
      cascadeLevel: t.cascadeLevel,
      suspenseReason: t.suspenseReason,
      suspenseOwner: t.suspenseOwner,
      suspenseOpenedOn: t.suspenseOpenedOn,
      suspenseEscalatesOn: t.suspenseEscalatesOn,
    },
    after: {
      cascadeLevel: LEVEL.suspense,
      suspenseReason: args.reasonCode,
      suspenseOwner: args.owner,
      suspenseOpenedOn: args.openedOn,
      suspenseEscalatesOn: args.escalatesOn,
    },
    provenance: { cascadeLevel: LEVEL.suspense },
  };
}

function portalRequest(
  t: TransactionRow,
  decision: SweepDecision,
  dueOn: string,
  openedOn: string,
  ordinal: number,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "portal_requests",
    rowId: derivedId(t.id, `portal-${decision.reasonCode}`, ordinal),
    row: {
      firmId: t.firmId,
      clientId: t.clientId,
      transactionId: t.id,
      reasonCode: decision.reasonCode,
      detail: decision.detail,
      status: "open",
      openedOn,
      dueOn,
      createdByRunId: RUN_ID_PLACEHOLDER,
      requestedAt: NOW_PLACEHOLDER,
    },
    provenance: { cascadeLevel: LEVEL.suspense },
  };
}
