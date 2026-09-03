/**
 * The one place proposals become rows.
 *
 * Runs do not write tables directly. They hand their proposal set to this
 * writer, which is the mechanical guarantee that the proposal set is the only
 * channel between propose and apply, as doc 03 Part 2 requires.
 *
 * The writer validates before it writes: entries balance to exactly 0n, every
 * entry carries at least two lines, and every amount is a bigint. A validation
 * failure throws and the whole transaction rolls back, because a half written
 * entry is exactly the state the framework refuses to allow.
 */

import {
  RUN_ERROR_CODES,
  isFieldWrite,
  isJournalEntry,
  isRowInsert,
  isSuspenseRouting,
  type ApplySink,
  type Proposal,
  type RunContext,
  type Ulid,
} from "./contract";
import type { RunTx } from "./db";
import { ulid } from "./ids";
import type {
  DeferralLineRow,
  DepreciationScheduleRow,
  DocumentationExceptionRow,
  ImportBatchRow,
  JournalEntryRow,
  JournalLineRow,
  PortalRequestRow,
  RecBatchRow,
  SettlementRowRow,
  StagedRowRow,
  SuspenseItemRow,
  TransactionRow,
} from "./tables";

/**
 * Two values a run cannot put in a proposal literally.
 *
 * Apply re-derives its proposals and compares them against the preview, byte
 * for byte, and refuses on any difference. That comparison is the reason a
 * proposal may not contain the execution id or the clock: both differ between
 * the preview and the apply, so a run that stamped them directly would refuse
 * itself every time. A run writes the placeholder and the writer substitutes
 * the real value at the moment of the write, which keeps the proposal set
 * deterministic and still records who wrote the row and when.
 */
export const RUN_ID_PLACEHOLDER = "$run_execution_id";
export const NOW_PLACEHOLDER = "$now";

function materialize(
  values: Record<string, unknown>,
  ctx: RunContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === RUN_ID_PLACEHOLDER) out[key] = ctx.runExecutionId;
    else if (value === NOW_PLACEHOLDER) out[key] = ctx.now.toISOString();
    else out[key] = value;
  }
  return out;
}

export class ProposalWriteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function emptySink(): ApplySink {
  return { entryIdByProposalIndex: {}, entriesCreated: 0, entriesReversed: 0 };
}

export function assertEntryShape(
  proposals: readonly Proposal[],
): void {
  for (const p of proposals) {
    if (!isJournalEntry(p)) continue;
    if (p.lines.length < 2) {
      throw new ProposalWriteError(
        RUN_ERROR_CODES.unbalancedEntry,
        `entry on ${p.entryDate} has fewer than two lines`,
      );
    }
    let net = BigInt(0);
    for (const line of p.lines) {
      if (typeof line.amountCents !== "bigint") {
        throw new ProposalWriteError(
          RUN_ERROR_CODES.unbalancedEntry,
          `line amount is not bigint cents on ${p.entryDate}`,
        );
      }
      net += line.amountCents;
    }
    if (net !== BigInt(0)) {
      throw new ProposalWriteError(
        RUN_ERROR_CODES.unbalancedEntry,
        `entry on ${p.entryDate} nets ${net.toString()} rather than zero`,
      );
    }
  }
}

export interface ApplyWriterMeta {
  runType: string;
  runVersion: number;
}

/**
 * Write a proposal set. Called from a run's apply, inside the run transaction.
 */
export async function applyProposals(
  proposals: readonly Proposal[],
  ctx: RunContext,
  meta: ApplyWriterMeta,
): Promise<ApplySink> {
  const tx = requireTx(ctx);
  assertEntryShape(proposals);
  const sink = ctx.applySink ?? emptySink();

  for (let index = 0; index < proposals.length; index += 1) {
    const p = proposals[index];
    if (isJournalEntry(p)) {
      const entryId = p.targetId ?? ulid(ctx.now);
      const entry: JournalEntryRow = {
        id: entryId,
        firmId: ctx.firmId,
        clientId: ctx.clientId,
        entryDate: p.entryDate,
        memo: p.lines.length > 0 ? p.lines[0].memo : "",
        posted: true,
        reversalOf: p.reversalOf ?? null,
        reversedByEntryId: null,
        redatedFromLockedPeriod: p.redatedFromLockedPeriod ?? null,
        // Doc 02 module 4. An accrual carries the day it undoes itself and,
        // once the real document arrives, a link to it. Both travel on the
        // proposal so preview and apply describe the same entry.
        reversesOn: p.reversesOn ?? null,
        linkedDocumentId: p.linkedDocumentId ?? null,
        accrualTemplateId: p.accrualTemplateId ?? null,
        sourceTable: p.sourceRef.table,
        sourceRowId: p.sourceRef.rowId,
        sourceVersion: p.sourceRef.version,
        createdByRunId: ctx.runExecutionId,
        runType: meta.runType,
        runVersion: meta.runVersion,
      };
      await tx.insert("journal_entries", [entry]);
      const lines: JournalLineRow[] = p.lines.map((line) => ({
        id: ulid(ctx.now),
        firmId: ctx.firmId,
        clientId: ctx.clientId,
        entryId,
        accountNumber: line.accountNumber,
        categoryId: line.categoryId,
        amountCents: line.amountCents,
        memo: line.memo,
        entryDate: p.entryDate,
        classId: line.dimensions.classId ?? null,
        locationId: line.dimensions.locationId ?? null,
        programId: line.dimensions.programId ?? null,
        restriction: line.dimensions.restriction ?? null,
      }));
      await tx.insert("journal_lines", lines);
      sink.entryIdByProposalIndex[index] = entryId;
      sink.entriesCreated += 1;
      if (p.reversalOf) sink.entriesReversed += 1;
      continue;
    }

    if (isFieldWrite(p)) {
      await writeField(tx, p.table, p.rowId, materialize(p.after, ctx));
      continue;
    }

    if (isRowInsert(p)) {
      await insertRow(tx, p.table, p.rowId, materialize(p.row, ctx));
      continue;
    }

    if (isSuspenseRouting(p)) {
      const item: SuspenseItemRow = {
        id: ulid(ctx.now),
        firmId: ctx.firmId,
        clientId: ctx.clientId,
        transactionId: p.transactionId,
        reasonCode: p.reasonCode,
        accountNumber: p.account,
        detail: p.detail,
        relatedIds: p.relatedIds ? p.relatedIds.slice() : [],
        createdByRunId: ctx.runExecutionId,
        withdrawnByRunId: null,
      };
      await tx.insert("suspense_items", [item]);
      continue;
    }
  }

  return sink;
}

/**
 * A field write goes through tx.update, which is where the override guard and
 * the period lock guard live. A run cannot route around them.
 */
async function writeField(
  tx: RunTx,
  table: string,
  rowId: Ulid,
  after: Record<string, unknown>,
): Promise<void> {
  switch (table) {
    case "transactions":
      await tx.update("transactions", rowId, after);
      return;
    case "suspense_items":
      await tx.update("suspense_items", rowId, after);
      return;
    // Doc 02 module 3. REC-MATCH-TIERED writes the tier onto the bank line and
    // REC-CLEAR-MATCHED writes the difference onto the batch.
    case "statement_lines":
      await tx.update("statement_lines", rowId, after);
      return;
    case "rec_batches":
      await tx.update("rec_batches", rowId, after);
      return;
    case "journal_entries":
      await tx.update("journal_entries", rowId, after);
      return;
    case "transfer_pairs":
      await tx.update("transfer_pairs", rowId, after);
      return;
    case "import_batches":
      await tx.update("import_batches", rowId, after);
      return;
    case "staged_rows":
      await tx.update("staged_rows", rowId, after);
      return;
    // Doc 02 TXN-SPLIT-SETTLEMENTS marks the settlement report row it consumed,
    // which is what makes a rerun report settlement_already_split rather than
    // post the same gross and fee twice.
    case "settlement_rows":
      await tx.update("settlement_rows", rowId, after);
      return;
    case "portal_requests":
      await tx.update("portal_requests", rowId, after);
      return;
    // Doc 02 module 4. Each of the six period end runs marks the subledger row
    // it consumed. That mark is what makes a rerun report the work as already
    // done instead of posting the same amount a second time.
    case "deferral_lines":
      await tx.update("deferral_lines", rowId, after);
      return;
    case "deferral_schedules":
      await tx.update("deferral_schedules", rowId, after);
      return;
    case "loan_schedule":
      await tx.update("loan_schedule", rowId, after);
      return;
    case "depreciation_schedule":
      await tx.update("depreciation_schedule", rowId, after);
      return;
    case "fixed_assets":
      await tx.update("fixed_assets", rowId, after);
      return;
    default:
      throw new ProposalWriteError(
        "UNKNOWN_WRITE_TABLE",
        `no field write path for table ${table}`,
      );
  }
}

/**
 * A row insert goes through tx.insert, which is where the unique guards live,
 * including the bank supplied id guard the import dedup rule depends on. Only
 * the tables the import pipeline and the coding cascade own are reachable from
 * here. Nothing a run proposes can create a journal entry by this path, because
 * an entry has a shape that has to be validated and it has its own proposal
 * kind.
 */
async function insertRow(
  tx: RunTx,
  table: string,
  rowId: Ulid,
  row: Record<string, unknown>,
): Promise<void> {
  const withId = { ...row, id: rowId };
  switch (table) {
    case "transactions":
      await tx.insert("transactions", [withId as unknown as TransactionRow]);
      return;
    case "import_batches":
      await tx.insert("import_batches", [withId as unknown as ImportBatchRow]);
      return;
    case "staged_rows":
      await tx.insert("staged_rows", [withId as unknown as StagedRowRow]);
      return;
    // Doc 02 TXN-SWEEP-SUSPENSE step 4 creates one request per client owned code.
    case "portal_requests":
      await tx.insert("portal_requests", [withId as unknown as PortalRequestRow]);
      return;
    // REC-MATCH-TIERED opens the reconciliation batch for the statement.
    case "rec_batches":
      await tx.insert("rec_batches", [withId as unknown as RecBatchRow]);
      return;
    // Doc 02 TXN-APPLY-RULES steps 7 and 8 raise these without stopping coding.
    case "documentation_exceptions":
      await tx.insert("documentation_exceptions", [
        withId as unknown as DocumentationExceptionRow,
      ]);
      return;
    case "settlement_rows":
      await tx.insert("settlement_rows", [withId as unknown as SettlementRowRow]);
      return;
    // Doc 02 PER-AMORTIZE-PREPAID writes the allocation table when the schedule
    // was created without one, and PER-POST-DEPRECIATION records the period it
    // posted. Both are inserts of a subledger row, not of a ledger entry.
    case "deferral_lines":
      await tx.insert("deferral_lines", [withId as unknown as DeferralLineRow]);
      return;
    case "depreciation_schedule":
      await tx.insert("depreciation_schedule", [
        withId as unknown as DepreciationScheduleRow,
      ]);
      return;
    default:
      throw new ProposalWriteError(
        "UNKNOWN_INSERT_TABLE",
        `no row insert path for table ${table}`,
      );
  }
}

export function requireTx(ctx: RunContext): RunTx {
  if (!ctx.tx) throw new Error("run context has no transaction");
  return ctx.tx;
}
