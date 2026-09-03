/**
 * CLOSE-POST-YEAREND. Empty the revenue and expense accounts into equity at the
 * end of a fiscal year.
 *
 * Spec: docs/02-run-specifications.md Module 6 CLS-POST-YEAREND, doc 00 Part 1
 * for the account blocks and Part 6 for the two net asset classes a nonprofit
 * uses, docs/05-decisions.md D4 for the scope of the work.
 *
 * COMPLIANCE. This is a bookkeeping mechanic and nothing else. It moves the
 * balances of the income statement accounts to retained earnings, or to the two
 * net asset classes for a nonprofit, so that the new year starts those accounts at
 * zero. It computes no tax, prepares no return, files nothing, and takes no
 * position on any tax treatment. Income tax expense lives in the 9000 block, which
 * doc 00 says never appears on a published statement, and this run does not touch
 * that block at all. We are not CPAs and this entry is not tax work.
 *
 * The entry is dated the last day of the fiscal year, because that is the day the
 * year ended. When that day sits inside a locked period the entry is redated to
 * the first day of the earliest open period and carries the marker doc 03 Part 7
 * requires, which is the same handling every other run uses for a correction that
 * belongs to a closed period.
 *
 * Idempotency is per fiscal year. The claim row in closing_entries is the record
 * that a year was closed, and a second execution finds it and reports the year as
 * already closed rather than emptying accounts that are already empty.
 */

import { z } from "zod";
import {
  isJournalEntry,
  makeResult,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedJournalEntry,
  type ProposedLine,
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
import { firstDayOfEarliestOpenPeriod, isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { reverseEntry } from "../undo";
import { periodWindow } from "./per-shared";
import {
  ZERO,
  isIncomeStatement,
  loadCloseData,
  priorDayOf,
  type CloseData,
} from "./close-shared";
import { fiscalYearEndOf, fiscalYearStartOf } from "./cls-lock-period";

export const YEAREND_ERROR_CODES = {
  missingEquityAccount: "CLOSE_YEAREND_EQUITY_ACCOUNT_MISSING",
  noOpenPeriod: "CLOSE_YEAREND_NO_OPEN_PERIOD",
} as const;

export const postYearEndScopeSchema = z.object({
  clientId: z.string().min(1),
  /**
   * Any day in the first period of the new fiscal year. The run reads the policy
   * to find the fiscal year end rather than assuming December, because a fiscal
   * year is a client fact and guessing it would post a year of activity on the
   * wrong day.
   */
  period: z.string().min(10),
});

export type PostYearEndScope = z.infer<typeof postYearEndScopeSchema>;

/** Which equity account a bucket of income statement activity closes to. */
type EquityBucket = "unrestricted" | "restricted";

export const clsPostYearEnd: Run<PostYearEndScope, Proposal> = {
  type: "CLOSE-POST-YEAREND",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:yearend:${scope.period.slice(0, 4)}`,
  scopeSchema: postYearEndScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<PostYearEndScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadCloseData(tx, ctx.firmId, scope.clientId, scope.period);
    const year = fiscalYearBeing(data);
    const candidateIds = data.chart
      .filter((a) => isIncomeStatement(a.accountNumber))
      .map((a) => a.id);
    const versions = [
      { id: "CLOSE-POST-YEAREND", version: 1 },
      ...(data.policy === null
        ? []
        : [{ id: data.policy.id, version: 1 }]),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // The period is in the hash, and so is the year being closed, because the
      // same chart closed for two years is two different entries.
      scopeHash: scopeHashFor({
        period: `${window.periodStart}:${year.end}`,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const data = await loadCloseData(
      tx,
      frozen.firmId,
      frozen.clientId,
      frozen.input.period,
    );
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const year = fiscalYearBeing(data);
    const entityKind = data.policy === null ? "for_profit" : data.policy.entityKind;

    // The run only fires on the first period of a new fiscal year. Any other
    // period is out of scope rather than an error, so a monthly close sequence
    // can include this run every month and it will act once a year.
    if (data.periodStart !== year.nextStart) {
      skips.push({
        rowId: frozen.clientId,
        reason: "out_of_scope_engagement",
        detail: `period ${data.periodStart} is not the first period of a fiscal year, which starts ${year.nextStart}`,
      });
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        proposals,
        skips,
        errors,
        ZERO,
      );
    }

    const already = await tx.query("closing_entries_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const claim = already.find((c) => c.fiscalYearEnd === year.end);
    if (claim !== undefined) {
      skips.push({
        rowId: claim.id,
        reason: "already_applied",
        detail: `fiscal year ending ${year.end} was closed by entry ${claim.entryId}`,
      });
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        proposals,
        skips,
        errors,
        ZERO,
      );
    }

    // Which equity accounts exist is checked against the buckets that actually
    // carry activity, further down. A nonprofit with no restricted revenue does
    // not need a restricted class configured to close its year.
    const accounts = equityAccountsFor(data, entityKind);

    // Activity for the year, per account and per restriction bucket. A nonprofit
    // splits by restriction because doc 00 Part 6 keeps two net asset classes and
    // netting them would erase the donor restriction the classes exist to report.
    const byAccount = new Map<string, Map<EquityBucket, Cents>>();
    for (const line of data.lines) {
      if (line.entryDate < year.start || line.entryDate > year.end) continue;
      if (!isIncomeStatement(line.accountNumber)) continue;
      const bucket: EquityBucket =
        entityKind === "nonprofit" && line.restriction === "with_donor_restrictions"
          ? "restricted"
          : "unrestricted";
      const forAccount =
        byAccount.get(line.accountNumber) ?? new Map<EquityBucket, Cents>();
      forAccount.set(bucket, (forAccount.get(bucket) ?? ZERO) + line.amountCents);
      byAccount.set(line.accountNumber, forAccount);
    }

    const lines: ProposedLine[] = [];
    const equityTotals = new Map<EquityBucket, Cents>();
    let closedRevenue = ZERO;
    let closedExpense = ZERO;
    let accountCount = 0;
    for (const account of [...byAccount.keys()].sort()) {
      const buckets = byAccount.get(account);
      if (buckets === undefined) continue;
      for (const bucket of ["unrestricted", "restricted"] as EquityBucket[]) {
        const balance = buckets.get(bucket) ?? ZERO;
        if (balance === ZERO) continue;
        accountCount += 1;
        if (balance < ZERO) closedRevenue += -balance;
        else closedExpense += balance;
        lines.push({
          accountNumber: account,
          categoryId: null,
          amountCents: -balance,
          memo: `Year end close of ${account} for the year ended ${year.end}`,
          dimensions:
            bucket === "restricted"
              ? { restriction: "with_donor_restrictions" }
              : {},
        });
        equityTotals.set(bucket, (equityTotals.get(bucket) ?? ZERO) + balance);
      }
    }

    if (lines.length === 0) {
      skips.push({
        rowId: frozen.clientId,
        reason: "already_applied",
        detail: `no revenue or expense activity exists for the year ended ${year.end}`,
      });
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        proposals,
        skips,
        errors,
        ZERO,
      );
    }

    for (const bucket of ["unrestricted", "restricted"] as EquityBucket[]) {
      const total = equityTotals.get(bucket) ?? ZERO;
      if (total === ZERO) continue;
      const account = accounts[bucket];
      if (account === null || account === "") {
        errors.push({
          rowId: null,
          code: YEAREND_ERROR_CODES.missingEquityAccount,
          message: `the ${bucket} equity account is not configured on the client policy, so there is nowhere to close ${total.toString()} to`,
          retryable: false,
        });
        continue;
      }
      lines.push({
        accountNumber: account,
        categoryId: null,
        amountCents: total,
        memo: `Net result for the year ended ${year.end} closed to ${account}`,
        dimensions:
          bucket === "restricted" ? { restriction: "with_donor_restrictions" } : {},
      });
    }

    if (errors.length > 0) {
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        [],
        skips,
        errors,
        ZERO,
      );
    }

    // Doc 03 Part 7. The year ended on its last day, so that is the date. A locked
    // day moves the entry to the earliest open day and says so on the entry.
    let entryDate = year.end;
    let redatedFrom: string | null = null;
    if (isLockedDay(data.locks, year.end)) {
      const open = firstDayOfEarliestOpenPeriod(data.locks, year.end);
      if (open === null) {
        errors.push({
          rowId: null,
          code: YEAREND_ERROR_CODES.noOpenPeriod,
          message: `the year ended ${year.end} inside a locked period and no open day was found within a year of it`,
          retryable: false,
        });
        return makeResult<Proposal>(
          frozen.candidateIds.length,
          [],
          skips,
          errors,
          ZERO,
        );
      }
      entryDate = open;
      redatedFrom = year.end;
    }

    const entryId = closingEntryId(frozen.clientId, year.end);
    const entry: ProposedJournalEntry = {
      kind: "journal_entry",
      targetId: entryId,
      entryDate,
      lines,
      sourceRef: {
        table: "closing_entries",
        rowId: closingClaimId(frozen.clientId, year.end),
        version: 1,
      },
      ...(redatedFrom === null ? {} : { redatedFromLockedPeriod: redatedFrom }),
    };
    proposals.push(entry);

    const unrestricted = accounts.unrestricted ?? "";
    proposals.push({
      kind: "row_insert",
      table: "closing_entries",
      rowId: closingClaimId(frozen.clientId, year.end),
      row: {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        version: 1,
        fiscalYearStart: year.start,
        fiscalYearEnd: year.end,
        entryId,
        entryDate,
        entityKind,
        equityAccount: unrestricted,
        closedRevenueCents: closedRevenue,
        closedExpenseCents: closedExpense,
        closedNetCents: closedRevenue - closedExpense,
        accountCount,
        postedByRunId: RUN_ID_PLACEHOLDER,
        postedAt: NOW_PLACEHOLDER,
        manualOverride: false,
      },
      provenance: { cascadeLevel: null },
    });

    let net = ZERO;
    for (const line of lines) net += line.amountCents;
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
      runType: "CLOSE-POST-YEAREND",
      runVersion: 1,
    });
  },

  /** Undoing a closing entry is a reversal of it. The claim row stands. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isJournalEntry(p) && p.targetId !== null) {
        plan.push(reverseEntry(p, p.targetId));
      }
    }
    return plan;
  },
};

export function closingEntryId(clientId: Ulid, fiscalYearEnd: string): Ulid {
  return derivedId(`${clientId}:${fiscalYearEnd}`, "cls-post-yearend", 0);
}

export function closingClaimId(clientId: Ulid, fiscalYearEnd: string): Ulid {
  return derivedId(`${clientId}:${fiscalYearEnd}`, "cls-post-yearend", 1);
}

/** The fiscal year that ended immediately before the period being opened. */
export function fiscalYearBeing(data: CloseData): {
  start: string;
  end: string;
  nextStart: string;
} {
  const endMonth = data.policy === null ? 12 : data.policy.fiscalYearEndMonth;
  const priorDay = priorDayOf(data.periodStart);
  const end = fiscalYearEndOf(priorDay, endMonth);
  const start = fiscalYearStartOf(priorDay, endMonth);
  return { start, end, nextStart: periodWindow(end).nextPeriodStart };
}

/**
 * Where the year closes to. A for profit closes to retained earnings. A nonprofit
 * closes to the two net asset classes, and doc 00 Part 6 is explicit that the two
 * are presented separately, so the run needs both configured before it will post.
 */
function equityAccountsFor(
  data: CloseData,
  entityKind: "for_profit" | "nonprofit",
): Record<EquityBucket, string | null> {
  if (data.policy === null) {
    return { unrestricted: null, restricted: null };
  }
  if (entityKind === "nonprofit") {
    return {
      unrestricted: data.policy.netAssetsWithoutRestrictionsAccount,
      restricted: data.policy.netAssetsWithRestrictionsAccount,
    };
  }
  return {
    unrestricted: data.policy.retainedEarningsAccount,
    // A for profit has no restricted class. Nothing is ever routed there, since
    // the bucket split only happens for a nonprofit.
    restricted: null,
  };
}
