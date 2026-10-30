/**
 * Read models for the firm screens beyond the client list and the register.
 * Same rules as reads.ts: named queries only, counts are filters over owning
 * tables, nothing here is a stored summary. NOTES 220.
 */

import type {
  Aging,
  ClientSetup,
  FirmTask,
  FirmTasks,
  AgingParty,
  Budget,
  CloseChecklist,
  Forecast,
  Journal,
  JournalEntry,
  Narratives,
  ReportPackages,
  Rules,
  Substantiation,
  TaxForms,
  FirmRequest,
  FirmRequests,
  RecBatch,
  RecLine,
  Reconcile,
  StagedBatch,
  StagedBatches,
  TrialBalance,
} from "../../shared/api/screens";
import type { Cents } from "../runs/contract";
import type { RunTx } from "../runs/db";
import type { PracticeTaskRow } from "../runs/tables";
import { blockOf } from "../runs/runs/close-shared";
import { periodWindow } from "../runs/runs/per-shared";

function cents(value: Cents | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function orNull(value: Cents | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/* ---------------- Close checklist ---------------- */

export async function closeChecklist(tx: RunTx, firmId: string, clientId: string, period: string): Promise<CloseChecklist> {
  const window = periodWindow(period);
  const periodStart = window.periodStart;
  const [periods, tasks, gates, tieouts, suspense, requests, batches] = await Promise.all([
    tx.query("close_periods_for_client", { firmId, clientId }),
    tx.query("practice_tasks_for_client", { firmId, clientId }),
    tx.query("close_gate_results_for_period", { firmId, clientId, periodStart }),
    tx.query("sub_tieouts_for_period", { firmId, clientId, periodStart }),
    tx.query("suspense_items_for_client", { firmId, clientId }),
    tx.query("open_portal_requests_for_client", { firmId, clientId }),
    tx.query("rec_batches_in_window", { firmId, clientId, from: periodStart, to: window.periodEnd }),
  ]);
  const row = periods.find((p) => p.periodStart === periodStart) ?? null;
  // One result per gate: the latest evaluation wins.
  const latestGate = new Map<string, (typeof gates)[number]>();
  for (const g of [...gates].sort((a, b) => (a.evaluatedAt < b.evaluatedAt ? -1 : 1))) latestGate.set(g.gateCode, g);
  return {
    clientId,
    period: periodStart,
    periodStatus: row ? row.status : "none",
    lockedAt: row?.lockedAt ?? null,
    tasks: tasks
      .filter((t) => t.periodStart === periodStart)
      .sort((a, b) => (a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : a.id < b.id ? -1 : 1))
      .map((t) => ({
        id: t.id,
        catalogCode: t.catalogCode,
        title: t.title,
        kind: t.kind,
        role: t.role,
        gateCode: t.gateCode,
        dueDate: t.dueDate,
        state: t.state,
        blockedByCode: t.blockedByCode,
        assigneeId: t.assigneeId,
        escalationRung: String(t.escalationRung),
        completedOn: t.completedOn,
      })),
    gates: Array.from(latestGate.values())
      .sort((a, b) => (a.gateCode < b.gateCode ? -1 : 1))
      .map((g) => ({
        gateCode: g.gateCode,
        gateTitle: g.gateTitle,
        outcome: String(g.outcome),
        blockingCount: g.blockingCount,
        evaluatedAt: g.evaluatedAt,
        scopeReason: g.scopeReason,
      })),
    tieouts: tieouts
      .sort((a, b) => (a.accountNumber < b.accountNumber ? -1 : 1))
      .map((t) => ({
        id: t.id,
        accountNumber: t.accountNumber,
        accountName: t.accountName,
        sourceKind: String(t.sourceKind),
        ledgerBalanceCents: cents(t.ledgerBalanceCents),
        supportedBalanceCents: orNull(t.supportedBalanceCents),
        varianceCents: orNull(t.varianceCents),
        state: t.state,
        detail: t.detail,
      })),
    openSuspense: suspense.filter((s) => s.withdrawnByRunId === null).length,
    openRequests: requests.filter((r) => r.status === "open").length,
    openBatches: batches.filter((b) => b.state !== "reconciled").length,
  };
}

/* ---------------- Reconciliation ---------------- */

export async function reconcile(
  tx: RunTx,
  firmId: string,
  clientId: string,
  period: string,
  batchId: string | null,
): Promise<Reconcile> {
  const window = periodWindow(period);
  const [accounts, batchRows] = await Promise.all([
    tx.query("bank_accounts_for_client", { firmId, clientId }),
    tx.query("rec_batches_in_window", { firmId, clientId, from: window.periodStart, to: window.periodEnd }),
  ]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const ordered = [...batchRows].sort((a, b) => (a.openedAt !== b.openedAt ? (a.openedAt < b.openedAt ? -1 : 1) : a.id < b.id ? -1 : 1));
  const linesByBatch = await Promise.all(
    ordered.map((b) =>
      tx.query("statement_lines_for_statement", { firmId, clientId, bankAccountId: b.bankAccountId, statementId: b.statementId }),
    ),
  );
  const batches: RecBatch[] = ordered.map((b, i) => {
    const account = accountById.get(b.bankAccountId);
    const lines = linesByBatch[i];
    return {
      id: b.id,
      bankAccountId: b.bankAccountId,
      bankAccountName: account?.nickname ?? b.bankAccountId,
      bankKind: account?.kind ?? "bank",
      statementId: b.statementId,
      statementPeriod: b.statementPeriod,
      statementBalanceCents: cents(b.statementBalanceCents),
      clearedLedgerBalanceCents: orNull(b.clearedLedgerBalanceCents),
      diffCents: orNull(b.diffCents),
      state: b.state,
      openedAt: b.openedAt,
      closedAt: b.closedAt,
      lineCount: lines.length,
      matchedCount: lines.filter((l) => l.matchedTransactionId !== null).length,
    };
  });
  const selectedIndex = batchId ? ordered.findIndex((b) => b.id === batchId) : ordered.length > 0 ? 0 : -1;
  const lines: RecLine[] =
    selectedIndex >= 0
      ? linesByBatch[selectedIndex].map((l) => ({
          id: l.id,
          statementDate: l.statementDate,
          amountCents: cents(l.amountCents),
          description: l.description,
          checkNumber: l.checkNumber,
          matchTier: l.matchTier,
          matchConfidence: l.matchConfidence,
          matchDiffCents: orNull(l.matchDiffCents),
          matchConfirmed: l.matchConfirmed,
          matchedTransactionId: l.matchedTransactionId,
          matchedTransactionCount: l.matchedTransactionCount,
        }))
      : [];
  return {
    clientId,
    period: window.periodStart,
    bankAccounts: accounts
      .map((a) => ({ id: a.id, nickname: a.nickname, accountNumber: a.accountNumber, kind: a.kind }))
      .sort((a, b) => (a.nickname < b.nickname ? -1 : 1)),
    batches,
    selectedBatchId: selectedIndex >= 0 ? ordered[selectedIndex].id : null,
    lines,
  };
}

/* ---------------- Staged statements ---------------- */

export async function stagedBatches(tx: RunTx, firmId: string, clientId: string): Promise<StagedBatches> {
  const [batches, accounts] = await Promise.all([
    tx.query("import_batches_awaiting_review", { firmId, clientId }),
    tx.query("bank_accounts_for_client", { firmId, clientId }),
  ]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const items: StagedBatch[] = await Promise.all(
    batches.map(async (b) => {
      const exceptions = await tx.query("mapping_exception_for_account", { firmId, clientId, bankAccountId: b.bankAccountId });
      const open = exceptions.find((e) => e.status === "open") ?? null;
      return {
        id: b.id,
        bankAccountId: b.bankAccountId,
        bankAccountName: accountById.get(b.bankAccountId)?.nickname ?? b.accountNumber,
        periodStart: b.earliestRowDate,
        periodEnd: b.latestRowDate,
        lineCount: b.rowCount,
        duplicatesHeld: b.heldCount,
        rejectedCount: b.rejectedCount,
        netCents: cents(b.netCents),
        status: b.status as "parsed" | "in_review",
        createdAt: b.createdAt,
        mappingError: open ? open.errorMessage : null,
      };
    }),
  );
  return { clientId, items: items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) };
}

/* ---------------- Open items ---------------- */

export async function firmRequests(tx: RunTx, firmId: string, clientId: string, today: string): Promise<FirmRequests> {
  const [portal, documents] = await Promise.all([
    tx.query("open_portal_requests_for_client", { firmId, clientId }),
    tx.query("document_requests_for_client", { firmId, clientId }),
  ]);
  const items: FirmRequest[] = [
    ...portal.map((r) => ({
      id: r.id,
      kind: "transaction" as const,
      subject: r.reasonCode,
      detail: r.detail,
      status: r.status,
      openedOn: r.openedOn,
      dueOn: r.dueOn,
      accountNumber: null,
      owner: "client" as const,
      transactionId: r.transactionId,
    })),
    ...documents
      .filter((r) => r.owner !== "system")
      .map((r) => ({
        id: r.id,
        kind: "document" as const,
        subject: r.catalogCode,
        detail: r.detail,
        status: r.status,
        openedOn: r.openedOn,
        dueOn: r.escalatesOn,
        accountNumber: r.accountNumber,
        owner: r.owner as "client" | "firm",
        transactionId: null,
      })),
  ].sort((a, b) => (a.openedOn !== b.openedOn ? (a.openedOn < b.openedOn ? -1 : 1) : a.id < b.id ? -1 : 1));
  const open = items.filter((i) => i.status === "open");
  return {
    clientId,
    items,
    openCount: open.length,
    overdueCount: open.filter((i) => i.dueOn !== null && i.dueOn < today).length,
  };
}

/* ---------------- Trial balance ---------------- */

export async function trialBalance(tx: RunTx, firmId: string, clientId: string, period: string): Promise<TrialBalance> {
  const window = periodWindow(period);
  const [chart, entries] = await Promise.all([
    tx.query("chart_accounts_for_client", { firmId, clientId }),
    tx.query("journal_entries_for_client", { firmId, clientId }),
  ]);
  const names = new Map(chart.map((a) => [a.accountNumber, a.name]));
  const posted = entries.filter((e) => e.posted && e.entryDate <= window.periodEnd);
  const lines = posted.length > 0 ? await tx.query("journal_lines_for_entries", { firmId, clientId, entryIds: posted.map((e) => e.id) }) : [];
  const balances = new Map<string, bigint>();
  for (const line of lines) {
    if (blockOf(line.accountNumber) === "memo") continue;
    balances.set(line.accountNumber, (balances.get(line.accountNumber) ?? BigInt(0)) + line.amountCents);
  }
  let debit = BigInt(0);
  let credit = BigInt(0);
  const out = Array.from(balances.entries())
    .filter(([, v]) => v !== BigInt(0))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([accountNumber, v]) => {
      if (v > BigInt(0)) debit += v;
      else credit += -v;
      return {
        accountNumber,
        name: names.get(accountNumber) ?? accountNumber,
        debitCents: v > BigInt(0) ? Number(v) : 0,
        creditCents: v < BigInt(0) ? Number(-v) : 0,
      };
    });
  return {
    clientId,
    period: window.periodStart,
    lines: out,
    totalDebitCents: Number(debit),
    totalCreditCents: Number(credit),
    foots: debit === credit,
  };
}

/* ---------------- Aging ---------------- */

type Bucketed = { currentCents: number; b1To30Cents: number; b31To60Cents: number; b61To90Cents: number; over90Cents: number; totalCents: number };

function emptyBuckets(): Bucketed {
  return { currentCents: 0, b1To30Cents: 0, b31To60Cents: 0, b61To90Cents: 0, over90Cents: 0, totalCents: 0 };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function addToBucket(b: Bucketed, dueDate: string, asOf: string, open: number): void {
  const late = daysBetween(dueDate, asOf);
  if (late <= 0) b.currentCents += open;
  else if (late <= 30) b.b1To30Cents += open;
  else if (late <= 60) b.b31To60Cents += open;
  else if (late <= 90) b.b61To90Cents += open;
  else b.over90Cents += open;
  b.totalCents += open;
}

function sumBuckets(parts: Bucketed[]): Bucketed {
  const out = emptyBuckets();
  for (const p of parts) {
    out.currentCents += p.currentCents;
    out.b1To30Cents += p.b1To30Cents;
    out.b31To60Cents += p.b31To60Cents;
    out.b61To90Cents += p.b61To90Cents;
    out.over90Cents += p.over90Cents;
    out.totalCents += p.totalCents;
  }
  return out;
}

export async function aging(tx: RunTx, firmId: string, clientId: string, asOfDate: string): Promise<Aging> {
  const [invoices, bills, customers, vendors, snapshots] = await Promise.all([
    tx.query("invoices_for_client", { firmId, clientId }),
    tx.query("bills_for_client", { firmId, clientId }),
    tx.query("customers_for_client", { firmId, clientId }),
    tx.query("vendors_for_client", { firmId, clientId }),
    tx.query("aging_snapshots_for_date", { firmId, clientId, asOfDate }),
  ]);
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const vendorName = new Map(vendors.map((v) => [v.id, v.legalName]));

  const byParty = (
    docs: { partyId: string; dueDate: string; openCents: number }[],
    names: Map<string, string>,
  ): AgingParty[] => {
    const parties = new Map<string, { buckets: Bucketed; count: number }>();
    for (const d of docs) {
      if (d.openCents <= 0) continue;
      const slot = parties.get(d.partyId) ?? { buckets: emptyBuckets(), count: 0 };
      addToBucket(slot.buckets, d.dueDate, asOfDate, d.openCents);
      slot.count += 1;
      parties.set(d.partyId, slot);
    }
    return Array.from(parties.entries())
      .map(([partyId, v]) => ({ partyId, partyName: names.get(partyId) ?? partyId, documentCount: v.count, buckets: v.buckets }))
      .sort((a, b) => (a.buckets.totalCents !== b.buckets.totalCents ? b.buckets.totalCents - a.buckets.totalCents : a.partyName < b.partyName ? -1 : 1));
  };

  const receivable = byParty(
    invoices
      .filter((i) => i.status === "posted")
      .map((i) => ({
        partyId: i.customerId,
        dueDate: i.dueDate,
        openCents: cents(i.originalAmountCents) - cents(i.appliedPaymentsCents) - cents(i.appliedCreditsCents) - cents(i.writtenOffCents),
      })),
    customerName,
  );
  const payable = byParty(
    bills
      .filter((b) => b.status === "posted")
      .map((b) => ({
        partyId: b.vendorId,
        dueDate: b.dueDate,
        openCents: cents(b.originalAmountCents) - cents(b.paidCents) - cents(b.discountTakenCents) - cents(b.creditsCents),
      })),
    vendorName,
  );
  const snapshotDates = snapshots.map((s) => s.asOfDate).sort();
  return {
    clientId,
    asOfDate,
    receivable,
    receivableTotals: sumBuckets(receivable.map((p) => p.buckets)),
    payable,
    payableTotals: sumBuckets(payable.map((p) => p.buckets)),
    lastSnapshotDate: snapshotDates.length > 0 ? snapshotDates[snapshotDates.length - 1] : null,
  };
}

/* ---------------- Budget ---------------- */

export async function budget(tx: RunTx, firmId: string, clientId: string, period: string): Promise<Budget> {
  const periodStart = periodWindow(period).periodStart;
  const [budgets, variances, thresholds] = await Promise.all([
    tx.query("budgets_for_period", { firmId, clientId, periodStart }),
    tx.query("report_variances_for_period", { firmId, clientId, periodStart }),
    tx.query("budget_thresholds_for_client", { firmId, clientId }),
  ]);
  const lines = variances
    .sort((a, b) => (a.accountNumber < b.accountNumber ? -1 : 1))
    .map((v) => ({
      accountNumber: v.accountNumber,
      accountName: v.accountName,
      budgetCents: cents(v.budgetCents),
      actualCents: cents(v.actualCents),
      varianceCents: cents(v.varianceCents),
      varianceBp: v.varianceBp,
      direction: v.direction,
      flagged: v.flagged,
      flagCode: v.flagCode,
      detail: v.detail,
    }));
  return {
    clientId,
    period: periodStart,
    budgetedAccounts: new Set(budgets.map((b) => b.accountNumber)).size,
    budgetTotalCents: budgets.reduce((n, b) => n + cents(b.budgetCents), 0),
    lines,
    flaggedCount: lines.filter((l) => l.flagged).length,
    thresholds: thresholds.map((t) => ({
      accountNumber: t.accountNumber,
      varianceFloorCents: cents(t.varianceFloorCents),
      varianceThresholdBp: t.varianceThresholdBp,
      note: t.note,
    })),
  };
}

/* ---------------- Forecast ---------------- */

export async function forecast(tx: RunTx, firmId: string, clientId: string, runId: string | null): Promise<Forecast> {
  const rows = await tx.query("cash_forecast_runs_for_client", { firmId, clientId });
  const runs = [...rows]
    .sort((a, b) => (a.builtAt !== b.builtAt ? (a.builtAt < b.builtAt ? 1 : -1) : a.id < b.id ? -1 : 1))
    .map((r) => ({
      id: r.id,
      scenario: r.scenario,
      startDate: r.startDate,
      endDate: r.endDate,
      horizonWeeks: r.horizonWeeks,
      openingCashCents: cents(r.openingCashCents),
      totalInflowCents: cents(r.totalInflowCents),
      totalOutflowCents: cents(r.totalOutflowCents),
      closingCashCents: cents(r.closingCashCents),
      firstShortfallWeek: r.firstShortfallWeek,
      shortfallWeekCount: r.shortfallWeekCount,
      builtAt: r.builtAt,
    }));
  const selected = (runId ? runs.find((r) => r.id === runId) : runs[0]) ?? null;
  const weekRows = selected ? await tx.query("cash_forecast_weeks_for_run", { firmId, clientId, forecastRunId: selected.id }) : [];
  return {
    clientId,
    runs,
    selectedRunId: selected?.id ?? null,
    weeks: weekRows
      .sort((a, b) => a.weekNumber - b.weekNumber)
      .map((w) => ({
        weekNumber: w.weekNumber,
        weekStart: w.weekStart,
        weekEnd: w.weekEnd,
        openingCents: cents(w.openingCents),
        arInflowCents: cents(w.arInflowCents),
        otherInflowCents: cents(w.otherInflowCents),
        apOutflowCents: cents(w.apOutflowCents),
        recurringOutflowCents: cents(w.recurringOutflowCents),
        loanOutflowCents: cents(w.loanOutflowCents),
        payrollOutflowCents: cents(w.payrollOutflowCents),
        inflowCents: cents(w.inflowCents),
        outflowCents: cents(w.outflowCents),
        closingCents: cents(w.closingCents),
        shortfall: w.shortfall,
      })),
  };
}

/* ---------------- Journal ---------------- */

export async function journal(tx: RunTx, firmId: string, clientId: string, period: string): Promise<Journal> {
  const window = periodWindow(period);
  const [entries, chart] = await Promise.all([
    tx.query("journal_entries_in_window", { firmId, clientId, from: window.periodStart, to: window.periodEnd }),
    tx.query("chart_accounts_for_client", { firmId, clientId }),
  ]);
  const names = new Map(chart.map((a) => [a.accountNumber, a.name]));
  const lines = entries.length > 0 ? await tx.query("journal_lines_for_entries", { firmId, clientId, entryIds: entries.map((e) => e.id) }) : [];
  const byEntry = new Map<string, typeof lines>();
  for (const l of lines) {
    const slot = byEntry.get(l.entryId) ?? [];
    slot.push(l);
    byEntry.set(l.entryId, slot);
  }
  let totalDebit = 0;
  const out: JournalEntry[] = [...entries]
    .sort((a, b) => (a.entryDate !== b.entryDate ? (a.entryDate < b.entryDate ? -1 : 1) : a.id < b.id ? -1 : 1))
    .map((e) => {
      const ls = (byEntry.get(e.id) ?? []).sort((a, b) => (a.accountNumber < b.accountNumber ? -1 : 1));
      const debit = ls.reduce((n, l) => (l.amountCents > BigInt(0) ? n + Number(l.amountCents) : n), 0);
      if (e.posted) totalDebit += debit;
      return {
        id: e.id,
        entryDate: e.entryDate,
        memo: e.memo,
        posted: e.posted,
        reversalOf: e.reversalOf,
        reversedByEntryId: e.reversedByEntryId,
        runType: e.runType,
        createdByRunId: e.createdByRunId,
        sourceTable: e.sourceTable,
        debitCents: debit,
        lines: ls.map((l) => ({
          id: l.id,
          accountNumber: l.accountNumber,
          accountName: names.get(l.accountNumber) ?? l.accountNumber,
          amountCents: Number(l.amountCents),
          memo: l.memo,
        })),
      };
    });
  return {
    clientId,
    period: window.periodStart,
    entries: out,
    postedCount: out.filter((e) => e.posted).length,
    totalDebitCents: totalDebit,
  };
}

/* ---------------- Rules ---------------- */

export async function rules(tx: RunTx, firmId: string, clientId: string): Promise<Rules> {
  const [ruleRows, categories] = await Promise.all([
    tx.query("active_rules_for_client", { firmId, clientId }),
    tx.query("categories_for_client", { firmId, clientId }),
  ]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const items = ruleRows.map((r) => ({
    id: r.id,
    name: r.name,
    priority: r.priority,
    conditionCount: r.conditionCount,
    conditions: r.conditions as unknown[],
    targetCategoryId: r.targetCategoryId,
    targetCategoryName: categoryName.get(r.targetCategoryId) ?? null,
    scopeKind: r.scopeKind,
    isActive: r.isActive,
    acceptedCount: r.acceptedCount,
    rejectedCount: r.rejectedCount,
    autoPostEnabled: r.autoPostEnabled,
    autoPostCeilingCents: cents(r.autoPostCeilingCents),
    version: r.version,
  }));
  return { clientId, items, autoPostCount: items.filter((r) => r.autoPostEnabled).length };
}

/* ---------------- Tax forms ---------------- */

export async function taxForms(tx: RunTx, firmId: string, clientId: string, today: string, dataSetId: string | null): Promise<TaxForms> {
  const [sets, w9, thresholds] = await Promise.all([
    tx.query("tax_data_sets_for_client", { firmId, clientId }),
    tx.query("w9_states_for_client", { firmId, clientId }),
    tx.query("tax_thresholds_for_firm", { firmId }),
  ]);
  const ordered = [...sets].sort((a, b) => (a.taxYear !== b.taxYear ? b.taxYear - a.taxYear : a.builtAt < b.builtAt ? 1 : -1));
  const selected = (dataSetId ? ordered.find((s) => s.id === dataSetId) : ordered[0]) ?? null;
  const lines = selected ? await tx.query("tax_data_lines_for_set", { firmId, clientId, dataSetId: selected.id }) : [];
  const taxYear = selected?.taxYear ?? Number(today.slice(0, 4));
  const yearW9 = w9.filter((w) => w.taxYear === taxYear);
  const current = thresholds
    .filter((t) => t.effectiveFrom <= today && (t.effectiveTo === null || t.effectiveTo >= today))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
  return {
    clientId,
    taxYear,
    threshold: current ? { thresholdCents: cents(current.thresholdCents), effectiveFrom: current.effectiveFrom, sourceNote: current.sourceNote } : null,
    dataSets: ordered.map((s) => ({
      id: s.id,
      taxYear: s.taxYear,
      thresholdCents: cents(s.thresholdCents),
      payeeCount: s.payeeCount,
      reportableCount: s.reportableCount,
      approachingCount: s.approachingCount,
      excludedCount: s.excludedCount,
      backupWithholdingCount: s.backupWithholdingCount,
      reportableTotalCents: cents(s.reportableTotalCents),
      excludedCardTotalCents: cents(s.excludedCardTotalCents),
      handoffStatement: s.handoffStatement,
      builtAt: s.builtAt,
    })),
    selectedDataSetId: selected?.id ?? null,
    lines: lines
      .sort((a, b) => (a.payeeName < b.payeeName ? -1 : 1))
      .map((l) => ({
        id: l.id,
        payeeName: l.payeeName,
        formCode: l.formCode,
        boxCode: l.boxCode,
        grossPaidCents: cents(l.grossPaidCents),
        excludedCardCents: cents(l.excludedCardCents),
        reportableCents: cents(l.reportableCents),
        state: l.state,
        w9State: String(l.w9State),
        backupWithholdingRequired: l.backupWithholdingRequired,
        tinLast4: l.tinLast4,
        reason: l.reason,
      })),
    w9: (yearW9.length > 0 ? yearW9 : w9)
      .sort((a, b) => (a.vendorName < b.vendorName ? -1 : 1))
      .map((w) => ({
        id: w.id,
        vendorName: w.vendorName,
        state: w.state,
        requestedOn: w.requestedOn,
        receivedOn: w.receivedOn,
        expiresOn: w.expiresOn,
        ageDays: w.ageDays,
        escalation: w.escalation,
        detail: w.detail,
      })),
  };
}

/* ---------------- Substantiation ---------------- */

export async function substantiation(tx: RunTx, firmId: string, clientId: string, period: string): Promise<Substantiation> {
  const periodStart = periodWindow(period).periodStart;
  const [records, exceptions, tieouts, chart, categories] = await Promise.all([
    tx.query("substantiation_records_for_period", { firmId, clientId, periodStart }),
    tx.query("documentation_exceptions_for_client", { firmId, clientId }),
    tx.query("sub_tieouts_for_period", { firmId, clientId, periodStart }),
    tx.query("chart_accounts_for_client", { firmId, clientId }),
    tx.query("categories_for_client", { firmId, clientId }),
  ]);
  const names = new Map(chart.map((a) => [a.accountNumber, a.name]));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const ex = exceptions
    .sort((a, b) => (a.openedAt !== b.openedAt ? (a.openedAt < b.openedAt ? -1 : 1) : a.id < b.id ? -1 : 1))
    .map((e) => ({
      id: e.id,
      transactionId: e.transactionId,
      kind: e.kind,
      categoryId: e.categoryId,
      categoryName: categoryName.get(e.categoryId) ?? null,
      detail: e.detail,
      status: e.status,
      openedAt: e.openedAt,
    }));
  return {
    clientId,
    period: periodStart,
    records: records
      .sort((a, b) => (a.accountNumber < b.accountNumber ? -1 : 1))
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        accountNumber: r.accountNumber,
        accountName: names.get(r.accountNumber) ?? r.accountNumber,
        supportedBalanceCents: cents(r.supportedBalanceCents),
        sourceRef: r.sourceRef,
        preparedOn: r.preparedOn,
      })),
    exceptions: ex,
    openExceptions: ex.filter((e) => e.status === "open").length,
    tieouts: tieouts
      .sort((a, b) => (a.accountNumber < b.accountNumber ? -1 : 1))
      .map((t) => ({
        id: t.id,
        accountNumber: t.accountNumber,
        accountName: t.accountName,
        sourceKind: String(t.sourceKind),
        ledgerBalanceCents: cents(t.ledgerBalanceCents),
        supportedBalanceCents: orNull(t.supportedBalanceCents),
        varianceCents: orNull(t.varianceCents),
        state: t.state,
        detail: t.detail,
      })),
  };
}

/* ---------------- Report package ---------------- */

export async function reportPackages(tx: RunTx, firmId: string, clientId: string, period: string, packageId: string | null): Promise<ReportPackages> {
  const periodStart = periodWindow(period).periodStart;
  const all = await tx.query("report_packages_for_client", { firmId, clientId });
  const inPeriod = all
    .filter((p) => p.periodStart === periodStart)
    .sort((a, b) => (a.builtAt !== b.builtAt ? (a.builtAt < b.builtAt ? 1 : -1) : a.id < b.id ? -1 : 1));
  const selected = (packageId ? inPeriod.find((p) => p.id === packageId) : inPeriod[0]) ?? null;
  const sections = selected ? await tx.query("report_sections_for_package", { firmId, clientId, packageId: selected.id }) : [];
  return {
    clientId,
    period: periodStart,
    packages: inPeriod.map((p) => ({
      id: p.id,
      period: p.periodStart,
      basis: p.basis,
      comparisonBasis: p.comparisonBasis,
      comparisonAvailable: p.comparisonAvailable,
      comparisonNote: p.comparisonNote,
      state: p.state,
      watermark: p.watermark,
      closedWithExceptions: p.closedWithExceptions,
      exceptionBanner: p.exceptionBanner,
      sectionCount: p.sectionCount,
      omissionCount: p.omissionCount,
      builtAt: p.builtAt,
    })),
    selectedPackageId: selected?.id ?? null,
    sections: sections
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => ({
        id: s.id,
        sequence: s.sequence,
        sectionCode: s.sectionCode,
        sectionTitle: s.sectionTitle,
        status: s.status,
        omissionReason: s.omissionReason,
        bannerText: s.bannerText,
        lines: s.lines.map((l) => ({
          label: l.label,
          accountNumber: l.accountNumber,
          amountCents: Number(l.amountCents),
          comparisonCents: l.comparisonCents === null ? null : Number(l.comparisonCents),
          note: l.note,
        })),
      })),
  };
}

/* ---------------- Narrative ---------------- */

export async function narratives(tx: RunTx, firmId: string, clientId: string, period: string): Promise<Narratives> {
  const periodStart = periodWindow(period).periodStart;
  const all = await tx.query("report_narratives_for_client", { firmId, clientId });
  return {
    clientId,
    period: periodStart,
    items: all
      .filter((n) => n.periodStart === periodStart)
      .sort((a, b) => (a.audience !== b.audience ? (a.audience < b.audience ? -1 : 1) : a.composedAt < b.composedAt ? 1 : -1))
      .map((n) => ({
        id: n.id,
        period: n.periodStart,
        audience: n.audience,
        comparisonBasis: n.comparisonBasis,
        sentenceCount: n.sentenceCount,
        droppedCount: n.droppedCount,
        bodyText: n.bodyText,
        sentences: n.sentences.map((s) => ({ sectionCode: s.sectionCode, triggerCode: s.triggerCode, priority: s.priority, text: s.text })),
        manualEdit: n.manualEdit,
        composedAt: n.composedAt,
      })),
  };
}

/* ---------------- Team, board, client setup ---------------- */

function taskDto(t: PracticeTaskRow, clientName: string): FirmTask {
  return {
    id: t.id,
    clientId: t.clientId,
    clientName,
    periodStart: t.periodStart,
    catalogCode: t.catalogCode,
    title: t.title,
    kind: t.kind,
    role: t.role,
    dueDate: t.dueDate,
    state: t.state,
    blockedByCode: t.blockedByCode,
    assigneeId: t.assigneeId,
    escalationRung: String(t.escalationRung),
    completedOn: t.completedOn,
    manualOverride: t.manualOverride,
  };
}

const byDueThenId = (a: FirmTask, b: FirmTask) => (a.dueDate !== b.dueDate ? (a.dueDate < b.dueDate ? -1 : 1) : a.id < b.id ? -1 : 1);

/**
 * Every practice task in the period, across every client the actor can read.
 * The period is the first day of the month. One query per client, which is
 * the shape the catalog has; the board is a firm screen and reads few rows.
 */
export async function firmTasks(tx: RunTx, firmId: string, period: string): Promise<FirmTasks> {
  const periodStart = periodWindow(period).periodStart;
  const clients = await tx.query("clients_for_firm", { firmId });
  const items: FirmTask[] = [];
  for (const c of clients) {
    const rows = await tx.query("practice_tasks_for_client", { firmId, clientId: c.id });
    for (const t of rows) if (t.periodStart === periodStart) items.push(taskDto(t, c.name));
  }
  items.sort(byDueThenId);
  return { period: periodStart, items };
}

/** Bank accounts, active mapping profiles with their columns, and tasks for one client. */
export async function clientSetup(tx: RunTx, firmId: string, clientId: string): Promise<ClientSetup> {
  const [client, banks, profiles, columns, tasks, policies] = await Promise.all([
    tx.query("client_by_id", { firmId, clientId }),
    tx.query("bank_accounts_for_client", { firmId, clientId }),
    tx.query("mapping_profiles_for_client", { firmId, clientId }),
    tx.query("mapping_profile_columns_for_client", { firmId, clientId }),
    tx.query("practice_tasks_for_client", { firmId, clientId }),
    tx.query("client_policy", { firmId, clientId }),
  ]);
  const name = client[0]?.name ?? clientId;
  const policy = policies[0] ?? null;
  return {
    clientId,
    bankAccounts: banks.map((b) => ({
      id: b.id,
      accountNumber: b.accountNumber,
      nickname: b.nickname,
      kind: b.kind,
      isProcessorDestination: b.isProcessorDestination,
    })),
    mappingProfiles: profiles.map((p) => ({
      id: p.id,
      version: p.version,
      institutionName: p.institutionName,
      accountNumber: p.accountNumber,
      fileFormat: p.fileFormat,
      headerRowNumber: p.headerRowNumber,
      skipRows: p.skipRows,
      dateColumn: p.dateColumn,
      dateFormat: p.dateFormat,
      descriptionColumn: p.descriptionColumn,
      amountColumn: p.amountColumn,
      debitColumn: p.debitColumn,
      creditColumn: p.creditColumn,
      signConvention: p.signConvention,
      currency: p.currency,
      columns: columns
        .filter((c) => c.profileId === p.id)
        .map((c) => ({ sourceIndex: c.sourceIndex, sourceName: c.sourceName, canonicalField: c.canonicalField, sampleValue: c.sampleValue })),
    })),
    tasks: tasks.map((t) => taskDto(t, name)).sort(byDueThenId),
    uploadsConfigured: false,
    policy:
      policy === null
        ? null
        : {
            functionalCurrency: policy.functionalCurrency,
            capitalizeOverCents: policy.capitalizeOverCents === null ? null : Number(policy.capitalizeOverCents),
            grossAtSaleTime: policy.grossAtSaleTime,
            cleanupEngagement: policy.cleanupEngagement,
            entityKind: policy.entityKind,
            retainedEarningsAccount: policy.retainedEarningsAccount,
            netAssetsWithoutRestrictionsAccount: policy.netAssetsWithoutRestrictionsAccount,
            netAssetsWithRestrictionsAccount: policy.netAssetsWithRestrictionsAccount,
            fiscalYearEndMonth: policy.fiscalYearEndMonth,
          },
  };
}
