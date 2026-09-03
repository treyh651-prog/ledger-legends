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
export { registry, lookupRun } from "./registry";
