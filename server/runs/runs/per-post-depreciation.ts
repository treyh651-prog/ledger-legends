/**
 * PER-POST-DEPRECIATION. One month of depreciation on every fixed asset.
 *
 * COMPLIANCE. We are not CPAs. Depreciation here is a bookkeeping mechanic and
 * not a tax position. The method on the asset row says how the cost of a thing
 * is spread across the months it is used, which is a bookkeeping question about
 * matching cost to period. It is not advice about what a return may claim, and
 * the names straight line, declining balance, and MACRS are used here only as
 * the arithmetic they describe. Nothing in this file computes a tax liability,
 * a deduction, a basis adjustment, a section 179 election, or a bonus
 * depreciation position. If a question turns into any of those, it stops here
 * and routes to CPA-BUILD-HANDOFF.
 *
 * Spec: docs/02-run-specifications.md Module 4 PER-POST-DEPRECIATION, and doc 04
 * Part 4 for the asset and schedule tables.
 *
 * The run posts one entry per asset class per period, debiting the depreciation
 * expense account and crediting accumulated depreciation. Grouping by class
 * rather than by asset keeps the ledger readable: forty laptops produce one
 * line, not forty, and the per asset detail lives in the schedule table where
 * it belongs.
 *
 * The contra account is read from the asset row and never guessed. The plus one
 * hundred convention holds across most charts, but an asset whose contra
 * account does not exist is skipped with contra_account_missing rather than
 * posted to an account this run invented.
 *
 * Half month convention. When the flag is set, the month an asset is acquired
 * carries half a month of depreciation and the schedule runs half a month
 * longer, and the month an asset is disposed carries half a month as well. The
 * flag is a convention, not a rounding rule: it exists because an asset bought
 * on the 28th did not serve the whole month.
 *
 * Cumulative depreciation never passes the depreciable base. Cost minus salvage
 * is the whole of what can ever be written off, and the last month takes
 * whatever is left rather than whatever the formula produces.
 */

import { z } from "zod";
import {
  makeResult,
  isFieldWrite,
  isJournalEntry,
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
  requireTx,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
} from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { reverseEntry, revertFieldWrite } from "../undo";
import type { DepreciationScheduleRow, FixedAssetRow } from "../tables";
import { accumulated, DEPRECIATION_ERROR_CODES, monthlyPlan } from "./depreciation-shared";
import {
  halve,
  monthKey,
  periodWindow,
} from "./per-shared";

export { DEPRECIATION_ERROR_CODES };

export const postDepreciationScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type PostDepreciationScope = z.infer<typeof postDepreciationScopeSchema>;

export const perPostDepreciation: Run<PostDepreciationScope, Proposal> = {
  type: "PER-POST-DEPRECIATION",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.period.slice(0, 7)}`,
  scopeSchema: postDepreciationScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<PostDepreciationScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const assets = await tx.query("fixed_assets_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });

    const candidateIds = assets.map((a) => a.id);
    const versions = [
      { id: "PER-POST-DEPRECIATION", version: 1 },
      ...assets.map((a) => ({ id: a.id, version: a.version })),
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
      overriddenIds: assets.filter((a) => a.manualOverride).map((a) => a.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const window = periodWindow(frozen.input.period);
    const period = monthKey(window.periodEnd);
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const assets = await tx.query("fixed_assets_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const history =
      assets.length === 0
        ? []
        : await tx.query("depreciation_schedule_for_assets", {
            firmId: frozen.firmId,
            clientId: frozen.clientId,
            assetIds: assets.map((a) => a.id),
          });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    const postingDay = window.periodEnd;
    const periodLocked = isLockedDay(locks, postingDay);

    /** Assets that will post, grouped by the pair of accounts they hit. */
    const groups = new Map<string, GroupedAsset[]>();
    let net: Cents = BigInt(0);

    for (const asset of assets) {
      if (asset.manualOverride) {
        skips.push({
          rowId: asset.id,
          reason: "manual_override",
          detail: `asset ${asset.id} carries manual_override`,
        });
        continue;
      }
      if (asset.method === "none") {
        skips.push({
          rowId: asset.id,
          reason: "out_of_scope_engagement",
          detail: `asset ${asset.description} is not depreciated`,
        });
        continue;
      }
      if (asset.status === "fully_depreciated") {
        skips.push({
          rowId: asset.id,
          reason: "already_applied",
          detail: `fully_depreciated, nothing left of the base`,
        });
        continue;
      }
      if (asset.status === "written_off") {
        skips.push({
          rowId: asset.id,
          reason: "out_of_scope_engagement",
          detail: `asset ${asset.id} was written off`,
        });
        continue;
      }
      if (asset.status === "disposed") {
        // PER-DISPOSE-ASSET already posted whatever final charge the
        // disposal month owed and recorded it as a schedule row, so reaching
        // here at all would mean that record is missing; either way the
        // asset left the books and there is nothing left for this run to do.
        skips.push({
          rowId: asset.id,
          reason: "out_of_scope_engagement",
          detail: `asset ${asset.id} was disposed on ${String(asset.disposedOn)}`,
        });
        continue;
      }
      if (window.periodEnd < asset.placedInServiceOn) {
        skips.push({
          rowId: asset.id,
          reason: "missing_prerequisite",
          detail: `not_in_service, placed in service ${asset.placedInServiceOn}`,
        });
        continue;
      }
      // A disposal is a half month in the month it happens and nothing after.
      if (asset.disposedOn !== null && asset.disposedOn < window.periodStart) {
        skips.push({
          rowId: asset.id,
          reason: "out_of_scope_engagement",
          detail: `disposed on ${asset.disposedOn}, before this period`,
        });
        continue;
      }

      const mine = history.filter((h) => h.assetId === asset.id);
      const already = mine.find((h) => monthKey(h.periodEnd) === period);
      if (already !== undefined) {
        skips.push({
          rowId: asset.id,
          reason: "already_applied",
          detail: `already_posted_this_period, schedule row ${already.id} status ${already.status}`,
        });
        continue;
      }

      const plan = monthlyPlan(asset);
      if ("code" in plan) {
        errors.push({
          rowId: asset.id,
          code: plan.code,
          message: plan.message,
          retryable: false,
        });
        continue;
      }

      const slot = plan.months.find((m) => m.period === period);
      if (slot === undefined) {
        skips.push({
          rowId: asset.id,
          reason: "already_applied",
          detail: `schedule_exhausted, the life ended before ${period}`,
        });
        continue;
      }

      const accumulatedBefore = accumulated(mine);
      const remaining = asset.depreciableBaseCents - accumulatedBefore;
      if (remaining <= BigInt(0)) {
        skips.push({
          rowId: asset.id,
          reason: "already_applied",
          detail: `fully_depreciated, accumulated ${accumulatedBefore.toString()} covers the base`,
        });
        continue;
      }

      let amount = slot.amountCents;
      // Disposal in this month is half a month under the convention, and the
      // last month of a life never writes off more than is left.
      if (
        asset.halfMonthConvention &&
        asset.disposedOn !== null &&
        monthKey(asset.disposedOn) === period
      ) {
        amount = halve(amount);
      }
      if (amount > remaining) amount = remaining;
      if (amount <= BigInt(0)) {
        skips.push({
          rowId: asset.id,
          reason: "already_applied",
          detail: `zero_depreciation for ${period}`,
        });
        continue;
      }

      const contra = await tx.query("chart_account", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        accountNumber: asset.accumAccount,
      });
      if (contra.length === 0) {
        // Never guessed. Posting accumulated depreciation to an account that
        // does not exist puts the balance sheet out by the whole amount.
        skips.push({
          rowId: asset.id,
          reason: "missing_prerequisite",
          detail: `contra_account_missing, ${asset.accumAccount} is not on the chart`,
        });
        continue;
      }
      if (periodLocked) {
        skips.push({
          rowId: asset.id,
          reason: "locked_period",
          detail: `period end ${postingDay} falls inside a locked period`,
        });
        continue;
      }

      const key = `${asset.expenseAccount}|${asset.accumAccount}`;
      const bucket = groups.get(key) ?? [];
      bucket.push({
        asset,
        amountCents: amount,
        accumulatedAfterCents: accumulatedBefore + amount,
        periodNumber: slot.periodNumber,
      });
      groups.set(key, bucket);
      net += amount;
    }

    // One entry per class, in a stable order so a rerun produces the same ids.
    for (const key of Array.from(groups.keys()).sort()) {
      const bucket = groups.get(key) ?? [];
      const entry = classEntry(
        frozen.clientId,
        key,
        bucket,
        window.periodEnd,
        period,
      );
      proposals.push(entry);
      for (const item of bucket) {
        proposals.push(
          scheduleInsert(item, window.periodStart, window.periodEnd, entry.targetId),
        );
      }
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
      runType: "PER-POST-DEPRECIATION",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isJournalEntry(p) && p.targetId !== null) {
        plan.push(reverseEntry(p, p.targetId));
      } else if (isFieldWrite(p)) {
        plan.push(revertFieldWrite(p));
      }
      // The schedule row stays. It is the record that the period was taken,
      // and the reversing entry is what returns the accounts.
    }
    return plan;
  },
};

interface GroupedAsset {
  asset: FixedAssetRow;
  amountCents: Cents;
  accumulatedAfterCents: Cents;
  periodNumber: number;
}

function classEntry(
  clientId: Ulid,
  groupKey: string,
  bucket: readonly GroupedAsset[],
  entryDate: string,
  period: string,
): ProposedJournalEntry {
  const [expenseAccount, accumAccount] = groupKey.split("|");
  const assetClass = bucket.length > 0 ? bucket[0].asset.assetClass : "assets";
  const total = bucket.reduce((acc, i) => acc + i.amountCents, BigInt(0));
  const memo = `Depreciation ${assetClass} ${period}`;
  const lines: ProposedLine[] = [
    {
      accountNumber: expenseAccount,
      categoryId: null,
      amountCents: total,
      memo,
      dimensions: {},
    },
    {
      accountNumber: accumAccount,
      categoryId: null,
      amountCents: -total,
      memo,
      dimensions: {},
    },
  ];
  return {
    kind: "journal_entry",
    targetId: derivedId(
      `${clientId}:${period}:${groupKey}`,
      "per-post-depreciation",
      0,
    ),
    entryDate,
    lines,
    // The entry belongs to the class rather than to one asset, so the source
    // row is the first asset of the group and the schedule rows carry the
    // per asset detail.
    sourceRef: {
      table: "fixed_assets",
      rowId: bucket.length > 0 ? bucket[0].asset.id : clientId,
      version: bucket.length > 0 ? bucket[0].asset.version : 1,
    },
  };
}

function scheduleInsert(
  item: GroupedAsset,
  periodStart: string,
  periodEnd: string,
  entryId: Ulid | null,
): ProposedRowInsert {
  const rowId = derivedId(
    `${item.asset.id}:${monthKey(periodEnd)}`,
    "per-depreciation-line",
    0,
  );
  const row: DepreciationScheduleRow = {
    id: rowId,
    firmId: item.asset.firmId,
    clientId: item.asset.clientId,
    assetId: item.asset.id,
    periodStart,
    periodEnd,
    periodNumber: item.periodNumber,
    scheduleVersion: item.asset.version,
    amountCents: item.amountCents,
    accumulatedAfterCents: item.accumulatedAfterCents,
    nbvAfterCents: item.asset.costCents - item.accumulatedAfterCents,
    status: "posted",
    postedEntryId: entryId,
    postedRunId: RUN_ID_PLACEHOLDER,
    postedAt: NOW_PLACEHOLDER,
    manualOverride: false,
    version: 1,
  };
  return {
    kind: "row_insert",
    table: "depreciation_schedule",
    rowId,
    row: row as unknown as Record<string, unknown>,
    provenance: { cascadeLevel: null },
  };
}
