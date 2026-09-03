/**
 * Fixtures for the run framework tests. Two firms, each with two clients, so
 * every isolation assertion has something real to fail against.
 */

import { MemoryRunDb } from "../db-memory";
import type {
  BankAccountRow,
  ChartAccountRow,
  PeriodLockRow,
  TransactionRow,
} from "../tables";
import type { ExecuteOptions } from "../execute";

export const FIRM_A = "FIRM-A";
export const FIRM_B = "FIRM-B";
export const CLIENT_A1 = "CLI-A1";
export const CLIENT_A2 = "CLI-A2";
export const CLIENT_B1 = "CLI-B1";
export const ACTOR = "USR-OPERATOR";

export const NOW = new Date("2026-02-10T15:00:00.000Z");

export function bankAccount(
  id: string,
  firmId: string,
  clientId: string,
  accountNumber: string,
  nickname: string,
): BankAccountRow {
  return {
    id,
    firmId,
    clientId,
    accountNumber,
    nickname,
    kind: "bank",
    isProcessorDestination: false,
  };
}

export function chartAccount(
  id: string,
  firmId: string,
  clientId: string,
  accountNumber: string,
  name: string,
): ChartAccountRow {
  return { id, firmId, clientId, accountNumber, name };
}

export interface TxnOverrides {
  categoryId?: string | null;
  pairedWithId?: string | null;
  duplicateFlag?: boolean;
  manualOverride?: boolean;
  normalizedVendor?: string;
  version?: number;
}

export function txn(
  id: string,
  firmId: string,
  clientId: string,
  bankAccountId: string,
  postedDate: string,
  amountCents: bigint,
  extra: TxnOverrides = {},
): TransactionRow {
  return {
    id,
    firmId,
    clientId,
    bankAccountId,
    postedDate,
    amountCents,
    description: `txn ${id}`,
    normalizedVendor: extra.normalizedVendor ?? "INTERNAL TRANSFER",
    categoryId: extra.categoryId ?? null,
    pairedWithId: extra.pairedWithId ?? null,
    duplicateFlag: extra.duplicateFlag ?? false,
    manualOverride: extra.manualOverride ?? false,
    manualOverrideBy: extra.manualOverride ? ACTOR : null,
    manualOverrideAt: extra.manualOverride ? NOW.toISOString() : null,
    version: extra.version ?? 1,
  };
}

export function lock(
  id: string,
  firmId: string,
  clientId: string,
  periodStart: string,
  periodEnd: string,
): PeriodLockRow {
  return {
    id,
    firmId,
    clientId,
    periodStart,
    periodEnd,
    lockedAt: NOW.toISOString(),
    lockedBy: ACTOR,
    closedWithExceptions: false,
    exceptionNote: null,
    unlockedAt: null,
    unlockedBy: null,
    unlockReason: null,
  };
}

/**
 * A database with the chart, the bank accounts, and no transactions. Tests seed
 * their own transactions so each one reads as a small self contained story.
 */
export function baseDb(): MemoryRunDb {
  const db = new MemoryRunDb();
  db.seed("chart_accounts", [
    chartAccount("CH-A1-1920", FIRM_A, CLIENT_A1, "1920", "Transfer clearing"),
    chartAccount("CH-A1-1010", FIRM_A, CLIENT_A1, "1010", "Operating"),
    chartAccount("CH-A1-1020", FIRM_A, CLIENT_A1, "1020", "Savings"),
    chartAccount("CH-A2-1920", FIRM_A, CLIENT_A2, "1920", "Transfer clearing"),
    chartAccount("CH-A2-1010", FIRM_A, CLIENT_A2, "1010", "Operating"),
    chartAccount("CH-A2-1020", FIRM_A, CLIENT_A2, "1020", "Savings"),
    chartAccount("CH-B1-1920", FIRM_B, CLIENT_B1, "1920", "Transfer clearing"),
    chartAccount("CH-B1-1010", FIRM_B, CLIENT_B1, "1010", "Operating"),
    chartAccount("CH-B1-1020", FIRM_B, CLIENT_B1, "1020", "Savings"),
  ]);
  db.seed("bank_accounts", [
    bankAccount("BA-A1-OP", FIRM_A, CLIENT_A1, "1010", "A1 operating"),
    bankAccount("BA-A1-SV", FIRM_A, CLIENT_A1, "1020", "A1 savings"),
    bankAccount("BA-A2-OP", FIRM_A, CLIENT_A2, "1010", "A2 operating"),
    bankAccount("BA-A2-SV", FIRM_A, CLIENT_A2, "1020", "A2 savings"),
    bankAccount("BA-B1-OP", FIRM_B, CLIENT_B1, "1010", "B1 operating"),
    bankAccount("BA-B1-SV", FIRM_B, CLIENT_B1, "1020", "B1 savings"),
  ]);
  return db;
}

export function opts(
  mode: "preview" | "apply",
  extra: Partial<ExecuteOptions> = {},
): ExecuteOptions {
  return {
    mode,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
    ...extra,
  };
}

export function scopeFor(
  clientId: string,
  from = "2026-01-01",
  to = "2026-01-31",
  bankAccountIds: string[] | null = null,
): { clientId: string; from: string; to: string; bankAccountIds: string[] | null } {
  return { clientId, from, to, bankAccountIds };
}
