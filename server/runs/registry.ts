/**
 * The run registry. One entry per implemented run type.
 *
 * The 49 run types in the contract are the target. Forty one are implemented so
 * far. IMPORT-PARSE-FEED and IMPORT-COMMIT-BATCH are the front door: nothing the
 * other runs read exists until a feed has been parsed and a batch committed. The
 * nine module 2 coding runs then take the register from a raw descriptor to a
 * coded row, and the order they appear in below is the order doc 02 Part B
 * requires. CODING_CASCADE_ORDER is the machine readable form of that order, and
 * the registry exists so triggering, sequences, and the undo runner never need to
 * import a run module directly.
 */

import type { Proposal, Run } from "./contract";
import { apApplyEarlyDiscount } from "./runs/ap-apply-earlydiscount";
import { cpaBuildHandoff } from "./runs/cpa-build-handoff";
import { offboardBuildExport } from "./runs/offboard-build-export";
import { payApproveRun } from "./runs/pay-approve-run";
import { payPostRegister } from "./runs/pay-post-register";
import { prcEscalateOverdue } from "./runs/prc-escalate-overdue";
import { prcGenerateWork } from "./runs/prc-generate-work";
import { prcNudgeRequests } from "./runs/prc-nudge-requests";
import { taxBuild1099 } from "./runs/tax-build-1099";
import { w9Track } from "./runs/w9-track";
import { arApplyPayments } from "./runs/ar-apply-payments";
import { arBuildStatements } from "./runs/ar-build-statements";
import { arChargeLateFees } from "./runs/ar-charge-latefees";
import { arapRefreshAging } from "./runs/ar-refresh-aging";
import { arWriteoffUncollectible } from "./runs/ar-writeoff-uncollectible";
import { clsEvaluateGates } from "./runs/cls-evaluate-gates";
import { clsLockPeriod } from "./runs/cls-lock-period";
import { clsPostYearEnd } from "./runs/cls-post-yearend";
import { rptBuildPackage } from "./runs/rpt-build-package";
import { rptFlagVariances } from "./runs/rpt-flag-variances";
import { rptRebuildForecast } from "./runs/rpt-rebuild-forecast";
import { rptComposeNarrative } from "./runs/rpt-compose-narrative";
import { clsRollForward } from "./runs/cls-roll-forward";
import { importCommitBatch } from "./runs/import-commit-batch";
import { perAmortizePrepaids } from "./runs/per-amortize-prepaids";
import { perPostAccruals } from "./runs/per-post-accruals";
import { perPostDepreciation } from "./runs/per-post-depreciation";
import { perPostRecurring } from "./runs/per-post-recurring";
import { perReverseAccruals } from "./runs/per-reverse-accruals";
import { perSplitLoan } from "./runs/per-split-loan";
import { importParseFeed } from "./runs/import-parse-feed";
import { recClearMatched } from "./runs/rec-clear-matched";
import { subRaiseRequests } from "./runs/sub-raise-requests";
import { subTieBalances } from "./runs/sub-tie-balances";
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
  // Module 5 AR and AP, in the order AR_AP_ORDER explains.
  entry(arApplyPayments),
  entry(apApplyEarlyDiscount),
  entry(arChargeLateFees),
  entry(arWriteoffUncollectible),
  entry(arapRefreshAging),
  entry(arBuildStatements),
  // Module 6 substantiation and close, in the order CLOSE_ORDER explains.
  entry(subTieBalances),
  entry(subRaiseRequests),
  entry(clsEvaluateGates),
  entry(clsLockPeriod),
  entry(clsRollForward),
  entry(clsPostYearEnd),
  // Module 8 reporting, in the order REPORTING_ORDER explains.
  entry(rptBuildPackage),
  entry(rptFlagVariances),
  entry(rptRebuildForecast),
  entry(rptComposeNarrative),
  // Module 9 tax compilation. Both runs compile. Neither issues, files,
  // submits, or transmits anything, and neither contacts a payee.
  entry(taxBuild1099),
  entry(w9Track),
  // Module 10 practice management, in the order PRACTICE_ORDER explains.
  entry(prcGenerateWork),
  entry(prcEscalateOverdue),
  entry(prcNudgeRequests),
  // D5 payroll. Approval is review and posting is bookkeeping. Neither one
  // disburses, and the constraint on the row says so in the database.
  entry(payApproveRun),
  entry(payPostRegister),
  // D5 and D9 deliverables. Both build an archive into the vault and neither
  // sends anything anywhere.
  entry(cpaBuildHandoff),
  entry(offboardBuildExport),
];

/**
 * Module 9 execution order.
 *
 * W-9 tracking comes first, because the 1099 compilation reads the W-9 status
 * of every payee to decide whether the backup withholding flag belongs on the
 * line. Compiling first and tracking second would produce a data set whose
 * flags describe the paperwork as it was before the run that refreshed it.
 */
export const TAX_ORDER: readonly string[] = ["TAX-TRACK-W9", "TAX-BUILD-1099"];

/**
 * Module 10 execution order.
 *
 * Generation comes first because there is nothing to escalate until the
 * workload exists. Escalation comes second. Nudging is last and independent of
 * the first two, placed here because a document request that a nudge is about
 * is usually the thing blocking a task the escalation just fired on, and
 * reading the escalations before deciding what to chase is the useful order.
 */
export const PRACTICE_ORDER: readonly string[] = [
  "PRAC-GENERATE-TASKS",
  "PRAC-ESCALATE-OVERDUE",
  "PRAC-NUDGE-REQUESTS",
];

/**
 * The deliverable order.
 *
 * Payroll approval before payroll posting, because posting refuses without an
 * approved run. The 1099 compilation before the CPA handoff, because the
 * handoff attaches the data set the compilation produced and will not build one
 * itself. The offboarding export last, because it is the only one that covers
 * the whole history and should see everything the others wrote.
 */
export const DELIVERABLE_ORDER: readonly string[] = [
  "PAY-APPROVE-RUN",
  "PAY-POST-REGISTER",
  "TAX-BUILD-1099",
  "CPA-BUILD-HANDOFF",
  "OFFBOARD-BUILD-EXPORT",
];

/**
 * Module 8 execution order.
 *
 * The package comes first because it is the snapshot every later step describes.
 * Variances come second, because a flag is a comparison against figures the
 * package already fixed. The forecast is third and independent of the first two,
 * placed here because the narrative reads it. The narrative is last, always, for
 * one reason: it is a description of what the other three found, so composing it
 * earlier would describe a state that no longer exists by the time a reader sees
 * it.
 */
export const REPORTING_ORDER: readonly string[] = [
  "RPT-BUILD-PACKAGE",
  "RPT-FLAG-VARIANCES",
  "RPT-REBUILD-FORECAST",
  "RPT-COMPOSE-NARRATIVE",
];

/**
 * Module 6 execution order.
 *
 * Tie outs come first because every later step reads them. A gate that asks
 * whether the AR subledger equals its control account is answering a question
 * the tie out already computed, and a request raised for an unresolved variance
 * cannot be raised before the variance exists.
 *
 * Requests come second so that the open items a close is waiting on are on
 * record before the gates report the period as blocked. The list of who owes
 * what is the useful half of a failed close.
 *
 * Gates come third, the lock fourth, and the lock refuses when the gates it
 * reads are not all pass or not applicable.
 *
 * Roll forward and the year end close come after the lock because both write
 * into the period that follows, and the figure they carry forward is only
 * settled once the period behind them is closed.
 */
export const CLOSE_ORDER: readonly string[] = [
  "SUB-TIEOUT-ACCOUNTS",
  "SUB-RAISE-REQUESTS",
  "CLOSE-CHECK-GATES",
  "CLOSE-LOCK-PERIOD",
  "CLOSE-ROLL-FORWARD",
  "CLOSE-POST-YEAREND",
];

/**
 * Module 5 execution order.
 *
 * Cash first. Applying payments is the only step that reduces what a customer
 * actually owes, and every step after it reads that balance. Charging a late
 * fee on an invoice that was paid last week, or writing off a balance the
 * customer already settled, are both consequences of running the cash step
 * late.
 *
 * The payable discount sits next to it for the same reason on the other side:
 * it settles bills and moves the payable balance, and nothing later in the
 * module reads it.
 *
 * Late fees come before write offs so that a fee prepared this period is
 * visible to the write off review rather than appearing after a balance was
 * already judged uncollectible.
 *
 * Aging is second to last because it is a measurement. It reports the state the
 * earlier steps left, and running it first would report a state that no longer
 * exists by the time the module finishes.
 *
 * Statements run last because a statement is a rendering of the aging and of
 * everything above it. A statement built before the cash was applied would show
 * a customer a balance the client's own books disagree with.
 */
export const AR_AP_ORDER: readonly string[] = [
  "AR-APPLY-PAYMENTS",
  "AP-APPLY-DISCOUNTS",
  "AR-CHARGE-LATEFEES",
  "AR-WRITEOFF-UNCOLLECTIBLE",
  "ARAP-REFRESH-AGING",
  "AR-BUILD-STATEMENTS",
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
