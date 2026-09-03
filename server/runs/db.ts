/**
 * The database port for runs.
 *
 * Four capabilities, and nothing else: read a named query, open a transaction
 * with a stated isolation level, take a two key advisory lock inside that
 * transaction, and write rows. Writes are split into insert and update because
 * a field write proposal has to be able to change an existing row.
 *
 * Keeping the port this narrow is what lets the in memory implementation used
 * by the tests be honest about the guarantees the Postgres implementation gets
 * from triggers.
 */

import type { Cents, Ulid } from "./contract";
import type {
  AccrualTemplateRow,
  AgingSnapshotRow,
  ArapPolicyRow,
  BankAccountRow,
  BankCodeMappingRow,
  BillRow,
  CategoryRow,
  CreditMemoRow,
  CustomerPaymentRow,
  CustomerRow,
  InvoiceRow,
  PaymentApplicationRow,
  RemittanceLineRow,
  StatementDocumentRow,
  StatementItemRow,
  VendorCreditRow,
  WriteoffProposalRow,
  DeferralLineRow,
  DeferralScheduleRow,
  DepreciationScheduleRow,
  FixedAssetRow,
  LoanRow,
  LoanScheduleRow,
  ChartAccountRow,
  ClientPolicyRow,
  ClosePeriodRow,
  CloseGateResultRow,
  ClosingEntryRow,
  DocumentationExceptionRow,
  DocumentRequestRow,
  OpeningBalanceRow,
  SubTieoutRow,
  SubstantiationRecordRow,
  DocumentLinkRow,
  ImportBatchRow,
  JournalEntryRow,
  JournalLineRow,
  MappingProfileRow,
  PeriodLockRow,
  PortalRequestRow,
  RecBatchRow,
  StatementLineRow,
  RecurringSplitRow,
  RecurringTemplateRow,
  RowMap,
  RuleRow,
  SettlementRowRow,
  RunLogEventRow,
  RunLogItemRow,
  RunLogRow,
  StagedRowRow,
  SuspenseItemRow,
  TableName,
  TransactionRow,
  TransferPairRow,
  VendorRow,
  BudgetRow,
  BudgetThresholdRow,
  CashForecastRunRow,
  CashForecastWeekRow,
  PayrollApprovalRow,
  ReportAuditEventRow,
  ReportNarrativeRow,
  ReportPackageRow,
  ReportSectionRow,
  ReportVarianceRow,
} from "./tables";

export type Isolation = "repeatable read" | "serializable";

/**
 * Session context set at transaction start. In Postgres these become
 * set_config calls, which is what the override guard and the row level
 * security policies read.
 */
export interface TxSession {
  isolation: Isolation;
  readOnly: boolean;
  firmId: Ulid;
  clientId: Ulid;
  actorId: Ulid;
  /** 'run', 'schedule', or 'sequence' for automation, 'human' for a person. */
  actorKind: "human" | "run" | "schedule" | "sequence";
}

/** The named query catalog. Params in, rows out, both typed. */
export interface QueryCatalog {
  bank_accounts_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: BankAccountRow;
  };
  chart_account: {
    params: { firmId: Ulid; clientId: Ulid; accountNumber: string };
    row: ChartAccountRow;
  };
  open_period_locks: {
    params: { firmId: Ulid; clientId: Ulid };
    row: PeriodLockRow;
  };
  /**
   * Candidate transactions in a date window. Overridden rows are excluded by
   * predicate when includeOverridden is false, per doc 03 Part 6 rule 1.
   */
  transactions_in_window: {
    params: {
      firmId: Ulid;
      clientId: Ulid;
      from: string;
      to: string;
      bankAccountIds: Ulid[] | null;
      includeOverridden: boolean;
    };
    row: TransactionRow;
  };
  /** Ids only, so an overridden row is counted without being loaded to write. */
  overridden_transaction_ids_in_window: {
    params: { firmId: Ulid; clientId: Ulid; from: string; to: string };
    row: { id: Ulid };
  };
  transfer_pairs_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: TransferPairRow;
  };
  applied_run_by_idempotency_key: {
    params: { idempotencyKey: string };
    row: RunLogRow;
  };
  run_log_by_id: {
    params: { firmId: Ulid; executionId: string };
    row: RunLogRow;
  };
  run_log_items_by_execution: {
    params: { firmId: Ulid; executionId: string };
    row: RunLogItemRow;
  };
  run_log_events_by_execution: {
    params: { firmId: Ulid; executionId: string };
    row: RunLogEventRow;
  };
  started_runs_before: {
    params: { before: string };
    row: RunLogRow;
  };
  journal_entries_by_run: {
    params: { firmId: Ulid; executionId: string };
    row: JournalEntryRow;
  };
  journal_entries_referencing: {
    params: { firmId: Ulid; clientId: Ulid; entryIds: Ulid[] };
    row: JournalEntryRow;
  };
  journal_lines_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: JournalLineRow;
  };
  suspense_items_by_run: {
    params: { firmId: Ulid; executionId: string };
    row: SuspenseItemRow;
  };
  transactions_by_ids: {
    params: { firmId: Ulid; clientId: Ulid; ids: Ulid[] };
    row: TransactionRow;
  };
  /**
   * The active mapping profile for an institution and file format. There is at
   * most one, enforced by map_one_active_per_institution in migration 0009.
   */
  active_mapping_profile: {
    params: {
      firmId: Ulid;
      clientId: Ulid;
      institutionName: string;
      fileFormat: string;
    };
    row: MappingProfileRow;
  };
  import_batch_by_id: {
    params: { firmId: Ulid; clientId: Ulid; batchId: Ulid };
    row: ImportBatchRow;
  };
  staged_rows_by_batch: {
    params: { firmId: Ulid; clientId: Ulid; batchId: Ulid };
    row: StagedRowRow;
  };
  /** Import dedup, first test: the bank supplied id is the key. */
  transactions_by_bank_ids: {
    params: {
      firmId: Ulid;
      clientId: Ulid;
      bankAccountId: Ulid;
      bankTransactionIds: string[];
    };
    row: TransactionRow;
  };
  /**
   * Import dedup, second test: account, date, amount, and normalized
   * description, over one funding source and a date window.
   */
  transactions_for_account_window: {
    params: {
      firmId: Ulid;
      clientId: Ulid;
      bankAccountId: Ulid;
      from: string;
      to: string;
    };
    row: TransactionRow;
  };
  /** Batch reversal reads the register rows the batch created. */
  transactions_by_batch: {
    params: { firmId: Ulid; clientId: Ulid; batchId: Ulid };
    row: TransactionRow;
  };

  // Doc 02 module 2. Everything below is read by the nine coding runs.

  /** The category layer, doc 00 Part 2. Read whole, it is small per client. */
  categories_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: CategoryRow;
  };
  /**
   * Active rules in the doc 00 tie break order already applied: priority
   * descending, condition count descending, rule id ascending.
   */
  active_rules_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: RuleRow;
  };
  recurring_templates_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: RecurringTemplateRow;
  };
  recurring_splits_for_template: {
    params: { firmId: Ulid; clientId: Ulid; templateId: Ulid; templateVersion: number };
    row: RecurringSplitRow;
  };
  vendors_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: VendorRow;
  };
  bank_code_mappings_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: BankCodeMappingRow;
  };
  /** Settlement report rows in a payout date window. */
  settlement_rows_in_window: {
    params: { firmId: Ulid; clientId: Ulid; from: string; to: string };
    row: SettlementRowRow;
  };
  /** At most one row per client. Missing means every default applies. */
  client_policy: {
    params: { firmId: Ulid; clientId: Ulid };
    row: ClientPolicyRow;
  };
  document_links_for_transactions: {
    params: { firmId: Ulid; clientId: Ulid; transactionIds: Ulid[] };
    row: DocumentLinkRow;
  };
  open_portal_requests_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: PortalRequestRow;
  };
  /**
   * Suspense items already raised against a set of transactions. The sweep uses
   * this to honor a reason code an earlier pipeline step produced, including one
   * produced by a run that writes no field on the register row.
   */
  suspense_items_for_transactions: {
    params: { firmId: Ulid; clientId: Ulid; transactionIds: Ulid[] };
    row: SuspenseItemRow;
  };

  // Doc 02 module 3. Everything below is read by the three reconciliation runs.

  /**
   * The bank side of the match, in the doc 02 iteration order: statement line
   * date ascending, absolute amount ascending, statement line id ascending.
   */
  statement_lines_for_statement: {
    params: {
      firmId: Ulid;
      clientId: Ulid;
      bankAccountId: Ulid;
      statementId: Ulid;
    };
    row: StatementLineRow;
  };
  /** At most one batch per account per statement, by the unique constraint. */
  rec_batch_for_statement: {
    params: { firmId: Ulid; clientId: Ulid; bankAccountId: Ulid; statementId: Ulid };
    row: RecBatchRow;
  };
  /**
   * Every cleared register row on one account through a day. This is the
   * cleared ledger balance REC-CLEAR-MATCHED subtracts from the statement
   * balance, and it deliberately reaches back before the statement period,
   * because a balance is cumulative and a period is not.
   */
  cleared_transactions_for_account: {
    params: {
      firmId: Ulid;
      clientId: Ulid;
      bankAccountId: Ulid;
      through: string;
    };
    row: TransactionRow;
  };
  /** Register rows already linked to a line of one statement. */
  transactions_for_statement: {
    params: {
      firmId: Ulid;
      clientId: Ulid;
      bankAccountId: Ulid;
      statementId: Ulid;
    };
    row: TransactionRow;
  };

  // Doc 02 module 4. Everything below is read by the six period end runs.

  /**
   * Every posted entry dated inside a window. Three of the six runs need this
   * for the same reason: an entry that already exists is the only honest test
   * of whether the period has already been posted. Ordered by entry date then
   * id so a rerun sees the same order.
   */
  journal_entries_in_window: {
    params: { firmId: Ulid; clientId: Ulid; from: string; to: string };
    row: JournalEntryRow;
  };
  /**
   * Auto reversing entries whose reversal day falls inside a window. This is
   * the whole candidate set of PER-REVERSE-ACCRUALS, and the reversal day is
   * deliberately the selection key rather than the original entry date,
   * because an accrual moved by hand has to reverse on the day a person put
   * on it.
   */
  journal_entries_awaiting_reversal: {
    params: { firmId: Ulid; clientId: Ulid; from: string; to: string };
    row: JournalEntryRow;
  };
  /** The lines of a named set of entries, in entry then account order. */
  journal_lines_for_entries: {
    params: { firmId: Ulid; clientId: Ulid; entryIds: Ulid[] };
    row: JournalLineRow;
  };
  /** Deferral schedules of one kind, prepaid unless the caller says otherwise. */
  deferral_schedules_for_client: {
    params: { firmId: Ulid; clientId: Ulid; kinds: string[] };
    row: DeferralScheduleRow;
  };
  /** The stored allocation table, ordered by schedule then period number. */
  deferral_lines_for_schedules: {
    params: { firmId: Ulid; clientId: Ulid; scheduleIds: Ulid[] };
    row: DeferralLineRow;
  };
  loans_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: LoanRow;
  };
  /**
   * The amortization table. Doc 02 iteration order for the loan split is due
   * date ascending then payment number ascending, applied in the query so the
   * run never sorts a second time.
   */
  loan_schedule_for_client: {
    params: { firmId: Ulid; clientId: Ulid; from: string; to: string };
    row: LoanScheduleRow;
  };
  /** Every scheduled row of a loan, used to walk the balance forward. */
  loan_schedule_for_loans: {
    params: { firmId: Ulid; clientId: Ulid; loanIds: Ulid[] };
    row: LoanScheduleRow;
  };
  fixed_assets_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: FixedAssetRow;
  };
  depreciation_schedule_for_assets: {
    params: { firmId: Ulid; clientId: Ulid; assetIds: Ulid[] };
    row: DepreciationScheduleRow;
  };
  accrual_templates_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: AccrualTemplateRow;
  };

  // Doc 02 module 5. Everything below is read by the six AR and AP runs.

  /**
   * At most one policy row per client, by the unique constraint in migration
   * 0014. Missing means every doc 02 module 5 default applies, so the callers
   * resolve it through a defaults helper rather than treating absence as an
   * error.
   */
  arap_policy: {
    params: { firmId: Ulid; clientId: Ulid };
    row: ArapPolicyRow;
  };
  /** Customer name ascending then id ascending, the module 5 iteration order. */
  customers_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: CustomerRow;
  };
  /**
   * Every invoice of a client, fee invoices included, ordered due date
   * ascending then id ascending. Read whole rather than filtered on open
   * balance, because the open balance is a subtraction over four columns and a
   * closed invoice is still part of the statement history.
   */
  invoices_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: InvoiceRow;
  };
  credit_memos_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: CreditMemoRow;
  };
  /**
   * Payments received in a window, in the doc 02 AR-APPLY-PAYMENTS iteration
   * order: payment date ascending then payment id ascending.
   */
  customer_payments_in_window: {
    params: { firmId: Ulid; clientId: Ulid; from: string; to: string };
    row: CustomerPaymentRow;
  };
  /** Structured remittance advice, ordered by payment then line number. */
  remittance_lines_for_payments: {
    params: { firmId: Ulid; clientId: Ulid; paymentIds: Ulid[] };
    row: RemittanceLineRow;
  };
  /**
   * Applications already recorded. This is what makes a rerun report
   * already_applied rather than applying the same payment a second time.
   */
  payment_applications_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: PaymentApplicationRow;
  };
  /**
   * The snapshot rows an earlier execution wrote for one as of date. The aging
   * run reads its own output so a second execution can agree with it in place
   * rather than duplicating it.
   */
  aging_snapshots_for_date: {
    params: { firmId: Ulid; clientId: Ulid; asOfDate: string };
    row: AgingSnapshotRow;
  };
  statement_documents_for_date: {
    params: { firmId: Ulid; clientId: Ulid; statementDate: string };
    row: StatementDocumentRow;
  };
  statement_items_for_statements: {
    params: { firmId: Ulid; clientId: Ulid; statementIds: Ulid[] };
    row: StatementItemRow;
  };
  writeoff_proposals_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: WriteoffProposalRow;
  };
  // Doc 02 module 6. Everything below is read by the six close runs.

  /**
   * The whole chart of one client, account number ascending. Module 6 iterates
   * the chart rather than a candidate list, because a tie out is a statement
   * about every substantiated account and an account nobody looked at is the
   * one that hides the variance.
   */
  chart_accounts_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: ChartAccountRow;
  };
  /** Every period of a client, period start ascending. */
  close_periods_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: ClosePeriodRow;
  };
  /** The tie out rows an earlier execution wrote for one period. */
  sub_tieouts_for_period: {
    params: { firmId: Ulid; clientId: Ulid; periodStart: string };
    row: SubTieoutRow;
  };
  /** Counts and registers that substantiate an account from outside the books. */
  substantiation_records_for_period: {
    params: { firmId: Ulid; clientId: Ulid; periodStart: string };
    row: SubstantiationRecordRow;
  };
  /**
   * Every document request of a client, not only the open ones. A satisfied
   * request is what makes a rerun refrain from asking again, so filtering it out
   * here would make the run repeat itself.
   */
  document_requests_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: DocumentRequestRow;
  };
  /** The gate result set for one period, gate code ascending. */
  close_gate_results_for_period: {
    params: { firmId: Ulid; clientId: Ulid; periodStart: string };
    row: CloseGateResultRow;
  };
  opening_balances_for_period: {
    params: { firmId: Ulid; clientId: Ulid; periodStart: string };
    row: OpeningBalanceRow;
  };
  closing_entries_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: ClosingEntryRow;
  };
  /**
   * Reconciliation batches whose period overlaps a window. Gates G02 and G03
   * read this, and so does the cash tie out, because the statement balance a
   * batch carries is the substantiation source for a bank account.
   */
  rec_batches_in_window: {
    params: { firmId: Ulid; clientId: Ulid; from: string; to: string };
    row: RecBatchRow;
  };
  /** Every suspense item of a client, withdrawn ones included. */
  suspense_items_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: SuspenseItemRow;
  };
  documentation_exceptions_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: DocumentationExceptionRow;
  };
  /**
   * Every posted entry of a client, entry date ascending. Gate G14 asks whether
   * anything is dated inside a locked period, and that question cannot be asked
   * of one window.
   */
  journal_entries_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: JournalEntryRow;
  };
  /**
   * Run log rows whose period start matches, ordered by start time. Gate G18
   * compares the actor who previewed a run against the actor who applied it, so
   * it needs the log and not the ledger.
   */
  run_log_for_period: {
    params: { firmId: Ulid; clientId: Ulid; periodStart: string };
    row: RunLogRow;
  };

  /** Bill date ascending then bill id ascending. */
  bills_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: BillRow;
  };
  vendor_credits_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: VendorCreditRow;
  };

  /**
   * Module 8 reporting reads. Every one of them is a read of a report table or
   * of a stored threshold. The reporting runs read ledger data through the
   * existing close queries, which is what keeps them readers on a locked period.
   */

  /** Budget rows for one period, account number ascending. */
  budgets_for_period: {
    params: { firmId: Ulid; clientId: Ulid; periodStart: string };
    row: BudgetRow;
  };
  /**
   * Every threshold row for the client, the default and the overrides together,
   * so the caller resolves precedence once in one place rather than issuing a
   * query per account.
   */
  budget_thresholds_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: BudgetThresholdRow;
  };
  report_packages_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: ReportPackageRow;
  };
  /** Sections under one package, catalog sequence ascending. */
  report_sections_for_package: {
    params: { firmId: Ulid; clientId: Ulid; packageId: Ulid };
    row: ReportSectionRow;
  };
  report_variances_for_period: {
    params: { firmId: Ulid; clientId: Ulid; periodStart: string };
    row: ReportVarianceRow;
  };
  cash_forecast_runs_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: CashForecastRunRow;
  };
  /** Week rows under one forecast header, week number ascending. */
  cash_forecast_weeks_for_run: {
    params: { firmId: Ulid; clientId: Ulid; forecastRunId: Ulid };
    row: CashForecastWeekRow;
  };
  report_narratives_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: ReportNarrativeRow;
  };
  /** Pay date ascending. The forecast walks these forward from its start date. */
  payroll_approvals_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: PayrollApprovalRow;
  };
  report_audit_events_for_client: {
    params: { firmId: Ulid; clientId: Ulid };
    row: ReportAuditEventRow;
  };
}

export type QueryName = keyof QueryCatalog;

export interface RunTx {
  readonly session: TxSession;
  query<K extends QueryName>(
    name: K,
    params: QueryCatalog[K]["params"],
  ): Promise<QueryCatalog[K]["row"][]>;
  /** Two key form. Returns false when another transaction holds the lock. */
  tryAdvisoryXactLock(highKey: string, lowKey: string): Promise<boolean>;
  insert<T extends TableName>(table: T, rows: RowMap[T][]): Promise<void>;
  update<T extends TableName>(
    table: T,
    rowId: string,
    patch: Partial<RowMap[T]>,
  ): Promise<void>;
}

export interface RunDb {
  tx<T>(session: TxSession, fn: (tx: RunTx) => Promise<T>): Promise<T>;
}

/** Raised when a write would land on a row carrying the manual override flag. */
export class OverrideProtectedError extends Error {
  readonly code = "OVERRIDE_PROTECTED_ROW";
  constructor(
    readonly table: string,
    readonly rowId: string,
  ) {
    super(`override_protected_row: ${table} ${rowId}`);
  }
}

/** Raised when a ledger write would land inside a locked period. */
export class LockedPeriodError extends Error {
  readonly code = "LOCKED_PERIOD";
  constructor(
    readonly date: string,
    readonly clientId: string,
  ) {
    super(`locked_period: ${date} is inside a locked period for client ${clientId}`);
  }
}

/** Raised when something tries to change an insert only log table. */
export class ImmutableLogError extends Error {
  readonly code = "IMMUTABLE_LOG";
  constructor(readonly table: string) {
    super(`insert_only_table: ${table} may not be updated or deleted`);
  }
}

/** Raised on a write write conflict under serializable isolation. */
export class SerializationFailure extends Error {
  readonly code = "SERIALIZATION_FAILURE";
  readonly retryable = true;
  constructor(readonly key: string) {
    super(`serialization_failure on ${key}`);
  }
}

/** Raised when an idempotency key is inserted twice for mode apply. */
export class UniqueViolation extends Error {
  readonly code = "UNIQUE_VIOLATION";
  constructor(readonly constraintName: string) {
    super(`unique_violation: ${constraintName}`);
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof SerializationFailure;
}

/** Sum of signed cents, used by tests and gates. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = BigInt(0);
  for (const v of values) total += v;
  return total;
}
