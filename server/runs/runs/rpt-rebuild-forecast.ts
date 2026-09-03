/**
 * RPT-REBUILD-FORECAST. Rebuild the thirteen week cash forecast.
 *
 * Spec: docs/02-run-specifications.md Module 8 RPT-REBUILD-FORECAST.
 *
 * Five sources, and nothing else: open receivables weighted by a stated
 * collection curve, open payables paid on the day they are actually going to be
 * paid, recurring templates stepped by their cadence, the loan schedule, and
 * approved payroll. Every week row carries the source documents that produced
 * it, so no figure in the forecast exists without a document id behind it.
 *
 * CONSTRAINT, and this one matters. There is no model here. The collection curve
 * is a stated table of basis points by aging bucket, written down in this file
 * where anybody can read it and argue with it. It is not fitted, not learned,
 * and not adjusted by anything the software observed. A fitted curve would be a
 * learned parameter, which is exactly what the no artificial intelligence
 * constraint rules out, and it would also make two rebuilds over the same ledger
 * disagree. See NOTES.md entry 109.
 *
 * The forecast foots by construction. Each week closes at opening plus inflow
 * minus outflow, the next week opens where the last one closed, and the schema
 * checks both. A forecast whose weeks do not add up is not a forecast.
 *
 * Scenarios are parameters on the header, never hidden constants. A reader of a
 * header can always state the shift in days and the multiplier in basis points
 * that produced the weeks under it, per doc 02 rule 4.
 *
 * The run reads the ledger and writes only report rows, so it is safe on a
 * locked period. The ledger fingerprint is in the scope hash, so a rebuild after
 * a posting is a new scope.
 *
 * SENDS. None.
 *
 * COMPLIANCE. A forecast is a projection of documents already recorded under
 * stated rules. It is not advice, not an opinion, and not a promise.
 */

import { z } from "zod";
import {
  isFieldWrite,
  makeResult,
  type Cents,
  type FrozenScope,
  type Proposal,
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
import { addDays, dayGap } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { CashForecastWeekRow, ForecastItem } from "../tables";
import {
  addMonths,
  cadenceDueIn,
  periodWindow,
  postingDayFor,
  startOfMonth,
} from "./per-shared";
import { ZERO } from "./close-shared";
import {
  BP_SCALE,
  HORIZON_WEEKS,
  absCents,
  billOpenCents,
  billPaymentDay,
  cashBalanceOf,
  centsStr,
  changedFieldsOf,
  invoiceOpenCents,
  loadReportData,
  reportingDiscriminator,
  weekOf,
  weekWindows,
  type ReportData,
  type WeekWindow,
} from "./rpt-shared";

export const rebuildForecastScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  scenario: z
    .enum(["base", "slow_collections", "revenue_shortfall"])
    .default("base"),
});

export type RebuildForecastScope = z.infer<typeof rebuildForecastScopeSchema>;

/**
 * The collection curve, written down.
 *
 * One row per aging bucket. Each row says what share of an open receivable is
 * expected in the week its expected day lands in, the week after, and the week
 * after that, in basis points. The rows do not have to sum to ten thousand: an
 * invoice ninety days past due is mostly not going to be collected inside
 * thirteen weeks, and pretending otherwise would put money in the forecast that
 * is not coming. The shortfall is deliberate and is reported as the difference
 * between the open balance and what the curve placed.
 *
 * These numbers are a stated policy. They are not fitted to anything.
 */
interface CurveRow {
  bucket: string;
  /** Days past due, inclusive lower bound. */
  fromDaysLate: number;
  /** Basis points landing in the expected week and the two weeks after. */
  weights: readonly [number, number, number];
}

export const COLLECTION_CURVE: readonly CurveRow[] = [
  { bucket: "current", fromDaysLate: -100000, weights: [8000, 1500, 500] },
  { bucket: "1_30", fromDaysLate: 1, weights: [6000, 2500, 1500] },
  { bucket: "31_60", fromDaysLate: 31, weights: [4000, 3000, 2000] },
  { bucket: "61_90", fromDaysLate: 61, weights: [2500, 2000, 1500] },
  { bucket: "over_90", fromDaysLate: 91, weights: [1000, 1000, 500] },
];

/** The scenario parameters. Stated on the header, never hidden in the code. */
const SLOW_SHIFT_DAYS = 30;
const SHORTFALL_BP = 8000;

/** The comparable content of the forecast header. */
interface ForecastHeaderContent {
  startDate: string;
  endDate: string;
  horizonWeeks: number;
  scenario: "base" | "slow_collections" | "revenue_shortfall";
  slowShiftDays: number;
  shortfallBp: number;
  useHistory: boolean;
  openingCashCents: Cents;
  totalInflowCents: Cents;
  totalOutflowCents: Cents;
  closingCashCents: Cents;
  firstShortfallWeek: number | null;
  shortfallWeekCount: number;
  itemCount: number;
  ledgerFingerprint: string;
}

/** The comparable content of one week row. */
interface WeekContent {
  weekNumber: number;
  weekStart: string;
  weekEnd: string;
  openingCents: Cents;
  arInflowCents: Cents;
  otherInflowCents: Cents;
  apOutflowCents: Cents;
  recurringOutflowCents: Cents;
  loanOutflowCents: Cents;
  payrollOutflowCents: Cents;
  inflowCents: Cents;
  outflowCents: Cents;
  closingCents: Cents;
  shortfall: boolean;
  items: ForecastItem[];
}

/** Everything one rebuild computed, before any of it is written. */
interface ForecastPlan {
  header: ForecastHeaderContent;
  weeks: WeekContent[];
  skips: Skip[];
}

export const rptRebuildForecast: Run<RebuildForecastScope, Proposal> = {
  type: "RPT-REBUILD-FORECAST",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:cash-forecast:${scope.period.slice(0, 7)}`,
  scopeSchema: rebuildForecastScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<RebuildForecastScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadReportData(tx, ctx.firmId, scope.clientId, scope.period);
    // The candidates are the source documents, because that is what the forecast
    // is made of and what a reader would want counted.
    const candidateIds = [
      ...data.invoices.map((i) => i.id),
      ...data.bills.map((b) => b.id),
      ...data.close.loanSchedule.map((l) => l.id),
      ...data.payroll.map((p) => p.id),
      ...data.recurringTemplates.map((t) => t.id),
    ].sort();
    const versions = [
      { id: "RPT-REBUILD-FORECAST", version: 1 },
      ...data.invoices.map((i) => ({ id: i.id, version: i.version })),
      ...data.bills.map((b) => ({ id: b.id, version: b.version })),
      ...data.close.loanSchedule.map((l) => ({ id: l.id, version: l.version })),
      ...data.payroll.map((p) => ({ id: p.id, version: p.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      /**
       * The period anchors the forecast start date, so it has to be in the hash
       * or two periods would share one forecast. The fingerprint is in the hash
       * because opening cash comes out of the ledger, so a posting changes the
       * answer even when no document changed.
       */
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds: [
          ...candidateIds,
          reportingDiscriminator(
            window.periodStart,
            data.fingerprint,
            `RPT-REBUILD-FORECAST:${scope.scenario}`,
          ),
        ],
        versions,
      }),
      versions,
      overriddenIds: data.forecasts
        .filter((f) => f.manualOverride)
        .map((f) => f.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const data = await loadReportData(
      tx,
      frozen.firmId,
      frozen.clientId,
      frozen.input.period,
    );
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const scenario = frozen.input.scenario;
    const headerId = forecastIdOf(data.periodStart, scenario);
    const priorHeader = data.forecasts.find((f) => f.id === headerId);

    // Invariant 8. A forecast a person took over is left alone, and so are its
    // weeks, because a header and its weeks are one document.
    if (priorHeader !== undefined && priorHeader.manualOverride) {
      skips.push({
        rowId: headerId,
        reason: "manual_override",
        detail: `cash forecast for ${data.periodStart} carries manual_override`,
      });
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        proposals,
        skips,
        errors,
        ZERO,
      );
    }

    const plan = buildForecast(data, scenario);
    skips.push(...plan.skips);

    const weekRows = await tx.query("cash_forecast_weeks_for_run", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      forecastRunId: headerId,
    });
    const priorWeekById = new Map<string, CashForecastWeekRow>(
      weekRows.map((r) => [r.id, r]),
    );

    if (priorHeader === undefined) {
      proposals.push(insertHeader(frozen, data, headerId, plan.header));
    } else {
      const changed = changedFieldsOf(
        priorHeader as unknown as Record<string, unknown>,
        plan.header as unknown as Record<string, unknown>,
      );
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId: headerId,
          reason: "already_applied",
          detail: `forecast_unchanged for ${data.periodStart} scenario ${scenario}`,
        });
      } else {
        proposals.push({
          kind: "field_write",
          table: "cash_forecast_runs",
          rowId: headerId,
          before: changed.before,
          after: changed.after,
          provenance: { cascadeLevel: null },
        });
      }
    }

    for (const week of plan.weeks) {
      const rowId = weekIdOf(headerId, week.weekNumber);
      const prior = priorWeekById.get(rowId);
      if (prior === undefined) {
        proposals.push(insertWeek(frozen, headerId, rowId, week));
        continue;
      }
      if (prior.manualOverride) {
        skips.push({
          rowId,
          reason: "manual_override",
          detail: `forecast week ${week.weekNumber} carries manual_override`,
        });
        continue;
      }
      const changed = changedFieldsOf(
        prior as unknown as Record<string, unknown>,
        week as unknown as Record<string, unknown>,
      );
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `forecast_week_unchanged ${week.weekNumber} for ${data.periodStart}`,
        });
        continue;
      }
      proposals.push({
        kind: "field_write",
        table: "cash_forecast_weeks",
        rowId,
        before: changed.before,
        after: changed.after,
        provenance: { cascadeLevel: null },
      });
    }

    return makeResult<Proposal>(
      frozen.candidateIds.length,
      proposals,
      skips,
      errors,
      ZERO,
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "RPT-REBUILD-FORECAST",
      runVersion: 1,
    });
  },

  /** Written weeks stand, field writes revert. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function forecastIdOf(periodStart: string, scenario: string): Ulid {
  return derivedId(`${periodStart}:${scenario}`, "rpt-rebuild-forecast", 0);
}

export function weekIdOf(forecastRunId: Ulid, weekNumber: number): Ulid {
  return derivedId(
    `${forecastRunId}:${String(weekNumber).padStart(2, "0")}`,
    "rpt-rebuild-forecast-week",
    0,
  );
}

/**
 * The forecast start date. The day after the period end.
 *
 * A forecast that starts inside the period it reports on would double count the
 * cash that already moved, and one that starts on the day the run happened to
 * execute would give two different answers on two different days for the same
 * closed period. See NOTES.md entry 107.
 */
export function forecastStartOf(periodEnd: string): string {
  return addDays(periodEnd, 1);
}

/**
 * The whole forecast, computed before anything is written.
 *
 * Inflows and outflows are collected into week buckets first, then the running
 * balance is walked forward once. Doing it in that order is what makes the
 * closing figures foot: no week can be closed before every item that lands in it
 * has been placed.
 */
export function buildForecast(
  data: ReportData,
  scenario: RebuildForecastScope["scenario"],
): ForecastPlan {
  const skips: Skip[] = [];
  const startDate = forecastStartOf(data.periodEnd);
  const windows = weekWindows(startDate);
  const endDate = windows[windows.length - 1].weekEnd;

  const arInflow = new Map<number, Cents>();
  const apOutflow = new Map<number, Cents>();
  const recurringOutflow = new Map<number, Cents>();
  const loanOutflow = new Map<number, Cents>();
  const payrollOutflow = new Map<number, Cents>();
  const items = new Map<number, ForecastItem[]>();
  for (const w of windows) {
    arInflow.set(w.weekNumber, ZERO);
    apOutflow.set(w.weekNumber, ZERO);
    recurringOutflow.set(w.weekNumber, ZERO);
    loanOutflow.set(w.weekNumber, ZERO);
    payrollOutflow.set(w.weekNumber, ZERO);
    items.set(w.weekNumber, []);
  }

  const add = (
    bucket: Map<number, Cents>,
    weekNumber: number,
    amount: Cents,
  ): void => {
    bucket.set(weekNumber, (bucket.get(weekNumber) ?? ZERO) + amount);
  };
  const record = (weekNumber: number, item: ForecastItem): void => {
    (items.get(weekNumber) ?? []).push(item);
  };

  placeReceivables(data, scenario, windows, startDate, skips, add, record, arInflow);
  placePayables(data, windows, startDate, skips, add, record, apOutflow);
  placeRecurring(data, windows, startDate, endDate, skips, add, record, recurringOutflow);
  placeLoans(data, windows, skips, add, record, loanOutflow);
  placePayroll(data, windows, skips, add, record, payrollOutflow);

  // Opening cash is the cash block through the day before the forecast starts,
  // which is the period end because the forecast starts the day after it.
  let running = cashBalanceOf(data, data.close.through);
  const openingCash = running;
  const weeks: WeekContent[] = [];
  let totalInflow = ZERO;
  let totalOutflow = ZERO;
  let firstShortfallWeek: number | null = null;
  let shortfallWeekCount = 0;
  let itemCount = 0;

  for (const w of windows) {
    const ar = arInflow.get(w.weekNumber) ?? ZERO;
    const ap = apOutflow.get(w.weekNumber) ?? ZERO;
    const recurring = recurringOutflow.get(w.weekNumber) ?? ZERO;
    const loan = loanOutflow.get(w.weekNumber) ?? ZERO;
    const payroll = payrollOutflow.get(w.weekNumber) ?? ZERO;
    const inflow = ar;
    const outflow = ap + recurring + loan + payroll;
    const opening = running;
    const closing = opening + inflow - outflow;
    running = closing;
    // Doc 02 rule 3. A week that closes below zero is named. A forecast that
    // shows a shortfall three weeks out and does not say so has failed at the one
    // thing it exists for.
    const shortfall = closing < ZERO;
    if (shortfall) {
      shortfallWeekCount += 1;
      if (firstShortfallWeek === null) firstShortfallWeek = w.weekNumber;
    }
    const weekItems = (items.get(w.weekNumber) ?? []).slice().sort(compareItems);
    itemCount += weekItems.length;
    totalInflow += inflow;
    totalOutflow += outflow;
    weeks.push({
      weekNumber: w.weekNumber,
      weekStart: w.weekStart,
      weekEnd: w.weekEnd,
      openingCents: opening,
      arInflowCents: ar,
      otherInflowCents: ZERO,
      apOutflowCents: ap,
      recurringOutflowCents: recurring,
      loanOutflowCents: loan,
      payrollOutflowCents: payroll,
      inflowCents: inflow,
      outflowCents: outflow,
      closingCents: closing,
      shortfall,
      items: weekItems,
    });
  }

  return {
    header: {
      startDate,
      endDate,
      horizonWeeks: HORIZON_WEEKS,
      scenario,
      slowShiftDays: scenario === "slow_collections" ? SLOW_SHIFT_DAYS : 0,
      shortfallBp: scenario === "revenue_shortfall" ? SHORTFALL_BP : BP_SCALE_NUMBER,
      // Stated once and stated false. The curve above is a policy table, not a
      // parameter fitted to this client's history.
      useHistory: false,
      openingCashCents: openingCash,
      totalInflowCents: totalInflow,
      totalOutflowCents: totalOutflow,
      closingCashCents: running,
      firstShortfallWeek,
      shortfallWeekCount,
      itemCount,
      ledgerFingerprint: data.fingerprint,
    },
    weeks,
    skips,
  };
}

/** Ten thousand basis points, meaning no adjustment at all. */
const BP_SCALE_NUMBER = Number(BP_SCALE);

type AddFn = (bucket: Map<number, Cents>, weekNumber: number, amount: Cents) => void;
type RecordFn = (weekNumber: number, item: ForecastItem) => void;

/**
 * Open receivables, spread over the horizon by the stated curve.
 *
 * The expected day is the due date. How much of the balance lands there and in
 * the two weeks after depends on how late the invoice already is, which is the
 * curve. An invoice in dispute is not placed at all, because a disputed invoice
 * has no expected collection day and guessing one would put money in the
 * forecast that nobody is arguing is owed yet.
 */
function placeReceivables(
  data: ReportData,
  scenario: RebuildForecastScope["scenario"],
  windows: readonly WeekWindow[],
  startDate: string,
  skips: Skip[],
  add: AddFn,
  record: RecordFn,
  arInflow: Map<number, Cents>,
): void {
  for (const invoice of data.invoices) {
    if (invoice.manualOverride) {
      skips.push({
        rowId: invoice.id,
        reason: "manual_override",
        detail: `invoice ${invoice.invoiceNumber} carries manual_override`,
      });
      continue;
    }
    if (invoice.status !== "posted") {
      skips.push({
        rowId: invoice.id,
        reason: "out_of_scope_engagement",
        detail: `invoice ${invoice.invoiceNumber} is ${invoice.status} and not an open receivable`,
      });
      continue;
    }
    const open = invoiceOpenCents(invoice);
    if (open <= ZERO) {
      skips.push({
        rowId: invoice.id,
        reason: "already_applied",
        detail: `invoice ${invoice.invoiceNumber} has no open balance`,
      });
      continue;
    }
    if (invoice.inDispute) {
      skips.push({
        rowId: invoice.id,
        reason: "ambiguous_candidate",
        detail: `invoice ${invoice.invoiceNumber} is in dispute and has no expected collection day`,
      });
      continue;
    }
    const daysLate = signedDaysLate(invoice.dueDate, startDate);
    const curve = curveFor(daysLate);
    const shifted =
      scenario === "slow_collections"
        ? addDays(invoice.dueDate, SLOW_SHIFT_DAYS)
        : invoice.dueDate;
    const expectedDay = shifted < startDate ? startDate : shifted;
    const anchor = weekOf(windows, expectedDay);
    if (anchor === null) {
      skips.push({
        rowId: invoice.id,
        reason: "out_of_scope_engagement",
        detail: `invoice ${invoice.invoiceNumber} is expected on ${expectedDay}, outside the thirteen week horizon`,
      });
      continue;
    }
    let placed = false;
    for (let offset = 0; offset < curve.weights.length; offset += 1) {
      const weekNumber = anchor.weekNumber + offset;
      if (weekNumber > HORIZON_WEEKS) break;
      const weight = curve.weights[offset];
      const amount = applyBp(open, weight, scenario);
      if (amount === ZERO) continue;
      add(arInflow, weekNumber, amount);
      record(weekNumber, {
        itemId: invoice.id,
        kind: "invoice",
        sourceTable: "invoices",
        dueDate: invoice.dueDate,
        amountCents: centsStr(amount),
        direction: "inflow",
      });
      placed = true;
    }
    if (!placed) {
      skips.push({
        rowId: invoice.id,
        reason: "out_of_scope_engagement",
        detail: `invoice ${invoice.invoiceNumber} in the ${curve.bucket} bucket places nothing inside the horizon`,
      });
    }
  }
}

/**
 * How late a due date is against the forecast start, signed.
 *
 * dayGap is an absolute distance, and a forecast that could not tell an invoice
 * due next week from one due last week would read both off the same curve row.
 */
export function signedDaysLate(dueDate: string, startDate: string): number {
  const gap = dayGap(dueDate, startDate);
  return dueDate < startDate ? gap : -gap;
}

/**
 * The curve row for an invoice that is this many days late.
 *
 * Days late is measured against the forecast start date, so an invoice due after
 * the start is current and one due before it is late by that many days. The rows
 * are scanned from the most overdue down, so the first match is the right one.
 */
export function curveFor(daysLate: number): CurveRow {
  let chosen = COLLECTION_CURVE[0];
  for (const row of COLLECTION_CURVE) {
    if (daysLate >= row.fromDaysLate) chosen = row;
  }
  return chosen;
}

/**
 * A share of an amount in basis points, rounded half away from zero per doc 00
 * Part 5, with the revenue shortfall scenario applied on top.
 *
 * The shortfall scenario multiplies collections, not the invoices, because the
 * invoices are facts and the scenario is a question about how much of them shows
 * up.
 */
function applyBp(
  amount: Cents,
  weightBp: number,
  scenario: RebuildForecastScope["scenario"],
): Cents {
  const effective =
    scenario === "revenue_shortfall"
      ? (BigInt(weightBp) * BigInt(SHORTFALL_BP)) / BP_SCALE
      : BigInt(weightBp);
  const numerator = amount * effective;
  const quotient = numerator / BP_SCALE;
  const remainder = numerator % BP_SCALE;
  return remainder * 2n >= BP_SCALE ? quotient + 1n : quotient;
}

/**
 * Open payables, placed on the day the money actually leaves.
 *
 * The due date, unless a discount closes earlier, in which case the discount day
 * is the answer. A bill on hold has no expected payment day, and a disputed bill
 * has no agreed amount, so neither is placed.
 */
function placePayables(
  data: ReportData,
  windows: readonly WeekWindow[],
  startDate: string,
  skips: Skip[],
  add: AddFn,
  record: RecordFn,
  apOutflow: Map<number, Cents>,
): void {
  for (const bill of data.bills) {
    if (bill.manualOverride) {
      skips.push({
        rowId: bill.id,
        reason: "manual_override",
        detail: `bill ${bill.billNumber} carries manual_override`,
      });
      continue;
    }
    if (bill.status !== "posted") {
      skips.push({
        rowId: bill.id,
        reason: "out_of_scope_engagement",
        detail: `bill ${bill.billNumber} is ${bill.status} and not an open payable`,
      });
      continue;
    }
    const open = billOpenCents(bill);
    if (open <= ZERO) {
      skips.push({
        rowId: bill.id,
        reason: "already_applied",
        detail: `bill ${bill.billNumber} has no open balance`,
      });
      continue;
    }
    if (bill.onHold || bill.inDispute) {
      skips.push({
        rowId: bill.id,
        reason: "ambiguous_candidate",
        detail: `bill ${bill.billNumber} is ${bill.onHold ? "on hold" : "in dispute"} and has no expected payment day`,
      });
      continue;
    }
    // A bill whose payment day already passed is not a bill that never gets
    // paid. It is overdue, and the money leaves in the first week of the
    // horizon, so the day is clamped forward rather than dropped.
    const scheduled = billPaymentDay(bill);
    const payDay = scheduled < startDate ? startDate : scheduled;
    const week = weekOf(windows, payDay);
    if (week === null) {
      skips.push({
        rowId: bill.id,
        reason: "out_of_scope_engagement",
        detail: `bill ${bill.billNumber} pays on ${payDay}, outside the thirteen week horizon`,
      });
      continue;
    }
    add(apOutflow, week.weekNumber, open);
    record(week.weekNumber, {
      itemId: bill.id,
      kind: "bill",
      sourceTable: "bills",
      dueDate: payDay,
      amountCents: centsStr(open),
      direction: "outflow",
    });
  }
}

/**
 * Recurring templates, stepped by cadence across the horizon.
 *
 * Only generated entry templates matter here. A transaction match template does
 * not create cash, it recognises cash that already moved. Weekly and semi
 * monthly cadences post more than once a month and the cadence helper does not
 * model them, so they are reported rather than guessed at, on the same call doc
 * 02 module 4 made.
 */
function placeRecurring(
  data: ReportData,
  windows: readonly WeekWindow[],
  startDate: string,
  endDate: string,
  skips: Skip[],
  add: AddFn,
  record: RecordFn,
  recurringOutflow: Map<number, Cents>,
): void {
  for (const template of data.recurringTemplates) {
    if (template.manualOverride) {
      skips.push({
        rowId: template.id,
        reason: "manual_override",
        detail: `recurring template ${template.name} carries manual_override`,
      });
      continue;
    }
    if (!template.isActive) {
      skips.push({
        rowId: template.id,
        reason: "out_of_scope_engagement",
        detail: `recurring template ${template.name} is not active`,
      });
      continue;
    }
    if (template.cadence === null || template.startDate === null) {
      skips.push({
        rowId: template.id,
        reason: "missing_prerequisite",
        detail: `recurring template ${template.name} has no cadence or no start date`,
      });
      continue;
    }
    if (template.cadence === "weekly" || template.cadence === "semi_monthly") {
      skips.push({
        rowId: template.id,
        reason: "ambiguous_candidate",
        detail: `recurring template ${template.name} has a ${template.cadence} cadence, which this forecast does not model`,
      });
      continue;
    }
    const amount = absCents(
      template.matchAmountCents ?? template.driverAmountCents ?? ZERO,
    );
    if (amount === ZERO) {
      skips.push({
        rowId: template.id,
        reason: "missing_prerequisite",
        detail: `recurring template ${template.name} carries no amount`,
      });
      continue;
    }
    let placed = false;
    // The horizon spans at most four calendar months, so walking month starts
    // from the start month to the end month covers every posting day.
    let monthStart = startOfMonth(startDate);
    const lastMonth = startOfMonth(endDate);
    while (monthStart <= lastMonth) {
      const window = periodWindow(monthStart);
      if (
        cadenceDueIn(template.cadence, template.startDate, monthStart) &&
        (template.endDate === null || template.endDate >= monthStart)
      ) {
        const day = postingDayFor(window, template.postingDateRule, template.dayOfMonth);
        const week = weekOf(windows, day);
        if (week !== null) {
          add(recurringOutflow, week.weekNumber, amount);
          record(week.weekNumber, {
            itemId: template.id,
            kind: "recurring",
            sourceTable: "recurring_templates",
            dueDate: day,
            amountCents: centsStr(amount),
            direction: "outflow",
          });
          placed = true;
        }
      }
      monthStart = addMonths(monthStart, 1);
    }
    if (!placed) {
      skips.push({
        rowId: template.id,
        reason: "out_of_scope_engagement",
        detail: `recurring template ${template.name} has no posting day inside the horizon`,
      });
    }
  }
}

/** Scheduled loan payments. A posted one already moved and is not forecast. */
function placeLoans(
  data: ReportData,
  windows: readonly WeekWindow[],
  skips: Skip[],
  add: AddFn,
  record: RecordFn,
  loanOutflow: Map<number, Cents>,
): void {
  for (const row of data.close.loanSchedule) {
    if (row.manualOverride) {
      skips.push({
        rowId: row.id,
        reason: "manual_override",
        detail: `loan payment ${row.paymentNumber} carries manual_override`,
      });
      continue;
    }
    if (row.status !== "scheduled") {
      skips.push({
        rowId: row.id,
        reason: "out_of_scope_engagement",
        detail: `loan payment ${row.paymentNumber} is ${row.status}`,
      });
      continue;
    }
    const week = weekOf(windows, row.dueDate);
    if (week === null) continue;
    const amount = absCents(row.paymentCents);
    add(loanOutflow, week.weekNumber, amount);
    record(week.weekNumber, {
      itemId: row.id,
      kind: "loan",
      sourceTable: "loan_schedule",
      dueDate: row.dueDate,
      amountCents: centsStr(amount),
      direction: "outflow",
    });
  }
}

/** Approved payroll. A draft payroll is not a commitment and is not forecast. */
function placePayroll(
  data: ReportData,
  windows: readonly WeekWindow[],
  skips: Skip[],
  add: AddFn,
  record: RecordFn,
  payrollOutflow: Map<number, Cents>,
): void {
  for (const row of data.payroll) {
    if (row.manualOverride) {
      skips.push({
        rowId: row.id,
        reason: "manual_override",
        detail: `payroll for ${row.payDate} carries manual_override`,
      });
      continue;
    }
    if (row.status !== "approved") {
      skips.push({
        rowId: row.id,
        reason: "missing_prerequisite",
        detail: `payroll for ${row.payDate} is ${row.status} and not approved`,
      });
      continue;
    }
    const week = weekOf(windows, row.payDate);
    if (week === null) continue;
    add(payrollOutflow, week.weekNumber, row.amountCents);
    record(week.weekNumber, {
      itemId: row.id,
      kind: "payroll",
      sourceTable: "payroll_approvals",
      dueDate: row.payDate,
      amountCents: centsStr(row.amountCents),
      direction: "outflow",
    });
  }
}

/** Doc 00 Part 6. A total ordering, with the row id as the tie breaker. */
function compareItems(a: ForecastItem, b: ForecastItem): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
}

function insertHeader(
  frozen: FrozenScope<RebuildForecastScope>,
  data: ReportData,
  rowId: Ulid,
  content: ForecastHeaderContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "cash_forecast_runs",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      ...content,
      builtByRunId: RUN_ID_PLACEHOLDER,
      builtAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

function insertWeek(
  frozen: FrozenScope<RebuildForecastScope>,
  forecastRunId: Ulid,
  rowId: Ulid,
  content: WeekContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "cash_forecast_weeks",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      forecastRunId,
      ...content,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}
