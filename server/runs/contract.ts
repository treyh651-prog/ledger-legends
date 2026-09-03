/**
 * The run contract, as specified in docs/03-run-framework.md Part 3.
 *
 * Money is bigint cents everywhere. Debit positive, credit negative.
 * Nothing in this file reaches a database. The port lives in db.ts.
 */

import type { ZodType } from "zod";
import type { RunDb, RunTx } from "./db";

export type Cents = bigint;
export type Ulid = string;

/**
 * All 49 run types. Doc 02 Part G lists 43 and doc 05 Part 8 appends 6 more,
 * so the union below is the authoritative set of 49.
 */
export type RunTypeId =
  // Intake and setup
  | "INTAKE-BUILD-CHART"
  | "INTAKE-SEED-TASKS"
  | "INTAKE-OPEN-REQUESTS"
  | "SETUP-IMPORT-BALANCES"
  // Transactions and coding
  | "TXN-NORMALIZE-VENDORS"
  | "TXN-DETECT-DUPLICATES"
  | "TXN-PAIR-TRANSFERS"
  | "TXN-SPLIT-SETTLEMENTS"
  | "TXN-APPLY-RECURRING"
  | "TXN-APPLY-RULES"
  | "TXN-APPLY-VENDORDEFAULTS"
  | "TXN-MAP-BANKCODES"
  | "TXN-SWEEP-SUSPENSE"
  // Reconciliation
  | "REC-MATCH-TIERED"
  | "REC-CLEAR-MATCHED"
  | "REC-FLAG-STALE"
  // Recurring and period end
  | "PER-POST-RECURRING"
  | "PER-AMORTIZE-PREPAID"
  | "PER-SPLIT-LOANPAYMENT"
  | "PER-POST-ACCRUALS"
  | "PER-REVERSE-ACCRUALS"
  | "PER-POST-DEPRECIATION"
  // AR and AP
  | "ARAP-REFRESH-AGING"
  | "AR-BUILD-STATEMENTS"
  | "AR-APPLY-PAYMENTS"
  | "AR-CHARGE-LATEFEES"
  | "AP-APPLY-DISCOUNTS"
  | "AR-WRITEOFF-UNCOLLECTIBLE"
  // Substantiation
  | "SUB-TIEOUT-ACCOUNTS"
  | "SUB-RAISE-REQUESTS"
  // Close
  | "CLOSE-CHECK-GATES"
  | "CLOSE-LOCK-PERIOD"
  | "CLOSE-ROLL-FORWARD"
  | "CLOSE-POST-YEAREND"
  // Reporting and tax compilation
  | "RPT-BUILD-PACKAGE"
  | "RPT-FLAG-VARIANCES"
  | "RPT-REBUILD-FORECAST"
  | "RPT-COMPOSE-NARRATIVE"
  | "TAX-BUILD-1099"
  | "TAX-TRACK-W9"
  // Practice
  | "PRAC-GENERATE-TASKS"
  | "PRAC-ESCALATE-OVERDUE"
  | "PRAC-NUDGE-REQUESTS"
  // Added by doc 05
  | "IMPORT-PARSE-FEED"
  | "IMPORT-COMMIT-BATCH"
  | "PAY-APPROVE-RUN"
  | "PAY-POST-REGISTER"
  | "CPA-BUILD-HANDOFF"
  | "OFFBOARD-BUILD-EXPORT";

/** Doc 03 Part 7 names the reversal of a run `<ORIGINAL>-UNDO`. */
export type UndoRunTypeId = `${RunTypeId}-UNDO`;

export type AnyRunTypeId = RunTypeId | UndoRunTypeId;

export type SkipReason =
  | "manual_override"
  | "locked_period"
  | "already_applied"
  | "out_of_scope_engagement"
  | "missing_prerequisite"
  | "ambiguous_candidate"
  | "entitlement_not_included"
  | "superseded_version";

export type RunMode = "preview" | "apply";

/** Doc 03 Part 11. Eight terminal statuses and there is no partially_applied. */
export type RunStatus =
  | "completed"
  | "completed_with_skips"
  | "no_op"
  | "refused"
  | "rejected_locked"
  | "deduplicated"
  | "failed"
  | "abandoned";

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "completed",
  "completed_with_skips",
  "no_op",
  "refused",
  "rejected_locked",
  "deduplicated",
  "failed",
  "abandoned",
];

/** Stable machine readable codes the framework itself raises. */
export const RUN_ERROR_CODES = {
  staleReview: "STALE_PREVIEW",
  notClean: "PROPOSAL_SET_NOT_CLEAN",
  alreadyRunning: "RUN_ALREADY_RUNNING",
  scopeDrift: "SCOPE_DRIFT",
  alreadyUndone: "UNDO_ALREADY_DONE",
  noOpenPeriod: "UNDO_NO_OPEN_PERIOD",
  dependentEntry: "UNDO_DEPENDENT_ENTRY",
  overrideProtected: "OVERRIDE_PROTECTED_ROW",
  lockedPeriod: "LOCKED_PERIOD",
  missingAccount: "MISSING_ACCOUNT",
  unbalancedEntry: "UNBALANCED_ENTRY",
  serialization: "SERIALIZATION_FAILURE",
} as const;

/** A single journal line. Debit positive, credit negative, integer cents. */
export interface ProposedLine {
  accountNumber: string; // four digit string, for example "6420"
  categoryId: string | null; // "CAT-" slug, null only for pure clearing moves
  amountCents: Cents; // signed, lines of an entry sum to exactly 0n
  memo: string;
  dimensions: {
    classId?: Ulid;
    locationId?: Ulid;
    programId?: Ulid;
    restriction?: "with_donor_restrictions" | "without_donor_restrictions";
  };
}

export interface ProposedJournalEntry {
  kind: "journal_entry";
  targetId: Ulid | null; // null when the run creates a new entry
  entryDate: string; // ISO date, must fall in an open period
  lines: ProposedLine[];
  reversalOf?: Ulid;
  sourceRef: { table: string; rowId: Ulid; version: number };
  /** Set when doc 03 Part 7 dating moved the entry out of a locked period. */
  redatedFromLockedPeriod?: string;
  /**
   * Doc 02 PER-POST-ACCRUALS. The day this entry reverses itself, which is the
   * first day of the following period. Carried on the proposal rather than
   * derived at write time so that a preview shows the reversal date a person
   * will actually see, and so PER-REVERSE-ACCRUALS has one column to select on.
   */
  reversesOn?: string;
  /** The real bill or invoice that superseded an accrual, once it arrives. */
  linkedDocumentId?: Ulid;
  /** Which accrual template produced this entry. */
  accrualTemplateId?: Ulid;
}

export interface ProposedFieldWrite {
  kind: "field_write";
  table: string;
  rowId: Ulid;
  before: Record<string, unknown>; // captured for the undo plan
  after: Record<string, unknown>;
  provenance: {
    /**
     * 0 through 9, per the conventions doc, or null for a write that belongs to
     * no coding level at all. Module 3 reconciliation writes are the null case:
     * a cleared flag and a match tier are not a coding decision and claiming a
     * level for them would put reconciliation inside the cascade, where doc 00
     * Part 3 does not put it. The run log already stored this column nullable.
     */
    cascadeLevel: number | null;
    ruleId?: string; // "RULE-" plus ULID
    ruleVersion?: number;
    templateId?: Ulid;
    templateVersion?: number;
  };
}

/**
 * A new row in a table a run owns. Doc 03 Part 3 named three proposal shapes,
 * all of which assume the row already exists, which is true for every coding
 * run and false for the import pipeline: parsing creates staged rows and
 * committing creates register rows. Rather than let those two runs write
 * outside the proposal set, the set grew a fourth shape, so the proposal set
 * stays the only channel between propose and apply.
 */
export interface ProposedRowInsert {
  kind: "row_insert";
  table: string;
  rowId: Ulid;
  row: Record<string, unknown>;
  provenance: {
    cascadeLevel: number | null;
    ruleId?: string;
    ruleVersion?: number;
    templateId?: Ulid;
    templateVersion?: number;
  };
}

export interface ProposedSuspenseRouting {
  kind: "suspense";
  transactionId: Ulid;
  reasonCode: `SUS-${string}`; // for example "SUS-04"
  account: "1990";
  detail: string;
  relatedIds?: Ulid[]; // both rule ids for SUS-19, for instance
}

export type Proposal =
  | ProposedJournalEntry
  | ProposedFieldWrite
  | ProposedRowInsert
  | ProposedSuspenseRouting;

export interface Skip {
  rowId: Ulid;
  reason: SkipReason;
  detail: string;
}

export interface RunError {
  rowId: Ulid | null; // null for run level errors
  code: string; // stable, machine readable
  message: string;
  retryable: boolean;
}

export interface ScopeVersionStamp {
  id: string;
  version: number;
}

export interface FrozenScope<S> {
  input: S;
  clientId: Ulid;
  firmId: Ulid;
  periodStart: string;
  periodEnd: string;
  candidateIds: Ulid[]; // ordered, deterministic
  scopeHash: string; // sha256 over candidateIds plus versions
  /** Every rule, template, schedule, or category version that participated. */
  versions: ScopeVersionStamp[];
  /**
   * Row ids in the window that carry the manual override flag. Doc 03 Part 6
   * rule 4 requires these to be reported rather than hidden.
   */
  overriddenIds: Ulid[];
}

export interface RunLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface RunActor {
  userId: Ulid;
  kind: "human" | "schedule" | "sequence";
}

/**
 * Where apply records what it actually wrote, so the log can name the created
 * journal entry ids. This is an addition to the doc 03 context shape, and it
 * exists because doc 03 Part 9 requires the created journal entry id on the
 * item row while apply returns void.
 */
export interface ApplySink {
  entryIdByProposalIndex: Record<number, Ulid>;
  entriesCreated: number;
  entriesReversed: number;
}

export interface RunContext {
  db: RunDb; // transaction aware handle
  tx?: RunTx;
  applySink?: ApplySink;
  actor: RunActor;
  runExecutionId: Ulid; // the ULID inside "RUNX-"
  idempotencyKey: string;
  now: Date; // injected, never Date.now() inside a run
  logger: RunLogger;
  firmId: Ulid;
  clientId: Ulid;
  mode: RunMode;
}

export interface RunResult<P = Proposal> {
  proposals: P[];
  skips: Skip[];
  errors: RunError[];
  totals: {
    candidates: number;
    proposed: number;
    skipped: number;
    failed: number;
    netCents: Cents; // must be 0n for any balanced posting run
  };
}

export interface Run<S, P = Proposal> {
  readonly type: AnyRunTypeId;
  readonly version: number; // bump on any behavior change
  readonly writesLedger: boolean;
  readonly requiresOpenPeriod: boolean;
  readonly concurrencyKey: (scope: S) => string;

  scopeSchema: ZodType<S>;

  resolveScope(scope: S, ctx: RunContext): Promise<FrozenScope<S>>;
  propose(scope: FrozenScope<S>, ctx: RunContext): Promise<RunResult<P>>;
  apply(proposals: P[], ctx: RunContext): Promise<void>;
  undoPlan(proposals: P[], ctx: RunContext): Promise<Proposal[]>;
}

/** Convenience for building a result and keeping the totals honest. */
export function makeResult<P>(
  candidateCount: number,
  proposals: P[],
  skips: Skip[],
  errors: RunError[],
  netCents: Cents,
): RunResult<P> {
  return {
    proposals,
    skips,
    errors,
    totals: {
      candidates: candidateCount,
      proposed: proposals.length,
      skipped: skips.length,
      failed: errors.length,
      netCents,
    },
  };
}

/** Sum of every signed line in every proposed journal entry. */
export function netCentsOf(proposals: readonly Proposal[]): Cents {
  let net = BigInt(0);
  for (const p of proposals) {
    if (p.kind !== "journal_entry") continue;
    for (const line of p.lines) net += line.amountCents;
  }
  return net;
}

export function isJournalEntry(p: Proposal): p is ProposedJournalEntry {
  return p.kind === "journal_entry";
}

export function isFieldWrite(p: Proposal): p is ProposedFieldWrite {
  return p.kind === "field_write";
}

export function isSuspenseRouting(p: Proposal): p is ProposedSuspenseRouting {
  return p.kind === "suspense";
}

export function isRowInsert(p: Proposal): p is ProposedRowInsert {
  return p.kind === "row_insert";
}
