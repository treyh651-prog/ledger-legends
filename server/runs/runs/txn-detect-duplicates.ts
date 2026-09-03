/**
 * TXN-DETECT-DUPLICATES. Flag possible duplicates, decide nothing.
 *
 * Spec: docs/02-run-specifications.md Module 2 TXN-DETECT-DUPLICATES. Level 2 of
 * the cascade in docs/00-conventions.md Part 3, which is why it runs before
 * transfer pairing, settlement splitting, and every coding step. A row the bank
 * sent twice is not a transfer and not an expense, it is a data problem, and
 * deciding that first keeps the rest of the cascade from coding a phantom.
 *
 * The match test, all conditions required:
 *   1. Same client.
 *   2. Same bank or card account.
 *   3. Equal absolute amount, exact integer cents, no tolerance.
 *   4. Equal normalized vendor, exact string equality.
 *   5. Posted date gap of 3 calendar days or fewer.
 *   6. Neither row already carrying the legitimate repeat confirmation.
 *   7. Neither row carrying the manual override flag.
 *
 * Direction. The group is sorted by posted date ascending, absolute amount
 * ascending, id ascending. The earliest member is the retained original and it is
 * never flagged. Every later member is flagged against that one earliest row. The
 * pointer is one directional on purpose: three matching rows produce two flags
 * both aimed at the first row, not a chain and not a ring.
 *
 * This run proposes and never posts. It does not delete, it does not merge, and
 * it does not net anything against anything. A duplicate that turns out to be a
 * real second charge is cleared by a person setting the legitimate repeat flag,
 * and this run then reports that row as a confirmed repeat forever after.
 */

import {
  makeResult,
  isFieldWrite,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { addDays, dayGap, isLockedDay } from "../dates";
import { revertFieldWrite } from "../undo";
import type { TransactionRow } from "../tables";
import {
  LEVEL,
  abs,
  codingScopeSchema,
  freezeCodingScope,
  iterationOrder,
  overrideSkips,
  resolvedLevel,
  suspenseProposal,
  type CodingScope,
} from "./coding-cascade";

export const DUPLICATE_WINDOW_DAYS = 3;
export const SUS_POSSIBLE_DUPLICATE = "SUS-05";

/**
 * The four values that have to agree exactly. Absolute amount rather than signed
 * amount, because a refund is not a duplicate of the charge it reverses and the
 * sign test that separates them belongs to the chargeback rule, not to this one.
 */
/**
 * The exact match key. A row with no normalized vendor never reaches this
 * function, because an unnormalized row has no comparable descriptor at all and
 * treating a missing key as an empty key would make every unnormalized row in
 * the client resemble every other one. That is the whole reason
 * TXN-NORMALIZE-VENDORS runs first.
 */
function matchKey(t: TransactionRow): string {
  return [
    t.bankAccountId,
    abs(t.amountCents).toString(),
    t.normalizedVendor ?? "",
  ].join("\u0000");
}

export const txnDetectDuplicates: Run<CodingScope, Proposal> = {
  type: "TXN-DETECT-DUPLICATES",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => scope.clientId,
  scopeSchema: codingScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CodingScope>> {
    return freezeCodingScope(scope, ctx, "TXN-DETECT-DUPLICATES", 1, [
      { id: "DUPLICATE-WINDOW", version: DUPLICATE_WINDOW_DAYS },
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

    // The comparison set spans three days either side of the window. Without the
    // buffer a monthly run would miss the pair that straddles the month end and
    // would then find it again next month, reporting the same duplicate twice.
    const buffered = await tx.query("transactions_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: addDays(scope.from, -DUPLICATE_WINDOW_DAYS),
      to: addDays(scope.to, DUPLICATE_WINDOW_DAYS),
      bankAccountIds: null,
      includeOverridden: false,
    });

    const inScope = new Set<Ulid>(frozen.candidateIds);
    const overridden = new Set<Ulid>(frozen.overriddenIds);

    const eligible: TransactionRow[] = [];
    for (const t of buffered.slice().sort(iterationOrder)) {
      if (overridden.has(t.id)) continue;
      if (t.status !== "active") continue;
      if (!inScope.has(t.id)) {
        // A buffer row. Never flagged here, only ever used as an earlier original.
        eligible.push(t);
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
      if (t.duplicateFlag) {
        skips.push({
          rowId: t.id,
          reason: "already_applied",
          detail: t.legitimateRepeat ? "confirmed_repeat" : "duplicate_flag_exists",
        });
        continue;
      }
      if (t.legitimateRepeat) {
        skips.push({
          rowId: t.id,
          reason: "already_applied",
          detail: "confirmed_repeat",
        });
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
      const level = resolvedLevel(t);
      if (level !== null && level < LEVEL.duplicate) {
        skips.push({
          rowId: t.id,
          reason: "already_applied",
          detail: `already_resolved_level_${String(level)}`,
        });
        continue;
      }
      eligible.push(t);
    }

    const flaggable = new Set<Ulid>();
    for (const t of eligible) if (inScope.has(t.id)) flaggable.add(t.id);

    // Group by the exact match key, then walk each group in iteration order.
    const groups = new Map<string, TransactionRow[]>();
    for (const t of eligible) {
      if (t.legitimateRepeat) continue;
      if (t.normalizedVendor === null) continue;
      const key = matchKey(t);
      const bucket = groups.get(key);
      if (bucket) bucket.push(t);
      else groups.set(key, [t]);
    }

    const orderedKeys = Array.from(groups.keys()).sort();
    for (const key of orderedKeys) {
      const members = (groups.get(key) ?? []).slice().sort(iterationOrder);
      if (members.length < 2) continue;
      const original = members[0];
      for (let i = 1; i < members.length; i += 1) {
        const later = members[i];
        if (dayGap(later.postedDate, original.postedDate) > DUPLICATE_WINDOW_DAYS) {
          continue;
        }
        if (!flaggable.has(later.id)) continue;
        const write: ProposedFieldWrite = {
          kind: "field_write",
          table: "transactions",
          rowId: later.id,
          before: {
            duplicateFlag: later.duplicateFlag,
            duplicateOfTransactionId: later.duplicateOfTransactionId,
            cascadeLevel: later.cascadeLevel,
          },
          after: {
            duplicateFlag: true,
            duplicateOfTransactionId: original.id,
            cascadeLevel: LEVEL.duplicate,
          },
          provenance: { cascadeLevel: LEVEL.duplicate },
        };
        proposals.push(write);
        proposals.push(
          suspenseProposal({
            transactionId: later.id,
            reasonCode: SUS_POSSIBLE_DUPLICATE,
            detail: `possible duplicate of ${original.id}, same account, ${abs(later.amountCents).toString()} cents, gap ${String(dayGap(later.postedDate, original.postedDate))} days`,
            relatedIds: [original.id],
          }),
        );
      }
    }

    return makeResult<Proposal>(
      frozen.candidateIds.length,
      proposals,
      skips,
      errors,
      BigInt(0),
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "TXN-DETECT-DUPLICATES",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      // Shape R2. The flag and the pointer go back. The SUS-05 item stays,
      // because the resemblance the run recorded really is there and a person
      // still owes an answer about it.
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};
