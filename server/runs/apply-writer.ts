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
  AgingSnapshotRow,
  DeferralLineRow,
  DepreciationScheduleRow,
  InvoiceRow,
  PaymentApplicationRow,
  StatementDocumentRow,
  StatementItemRow,
  VendorCreditRow,
  WriteoffProposalRow,
  ClosePeriodRow,
  CloseGateResultRow,
  ClosingEntryRow,
  DocumentRequestRow,
  DocumentationExceptionRow,
  OpeningBalanceRow,
  PeriodLockRow,
  SubTieoutRow,
  SubstantiationRecordRow,
  ImportBatchRow,
  JournalEntryRow,
  JournalLineRow,
  PortalRequestRow,
  RecBatchRow,
  SettlementRowRow,
  StagedRowRow,
  SuspenseItemRow,
  TransactionRow,
  CashForecastRunRow,
  CashForecastWeekRow,
  ReportAuditEventRow,
  ReportNarrativeRow,
  ReportPackageRow,
  ReportSectionRow,
  ReportVarianceRow,
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
/**
 * The person the write is recorded against. The same reasoning as the two above:
 * a preview and its apply are often run by two different people, which is the
 * point of the preparer and approver split in D4, so a run that stamped the
 * actor id into a proposal would refuse itself on every honest two person close.
 * CLOSE-LOCK-PERIOD writes this and the writer resolves it. See NOTES.md entry 92.
 */
export const ACTOR_PLACEHOLDER = "$actor_user_id";

function materialize(
  values: Record<string, unknown>,
  ctx: RunContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === RUN_ID_PLACEHOLDER) out[key] = ctx.runExecutionId;
    else if (value === NOW_PLACEHOLDER) out[key] = ctx.now.toISOString();
    else if (value === ACTOR_PLACEHOLDER) out[key] = ctx.actor.userId;
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
    // Doc 02 module 5. The receivable and payable runs move the running totals
    // that define an open balance, and they mark the document they consumed so
    // a rerun agrees with the first execution instead of doubling it.
    case "invoices":
      await tx.update("invoices", rowId, after);
      return;
    case "bills":
      await tx.update("bills", rowId, after);
      return;
    case "customers":
      await tx.update("customers", rowId, after);
      return;
    case "customer_payments":
      await tx.update("customer_payments", rowId, after);
      return;
    case "credit_memos":
      await tx.update("credit_memos", rowId, after);
      return;
    case "payment_applications":
      await tx.update("payment_applications", rowId, after);
      return;
    case "aging_snapshots":
      await tx.update("aging_snapshots", rowId, after);
      return;
    case "statement_documents":
      await tx.update("statement_documents", rowId, after);
      return;
    case "writeoff_proposals":
      await tx.update("writeoff_proposals", rowId, after);
      return;
    case "vendor_credits":
      await tx.update("vendor_credits", rowId, after);
      return;
    // Doc 02 module 6. The close runs refresh a tie out row, a document request,
    // a gate result, a period status, and a lock. Every one of these is a row a
    // person can override, and the override guard in the store is what stops the
    // write, not a branch here.
    case "sub_tieouts":
      await tx.update("sub_tieouts", rowId, after);
      return;
    case "document_requests":
      await tx.update("document_requests", rowId, after);
      return;
    case "close_gate_results":
      await tx.update("close_gate_results", rowId, after);
      return;
    case "close_periods":
      await tx.update("close_periods", rowId, after);
      return;
    case "period_locks":
      await tx.update("period_locks", rowId, after);
      return;
    case "opening_balances":
      await tx.update("opening_balances", rowId, after);
      return;
    // Doc 02 module 8. A rebuild refreshes the package header and its sections,
    // the variance rows, the forecast header and its weeks, and the narrative
    // draft. Every one of them carries the override flag, and the guard in the
    // store is what refuses a write to an overridden row.
    case "report_packages":
      await tx.update("report_packages", rowId, after);
      return;
    case "report_sections":
      await tx.update("report_sections", rowId, after);
      return;
    case "report_variances":
      await tx.update("report_variances", rowId, after);
      return;
    case "cash_forecast_runs":
      await tx.update("cash_forecast_runs", rowId, after);
      return;
    case "cash_forecast_weeks":
      await tx.update("cash_forecast_weeks", rowId, after);
      return;
    case "report_narratives":
      await tx.update("report_narratives", rowId, after);
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
    // Doc 02 module 5. Four of the six receivable and payable runs produce a
    // subledger record rather than only a ledger entry: the aging snapshot, the
    // statement document and its lines, the fee invoice, the application, the
    // write off proposal, and the vendor credit. None of these is a ledger
    // entry, so none of them can reach the entry path from here.
    case "aging_snapshots":
      await tx.insert("aging_snapshots", [
        withId as unknown as AgingSnapshotRow,
      ]);
      return;
    case "statement_documents":
      await tx.insert("statement_documents", [
        withId as unknown as StatementDocumentRow,
      ]);
      return;
    case "statement_items":
      await tx.insert("statement_items", [
        withId as unknown as StatementItemRow,
      ]);
      return;
    case "invoices":
      await tx.insert("invoices", [withId as unknown as InvoiceRow]);
      return;
    case "payment_applications":
      await tx.insert("payment_applications", [
        withId as unknown as PaymentApplicationRow,
      ]);
      return;
    case "writeoff_proposals":
      await tx.insert("writeoff_proposals", [
        withId as unknown as WriteoffProposalRow,
      ]);
      return;
    case "vendor_credits":
      await tx.insert("vendor_credits", [
        withId as unknown as VendorCreditRow,
      ]);
      return;
    // Doc 02 module 6. Substantiation and close write derived rows: the tie out
    // per account, the request per open item, the gate result per gate, the
    // period, the lock, the opening balance, and the year end claim.
    case "close_periods":
      await tx.insert("close_periods", [withId as unknown as ClosePeriodRow]);
      return;
    case "sub_tieouts":
      await tx.insert("sub_tieouts", [withId as unknown as SubTieoutRow]);
      return;
    case "substantiation_records":
      await tx.insert("substantiation_records", [
        withId as unknown as SubstantiationRecordRow,
      ]);
      return;
    case "document_requests":
      await tx.insert("document_requests", [
        withId as unknown as DocumentRequestRow,
      ]);
      return;
    case "close_gate_results":
      await tx.insert("close_gate_results", [
        withId as unknown as CloseGateResultRow,
      ]);
      return;
    case "opening_balances":
      await tx.insert("opening_balances", [
        withId as unknown as OpeningBalanceRow,
      ]);
      return;
    case "closing_entries":
      await tx.insert("closing_entries", [
        withId as unknown as ClosingEntryRow,
      ]);
      return;
    case "period_locks":
      await tx.insert("period_locks", [withId as unknown as PeriodLockRow]);
      return;
    // Doc 02 module 8. Reporting inserts only report rows. There is no path from
    // here to a ledger table, which is the property that lets a reporting run
    // work on a locked period at all. The audit event table is the whole of the
    // module's delivery surface, and it has no address column to send to.
    case "report_packages":
      await tx.insert("report_packages", [
        withId as unknown as ReportPackageRow,
      ]);
      return;
    case "report_sections":
      await tx.insert("report_sections", [
        withId as unknown as ReportSectionRow,
      ]);
      return;
    case "report_variances":
      await tx.insert("report_variances", [
        withId as unknown as ReportVarianceRow,
      ]);
      return;
    case "cash_forecast_runs":
      await tx.insert("cash_forecast_runs", [
        withId as unknown as CashForecastRunRow,
      ]);
      return;
    case "cash_forecast_weeks":
      await tx.insert("cash_forecast_weeks", [
        withId as unknown as CashForecastWeekRow,
      ]);
      return;
    case "report_narratives":
      await tx.insert("report_narratives", [
        withId as unknown as ReportNarrativeRow,
      ]);
      return;
    case "report_audit_events":
      await tx.insert("report_audit_events", [
        withId as unknown as ReportAuditEventRow,
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
