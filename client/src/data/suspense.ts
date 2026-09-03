import { SUSPENSE_ACCOUNT_ID } from "./coa";

/**
 * Suspense reason codes, doc 00 Part 4.
 *
 * Every amount parked in account 1990 carries one of these. The code says why the
 * item could not be coded, who owns clearing it, what clears it, and how long it may
 * sit before it escalates. Gate G01 holds the close until 1990 is back at zero.
 */

export type SuspenseOwner = "Firm" | "Client" | "System";

export interface SuspenseReason {
  code: string;
  /** Plain English meaning, shown next to the code anywhere an item is listed. */
  meaning: string;
  owner: SuspenseOwner;
  resolution: string;
  escalateAfterDays: number;
}

export const SUSPENSE_REASONS: SuspenseReason[] = [
  { code: "SUS-01", meaning: "Unknown vendor, money out", owner: "Firm", resolution: "Create rule or vendor default", escalateAfterDays: 5 },
  { code: "SUS-02", meaning: "Unknown source, money in", owner: "Firm", resolution: "Identify deposit, create rule", escalateAfterDays: 5 },
  { code: "SUS-03", meaning: "Business purpose not determinable", owner: "Client", resolution: "Portal request with the transaction attached", escalateAfterDays: 7 },
  { code: "SUS-04", meaning: "Possible transfer, no single pair", owner: "Firm", resolution: "Confirm or reject the pairing", escalateAfterDays: 3 },
  { code: "SUS-05", meaning: "Possible duplicate", owner: "Firm", resolution: "Confirm duplicate and void, or mark legitimate repeat", escalateAfterDays: 3 },
  { code: "SUS-06", meaning: "Coding known, receipt missing over threshold", owner: "Client", resolution: "Portal request for the document", escalateAfterDays: 10 },
  { code: "SUS-07", meaning: "Mixed business and personal", owner: "Client", resolution: "Confirm the split percentage", escalateAfterDays: 7 },
  { code: "SUS-08", meaning: "Owner activity unclear, draw or reimbursement or loan", owner: "Client", resolution: "Confirm treatment", escalateAfterDays: 7 },
  { code: "SUS-09", meaning: "Over the capitalization threshold", owner: "Firm", resolution: "Route to fixed asset register or expense with reason", escalateAfterDays: 5 },
  { code: "SUS-10", meaning: "Sales tax treatment unclear", owner: "Firm", resolution: "Confirm taxability", escalateAfterDays: 5 },
  { code: "SUS-11", meaning: "Foreign currency, out of scope", owner: "Firm", resolution: "Manual entry with a stated rate", escalateAfterDays: 5 },
  { code: "SUS-12", meaning: "Processor gross and fee not yet settled", owner: "System", resolution: "Clears automatically when the settlement report arrives", escalateAfterDays: 10 },
  { code: "SUS-13", meaning: "Chargeback or reversal pending", owner: "Firm", resolution: "Link to the original transaction", escalateAfterDays: 10 },
  { code: "SUS-14", meaning: "Loan proceeds or repayment unclear", owner: "Client", resolution: "Confirm the instrument and provide the schedule", escalateAfterDays: 7 },
  { code: "SUS-15", meaning: "Grant or contribution restriction unknown", owner: "Client", resolution: "Confirm donor restriction", escalateAfterDays: 7 },
  { code: "SUS-16", meaning: "Intercompany, other side unconfirmed", owner: "Firm", resolution: "Confirm against the related entity's books", escalateAfterDays: 7 },
  { code: "SUS-17", meaning: "Amount does not agree to the supporting document", owner: "Firm", resolution: "Investigate the variance", escalateAfterDays: 5 },
  { code: "SUS-18", meaning: "Stale uncleared item", owner: "Firm", resolution: "Void, write off, or confirm still outstanding", escalateAfterDays: 30 },
  { code: "SUS-19", meaning: "Rule conflict", owner: "Firm", resolution: "Fix rule priority, then rerun", escalateAfterDays: 2 },
  { code: "SUS-20", meaning: "Dated in a locked period", owner: "Firm", resolution: "Post a correcting entry in an open period", escalateAfterDays: 5 },
];

export const SUSPENSE_REASON_BY_CODE: Record<string, SuspenseReason> = Object.fromEntries(
  SUSPENSE_REASONS.map((r) => [r.code, r]),
);

export function suspenseReason(code?: string): SuspenseReason | undefined {
  return code ? SUSPENSE_REASON_BY_CODE[code] : undefined;
}

/** "SUS-01 unknown vendor, money out" for one line of UI. */
export function suspenseReasonLabel(code?: string): string {
  const r = suspenseReason(code);
  if (!r) return "No reason code";
  return `${r.code} ${r.meaning.charAt(0).toLowerCase()}${r.meaning.slice(1)}`;
}

/** True when this account is the balance sheet suspense account. */
export function isSuspenseAccount(accountId: string): boolean {
  return accountId === SUSPENSE_ACCOUNT_ID;
}
