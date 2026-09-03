/**
 * Fixtures for the run framework tests. Two firms, each with two clients, so
 * every isolation assertion has something real to fail against.
 */

import { MemoryRunDb } from "../db-memory";
import type {
  BankAccountRow,
  ChartAccountRow,
  ImportBatchRow,
  MappingProfileRow,
  PeriodLockRow,
  StagedRowRow,
  TransactionRow,
} from "../tables";
import type { ExecuteOptions } from "../execute";
import { headerFingerprintOf } from "../runs/import-parse-feed";

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
  categoryVersion?: number | null;
  cascadeLevel?: number | null;
  pairedWithId?: string | null;
  duplicateFlag?: boolean;
  duplicateOfTransactionId?: string | null;
  legitimateRepeat?: boolean;
  manualOverride?: boolean;
  normalizedVendor?: string | null;
  vendorNormalizationVersion?: number | null;
  normalizationDegraded?: boolean;
  vendorId?: string | null;
  bankMerchantName?: string | null;
  institutionId?: string | null;
  bankCode?: string | null;
  ruleId?: string | null;
  ruleVersion?: number | null;
  templateId?: string | null;
  templateVersion?: number | null;
  classId?: string | null;
  suspenseReason?: string | null;
  suspenseOwner?: "firm" | "client" | "system" | null;
  suspenseOpenedOn?: string | null;
  settlementOfTransactionId?: string | null;
  isProcessorSettlement?: boolean;
  currency?: string;
  version?: number;
  accountNumber?: string;
  bankTransactionId?: string | null;
  importBatchId?: string | null;
  cleared?: boolean;
  status?: "active" | "reversed";
  description?: string;
  checkNumber?: string | null;
  // Migration 0011 and 0012 reconciliation fields.
  instrumentType?: "issued_check" | "electronic" | "deposit" | "other";
  clearedDate?: string | null;
  statementId?: string | null;
  statementLineId?: string | null;
  statementDate?: string | null;
  matchTier?: number | null;
  matchConfidence?: number | null;
  recBatchId?: string | null;
  staleFlagged?: boolean;
  staleFlaggedOn?: string | null;
  staleOwner?: "firm" | "client" | "system" | null;
  staleEscalatesOn?: string | null;
  escheatReview?: boolean;
  voided?: boolean;
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
    accountNumber: extra.accountNumber ?? "1010",
    postedDate,
    amountCents,
    currency: extra.currency ?? "USD",
    description: extra.description ?? `txn ${id}`,
    bankMerchantName: extra.bankMerchantName ?? null,
    normalizedVendor:
      extra.normalizedVendor === undefined
        ? "INTERNAL TRANSFER"
        : extra.normalizedVendor,
    vendorNormalizationVersion: extra.vendorNormalizationVersion ?? null,
    normalizationDegraded: extra.normalizationDegraded ?? false,
    vendorId: extra.vendorId ?? null,
    checkNumber: extra.checkNumber ?? null,
    bankCode: extra.bankCode ?? null,
    institutionId: extra.institutionId ?? null,
    bankTransactionId: extra.bankTransactionId ?? null,
    source: "import",
    importBatchId: extra.importBatchId ?? null,
    stagedRowId: null,
    categoryId: extra.categoryId ?? null,
    categoryVersion: extra.categoryVersion ?? null,
    cascadeLevel: extra.cascadeLevel ?? null,
    ruleId: extra.ruleId ?? null,
    ruleVersion: extra.ruleVersion ?? null,
    matchedConditions: null,
    autoPostedUnderRulePromotion: false,
    templateId: extra.templateId ?? null,
    templateVersion: extra.templateVersion ?? null,
    classId: extra.classId ?? null,
    locationId: null,
    programId: null,
    suspenseReason: extra.suspenseReason ?? null,
    suspenseOwner: extra.suspenseOwner ?? null,
    suspenseOpenedOn: extra.suspenseOpenedOn ?? null,
    suspenseEscalatesOn: null,
    pairedWithId: extra.pairedWithId ?? null,
    settlementOfTransactionId: extra.settlementOfTransactionId ?? null,
    isProcessorSettlement: extra.isProcessorSettlement ?? false,
    duplicateFlag: extra.duplicateFlag ?? false,
    duplicateOfTransactionId: extra.duplicateOfTransactionId ?? null,
    legitimateRepeat: extra.legitimateRepeat ?? false,
    journalEntryId: null,
    instrumentType: extra.instrumentType ?? "other",
    cleared: extra.cleared ?? false,
    clearedDate:
      extra.clearedDate === undefined
        ? extra.cleared
          ? postedDate
          : null
        : extra.clearedDate,
    statementId: extra.statementId ?? null,
    statementLineId: extra.statementLineId ?? null,
    statementDate: extra.statementDate ?? null,
    matchTier: extra.matchTier ?? null,
    matchConfidence: extra.matchConfidence ?? null,
    recBatchId: extra.recBatchId ?? null,
    staleFlagged: extra.staleFlagged ?? false,
    staleFlaggedOn: extra.staleFlaggedOn ?? null,
    staleOwner: extra.staleOwner ?? null,
    staleEscalatesOn: extra.staleEscalatesOn ?? null,
    escheatReview: extra.escheatReview ?? false,
    voided: extra.voided ?? false,
    status: extra.status ?? "active",
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

/**
 * A CSV mapping profile whose fingerprint is computed from the header cells it
 * is built with, so a test can hand the parser a matching header or a shifted
 * one and get the real comparison rather than a hardcoded string.
 */
export function mappingProfile(
  id: string,
  firmId: string,
  clientId: string,
  header: readonly string[],
  extra: Partial<MappingProfileRow> = {},
): MappingProfileRow {
  return {
    id,
    firmId,
    clientId,
    version: 1,
    institutionName: "First Bank",
    accountNumber: "1010",
    fileFormat: "csv",
    headerFingerprint: headerFingerprintOf(header),
    headerRowNumber: 1,
    skipRows: 0,
    dateColumn: "Date",
    dateFormat: "MM/DD/YYYY",
    descriptionColumn: "Description",
    amountColumn: "Amount",
    debitColumn: null,
    creditColumn: null,
    signConvention: "credit_positive",
    currency: "USD",
    bankIdColumn: null,
    checkNumberColumn: null,
    bankCodeColumn: null,
    isActive: true,
    ...extra,
  };
}

export function importBatch(
  id: string,
  firmId: string,
  clientId: string,
  bankAccountId: string,
  extra: Partial<ImportBatchRow> = {},
): ImportBatchRow {
  return {
    id,
    firmId,
    clientId,
    name: `batch ${id}`,
    sourceFormat: "ofx",
    bankAccountId,
    accountNumber: "1010",
    mappingProfileId: null,
    mappingProfileVersion: null,
    status: "parsed",
    rejectReason: null,
    rowCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    heldCount: 0,
    netCents: BigInt(0),
    parsedRunId: null,
    committedRunId: null,
    committedAt: null,
    reversedRunId: null,
    reversedAt: null,
    reversalBlocked: false,
    createdAt: NOW.toISOString(),
    version: 1,
    ...extra,
  };
}

export function stagedRow(
  id: string,
  batchId: string,
  firmId: string,
  clientId: string,
  bankAccountId: string,
  rowNumber: number,
  postedOn: string,
  amountCents: bigint,
  extra: Partial<StagedRowRow> = {},
): StagedRowRow {
  const description =
    typeof extra.description === "string" ? extra.description : `staged ${id}`;
  return {
    id,
    batchId,
    firmId,
    clientId,
    rowNumber,
    rawRow: {},
    postedOn,
    description,
    normalizedDescription: description.toUpperCase(),
    amountCents,
    currency: "USD",
    accountNumber: "1010",
    bankAccountId,
    bankTransactionId: null,
    checkNumber: null,
    bankCode: null,
    dedupState: "unique",
    duplicateOfTransactionId: null,
    reviewState: "none",
    committedTransactionId: null,
    committedEntryId: null,
    errorCode: null,
    errorMessage: null,
    version: 1,
    ...extra,
  };
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
