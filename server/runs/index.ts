/**
 * The run framework, the contract all 49 automation runs plug into.
 *
 * Read docs/03-run-framework.md first. The short version:
 *   execute() is the only entry point, and preview is apply with the commit
 *   removed. There is no second code path.
 *   Every candidate lands in exactly one of proposals, skips, or errors, and
 *   apply refuses to start when any error exists.
 *   A run may never write over a row carrying the manual override flag.
 *   Money is bigint cents. Ids are ULIDs. The run log is insert only.
 */

export * from "./contract";
export * from "./tables";
export * from "./db";
export * from "./db-memory";
export * from "./db-postgres";
export * from "./dates";
export * from "./ids";
export * from "./apply-writer";
export * from "./run-log";
export * from "./execute";
export * from "./undo";
export * from "./sequence";
export { txnPairTransfers } from "./runs/txn-pair-transfers";
export type { PairTransfersScope } from "./runs/txn-pair-transfers";
export * from "./runs/import-parse-feed";
export * from "./runs/import-commit-batch";
export * from "./runs/coding-cascade";
export * from "./runs/txn-normalize-vendors";
export * from "./runs/txn-detect-duplicates";
export * from "./runs/txn-split-settlements";
export * from "./runs/txn-apply-recurring";
export * from "./runs/txn-apply-rules";
export * from "./runs/txn-apply-vendordefaults";
export * from "./runs/txn-map-bankcodes";
export * from "./runs/txn-sweep-suspense";
export * from "./runs/rec-shared";
export * from "./runs/rec-match-tiered";
export * from "./runs/rec-clear-matched";
export * from "./runs/rec-flag-stale";
export * from "./runs/arap-shared";
export * from "./runs/ar-refresh-aging";
export * from "./runs/ar-build-statements";
export * from "./runs/ar-apply-payments";
export * from "./runs/ar-charge-latefees";
export * from "./runs/ap-apply-earlydiscount";
export * from "./runs/ar-writeoff-uncollectible";
export * from "./runs/close-shared";
export * from "./runs/sub-tie-balances";
export * from "./runs/sub-raise-requests";
export * from "./runs/cls-evaluate-gates";
export * from "./runs/cls-lock-period";
export * from "./runs/cls-roll-forward";
export * from "./runs/cls-post-yearend";
export * from "./runs/rpt-shared";
export * from "./runs/rpt-build-package";
export * from "./runs/rpt-flag-variances";
export * from "./runs/rpt-rebuild-forecast";
export * from "./runs/rpt-compose-narrative";
export {
  registry,
  lookupRun,
  AR_AP_ORDER,
  CLOSE_ORDER,
  CODING_CASCADE_ORDER,
  RECONCILIATION_ORDER,
  REPORTING_ORDER,
  cascadePosition,
} from "./registry";
