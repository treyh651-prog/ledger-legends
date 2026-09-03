/**
 * TXN-APPLY-RECURRING. Match recurring templates and apply their splits.
 *
 * Spec: docs/02-run-specifications.md Module 2 TXN-APPLY-RECURRING, template
 * shapes from docs/04-reference-data.md Part 6. Level 5 of the cascade, above
 * rules, because a template is a statement about a specific arrangement with a
 * specific counterparty and a rule is a generalization. When the two disagree the
 * specific one is the one a person actually set up.
 *
 * The match test, all three required:
 *   1. Normalized vendor exact equality with the template match name.
 *   2. Bank or card account equality with the template account.
 *   3. Posted day of month within the template day window, default 5 days either
 *      side. The comparison wraps across the month boundary, so a template due
 *      on the 1st still matches a charge on the 29th of a short month.
 *
 * Amount, by template mode:
 *   fixed_amount   exact integer cent equality.
 *   variable_amount inside the inclusive floor and ceiling band.
 *
 * Two or more templates matching means none of them is applied and SUS-19 names
 * every survivor. Guessing between two templates a person set up is worse than
 * asking, because the wrong guess looks correct on the report.
 *
 * Splits:
 *   single        one line for the whole amount.
 *   fixed_amount  the fixed cents must sum to the transaction amount exactly.
 *                 Anything else is SUS-17, because a template that no longer adds
 *                 up is a document disagreement and not a rounding question.
 *   fixed_percent integer basis points summing to exactly 10000, allocated by
 *                 largest remainder, with the residual cent landing on the
 *                 highest sequence line.
 *
 * Part D. This run never auto posts under any configuration. It proposes, a
 * person applies.
 */

import {
  makeResult,
  isFieldWrite,
  isJournalEntry,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedJournalEntry,
  type ProposedLine,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { isLockedDay } from "../dates";
import { reverseEntry, revertFieldWrite } from "../undo";
import type {
  BankAccountRow,
  RecurringSplitRow,
  RecurringTemplateRow,
  TransactionRow,
} from "../tables";
import {
  LEVEL,
  abs,
  alreadyResolvedSkip,
  foreignCurrencySkip,
  policyOf,
  categoryIndex,
  codingScopeSchema,
  codingWrite,
  freezeCodingScope,
  iterationOrder,
  overrideSkips,
  resolvedLevel,
  suspenseProposal,
  type CodingScope,
} from "./coding-cascade";

/** Doc 02 Part D. Not eligible for auto post under any configuration. */
export const RECURRING_AUTO_POST_ELIGIBLE = false;
export const DEFAULT_DAY_WINDOW = 5;
export const BASIS_POINTS_TOTAL = 10000;
export const SUS_TEMPLATE_CONFLICT = "SUS-19";
export const SUS_TEMPLATE_AMOUNT = "SUS-17";

/**
 * Day of month distance with the month boundary treated as a circle of 31 days.
 * A monthly charge that slips from the 31st to the 1st moved one day in the world
 * and thirty days on a naive subtraction, and the naive answer is the wrong one.
 */
export function dayOfMonthDistance(day: string, target: number): number {
  const dom = Number(day.slice(8, 10));
  const raw = Math.abs(dom - target);
  return Math.min(raw, 31 - raw);
}

export function templateMatches(
  t: TransactionRow,
  tpl: RecurringTemplateRow,
): boolean {
  if (tpl.matchKind !== "transaction_match") return false;
  if (tpl.matchNormalizedName === null) return false;
  if (t.normalizedVendor === null) return false;
  if (t.normalizedVendor !== tpl.matchNormalizedName) return false;
  if (tpl.bankAccountId !== null && tpl.bankAccountId !== t.bankAccountId) {
    return false;
  }
  const window = tpl.dayWindow;
  if (tpl.dayOfMonth !== null && dayOfMonthDistance(t.postedDate, tpl.dayOfMonth) > window) {
    return false;
  }
  if (tpl.amountMode === "fixed_amount") {
    if (tpl.matchAmountCents === null) return false;
    return abs(t.amountCents) === abs(tpl.matchAmountCents);
  }
  const magnitude = abs(t.amountCents);
  const floor = tpl.amountFloorCents;
  const ceiling = tpl.amountCeilingCents;
  if (floor !== null && magnitude < abs(floor)) return false;
  if (ceiling !== null && magnitude > abs(ceiling)) return false;
  return true;
}

export interface Allocation {
  split: RecurringSplitRow;
  amountCents: Cents;
}

/**
 * Largest remainder allocation over integer basis points. Total is the signed
 * transaction amount, allocation is done on the magnitude and the sign is put
 * back at the end, so a credit splits the same way a debit does.
 */
export function allocateByBasisPoints(
  total: Cents,
  splits: readonly RecurringSplitRow[],
): Allocation[] {
  const magnitude = abs(total);
  const sign = total < BigInt(0) ? BigInt(-1) : BigInt(1);
  const ordered = splits.slice().sort((a, b) => a.lineNumber - b.lineNumber);

  const floors: Cents[] = [];
  const remainders: bigint[] = [];
  let assigned = BigInt(0);
  for (const s of ordered) {
    const bps = BigInt(s.percentBps ?? 0);
    const product = magnitude * bps;
    const floor = product / BigInt(BASIS_POINTS_TOTAL);
    floors.push(floor);
    remainders.push(product - floor * BigInt(BASIS_POINTS_TOTAL));
    assigned += floor;
  }

  // Order the claims on the leftover cents: biggest fractional part first, and
  // when two claims tie the highest sequence line takes it. That tie break is
  // what puts the odd cent on the last line rather than somewhere arbitrary.
  const claims = ordered.map((s, i) => ({ i, line: s.lineNumber, r: remainders[i] }));
  claims.sort((a, b) => {
    if (a.r !== b.r) return a.r > b.r ? -1 : 1;
    return b.line - a.line;
  });

  let leftover = magnitude - assigned;
  for (const claim of claims) {
    if (leftover <= BigInt(0)) break;
    floors[claim.i] += BigInt(1);
    leftover -= BigInt(1);
  }
  // Anything still unassigned goes to the highest sequence line, which cannot
  // happen when the basis points sum to 10000 and is a guard rather than a path.
  if (leftover > BigInt(0)) floors[floors.length - 1] += leftover;

  return ordered.map((s, i) => ({ split: s, amountCents: sign * floors[i] }));
}

export const txnApplyRecurring: Run<CodingScope, Proposal> = {
  type: "TXN-APPLY-RECURRING",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => scope.clientId,
  scopeSchema: codingScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CodingScope>> {
    const tx = requireTx(ctx);
    const templates = await tx.query("recurring_templates_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    return freezeCodingScope(scope, ctx, "TXN-APPLY-RECURRING", 1, [
      ...templates.map((tpl) => ({ id: tpl.id, version: tpl.version })),
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
    const accounts = await tx.query("bank_accounts_for_client", {
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
    const allTemplates = await tx.query("recurring_templates_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const candidates = await tx.query("transactions_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: scope.from,
      to: scope.to,
      bankAccountIds: scope.bankAccountIds,
      includeOverridden: false,
    });

    const accountById = new Map<string, BankAccountRow>();
    for (const a of accounts) accountById.set(a.id, a);

    for (const tpl of allTemplates) {
      if (tpl.isActive) continue;
      skips.push({
        rowId: tpl.id,
        reason: "out_of_scope_engagement",
        detail: "template_inactive",
      });
    }
    // Template id ascending, doc 02 iteration order for the template side.
    const templates = allTemplates
      .filter((tpl) => tpl.isActive)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const splitCache = new Map<string, RecurringSplitRow[]>();
    const splitsFor = async (
      tpl: RecurringTemplateRow,
    ): Promise<RecurringSplitRow[]> => {
      const key = `${tpl.id}:${String(tpl.version)}`;
      const seen = splitCache.get(key);
      if (seen) return seen;
      const rows = await tx.query("recurring_splits_for_template", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        templateId: tpl.id,
        templateVersion: tpl.version,
      });
      const ordered = rows.slice().sort((a, b) => a.lineNumber - b.lineNumber);
      splitCache.set(key, ordered);
      return ordered;
    };

    for (const t of candidates.slice().sort(iterationOrder)) {
      if (isLockedDay(locks, t.postedDate)) {
        skips.push({
          rowId: t.id,
          reason: "locked_period",
          detail: `posted ${t.postedDate} falls inside a locked period`,
        });
        continue;
      }
      const level = resolvedLevel(t);
      if (level !== null && level < LEVEL.recurringTemplate) {
        skips.push(alreadyResolvedSkip(t, level));
        continue;
      }
      const currencySkip = foreignCurrencySkip(t, policy.functionalCurrency);
      if (currencySkip !== null) {
        skips.push(currencySkip);
        continue;
      }
      if (t.templateId !== null) {
        skips.push(alreadyResolvedSkip(t, LEVEL.recurringTemplate));
        continue;
      }
      if (t.normalizedVendor === null) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: "vendor is not normalized yet, TXN-NORMALIZE-VENDORS runs first",
        });
        continue;
      }

      const hits = templates.filter((tpl) => templateMatches(t, tpl));
      if (hits.length === 0) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: "no_recurring_template",
        });
        continue;
      }
      if (hits.length > 1) {
        proposals.push(
          suspenseProposal({
            transactionId: t.id,
            reasonCode: SUS_TEMPLATE_CONFLICT,
            detail: `templates conflict, every match: ${hits.map((h) => h.id).join(",")}`,
            relatedIds: hits.map((h) => h.id),
          }),
        );
        continue;
      }

      const tpl = hits[0];
      const splits = await splitsFor(tpl);
      if (splits.length === 0) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: `template ${tpl.id} version ${String(tpl.version)} has no split lines`,
        });
        continue;
      }

      const allocations = allocationsFor(t, tpl, splits);
      if (allocations === null) {
        proposals.push(
          suspenseProposal({
            transactionId: t.id,
            reasonCode: SUS_TEMPLATE_AMOUNT,
            detail: `template ${tpl.id} split lines do not sum to ${t.amountCents.toString()} cents`,
            relatedIds: [tpl.id],
          }),
        );
        continue;
      }

      let missing = false;
      for (const a of allocations) {
        if (!categories.has(a.split.categoryId)) {
          errors.push({
            rowId: t.id,
            code: "MISSING_ACCOUNT",
            message: `split category ${a.split.categoryId} on template ${tpl.id} is not on this client`,
            retryable: false,
          });
          missing = true;
        }
      }
      if (missing) continue;

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

      proposals.push(splitEntry(t, tpl, allocations, account));

      // The register row carries the largest allocation as its summary category,
      // ties going to the lowest sequence line. The entry is the full truth of the
      // split, the column is the one line answer to what this charge mostly was.
      const summary = allocations
        .slice()
        .sort((a, b) => {
          const aa = abs(a.amountCents);
          const ba = abs(b.amountCents);
          if (aa !== ba) return aa > ba ? -1 : 1;
          return a.split.lineNumber - b.split.lineNumber;
        })[0];
      const summaryCategory = categories.get(summary.split.categoryId);
      proposals.push(
        codingWrite({
          t,
          categoryId: summary.split.categoryId,
          categoryVersion: summaryCategory ? summaryCategory.version : 1,
          cascadeLevel: LEVEL.recurringTemplate,
          templateId: tpl.id,
          templateVersion: tpl.version,
        }),
      );
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
      runType: "TXN-APPLY-RECURRING",
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
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

/** Null means the split does not reconcile to the transaction amount. */
export function allocationsFor(
  t: TransactionRow,
  tpl: RecurringTemplateRow,
  splits: readonly RecurringSplitRow[],
): Allocation[] | null {
  const sign = t.amountCents < BigInt(0) ? BigInt(-1) : BigInt(1);
  const magnitude = abs(t.amountCents);

  if (tpl.splitMode === "single") {
    if (splits.length !== 1) return null;
    return [{ split: splits[0], amountCents: t.amountCents }];
  }

  if (tpl.splitMode === "fixed_amount") {
    const remainderLines = splits.filter((s) => s.isRemainder);
    if (remainderLines.length > 1) return null;
    let fixedTotal = BigInt(0);
    for (const s of splits) {
      if (s.isRemainder) continue;
      if (s.fixedAmountCents === null) return null;
      fixedTotal += abs(s.fixedAmountCents);
    }
    if (remainderLines.length === 0) {
      // Doc 02. Exact equality or nothing. No tolerance, no plug line.
      if (fixedTotal !== magnitude) return null;
      return splits.map((s) => ({
        split: s,
        amountCents: sign * abs(s.fixedAmountCents ?? BigInt(0)),
      }));
    }
    const remainder = magnitude - fixedTotal;
    if (remainder < BigInt(0)) return null;
    return splits.map((s) => ({
      split: s,
      amountCents: s.isRemainder
        ? sign * remainder
        : sign * abs(s.fixedAmountCents ?? BigInt(0)),
    }));
  }

  // fixed_percent. The basis points have to sum to exactly 10000 first.
  let bpsTotal = 0;
  for (const s of splits) {
    if (s.percentBps === null) return null;
    bpsTotal += s.percentBps;
  }
  if (bpsTotal !== BASIS_POINTS_TOTAL) return null;
  return allocateByBasisPoints(t.amountCents, splits);
}

function splitEntry(
  t: TransactionRow,
  tpl: RecurringTemplateRow,
  allocations: readonly Allocation[],
  account: BankAccountRow,
): ProposedJournalEntry {
  const memo = `recurring template ${tpl.name} version ${String(tpl.version)}`;
  const lines: ProposedLine[] = allocations.map((a) => ({
    accountNumber: a.split.accountNumber,
    categoryId: a.split.categoryId,
    // The bank saw money leave, so the split lines take the opposite sign of the
    // bank line. Negating the observed amount is what keeps the entry at zero.
    amountCents: -a.amountCents,
    memo: a.split.memo ?? memo,
    dimensions: {
      classId: a.split.classId ?? undefined,
      locationId: a.split.locationId ?? undefined,
      programId: a.split.programId ?? undefined,
    },
  }));
  lines.push({
    accountNumber: account.accountNumber,
    categoryId: null,
    amountCents: t.amountCents,
    memo,
    dimensions: {},
  });
  return {
    kind: "journal_entry",
    targetId: null,
    entryDate: t.postedDate,
    lines,
    sourceRef: { table: "transactions", rowId: t.id, version: t.version },
  };
}
