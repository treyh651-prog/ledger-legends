/**
 * Shared depreciation arithmetic for PER-POST-DEPRECIATION and PER-DISPOSE-ASSET.
 *
 * Both runs need the identical month by month schedule a method produces and
 * the identical reading of how much of an asset's base is already written
 * off, for the same reason rec-shared.ts keeps one tier table rather than
 * three: two runs computing a depreciation schedule their own way is two
 * schedules that drift, and a disposal computed against a different number
 * than the one PER-POST-DEPRECIATION already posted would put the balance
 * sheet out by the difference.
 */

import type { Cents } from "../contract";
import type { DepreciationScheduleRow, FixedAssetRow } from "../tables";
import { addMonths, halve, monthKey, startOfMonth } from "./per-shared";

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
export const MACRS_PPM: Record<number, readonly number[]> = {
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

export interface PlanMonth {
  period: string;
  periodNumber: number;
  amountCents: Cents;
}

export interface PlanFailure {
  code: string;
  message: string;
}

/** Depreciation already posted for an asset. Skipped and superseded rows carry no weight. */
export function accumulated(rows: readonly DepreciationScheduleRow[]): Cents {
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
export function monthlyPlan(
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

/** Spread a total over n periods. Local copy of per-shared's evenSplit kept in step with it. */
function evenSplit(total: Cents, periods: number): Cents[] {
  if (periods <= 0) return [];
  const negative = total < BigInt(0);
  const magnitude = negative ? -total : total;
  const n = BigInt(periods);
  const base = magnitude / n;
  const out: Cents[] = [];
  for (let i = 0; i < periods - 1; i += 1) out.push(base);
  out.push(magnitude - base * BigInt(periods - 1));
  return negative ? out.map((v) => -v) : out;
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
