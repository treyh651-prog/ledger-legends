/**
 * PER-POST-RECURRING. Post the recurring journal templates for one period.
 *
 * Spec: docs/02-run-specifications.md Module 4, and doc 04 Part 6 for the
 * template and split tables.
 *
 * Rent, insurance, and subscriptions are the same problem three times: an
 * amount that is known before the period starts and does not depend on
 * anything the bank did. A template says what to post, this run says when, and
 * the pair of them is what stops a closer typing the same rent entry twelve
 * times a year.
 *
 * One table holds two kinds of template. A transaction_match template
 * recognizes a row that already landed on the register, and TXN-APPLY-RECURRING
 * owns those. A generated_entry template produces a journal entry whether or
 * not a transaction exists, and only those are candidates here. Reading the
 * wrong kind would post rent twice: once from the template and once from the
 * bank row TXN-APPLY-RECURRING already coded.
 *
 * Idempotency is per client, template, and period. The key is not a flag on
 * the template but the presence of a posted entry in the period whose source
 * row is the template, which is the only test that survives a database restore
 * and the only one that stays true if someone posts the entry by hand.
 *
 * The entry id is derived from the template and the period, so a preview and
 * an apply describe the same entry, and a second apply of the same period
 * collides with the row already there instead of creating a duplicate.
 *
 * Amounts come from the split rows. Two shapes are allowed: fixed cents, and
 * basis points of the driver amount stored on the template. A basis point
 * template needs exactly one remainder line, which absorbs the rounding, so
 * the splits always add to the driver exactly.
 */

import { z } from "zod";
import {
  makeResult,
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
  type Ulid,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import type { RunTx } from "../db";
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { reverseEntry } from "../undo";
import type {
  JournalEntryRow,
  RecurringSplitRow,
  RecurringTemplateRow,
} from "../tables";
import {
  SUPPORTED_CADENCES,
  cadenceDueIn,
  periodWindow,
  postingDayFor,
  type PeriodWindow,
} from "./per-shared";

export const RECURRING_ERROR_CODES = {
  unbalancedTemplate: "PER_TEMPLATE_UNBALANCED",
  noSplits: "PER_TEMPLATE_HAS_NO_SPLITS",
  missingDriver: "PER_TEMPLATE_MISSING_DRIVER_AMOUNT",
  remainderShape: "PER_TEMPLATE_REMAINDER_SHAPE",
} as const;

export const postRecurringScopeSchema = z.object({
  clientId: z.string().min(1),
  /** Any day inside the period. The run works on the calendar month it names. */
  period: z.string().min(10),
});

export type PostRecurringScope = z.infer<typeof postRecurringScopeSchema>;

export const perPostRecurring: Run<PostRecurringScope, Proposal> = {
  type: "PER-POST-RECURRING",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.period.slice(0, 7)}`,
  scopeSchema: postRecurringScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<PostRecurringScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const templates = await generatedTemplates(tx, ctx.firmId, scope.clientId);

    const candidateIds = templates.map((t) => t.id);
    const versions = [
      { id: "PER-POST-RECURRING", version: 1 },
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

    const templates = await generatedTemplates(tx, frozen.firmId, frozen.clientId);
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const posted = await tx.query("journal_entries_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: window.periodStart,
      to: window.periodEnd,
    });

    let net: Cents = BigInt(0);

    for (const template of templates) {
      // Doc 03 Part 6. A person who edited this template has made a decision
      // and the run does not post over it.
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
      if (alreadyPosted(posted, template.id)) {
        skips.push({
          rowId: template.id,
          reason: "already_applied",
          detail: `already_posted_this_period, an entry for ${template.name} already exists in ${window.periodStart.slice(0, 7)}`,
        });
        continue;
      }

      const dueSkip = dueness(template, window);
      if (dueSkip !== null) {
        skips.push(dueSkip);
        continue;
      }

      const postingDay = postingDayFor(
        window,
        template.postingDateRule,
        template.dayOfMonth,
      );
      // Doc 03 Part 7. A locked period is skipped, never thrown, and never
      // redated. A recurring entry redated into the open period would put rent
      // for March into April, which is a worse answer than not posting.
      if (isLockedDay(locks, postingDay)) {
        skips.push({
          rowId: template.id,
          reason: "locked_period",
          detail: `posting day ${postingDay} falls inside a locked period`,
        });
        continue;
      }

      const splits = await tx.query("recurring_splits_for_template", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        templateId: template.id,
        templateVersion: template.version,
      });
      const built = buildLines(template, splits, postingDay);
      if ("code" in built) {
        errors.push({
          rowId: template.id,
          code: built.code,
          message: built.message,
          retryable: false,
        });
        continue;
      }

      proposals.push(entryFor(template, built.lines, postingDay));
      for (const line of built.lines) net += line.amountCents;
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
      runType: "PER-POST-RECURRING",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      // Shape R1. A posted entry is undone by a reversing entry, never by
      // deleting the row, because a deleted entry is a hole in the audit trail.
      if (isJournalEntry(p) && p.targetId !== null) {
        plan.push(reverseEntry(p, p.targetId));
      }
    }
    return plan;
  },
};

async function generatedTemplates(
  tx: RunTx,
  firmId: Ulid,
  clientId: Ulid,
): Promise<RecurringTemplateRow[]> {
  const all = await tx.query("recurring_templates_for_client", {
    firmId,
    clientId,
  });
  return all
    .filter((t) => t.matchKind === "generated_entry")
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function alreadyPosted(
  posted: readonly JournalEntryRow[],
  templateId: Ulid,
): boolean {
  return posted.some(
    (e) => e.sourceTable === "recurring_templates" && e.sourceRowId === templateId,
  );
}

/**
 * Whether the template is due in this period, and why not when it is not.
 *
 * A template that has not started yet, has ended, or whose cadence does not
 * land on this month is not an error and not a candidate: it is a skip with a
 * reason a person can read.
 */
function dueness(
  template: RecurringTemplateRow,
  window: PeriodWindow,
): Skip | null {
  const start = template.startDate;
  if (start === null) {
    return {
      rowId: template.id,
      reason: "missing_prerequisite",
      detail: `template_missing_start_date, a generated entry template needs one to know which periods it covers`,
    };
  }
  if (window.periodEnd < start) {
    return {
      rowId: template.id,
      reason: "missing_prerequisite",
      detail: `not_started, the template starts ${start}`,
    };
  }
  if (template.endDate !== null && window.periodStart > template.endDate) {
    return {
      rowId: template.id,
      reason: "missing_prerequisite",
      detail: `template_ended on ${template.endDate}`,
    };
  }
  const cadence = template.cadence;
  if (cadence === null) {
    return {
      rowId: template.id,
      reason: "missing_prerequisite",
      detail: `template_missing_cadence`,
    };
  }
  if (!SUPPORTED_CADENCES.includes(cadence)) {
    // Weekly and semi monthly post more than once inside a period. A run that
    // fires once per period cannot represent them, and inventing a rule for
    // which of the several dates to use would be the engine deciding a
    // question the specification has not answered.
    return {
      rowId: template.id,
      reason: "ambiguous_candidate",
      detail: `cadence_not_period_shaped, ${cadence} posts more than once in a period`,
    };
  }
  if (!cadenceDueIn(cadence, start, window.periodStart)) {
    return {
      rowId: template.id,
      reason: "missing_prerequisite",
      detail: `not_due_this_period, ${cadence} counted from ${start}`,
    };
  }
  return null;
}

interface BuildFailure {
  code: string;
  message: string;
}

/**
 * Turn the split rows into balanced journal lines.
 *
 * Fixed amount splits are taken as written and have to sum to zero on their
 * own. Basis point splits are applied to the template's driver amount, and the
 * single remainder line takes whatever the basis points did not reach, which
 * is what makes a 3333 and 3333 and 3334 split land exactly on 10000.
 */
function buildLines(
  template: RecurringTemplateRow,
  splits: readonly RecurringSplitRow[],
  postingDay: string,
): { lines: ProposedLine[] } | BuildFailure {
  if (splits.length === 0) {
    return {
      code: RECURRING_ERROR_CODES.noSplits,
      message: `template ${template.id} has no split lines and cannot produce an entry`,
    };
  }
  const memo = template.entryMemoTemplate ?? template.name;
  const ordered = splits
    .slice()
    .sort((a, b) => (a.lineNumber < b.lineNumber ? -1 : 1));

  const usesPercent = ordered.some((s) => s.percentBps !== null);
  if (!usesPercent) {
    const lines = ordered.map((s) => line(s, s.fixedAmountCents ?? BigInt(0), memo, postingDay));
    const sum = lines.reduce((acc, l) => acc + l.amountCents, BigInt(0));
    if (sum !== BigInt(0)) {
      return {
        code: RECURRING_ERROR_CODES.unbalancedTemplate,
        message: `template ${template.id} splits sum to ${sum.toString()} rather than zero`,
      };
    }
    return { lines };
  }

  const driver = template.driverAmountCents;
  if (driver === null) {
    return {
      code: RECURRING_ERROR_CODES.missingDriver,
      message: `template ${template.id} has basis point splits and no driver amount to apply them to`,
    };
  }
  const remainders = ordered.filter((s) => s.isRemainder);
  if (remainders.length !== 1) {
    return {
      code: RECURRING_ERROR_CODES.remainderShape,
      message: `template ${template.id} has ${String(remainders.length)} remainder lines, a basis point template needs exactly one`,
    };
  }

  const lines: ProposedLine[] = [];
  let allocated: Cents = BigInt(0);
  for (const s of ordered) {
    if (s.isRemainder) continue;
    const amount = (driver * BigInt(s.percentBps ?? 0)) / BigInt(10000);
    allocated += amount;
    lines.push(line(s, amount, memo, postingDay));
  }
  lines.push(line(remainders[0], -allocated, memo, postingDay));
  return { lines };
}

function line(
  split: RecurringSplitRow,
  amountCents: Cents,
  memo: string,
  postingDay: string,
): ProposedLine {
  return {
    accountNumber: split.accountNumber,
    categoryId: split.categoryId,
    amountCents,
    memo: split.memo ?? `${memo} ${postingDay.slice(0, 7)}`,
    dimensions: {
      ...(split.classId === null ? {} : { classId: split.classId }),
      ...(split.locationId === null ? {} : { locationId: split.locationId }),
      ...(split.programId === null ? {} : { programId: split.programId }),
    },
  };
}

function entryFor(
  template: RecurringTemplateRow,
  lines: ProposedLine[],
  postingDay: string,
): ProposedJournalEntry {
  return {
    kind: "journal_entry",
    // Derived from the template and the period, which is the idempotency key
    // this run promises, expressed as an id rather than as a lookup.
    targetId: derivedId(
      `${template.id}:${postingDay.slice(0, 7)}`,
      "per-post-recurring",
      0,
    ),
    entryDate: postingDay,
    lines,
    sourceRef: {
      table: "recurring_templates",
      rowId: template.id,
      version: template.version,
    },
  };
}
