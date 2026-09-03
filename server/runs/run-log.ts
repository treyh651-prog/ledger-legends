/**
 * The run log writer, doc 03 Part 9.
 *
 * One writer function, used by apply and by preview, so the two modes cannot
 * log different things. Everything here is an insert. Nothing updates a log row.
 * A status transition after the intent row is an appended run_log_events row.
 */

import type {
  Cents,
  FrozenScope,
  Proposal,
  Run,
  RunContext,
  RunMode,
  RunResult,
  RunStatus,
  Skip,
  Ulid,
} from "./contract";
import {
  isFieldWrite,
  isJournalEntry,
  isRowInsert,
  isSuspenseRouting,
} from "./contract";
import type { RunTx } from "./db";
import { toJsonValue, ulid } from "./ids";
import type { RunLogEventRow, RunLogItemRow, RunLogRow } from "./tables";

export interface LogEnvironment {
  gitSha: string;
  releaseId: string;
}

export const DEFAULT_ENVIRONMENT: LogEnvironment = {
  gitSha: process.env.GIT_SHA ?? "unknown",
  releaseId: process.env.RELEASE_ID ?? "unknown",
};

export interface IntentRowArgs<S> {
  executionId: string;
  runType: string;
  runVersion: number;
  mode: RunMode;
  firmId: Ulid;
  clientId: Ulid;
  idempotencyKey: string;
  frozen: FrozenScope<S>;
  actorId: Ulid;
  actorKind: string;
  source: string;
  parentSequenceId: string | null;
  previewRunId: string | null;
  originalRunId: string | null;
  startedAt: Date;
  env: LogEnvironment;
}

/**
 * The pre transaction intent row of doc 03 Part 11. Written in its own short
 * transaction before the main one opens, so a process that dies mid run still
 * leaves evidence it was attempted.
 */
export function buildIntentRow<S>(args: IntentRowArgs<S>): RunLogRow {
  return {
    id: args.executionId,
    firmId: args.firmId,
    clientId: args.clientId,
    runType: args.runType,
    runVersion: args.runVersion,
    mode: args.mode,
    status: "started",
    idempotencyKey: args.idempotencyKey,
    scopeHash: args.frozen.scopeHash,
    actorId: args.actorId,
    actorKind: args.actorKind,
    source: args.source,
    parentSequenceId: args.parentSequenceId,
    previewRunId: args.previewRunId,
    originalRunId: args.originalRunId,
    periodStart: args.frozen.periodStart,
    periodEnd: args.frozen.periodEnd,
    candidateCount: args.frozen.candidateIds.length,
    candidateIds: args.frozen.candidateIds.slice(),
    scopeInput: toJsonValue(args.frozen.input),
    versions: toJsonValue(args.frozen.versions),
    startedAt: args.startedAt.toISOString(),
    gitSha: args.env.gitSha,
    releaseId: args.env.releaseId,
  };
}

export function skipCountsByReason(skips: readonly Skip[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of skips) out[s.reason] = (out[s.reason] ?? 0) + 1;
  return out;
}

/** Row id a proposal is about, so the log item points at something real. */
export function proposalRowId(p: Proposal): Ulid | null {
  if (isJournalEntry(p)) return p.sourceRef.rowId;
  if (isFieldWrite(p)) return p.rowId;
  if (isRowInsert(p)) return p.rowId;
  if (isSuspenseRouting(p)) return p.transactionId;
  return null;
}

export function proposalTable(p: Proposal): string {
  if (isJournalEntry(p)) return p.sourceRef.table;
  if (isFieldWrite(p)) return p.table;
  if (isRowInsert(p)) return p.table;
  return "transactions";
}

/**
 * Deterministic reason string. Doc 02 Part A rule 2 wants a stored sentence
 * built from a template plus merge fields, never free text assembled later.
 */
export function proposalReason(p: Proposal): string {
  if (isJournalEntry(p)) {
    const redated = p.redatedFromLockedPeriod
      ? `redated_from_locked_period:${p.redatedFromLockedPeriod}`
      : "dated_in_open_period";
    const reversal = p.reversalOf ? `reversal_of:${p.reversalOf}` : "original_entry";
    return `posted_entry source:${p.sourceRef.table} date:${p.entryDate} ${reversal} ${redated}`;
  }
  if (isFieldWrite(p)) {
    const rule = p.provenance.ruleId
      ? ` rule:${p.provenance.ruleId} version:${String(p.provenance.ruleVersion ?? 0)}`
      : "";
    const template = p.provenance.templateId
      ? ` template:${p.provenance.templateId} version:${String(p.provenance.templateVersion ?? 0)}`
      : "";
    return `field_write table:${p.table} cascade_level:${String(p.provenance.cascadeLevel)}${rule}${template}`;
  }
  if (isRowInsert(p)) {
    return `row_insert table:${p.table} row:${p.rowId} cascade_level:${String(p.provenance.cascadeLevel)}`;
  }
  return `routed_to_suspense code:${p.reasonCode} account:${p.account} detail:${p.detail}`;
}

export interface WriteLogArgs<S, P> {
  run: Run<S, P>;
  ctx: RunContext;
  mode: RunMode;
  frozen: FrozenScope<S>;
  result: RunResult<P>;
  status: RunStatus;
  attempt: number;
  startedAt: Date;
  finishedAt: Date;
  entriesCreated: number;
  entriesReversed: number;
  /** Journal entry id assigned during apply, keyed by proposal index. */
  entryIdByProposalIndex?: Record<number, Ulid>;
  detail?: string;
  relatedRunId?: string | null;
}

/**
 * Write the item rows and the terminal event row. Called inside the run
 * transaction for an apply, and inside the short follow up transaction for a
 * preview, which is what keeps the two modes on one writer.
 */
export async function writeRunLog<S, P>(
  tx: RunTx,
  args: WriteLogArgs<S, P>,
): Promise<void> {
  const { ctx, frozen, result } = args;
  const items: RunLogItemRow[] = [];

  result.proposals.forEach((raw, index) => {
    const p = raw as unknown as Proposal;
    const provenance =
      isFieldWrite(p) || isRowInsert(p) ? p.provenance : null;
    items.push({
      id: ulid(args.finishedAt),
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      runExecutionId: ctx.runExecutionId,
      rowTable: proposalTable(p),
      rowId: proposalRowId(p),
      decision: "proposed",
      reason: proposalReason(p),
      cascadeLevel: provenance ? provenance.cascadeLevel : null,
      ruleId: provenance?.ruleId ?? null,
      ruleVersion: provenance?.ruleVersion ?? null,
      templateId: provenance?.templateId ?? null,
      templateVersion: provenance?.templateVersion ?? null,
      suspenseReasonCode: isSuspenseRouting(p) ? p.reasonCode : null,
      journalEntryId: args.entryIdByProposalIndex?.[index] ?? null,
      beforeJson: isFieldWrite(p) ? toJsonValue(p.before) : null,
      afterJson: isFieldWrite(p)
        ? toJsonValue(p.after)
        : isRowInsert(p)
          ? toJsonValue(p.row)
          : null,
      proposalJson: toJsonValue(p),
      errorCode: null,
      errorMessage: null,
    });
  });

  for (const skip of result.skips) {
    items.push({
      id: ulid(args.finishedAt),
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      runExecutionId: ctx.runExecutionId,
      rowTable: "transactions",
      rowId: skip.rowId,
      decision: "skipped",
      reason: `${skip.reason} ${skip.detail}`,
      cascadeLevel: null,
      ruleId: null,
      ruleVersion: null,
      templateId: null,
      templateVersion: null,
      suspenseReasonCode: null,
      journalEntryId: null,
      beforeJson: null,
      afterJson: null,
      proposalJson: null,
      errorCode: null,
      errorMessage: null,
    });
  }

  for (const err of result.errors) {
    items.push({
      id: ulid(args.finishedAt),
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      runExecutionId: ctx.runExecutionId,
      rowTable: "transactions",
      rowId: err.rowId,
      decision: "errored",
      reason: `${err.code} ${err.message}`,
      cascadeLevel: null,
      ruleId: null,
      ruleVersion: null,
      templateId: null,
      templateVersion: null,
      suspenseReasonCode: null,
      journalEntryId: null,
      beforeJson: null,
      afterJson: null,
      proposalJson: null,
      errorCode: err.code,
      errorMessage: err.message,
    });
  }

  if (items.length > 0) await tx.insert("run_log_items", items);

  await appendEvent(tx, {
    firmId: frozen.firmId,
    runExecutionId: ctx.runExecutionId,
    event: args.status,
    attempt: args.attempt,
    detail: args.detail ?? "",
    proposalCount: result.proposals.length,
    skipCount: result.skips.length,
    errorCount: result.errors.length,
    netCents: result.totals.netCents,
    entriesCreated: args.entriesCreated,
    entriesReversed: args.entriesReversed,
    skipCountsByReason: skipCountsByReason(result.skips),
    durationMs: args.finishedAt.getTime() - args.startedAt.getTime(),
    relatedRunId: args.relatedRunId ?? null,
    occurredAt: args.finishedAt.toISOString(),
  });
}

export interface AppendEventArgs {
  firmId: Ulid;
  runExecutionId: string;
  event: RunLogEventRow["event"];
  attempt: number;
  detail: string;
  proposalCount: number;
  skipCount: number;
  errorCount: number;
  netCents: Cents;
  entriesCreated: number;
  entriesReversed: number;
  skipCountsByReason: Record<string, number>;
  durationMs: number;
  relatedRunId: string | null;
  occurredAt: string;
}

export async function appendEvent(
  tx: RunTx,
  args: AppendEventArgs,
): Promise<void> {
  const row: RunLogEventRow = {
    id: ulid(new Date(args.occurredAt)),
    firmId: args.firmId,
    runExecutionId: args.runExecutionId,
    event: args.event,
    attempt: args.attempt,
    detail: args.detail,
    proposalCount: args.proposalCount,
    skipCount: args.skipCount,
    errorCount: args.errorCount,
    netCents: args.netCents,
    entriesCreated: args.entriesCreated,
    entriesReversed: args.entriesReversed,
    skipCountsByReason: args.skipCountsByReason,
    durationMs: args.durationMs,
    relatedRunId: args.relatedRunId,
    occurredAt: args.occurredAt,
  };
  await tx.insert("run_log_events", [row]);
}

/** Shorthand for an event with no counts, such as a retry marker. */
export async function appendBareEvent(
  tx: RunTx,
  firmId: Ulid,
  runExecutionId: string,
  event: RunLogEventRow["event"],
  attempt: number,
  detail: string,
  occurredAt: Date,
  relatedRunId: string | null = null,
): Promise<void> {
  await appendEvent(tx, {
    firmId,
    runExecutionId,
    event,
    attempt,
    detail,
    proposalCount: 0,
    skipCount: 0,
    errorCount: 0,
    netCents: BigInt(0),
    entriesCreated: 0,
    entriesReversed: 0,
    skipCountsByReason: {},
    durationMs: 0,
    relatedRunId,
    occurredAt: occurredAt.toISOString(),
  });
}
