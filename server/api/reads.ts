/**
 * Read models. NOTES 220.
 *
 * Every function here takes a RunTx opened under a human session and composes
 * named queries from the catalog into the shape a screen shows. No SQL lives
 * here. The catalog is the one place a read is written, both ports implement
 * it, and check-queries covers it. A count on a screen is a filter over the
 * rows of the owning table, never a stored number that could go stale.
 */

import type { ClientSummary } from "../../shared/api/clients";
import type { FirmOverview } from "../../shared/api/overview";
import type { MonthlyRevenueExpense, PortalHome, PortalRequest, PortalStatements, StatementLine, StatementSection } from "../../shared/api/portal";
import type { RunHistoryItem } from "../../shared/api/runs";
import type { Transaction, TransactionPage, TransactionQuery } from "../../shared/api/transactions";
import { TIERS, isTierId } from "../../shared/tiers";
import type { Entitlement } from "../entitlement";
import type { Cents } from "../runs/contract";
import type { RunTx } from "../runs/db";
import { tierOf } from "../runs/policy";
import { blockOf, isIncomeStatement } from "../runs/runs/close-shared";
import { periodWindow } from "../runs/runs/per-shared";
import type { ClientRow, EngagementRow, JournalLineRow, RunLogRow, TransactionRow } from "../runs/tables";

/* ---------------- Helpers ---------------- */

function cents(value: Cents): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`cents out of safe integer range: ${value.toString()}`);
  return n;
}

function scopeKeysOf(client: ClientRow): string[] {
  const scope = client.engagementScope as { keys?: unknown } | null;
  if (scope && Array.isArray(scope.keys)) return scope.keys.filter((k): k is string => typeof k === "string");
  return [];
}

function clientStatus(client: ClientRow): ClientSummary["status"] {
  if (client.archivedAt) return "archived";
  if (client.onboardedAt) return "active";
  return "onboarding";
}

const TREND_MONTHS = 6;

/** The trailing n months as "YYYY-MM" keys, oldest first, today's month last. */
function trailingMonths(today: string, n: number): string[] {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    let yy = y;
    let mm = m - i;
    while (mm <= 0) {
      mm += 12;
      yy -= 1;
    }
    out.push(`${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}`);
  }
  return out;
}

/**
 * Revenue and expense per month from posted journal lines, the same two
 * blocks ARAP and the income statement use (doc 00 Part 3): revenue is a
 * credit, so the sign flips to read as a positive figure; cogs and opex are
 * both debit normal and need no flip. The 8000 block is other income and
 * other expense together and has no single direction, so it is left out of
 * this trend the same way rpt-shared's own variance direction leaves it
 * neutral.
 */
function monthlyRevenueExpense(
  lines: readonly JournalLineRow[],
  today: string,
): MonthlyRevenueExpense[] {
  const months = trailingMonths(today, TREND_MONTHS);
  const revenue = new Map<string, Cents>(months.map((m) => [m, BigInt(0)]));
  const expense = new Map<string, Cents>(months.map((m) => [m, BigInt(0)]));
  for (const line of lines) {
    const block = blockOf(line.accountNumber);
    if (block !== "revenue" && block !== "cogs" && block !== "opex") continue;
    const mk = line.entryDate.slice(0, 7);
    if (!revenue.has(mk)) continue;
    if (block === "revenue") revenue.set(mk, (revenue.get(mk) ?? BigInt(0)) - line.amountCents);
    else expense.set(mk, (expense.get(mk) ?? BigInt(0)) + line.amountCents);
  }
  return months.map((mk) => ({
    month: `${mk}-01`,
    revenueCents: cents(revenue.get(mk) ?? BigInt(0)),
    expenseCents: cents(expense.get(mk) ?? BigInt(0)),
  }));
}

/**
 * Net cash movement per month from posted journal lines on cash accounts
 * (doc 00 Part 3, the 1000 through 1099 block). A deposit and a withdrawal
 * both show up here exactly as they posted, debit positive, so the figure
 * is signed the same way the ledger itself is.
 */
function monthlyCashFlow(lines: readonly JournalLineRow[], today: string): Map<string, Cents> {
  const months = trailingMonths(today, TREND_MONTHS);
  const net = new Map<string, Cents>(months.map((m) => [m, BigInt(0)]));
  for (const line of lines) {
    if (blockOf(line.accountNumber) !== "cash") continue;
    const mk = line.entryDate.slice(0, 7);
    if (!net.has(mk)) continue;
    net.set(mk, (net.get(mk) ?? BigInt(0)) + line.amountCents);
  }
  return net;
}

/* ---------------- Clients ---------------- */

export async function clientSummary(tx: RunTx, firmId: string, client: ClientRow): Promise<ClientSummary> {
  const clientId = client.id;
  const [engagements, portalRequests, documentRequests, suspense, tasks, chart, periods, runs] = await Promise.all([
    tx.query("engagements_for_client", { firmId, clientId }),
    tx.query("open_portal_requests_for_client", { firmId, clientId }),
    tx.query("document_requests_for_client", { firmId, clientId }),
    tx.query("suspense_items_for_client", { firmId, clientId }),
    tx.query("practice_tasks_for_client", { firmId, clientId }),
    tx.query("chart_accounts_for_client", { firmId, clientId }),
    tx.query("close_periods_for_client", { firmId, clientId }),
    tx.query("run_log_for_client", { firmId, clientId, runType: null, limit: 1, offset: 0 }),
  ]);
  const engagement: EngagementRow | undefined = engagements[0];
  const locked = periods.filter((p) => p.status === "locked").map((p) => p.periodStart).sort();
  const open = periods.filter((p) => p.status === "open").map((p) => p.periodStart).sort();
  return {
    id: client.id,
    firmId: client.firmId,
    name: client.name,
    entityType: client.entityType,
    isNonprofit: client.isNonprofit,
    fiscalYearEndMonth: client.fiscalYearEndMonth,
    functionalCurrency: client.functionalCurrency,
    chartTemplateId: client.chartTemplateId,
    scopeKeys: scopeKeysOf(client),
    onboardedAt: client.onboardedAt,
    archivedAt: client.archivedAt,
    status: clientStatus(client),
    engagement: engagement
      ? {
          id: engagement.id,
          status: engagement.status,
          serviceLevel: engagement.serviceLevel,
          reportingBasis: engagement.reportingBasis,
          startDate: engagement.startDate,
          signedAt: engagement.signedAt,
          billingStatus: engagement.billingStatus,
        }
      : null,
    openRequests:
      portalRequests.filter((r) => r.status === "open").length +
      documentRequests.filter((r) => r.status === "open" && r.owner === "client").length,
    openSuspense: suspense.filter((s) => s.withdrawnByRunId === null).length,
    openTasks: tasks.filter((t) => t.state !== "complete").length,
    chartAccounts: chart.length,
    latestClosedPeriod: locked.length > 0 ? locked[locked.length - 1] : null,
    openPeriod: open.length > 0 ? open[0] : null,
    lastRunAt: runs[0]?.startedAt ?? null,
  };
}

export async function listClients(tx: RunTx, firmId: string): Promise<ClientSummary[]> {
  const clients = await tx.query("clients_for_firm", { firmId });
  const out: ClientSummary[] = [];
  for (const c of clients) out.push(await clientSummary(tx, firmId, c));
  return out;
}

export async function getClient(tx: RunTx, firmId: string, clientId: string): Promise<ClientSummary | null> {
  const rows = await tx.query("client_by_id", { firmId, clientId });
  if (rows.length === 0) return null;
  return clientSummary(tx, firmId, rows[0]);
}

/* ---------------- Firm overview ---------------- */

export async function firmOverview(tx: RunTx, firmId: string, today: string): Promise<FirmOverview> {
  const clients = await listClients(tx, firmId);
  const nameById = new Map(clients.map((c) => [c.id, c.name]));
  const recent = await tx.query("run_log_recent_for_firm", { firmId, limit: 20 });

  // Cash flow trend, summed across every client. One client's posted lines
  // at a time, the same N+1 shape listClients -> clientSummary already uses
  // above, acceptable at the scale a firm's own client book runs at.
  const months = trailingMonths(today, TREND_MONTHS);
  const from = `${months[0]}-01`;
  const cashByMonth = new Map<string, Cents>(months.map((m) => [m, BigInt(0)]));
  for (const c of clients) {
    const entries = await tx.query("journal_entries_in_window", { firmId, clientId: c.id, from, to: today });
    const lines =
      entries.length > 0
        ? await tx.query("journal_lines_for_entries", { firmId, clientId: c.id, entryIds: entries.map((e) => e.id) })
        : [];
    for (const [mk, v] of monthlyCashFlow(lines, today)) {
      cashByMonth.set(mk, (cashByMonth.get(mk) ?? BigInt(0)) + v);
    }
  }

  return {
    asOf: today,
    clients,
    totals: {
      clients: clients.length,
      onboarding: clients.filter((c) => c.status === "onboarding").length,
      active: clients.filter((c) => c.status === "active").length,
      openRequests: clients.reduce((n, c) => n + c.openRequests, 0),
      openSuspense: clients.reduce((n, c) => n + c.openSuspense, 0),
      openTasks: clients.reduce((n, c) => n + c.openTasks, 0),
      periodsAwaitingClose: clients.filter((c) => c.openPeriod !== null && c.openPeriod < today.slice(0, 7) + "-01").length,
    },
    recentRuns: recent.map((r) => ({
      executionId: r.id,
      clientId: r.clientId,
      clientName: nameById.get(r.clientId) ?? r.clientId,
      runType: r.runType,
      mode: r.mode,
      status: r.status,
      startedAt: r.startedAt,
    })),
    cashFlowTrend: months.map((mk) => ({
      month: `${mk}-01`,
      netCashCents: cents(cashByMonth.get(mk) ?? BigInt(0)),
    })),
  };
}

/* ---------------- Run history ---------------- */

export async function historyItem(tx: RunTx, row: RunLogRow, undoneIds: ReadonlySet<string>): Promise<RunHistoryItem> {
  const tier = tierOf(row.runType);
  const events = await tx.query("run_log_events_by_execution", { firmId: row.firmId, executionId: row.id });
  const terminal = events.filter((e) => e.event !== "attempt_retried" && e.event !== "undone_by");
  const last = terminal.length > 0 ? terminal[terminal.length - 1] : null;
  const undone = undoneIds.has(row.id) || events.some((e) => e.event === "undone_by");
  return {
    executionId: row.id,
    runType: row.runType,
    runVersion: row.runVersion,
    mode: row.mode,
    status: row.status,
    actorId: row.actorId,
    actorKind: row.actorKind,
    source: row.source,
    previewRunId: row.previewRunId,
    originalRunId: row.originalRunId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    candidateCount: row.candidateCount,
    proposalCount: last?.proposalCount ?? 0,
    skipCount: last?.skipCount ?? 0,
    errorCount: last?.errorCount ?? 0,
    startedAt: row.startedAt,
    finishedAt: last?.occurredAt ?? null,
    tier,
    canApply: row.mode === "preview" && (row.status === "completed" || row.status === "completed_with_skips"),
    canUndo:
      row.mode === "apply" &&
      row.originalRunId === null &&
      (row.status === "completed" || row.status === "completed_with_skips") &&
      !undone,
  };
}

export async function runHistory(
  tx: RunTx,
  firmId: string,
  clientId: string,
  q: { runType?: string; limit: number; offset: number },
): Promise<{ items: RunHistoryItem[]; total: number }> {
  const page = await tx.query("run_log_for_client", {
    firmId,
    clientId,
    runType: q.runType ?? null,
    limit: q.limit,
    offset: q.offset,
  });
  // The total is the unpaged count. One more read, bounded by the page size
  // ceiling rather than by the table, would be dishonest, so read it whole.
  const all = await tx.query("run_log_for_client", {
    firmId,
    clientId,
    runType: q.runType ?? null,
    limit: 100000,
    offset: 0,
  });
  const undone = new Set(all.filter((r) => r.originalRunId !== null && r.mode === "apply").map((r) => r.originalRunId as string));
  const items: RunHistoryItem[] = [];
  for (const r of page) items.push(await historyItem(tx, r, undone));
  return { items, total: all.length };
}

/* ---------------- Transactions ---------------- */

function transactionDto(row: TransactionRow, categoryName: string | null = null): Transaction {
  return {
    categoryName,
    id: row.id,
    bankAccountId: row.bankAccountId,
    accountNumber: row.accountNumber,
    postedDate: row.postedDate,
    amountCents: cents(row.amountCents),
    description: row.description,
    normalizedVendor: row.normalizedVendor,
    categoryId: row.categoryId,
    cascadeLevel: row.cascadeLevel,
    manualOverride: row.manualOverride,
    status: row.status,
  };
}

export async function transactionPage(
  tx: RunTx,
  firmId: string,
  clientId: string,
  q: TransactionQuery,
): Promise<TransactionPage> {
  const params = {
    firmId,
    clientId,
    from: q.from ?? null,
    to: q.to ?? null,
    bankAccountId: q.bankAccountId ?? null,
    search: q.search && q.search.length > 0 ? q.search : null,
    uncategorized: q.uncategorized === true,
  };
  const [rows, all, categories] = await Promise.all([
    tx.query("transactions_page", { ...params, limit: q.limit, offset: q.offset }),
    tx.query("transactions_page", { ...params, limit: 1000000, offset: 0 }),
    tx.query("categories_for_client", { firmId, clientId }),
  ]);
  // The category name rides along so a screen never shows a raw CAT- id.
  const names = new Map(categories.map((c) => [c.id, c.name] as const));
  return {
    items: rows.map((r) => transactionDto(r, r.categoryId ? names.get(r.categoryId) ?? null : null)),
    total: all.length,
    limit: q.limit,
    offset: q.offset,
  };
}

/* ---------------- Portal ---------------- */

function requestDto(r: {
  id: string;
  kind: PortalRequest["kind"];
  subject: string;
  detail: string;
  status: PortalRequest["status"];
  openedOn: string;
  dueOn: string | null;
  accountNumber: string | null;
}): PortalRequest {
  return r;
}

export async function openRequests(tx: RunTx, firmId: string, clientId: string): Promise<PortalRequest[]> {
  const [portal, documents] = await Promise.all([
    tx.query("open_portal_requests_for_client", { firmId, clientId }),
    tx.query("document_requests_for_client", { firmId, clientId }),
  ]);
  const items: PortalRequest[] = [
    ...portal
      .filter((r) => r.status === "open")
      .map((r) =>
        requestDto({
          id: r.id,
          kind: "transaction",
          subject: r.reasonCode,
          detail: r.detail,
          status: r.status,
          openedOn: r.openedOn,
          dueOn: r.dueOn,
          accountNumber: null,
        }),
      ),
    ...documents
      .filter((r) => r.status === "open" && r.owner === "client")
      .map((r) =>
        requestDto({
          id: r.id,
          kind: "document",
          subject: r.catalogCode,
          detail: r.detail,
          status: r.status,
          openedOn: r.openedOn,
          dueOn: r.escalatesOn,
          accountNumber: r.accountNumber,
        }),
      ),
  ];
  return items.sort((a, b) => (a.openedOn !== b.openedOn ? (a.openedOn < b.openedOn ? -1 : 1) : a.id < b.id ? -1 : 1));
}

export async function portalHome(
  tx: RunTx,
  firmId: string,
  clientId: string,
  entitlement: Entitlement,
  today: string,
): Promise<PortalHome | null> {
  const clients = await tx.query("client_by_id", { firmId, clientId });
  const client = clients[0];
  if (!client) return null;
  const [engagements, periods, entries, requests, runs] = await Promise.all([
    tx.query("engagements_for_client", { firmId, clientId }),
    tx.query("close_periods_for_client", { firmId, clientId }),
    tx.query("journal_entries_for_client", { firmId, clientId }),
    openRequests(tx, firmId, clientId),
    tx.query("run_log_for_client", { firmId, clientId, runType: null, limit: 1, offset: 0 }),
  ]);
  const engagement = engagements[0];
  const tier = entitlement.tier ?? (engagement && isTierId(engagement.serviceLevel) ? engagement.serviceLevel : "ledger");
  const locked = periods.filter((p) => p.status === "locked").map((p) => p.periodStart).sort();
  const open = periods.filter((p) => p.status === "open").map((p) => p.periodStart).sort();
  const posted = entries.filter((e) => e.posted);
  const lines =
    posted.length > 0
      ? await tx.query("journal_lines_for_entries", { firmId, clientId, entryIds: posted.map((e) => e.id) })
      : [];
  return {
    client: {
      id: client.id,
      name: client.name,
      entityType: client.entityType,
      fiscalYearEndMonth: client.fiscalYearEndMonth,
    },
    tier,
    tierName: TIERS[tier].name,
    features: [...entitlement.features].sort(),
    engagementStatus: engagement?.status ?? null,
    billingStatus: engagement?.billingStatus ?? null,
    closedPeriods: locked,
    openPeriod: open[0] ?? null,
    latestClosedPeriod: locked.length > 0 ? locked[locked.length - 1] : null,
    hasBooks: posted.length > 0,
    openRequests: requests,
    lastRunAt: runs[0]?.startedAt ?? null,
    monthlyTrend: monthlyRevenueExpense(lines, today),
  };
}

/* ---------------- Statements ---------------- */

interface SectionSpec {
  code: string;
  title: string;
  /** Inclusive account number range, doc 00 Part 3 blocks. */
  from: number;
  to: number;
  creditNormal: boolean;
}

const INCOME_SECTIONS: readonly SectionSpec[] = [
  { code: "revenue", title: "Revenue", from: 4000, to: 4999, creditNormal: true },
  { code: "cogs", title: "Cost of goods sold", from: 5000, to: 5999, creditNormal: false },
  { code: "expenses", title: "Operating expenses", from: 6000, to: 7999, creditNormal: false },
  { code: "other", title: "Other income and expense", from: 8000, to: 8999, creditNormal: false },
];

const BALANCE_SECTIONS: readonly SectionSpec[] = [
  { code: "assets", title: "Assets", from: 1000, to: 1999, creditNormal: false },
  { code: "liabilities", title: "Liabilities", from: 2000, to: 2999, creditNormal: true },
  { code: "equity", title: "Equity", from: 3000, to: 3999, creditNormal: true },
];

function inSection(spec: SectionSpec, accountNumber: string): boolean {
  const n = Number(accountNumber);
  return n >= spec.from && n <= spec.to;
}

function sectionOf(
  spec: SectionSpec,
  balances: Map<string, bigint>,
  names: Map<string, string>,
): StatementSection {
  const lines: StatementLine[] = [];
  let total = BigInt(0);
  for (const [accountNumber, balance] of [...balances.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!inSection(spec, accountNumber)) continue;
    if (balance === BigInt(0)) continue;
    const presented = spec.creditNormal ? -balance : balance;
    total += presented;
    lines.push({
      accountNumber,
      name: names.get(accountNumber) ?? accountNumber,
      balanceCents: cents(balance),
      presentedCents: cents(presented),
    });
  }
  return { code: spec.code, title: spec.title, lines, totalCents: cents(total) };
}

/**
 * Statements for one period, derived from posted journal lines. The income
 * statement covers the period. The balance sheet is cumulative through the
 * period end, with the income statement blocks rolled into a single retained
 * earnings line, so that both sides foot by construction when the ledger
 * does. If the ledger does not foot the screen is told so rather than shown a
 * plug.
 */
export async function portalStatements(
  tx: RunTx,
  firmId: string,
  clientId: string,
  period: string,
  entitlement: Entitlement,
): Promise<PortalStatements> {
  const window = periodWindow(period);
  const [chart, periods, entriesThrough] = await Promise.all([
    tx.query("chart_accounts_for_client", { firmId, clientId }),
    tx.query("close_periods_for_client", { firmId, clientId }),
    tx.query("journal_entries_for_client", { firmId, clientId }),
  ]);
  const names = new Map(chart.map((a) => [a.accountNumber, a.name]));
  const posted = entriesThrough.filter((e) => e.posted && e.entryDate <= window.periodEnd);
  const lines = posted.length > 0
    ? await tx.query("journal_lines_for_entries", { firmId, clientId, entryIds: posted.map((e) => e.id) })
    : [];
  const inPeriod = new Set(posted.filter((e) => e.entryDate >= window.periodStart).map((e) => e.id));

  const periodBalances = new Map<string, bigint>();
  const cumulative = new Map<string, bigint>();
  let retained = BigInt(0);
  for (const line of lines) {
    if (line.accountNumber >= "9000") continue;
    if (blockOf(line.accountNumber) === "memo") continue;
    if (isIncomeStatement(line.accountNumber)) {
      retained += line.amountCents;
      if (inPeriod.has(line.entryId)) {
        periodBalances.set(line.accountNumber, (periodBalances.get(line.accountNumber) ?? BigInt(0)) + line.amountCents);
      }
    } else {
      cumulative.set(line.accountNumber, (cumulative.get(line.accountNumber) ?? BigInt(0)) + line.amountCents);
    }
  }

  const incomeStatement = INCOME_SECTIONS.map((s) => sectionOf(s, periodBalances, names));
  const revenue = incomeStatement.find((s) => s.code === "revenue")?.totalCents ?? 0;
  const costs = incomeStatement.filter((s) => s.code !== "revenue").reduce((n, s) => n + s.totalCents, 0);
  const netIncome = revenue - costs;

  const balanceSheet = BALANCE_SECTIONS.map((s) => sectionOf(s, cumulative, names));
  const equity = balanceSheet.find((s) => s.code === "equity");
  if (equity && retained !== BigInt(0)) {
    const presented = -retained;
    equity.lines.push({
      accountNumber: "3900",
      name: "Retained earnings, current",
      balanceCents: cents(retained),
      presentedCents: cents(presented),
    });
    equity.totalCents += cents(presented);
  }
  const assets = balanceSheet.find((s) => s.code === "assets")?.totalCents ?? 0;
  const liabilitiesAndEquity = balanceSheet.filter((s) => s.code !== "assets").reduce((n, s) => n + s.totalCents, 0);

  const locked = periods.filter((p) => p.status === "locked").map((p) => p.periodStart).sort();
  const open = periods.filter((p) => p.status === "open").map((p) => p.periodStart);
  const thisPeriod = periods.find((p) => p.periodStart === window.periodStart);
  const canSeeOpen = entitlement.features.has("open_period");
  const visible = canSeeOpen ? [...locked, ...open].sort() : locked;

  return {
    clientId,
    period: window.periodStart,
    periodEnd: window.periodEnd,
    periodStatus: thisPeriod ? thisPeriod.status : "none",
    visiblePeriods: visible,
    incomeStatement,
    netIncomeCents: netIncome,
    balanceSheet,
    totalAssetsCents: assets,
    totalLiabilitiesAndEquityCents: liabilitiesAndEquity,
    foots: assets === liabilitiesAndEquity,
    entryCount: inPeriod.size,
  };
}
