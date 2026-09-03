/**
 * The run registry. One entry per implemented run type.
 *
 * The 49 run types in the contract are the target. Fourteen are implemented so
 * far. IMPORT-PARSE-FEED and IMPORT-COMMIT-BATCH are the front door: nothing the
 * other runs read exists until a feed has been parsed and a batch committed. The
 * nine module 2 coding runs then take the register from a raw descriptor to a
 * coded row, and the order they appear in below is the order doc 02 Part B
 * requires. CODING_CASCADE_ORDER is the machine readable form of that order, and
 * the registry exists so triggering, sequences, and the undo runner never need to
 * import a run module directly.
 */

import type { Proposal, Run } from "./contract";
import { importCommitBatch } from "./runs/import-commit-batch";
import { perAmortizePrepaids } from "./runs/per-amortize-prepaids";
import { perPostAccruals } from "./runs/per-post-accruals";
import { perPostDepreciation } from "./runs/per-post-depreciation";
import { perPostRecurring } from "./runs/per-post-recurring";
import { perReverseAccruals } from "./runs/per-reverse-accruals";
import { perSplitLoan } from "./runs/per-split-loan";
import { importParseFeed } from "./runs/import-parse-feed";
import { recClearMatched } from "./runs/rec-clear-matched";
import { recFlagStale } from "./runs/rec-flag-stale";
import { recMatchTiered } from "./runs/rec-match-tiered";
import { txnApplyRecurring } from "./runs/txn-apply-recurring";
import { txnApplyRules } from "./runs/txn-apply-rules";
import { txnApplyVendorDefaults } from "./runs/txn-apply-vendordefaults";
import { txnDetectDuplicates } from "./runs/txn-detect-duplicates";
import { txnMapBankCodes } from "./runs/txn-map-bankcodes";
import { txnNormalizeVendors } from "./runs/txn-normalize-vendors";
import { txnPairTransfers } from "./runs/txn-pair-transfers";
import { txnSplitSettlements } from "./runs/txn-split-settlements";
import { txnSweepSuspense } from "./runs/txn-sweep-suspense";

/** Scope types differ per run, so the registry stores erased entries. */
export interface RegistryEntry {
  type: string;
  version: number;
  writesLedger: boolean;
  run: Run<never, Proposal>;
}

function entry<S>(run: Run<S, Proposal>): RegistryEntry {
  return {
    type: run.type,
    version: run.version,
    writesLedger: run.writesLedger,
    run: run as unknown as Run<never, Proposal>,
  };
}

export const registry: readonly RegistryEntry[] = [
  entry(importParseFeed),
  entry(importCommitBatch),
  entry(txnNormalizeVendors),
  entry(txnDetectDuplicates),
  entry(txnPairTransfers),
  entry(txnSplitSettlements),
  entry(txnApplyRecurring),
  entry(txnApplyRules),
  entry(txnApplyVendorDefaults),
  entry(txnMapBankCodes),
  entry(txnSweepSuspense),
  // Module 3 reconciliation, in the only order they can run in: matching opens
  // the batch, clearing closes it with a difference, and stale flagging reports
  // on what clearing left outstanding.
  entry(recMatchTiered),
  entry(recClearMatched),
  entry(recFlagStale),
  // Module 4 period end, in the order doc 02 requires. Reversal comes first
  // because it belongs to the period being opened and clears last period's
  // accruals off the books before anything is added to this one.
  entry(perReverseAccruals),
  entry(perPostRecurring),
  entry(perAmortizePrepaids),
  entry(perSplitLoan),
  entry(perPostAccruals),
  entry(perPostDepreciation),
];

/**
 * Module 4 execution order.
 *
 * Reversal runs first. It undoes the accruals the previous period posted, and
 * running it after this period's accruals would leave two periods of the same
 * obligation on the books at once while the rest of the module computed against
 * them.
 *
 * Recurring, prepaids, and the loan split come next in any order among
 * themselves, since none reads what another writes. They are listed in the
 * order doc 02 lists them.
 *
 * Accruals run after the loan split so that the interest the split posted is
 * already on the books when the double count guard looks for it.
 *
 * Depreciation runs last because it is the one step that reads no other
 * subledger and produces no input for anything else in the module.
 */
export const PERIOD_END_ORDER: readonly string[] = [
  "PER-REVERSE-ACCRUALS",
  "PER-POST-RECURRING",
  "PER-AMORTIZE-PREPAID",
  "PER-SPLIT-LOANPAYMENT",
  "PER-POST-ACCRUALS",
  "PER-POST-DEPRECIATION",
];

/**
 * Module 3 execution order. Kept separate from the coding cascade because
 * reconciliation is not a coding step: it never decides what a row is, only
 * whether the bank has seen it.
 */
export const RECONCILIATION_ORDER: readonly string[] = [
  "REC-MATCH-TIERED",
  "REC-CLEAR-MATCHED",
  "REC-FLAG-STALE",
];

/**
 * The module 2 execution order from doc 02 Part B. Every dependency in the
 * cascade points backwards, so this list is the whole ordering contract:
 * normalization before anything that reads a vendor key, duplicate detection
 * before anything that codes, transfer pairing before rules so a rule can never
 * recode one leg of a transfer, settlement splitting and templates before rules
 * because both are stronger evidence than a rule, rules before vendor defaults,
 * vendor defaults before bank codes, and the suspense sweep last so no row can
 * finish the cascade with a null category.
 */
export const CODING_CASCADE_ORDER: readonly string[] = [
  "TXN-NORMALIZE-VENDORS",
  "TXN-DETECT-DUPLICATES",
  "TXN-PAIR-TRANSFERS",
  "TXN-SPLIT-SETTLEMENTS",
  "TXN-APPLY-RECURRING",
  "TXN-APPLY-RULES",
  "TXN-APPLY-VENDORDEFAULTS",
  "TXN-MAP-BANKCODES",
  "TXN-SWEEP-SUSPENSE",
];

/** Position of a run in the cascade, or null when it is not a coding run. */
export function cascadePosition(type: string): number | null {
  const at = CODING_CASCADE_ORDER.indexOf(type);
  return at === -1 ? null : at;
}

export function lookupRun(type: string): RegistryEntry | null {
  for (const e of registry) if (e.type === type) return e;
  return null;
}
