/**
 * The run registry. One entry per implemented run type.
 *
 * The 49 run types doc 02 and doc 05 name are the original target, and all 49
 * are implemented. Thirteen more sit beside them: SETUP-ADD-BANK-ACCOUNT,
 * AR-CREATE-CUSTOMER, AR-CREATE-INVOICE, REC-IMPORT-STATEMENT,
 * AP-CREATE-VENDOR, AP-CREATE-BILL, AR-RECORD-PAYMENT, AR-CREATE-CREDITMEMO,
 * TXN-POST-CODED, IMPORT-FLAG-MAPPING-NEEDED, IMPORT-REJECT-BATCH,
 * PER-DISPOSE-ASSET, and IMPORT-REVIEW-STAGED-ROW, none of which the
 * original modules ever specified,
 * because module 1 setup, module 5, and module 3 were all written assuming a
 * bank account, a customer, an invoice, a bank statement's lines, a vendor, a
 * bill, a received payment, or a credit memo already existed on the books by
 * the time their own runs read them. Eight of the nine put the first row of
 * something on the books, in the same insert-only, run-framework shape as
 * everything around them. TXN-POST-CODED is the ninth and the deepest: module
 * 2 never had a missing row, it had a missing posting -- migration 0011 says
 * a register row becomes accounting when its journal_entry_id is filled in,
 * and nothing in the documented nine coding runs ever filled it in for a row
 * resolved only by a rule, a vendor default, or a bank code. IMPORT-FLAG-MAPPING-NEEDED
 * is the tenth and a different shape of gap again: IMPORT-PARSE-FEED already
 * refused a file with no mapping profile or a header that did not match one,
 * correctly, but nothing ever wrote that refusal down anywhere a bookkeeper
 * would see it. This run is what the upload route calls when that happens.
 * IMPORT-REJECT-BATCH is the eleventh: import.batches has carried a rejected
 * status and a reason column since migration 0009, and nothing ever wrote
 * either, so a bookkeeper who decided a staged statement was the wrong
 * account had no way to take it off the list. PER-DISPOSE-ASSET is the
 * twelfth: subledger.fixed_assets has carried disposed_on, disposal_entry_id,
 * and disposal_proceeds_cents, plus a check constraint requiring the first
 * two whenever status is disposed, since the asset table was built, and
 * PER-POST-DEPRECIATION has always read disposed_on to stop depreciating an
 * asset once it leaves. Nothing ever wrote any of the three, so an asset sold
 * or scrapped had no way to leave the books at all. IMPORT-REVIEW-STAGED-ROW
 * is the thirteenth: import.staged_rows has carried review_state, reviewed_by,
 * and reviewed_at since migration 0009, and IMPORT-COMMIT-BATCH has always
 * refused to commit a row held for review until review_state reaches
 * accepted. Nothing ever moved it past pending, so a bank feed with no
 * transaction ids held every genuine repeat charge forever.
 *
 * SETUP-ADD-BANK-ACCOUNT comes first for the same reason: IMPORT-PARSE-FEED's
 * own scope requires an existing bankAccountId, and without this run nothing
 * downstream of it, including the whole of module 3, was reachable for any
 * client. IMPORT-PARSE-FEED and IMPORT-COMMIT-BATCH are the front door for the
 * register side: nothing the coding cascade reads exists until a feed has
 * been parsed and a batch committed. REC-IMPORT-STATEMENT is the equivalent
 * front door for the bank's own side, which the original 49 never built. The
 * ten module 2 coding runs then take the register from a raw descriptor to a
 * posted entry, and the order they appear in below is doc 02 Part B's order
 * plus TXN-POST-CODED at the end. CODING_CASCADE_ORDER is the machine readable
 * form of that order, and the registry exists so triggering, sequences, and
 * the undo runner never need to import a run module directly.
 */

import type { Proposal, Run } from "./contract";
import { apApplyEarlyDiscount } from "./runs/ap-apply-earlydiscount";
import { apCreateVendor } from "./runs/ap-create-vendor";
import { apCreateBill } from "./runs/ap-create-bill";
import { arCreateCustomer } from "./runs/ar-create-customer";
import { arCreateInvoice } from "./runs/ar-create-invoice";
import { arCreateCreditMemo } from "./runs/ar-create-creditmemo";
import { arRecordPayment } from "./runs/ar-record-payment";
import { recImportStatement } from "./runs/rec-import-statement";
import { cpaBuildHandoff } from "./runs/cpa-build-handoff";
import { offboardBuildExport } from "./runs/offboard-build-export";
import { payApproveRun } from "./runs/pay-approve-run";
import { payPostRegister } from "./runs/pay-post-register";
import { prcEscalateOverdue } from "./runs/prc-escalate-overdue";
import { prcGenerateWork } from "./runs/prc-generate-work";
import { prcNudgeRequests } from "./runs/prc-nudge-requests";
import { prcUpdateTask } from "./runs/prc-update-task";
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
import { intakeBuildChart } from "./runs/intake-build-chart";
import { intakeCreateClient } from "./runs/intake-create-client";
import { intakeActivateEngagement } from "./runs/intake-activate-engagement";
import { engSignLetter } from "./runs/eng-sign-letter";
import { engSetBillingStatus } from "./runs/eng-set-billing-status";
import { portalAnswerRequest } from "./runs/portal-answer-request";
import { portalPostMessage } from "./runs/portal-post-message";
import { docRecordUpload } from "./runs/doc-record-upload";
import { intakeSeedTasks } from "./runs/intake-seed-tasks";
import { intakeOpenRequests } from "./runs/intake-open-requests";
import { setupAddBankAccount } from "./runs/setup-add-bank-account";
import { setupImportBalances } from "./runs/setup-import-balances";
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
import { txnPostCoded } from "./runs/txn-post-coded";
import { importFlagMappingNeeded } from "./runs/import-flag-mapping-needed";
import { importRejectBatch } from "./runs/import-reject-batch";
import { importReviewStagedRow } from "./runs/import-review-staged-row";
import { perDisposeAsset } from "./runs/per-dispose-asset";
import { cfgEditCategory } from "./runs/cfg-edit-category";
import { cfgEditRule } from "./runs/cfg-edit-rule";
import { cfgEditMappingProfile } from "./runs/cfg-edit-mapping-profile";
import { cfgEditClientPolicy } from "./runs/cfg-edit-client-policy";

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
  // Module 1 intake and setup, in the order INTAKE_ORDER explains. These four
  // run once per client, at the moment the firm finishes the wizard, and every
  // other run in this list assumes they already did.
  entry(intakeCreateClient),
  entry(intakeActivateEngagement),
  entry(intakeBuildChart),
  entry(intakeSeedTasks),
  entry(intakeOpenRequests),
  // Firm set, manual, tenancy level. Not a module, not ledger affecting,
  // triggered from the client admin page rather than any pipeline.
  entry(engSetBillingStatus),
  // Portal screens, docs/11-api.md and migration 0028. Three runs a person
  // starts from the client plane, or from the firm plane for a reply.
  entry(portalAnswerRequest),
  entry(portalPostMessage),
  entry(docRecordUpload),
  entry(engSignLetter),
  entry(setupAddBankAccount),
  entry(setupImportBalances),
  entry(importParseFeed),
  entry(importCommitBatch),
  entry(importFlagMappingNeeded),
  entry(importRejectBatch),
  entry(importReviewStagedRow),
  entry(txnNormalizeVendors),
  entry(txnDetectDuplicates),
  entry(txnPairTransfers),
  entry(txnSplitSettlements),
  entry(txnApplyRecurring),
  entry(txnApplyRules),
  entry(txnApplyVendorDefaults),
  entry(txnMapBankCodes),
  entry(txnSweepSuspense),
  entry(txnPostCoded),
  // Module 3 reconciliation. REC-IMPORT-STATEMENT first: it is what puts the
  // bank's own lines on the books, the "statement has already been imported"
  // precondition the other three assume. Matching then opens the batch,
  // clearing closes it with a difference, and stale flagging reports on what
  // clearing left outstanding.
  entry(recImportStatement),
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
  entry(perDisposeAsset),
  // Module 5 AR and AP. AR-CREATE-CUSTOMER and AR-CREATE-INVOICE first: they
  // are what put a customer and a bill on the books, the precondition every
  // run below assumes. AP-CREATE-VENDOR and AP-CREATE-BILL do the identical
  // thing for the payable side, and AR-RECORD-PAYMENT puts the first received
  // payment on the books, the precondition AR-APPLY-PAYMENTS assumes. Then
  // AR_AP_ORDER explains the rest.
  entry(arCreateCustomer),
  entry(arCreateInvoice),
  entry(arCreateCreditMemo),
  entry(apCreateVendor),
  entry(apCreateBill),
  entry(arRecordPayment),
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
  entry(prcUpdateTask),
  // D5 payroll. Approval is review and posting is bookkeeping. Neither one
  // disburses, and the constraint on the row says so in the database.
  entry(payApproveRun),
  entry(payPostRegister),
  // D5 and D9 deliverables. Both build an archive into the vault and neither
  // sends anything anywhere.
  entry(cpaBuildHandoff),
  entry(offboardBuildExport),
  // Reference data edits, manual tier, triggered from a settings screen
  // rather than any pipeline. Not part of any module.
  entry(cfgEditCategory),
  entry(cfgEditRule),
  entry(cfgEditMappingProfile),
  entry(cfgEditClientPolicy),
];

/**
 * Module 1 execution order.
 *
 * The chart is first because everything else points at an account number. The
 * opening balance entry would have nowhere to post without it, and the run
 * refuses an account that is not on the chart rather than creating one.
 *
 * The task catalog is second. It is independent of the chart, and it sits here
 * because the first period's instances should exist before anybody looks at the
 * client, not because a later step needs them.
 *
 * The document requests are third, for the same reason.
 *
 * The opening balances are last, always. They are the only one of the four that
 * touches the ledger, so putting them at the end means a wizard finish that
 * fails on a trial balance that does not foot still leaves a client with a
 * chart, a workload, and its opening asks on record, rather than nothing.
 */
export const INTAKE_ORDER: readonly string[] = [
  "INTAKE-BUILD-CHART",
  "INTAKE-SEED-TASKS",
  "INTAKE-OPEN-REQUESTS",
  "SETUP-IMPORT-BALANCES",
];

/**
 * Module 9 execution order.
 *
 * W-9 tracking comes first, because the 1099 compilation reads the W-9 status
 * of every payee to decide whether the backup withholding flag belongs on the
 * line. Compiling first and tracking second would produce a data set whose
 * flags describe the paperwork as it was before the run that refreshed it.
 */
/**
 * The create client path the API runs. INTAKE-CREATE-CLIENT writes the client
 * and draft engagement rows first, then the three runs that need a client to
 * exist. Opening balances are not here: they come later, when the firm has a
 * trial balance, through SETUP-IMPORT-BALANCES on the client's run page.
 */
export const CLIENT_INTAKE_ORDER: readonly string[] = [
  "INTAKE-CREATE-CLIENT",
  ...INTAKE_ORDER.slice(0, 3),
];

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
 * The module 2 execution order from doc 02 Part B, with one addition at the
 * end. Every dependency in the cascade points backwards, so this list is the
 * whole ordering contract: normalization before anything that reads a vendor
 * key, duplicate detection before anything that codes, transfer pairing before
 * rules so a rule can never recode one leg of a transfer, settlement splitting
 * and templates before rules because both are stronger evidence than a rule,
 * rules before vendor defaults, vendor defaults before bank codes, and the
 * suspense sweep so no row can finish coded with a null category.
 *
 * TXN-POST-CODED runs last, after the sweep, because a row has to finish being
 * coded -- suspense included -- before anything can decide there is nothing
 * left of it to post. Doc 02 names nine runs here; this is the tenth, and the
 * one that posts a row the first nine only ever categorized.
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
  "TXN-POST-CODED",
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
