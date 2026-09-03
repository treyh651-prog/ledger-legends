import { ACCOUNTS, acct, cashFlowClass } from "./coa";
import { CURRENT_PERIOD, PERIODS, TODAY, variances } from "./seed";
import type { Dataset } from "./seed";
import type { Account, Bill, Invoice, JournalEntry, TieStatus, Txn } from "./types";

export function periodEnd(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

export function priorPeriod(period: string): string | null {
  const i = PERIODS.indexOf(period);
  return i > 0 ? PERIODS[i - 1] : null;
}

export function periodsThrough(period: string): string[] {
  const i = PERIODS.indexOf(period);
  return PERIODS.slice(0, i + 1);
}

/** Debit positive net balance per account. */
export function netBalances(
  ds: Dataset,
  clientId: string,
  opts: { period?: string; through?: string; includeOpening?: boolean } = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const je of ds.journalEntries) {
    if (je.clientId !== clientId) continue;
    if (!je.posted) continue;
    if (opts.period && je.period !== opts.period) continue;
    if (opts.through) {
      const isOpening = je.source === "opening";
      if (!isOpening && je.period > opts.through) continue;
      if (opts.includeOpening === false && isOpening) continue;
    }
    if (!opts.through && opts.includeOpening === false && je.source === "opening") continue;
    for (const l of je.lines) {
      out[l.accountId] = (out[l.accountId] || 0) + l.debit - l.credit;
    }
  }
  return out;
}

/** Natural sign presentation: assets and expenses positive on debits, everything else positive on credits. */
export function naturalBalance(account: Account, net: number): number {
  if (account.type === "asset" || account.type === "expense") return net;
  return -net;
}

export interface TrialBalanceRow {
  account: Account;
  debit: number;
  credit: number;
}

export function trialBalance(ds: Dataset, clientId: string, period: string): { rows: TrialBalanceRow[]; totalDebit: number; totalCredit: number } {
  const nets = netBalances(ds, clientId, { through: period });
  const rows: TrialBalanceRow[] = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const a of ACCOUNTS) {
    const net = nets[a.id] || 0;
    if (net === 0) continue;
    const debit = net > 0 ? net : 0;
    const credit = net < 0 ? -net : 0;
    totalDebit += debit;
    totalCredit += credit;
    rows.push({ account: a, debit, credit });
  }
  return { rows, totalDebit, totalCredit };
}

export interface PLSection {
  key: string;
  label: string;
  rows: { account: Account; amount: number; prior: number }[];
  total: number;
  priorTotal: number;
}

export interface PLStatement {
  sections: PLSection[];
  revenue: number;
  costOfSales: number;
  grossProfit: number;
  operatingExpenses: number;
  otherExpenses: number;
  netIncome: number;
  priorRevenue: number;
  priorGrossProfit: number;
  priorNetIncome: number;
  priorOperatingExpenses: number;
  priorCostOfSales: number;
}

function plSectionsFor(nets: Record<string, number>, priorNets: Record<string, number>): PLSection[] {
  const groups: { key: string; label: string; test: (a: Account) => boolean }[] = [
    { key: "revenue", label: "Revenue", test: (a) => a.type === "revenue" },
    { key: "cos", label: "Cost of sales", test: (a) => a.subtype === "Cost of sales" },
    { key: "opex", label: "Operating expenses", test: (a) => a.type === "expense" && a.subtype === "Operating expenses" },
    { key: "other", label: "Other expense", test: (a) => a.subtype === "Other expense" },
  ];
  return groups.map((g) => {
    const rows = ACCOUNTS.filter(g.test)
      .map((a) => ({
        account: a,
        amount: naturalBalance(a, nets[a.id] || 0),
        prior: naturalBalance(a, priorNets[a.id] || 0),
      }))
      .filter((r) => r.amount !== 0 || r.prior !== 0);
    return {
      key: g.key,
      label: g.label,
      rows,
      total: rows.reduce((s, r) => s + r.amount, 0),
      priorTotal: rows.reduce((s, r) => s + r.prior, 0),
    };
  });
}

export function profitAndLoss(ds: Dataset, clientId: string, period: string, comparePeriod?: string | null): PLStatement {
  const nets = netBalances(ds, clientId, { period });
  const priorNets = comparePeriod ? netBalances(ds, clientId, { period: comparePeriod }) : {};
  const sections = plSectionsFor(nets, priorNets);
  const get = (key: string) => sections.find((s) => s.key === key)!;
  const revenue = get("revenue").total;
  const costOfSales = get("cos").total;
  const operatingExpenses = get("opex").total;
  const otherExpenses = get("other").total;
  return {
    sections,
    revenue,
    costOfSales,
    grossProfit: revenue - costOfSales,
    operatingExpenses,
    otherExpenses,
    netIncome: revenue - costOfSales - operatingExpenses - otherExpenses,
    priorRevenue: get("revenue").priorTotal,
    priorCostOfSales: get("cos").priorTotal,
    priorGrossProfit: get("revenue").priorTotal - get("cos").priorTotal,
    priorOperatingExpenses: get("opex").priorTotal,
    priorNetIncome:
      get("revenue").priorTotal - get("cos").priorTotal - get("opex").priorTotal - get("other").priorTotal,
  };
}

/** Year to date profit and loss, used by the balance sheet and the narrative. */
export function ytdProfitAndLoss(ds: Dataset, clientId: string, through: string): number {
  const nets = netBalances(ds, clientId, { through, includeOpening: false });
  let income = 0;
  for (const a of ACCOUNTS) {
    if (a.type === "revenue") income += naturalBalance(a, nets[a.id] || 0);
    if (a.type === "expense") income -= naturalBalance(a, nets[a.id] || 0);
  }
  return income;
}

export interface BSGroup {
  key: string;
  label: string;
  rows: { account: Account; amount: number }[];
  total: number;
}

export interface BalanceSheet {
  assetGroups: BSGroup[];
  liabilityGroups: BSGroup[];
  equity: BSGroup;
  netIncomeYtd: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanced: boolean;
  difference: number;
}

export function balanceSheet(ds: Dataset, clientId: string, period: string): BalanceSheet {
  const nets = netBalances(ds, clientId, { through: period });
  const group = (key: string, label: string, subtypes: string[], type: Account["type"]): BSGroup => {
    const rows = ACCOUNTS.filter((a) => a.type === type && subtypes.includes(a.subtype))
      .map((a) => ({ account: a, amount: naturalBalance(a, nets[a.id] || 0) }))
      .filter((r) => r.amount !== 0);
    return { key, label, rows, total: rows.reduce((s, r) => s + r.amount, 0) };
  };
  const assetGroups = [
    // Keep this list in step with BS_SECTIONS in coa.ts. The clearing and suspense
    // block sits in current assets, which is where an unresolved amount belongs.
    group("current_assets", "Current assets", ["Cash and equivalents", "Clearing and suspense", "Receivables", "Inventory", "Other current assets"], "asset"),
    group("fixed_assets", "Property and equipment", ["Fixed assets"], "asset"),
  ];
  const liabilityGroups = [
    group("current_liabilities", "Current liabilities", ["Current liabilities"], "liability"),
    group("long_term", "Long term liabilities", ["Long term liabilities"], "liability"),
  ];
  const equityBase = group("equity", "Equity", ["Equity"], "equity");
  const netIncomeYtd = ytdProfitAndLoss(ds, clientId, period);
  const totalAssets = assetGroups.reduce((s, g) => s + g.total, 0);
  const totalLiabilities = liabilityGroups.reduce((s, g) => s + g.total, 0);
  const totalEquity = equityBase.total + netIncomeYtd;
  return {
    assetGroups,
    liabilityGroups,
    equity: equityBase,
    netIncomeYtd,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
    difference: totalAssets - (totalLiabilities + totalEquity),
  };
}

export interface CashFlowStatement {
  beginningCash: number;
  operating: { label: string; amount: number }[];
  investing: { label: string; amount: number }[];
  financing: { label: string; amount: number }[];
  operatingTotal: number;
  investingTotal: number;
  financingTotal: number;
  netChange: number;
  endingCash: number;
  ties: boolean;
}

function cashOf(nets: Record<string, number>): number {
  return ACCOUNTS.filter((a) => a.cashLike).reduce((s, a) => s + (nets[a.id] || 0), 0);
}

export function cashFlow(ds: Dataset, clientId: string, period: string): CashFlowStatement {
  const prior = priorPeriod(period);
  const beginningNets = prior ? netBalances(ds, clientId, { through: prior }) : netBalances(ds, clientId, { through: "2025-12" });
  const beginningCash = prior
    ? cashOf(beginningNets)
    : cashOf(netBalances(ds, clientId, { period: "2025-12" }));
  const buckets: Record<"operating" | "investing" | "financing", Record<string, number>> = {
    operating: {},
    investing: {},
    financing: {},
  };
  for (const je of ds.journalEntries) {
    if (je.clientId !== clientId || je.period !== period || !je.posted) continue;
    const cashLines = je.lines.filter((l) => acct(l.accountId).cashLike);
    if (!cashLines.length) continue;
    const cashDelta = cashLines.reduce((s, l) => s + l.debit - l.credit, 0);
    if (cashDelta === 0) continue;
    const others = je.lines.filter((l) => !acct(l.accountId).cashLike);
    if (!others.length) continue;
    const weights = others.map((l) => Math.abs(l.debit - l.credit));
    const totalWeight = weights.reduce((s, w) => s + w, 0) || 1;
    let assigned = 0;
    others.forEach((l, i) => {
      const share = i === others.length - 1 ? cashDelta - assigned : Math.round((cashDelta * weights[i]) / totalWeight);
      assigned += share;
      const a = acct(l.accountId);
      const cls = a.type === "revenue" || a.type === "expense" ? "operating" : cashFlowClass(l.accountId);
      const label = labelForCashRow(a);
      buckets[cls][label] = (buckets[cls][label] || 0) + share;
    });
  }
  const toRows = (m: Record<string, number>) =>
    Object.entries(m)
      .filter(([, v]) => v !== 0)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([label, amount]) => ({ label, amount }));
  const operating = toRows(buckets.operating);
  const investing = toRows(buckets.investing);
  const financing = toRows(buckets.financing);
  const operatingTotal = operating.reduce((s, r) => s + r.amount, 0);
  const investingTotal = investing.reduce((s, r) => s + r.amount, 0);
  const financingTotal = financing.reduce((s, r) => s + r.amount, 0);
  const netChange = operatingTotal + investingTotal + financingTotal;
  const endingCash = cashOf(netBalances(ds, clientId, { through: period }));
  return {
    beginningCash,
    operating,
    investing,
    financing,
    operatingTotal,
    investingTotal,
    financingTotal,
    netChange,
    endingCash,
    ties: beginningCash + netChange === endingCash,
  };
}

function labelForCashRow(a: Account): string {
  switch (a.id) {
    case "1100": return "Collections on customer invoices";
    case "2100": return "Payments on vendor bills";
    case "2010": return "Credit card payments";
    case "2200": return "Sales tax remitted";
    case "2300": return "Payroll taxes remitted";
    case "2400": return "Restricted funds released";
    case "1150": return "Inventory purchases";
    case "1200": return "Prepaid items";
    case "1500": return "Equipment purchases";
    case "2500": return "Loan principal";
    case "3000": return "Owner contributions";
    case "3100": return "Owner distributions";
    default: return a.name;
  }
}

// ---------------- Aging ----------------

export interface AgingBucketSet {
  current: number;
  b1: number;
  b31: number;
  b61: number;
  b90: number;
  total: number;
}

export function emptyBuckets(): AgingBucketSet {
  return { current: 0, b1: 0, b31: 0, b61: 0, b90: 0, total: 0 };
}

export function bucketFor(dueDate: string, asOf: string): keyof Omit<AgingBucketSet, "total"> {
  const days = Math.round((Date.parse(asOf + "T00:00:00Z") - Date.parse(dueDate + "T00:00:00Z")) / 86400000);
  if (days <= 0) return "current";
  if (days <= 30) return "b1";
  if (days <= 60) return "b31";
  if (days <= 90) return "b61";
  return "b90";
}

export function openInvoices(ds: Dataset, clientId: string): Invoice[] {
  return ds.invoices.filter((i) => i.clientId === clientId && i.paidCents < i.amountCents);
}

export function openBills(ds: Dataset, clientId: string): Bill[] {
  return ds.bills.filter((b) => b.clientId === clientId && b.paidCents < b.amountCents);
}

export function agingByParty(
  rows: { party: string; dueDate: string; open: number }[],
  asOf = TODAY,
): { party: string; buckets: AgingBucketSet }[] {
  const map = new Map<string, AgingBucketSet>();
  for (const r of rows) {
    const b = map.get(r.party) || emptyBuckets();
    b[bucketFor(r.dueDate, asOf)] += r.open;
    b.total += r.open;
    map.set(r.party, b);
  }
  return [...map.entries()].map(([party, buckets]) => ({ party, buckets })).sort((a, b) => b.buckets.total - a.buckets.total);
}

export function totalBuckets(sets: AgingBucketSet[]): AgingBucketSet {
  return sets.reduce((acc, b) => ({
    current: acc.current + b.current,
    b1: acc.b1 + b.b1,
    b31: acc.b31 + b.b31,
    b61: acc.b61 + b.b61,
    b90: acc.b90 + b.b90,
    total: acc.total + b.total,
  }), emptyBuckets());
}

// ---------------- Reconciliation ----------------

export interface ReconSummary {
  bankAccountId: string;
  period: string;
  statementTotal: number;
  bookTotal: number;
  difference: number;
  matchedCount: number;
  unmatchedStatement: number;
  unmatchedBook: number;
  clearedTotal: number;
}

export function reconSummary(ds: Dataset, clientId: string, bankAccountId: string, period: string): ReconSummary {
  const lines = ds.statementLines.filter((l) => l.bankAccountId === bankAccountId && l.period === period);
  const book = ds.txns.filter((t) => t.bankAccountId === bankAccountId && t.period === period);
  const statementTotal = lines.reduce((s, l) => s + l.amountCents, 0);
  const bookTotal = book.reduce((s, t) => s + t.baseAmountCents, 0);
  const matchedIds = new Set(lines.map((l) => l.matchedTxnId).filter(Boolean) as string[]);
  return {
    bankAccountId,
    period,
    statementTotal,
    bookTotal,
    difference: statementTotal - bookTotal,
    matchedCount: matchedIds.size,
    unmatchedStatement: lines.filter((l) => !l.matchedTxnId).length,
    unmatchedBook: book.filter((t) => !matchedIds.has(t.id)).length,
    clearedTotal: book.filter((t) => matchedIds.has(t.id)).reduce((s, t) => s + t.baseAmountCents, 0),
  };
}

// ---------------- Substantiation ----------------

export interface SubstantiationView {
  id: string;
  clientId: string;
  accountId: string;
  accountName: string;
  period: string;
  supportType: string;
  glCents: number;
  supportedCents: number | null;
  varianceCents: number;
  status: TieStatus;
  documentIds: string[];
  preparedBy: string;
  reviewedBy?: string;
  note: string;
}

export function substantiationViews(ds: Dataset, clientId: string, period = CURRENT_PERIOD): SubstantiationView[] {
  const nets = netBalances(ds, clientId, { through: period });
  return ds.substantiations
    .filter((s) => s.clientId === clientId && s.period === period)
    .map((s) => {
      const a = acct(s.accountId);
      const gl = naturalBalance(a, nets[s.accountId] || 0);
      const varianceSeed = variances[`${s.clientId}:${s.accountId}`];
      const supported = s.supportedCents === null ? null : gl + (varianceSeed || 0);
      const variance = supported === null ? gl : gl - supported;
      const status: TieStatus = supported === null ? "unsupported" : variance === 0 ? "tied" : "variance";
      return {
        id: s.id,
        clientId: s.clientId,
        accountId: s.accountId,
        accountName: a.name,
        period,
        supportType: s.supportType,
        glCents: gl,
        supportedCents: supported,
        varianceCents: variance,
        status,
        documentIds: s.documentIds,
        preparedBy: s.preparedBy,
        reviewedBy: s.reviewedBy,
        note: s.note,
      };
    })
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
}

// ---------------- Vendors and 1099 ----------------

export interface VendorView {
  id: string;
  clientId: string;
  name: string;
  taxClassification: string;
  w9OnFile: boolean;
  tinLast4?: string;
  ytdPaymentsCents: number;
  reportable: boolean;
  requestSentAt?: string;
}

export const REPORTABLE_THRESHOLD_CENTS = 60000;
const NON_REPORTABLE_CLASSES = ["S corporation", "C corporation"];

export function vendorViews(ds: Dataset, clientId: string): VendorView[] {
  return ds.vendors
    .filter((v) => v.clientId === clientId)
    .map((v) => {
      const ytd = ds.txns
        .filter((t) => t.clientId === clientId && t.vendor === v.name && t.baseAmountCents < 0 && t.date >= "2026-01-01")
        .reduce((s, t) => s + Math.abs(t.baseAmountCents), 0);
      const reportable = ytd >= REPORTABLE_THRESHOLD_CENTS && !NON_REPORTABLE_CLASSES.includes(v.taxClassification);
      return { ...v, ytdPaymentsCents: ytd, reportable };
    })
    .sort((a, b) => b.ytdPaymentsCents - a.ytdPaymentsCents);
}

// ---------------- Budget vs actual ----------------

export interface BvaRow {
  account: Account;
  actual: number;
  budget: number;
  variance: number;
  variancePct: number | null;
  favorable: boolean;
}

export function budgetVsActual(ds: Dataset, clientId: string, period: string): { rows: BvaRow[]; totals: { actual: number; budget: number; variance: number } } {
  const nets = netBalances(ds, clientId, { period });
  const rows: BvaRow[] = [];
  for (const a of ACCOUNTS) {
    if (a.type !== "revenue" && a.type !== "expense") continue;
    const actual = naturalBalance(a, nets[a.id] || 0);
    const budgetLine = ds.budgets.find((b) => b.clientId === clientId && b.accountId === a.id && b.period === period);
    const budget = budgetLine ? budgetLine.amountCents : 0;
    if (!actual && !budget) continue;
    const variance = a.type === "revenue" ? actual - budget : budget - actual;
    rows.push({
      account: a,
      actual,
      budget,
      variance,
      variancePct: budget ? Math.round((variance / Math.abs(budget)) * 1000) / 10 : null,
      favorable: variance >= 0,
    });
  }
  const totals = rows.reduce(
    (s, r) => ({ actual: s.actual + (r.account.type === "revenue" ? r.actual : -r.actual), budget: s.budget + (r.account.type === "revenue" ? r.budget : -r.budget), variance: s.variance + r.variance }),
    { actual: 0, budget: 0, variance: 0 },
  );
  return { rows, totals };
}

// ---------------- Cash forecast ----------------

export interface ForecastWeek {
  weekStart: string;
  label: string;
  inflow: number;
  outflow: number;
  net: number;
  endingCash: number;
  scheduled: string[];
}

export function cashForecast(ds: Dataset, clientId: string, weeks = 13): ForecastWeek[] {
  const nets = netBalances(ds, clientId, { through: CURRENT_PERIOD });
  let cash = cashOf(nets);
  const recent = ds.txns.filter((t) => t.clientId === clientId && t.period >= "2026-05" && !t.isMirror);
  const mirrors = ds.txns.filter((t) => t.clientId === clientId && t.period >= "2026-05" && t.isMirror);
  const inflowTotal = [...recent, ...mirrors].filter((t) => t.baseAmountCents > 0 && t.glAccountId === "1010").reduce((s, t) => s + t.baseAmountCents, 0);
  const outflowTotal = [...recent, ...mirrors].filter((t) => t.baseAmountCents < 0 && t.glAccountId === "1010").reduce((s, t) => s + Math.abs(t.baseAmountCents), 0);
  const weeklyIn = Math.round(inflowTotal / 13);
  const weeklyOut = Math.round(outflowTotal / 13);
  const invoices = openInvoices(ds, clientId);
  const bills = openBills(ds, clientId);
  const seasonal = [1.02, 0.94, 1.08, 1.0, 0.9, 1.12, 1.05, 0.97, 1.01, 1.06, 0.92, 1.03, 0.99];
  const out: ForecastWeek[] = [];
  let cursor = TODAY;
  for (let w = 0; w < weeks; w++) {
    const weekStart = cursor;
    const weekEnd = new Date(Date.parse(cursor + "T00:00:00Z") + 6 * 86400000).toISOString().slice(0, 10);
    const scheduled: string[] = [];
    let inflow = Math.round(weeklyIn * seasonal[w % seasonal.length]);
    let outflow = Math.round(weeklyOut * seasonal[(w + 4) % seasonal.length]);
    for (const inv of invoices) {
      if (inv.dueDate >= weekStart && inv.dueDate <= weekEnd) {
        inflow += inv.amountCents - inv.paidCents;
        scheduled.push(`Invoice ${inv.number} from ${inv.customer}`);
      }
    }
    for (const bill of bills) {
      if (bill.dueDate >= weekStart && bill.dueDate <= weekEnd) {
        outflow += bill.amountCents - bill.paidCents;
        scheduled.push(`Bill ${bill.number} to ${bill.vendor}`);
      }
    }
    cash = cash + inflow - outflow;
    out.push({
      weekStart,
      label: `Wk ${w + 1}`,
      inflow,
      outflow,
      net: inflow - outflow,
      endingCash: cash,
      scheduled,
    });
    cursor = new Date(Date.parse(cursor + "T00:00:00Z") + 7 * 86400000).toISOString().slice(0, 10);
  }
  return out;
}

// ---------------- Narrative ----------------

export interface NarrativePoint {
  heading: string;
  body: string;
  tone: "neutral" | "good" | "watch" | "risk";
}

export function monthlyNarrative(ds: Dataset, clientId: string, period = CURRENT_PERIOD): NarrativePoint[] {
  const prior = priorPeriod(period);
  const pl = profitAndLoss(ds, clientId, period, prior);
  const bs = balanceSheet(ds, clientId, period);
  const cf = cashFlow(ds, clientId, period);
  const client = ds.clients.find((c) => c.id === clientId)!;
  const points: NarrativePoint[] = [];
  const fmt = (cents: number) => "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const revDelta = pl.revenue - pl.priorRevenue;
  points.push({
    heading: "Revenue",
    body: `Revenue landed at ${fmt(pl.revenue)}, ${revDelta >= 0 ? "up" : "down"} ${fmt(revDelta)} from the prior month. Net income for the month was ${pl.netIncome >= 0 ? fmt(pl.netIncome) : "a loss of " + fmt(pl.netIncome)}.`,
    tone: revDelta >= 0 ? "good" : "watch",
  });

  const margin = pl.revenue ? (pl.grossProfit / pl.revenue) * 100 : 0;
  const priorMargin = pl.priorRevenue ? (pl.priorGrossProfit / pl.priorRevenue) * 100 : 0;
  points.push({
    heading: "Gross margin",
    body: `Gross margin came in at ${margin.toFixed(1)} percent against ${priorMargin.toFixed(1)} percent last month. Cost of sales was ${fmt(pl.costOfSales)} on ${fmt(pl.revenue)} of revenue.`,
    tone: margin >= priorMargin ? "good" : "watch",
  });

  // Biggest movers by absolute change
  const movers = pl.sections
    .flatMap((s) => s.rows.map((r) => ({ name: r.account.name, delta: r.amount - r.prior, type: r.account.type })))
    .filter((m) => m.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3);
  points.push({
    heading: "Biggest movers",
    body: movers
      .map((m) => `${m.name} ${m.delta > 0 ? "rose" : "fell"} ${fmt(m.delta)}`)
      .join(", ") + ".",
    tone: "neutral",
  });

  const cash = bs.assetGroups[0].rows.filter((r) => r.account.cashLike).reduce((s, r) => s + r.amount, 0);
  const monthlyBurn = Math.max(1, Math.round((pl.costOfSales + pl.operatingExpenses + pl.otherExpenses) / 1));
  const runway = cash / monthlyBurn;
  points.push({
    heading: "Cash position",
    body: `Cash across all accounts closed at ${fmt(cash)} after ${cf.netChange >= 0 ? "adding" : "using"} ${fmt(cf.netChange)} during the month. At the current spend rate that covers about ${runway.toFixed(1)} months of operating costs.`,
    tone: runway >= 3 ? "good" : runway >= 1.5 ? "watch" : "risk",
  });

  const ar = totalBuckets(agingByParty(openInvoices(ds, clientId).map((i) => ({ party: i.customer, dueDate: i.dueDate, open: i.amountCents - i.paidCents }))).map((r) => r.buckets));
  const ap = totalBuckets(agingByParty(openBills(ds, clientId).map((b) => ({ party: b.vendor, dueDate: b.dueDate, open: b.amountCents - b.paidCents }))).map((r) => r.buckets));
  points.push({
    heading: "Receivables and payables",
    body: `Open receivables total ${fmt(ar.total)} with ${fmt(ar.b31 + ar.b61 + ar.b90)} past 30 days. Payables total ${fmt(ap.total)}.`,
    tone: ar.b61 + ar.b90 > 0 ? "watch" : "neutral",
  });

  const flags: string[] = [];
  const subs = substantiationViews(ds, clientId, period);
  const varianceSubs = subs.filter((s) => s.status === "variance");
  const unsupported = subs.filter((s) => s.status === "unsupported");
  if (varianceSubs.length) flags.push(`${varianceSubs[0].accountName} has an unexplained variance of ${fmt(varianceSubs[0].varianceCents)}`);
  if (unsupported.length) flags.push(`${unsupported.length} balance sheet account${unsupported.length > 1 ? "s" : ""} still need support`);
  const review = ds.txns.filter((t) => t.clientId === clientId && t.status === "needs_review").length;
  if (review) flags.push(`${review} transaction${review > 1 ? "s" : ""} parked in 1990 suspense`);
  const missingW9 = vendorViews(ds, clientId).filter((v) => v.reportable && !v.w9OnFile).length;
  if (missingW9) flags.push(`${missingW9} reportable vendor${missingW9 > 1 ? "s" : ""} without a W-9 on file`);
  const openReq = ds.openItems.filter((o) => o.clientId === clientId && o.status !== "accepted").length;
  if (openReq) flags.push(`${openReq} document request${openReq > 1 ? "s" : ""} open with the client`);
  points.push({
    heading: "Flagged for follow up",
    body: flags.length ? flags.join(". ") + "." : `Nothing outstanding for ${client.dba} this period.`,
    tone: flags.length ? "risk" : "good",
  });

  return points;
}

// ---------------- Firm level rollups ----------------

export interface ClientRollup {
  clientId: string;
  revenue: number;
  netIncome: number;
  cash: number;
  openItems: number;
  needsReview: number;
  unreconciled: number;
  tieOutIssues: number;
  tasksOpen: number;
  tasksOverdue: number;
  closeProgress: number;
}

export function clientRollup(ds: Dataset, clientId: string, period = CURRENT_PERIOD): ClientRollup {
  const pl = profitAndLoss(ds, clientId, period, priorPeriod(period));
  const nets = netBalances(ds, clientId, { through: period });
  const banks = ds.bankAccounts.filter((b) => b.clientId === clientId && b.needsReconciling);
  const unreconciled = banks.filter((b) => reconSummary(ds, clientId, b.id, period).difference !== 0).length;
  const subs = substantiationViews(ds, clientId, period);
  const tasks = ds.tasks.filter((t) => t.clientId === clientId && t.period === period);
  const done = tasks.filter((t) => t.status === "Done").length;
  return {
    clientId,
    revenue: pl.revenue,
    netIncome: pl.netIncome,
    cash: cashOf(nets),
    openItems: ds.openItems.filter((o) => o.clientId === clientId && o.status !== "accepted").length,
    needsReview: ds.txns.filter((t) => t.clientId === clientId && t.status === "needs_review").length,
    unreconciled,
    tieOutIssues: subs.filter((s) => s.status !== "tied").length,
    tasksOpen: tasks.filter((t) => t.status !== "Done").length,
    tasksOverdue: tasks.filter((t) => t.status !== "Done" && t.dueDate < TODAY).length,
    closeProgress: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
  };
}

export function monthlyTrend(ds: Dataset, clientId: string): { period: string; revenue: number; expenses: number; netIncome: number; cash: number }[] {
  return PERIODS.map((p) => {
    const pl = profitAndLoss(ds, clientId, p);
    return {
      period: p,
      revenue: pl.revenue,
      expenses: pl.costOfSales + pl.operatingExpenses + pl.otherExpenses,
      netIncome: pl.netIncome,
      cash: cashOf(netBalances(ds, clientId, { through: p })),
    };
  });
}

export function classBreakdown(ds: Dataset, clientId: string, period: string): { name: string; revenue: number; expense: number }[] {
  const map = new Map<string, { revenue: number; expense: number }>();
  for (const je of ds.journalEntries) {
    if (je.clientId !== clientId || je.period !== period) continue;
    for (const l of je.lines) {
      if (!l.klass) continue;
      const a = acct(l.accountId);
      if (a.type !== "revenue" && a.type !== "expense") continue;
      const row = map.get(l.klass) || { revenue: 0, expense: 0 };
      if (a.type === "revenue") row.revenue += l.credit - l.debit;
      else row.expense += l.debit - l.credit;
      map.set(l.klass, row);
    }
  }
  return [...map.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.revenue - a.revenue);
}

export function jobProfitability(ds: Dataset, clientId: string, period: string): { job: string; revenue: number; cost: number; margin: number }[] {
  const map = new Map<string, { revenue: number; cost: number }>();
  for (const je of ds.journalEntries) {
    if (je.clientId !== clientId || je.period !== period) continue;
    for (const l of je.lines) {
      if (!l.job) continue;
      const a = acct(l.accountId);
      if (a.type === "revenue") {
        const row = map.get(l.job) || { revenue: 0, cost: 0 };
        row.revenue += l.credit - l.debit;
        map.set(l.job, row);
      } else if (a.subtype === "Cost of sales") {
        const row = map.get(l.job) || { revenue: 0, cost: 0 };
        row.cost += l.debit - l.credit;
        map.set(l.job, row);
      }
    }
  }
  return [...map.entries()]
    .map(([job, v]) => ({ job, revenue: v.revenue, cost: v.cost, margin: v.revenue - v.cost }))
    .sort((a, b) => b.revenue - a.revenue);
}

export function auditForClient(ds: Dataset, clientId: string) {
  return ds.audit.filter((a) => a.clientId === clientId).sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function entriesFor(ds: Dataset, clientId: string, filter?: (je: JournalEntry) => boolean): JournalEntry[] {
  return ds.journalEntries
    .filter((je) => je.clientId === clientId && (!filter || filter(je)))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ref.localeCompare(a.ref)));
}

export function txnsFor(ds: Dataset, clientId: string): Txn[] {
  return ds.txns.filter((t) => t.clientId === clientId).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function teamWorkload(ds: Dataset) {
  return ds.team.map((m) => {
    const tasks = ds.tasks.filter((t) => t.assignee === m.name && t.status !== "Done");
    const hours = tasks.reduce((s, t) => s + t.estHours, 0);
    return {
      member: m,
      openTasks: tasks.length,
      hours,
      utilization: Math.round((hours / m.capacityHours) * 100),
      overdue: tasks.filter((t) => t.dueDate < TODAY).length,
    };
  });
}
