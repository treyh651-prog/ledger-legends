/**
 * Postgres implementation of the run port, written against the `pg` style API.
 *
 * It is not exercised in this sandbox because there is no Postgres here, and
 * `pg` is deliberately not installed, so the client type is declared
 * structurally below. Correctness is by inspection against doc 03.
 *
 * Points worth reading closely:
 *   Isolation is set on the transaction, serializable for anything that both
 *   reads and writes ledger rows.
 *   Tenant context and actor kind are set with set_config, which is what the
 *   override guard and the row level security policies read.
 *   The advisory lock is the two key form of pg_try_advisory_xact_lock, taken
 *   inside the transaction so it releases on commit or rollback.
 *   Every candidate query carries firm_id and client_id terms, because a
 *   missing tenant term is the failure mode doc 03 Part 12 calls out.
 *   Integer cents cross the wire as text and are converted with BigInt, never
 *   through Number.
 */

import {
  LockedPeriodError,
  OverrideProtectedError,
  SerializationFailure,
  UniqueViolation,
  type QueryCatalog,
  type QueryName,
  type RunDb,
  type RunTx,
  type TxSession,
} from "./db";
import type { RowMap, TableName } from "./tables";

export interface PgQueryResultLike<R> {
  rows: R[];
  rowCount: number | null;
}

export interface PgClientLike {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<PgQueryResultLike<R>>;
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
}

const SCHEMA = "ledger";

/**
 * Most run tables live in the ledger schema, but the import pipeline writes to
 * three tables that migration 0009 put in the import schema, and two of them
 * carry a different physical name than the row map key. Qualification is a
 * lookup rather than a prefix so the mismatch stays in one place.
 */
const PHYSICAL_TABLES: Partial<Record<TableName, string>> = {
  mapping_profiles: "import.mapping_profiles",
  import_batches: "import.batches",
  staged_rows: "import.staged_rows",
};

function physical(table: TableName): string {
  return PHYSICAL_TABLES[table] ?? `${SCHEMA}.${table}`;
}

/** Cents columns per table, converted from text to bigint on the way out. */
const CENTS_FIELDS: Record<string, readonly string[]> = {
  transactions: ["amountCents"],
  journal_lines: ["amountCents"],
  run_log_events: ["netCents"],
  import_batches: ["netCents"],
  staged_rows: ["amountCents"],
};

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function encodeParam(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

function decodeRow(table: string, row: Record<string, unknown>): unknown {
  const fields = CENTS_FIELDS[table] ?? [];
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    if (typeof out[f] === "string") out[f] = BigInt(out[f] as string);
    else if (typeof out[f] === "number") out[f] = BigInt(out[f] as number);
  }
  return out;
}

/**
 * Named query catalog as SQL. Column aliases produce camelCase keys so the row
 * types in tables.ts are the single definition of a row shape.
 */
interface SqlSpec {
  table: string;
  sql: string;
  params: (p: Record<string, unknown>) => unknown[];
}

const TXN_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId",
  bank_account_id as "bankAccountId", account_number as "accountNumber",
  posted_date::text as "postedDate",
  amount_cents::text as "amountCents", currency, description,
  normalized_vendor as "normalizedVendor", check_number as "checkNumber",
  bank_code as "bankCode", bank_transaction_id as "bankTransactionId",
  source, import_batch_id as "importBatchId", staged_row_id as "stagedRowId",
  category_id as "categoryId", cascade_level as "cascadeLevel",
  suspense_reason as "suspenseReason",
  paired_with_id as "pairedWithId", duplicate_flag as "duplicateFlag",
  journal_entry_id as "journalEntryId", cleared,
  cleared_date::text as "clearedDate", status,
  manual_override as "manualOverride", manual_override_by as "manualOverrideBy",
  manual_override_at::text as "manualOverrideAt", version`;

const MAPPING_PROFILE_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", version,
  institution_name as "institutionName", account_number as "accountNumber",
  file_format as "fileFormat", header_fingerprint as "headerFingerprint",
  header_row_number as "headerRowNumber", skip_rows as "skipRows",
  date_column as "dateColumn", date_format as "dateFormat",
  description_column as "descriptionColumn", amount_column as "amountColumn",
  debit_column as "debitColumn", credit_column as "creditColumn",
  sign_convention as "signConvention", currency,
  bank_id_column as "bankIdColumn",
  check_number_column as "checkNumberColumn",
  bank_code_column as "bankCodeColumn", is_active as "isActive"`;

const IMPORT_BATCH_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", name,
  source_format as "sourceFormat", bank_account_id as "bankAccountId",
  account_number as "accountNumber",
  mapping_profile_id as "mappingProfileId",
  mapping_profile_version as "mappingProfileVersion", status,
  reject_reason as "rejectReason", row_count as "rowCount",
  accepted_count as "acceptedCount", rejected_count as "rejectedCount",
  held_count as "heldCount", net_cents::text as "netCents",
  parsed_run_id as "parsedRunId", committed_run_id as "committedRunId",
  committed_at::text as "committedAt", reversed_run_id as "reversedRunId",
  reversed_at::text as "reversedAt", reversal_blocked as "reversalBlocked",
  created_at::text as "createdAt", version`;

const STAGED_ROW_COLUMNS = `
  id, batch_id as "batchId", firm_id as "firmId", client_id as "clientId",
  row_number as "rowNumber", raw_row as "rawRow",
  posted_on::text as "postedOn", description,
  normalized_description as "normalizedDescription",
  amount_cents::text as "amountCents", currency,
  account_number as "accountNumber", bank_account_id as "bankAccountId",
  bank_transaction_id as "bankTransactionId",
  check_number as "checkNumber", bank_code as "bankCode",
  dedup_state as "dedupState",
  duplicate_of_transaction_id as "duplicateOfTransactionId",
  review_state as "reviewState",
  committed_transaction_id as "committedTransactionId",
  committed_entry_id as "committedEntryId",
  error_code as "errorCode", error_message as "errorMessage", version`;

const RUN_LOG_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId", run_type as "runType",
  run_version as "runVersion", mode, status,
  idempotency_key as "idempotencyKey", scope_hash as "scopeHash",
  actor_id as "actorId", actor_kind as "actorKind", source,
  parent_sequence_id as "parentSequenceId", preview_run_id as "previewRunId",
  original_run_id as "originalRunId", period_start::text as "periodStart",
  period_end::text as "periodEnd", candidate_count as "candidateCount",
  candidate_ids as "candidateIds", scope_input as "scopeInput", versions,
  started_at::text as "startedAt", git_sha as "gitSha", release_id as "releaseId"`;

const JE_COLUMNS = `
  id, firm_id as "firmId", client_id as "clientId",
  entry_date::text as "entryDate", memo, posted, reversal_of as "reversalOf",
  reversed_by_entry_id as "reversedByEntryId",
  redated_from_locked_period::text as "redatedFromLockedPeriod",
  source_table as "sourceTable", source_row_id as "sourceRowId",
  source_version as "sourceVersion", created_by_run_id as "createdByRunId",
  run_type as "runType", run_version as "runVersion"`;

const QUERIES: Record<QueryName, SqlSpec> = {
  bank_accounts_for_client: {
    table: "bank_accounts",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            account_number as "accountNumber", nickname, kind,
            is_processor_destination as "isProcessorDestination"
          from ${SCHEMA}.bank_accounts
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  chart_account: {
    table: "chart_accounts",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            account_number as "accountNumber", name
          from ${SCHEMA}.chart_accounts
          where firm_id = $1 and client_id = $2 and account_number = $3
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.accountNumber],
  },
  open_period_locks: {
    table: "period_locks",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            period_start::text as "periodStart", period_end::text as "periodEnd",
            locked_at::text as "lockedAt", locked_by as "lockedBy",
            closed_with_exceptions as "closedWithExceptions",
            exception_note as "exceptionNote", unlocked_at::text as "unlockedAt",
            unlocked_by as "unlockedBy", unlock_reason as "unlockReason"
          from ${SCHEMA}.period_locks
          where firm_id = $1 and client_id = $2 and unlocked_at is null
          order by period_start asc, id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  transactions_in_window: {
    table: "transactions",
    sql: `select ${TXN_COLUMNS}
          from ${SCHEMA}.transactions
          where firm_id = $1
            and client_id = $2
            and posted_date between $3::date and $4::date
            and ($5::boolean or manual_override = false)
            and ($6::uuid[] is null or bank_account_id = any($6::uuid[]))
          order by posted_date asc, abs(amount_cents) asc, id asc`,
    params: (p) => [
      p.firmId,
      p.clientId,
      p.from,
      p.to,
      p.includeOverridden,
      p.bankAccountIds,
    ],
  },
  overridden_transaction_ids_in_window: {
    table: "transactions",
    sql: `select id
          from ${SCHEMA}.transactions
          where firm_id = $1
            and client_id = $2
            and posted_date between $3::date and $4::date
            and manual_override = true
          order by posted_date asc, abs(amount_cents) asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.from, p.to],
  },
  transfer_pairs_for_client: {
    table: "transfer_pairs",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            outbound_txn_id as "outboundTxnId", inbound_txn_id as "inboundTxnId",
            created_by_run_id as "createdByRunId",
            manually_confirmed as "manuallyConfirmed"
          from ${SCHEMA}.transfer_pairs
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  applied_run_by_idempotency_key: {
    table: "run_log",
    sql: `select ${RUN_LOG_COLUMNS}
          from ${SCHEMA}.run_log
          where mode = 'apply' and idempotency_key = $1
          order by started_at asc, id asc`,
    params: (p) => [p.idempotencyKey],
  },
  run_log_by_id: {
    table: "run_log",
    sql: `select ${RUN_LOG_COLUMNS}
          from ${SCHEMA}.run_log
          where firm_id = $1 and id = $2`,
    params: (p) => [p.firmId, p.executionId],
  },
  run_log_items_by_execution: {
    table: "run_log_items",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            run_execution_id as "runExecutionId", row_table as "rowTable",
            row_id as "rowId", decision, reason,
            cascade_level as "cascadeLevel", rule_id as "ruleId",
            rule_version as "ruleVersion", template_id as "templateId",
            template_version as "templateVersion",
            suspense_reason_code as "suspenseReasonCode",
            journal_entry_id as "journalEntryId", before_json as "beforeJson",
            after_json as "afterJson", proposal_json as "proposalJson",
            error_code as "errorCode", error_message as "errorMessage"
          from ${SCHEMA}.run_log_items
          where firm_id = $1 and run_execution_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.executionId],
  },
  run_log_events_by_execution: {
    table: "run_log_events",
    sql: `select id, firm_id as "firmId", run_execution_id as "runExecutionId",
            event, attempt, detail, proposal_count as "proposalCount",
            skip_count as "skipCount", error_count as "errorCount",
            net_cents::text as "netCents", entries_created as "entriesCreated",
            entries_reversed as "entriesReversed",
            skip_counts_by_reason as "skipCountsByReason",
            duration_ms as "durationMs", related_run_id as "relatedRunId",
            occurred_at::text as "occurredAt"
          from ${SCHEMA}.run_log_events
          where firm_id = $1 and run_execution_id = $2
          order by occurred_at asc, id asc`,
    params: (p) => [p.firmId, p.executionId],
  },
  started_runs_before: {
    table: "run_log",
    sql: `select ${RUN_LOG_COLUMNS}
          from ${SCHEMA}.run_log
          where status = 'started' and started_at <= $1::timestamptz
          order by started_at asc, id asc`,
    params: (p) => [p.before],
  },
  journal_entries_by_run: {
    table: "journal_entries",
    sql: `select ${JE_COLUMNS}
          from ${SCHEMA}.journal_entries
          where firm_id = $1 and created_by_run_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.executionId],
  },
  journal_entries_referencing: {
    table: "journal_entries",
    sql: `select ${JE_COLUMNS}
          from ${SCHEMA}.journal_entries
          where firm_id = $1 and client_id = $2
            and reversal_of = any($3::char(26)[])
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.entryIds],
  },
  journal_lines_for_client: {
    table: "journal_lines",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            entry_id as "entryId", account_number as "accountNumber",
            category_id as "categoryId", amount_cents::text as "amountCents",
            memo, entry_date::text as "entryDate", class_id as "classId",
            location_id as "locationId", program_id as "programId", restriction
          from ${SCHEMA}.journal_lines
          where firm_id = $1 and client_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.clientId],
  },
  suspense_items_by_run: {
    table: "suspense_items",
    sql: `select id, firm_id as "firmId", client_id as "clientId",
            transaction_id as "transactionId", reason_code as "reasonCode",
            account_number as "accountNumber", detail,
            related_ids as "relatedIds", created_by_run_id as "createdByRunId",
            withdrawn_by_run_id as "withdrawnByRunId"
          from ${SCHEMA}.suspense_items
          where firm_id = $1 and created_by_run_id = $2
          order by id asc`,
    params: (p) => [p.firmId, p.executionId],
  },
  transactions_by_ids: {
    table: "transactions",
    sql: `select ${TXN_COLUMNS}
          from ${SCHEMA}.transactions
          where firm_id = $1 and client_id = $2 and id = any($3::char(26)[])
          order by id asc`,
    params: (p) => [p.firmId, p.clientId, p.ids],
  },
  active_mapping_profile: {
    table: "mapping_profiles",
    sql: `select ${MAPPING_PROFILE_COLUMNS}
          from import.mapping_profiles
          where firm_id = $1 and client_id = $2
            and institution_name = $3 and file_format = $4
            and is_active = true
          order by version desc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.institutionName, p.fileFormat],
  },
  import_batch_by_id: {
    table: "import_batches",
    sql: `select ${IMPORT_BATCH_COLUMNS}
          from import.batches
          where firm_id = $1 and client_id = $2 and id = $3`,
    params: (p) => [p.firmId, p.clientId, p.batchId],
  },
  staged_rows_by_batch: {
    table: "staged_rows",
    sql: `select ${STAGED_ROW_COLUMNS}
          from import.staged_rows
          where firm_id = $1 and client_id = $2 and batch_id = $3
          order by row_number asc`,
    params: (p) => [p.firmId, p.clientId, p.batchId],
  },
  transactions_by_bank_ids: {
    table: "transactions",
    sql: `select ${TXN_COLUMNS}
          from ${SCHEMA}.transactions
          where firm_id = $1 and client_id = $2
            and bank_account_id = $3
            and bank_transaction_id = any($4::text[])
          order by posted_date asc, abs(amount_cents) asc, id asc`,
    params: (p) => [
      p.firmId,
      p.clientId,
      p.bankAccountId,
      p.bankTransactionIds,
    ],
  },
  transactions_for_account_window: {
    table: "transactions",
    sql: `select ${TXN_COLUMNS}
          from ${SCHEMA}.transactions
          where firm_id = $1 and client_id = $2
            and bank_account_id = $3
            and posted_date between $4::date and $5::date
          order by posted_date asc, abs(amount_cents) asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.bankAccountId, p.from, p.to],
  },
  transactions_by_batch: {
    table: "transactions",
    sql: `select ${TXN_COLUMNS}
          from ${SCHEMA}.transactions
          where firm_id = $1 and client_id = $2 and import_batch_id = $3
          order by posted_date asc, abs(amount_cents) asc, id asc`,
    params: (p) => [p.firmId, p.clientId, p.batchId],
  },
};

function translateError(err: unknown): unknown {
  const e = err as PgErrorLike;
  if (!e || typeof e !== "object") return err;
  if (e.code === "40001" || e.code === "40P01") {
    return new SerializationFailure(e.message ?? "serialization");
  }
  if (e.code === "23505" || e.code === "23P01") {
    return new UniqueViolation(e.constraint ?? "unique");
  }
  const message = e.message ?? "";
  if (message.startsWith("override_protected_row")) {
    const parts = message.split(" ");
    return new OverrideProtectedError(parts[1] ?? "unknown", parts[2] ?? "unknown");
  }
  if (message.startsWith("locked_period")) {
    return new LockedPeriodError("unknown", "unknown");
  }
  return err;
}

class PostgresTx implements RunTx {
  constructor(
    private readonly client: PgClientLike,
    readonly session: TxSession,
  ) {}

  async query<K extends QueryName>(
    name: K,
    params: QueryCatalog[K]["params"],
  ): Promise<QueryCatalog[K]["row"][]> {
    const spec = QUERIES[name];
    try {
      const res = await this.client.query<Record<string, unknown>>(
        spec.sql,
        spec.params(params as unknown as Record<string, unknown>).map(encodeParam),
      );
      return res.rows.map(
        (r) => decodeRow(spec.table, r) as QueryCatalog[K]["row"],
      );
    } catch (err) {
      throw translateError(err);
    }
  }

  async tryAdvisoryXactLock(highKey: string, lowKey: string): Promise<boolean> {
    const res = await this.client.query<{ locked: boolean }>(
      `select pg_try_advisory_xact_lock(hashtext($1::text), hashtext($2::text)) as locked`,
      [highKey, lowKey],
    );
    return res.rows.length > 0 && res.rows[0].locked === true;
  }

  async insert<T extends TableName>(table: T, rows: RowMap[T][]): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      const entries = Object.entries(row as unknown as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      );
      const cols = entries.map(([k]) => camelToSnake(k)).join(", ");
      const placeholders = entries.map((_e, i) => `$${i + 1}`).join(", ");
      const values = entries.map(([, v]) => encodeParam(v));
      try {
        await this.client.query(
          `insert into ${physical(table)} (${cols}) values (${placeholders})`,
          values,
        );
      } catch (err) {
        throw translateError(err);
      }
    }
  }

  async update<T extends TableName>(
    table: T,
    rowId: string,
    patch: Partial<RowMap[T]>,
  ): Promise<void> {
    const entries = Object.entries(patch as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return;
    const sets = entries
      .map(([k], i) => `${camelToSnake(k)} = $${i + 1}`)
      .join(", ");
    const values = entries.map(([, v]) => encodeParam(v));
    values.push(rowId);
    values.push(this.session.firmId);
    try {
      await this.client.query(
        `update ${physical(table)} set ${sets}
         where id = $${values.length - 1} and firm_id = $${values.length}`,
        values,
      );
    } catch (err) {
      throw translateError(err);
    }
  }
}

export class PostgresRunDb implements RunDb {
  constructor(private readonly pool: PgPoolLike) {}

  async tx<T>(session: TxSession, fn: (tx: RunTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const isolation =
      session.isolation === "serializable" ? "serializable" : "repeatable read";
    try {
      await client.query(
        `begin isolation level ${isolation}${session.readOnly ? " read only" : ""}`,
      );
      // Tenant context and actor kind, read by the guards and the RLS policies.
      await client.query(
        `select set_config('app.firm_id', $1, true),
                set_config('app.client_id', $2, true),
                set_config('app.actor_id', $3, true),
                set_config('app.actor_kind', $4, true)`,
        [session.firmId, session.clientId, session.actorId, session.actorKind],
      );
      const out = await fn(new PostgresTx(client, session));
      await client.query("commit");
      return out;
    } catch (err) {
      try {
        await client.query("rollback");
      } catch {
        // A rollback failure on a dead connection is not the interesting error.
      }
      throw translateError(err);
    } finally {
      client.release();
    }
  }
}
