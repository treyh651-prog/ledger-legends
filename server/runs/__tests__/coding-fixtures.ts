/**
 * Fixtures for the module 2 coding cascade tests.
 *
 * The base fixtures build a chart with 1010, 1020, and 1920 on it. The coding
 * cascade also needs 1910 and 1990 plus a handful of expense and revenue
 * accounts, so codingDb() extends the base rather than replacing it. Every
 * builder below takes an overrides object so a test can say what it is actually
 * about in one line and let everything else default to something plausible.
 */

import type { MemoryRunDb } from "../db-memory";
import type { Proposal, Run } from "../contract";
import { execute, type ExecuteOptions, type RunOutcome } from "../execute";
import type {
  BankCodeMappingRow,
  CategoryRow,
  ClientPolicyRow,
  DocumentLinkRow,
  PortalRequestRow,
  RecurringSplitRow,
  RecurringTemplateRow,
  RuleRow,
  SettlementRowRow,
  SuspenseItemRow,
  VendorRow,
} from "../tables";
import {
  ACTOR,
  CLIENT_A1,
  CLIENT_A2,
  FIRM_A,
  NOW,
  bankAccount,
  baseDb,
  chartAccount,
  opts,
} from "./fixtures";

/** Chart accounts the coding cascade posts to, beyond the base three. */
export const CODING_ACCOUNTS: readonly [string, string][] = [
  ["1910", "Processor clearing"],
  ["1930", "Undeposited funds"],
  ["1990", "Suspense"],
  ["4000", "Sales"],
  ["6100", "Software"],
  ["6110", "Merchant fees"],
  ["6200", "Meals"],
  ["6300", "Rent"],
  ["1500", "Equipment"],
];

/**
 * The base database plus the coding chart, a processor destination account, and
 * the second client's suspense account so cross client isolation has something
 * real to fail against.
 */
export function codingDb(): MemoryRunDb {
  const db = baseDb();
  const rows = [];
  for (const [number, name] of CODING_ACCOUNTS) {
    rows.push(chartAccount(`CH-A1-${number}`, FIRM_A, CLIENT_A1, number, name));
    rows.push(chartAccount(`CH-A2-${number}`, FIRM_A, CLIENT_A2, number, name));
  }
  db.seed("chart_accounts", rows);
  db.seed("bank_accounts", [
    {
      ...bankAccount("BA-A1-PROC", FIRM_A, CLIENT_A1, "1910", "A1 processor"),
      isProcessorDestination: true,
    },
    {
      ...bankAccount("BA-A1-CARD", FIRM_A, CLIENT_A1, "1010", "A1 card"),
      kind: "card" as const,
    },
  ]);
  return db;
}

export function category(
  id: string,
  accountNumber: string,
  extra: Partial<CategoryRow> = {},
): CategoryRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    name: id,
    accountNumber,
    normalSide: "debit",
    taxTreatment: "deductible",
    class1099: "none",
    requiresReceiptOverCents: null,
    requiresClass: false,
    capitalizeOverCents: null,
    restrictionRelevant: false,
    isActive: true,
    ...extra,
  };
}

/** The three categories nearly every coding test needs. */
export function standardCategories(): CategoryRow[] {
  return [
    category("CAT-software", "6100"),
    category("CAT-meals", "6200", { taxTreatment: "meals_50" }),
    category("CAT-sales", "4000", {
      normalSide: "credit",
      taxTreatment: "not_applicable",
    }),
    category("CAT-fees", "6110"),
    category("CAT-rent", "6300"),
  ];
}

export function rule(
  id: string,
  extra: Partial<RuleRow> = {},
): RuleRow {
  const conditions = extra.conditions ?? [
    { type: "vendor_equals" as const, value: "GITHUB" },
  ];
  // conditionCount is denormalized because it is a tie break input, so it is
  // derived from the conditions unless a test is deliberately setting it apart.
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    name: id,
    priority: 100,
    conditionCount: conditions.length,
    conditions,
    targetCategoryId: "CAT-software",
    scopeKind: "client",
    effectiveFrom: null,
    effectiveTo: null,
    isActive: true,
    acceptedCount: 0,
    rejectedCount: 0,
    autoPostEnabled: false,
    autoPostEnabledBy: null,
    autoPostCeilingCents: BigInt(250000),
    ...extra,
  };
}

export function template(
  id: string,
  extra: Partial<RecurringTemplateRow> = {},
): RecurringTemplateRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    name: id,
    matchKind: "transaction_match",
    matchNormalizedName: "GITHUB",
    bankAccountId: null,
    amountMode: "fixed_amount",
    matchAmountCents: BigInt(-10000),
    amountFloorCents: null,
    amountCeilingCents: null,
    dayOfMonth: null,
    dayWindow: 5,
    splitMode: "single",
    isActive: true,
    cadence: null,
    startDate: null,
    endDate: null,
    postingDateRule: "period_end",
    driverAmountCents: null,
    entryMemoTemplate: null,
    manualOverride: false,
    ...extra,
  };
}

export function split(
  id: string,
  templateId: string,
  lineNumber: number,
  extra: Partial<RecurringSplitRow> = {},
): RecurringSplitRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    templateId,
    templateVersion: 1,
    lineNumber,
    categoryId: "CAT-software",
    accountNumber: "6100",
    fixedAmountCents: null,
    percentBps: null,
    isRemainder: false,
    classId: null,
    locationId: null,
    programId: null,
    memo: null,
    ...extra,
  };
}

export function vendor(
  id: string,
  normalizedName: string,
  extra: Partial<VendorRow> = {},
): VendorRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    legalName: normalizedName,
    normalizedName,
    normalizerVersion: 1,
    aliases: [],
    defaultCategoryId: "CAT-software",
    defaultCategoryVersion: 1,
    isActive: true,
    ...extra,
  };
}

export function bankCodeMapping(
  id: string,
  bankCode: string,
  extra: Partial<BankCodeMappingRow> = {},
): BankCodeMappingRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    institutionId: "INST-1",
    bankCode,
    categoryId: "CAT-software",
    isActive: true,
    ...extra,
  };
}

export function settlementRow(
  id: string,
  extra: Partial<SettlementRowRow> = {},
): SettlementRowRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    processorKey: "STRIPE",
    payoutId: "PO-1",
    payoutDate: "2026-01-15",
    grossCents: BigInt(100000),
    feeCents: BigInt(-2900),
    netCents: BigInt(97100),
    batchReference: "PO-1",
    revenueCategoryId: "CAT-sales",
    feeCategoryId: "CAT-fees",
    matchedTransactionId: null,
    version: 1,
    ...extra,
  };
}

export function clientPolicy(
  extra: Partial<ClientPolicyRow> = {},
): ClientPolicyRow {
  return {
    id: "POL-A1",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    functionalCurrency: "USD",
    capitalizeOverCents: BigInt(250000),
    grossAtSaleTime: false,
    cleanupEngagement: false,
    ...extra,
  };
}

export function documentLink(
  id: string,
  transactionId: string,
  extra: Partial<DocumentLinkRow> = {},
): DocumentLinkRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    transactionId,
    documentId: `DOC-${id}`,
    documentType: "receipt",
    ...extra,
  };
}

export function suspenseItem(
  id: string,
  transactionId: string,
  reasonCode: string,
  extra: Partial<SuspenseItemRow> = {},
): SuspenseItemRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    transactionId,
    reasonCode,
    accountNumber: "1990",
    detail: `seeded ${reasonCode}`,
    relatedIds: [],
    createdByRunId: "RUNX-SEED",
    withdrawnByRunId: null,
    ...extra,
  };
}

export function portalRequestRow(
  id: string,
  transactionId: string,
  reasonCode: string,
  extra: Partial<PortalRequestRow> = {},
): PortalRequestRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    transactionId,
    reasonCode,
    detail: `seeded ${reasonCode}`,
    status: "open",
    openedOn: "2026-01-05",
    dueOn: "2026-01-12",
    createdByRunId: "RUNX-SEED",
    requestedAt: NOW.toISOString(),
    ...extra,
  };
}

/** The actor id, re exported so a coding test does not import two fixture files. */
export const CODING_ACTOR = ACTOR;

/**
 * Preview a coding run. Every coding test starts here, because preview is apply
 * with the commit removed and a preview that proposes the wrong thing is the
 * cheapest possible place to catch it.
 */
export function previewCoding<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<RunOutcome<Proposal>> {
  return execute<S, Proposal>(db, run, scope, opts("preview", extra));
}

/**
 * Preview then apply, which is the only legal way to apply. The preview id is
 * threaded through because the framework refuses an apply that never previewed.
 */
export async function applyCoding<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<{ preview: RunOutcome<Proposal>; applied: RunOutcome<Proposal> }> {
  const preview = await execute<S, Proposal>(db, run, scope, opts("preview", extra));
  const applied = await execute<S, Proposal>(
    db,
    run,
    scope,
    opts("apply", { ...extra, previewRunId: preview.executionId }),
  );
  return { preview, applied };
}

/** The skip details recorded against one row, sorted so a compare is stable. */
export function skipDetails(
  outcome: RunOutcome<Proposal>,
  rowId: string,
): string[] {
  return outcome.result.skips
    .filter((s) => s.rowId === rowId)
    .map((s) => `${s.reason}:${s.detail ?? ""}`)
    .sort();
}

/** True when the run recorded the given skip reason against the row. */
export function skippedFor(
  outcome: RunOutcome<Proposal>,
  rowId: string,
  reason: string,
): boolean {
  return outcome.result.skips.some((s) => s.rowId === rowId && s.reason === reason);
}
