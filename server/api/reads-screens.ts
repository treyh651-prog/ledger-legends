/**
 * Read models for the firm screens beyond the client list and the register.
 * Same rules as reads.ts: named queries only, counts are filters over owning
 * tables, nothing here is a stored summary. NOTES 220.
 */

import type {
  CloseChecklist,
  FirmRequest,
  FirmRequests,
  RecBatch,
  RecLine,
  Reconcile,
  TrialBalance,
} from "../../shared/api/screens";
import type { Cents } from "../runs/contract";
import type { RunTx } from "../runs/db";
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
