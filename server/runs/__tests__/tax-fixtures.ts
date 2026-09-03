/**
 * COMPLIANCE. Ledger Legends is not a CPA firm. This run compiles data. It does
 * not file, issue, submit, or transmit any tax document. The compiled data set
 * is provided to the client's CPA for filing.
 *
 * Fixtures for the module 9 tax compilation tests.
 *
 * The base is the close fixture, because a compiled data set quotes a ledger and
 * a ledger needs a chart, a bank account, and a posted entry to exist. On top of
 * that this file adds the things a 1099 needs and a close does not: a card
 * funding account so the processor exclusion has a subject, a category per
 * reportable class, a vendor per exclusion path, and a year of payments.
 *
 * The year is 2026, so the dated threshold in play is 2,000 dollars. That is
 * deliberate. A fixture built on the 600 dollar figure would still pass if
 * somebody replaced the dated lookup with a constant, and the whole point of
 * doc 02 rule 1 is that the figure moved.
 *
 * Every payee below is one sentence about one rule.
 *
 * CONTRACTOR   250,000 cents of non employee compensation, W-9 on file with a
 *              recorded TIN. The plain reportable case.
 * CORP         300,000 cents, flagged a C corporation. Excluded.
 * ATTORNEY     300,000 cents, also a C corporation, but the class is attorney,
 *              so the exception survives the incorporation.
 * LANDLORD     240,000 cents of rent, which lands in a different form box.
 * APPROACH     170,000 cents, which is 85 percent of the threshold, so it is
 *              listed as approaching and never as reportable.
 * SMALL        50,000 cents, which is under both tests and appears nowhere.
 * HOLD         500,000 cents, no W-9, payment hold set. Excluded entirely.
 * CARDPAYEE    400,000 cents paid on the card account, which the processor
 *              reports on a 1099-K.
 * NOTIN        300,000 cents, reportable, no W-9 and no payment hold, so the
 *              backup withholding flag lands. A flag is all this codebase does.
 */

import { MemoryRunDb } from "../db-memory";
import type { Proposal, Run } from "../contract";
import { execute, type ExecuteOptions, type RunOutcome } from "../execute";
import type {
  BankAccountRow,
  CategoryRow,
  TaxDataLineRow,
  TaxDataSetRow,
  TaxThresholdRow,
  TransactionRow,
  VendorRow,
  W9StateRow,
} from "../tables";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, lock, opts, txn } from "./fixtures";
import { PERIOD, closeDb, request, seedEntry } from "./close-fixtures";

/** The compiled year, and the day inside it every scope points at. */
export const TAX_YEAR = 2026;
export const TAX_PERIOD = "2026-12-01";
export const YEAR_START = "2026-01-01";
export const YEAR_END = "2026-12-31";

/** The 2026 threshold in cents. Section 70433 of the OBBBA moved it here. */
export const THRESHOLD_2026 = BigInt(200000);
/** The pre 2026 threshold, kept so a test can compile an earlier year. */
export const THRESHOLD_LEGACY = BigInt(60000);

export const CARD_ACCOUNT = "BA-A1-CARD";

export const CONTRACTOR = "VEN-CONTRACTOR";
export const CORP = "VEN-CORP";
export const ATTORNEY = "VEN-ATTORNEY";
export const LANDLORD = "VEN-LANDLORD";
export const APPROACH = "VEN-APPROACH";
export const SMALL = "VEN-SMALL";
export const HOLD = "VEN-HOLD";
export const CARDPAYEE = "VEN-CARDPAYEE";
export const NOTIN = "VEN-NOTIN";

/** The tax base. One client, one calendar year, eight payees. */
export function taxDb(): MemoryRunDb {
  const db = closeDb();
  db.seed("bank_accounts", [
    ...db.all("bank_accounts"),
    cardAccount(),
  ]);
  db.seed("tax_thresholds", [
    threshold("TH-1099-LEGACY", "2000-01-01", "2025-12-31", THRESHOLD_LEGACY),
    threshold("TH-1099-2026", "2026-01-01", null, THRESHOLD_2026),
  ]);
  db.seed("categories", taxCategories());
  db.seed("vendors", taxVendors());
  db.seed("transactions", taxTransactions());
  // One posted entry inside the compiled year, so the year fingerprint has
  // something to hash and a later posting can be seen to change it.
  seedEntry(db, "JE-DEC", "2026-12-15", [
    ["6100", BigInt(250000)],
    ["1010", BigInt(-250000)],
  ]);
  return db;
}

export function cardAccount(extra: Partial<BankAccountRow> = {}): BankAccountRow {
  return {
    id: CARD_ACCOUNT,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    accountNumber: "1010",
    nickname: "A1 card",
    kind: "card",
    isProcessorDestination: false,
    ...extra,
  };
}

export function threshold(
  id: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  thresholdCents: bigint,
  extra: Partial<TaxThresholdRow> = {},
): TaxThresholdRow {
  return {
    id,
    firmId: FIRM_A,
    version: 1,
    formFamily: "1099",
    effectiveFrom,
    effectiveTo,
    thresholdCents,
    sourceNote: "seeded threshold row",
    createdAt: NOW.toISOString(),
    manualOverride: false,
    ...extra,
  };
}

/** One category per reportable class, plus a class none control. */
export function taxCategories(): CategoryRow[] {
  return [
    taxCategory("CAT-contract", "nec"),
    taxCategory("CAT-rent", "misc_rent"),
    taxCategory("CAT-attorney", "attorney"),
    taxCategory("CAT-other", "misc_other"),
    taxCategory("CAT-plain", "none"),
  ];
}

export function taxCategory(
  id: string,
  class1099: CategoryRow["class1099"],
  extra: Partial<CategoryRow> = {},
): CategoryRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    name: id,
    accountNumber: "6100",
    normalSide: "debit",
    taxTreatment: "deductible",
    class1099,
    requiresReceiptOverCents: null,
    requiresClass: false,
    capitalizeOverCents: null,
    restrictionRelevant: false,
    isActive: true,
    ...extra,
  };
}

export function taxVendor(
  id: string,
  legalName: string,
  extra: Partial<VendorRow> = {},
): VendorRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    legalName,
    normalizedName: legalName.toUpperCase(),
    normalizerVersion: 1,
    aliases: [],
    defaultCategoryId: null,
    defaultCategoryVersion: null,
    isActive: true,
    earlyDiscountRule: null,
    w9OnFile: true,
    w9ExpiresOn: null,
    entityType: "individual",
    paymentHold: false,
    tinLast4: "1234",
    ...extra,
  };
}

export function taxVendors(): VendorRow[] {
  return [
    taxVendor(CONTRACTOR, "Alvarez Contracting"),
    taxVendor(CORP, "Bright Supply Inc", { entityType: "c_corporation" }),
    taxVendor(ATTORNEY, "Coleman Law PC", { entityType: "c_corporation" }),
    taxVendor(LANDLORD, "Delgado Properties"),
    taxVendor(APPROACH, "Everett Design"),
    taxVendor(SMALL, "Fielding Repair"),
    // No W-9 and a payment hold. Somebody already stopped paying this payee.
    taxVendor(HOLD, "Granger Hauling", {
      w9OnFile: false,
      tinLast4: null,
      paymentHold: true,
    }),
    taxVendor(CARDPAYEE, "Hollis Marketing"),
    // Reportable, no W-9, no payment hold. The backup withholding flag exists
    // for exactly this payee, and the flag is all this codebase ever does.
    taxVendor(NOTIN, "Iverson Welding", {
      w9OnFile: false,
      tinLast4: null,
    }),
  ];
}

/**
 * A payment. Money out is negative, which is what the ledger stores.
 *
 * The funding account is a positional argument on the shared builder rather than
 * an override, so it is passed here the same way rather than through the extras
 * bag, where it would be silently dropped.
 */
export function payment(
  id: string,
  vendorId: string,
  categoryId: string,
  cents: bigint,
  bankAccountId: string = "BA-A1-OP",
  extra: Partial<TransactionRow> = {},
): TransactionRow {
  return txn(id, FIRM_A, CLIENT_A1, bankAccountId, "2026-06-15", -cents, {
    vendorId,
    categoryId,
    categoryVersion: 1,
    normalizedVendor: null,
    ...extra,
  });
}

export function taxTransactions(): TransactionRow[] {
  return [
    payment("TXN-CONTRACT", CONTRACTOR, "CAT-contract", BigInt(250000)),
    payment("TXN-CORP", CORP, "CAT-contract", BigInt(300000)),
    payment("TXN-ATTY", ATTORNEY, "CAT-attorney", BigInt(300000)),
    payment("TXN-RENT", LANDLORD, "CAT-rent", BigInt(240000)),
    payment("TXN-APPROACH", APPROACH, "CAT-contract", BigInt(170000)),
    payment("TXN-SMALL", SMALL, "CAT-contract", BigInt(50000)),
    payment("TXN-HOLD", HOLD, "CAT-contract", BigInt(500000)),
    payment("TXN-CARD", CARDPAYEE, "CAT-contract", BigInt(400000), CARD_ACCOUNT),
    payment("TXN-NOTIN", NOTIN, "CAT-contract", BigInt(300000)),
  ];
}

/** A W-9 document request, shaped the way SUB-RAISE-REQUESTS shapes one. */
export function w9Request(
  id: string,
  vendorId: string,
  extra: Parameters<typeof request>[2] = {},
) {
  return request(id, `w9:${vendorId}`, {
    catalogCode: "W9",
    linkedItemId: vendorId,
    openedOn: "2026-12-01",
    asOfDate: YEAR_END,
    agingDays: 30,
    escalation: "none",
    ...extra,
  });
}

/** Lock a period, which is the normal state of a January compilation. */
export function lockDecember(db: MemoryRunDb): void {
  db.seed("period_locks", [
    ...db.all("period_locks"),
    lock("PL-DEC", FIRM_A, CLIENT_A1, "2026-12-01", YEAR_END),
  ]);
}

/** Lock January, which is what the payroll write runs have to refuse. */
export function lockJanuary(db: MemoryRunDb): void {
  db.seed("period_locks", [
    ...db.all("period_locks"),
    lock("PL-JAN", FIRM_A, CLIENT_A1, PERIOD, "2026-01-31"),
  ]);
}

export function taxScope(
  period: string = TAX_PERIOD,
  clientId: string = CLIENT_A1,
): { clientId: string; period: string } {
  return { clientId, period };
}

export function previewTax<S>(
  db: MemoryRunDb,
  run: Run<S, Proposal>,
  scope: S,
  extra: Partial<ExecuteOptions> = {},
): Promise<RunOutcome<Proposal>> {
  return execute<S, Proposal>(db, run, scope, opts("preview", extra));
}

/** Preview then apply, the way the whole suite runs a run. */
export async function applyTax<S>(
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

export function dataSetsOf(db: MemoryRunDb): TaxDataSetRow[] {
  return [...db.all("tax_data_sets")].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function linesOf(db: MemoryRunDb): TaxDataLineRow[] {
  return [...db.all("tax_data_lines")].sort((a, b) =>
    a.payeeName === b.payeeName
      ? a.boxCode < b.boxCode
        ? -1
        : 1
      : a.payeeName < b.payeeName
        ? -1
        : 1,
  );
}

export function lineFor(db: MemoryRunDb, payeeId: string): TaxDataLineRow | undefined {
  return linesOf(db).find((l) => l.payeeId === payeeId);
}

export function w9StatesOf(db: MemoryRunDb): W9StateRow[] {
  return [...db.all("w9_states")].sort((a, b) => (a.vendorId < b.vendorId ? -1 : 1));
}

/** A comparable shape for a proposal. The execution id differs by definition. */
export function shapeOf(proposals: readonly Proposal[]): string {
  return JSON.stringify(
    proposals.map((p) => ({
      kind: p.kind,
      table: "table" in p ? p.table : null,
      rowId: "rowId" in p ? p.rowId : null,
    })),
  );
}

export { ACTOR, CLIENT_A1, FIRM_A, NOW, opts };
