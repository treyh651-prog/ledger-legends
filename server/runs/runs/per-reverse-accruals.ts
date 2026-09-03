/**
 * PER-REVERSE-ACCRUALS. Take last period's accruals back off the books.
 *
 * Spec: docs/02-run-specifications.md Module 4 PER-REVERSE-ACCRUALS.
 *
 * An accrual is a promise to undo itself. PER-POST-ACCRUALS put the expense in
 * the period that earned it and stamped the day the promise comes due, which is
 * the first day of the following period. This run keeps the promise: it reads
 * every entry whose reversal day falls in the period being opened, flips every
 * line, and posts the mirror image on that day.
 *
 * Line for line, sign for sign. The reversal is built from the original's
 * stored lines rather than from the template that produced them, because the
 * template may have changed since. Reversing what was actually posted is the
 * only thing that returns the accounts to where they were.
 *
 * Supersession is the one case that does not reverse. When the real bill or
 * invoice arrived, someone linked it to the accrual, and the document now
 * carries the amount. Reversing on top of that would credit the expense twice,
 * once from the reversal and once from the document being the real cost. The
 * skip reason is superseded_version and the accrual stays where it is.
 *
 * Whether an accrual has already been reversed is answered by asking the ledger
 * for entries that point back at it, not by writing a flag onto the original.
 * The original sits in the period just closed, and a write to an entry dated in
 * a locked period is exactly what the period lock exists to refuse. Reading is
 * also the more honest test: a reversal posted by hand counts.
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
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { reverseEntry } from "../undo";
import type { JournalEntryRow, JournalLineRow } from "../tables";
import { periodWindow } from "./per-shared";

export const REVERSE_ERROR_CODES = {
  noLines: "PER_REVERSAL_ORIGINAL_HAS_NO_LINES",
  unbalanced: "PER_REVERSAL_ORIGINAL_UNBALANCED",
} as const;

export const reverseAccrualsScopeSchema = z.object({
  clientId: z.string().min(1),
  /**
   * Any day inside the period being opened. Reversals land on its first day,
   * which is where the accruals stamped by the previous period point.
   */
  period: z.string().min(10),
});

export type ReverseAccrualsScope = z.infer<typeof reverseAccrualsScopeSchema>;

export const perReverseAccruals: Run<ReverseAccrualsScope, Proposal> = {
  type: "PER-REVERSE-ACCRUALS",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.period.slice(0, 7)}`,
  scopeSchema: reverseAccrualsScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ReverseAccrualsScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const due = await tx.query("journal_entries_awaiting_reversal", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      from: window.periodStart,
      to: window.periodEnd,
    });

    const candidateIds = due.map((e) => e.id);
    const versions = [
      { id: "PER-REVERSE-ACCRUALS", version: 1 },
      // A journal entry carries no version of its own. The source version it
      // was posted from is what would change underneath a preview, so that is
      // what the scope freezes.
      ...due.map((e) => ({ id: e.id, version: e.sourceVersion })),
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
      // A posted entry carries no override flag. The template it came from
      // does, and PER-POST-ACCRUALS honored that when it decided to post.
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const due = await tx.query("journal_entries_awaiting_reversal", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: window.periodStart,
      to: window.periodEnd,
    });
    if (due.length === 0) {
      return makeResult<Proposal>(0, [], [], [], BigInt(0));
    }

    const lines = await tx.query("journal_lines_for_entries", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      entryIds: due.map((e) => e.id),
    });
    // Anything already pointing back at one of these entries is a reversal that
    // exists, whether this run made it last time or a person made it by hand.
    const existing = await tx.query("journal_entries_referencing", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      entryIds: due.map((e) => e.id),
    });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    const reversed = new Set<Ulid>(
      existing.map((e) => e.reversalOf).filter((id): id is Ulid => id !== null),
    );

    let net: Cents = BigInt(0);

    for (const original of due) {
      if (original.linkedDocumentId !== null) {
        skips.push({
          rowId: original.id,
          reason: "superseded_version",
          detail: `superseded by document ${original.linkedDocumentId}, the real bill carries the amount now`,
        });
        continue;
      }
      if (reversed.has(original.id)) {
        skips.push({
          rowId: original.id,
          reason: "already_applied",
          detail: `already_reversed, an entry already points back at ${original.id}`,
        });
        continue;
      }
      if (original.reversedByEntryId !== null) {
        skips.push({
          rowId: original.id,
          reason: "already_applied",
          detail: `already_reversed by entry ${original.reversedByEntryId}`,
        });
        continue;
      }

      const on = original.reversesOn;
      if (on === null) continue; // the query cannot return these, guarded anyway
      // Doc 03 Part 7. Skipped, never thrown, and never redated. A reversal
      // moved to a later day would sit in a period that did not carry the
      // accrual, which is a worse answer than leaving it for the person who
      // locked the period.
      if (isLockedDay(locks, on)) {
        skips.push({
          rowId: original.id,
          reason: "locked_period",
          detail: `reversal day ${on} falls inside a locked period`,
        });
        continue;
      }

      const originalLines = lines.filter((l) => l.entryId === original.id);
      if (originalLines.length === 0) {
        errors.push({
          rowId: original.id,
          code: REVERSE_ERROR_CODES.noLines,
          message: `entry ${original.id} is due to reverse and has no lines to reverse`,
          retryable: false,
        });
        continue;
      }
      const sum = originalLines.reduce(
        (acc, l) => acc + l.amountCents,
        BigInt(0),
      );
      if (sum !== BigInt(0)) {
        errors.push({
          rowId: original.id,
          code: REVERSE_ERROR_CODES.unbalanced,
          message: `entry ${original.id} sums to ${sum.toString()} rather than zero, so its mirror image would not balance either`,
          retryable: false,
        });
        continue;
      }

      const entry = reversalFor(original, originalLines, on);
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
      runType: "PER-REVERSE-ACCRUALS",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      // Undoing a reversal is a second reversal, which puts the accrual back.
      if (isJournalEntry(p) && p.targetId !== null) {
        plan.push(reverseEntry(p, p.targetId));
      }
    }
    return plan;
  },
};

/**
 * The mirror image of the original, dated on the reversal day.
 *
 * Every line is flipped and nothing else is touched. Category and dimensions
 * ride along unchanged, because a reversal that lands in a different class or
 * program than the accrual leaves both of them wrong.
 */
function reversalFor(
  original: JournalEntryRow,
  originalLines: readonly JournalLineRow[],
  on: string,
): ProposedJournalEntry {
  const lines: ProposedLine[] = originalLines.map((l) => ({
    accountNumber: l.accountNumber,
    categoryId: l.categoryId,
    amountCents: -l.amountCents,
    memo: `Reversal of ${l.memo}`,
    dimensions: {
      ...(l.classId === null ? {} : { classId: l.classId }),
      ...(l.locationId === null ? {} : { locationId: l.locationId }),
      ...(l.programId === null ? {} : { programId: l.programId }),
      ...(l.restriction === "with_donor_restrictions" ||
      l.restriction === "without_donor_restrictions"
        ? { restriction: l.restriction }
        : {}),
    },
  }));

  return {
    kind: "journal_entry",
    targetId: derivedId(original.id, "per-reverse-accruals", 0),
    entryDate: on,
    lines,
    reversalOf: original.id,
    // The reversal points at the same source row the accrual came from, so a
    // person following the template forward sees both halves of the pair.
    sourceRef: {
      table: original.sourceTable,
      rowId: original.sourceRowId,
      version: original.sourceVersion,
    },
    ...(original.accrualTemplateId === null
      ? {}
      : { accrualTemplateId: original.accrualTemplateId }),
  };
}
