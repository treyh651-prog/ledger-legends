/**
 * Shared reading and arithmetic for module 6, substantiation and close.
 *
 * Spec: docs/02-run-specifications.md Module 6, docs/00-conventions.md Part 1
 * for the account blocks and Part 5 for gate behavior, docs/05-decisions.md D3
 * for the derived cash basis and D4 for the preparer and approver split.
 *
 * Three ideas live here and nothing else.
 *
 * First, the account blocks. A chart account row carries a number and a name and
 * no type, so every question about what an account is has to be answered from
 * the four digit block, which doc 00 Part 1 fixes. Guessing from the name would
 * be a different program every time somebody renamed an account.
 *
 * Second, the substantiation source per block. A tie out is only a tie out when
 * the number on the other side came from outside the ledger, so each block names
 * where its support comes from and an account whose block has no source is
 * reported as unsupported rather than quietly counted as agreeing.
 *
 * Third, one read of everything the close needs. The gate evaluator asks
 * nineteen questions of the same ledger, and reading it nineteen times would let
 * two gates disagree about the same period inside one execution.
 */

import { sha256Hex, canonicalJson } from "../ids";
import { sumCents, type RunTx } from "../db";
import type {
  AccrualTemplateRow,
  AgingSnapshotRow,
  BankAccountRow,
  ChartAccountRow,
  ClientPolicyRow,
  ClosePeriodRow,
  DeferralLineRow,
  DeferralScheduleRow,
  DepreciationScheduleRow,
  DocumentLinkRow,
  DocumentRequestRow,
  DocumentationExceptionRow,
  FixedAssetRow,
  GateBlockingRow,
  GateOutcome,
  JournalEntryRow,
  JournalLineRow,
  LoanRow,
  LoanScheduleRow,
  OpeningBalanceRow,
  PeriodLockRow,
  RecBatchRow,
  RunLogRow,
  SubTieoutRow,
  SubstantiationRecordRow,
  SuspenseItemRow,
  TieoutSourceKind,
  TransactionRow,
  VendorRow,
} from "../tables";
import type { Cents, Ulid } from "../contract";
import { periodWindow } from "./per-shared";
import { ZERO, resolvePolicy, type ArapPolicy } from "./arap-shared";

/**
 * Doc 00 Part 1 names five clearing accounts. The task brief puts all five in
 * G01, including 1900 undeposited funds, which doc 00 says need not be zero when
 * a deposits in transit list supports it. See NOTES.md entry 84: the brief wins,
 * because a build that decided for itself which listed account to drop would be
 * a build nobody could audit against the brief.
 */
export const CLEARING_ACCOUNTS: readonly string[] = [
  "1900",
  "1910",
  "1920",
  "1930",
  "1990",
];

export type AccountBlock =
  | "cash"
  | "receivable"
  | "inventory"
  | "prepaid"
  | "other_receivable"
  | "fixed_asset"
  | "accum_depreciation"
  | "intangible"
  | "deposit"
  | "clearing"
  | "payable"
  | "card"
  | "accrued"
  | "payroll"
  | "sales_tax"
  | "deferred_revenue"
  | "debt_current"
  | "debt_long"
  | "related_party"
  | "equity"
  | "revenue"
  | "cogs"
  | "opex"
  | "other_income_expense"
  | "memo";

/** The block an account number falls in, straight off the doc 00 table. */
export function blockOf(accountNumber: string): AccountBlock {
  const n = Number(accountNumber);
  if (n >= 1000 && n <= 1099) return "cash";
  if (n >= 1100 && n <= 1199) return "receivable";
  if (n >= 1200 && n <= 1299) return "inventory";
  if (n >= 1300 && n <= 1399) return "prepaid";
  if (n >= 1400 && n <= 1499) return "other_receivable";
  if (n >= 1500 && n <= 1599) return "fixed_asset";
  if (n >= 1600 && n <= 1699) return "accum_depreciation";
  if (n >= 1700 && n <= 1799) return "intangible";
  if (n >= 1800 && n <= 1899) return "deposit";
  if (n >= 1900 && n <= 1999) return "clearing";
  if (n >= 2000 && n <= 2099) return "payable";
  if (n >= 2100 && n <= 2199) return "card";
  if (n >= 2200 && n <= 2299) return "accrued";
  if (n >= 2300 && n <= 2399) return "payroll";
  if (n >= 2400 && n <= 2499) return "sales_tax";
  if (n >= 2500 && n <= 2599) return "deferred_revenue";
  if (n >= 2600 && n <= 2699) return "debt_current";
  if (n >= 2700 && n <= 2899) return "debt_long";
  if (n >= 2900 && n <= 2999) return "related_party";
  if (n >= 3000 && n <= 3999) return "equity";
  if (n >= 4000 && n <= 4999) return "revenue";
  if (n >= 5000 && n <= 5999) return "cogs";
  if (n >= 6000 && n <= 7999) return "opex";
  if (n >= 8000 && n <= 8999) return "other_income_expense";
  return "memo";
}

/** True for anything that carries a balance forward across a year end. */
export function isBalanceSheet(accountNumber: string): boolean {
  const b = blockOf(accountNumber);
  return (
    b !== "revenue" &&
    b !== "cogs" &&
    b !== "opex" &&
    b !== "other_income_expense" &&
    b !== "memo"
  );
}

/**
 * True for the accounts a year end close empties. Memo accounts at 9000 are out,
 * because doc 00 says they never appear on a published statement, and income tax
 * expense sits in the same block, which is exactly the number a bookkeeper must
 * not compute. See NOTES.md entry 90.
 */
export function isIncomeStatement(accountNumber: string): boolean {
  const b = blockOf(accountNumber);
  return (
    b === "revenue" || b === "cogs" || b === "opex" || b === "other_income_expense"
  );
}

/** Debit positive normal side, per the block. Used by the wrong side check. */
export function normalSideOf(accountNumber: string): "debit" | "credit" {
  const b = blockOf(accountNumber);
  switch (b) {
    case "cash":
    case "receivable":
    case "inventory":
    case "prepaid":
    case "other_receivable":
    case "fixed_asset":
    case "intangible":
    case "deposit":
    case "clearing":
    case "cogs":
    case "opex":
    case "memo":
      return "debit";
    default:
      return "credit";
  }
}

/**
 * Re-exported so a close run can take every money helper it needs from one
 * import. Both come from module 5 and module 1, and redefining either here would
 * create a second zero that compares equal and reads as a different thing.
 */
export { ZERO, sumCents };

/** Cents as a decimal string, for a jsonb payload that cannot hold a bigint. */
export function centsText(value: Cents | null): string | null {
  return value === null ? null : value.toString();
}

export function blocker(
  rowId: string | null,
  label: string,
  detail: string,
  amountCents: Cents | null = null,
): GateBlockingRow {
  return { rowId, label, detail, amountCents: centsText(amountCents) };
}

/** Every account balance through a day, debit positive. */
export function balancesThrough(
  lines: readonly JournalLineRow[],
  asOf: string,
): Map<string, Cents> {
  const out = new Map<string, Cents>();
  for (const l of lines) {
    if (l.entryDate > asOf) continue;
    out.set(l.accountNumber, (out.get(l.accountNumber) ?? ZERO) + l.amountCents);
  }
  return out;
}

/** Every account balance moved inside a window, debit positive. */
export function balancesBetween(
  lines: readonly JournalLineRow[],
  from: string,
  to: string,
): Map<string, Cents> {
  const out = new Map<string, Cents>();
  for (const l of lines) {
    if (l.entryDate < from || l.entryDate > to) continue;
    out.set(l.accountNumber, (out.get(l.accountNumber) ?? ZERO) + l.amountCents);
  }
  return out;
}

export function balanceOf(map: Map<string, Cents>, account: string): Cents {
  return map.get(account) ?? ZERO;
}

/**
 * A hash of the posted ledger inside the period. CLOSE-LOCK-PERIOD stores it and
 * recomputes it, which is how a lock proves the gate set it froze was evaluated
 * against the ledger it locked. A journal row carries no created at column in
 * this schema, so a timestamp comparison was not available. See NOTES.md 88.
 */
export function ledgerFingerprint(
  entries: readonly JournalEntryRow[],
  lines: readonly JournalLineRow[],
  periodStart: string,
  periodEnd: string,
): string {
  const inWindow = entries
    .filter((e) => e.entryDate >= periodStart && e.entryDate <= periodEnd)
    .map((e) => e.id)
    .sort();
  const set = new Set(inWindow);
  const lineParts = lines
    .filter((l) => set.has(l.entryId))
    .map((l) => `${l.entryId}:${l.accountNumber}:${l.amountCents.toString()}`)
    .sort();
  return sha256Hex(canonicalJson({ entries: inWindow, lines: lineParts }));
}

/** Everything module 6 reads, read once. */
export interface CloseData {
  firmId: Ulid;
  clientId: Ulid;
  periodStart: string;
  periodEnd: string;
  nextPeriodStart: string;
  chart: readonly ChartAccountRow[];
  bankAccounts: readonly BankAccountRow[];
  policy: ClientPolicyRow | null;
  arap: ArapPolicy;
  entries: readonly JournalEntryRow[];
  lines: readonly JournalLineRow[];
  locks: readonly PeriodLockRow[];
  periods: readonly ClosePeriodRow[];
  transactions: readonly TransactionRow[];
  suspense: readonly SuspenseItemRow[];
  exceptions: readonly DocumentationExceptionRow[];
  documentLinks: readonly DocumentLinkRow[];
  recBatches: readonly RecBatchRow[];
  aging: readonly AgingSnapshotRow[];
  assets: readonly FixedAssetRow[];
  depreciation: readonly DepreciationScheduleRow[];
  deferrals: readonly DeferralScheduleRow[];
  deferralLines: readonly DeferralLineRow[];
  loans: readonly LoanRow[];
  loanSchedule: readonly LoanScheduleRow[];
  accrualTemplates: readonly AccrualTemplateRow[];
  substantiation: readonly SubstantiationRecordRow[];
  tieouts: readonly SubTieoutRow[];
  requests: readonly DocumentRequestRow[];
  openings: readonly OpeningBalanceRow[];
  vendors: readonly VendorRow[];
  runLog: readonly RunLogRow[];
  /** Balances through period end and inside the period, computed once. */
  through: Map<string, Cents>;
  inPeriod: Map<string, Cents>;
  priorThrough: Map<string, Cents>;
  fingerprint: string;
}

export async function loadCloseData(
  tx: RunTx,
  firmId: Ulid,
  clientId: Ulid,
  period: string,
): Promise<CloseData> {
  const window = periodWindow(period);
  const key = { firmId, clientId };
  const chart = await tx.query("chart_accounts_for_client", key);
  const bankAccounts = await tx.query("bank_accounts_for_client", key);
  const policies = await tx.query("client_policy", key);
  const arapRows = await tx.query("arap_policy", key);
  const entries = await tx.query("journal_entries_for_client", key);
  const lines = await tx.query("journal_lines_for_client", key);
  const locks = await tx.query("open_period_locks", key);
  const periods = await tx.query("close_periods_for_client", key);
  const transactions = await tx.query("transactions_in_window", {
    ...key,
    from: window.periodStart,
    to: window.periodEnd,
    bankAccountIds: null,
    includeOverridden: true,
  });
  const suspense = await tx.query("suspense_items_for_client", key);
  const exceptions = await tx.query("documentation_exceptions_for_client", key);
  const documentLinks = await tx.query("document_links_for_transactions", {
    ...key,
    transactionIds: transactions.map((t) => t.id),
  });
  const recBatches = await tx.query("rec_batches_in_window", {
    ...key,
    from: window.periodStart,
    to: window.periodEnd,
  });
  const aging = await tx.query("aging_snapshots_for_date", {
    ...key,
    asOfDate: window.periodEnd,
  });
  const assets = await tx.query("fixed_assets_for_client", key);
  const depreciation = await tx.query("depreciation_schedule_for_assets", {
    ...key,
    assetIds: assets.map((a) => a.id),
  });
  const deferrals = await tx.query("deferral_schedules_for_client", {
    ...key,
    kinds: ["prepaid", "intangible_amortization", "deferred_revenue", "accrual"],
  });
  const deferralLines = await tx.query("deferral_lines_for_schedules", {
    ...key,
    scheduleIds: deferrals.map((d) => d.id),
  });
  const loans = await tx.query("loans_for_client", key);
  const loanSchedule = await tx.query("loan_schedule_for_loans", {
    ...key,
    loanIds: loans.map((l) => l.id),
  });
  const accrualTemplates = await tx.query("accrual_templates_for_client", key);
  const substantiation = await tx.query("substantiation_records_for_period", {
    ...key,
    periodStart: window.periodStart,
  });
  const tieouts = await tx.query("sub_tieouts_for_period", {
    ...key,
    periodStart: window.periodStart,
  });
  const requests = await tx.query("document_requests_for_client", key);
  const openings = await tx.query("opening_balances_for_period", {
    ...key,
    periodStart: window.periodStart,
  });
  const vendors = await tx.query("vendors_for_client", key);
  const runLog = await tx.query("run_log_for_period", {
    ...key,
    periodStart: window.periodStart,
  });

  const priorDay = priorDayOf(window.periodStart);
  return {
    firmId,
    clientId,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    nextPeriodStart: window.nextPeriodStart,
    chart,
    bankAccounts,
    policy: policies[0] ?? null,
    arap: resolvePolicy(arapRows),
    entries,
    lines,
    locks,
    periods,
    transactions,
    suspense,
    exceptions,
    documentLinks,
    recBatches,
    aging,
    assets,
    depreciation,
    deferrals,
    deferralLines,
    loans,
    loanSchedule,
    accrualTemplates,
    substantiation,
    tieouts,
    requests,
    openings,
    vendors,
    runLog,
    through: balancesThrough(lines, window.periodEnd),
    inPeriod: balancesBetween(lines, window.periodStart, window.periodEnd),
    priorThrough: balancesThrough(lines, priorDay),
    fingerprint: ledgerFingerprint(
      entries,
      lines,
      window.periodStart,
      window.periodEnd,
    ),
  };
}

/** The day before an ISO day, by string arithmetic on the first of a month. */
export function priorDayOf(day: string): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`) - 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** What one tie out row says before it is compared to the ledger. */
export interface TieSource {
  sourceKind: TieoutSourceKind;
  sourceRef: string | null;
  /** Debit positive, in the same convention as the ledger balance. */
  supportedCents: Cents | null;
  detail: string;
}

/**
 * The substantiation source for one account, by block.
 *
 * The signs matter more than anything else here. A ledger balance is debit
 * positive, so a liability supported by a schedule of what is still owed is
 * compared against the negative of that schedule. Getting this backwards would
 * produce a variance of exactly twice the balance on every liability, which is
 * the kind of error that looks like a data problem for a week.
 */
export function tieSourceFor(
  data: CloseData,
  account: ChartAccountRow,
): TieSource {
  const number = account.accountNumber;
  const block = blockOf(number);
  switch (block) {
    case "cash":
      return cashSource(data, number);
    case "receivable":
      return agingSource(data, number, "receivable");
    case "payable":
      return agingSource(data, number, "payable");
    case "inventory":
      return recordSource(data, number, "inventory_count", "physical_count");
    case "payroll":
      return recordSource(data, number, "payroll_register", "register_total");
    case "fixed_asset":
      return assetCostSource(data, number);
    case "accum_depreciation":
      return accumSource(data, number);
    case "debt_current":
    case "debt_long":
      return loanSource(data, number);
    case "prepaid":
      return deferralSource(data, number, ["prepaid"]);
    case "intangible":
      return deferralSource(data, number, ["intangible_amortization"]);
    case "deferred_revenue":
      return deferralSource(data, number, ["deferred_revenue"]);
    case "accrued":
      return deferralSource(data, number, ["accrual"]);
    default:
      return {
        sourceKind: "none",
        sourceRef: null,
        supportedCents: null,
        detail: `block ${block} carries no substantiation source`,
      };
  }
}

function cashSource(data: CloseData, account: string): TieSource {
  const bank = data.bankAccounts.find((b) => b.accountNumber === account);
  if (bank === undefined) {
    return {
      sourceKind: "none",
      sourceRef: null,
      supportedCents: null,
      detail: `no bank account is mapped to ${account}`,
    };
  }
  const batches = data.recBatches
    .filter((b) => b.bankAccountId === bank.id && b.periodEnd <= data.periodEnd)
    .sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
  const batch = batches[batches.length - 1];
  if (batch === undefined) {
    return {
      sourceKind: "statement_balance",
      sourceRef: null,
      supportedCents: null,
      detail: `no statement is loaded for ${bank.nickname} through ${data.periodEnd}`,
    };
  }
  return {
    sourceKind: "statement_balance",
    sourceRef: batch.id,
    supportedCents: batch.statementBalanceCents,
    detail: `statement balance from batch ${batch.id} for ${batch.statementPeriod}`,
  };
}

function agingTotalOf(
  rows: readonly AgingSnapshotRow[],
  side: "receivable" | "payable",
): Cents {
  return sumCents(
    rows
      .filter((r) => r.side === side && r.bucket !== "tie")
      .map((r) => r.openBalanceCents),
  );
}

function agingSource(
  data: CloseData,
  account: string,
  side: "receivable" | "payable",
): TieSource {
  const control =
    side === "receivable" ? data.arap.accounts.arControl : data.arap.accounts.apControl;
  if (account !== control) {
    return {
      sourceKind: "none",
      sourceRef: null,
      supportedCents: null,
      detail: `${account} is not the ${side} control account`,
    };
  }
  const rows = data.aging.filter((r) => r.side === side);
  if (rows.length === 0) {
    return {
      sourceKind: "aging_total",
      sourceRef: null,
      supportedCents: null,
      detail: `no aging snapshot exists for ${data.periodEnd}`,
    };
  }
  const total = agingTotalOf(rows, side);
  // A receivable subledger total is a debit and a payable subledger total is
  // stated as a positive amount owed, which is a credit in the ledger.
  const supported = side === "receivable" ? total : -total;
  return {
    sourceKind: "aging_total",
    sourceRef: `aging:${data.periodEnd}:${side}`,
    supportedCents: supported,
    detail: `aging total for ${side} on ${data.periodEnd}`,
  };
}

function recordSource(
  data: CloseData,
  account: string,
  kind: "inventory_count" | "payroll_register",
  sourceKind: TieoutSourceKind,
): TieSource {
  const record = data.substantiation.find(
    (r) => r.kind === kind && r.accountNumber === account,
  );
  if (record === undefined) {
    return {
      sourceKind,
      sourceRef: null,
      supportedCents: null,
      detail: `no ${kind} is recorded for ${account} in ${data.periodStart}`,
    };
  }
  return {
    sourceKind,
    sourceRef: record.id,
    supportedCents: record.supportedBalanceCents,
    detail: `${kind} ${record.sourceRef ?? record.id}`,
  };
}

function assetCostSource(data: CloseData, account: string): TieSource {
  const owned = data.assets.filter(
    (a) =>
      a.costAccount === account &&
      a.acquiredOn <= data.periodEnd &&
      (a.disposedOn === null || a.disposedOn > data.periodEnd),
  );
  if (owned.length === 0) {
    return {
      sourceKind: "roll_forward_net",
      sourceRef: null,
      supportedCents: ZERO,
      detail: `no asset is registered against ${account} through ${data.periodEnd}`,
    };
  }
  return {
    sourceKind: "roll_forward_net",
    sourceRef: `assets:${account}`,
    supportedCents: sumCents(owned.map((a) => a.costCents)),
    detail: `${owned.length} asset rows at cost against ${account}`,
  };
}

function accumSource(data: CloseData, account: string): TieSource {
  const assets = data.assets.filter(
    (a) =>
      a.accumAccount === account &&
      (a.disposedOn === null || a.disposedOn > data.periodEnd),
  );
  if (assets.length === 0) {
    return {
      sourceKind: "roll_forward_net",
      sourceRef: null,
      supportedCents: ZERO,
      detail: `no asset depreciates into ${account}`,
    };
  }
  let accumulated = ZERO;
  for (const asset of assets) {
    const posted = data.depreciation
      .filter(
        (d) =>
          d.assetId === asset.id &&
          d.status === "posted" &&
          d.periodEnd <= data.periodEnd,
      )
      .sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1));
    const last = posted[posted.length - 1];
    if (last !== undefined) accumulated += last.accumulatedAfterCents;
  }
  // Accumulated depreciation is contra to cost, so it is a credit balance.
  return {
    sourceKind: "roll_forward_net",
    sourceRef: `accum:${account}`,
    supportedCents: -accumulated,
    detail: `roll forward of posted depreciation into ${account}`,
  };
}

function loanSource(data: CloseData, account: string): TieSource {
  const loans = data.loans.filter(
    (l) =>
      l.status === "active" &&
      (l.principalAccountLt === account || l.principalAccountCp === account),
  );
  if (loans.length === 0) {
    return {
      sourceKind: "schedule_remaining",
      sourceRef: null,
      supportedCents: ZERO,
      detail: `no active loan uses ${account}`,
    };
  }
  let remaining = ZERO;
  for (const loan of loans) {
    const paid = data.loanSchedule
      .filter(
        (r) =>
          r.loanId === loan.id &&
          r.status === "posted" &&
          r.dueDate <= data.periodEnd,
      )
      .sort((a, b) => a.paymentNumber - b.paymentNumber);
    const last = paid[paid.length - 1];
    remaining += last === undefined ? loan.originalPrincipalCents : last.balanceAfterCents;
  }
  return {
    sourceKind: "schedule_remaining",
    sourceRef: `loans:${account}`,
    supportedCents: -remaining,
    detail: `amortization remaining across ${loans.length} loans on ${account}`,
  };
}

function deferralSource(
  data: CloseData,
  account: string,
  kinds: readonly string[],
): TieSource {
  const schedules = data.deferrals.filter(
    (s) => kinds.includes(s.kind) && s.balanceAccount === account,
  );
  if (schedules.length === 0) {
    return {
      sourceKind: "schedule_remaining",
      sourceRef: null,
      supportedCents: ZERO,
      detail: `no ${kinds.join(" or ")} schedule uses ${account}`,
    };
  }
  let remaining = ZERO;
  for (const schedule of schedules) {
    const released = data.deferralLines
      .filter(
        (l) =>
          l.scheduleId === schedule.id &&
          l.status === "posted" &&
          l.periodEnd <= data.periodEnd,
      )
      .sort((a, b) => a.periodNumber - b.periodNumber);
    const last = released[released.length - 1];
    remaining +=
      last === undefined ? schedule.totalCents : last.remainingAfterCents;
  }
  const debitSide = normalSideOf(account) === "debit";
  return {
    sourceKind: "schedule_remaining",
    sourceRef: `deferrals:${account}`,
    supportedCents: debitSide ? remaining : -remaining,
    detail: `schedule remaining across ${schedules.length} schedules on ${account}`,
  };
}

/** One gate answer. Never a maybe: doc 00 Part 5 allows three outcomes. */
export interface GateVerdict {
  outcome: GateOutcome;
  blocking: GateBlockingRow[];
  scopeReason: string | null;
}

export interface GateDefinition {
  code: string;
  title: string;
  evaluate: (data: CloseData) => GateVerdict;
}

export function pass(): GateVerdict {
  return { outcome: "pass", blocking: [], scopeReason: null };
}

export function fail(blocking: GateBlockingRow[]): GateVerdict {
  return { outcome: "fail", blocking, scopeReason: null };
}

export function notApplicable(reason: string): GateVerdict {
  return { outcome: "not_applicable", blocking: [], scopeReason: reason };
}

/** Fail when there is blocking evidence, pass when there is none. */
export function verdict(blocking: GateBlockingRow[]): GateVerdict {
  return blocking.length === 0 ? pass() : fail(blocking);
}
