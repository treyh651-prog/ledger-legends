/**
 * The run registry. One entry per implemented run type.
 *
 * The 49 run types in the contract are the target. Three are implemented so
 * far. TXN-PAIR-TRANSFERS is the reference implementation that proves the
 * contract end to end. IMPORT-PARSE-FEED and IMPORT-COMMIT-BATCH are the front
 * door: nothing the other runs read exists until a feed has been parsed and a
 * batch committed. The registry exists so triggering, sequences, and the undo
 * runner never need to import a run module directly.
 */

import type { Proposal, Run } from "./contract";
import { importCommitBatch } from "./runs/import-commit-batch";
import { importParseFeed } from "./runs/import-parse-feed";
import { txnPairTransfers } from "./runs/txn-pair-transfers";

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
  entry(txnPairTransfers),
];

export function lookupRun(type: string): RegistryEntry | null {
  for (const e of registry) if (e.type === type) return e;
  return null;
}
