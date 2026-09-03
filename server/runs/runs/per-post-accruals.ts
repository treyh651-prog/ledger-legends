/**
 * PER-POST-ACCRUALS. Post the period end accruals from their templates.
 *
 * Spec: docs/02-run-specifications.md Module 4 PER-POST-ACCRUALS, with the
 * accrual template table added by migration 0013.
 *
 * Three things happen at period end that the register cannot see. A bill has
 * been received and not entered. Wages have been earned and not paid. Revenue
 * has been earned and not billed. All three are real obligations of the period
 * and none of them has a transaction, so an accrual puts them on the books and
 * the following period takes them straight back off.
 *
 * Doc 05 D5 holds here without exception: payroll never disburses. A wage
 * accrual debits wage expense and credits an accrued liability. No cash account
 * appears on the entry, no payment is made, and nothing in this run moves money.
 *
 * Every accrual carries the day it reverses, which is the first day of the
 * following period. Storing it on the entry rather than deriving it later is
 * what lets PER-REVERSE-ACCRUALS select on one column, and it lets a person
 * move a reversal date and have the engine honor the move.
 *
 * The double count guard is the reason this run reads the period's entries
 * before it posts. If the real bill was already entered against the same
 * account for the same amount, the accrual is unnecessary and posting it would
 * put the expense in the period twice. That case is skipped, not posted and
 * then reversed.
 *
 * Amounts come from one of four bases and no others. A template with a basis
 * this run does not recognize is reported, because an amount nobody can
 * reproduce is worse than a missing accrual.
 */

import { z } from "zod";
import {
  makeResult,
  isJournalEntry,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedJournalEntry,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { reverseEntry } from "../undo";
import type { AccrualTemplateRow, JournalEntryRow, JournalLineRow } from "../tables";
import { monthKey, periodWindow } from "./per-shared";

export const ACCRUAL_ERROR_CODES = {
  unknownBasis: "PER_ACCRUAL_BASIS_UNKNOWN",
  missingInputs: "PER_ACCRUAL_BASIS_INPUTS_MISSING",
  zeroAmount: "PER_ACCRUAL_AMOUNT_IS_ZERO",
} as const;

export const postAccrualsScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type PostAccrualsScope = z.infer<typeof postAccrualsScopeSchema>;

export const perPostAccruals: Run<PostAccrualsScope, Proposal> = {
  type: "PER-POST-ACCRUALS",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.period.slice(0, 7)}`,
  scopeSchema: postAccrualsScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<PostAccrualsScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const templates = await tx.query("accrual_templates_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });

    const candidateIds = templates.map((t) => t.id);
    const versions = [
      { id: "PER-POST-ACCRUALS", version: 1 },
      ...templates.map((t) => ({ id: t.id, version: t.version })),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // The period is part of the hash. Two periods often see the same set of
      // rows at the same versions, and without the window in the hash the
      // second period would key to the first and be deduplicated away.
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: templates.filter((t) => t.manualOverride).map((t) => t.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const templates = await tx.query("accrual_templates_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const posted = await tx.query("journal_entries_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: window.periodStart,
      to: window.periodEnd,
    });
    const lines =
      posted.length === 0
        ? []
        : await tx.query("journal_lines_for_entries", {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            entryIds: posted.map((e) => e.id),
          });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    let net: Cents = BigInt(0);

    for (const template of templates) {
      if (template.manualOverride) {
        skips.push({
          rowId: template.id,
          reason: "manual_override",
          detail: `template ${template.id} carries manual_override`,
        });
        continue;
      }
      if (!template.isActive) {
        skips.push({
          rowId: template.id,
          reason: "missing_prerequisite",
          detail: `template_inactive, ${template.name} is switched off`,
        });
        continue;
      }
      if (postedFromTemplate(posted, template.id)) {
        skips.push({
          rowId: template.id,
          reason: "already_applied",
          detail: `already_accrued_this_period for ${template.name}`,
        });
        continue;
      }

      const amount = amountFor(template);
      if ("code" in amount) {
        errors.push({
          rowId: template.id,
          code: amount.code,
          message: amount.message,
          retryable: false,
        });
        continue;
      }

      // The double count guard. If the real document already hit the same
      // account for the same amount inside this period, accruing it again would
      // put the cost in the period twice.
      const dup = documentAlreadyPosted(
        posted,
        lines,
        template.debitAccount,
        amount.cents,
      );
      if (dup !== null) {
        skips.push({
          rowId: template.id,
          reason: "already_applied",
          detail: `source_document_already_posted, entry ${dup} carries ${amount.cents.toString()} on account ${template.debitAccount}`,
        });
        continue;
      }

      const postingDay = window.periodEnd;
      if (isLockedDay(locks, postingDay)) {
        skips.push({
          rowId: template.id,
          reason: "locked_period",
          detail: `period end ${postingDay} falls inside a locked period`,
        });
        continue;
      }

      const entry = entryFor(template, amount.cents, window.periodEnd, window.nextPeriodStart);
      proposals.push(entry);
      for (const l of entry.lines) net += l.amountCents;
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
      runType: "PER-POST-ACCRUALS",
      runVersion: 1,
    });
  },

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

interface AmountFailure {
  code: string;
  message: string;
}

/**
 * The four calculation bases doc 02 names, and nothing else.
 *
 * A basis outside the four is a specification question rather than a data
 * problem, so it is reported with the template id and the basis on it.
 */
function amountFor(
  template: AccrualTemplateRow,
): { cents: Cents } | AmountFailure {
  let cents: Cents;
  switch (template.basis) {
    case "fixed_amount": {
      if (template.fixedAmountCents === null) {
        return missing(template, "fixed_amount_cents");
      }
      cents = template.fixedAmountCents;
      break;
    }
    case "from_document": {
      if (template.sourceDocumentAmountCents === null) {
        return missing(template, "source_document_amount_cents");
      }
      cents = template.sourceDocumentAmountCents;
      break;
    }
    case "daily_rate_x_days": {
      if (template.dailyRateCents === null || template.dayCount === null) {
        return missing(template, "daily_rate_cents and day_count");
      }
      cents = template.dailyRateCents * BigInt(template.dayCount);
      break;
    }
    case "percent_of_base": {
      if (template.baseCents === null || template.percentBps === null) {
        return missing(template, "base_cents and percent_bps");
      }
      cents = (template.baseCents * BigInt(template.percentBps)) / BigInt(10000);
      break;
    }
    default: {
      return {
        code: ACCRUAL_ERROR_CODES.unknownBasis,
        message: `template ${template.id} uses basis ${String(template.basis)} which this run does not compute`,
      };
    }
  }
  if (cents === BigInt(0)) {
    return {
      code: ACCRUAL_ERROR_CODES.zeroAmount,
      message: `template ${template.id} computes an accrual of zero, which posts nothing`,
    };
  }
  // An accrual is stated as a positive amount and the entry decides the signs.
  return { cents: cents < BigInt(0) ? -cents : cents };
}

function missing(template: AccrualTemplateRow, fields: string): AmountFailure {
  return {
    code: ACCRUAL_ERROR_CODES.missingInputs,
    message: `template ${template.id} uses basis ${template.basis} and is missing ${fields}`,
  };
}

function postedFromTemplate(
  posted: readonly JournalEntryRow[],
  templateId: string,
): boolean {
  return posted.some(
    (e) =>
      e.accrualTemplateId === templateId ||
      (e.sourceTable === "accrual_templates" && e.sourceRowId === templateId),
  );
}

/**
 * Whether a real bill or invoice already put this amount on this account in
 * this period. Matching on account and amount together is deliberate: account
 * alone would suppress a second genuine accrual on a busy expense account, and
 * amount alone would suppress an unrelated coincidence.
 */
function documentAlreadyPosted(
  posted: readonly JournalEntryRow[],
  lines: readonly JournalLineRow[],
  account: string,
  amount: Cents,
): string | null {
  const fromDocuments = new Set(
    posted
      .filter((e) => e.sourceTable === "bills" || e.sourceTable === "invoices")
      .map((e) => e.id),
  );
  const hit = lines.find(
    (l) =>
      fromDocuments.has(l.entryId) &&
      l.accountNumber === account &&
      l.amountCents === amount,
  );
  return hit === undefined ? null : hit.entryId;
}

function entryFor(
  template: AccrualTemplateRow,
  amount: Cents,
  periodEnd: string,
  nextPeriodStart: string,
): ProposedJournalEntry {
  const memo = `${template.entryMemo} ${monthKey(periodEnd)}`;
  return {
    kind: "journal_entry",
    targetId: derivedId(
      `${template.id}:${monthKey(periodEnd)}`,
      "per-post-accruals",
      0,
    ),
    entryDate: periodEnd,
    lines: [
      // The expense, or the receivable on a revenue accrual.
      {
        accountNumber: template.debitAccount,
        categoryId: template.categoryId,
        amountCents: amount,
        memo,
        dimensions: {},
      },
      // The liability, or the revenue. Never a cash account: doc 05 D5.
      {
        accountNumber: template.creditAccount,
        categoryId: template.categoryId,
        amountCents: -amount,
        memo,
        dimensions: {},
      },
    ],
    // An accrual that does not reverse is a permanent adjustment, so the flag
    // on the template decides rather than the run.
    ...(template.autoReverse ? { reversesOn: nextPeriodStart } : {}),
    accrualTemplateId: template.id,
    sourceRef: {
      table: "accrual_templates",
      rowId: template.id,
      version: template.version,
    },
  };
}
