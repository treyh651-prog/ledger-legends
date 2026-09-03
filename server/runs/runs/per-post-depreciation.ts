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
import {
  addMonths,
  evenSplit,
  halve,
  monthKey,
  periodWindow,
  startOfMonth,
} from "./per-shared";

export const DEPRECIATION_ERROR_CODES = {
  missingLife: "PER_ASSET_LIFE_MISSING",
  unsupportedMethod: "PER_ASSET_METHOD_UNSUPPORTED",
  missingRecovery: "PER_ASSET_MACRS_RECOVERY_MISSING",
} as const;

/**
 * MACRS general depreciation system, half year convention, expressed in parts
 * per million of the depreciable base so the arithmetic stays in integers. The
 * three, five, seven, and ten year classes are two hundred percent declining
 * balance switching to straight line. Fifteen and twenty year are one hundred
 * fifty percent. These are the published annual percentages and they are stored
 * as a table because deriving them reproduces rounding the tables already
 * settled.
 *
 * They are used here as an allocation pattern for the books. Choosing a
 * recovery period for a return is a tax position and is not made here.
 */
const MACRS_PPM: Record<number, readonly number[]> = {
  3: [333300, 444500, 148100, 74100],
  5: [200000, 320000, 192000, 115200, 115200, 57600],
  7: [142900, 244900, 174900, 124900, 89300, 89200, 89300, 44600],
  10: [
    100000, 180000, 144000, 115200, 92200, 73700, 65500, 65500, 65600, 65500,
    32800,
  ],
  15: [
    50000, 95000, 85500, 77000, 69300, 62300, 59000, 59000, 59100, 59000, 59100,
    59000, 59100, 59000, 59100, 29500,
  ],
  20: [
    37500, 72190, 66770, 61770, 57130, 52850, 48880, 45220, 44620, 44610, 44620,
    44610, 44620, 44610, 44620, 44610, 44620, 44610, 44620, 44610, 22310,
  ],
};

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

interface PlanMonth {
  period: string;
  periodNumber: number;
  amountCents: Cents;
}

interface PlanFailure {
  code: string;
  message: string;
}

function accumulated(rows: readonly DepreciationScheduleRow[]): Cents {
  return rows
    .filter((r) => r.status === "posted")
    .reduce((acc, r) => acc + r.amountCents, BigInt(0));
}

/**
 * The whole monthly schedule for an asset, from the month it was placed in
 * service to the month the base runs out.
 *
 * The schedule is computed in full rather than one month at a time so that the
 * residual can be placed deliberately in the final month. A month at a time
 * calculation has nowhere to put the rounding and leaves a few cents of base
 * that never depreciate.
 *
 * The half month convention is applied as a last pass over whatever the method
 * produced: the first month is halved and the half that was taken out is added
 * as one extra month on the end. Doing it uniformly, rather than inside each
 * method, is what keeps straight line, declining balance, and MACRS agreeing
 * that the total written off is exactly the depreciable base.
 */
function monthlyPlan(
  asset: FixedAssetRow,
): { months: PlanMonth[] } | PlanFailure {
  const base = asset.depreciableBaseCents;
  let raw: Cents[];

  switch (asset.method) {
    case "straight_line": {
      if (asset.lifeMonths === null || asset.lifeMonths <= 0) {
        return {
          code: DEPRECIATION_ERROR_CODES.missingLife,
          message: `asset ${asset.id} is straight line and carries no life in months`,
        };
      }
      raw = evenSplit(base, asset.lifeMonths);
      break;
    }
    case "ddb":
    case "ddb_150": {
      if (asset.lifeMonths === null || asset.lifeMonths <= 0) {
        return {
          code: DEPRECIATION_ERROR_CODES.missingLife,
          message: `asset ${asset.id} is declining balance and carries no life in months`,
        };
      }
      raw = decliningBalance(
        base,
        asset.lifeMonths,
        asset.ddbFactorBps ?? (asset.method === "ddb" ? 20000 : 15000),
      );
      break;
    }
    case "macrs": {
      const years = asset.macrsRecoveryYears;
      if (years === null || MACRS_PPM[years] === undefined) {
        return {
          code: DEPRECIATION_ERROR_CODES.missingRecovery,
          message: `asset ${asset.id} is MACRS and carries no recovery period this run has a table for`,
        };
      }
      raw = macrsMonths(base, MACRS_PPM[years]);
      break;
    }
    default: {
      // Units of production depends on a usage reading nobody has entered, and
      // sum of years digits is not in the module 4 brief. Both are reported
      // rather than approximated with a method they are not.
      return {
        code: DEPRECIATION_ERROR_CODES.unsupportedMethod,
        message: `asset ${asset.id} uses method ${asset.method}, which this run does not compute`,
      };
    }
  }

  if (asset.halfMonthConvention && raw.length > 0) {
    const first = raw[0];
    const half = halve(first);
    const carried = first - half;
    raw = [half, ...raw.slice(1), carried];
  }

  const start = startOfMonth(asset.placedInServiceOn);
  const months: PlanMonth[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    months.push({
      period: monthKey(addMonths(start, i)),
      periodNumber: i + 1,
      amountCents: raw[i],
    });
  }
  return { months };
}

/**
 * Declining balance over the life, switching to straight line for the rest of
 * the life the first month straight line gives the larger number. The switch is
 * the standard mechanic and it is deterministic: the same asset produces the
 * same month by month schedule every time it is computed.
 */
function decliningBalance(
  base: Cents,
  lifeMonths: number,
  factorBps: number,
): Cents[] {
  const out: Cents[] = [];
  let remaining = base;
  for (let i = 0; i < lifeMonths; i += 1) {
    const monthsLeft = lifeMonths - i;
    if (monthsLeft === 1) {
      out.push(remaining);
      remaining = BigInt(0);
      continue;
    }
    const declining =
      (remaining * BigInt(factorBps)) / (BigInt(10000) * BigInt(lifeMonths));
    const straight = remaining / BigInt(monthsLeft);
    const take = straight > declining ? straight : declining;
    out.push(take);
    remaining -= take;
  }
  return out;
}

/**
 * Spread each MACRS annual percentage across the twelve months of its recovery
 * year, residual in the twelfth. The published table is the authority for the
 * year totals and this only decides how a year is presented monthly.
 */
function macrsMonths(base: Cents, annualPpm: readonly number[]): Cents[] {
  const out: Cents[] = [];
  let assigned = BigInt(0);
  for (let y = 0; y < annualPpm.length; y += 1) {
    const isLastYear = y === annualPpm.length - 1;
    const yearTotal = isLastYear
      ? base - assigned
      : (base * BigInt(annualPpm[y])) / BigInt(1000000);
    assigned += yearTotal;
    for (const m of evenSplit(yearTotal, 12)) out.push(m);
  }
  return out;
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
