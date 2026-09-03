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
