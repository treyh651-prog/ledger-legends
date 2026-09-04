/**
 * SETUP-IMPORT-BALANCES. Post a client's opening balances at the cutover date.
 *
 * Spec: docs/02-run-specifications.md Module 1, docs/01-categories-and-charts.md
 * Part 2.4 for the opening balance equity account.
 *
 * What the run does. The wizard hands over a trial balance as at the cutover
 * date, either from a pasted CSV or from the grid on step 5. This run turns it
 * into exactly one journal entry dated the cutover, one line per supplied
 * account, plus the offsetting line to 3900 opening balance equity. It also
 * writes one opening_balances row per account so the close and the roll forward
 * have the same figures to read that the ledger has.
 *
 * One entry per client per cutover. The entry id is derived from the client and
 * the cutover date, so a second execution proposes the same id, the ledger
 * refuses the duplicate, and the run reports balances already posted rather
 * than doubling the books. That is the whole idempotency story here, and it is
 * why the run is safe to press twice.
 *
 * FOOTING, and why this run refuses to plug.
 *
 * The 3900 line is the offset the spec names, and it is derived as the negation
 * of every other supplied line. That much is arithmetic. What the run will not
 * do is absorb a mistake into it silently. Two checks stand in the way. First,
 * if the caller supplied its own 3900 figure, the derived offset must equal it
 * exactly, and a disagreement is a hard error naming both numbers, because a
 * trial balance whose equity line does not agree with its own accounts is a
 * trial balance somebody read wrong. Second, the finished line set is summed
 * again and a non zero total is a hard error. An error means apply refuses to
 * start, per doc 03, so nothing is written at all. See NOTES.md entry 127.
 *
 * Locked periods. A cutover inside a locked period is refused rather than
 * redated. Every other date in the book hangs off the cutover, so moving it
 * would silently change what the opening balance is the opening of.
 *
 * SENDS. None. This run writes a journal entry and balance rows.
 *
 * CONSTRAINT. No model and no inference. The account numbers and the integer
 * cents arrive on the scope, already parsed by the caller. There is no float
 * anywhere on this path.
 */

import { z } from "zod";
import {
  makeResult,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedJournalEntry,
  type ProposedLine,
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
import { isIsoDay, isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import type { OpeningBalanceRow } from "../tables";
import { ZERO } from "./close-shared";
import { periodWindow } from "./per-shared";
import {
  OPENING_BALANCE_EQUITY_ACCOUNT,
  byAccountNumber,
  loadIntakeData,
} from "./intake-shared";

/** Integer cents as a decimal string. There is no float on this path. */
const centsString = z.string().regex(/^-?[0-9]+$/);

const balanceLineSchema = z.object({
  accountNumber: z.string().regex(/^[0-9]{4}$/),
  /** Signed. Debit positive, credit negative, the convention doc 00 fixes. */
  amountCents: centsString,
});

export const importBalancesScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  /** The day the books open. Every line of the entry carries this date. */
  cutoverDate: z.string().min(10),
  lines: z.array(balanceLineSchema).min(1),
  /** Where the figures came from, for the opening balance row's provenance. */
  sourceKind: z.string().min(1).default("wizard_trial_balance"),
});

export type ImportBalancesScope = z.infer<typeof importBalancesScopeSchema>;

export interface BalanceLine {
  accountNumber: string;
  amountCents: Cents;
}

export const setupImportBalances: Run<ImportBalancesScope, Proposal> = {
  type: "SETUP-IMPORT-BALANCES",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:opening-balances:${scope.cutoverDate}`,
  scopeSchema: importBalancesScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ImportBalancesScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadIntakeData(
      tx,
      ctx.firmId,
      scope.clientId,
      scope.period,
      window.periodStart,
    );
    const entryId = openingEntryId(scope.clientId, scope.cutoverDate);
    const candidateIds = [entryId];
    const versions = [
      { id: "SETUP-IMPORT-BALANCES", version: 1 },
      ...data.openingBalances.map((b) => ({ id: b.id, version: b.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // Every figure is in the discriminator. A trial balance somebody fixed
      // and resubmitted is a different scope, and a preview taken before the
      // fix must not satisfy the apply that follows it.
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [
          scope.cutoverDate,
          scope.sourceKind,
          mergeLines(scope.lines)
            .map((l) => `${l.accountNumber}:${l.amountCents.toString()}`)
            .join("|"),
        ].join("/"),
      }),
      versions,
      overriddenIds: data.openingBalances
        .filter((b) => b.manualOverride)
        .map((b) => b.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const data = await loadIntakeData(
      tx,
      frozen.firmId,
      frozen.clientId,
      frozen.input.period,
      window.periodStart,
    );
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const cutover = frozen.input.cutoverDate;
    const entryId = openingEntryId(frozen.clientId, cutover);

    if (!isIsoDay(cutover)) {
      errors.push({
        rowId: entryId,
        code: "CUTOVER_NOT_A_DAY",
        message: `cutover date ${cutover} is not an ISO day`,
        retryable: false,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    if (isLockedDay(data.close.locks, cutover)) {
      skips.push({
        rowId: entryId,
        reason: "locked_period",
        detail: `the cutover date ${cutover} falls in a locked period, so nothing was posted`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    /*
     * A rerun. The entry id is derived, so if the balances are already on the
     * books the honest answer is to say so and write nothing. Posting the same
     * opening balance twice is the single worst thing this run could do.
     */
    const alreadyPosted = data.openingBalances.some(
      (b) => b.periodStart === window.periodStart && b.sourceKind === frozen.input.sourceKind,
    );
    if (alreadyPosted) {
      skips.push({
        rowId: entryId,
        reason: "already_applied",
        detail: `opening balances for ${window.periodStart} are already on the books`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const merged = mergeLines(frozen.input.lines);
    const balanced = balanceAgainstOpeningEquity(merged);
    if (balanced.error !== null) {
      errors.push({ rowId: entryId, ...balanced.error });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const lines = balanced.lines;

    // The belt to the braces above. If this ever fires the arithmetic changed,
    // and the run stops rather than posting an entry that does not foot.
    let footing = BigInt(0);
    for (const line of lines) footing += line.amountCents;
    if (footing !== BigInt(0)) {
      errors.push({
        rowId: entryId,
        code: "ENTRY_DOES_NOT_FOOT",
        message: `the opening entry sums to ${footing.toString()} cents rather than zero, so nothing was posted`,
        retryable: false,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const known = new Set(data.accounts.map((a) => a.accountNumber));
    const unknown = lines
      .map((l) => l.accountNumber)
      .filter((n) => known.size > 0 && !known.has(n));
    if (unknown.length > 0) {
      errors.push({
        rowId: entryId,
        code: "ACCOUNT_NOT_ON_CHART",
        message: `these accounts are not on the client's chart, so the entry was not posted: ${unknown.join(", ")}`,
        retryable: false,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const claimId = openingClaimId(frozen.clientId, cutover);
    const entry: ProposedJournalEntry = {
      kind: "journal_entry",
      targetId: entryId,
      entryDate: cutover,
      lines: lines.map(
        (l): ProposedLine => ({
          accountNumber: l.accountNumber,
          categoryId: null,
          amountCents: l.amountCents,
          memo: `Opening balance at ${cutover}`,
          dimensions: {},
        }),
      ),
      sourceRef: { table: "opening_balances", rowId: claimId, version: 1 },
    };
    proposals.push(entry);

    for (const line of lines) {
      proposals.push(
        insertBalance(frozen, line, window.periodStart, cutover, frozen.input.sourceKind),
      );
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "SETUP-IMPORT-BALANCES",
      runVersion: 1,
    });
  },

  /**
   * Nothing reverts here. An opening balance entry is undone by a reversing
   * entry a person posts and signs, not by a quiet delete, because everything
   * dated after the cutover was built on top of it.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};

export function openingEntryId(clientId: Ulid, cutoverDate: string): Ulid {
  return derivedId(`${clientId}:${cutoverDate}`, "setup-import-balances", 0);
}

export function openingClaimId(clientId: Ulid, cutoverDate: string): Ulid {
  return derivedId(`${clientId}:${cutoverDate}`, "setup-import-balances", 1);
}

export function balanceRowId(clientId: Ulid, periodStart: string, accountNumber: string): Ulid {
  return derivedId(`${clientId}:${periodStart}:${accountNumber}`, "setup-import-balances", 2);
}

/**
 * One line per account, account number ascending. A trial balance that lists an
 * account twice is added together rather than refused, because a grid with two
 * rows for 1010 is a person entering two statements, not a mistake.
 */
export function mergeLines(
  lines: readonly { accountNumber: string; amountCents: string }[],
): BalanceLine[] {
  const totals = new Map<string, Cents>();
  for (const line of lines) {
    const prior = totals.get(line.accountNumber) ?? BigInt(0);
    totals.set(line.accountNumber, prior + BigInt(line.amountCents));
  }
  return [...totals.entries()]
    .map(([accountNumber, amountCents]) => ({ accountNumber, amountCents }))
    .sort(byAccountNumber);
}

export interface BalanceOutcome {
  lines: BalanceLine[];
  error: { code: string; message: string; retryable: boolean } | null;
}

/**
 * The finished line set, with the 3900 offset derived from everything else.
 *
 * A supplied 3900 figure is checked, never adjusted. A zero line is dropped,
 * because an account with no opening balance has nothing to say.
 */
export function balanceAgainstOpeningEquity(merged: readonly BalanceLine[]): BalanceOutcome {
  const others = merged.filter((l) => l.accountNumber !== OPENING_BALANCE_EQUITY_ACCOUNT);
  const suppliedEquity = merged.find(
    (l) => l.accountNumber === OPENING_BALANCE_EQUITY_ACCOUNT,
  );

  let sum = BigInt(0);
  for (const line of others) sum += line.amountCents;
  const derivedEquity = -sum;

  if (suppliedEquity !== undefined && suppliedEquity.amountCents !== derivedEquity) {
    return {
      lines: [],
      error: {
        code: "OPENING_EQUITY_DISAGREES",
        message:
          `the trial balance supplies ${suppliedEquity.amountCents.toString()} cents on account ` +
          `${OPENING_BALANCE_EQUITY_ACCOUNT} but its own accounts offset to ` +
          `${derivedEquity.toString()} cents, so nothing was posted and no figure was plugged`,
        retryable: false,
      },
    };
  }

  const kept = others.filter((l) => l.amountCents !== BigInt(0));
  if (kept.length === 0) {
    return {
      lines: [],
      error: {
        code: "NO_OPENING_BALANCES",
        message: "every supplied opening balance is zero, so there is no entry to post",
        retryable: false,
      },
    };
  }

  const lines =
    derivedEquity === BigInt(0)
      ? kept
      : [
          ...kept,
          {
            accountNumber: OPENING_BALANCE_EQUITY_ACCOUNT,
            amountCents: derivedEquity,
          },
        ].sort(byAccountNumber);

  return { lines, error: null };
}

function insertBalance(
  frozen: FrozenScope<ImportBalancesScope>,
  line: BalanceLine,
  periodStart: string,
  cutover: string,
  sourceKind: string,
): ProposedRowInsert {
  const row: Omit<OpeningBalanceRow, "id"> = {
    firmId: frozen.firmId,
    clientId: frozen.clientId,
    version: 1,
    periodStart,
    accountNumber: line.accountNumber,
    openingBalanceCents: line.amountCents,
    sourcePeriodStart: cutover,
    sourceKind,
    createdByRunId: RUN_ID_PLACEHOLDER,
    createdAt: NOW_PLACEHOLDER,
    manualOverride: false,
  };
  return {
    kind: "row_insert",
    table: "opening_balances",
    rowId: balanceRowId(frozen.clientId, periodStart, line.accountNumber),
    row: row as unknown as Record<string, unknown>,
    provenance: { cascadeLevel: null },
  };
}
