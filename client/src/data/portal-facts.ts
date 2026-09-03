import {
  agingByParty,
  balanceSheet,
  budgetVsActual,
  cashForecast,
  monthlyNarrative,
  netBalances,
  openBills,
  openInvoices,
  priorPeriod,
  profitAndLoss,
  type ForecastWeek,
} from "./derive";
import { closedPeriods, openPeriod } from "./entitlement";
import { ACCOUNTS } from "./coa";
import type { Dataset } from "./seed";
import { TODAY } from "./seed";
import { daysBetween } from "@/lib/money";

/**
 * Every locked state in the portal is built from one of these. The rule is that a
 * client always sees a true number computed from their own posted records, and only
 * the detail behind it waits on the service level. Nothing here invents a value, and
 * when there is no data yet the fact says so instead of dressing up a zero.
 */

export interface FactStat {
  label: string;
  cents?: number;
  count?: number;
  text?: string;
  /** True only for a change or a difference, so a plus sign means something. */
  signed?: boolean;
  tone?: "neutral" | "good" | "watch" | "risk";
}

export interface TruthfulFact {
  /** The one number worth reading first. Always computed, never illustrative. */
  headline: FactStat;
  supporting: FactStat[];
  /** Plain description of what is behind the lock. */
  lockedDetail: string;
  /** How the headline was computed, so the number can be checked. */
  basis: string;
  hasData: boolean;
  /** Used in place of the headline when there is nothing posted yet. */
  emptyNote?: string;
}

function cashOf(nets: Record<string, number>): number {
  return ACCOUNTS.filter((a) => a.cashLike).reduce((s, a) => s + (nets[a.id] || 0), 0);
}

function hasAnyPosting(ds: Dataset, clientId: string): boolean {
  return ds.txns.some((t) => t.clientId === clientId) || ds.journalEntries.some((j) => j.clientId === clientId);
}

/* ---------------- Ledger+ facts ---------------- */

/** Month over month. True fact is the revenue and net income move against the prior closed month. */
export function compareFact(ds: Dataset, clientId: string, period: string): TruthfulFact {
  const prior = priorPeriod(period);
  const closed = closedPeriods(ds, clientId);
  const priorClosed = prior && closed.includes(prior) ? prior : null;
  if (!priorClosed || !hasAnyPosting(ds, clientId)) {
    return {
      headline: { label: "Months available to compare", count: closed.length },
      supporting: [],
      lockedDetail: "Line by line movement between two months.",
      basis: "Counted from your closed periods.",
      hasData: false,
      emptyNote:
        closed.length < 2
          ? "A comparison needs two closed months. You have " + closed.length + " so far, so there is nothing to compare yet."
          : "The month before this one is not closed yet.",
    };
  }
  const pl = profitAndLoss(ds, clientId, period, priorClosed);
  const revenueDelta = pl.revenue - pl.priorRevenue;
  const netDelta = pl.netIncome - pl.priorNetIncome;
  let moved = 0;
  for (const section of pl.sections) {
    for (const row of section.rows) {
      const diff = Math.abs(row.amount - row.prior);
      if (diff >= 2500) moved += 1;
    }
  }
  return {
    headline: {
      label: "Revenue change versus " + priorClosed,
      cents: revenueDelta,
      signed: true,
      tone: revenueDelta >= 0 ? "good" : "watch",
    },
    supporting: [
      { label: "Net income change", cents: netDelta, signed: true, tone: netDelta >= 0 ? "good" : "watch" },
      { label: "Accounts that moved by 25 dollars or more", count: moved },
    ],
    lockedDetail: "The account by account comparison showing which lines drove the change.",
    basis: "Both months come from your own posted entries. The change is this period minus " + priorClosed + ".",
    hasData: true,
  };
}

/** Budget versus actual. True fact is how many accounts are off plan and by how much. */
export function budgetFact(ds: Dataset, clientId: string, period: string): TruthfulFact {
  const hasBudget = ds.budgets.some((b) => b.clientId === clientId && b.period === period);
  if (!hasBudget) {
    return {
      headline: { label: "Budget lines on file for " + period, count: 0 },
      supporting: [],
      lockedDetail: "Account level variance against plan.",
      basis: "Counted from the budget loaded for this period.",
      hasData: false,
      emptyNote: "No budget is loaded for this period, so there is no variance to show. Send us a plan and this fills in.",
    };
  }
  const bva = budgetVsActual(ds, clientId, period);
  const off = bva.rows.filter((r) => !r.favorable && r.variance !== 0);
  const worst = off.slice().sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))[0];
  const unfavorable = off.reduce((s, r) => s + Math.abs(r.variance), 0);
  return {
    headline: { label: "Accounts running over plan in " + period, count: off.length, tone: off.length > 0 ? "watch" : "good" },
    supporting: [
      { label: "Total amount over plan", cents: unfavorable, tone: unfavorable > 0 ? "watch" : "good" },
      worst
        ? { label: "Largest single gap", text: worst.account.code + " " + worst.account.name, tone: "watch" }
        : { label: "Largest single gap", text: "Every account is inside plan" },
    ],
    lockedDetail: "The full variance table with every account, the plan amount, and the percent off.",
    basis: "Actuals are your posted amounts for " + period + ". Plan amounts come from the budget on file.",
    hasData: true,
  };
}

/** AR and AP aging. True fact is the overdue count and the overdue balance. */
export function agingFact(ds: Dataset, clientId: string): TruthfulFact {
  const invoices = openInvoices(ds, clientId);
  const bills = openBills(ds, clientId);
  if (invoices.length === 0 && bills.length === 0) {
    return {
      headline: { label: "Open invoices and bills", count: 0 },
      supporting: [],
      lockedDetail: "The aging table by customer and by vendor.",
      basis: "Counted from your open receivable and payable records.",
      hasData: false,
      emptyNote: "Nothing is outstanding right now, so there is no aging to read. This fills in as invoices and bills post.",
    };
  }
  const overdue = invoices.filter((i) => i.dueDate < TODAY);
  const overdueCents = overdue.reduce((s, i) => s + (i.amountCents - i.paidCents), 0);
  const oldest = overdue.slice().sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0];
  const oldestDays = oldest ? daysBetween(oldest.dueDate, TODAY) : 0;
  const owedOut = bills.filter((b) => b.dueDate < TODAY).reduce((s, b) => s + (b.amountCents - b.paidCents), 0);
  return {
    headline: {
      label: "Invoices past due today",
      count: overdue.length,
      tone: overdue.length > 0 ? "risk" : "good",
    },
    supporting: [
      { label: "Past due receivable balance", cents: overdueCents, tone: overdueCents > 0 ? "risk" : "good" },
      { label: "Oldest invoice, days past due", count: oldestDays, tone: oldestDays > 30 ? "risk" : "watch" },
      { label: "Bills past due", cents: owedOut, tone: owedOut > 0 ? "watch" : "good" },
    ],
    lockedDetail: "The bucketed aging by customer and vendor, current through ninety days and over.",
    basis: "Counted from your open invoices and bills with a due date before " + TODAY + ".",
    hasData: true,
  };
}

/** Open period access. True fact is what has already posted in the month in progress. */
export function openPeriodFact(ds: Dataset, clientId: string): TruthfulFact {
  const open = openPeriod(ds, clientId);
  if (!open) {
    return {
      headline: { label: "Open period", text: "Every period is closed" },
      supporting: [],
      lockedDetail: "Draft numbers for the month in progress.",
      basis: "Read from your close records.",
      hasData: false,
      emptyNote: "There is no month in progress right now, so there are no draft numbers to release early.",
    };
  }
  const rows = ds.txns.filter((t) => t.clientId === clientId && t.period === open);
  if (rows.length === 0) {
    return {
      headline: { label: "Transactions posted in " + open, count: 0 },
      supporting: [],
      lockedDetail: "Draft profit and loss and cash position for the month in progress.",
      basis: "Counted from your posted transactions in " + open + ".",
      hasData: false,
      emptyNote: "Nothing has posted in " + open + " yet, so there is no early view to give you.",
    };
  }
  const inflow = rows.filter((t) => t.baseAmountCents > 0).reduce((s, t) => s + t.baseAmountCents, 0);
  const outflow = rows.filter((t) => t.baseAmountCents < 0).reduce((s, t) => s + Math.abs(t.baseAmountCents), 0);
  const uncategorized = rows.filter((t) => !t.categoryAccountId || t.status === "needs_review").length;
  return {
    headline: { label: "Transactions already posted in " + open, count: rows.length },
    supporting: [
      { label: "Money in so far", cents: inflow, tone: "good" },
      { label: "Money out so far", cents: outflow, tone: "watch" },
      { label: "Still waiting on a category or a receipt", count: uncategorized, tone: uncategorized > 0 ? "watch" : "good" },
    ],
    lockedDetail: "The draft profit and loss, balance sheet, and cash position for " + open + " before it closes.",
    basis: "Counted from your own transactions dated inside " + open + ".",
    hasData: true,
  };
}

/* ---------------- Legend facts ---------------- */

/** Thirteen week forecast. True fact is the ending cash and the tightest week. */
export function forecastFact(ds: Dataset, clientId: string): TruthfulFact {
  if (!hasAnyPosting(ds, clientId)) {
    return {
      headline: { label: "Weeks of history available to project", count: 0 },
      supporting: [],
      lockedDetail: "The thirteen week cash forecast with the schedule behind each week.",
      basis: "A forecast reads from your posted cash activity.",
      hasData: false,
      emptyNote: "There is no posted cash activity yet, so a forecast would be a guess. This turns on once transactions land.",
    };
  }
  const weeks = cashForecast(ds, clientId, 13);
  const nets = netBalances(ds, clientId, { through: openPeriod(ds, clientId) || closedPeriods(ds, clientId)[0] });
  const startCash = cashOf(nets);
  const ending = weeks[weeks.length - 1];
  const low = weeks.slice().sort((a, b) => a.endingCash - b.endingCash)[0];
  const negativeWeeks = weeks.filter((w) => w.net < 0).length;
  return {
    headline: {
      label: "Projected cash in thirteen weeks",
      cents: ending ? ending.endingCash : startCash,
      tone: ending && ending.endingCash >= startCash ? "good" : "watch",
    },
    supporting: [
      { label: "Cash on hand today", cents: startCash },
      { label: "Tightest week ending balance", cents: low ? low.endingCash : startCash, tone: low && low.endingCash < startCash ? "watch" : "good" },
      { label: "Weeks that spend more than they collect", count: negativeWeeks, tone: negativeWeeks > 6 ? "watch" : "neutral" },
    ],
    lockedDetail: "The week by week table with inflow, outflow, ending balance, and the invoices and bills scheduled in each week.",
    basis: "Built from your cash accounts today plus your open invoices and bills by due date, with the run rate from your last three months.",
    hasData: true,
  };
}

/** Period narrative. True fact is that the write up exists and what it covers. */
export function narrativeFact(ds: Dataset, clientId: string, period: string): TruthfulFact {
  if (!hasAnyPosting(ds, clientId)) {
    return {
      headline: { label: "Notes written for " + period, count: 0 },
      supporting: [],
      lockedDetail: "The written read on the month.",
      basis: "The narrative is written from your closed numbers.",
      hasData: false,
      emptyNote: "There is nothing posted for " + period + " yet, so there is no month to write about.",
    };
  }
  const points = monthlyNarrative(ds, clientId, period);
  const flagged = points.filter((p) => p.tone === "watch" || p.tone === "risk").length;
  return {
    headline: { label: "Notes written about " + period, count: points.length },
    supporting: [
      { label: "Notes that flag something to watch", count: flagged, tone: flagged > 0 ? "watch" : "good" },
      { label: "First note", text: points[0] ? points[0].heading : "None yet" },
    ],
    lockedDetail: "The full write up, each note in plain language with the numbers behind it.",
    basis: "Written from your closed " + period + " statements by the person who closed the month.",
    hasData: true,
  };
}

/* ---------------- Scenarios ---------------- */

export interface ScenarioDef {
  id: string;
  name: string;
  assumption: string;
}

export const SCENARIOS: ScenarioDef[] = [
  { id: "base", name: "As it stands", assumption: "Your open invoices and bills land on the due dates already recorded." },
  { id: "slow", name: "Collections run two weeks late", assumption: "Every expected collection arrives two weeks after the recorded due date. Nothing else changes." },
  { id: "spend", name: "Spending runs five percent higher", assumption: "Cash out is five percent above the run rate in each week. Collections are unchanged." },
];

export interface ScenarioResult {
  def: ScenarioDef;
  weeks: ForecastWeek[];
  endingCash: number;
  lowestCash: number;
  lowestWeekLabel: string;
  negativeWeeks: number;
  deltaFromBase: number;
}

/** Scenarios are the real base forecast with one stated assumption applied. Integer cents only. */
export function scenarioResults(ds: Dataset, clientId: string): ScenarioResult[] {
  const base = cashForecast(ds, clientId, 13);
  const nets = netBalances(ds, clientId, { through: openPeriod(ds, clientId) || closedPeriods(ds, clientId)[0] });
  const startCash = cashOf(nets);

  function rebuild(def: ScenarioDef, inflowOf: (w: ForecastWeek, i: number) => number, outflowOf: (w: ForecastWeek, i: number) => number): ScenarioResult {
    let cash = startCash;
    const weeks: ForecastWeek[] = base.map((w, i) => {
      const inflow = inflowOf(w, i);
      const outflow = outflowOf(w, i);
      cash = cash + inflow - outflow;
      return { ...w, inflow, outflow, net: inflow - outflow, endingCash: cash };
    });
    const low = weeks.slice().sort((a, b) => a.endingCash - b.endingCash)[0];
    const ending = weeks.length > 0 ? weeks[weeks.length - 1].endingCash : startCash;
    return {
      def,
      weeks,
      endingCash: ending,
      lowestCash: low ? low.endingCash : startCash,
      lowestWeekLabel: low ? low.label : "None",
      negativeWeeks: weeks.filter((w) => w.net < 0).length,
      deltaFromBase: 0,
    };
  }

  const results: ScenarioResult[] = [
    rebuild(SCENARIOS[0], (w) => w.inflow, (w) => w.outflow),
    rebuild(
      SCENARIOS[1],
      (_w, i) => (i >= 2 ? base[i - 2].inflow : 0),
      (w) => w.outflow,
    ),
    rebuild(SCENARIOS[2], (w) => w.inflow, (w) => Math.round((w.outflow * 105) / 100)),
  ];
  const baseEnding = results[0].endingCash;
  return results.map((r) => ({ ...r, deltaFromBase: r.endingCash - baseEnding }));
}

/** Scenario teaser. True fact is the base ending cash and the spread across scenarios. */
export function scenarioFact(ds: Dataset, clientId: string): TruthfulFact {
  if (!hasAnyPosting(ds, clientId)) {
    return {
      headline: { label: "Scenarios ready to run", count: 0 },
      supporting: [],
      lockedDetail: "The same forecast under slower collections or higher spend.",
      basis: "A scenario is the base forecast with one assumption changed.",
      hasData: false,
      emptyNote: "There is no cash history to project yet, so there is no base case to compare against.",
    };
  }
  const results = scenarioResults(ds, clientId);
  const base = results[0];
  const worst = results.slice().sort((a, b) => a.endingCash - b.endingCash)[0];
  return {
    headline: { label: "Base case cash in thirteen weeks", cents: base.endingCash },
    supporting: [
      { label: "Scenarios prepared from your data", count: results.length },
      { label: "Worst case ending cash", cents: worst.endingCash, tone: worst.endingCash < base.endingCash ? "watch" : "neutral" },
      { label: "Gap between best and worst", cents: Math.abs(base.endingCash - worst.endingCash), tone: "watch" },
    ],
    lockedDetail: "Each scenario week by week, side by side, with the assumption written on it.",
    basis: "Every scenario starts from your real forecast and changes one stated assumption. No amounts are invented.",
    hasData: true,
  };
}

/* ---------------- Consolidation ---------------- */

export interface EntityLine {
  clientId: string;
  name: string;
  revenue: number;
  netIncome: number;
  cash: number;
  totalAssets: number;
  totalLiabilities: number;
  equity: number;
  closed: boolean;
}

export interface ConsolidatedView {
  period: string;
  entities: EntityLine[];
  combined: Omit<EntityLine, "clientId" | "name" | "closed">;
  relatedPartyNote: string | null;
}

/** Combines the entities in a group for one period. Sums only, and it says so. */
export function consolidatedView(ds: Dataset, clientIds: string[], period: string): ConsolidatedView {
  const entities: EntityLine[] = clientIds.map((id) => {
    const client = ds.clients.find((c) => c.id === id);
    const pl = profitAndLoss(ds, id, period, null);
    const bs = balanceSheet(ds, id, period);
    const nets = netBalances(ds, id, { through: period });
    const close = ds.closes.find((c) => c.clientId === id && c.period === period);
    return {
      clientId: id,
      name: client ? client.dba : id,
      revenue: pl.revenue,
      netIncome: pl.netIncome,
      cash: cashOf(nets),
      totalAssets: bs.totalAssets,
      totalLiabilities: bs.totalLiabilities,
      equity: bs.totalEquity,
      closed: close ? close.state === "closed" : false,
    };
  });
  const combined = {
    revenue: entities.reduce((s, e) => s + e.revenue, 0),
    netIncome: entities.reduce((s, e) => s + e.netIncome, 0),
    cash: entities.reduce((s, e) => s + e.cash, 0),
    totalAssets: entities.reduce((s, e) => s + e.totalAssets, 0),
    totalLiabilities: entities.reduce((s, e) => s + e.totalLiabilities, 0),
    equity: entities.reduce((s, e) => s + e.equity, 0),
  };
  // Trade between the entities in a group is disclosed rather than netted, because no
  // intercompany accounts are set up in this chart. Say it plainly instead of implying eliminations.
  const names = ds.clients.filter((c) => clientIds.includes(c.id)).map((c) => c.legalName.split(" ")[0]);
  const crossTrade = ds.txns.filter(
    (t) => clientIds.includes(t.clientId) && t.vendor && names.some((n) => (t.vendor || "").toLowerCase().includes(n.toLowerCase())),
  );
  const relatedPartyNote =
    crossTrade.length > 0
      ? crossTrade.length +
        " transactions between the entities in this group are still counted on both sides. No intercompany eliminations are recorded, so read the combined column as a sum."
      : null;
  return { period, entities, combined, relatedPartyNote };
}

/** Consolidation teaser. True fact is how many entities are in the group and their combined cash. */
export function consolidationFact(ds: Dataset, clientId: string, memberIds: string[], period: string): TruthfulFact {
  const others = memberIds.filter((id) => id !== clientId);
  if (memberIds.length === 0 || !hasAnyPosting(ds, clientId)) {
    return {
      headline: { label: "Entities in your group", count: memberIds.length },
      supporting: [],
      lockedDetail: "Combined statements across the group.",
      basis: "Read from the entity group on your engagement.",
      hasData: false,
      emptyNote: "There is nothing posted to combine yet.",
    };
  }
  if (others.length === 0) {
    return {
      headline: { label: "Entities in your group", count: 1 },
      supporting: [{ label: "Your books already cover the whole group", text: ds.clients.find((c) => c.id === clientId)?.dba || clientId }],
      lockedDetail: "Combined statements, which start to matter at two entities or more.",
      basis: "Your engagement lists one entity, so a consolidation would repeat the statements you already have.",
      hasData: false,
      emptyNote: "You have one entity, so there is nothing to consolidate. Tell us when a second entity opens and this turns on.",
    };
  }
  const view = consolidatedView(ds, memberIds, period);
  return {
    headline: { label: "Entities on your engagement", count: memberIds.length },
    supporting: [
      { label: "Combined cash across the group", cents: view.combined.cash },
      { label: "Combined revenue in " + period, cents: view.combined.revenue },
      { label: "Other entity", text: view.entities.filter((e) => e.clientId !== clientId).map((e) => e.name).join(", ") },
    ],
    lockedDetail: "The combined profit and loss and balance sheet with a column for each entity.",
    basis: "Each entity total comes from its own posted books for " + period + ". The combined column is the sum.",
    hasData: true,
  };
}
