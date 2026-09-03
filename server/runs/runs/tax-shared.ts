/**
 * COMPLIANCE. Ledger Legends is not a CPA firm. This run compiles data. It does
 * not file, issue, submit, or transmit any tax document. The compiled data set
 * is provided to the client's CPA for filing.
 *
 * Shared reading and arithmetic for module 9, the tax compilation runs.
 *
 * Spec: docs/02-run-specifications.md Module 8 Tax Compilation, and
 * docs/05-decisions.md D4 for what the firm may and may not do.
 *
 * Two runs live on top of this file. TAX-BUILD-1099 compiles the reportable
 * payee data set for a calendar year, and TAX-TRACK-W9 tracks the collection
 * state of the paperwork behind it. Neither one issues a form, files a return,
 * enrolls in a transmission system, contacts a payee, or signs anything. The
 * output is a data set a CPA reads before they file, which is exactly what D4
 * says the firm's role is.
 *
 * Five things live here rather than in the two run files.
 *
 * 1. One read. loadTaxData reads the close data set once for the December
 *    period of the year, adds the whole calendar year of transactions, the
 *    vendors, the categories, the document requests, and whatever tax rows
 *    already exist. A run that reads the same table twice can see two answers.
 *
 * 2. One threshold lookup. Doc 02 rule 1 says the threshold is read from a
 *    dated configuration row and never from a constant, because the figure
 *    changed. Payments dated before January 1, 2026 use 600 dollars and
 *    payments on or after use 2,000 dollars, following section 70433 of the One
 *    Big Beautiful Bill Act. A year with no covering row is a hard block rather
 *    than a default, because a compiled set measured against a guessed
 *    threshold is worse than no set at all.
 *
 * 3. One aggregation. Payments are aggregated per payee per calendar year
 *    across every category and every funding account, because the threshold is
 *    a payee level test and not a box level one.
 *
 * 4. One exclusion vocabulary. Card and processor settled payments, corporation
 *    payees, the attorney exception, class none categories, and held payees
 *    with no W-9. Every exclusion is a stored fact and never an inference from
 *    a name.
 *
 * 5. One scope discriminator, shared with module 8 reporting: the period, the
 *    ledger fingerprint, and the run type. A posting inside the year has to
 *    produce a fresh data set rather than a stale deduplication hit.
 *
 * CONSTRAINT. No model, no score, no learned parameter, and no string distance
 * anywhere in this module. Whether a payee is a corporation is read from the
 * vendor entity type a person recorded off the W-9. The codebase never guesses
 * an entity from a name, because a payee called something ending in Inc may be
 * a sole proprietor and a partnership may not say so at all.
 *
 * PRIVACY. Only the last four digits of a taxpayer identification number are
 * ever read, stored, compiled, or narrated. There is no column anywhere in the
 * schema that can hold more than four digits of one, which is what makes the
 * rule enforceable rather than aspirational.
 */

import type { Cents, Ulid } from "../contract";
import type { RunTx } from "../db";
import { canonicalJson, sha256Hex } from "../ids";
import type {
  CategoryRow,
  DocumentRequestRow,
  TaxDataLineRow,
  TaxDataSetRow,
  TaxThresholdRow,
  TransactionRow,
  VendorRow,
  W9StateRow,
  W9StatusCode,
} from "../tables";
import { ZERO, loadCloseData, type CloseData } from "./close-shared";
import { checksumOf, retentionUntil } from "./rpt-shared";

export { checksumOf, retentionUntil };

/**
 * The compliance banner, stated once so the two run files and the handoff run
 * carry the same words rather than three paraphrases of them.
 */
export const COMPILATION_ONLY_BANNER =
  "Ledger Legends is not a CPA firm. This run compiles data. It does not " +
  "file, issue, submit, or transmit any tax document. The compiled data set " +
  "is provided to the client's CPA for filing.";

/**
 * Doc 02 TAX-BUILD-1099 rule 6. A payee at or above this share of the
 * threshold, and still under it, is listed so the firm can chase the W-9 before
 * December rather than in January. Such a payee never appears in a reportable
 * set.
 */
export const APPROACHING_NUMERATOR = 80n;
export const APPROACHING_DENOMINATOR = 100n;

/** Doc 02 TAX-TRACK-W9 rule 3. A request older than this escalates once. */
export const W9_ESCALATION_DAYS = 10;

/** The four boxes this codebase compiles into, and nothing else. */
export type BoxCode = "NEC-1" | "MISC-1" | "MISC-3" | "MISC-10";

/** The reportable classes. A class none category is not one of them. */
export type ReportableClass = "nec" | "attorney" | "misc_rent" | "misc_other";

export interface BoxRoute {
  formCode: "1099-NEC" | "1099-MISC";
  boxCode: BoxCode;
}

/**
 * Where a class lands.
 *
 * Doc 02 module 8 rule 4. Non employee compensation goes to box 1 of the NEC.
 * Rent goes to box 1 of the MISC and other reportable payments to box 3.
 * Attorney fees go to the NEC and gross proceeds paid to an attorney go to box
 * 10 of the MISC, which is the reason the attorney class is separate from the
 * others rather than folded into non employee compensation.
 */
export function routeFor(cls: ReportableClass): BoxRoute {
  switch (cls) {
    case "nec":
      return { formCode: "1099-NEC", boxCode: "NEC-1" };
    case "attorney":
      return { formCode: "1099-NEC", boxCode: "NEC-1" };
    case "misc_rent":
      return { formCode: "1099-MISC", boxCode: "MISC-1" };
    case "misc_other":
      return { formCode: "1099-MISC", boxCode: "MISC-3" };
  }
}

/**
 * The entity types a 1099 is not issued to.
 *
 * A C corporation and an S corporation are excluded, and so is a government
 * body and a tax exempt organization. Unknown is not on the list, because an
 * unknown entity means nobody has told us yet and excluding on that basis would
 * quietly drop a payee who should be reported.
 */
export function isExcludedEntity(entityType: VendorRow["entityType"]): boolean {
  return (
    entityType === "c_corporation" ||
    entityType === "s_corporation" ||
    entityType === "government" ||
    entityType === "tax_exempt"
  );
}

/**
 * The exception that survives incorporation.
 *
 * An attorney is reportable whether or not the practice is incorporated, which
 * is why the class carries its own name in the chart rather than sitting inside
 * non employee compensation. Medical and health care payments have the same
 * treatment and the chart records them under the same class, per doc 01.
 */
export function attorneyExceptionApplies(cls: ReportableClass): boolean {
  return cls === "attorney";
}

/** The calendar year window a data set covers. Doc 02 rule 2. */
export interface YearWindow {
  taxYear: number;
  yearStart: string;
  yearEnd: string;
}

export function yearWindowOf(taxYear: number): YearWindow {
  const y = String(taxYear).padStart(4, "0");
  return { taxYear, yearStart: `${y}-01-01`, yearEnd: `${y}-12-31` };
}

/**
 * The threshold row covering a year, or null.
 *
 * The lookup uses January 1 of the year and never the day the run executes, so
 * recompiling 2025 in 2027 still produces 2025 behavior. Null is returned
 * rather than a default, and the run turns that into a hard block.
 */
export function thresholdFor(
  rows: readonly TaxThresholdRow[],
  window: YearWindow,
): TaxThresholdRow | null {
  for (const row of rows) {
    if (row.formFamily !== "1099") continue;
    if (row.effectiveFrom > window.yearStart) continue;
    if (row.effectiveTo !== null && row.effectiveTo < window.yearStart) continue;
    return row;
  }
  return null;
}

/** Everything module 9 reads, read once. */
export interface TaxData {
  close: CloseData;
  firmId: Ulid;
  clientId: Ulid;
  window: YearWindow;
  /** December of the year, which is the period the ledger figures come from. */
  periodStart: string;
  periodEnd: string;
  thresholds: readonly TaxThresholdRow[];
  vendors: readonly VendorRow[];
  categories: readonly CategoryRow[];
  requests: readonly DocumentRequestRow[];
  /** Every transaction dated inside the calendar year, overridden ones included. */
  yearTransactions: readonly TransactionRow[];
  dataSets: readonly TaxDataSetRow[];
  w9States: readonly W9StateRow[];
  /** Bank account kind by id. A card payment is reportable by the processor. */
  bankKindById: Map<string, "bank" | "card">;
  /** Hash of the ledger rows inside the year. Part of every scope hash here. */
  fingerprint: string;
}

export async function loadTaxData(
  tx: RunTx,
  firmId: Ulid,
  clientId: Ulid,
  taxYear: number,
): Promise<TaxData> {
  const window = yearWindowOf(taxYear);
  // December of the year. The ledger figures a compiled set quotes are the ones
  // through the end of the year, and the close data loader is keyed by period.
  const close = await loadCloseData(tx, firmId, clientId, window.yearEnd);
  const key = { firmId, clientId };
  const thresholds = await tx.query("tax_thresholds_for_firm", { firmId });
  const vendors = await tx.query("vendors_for_client", key);
  const categories = await tx.query("categories_for_client", key);
  const requests = await tx.query("document_requests_for_client", key);
  const yearTransactions = await tx.query("transactions_in_window", {
    ...key,
    from: window.yearStart,
    to: window.yearEnd,
    bankAccountIds: null,
    // Overridden rows are read, because a payment a person recoded by hand is
    // still a payment and leaving it out would understate the payee. Nothing
    // here writes to a transaction, so reading one is not a write.
    includeOverridden: true,
  });
  const dataSets = await tx.query("tax_data_sets_for_client", key);
  const w9States = await tx.query("w9_states_for_client", key);

  const bankKindById = new Map<string, "bank" | "card">();
  for (const account of close.bankAccounts) {
    bankKindById.set(account.id, account.kind);
  }

  return {
    close,
    firmId,
    clientId,
    window,
    periodStart: close.periodStart,
    periodEnd: close.periodEnd,
    thresholds,
    vendors,
    categories,
    requests,
    yearTransactions,
    dataSets,
    w9States,
    bankKindById,
    fingerprint: yearFingerprint(close, window),
  };
}

/**
 * The ledger fingerprint of a whole calendar year.
 *
 * The close data loader computes a fingerprint for its period, which is one
 * month. A data set that covers a year has to change when anything anywhere in
 * that year changes, so the fingerprint is recomputed over the year window from
 * the same entries and lines.
 */
export function yearFingerprint(close: CloseData, window: YearWindow): string {
  const ids = close.entries
    .filter((e) => e.entryDate >= window.yearStart && e.entryDate <= window.yearEnd)
    .map((e) => e.id)
    .sort();
  const set = new Set(ids);
  const lineParts = close.lines
    .filter((l) => set.has(l.entryId))
    .map((l) => `${l.entryId}:${l.accountNumber}:${l.amountCents.toString()}`)
    .sort();
  return sha256Hex(canonicalJson({ year: window.taxYear, entries: ids, lines: lineParts }));
}

/** One payee's year, aggregated. */
export interface PayeeTotals {
  vendor: VendorRow;
  /** Reportable cents by class, positive magnitudes. */
  byClass: Map<ReportableClass, Cents>;
  /** Payments the processor reports on a 1099-K instead of us. */
  cardCents: Cents;
  /** Payments in class none categories, which are not reportable at all. */
  classNoneCents: Cents;
  /** The aggregate reportable total the threshold is measured against. */
  totalCents: Cents;
  /** Every category class seen, for the reason string. */
  classesSeen: readonly ReportableClass[];
}

/**
 * Aggregate the year, payee by payee.
 *
 * Money out of an account is negative in this ledger, so a payment is a
 * negative amount and its magnitude is what a 1099 states. A deposit or a
 * refund from the payee is a positive amount and it nets against the year,
 * because what a payee was paid over a year is the net of what went out and
 * what came back.
 *
 * Iteration is payee name ascending then payee id ascending, per doc 02 rule 8,
 * so the derived ordinals are the same on every execution.
 */
export function aggregatePayees(data: TaxData): PayeeTotals[] {
  const categoryById = new Map<string, CategoryRow>(
    data.categories.map((c) => [c.id, c]),
  );
  const vendorById = new Map<string, VendorRow>(data.vendors.map((v) => [v.id, v]));
  const totals = new Map<string, PayeeTotals>();

  for (const txn of data.yearTransactions) {
    if (txn.vendorId === null) continue;
    if (txn.voided) continue;
    if (txn.status === "reversed") continue;
    const vendor = vendorById.get(txn.vendorId);
    if (vendor === undefined) continue;
    const entry = totals.get(vendor.id) ?? {
      vendor,
      byClass: new Map<ReportableClass, Cents>(),
      cardCents: ZERO,
      classNoneCents: ZERO,
      totalCents: ZERO,
      classesSeen: [],
    };
    // A payment is money out, which is a negative amount. The magnitude is what
    // gets reported, so the sign is flipped once here and never again.
    const magnitude = -txn.amountCents;
    const category = txn.categoryId === null ? undefined : categoryById.get(txn.categoryId);
    const cls = category === undefined ? "none" : category.class1099;

    /*
     * Doc 02 rule 3. A payment made by card, or settled by a third party
     * processor, is reported by that processor on a 1099-K and would be
     * reported twice if it were also compiled here. The test is the stored
     * funding account kind and the stored settlement flag, never an inference
     * from a description.
     */
    const kind = data.bankKindById.get(txn.bankAccountId);
    if (kind === "card" || txn.isProcessorSettlement) {
      entry.cardCents += magnitude;
      totals.set(vendor.id, entry);
      continue;
    }

    if (cls === "none") {
      entry.classNoneCents += magnitude;
      totals.set(vendor.id, entry);
      continue;
    }

    const prior = entry.byClass.get(cls) ?? ZERO;
    entry.byClass.set(cls, prior + magnitude);
    entry.totalCents += magnitude;
    if (!entry.classesSeen.includes(cls)) {
      entry.classesSeen = [...entry.classesSeen, cls].sort();
    }
    totals.set(vendor.id, entry);
  }

  return [...totals.values()].sort(comparePayees);
}

/** Doc 02 rule 8. Payee name ascending, then payee id ascending. */
export function comparePayees(a: PayeeTotals, b: PayeeTotals): number {
  if (a.vendor.legalName !== b.vendor.legalName) {
    return a.vendor.legalName < b.vendor.legalName ? -1 : 1;
  }
  return a.vendor.id < b.vendor.id ? -1 : a.vendor.id > b.vendor.id ? 1 : 0;
}

/** At or above the threshold. Inclusive, per doc 02 rule 1. */
export function meetsThreshold(totalCents: Cents, thresholdCents: Cents): boolean {
  return totalCents >= thresholdCents;
}

/** At or above eighty percent of the threshold and still under it. */
export function isApproaching(totalCents: Cents, thresholdCents: Cents): boolean {
  if (totalCents >= thresholdCents) return false;
  return totalCents * APPROACHING_DENOMINATOR >= thresholdCents * APPROACHING_NUMERATOR;
}

/**
 * The W-9 status of one vendor, as of a day.
 *
 * The five values are ordered by severity in doc 02 TAX-TRACK-W9 rule 1 and the
 * first one that matches wins. On file and complete means a current form with a
 * taxpayer identification number. On file and incomplete means a form with no
 * number on it, which is worth naming separately because it looks satisfied in
 * a folder and is not. An expired form is not on file.
 */
export function w9StatusOf(
  vendor: VendorRow,
  request: DocumentRequestRow | undefined,
  asOfDate: string,
): W9StatusCode {
  const expired = vendor.w9ExpiresOn !== null && vendor.w9ExpiresOn <= asOfDate;
  if (vendor.w9OnFile && !expired) {
    return vendor.tinLast4 === null ? "on_file_incomplete" : "on_file_complete";
  }
  if (request !== undefined && request.status === "open") {
    return request.agingDays > W9_ESCALATION_DAYS
      ? "requested_overdue"
      : "requested_pending";
  }
  return "missing";
}

/** The collection stage the brief names, which is a different question. */
export function w9StageOf(
  vendor: VendorRow,
  request: DocumentRequestRow | undefined,
  asOfDate: string,
): W9StateRow["state"] {
  const expired = vendor.w9ExpiresOn !== null && vendor.w9ExpiresOn <= asOfDate;
  if (vendor.w9OnFile && expired) return "expired";
  if (vendor.w9OnFile) return "on_file";
  if (request !== undefined && request.status === "satisfied") return "received";
  if (request !== undefined && request.status === "open") return "requested";
  return "not_requested";
}

/** Severity order for iteration. Doc 02 rule 6, worst first. */
export const W9_SEVERITY: readonly W9StatusCode[] = [
  "missing",
  "requested_overdue",
  "requested_pending",
  "on_file_incomplete",
  "on_file_complete",
];

export function severityOf(code: W9StatusCode): number {
  const index = W9_SEVERITY.indexOf(code);
  return index < 0 ? W9_SEVERITY.length : index;
}

/**
 * Backup withholding, as a flag and never as an act.
 *
 * The condition is a reportable payee at or above the threshold with no
 * complete W-9 behind them. This codebase withholds nothing, remits nothing,
 * and computes no rate. The flag exists so the CPA and the client see the
 * exposure while there is still time to collect the form.
 */
export function backupWithholdingFlag(
  status: W9StatusCode,
  meets: boolean,
): boolean {
  return meets && status !== "on_file_complete";
}

/** Cents as a decimal string, for a jsonb snapshot that cannot hold a bigint. */
export function centsText(value: Cents): string {
  return value.toString();
}

/** Lines under one data set, for a rerun comparison. */
export function lineIndex(
  lines: readonly TaxDataLineRow[],
): Map<string, TaxDataLineRow> {
  return new Map(lines.map((l) => [l.id, l]));
}
