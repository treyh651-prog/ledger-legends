-- 0020: run id columns hold a run id
--
-- Every id this framework mints is a prefix plus a 26 character ULID.
-- `server/runs/ids.ts` mints a run execution id as 'RUNX-' plus a ULID, so 31
-- characters, and `server/runs/sequence.ts` mints a sequence id as 'RUNSEQ-'
-- plus a ULID, so 33. Migrations 0003 through 0014 sized their run id columns
-- char(26), which is the ULID on its own, so the first run that writes to
-- Postgres refuses with value too long for type character(26), part way through
-- a run rather than at startup. Migrations 0015 through 0019 used char(31), so
-- the schema answered the same question two ways.
--
-- Every run id column becomes text with a named length check. Three reasons.
-- The limit stays stated and stays visible, in a constraint name a failure
-- message will carry. There is no blank padding, so a comparison against an
-- unpadded literal cannot silently match nothing the way bpchar can. And the
-- next prefix that grows is a constraint change rather than a table rewrite.
-- Uniformity matters more than the choice, so the columns that were already
-- char(31) or char(33) convert as well. A schema where half the run id columns
-- are bpchar and half are text is worse than either.
--
-- The check reads at most rather than exactly, because a shorter id is not the
-- failure this guards against. An id too long is refused at the write, which is
-- the whole point, and an id too short is a malformed value question that
-- belongs to whatever mints it.
--
-- Three columns whose name ends in run_id are deliberately left at char(26),
-- because their row field is typed Ulid and the value is an entity id rather
-- than a run execution id: ledger.close_gate_results.close_run_id references
-- ledger.close_runs(id), report.cash_forecast_weeks.forecast_run_id references
-- report.cash_forecast_runs(id), and subledger.pay_register_entries.pay_run_id
-- references subledger.pay_runs(id). Widening those would say something untrue
-- about what they hold and would break two foreign keys.
--
-- The partitioned parents ledger.run_log and ledger.run_log_items are altered
-- once each. A type change on a partitioned table reaches every partition, so
-- the twelve monthly partitions of each are not named here and cannot end up
-- at a different width from their parent. The partial unique idempotency index
-- lives on each partition and is keyed on idempotency_key, not on a run id, so
-- nothing rebuilds it. Verified before writing this: no view, no generated
-- column and no foreign key depends on any column below.
--
-- Sections 2 and 3 finish the array work migration 0019 started.

begin;

-- 1. Run id columns -----------------------------------------------------------
-- evaluated_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table close.close_gate_results
  alter column evaluated_by_run_id type text;
alter table close.close_gate_results
  add constraint evaluated_by_run_id_width check (char_length(evaluated_by_run_id) <= 31);

-- posted_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table close.closing_entries
  alter column posted_by_run_id type text;
alter table close.closing_entries
  add constraint posted_by_run_id_width check (char_length(posted_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table close.document_requests
  alter column created_by_run_id type text;
alter table close.document_requests
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table close.opening_balances
  alter column created_by_run_id type text;
alter table close.opening_balances
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- locked_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
-- opened_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table close.periods
  alter column locked_by_run_id type text,
  alter column opened_by_run_id type text;
alter table close.periods
  add constraint locked_by_run_id_width check (char_length(locked_by_run_id) <= 31);
alter table close.periods
  add constraint opened_by_run_id_width check (char_length(opened_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table close.sub_tieouts
  alter column created_by_run_id type text;
alter table close.sub_tieouts
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- built_run_id: char(26), too narrow to hold one, limit 31
alter table deliverable.cpa_handoff_packages
  alter column built_run_id type text;
alter table deliverable.cpa_handoff_packages
  add constraint built_run_id_width check (char_length(built_run_id) <= 31);

-- built_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table deliverable.cpa_handoffs
  alter column built_by_run_id type text;
alter table deliverable.cpa_handoffs
  add constraint built_by_run_id_width check (char_length(built_by_run_id) <= 31);

-- built_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table deliverable.offboard_exports
  alter column built_by_run_id type text;
alter table deliverable.offboard_exports
  add constraint built_by_run_id_width check (char_length(built_by_run_id) <= 31);

-- built_run_id: char(26), too narrow to hold one, limit 31
alter table deliverable.offboarding_exports
  alter column built_run_id type text;
alter table deliverable.offboarding_exports
  add constraint built_run_id_width check (char_length(built_run_id) <= 31);

-- run_id: char(26), too narrow to hold one, limit 31
alter table docvault.audit_events
  alter column run_id type text;
alter table docvault.audit_events
  add constraint run_id_width check (char_length(run_id) <= 31);

-- committed_run_id: char(26), too narrow to hold one, limit 31
-- parsed_run_id: char(26), too narrow to hold one, limit 31
-- reversed_run_id: char(26), too narrow to hold one, limit 31
alter table import.batches
  alter column committed_run_id type text,
  alter column parsed_run_id type text,
  alter column reversed_run_id type text;
alter table import.batches
  add constraint committed_run_id_width check (char_length(committed_run_id) <= 31);
alter table import.batches
  add constraint parsed_run_id_width check (char_length(parsed_run_id) <= 31);
alter table import.batches
  add constraint reversed_run_id_width check (char_length(reversed_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table import.mapping_profile_columns
  alter column created_by_run_id type text;
alter table import.mapping_profile_columns
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- balances_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
-- chart_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
-- requests_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
-- tasks_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table intake.wizard_sessions
  alter column balances_run_id type text,
  alter column chart_run_id type text,
  alter column created_by_run_id type text,
  alter column requests_run_id type text,
  alter column tasks_run_id type text;
alter table intake.wizard_sessions
  add constraint balances_run_id_width check (char_length(balances_run_id) <= 31);
alter table intake.wizard_sessions
  add constraint chart_run_id_width check (char_length(chart_run_id) <= 31);
alter table intake.wizard_sessions
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);
alter table intake.wizard_sessions
  add constraint requests_run_id_width check (char_length(requests_run_id) <= 31);
alter table intake.wizard_sessions
  add constraint tasks_run_id_width check (char_length(tasks_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table ledger.documentation_exceptions
  alter column created_by_run_id type text;
alter table ledger.documentation_exceptions
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- run_id: char(26), too narrow to hold one, limit 31
alter table ledger.journal_entries
  alter column run_id type text;
alter table ledger.journal_entries
  add constraint run_id_width check (char_length(run_id) <= 31);

-- locked_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table ledger.period_locks
  alter column locked_by_run_id type text;
alter table ledger.period_locks
  add constraint locked_by_run_id_width check (char_length(locked_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table ledger.portal_requests
  alter column created_by_run_id type text;
alter table ledger.portal_requests
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- closed_by_run_id: char(26), too narrow to hold one, limit 31
-- opened_by_run_id: char(26), too narrow to hold one, limit 31
alter table ledger.rec_batches
  alter column closed_by_run_id type text,
  alter column opened_by_run_id type text;
alter table ledger.rec_batches
  add constraint closed_by_run_id_width check (char_length(closed_by_run_id) <= 31);
alter table ledger.rec_batches
  add constraint opened_by_run_id_width check (char_length(opened_by_run_id) <= 31);

-- id: char(26), too narrow to hold one, limit 31
-- original_run_id: char(26), too narrow to hold one, limit 31
-- preview_run_id: char(26), too narrow to hold one, limit 31
-- sequence_id: char(26), too narrow to hold one, limit 33
alter table ledger.run_log
  alter column id type text,
  alter column original_run_id type text,
  alter column preview_run_id type text,
  alter column sequence_id type text;
alter table ledger.run_log
  add constraint id_width check (char_length(id) <= 31);
alter table ledger.run_log
  add constraint original_run_id_width check (char_length(original_run_id) <= 31);
alter table ledger.run_log
  add constraint preview_run_id_width check (char_length(preview_run_id) <= 31);
alter table ledger.run_log
  add constraint sequence_id_width check (char_length(sequence_id) <= 33);

-- run_id: char(26), too narrow to hold one, limit 31
alter table ledger.run_log_events
  alter column run_id type text;
alter table ledger.run_log_events
  add constraint run_id_width check (char_length(run_id) <= 31);

-- run_id: char(26), too narrow to hold one, limit 31
alter table ledger.run_log_items
  alter column run_id type text;
alter table ledger.run_log_items
  add constraint run_id_width check (char_length(run_id) <= 31);

-- id: char(33), already wide enough, converted so every run id column is one type, limit 33
alter table ledger.run_sequences
  alter column id type text;
alter table ledger.run_sequences
  add constraint id_width check (char_length(id) <= 33);

-- matched_by_run_id: char(26), too narrow to hold one, limit 31
alter table ledger.statement_lines
  alter column matched_by_run_id type text;
alter table ledger.statement_lines
  add constraint matched_by_run_id_width check (char_length(matched_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
-- withdrawn_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table ledger.suspense_items
  alter column created_by_run_id type text,
  alter column withdrawn_by_run_id type text;
alter table ledger.suspense_items
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);
alter table ledger.suspense_items
  add constraint withdrawn_by_run_id_width check (char_length(withdrawn_by_run_id) <= 31);

-- reversed_by_run_id: char(26), too narrow to hold one, limit 31
alter table ledger.transactions
  alter column reversed_by_run_id type text;
alter table ledger.transactions
  add constraint reversed_by_run_id_width check (char_length(reversed_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table ledger.transfer_pairs
  alter column created_by_run_id type text;
alter table ledger.transfer_pairs
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table practice.escalations
  alter column created_by_run_id type text;
alter table practice.escalations
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table practice.request_nudges
  alter column created_by_run_id type text;
alter table practice.request_nudges
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table practice.tasks
  alter column created_by_run_id type text;
alter table practice.tasks
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table practice.workload_notices
  alter column created_by_run_id type text;
alter table practice.workload_notices
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- built_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table report.cash_forecast_runs
  alter column built_by_run_id type text;
alter table report.cash_forecast_runs
  add constraint built_by_run_id_width check (char_length(built_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table report.cash_forecast_weeks
  alter column created_by_run_id type text;
alter table report.cash_forecast_weeks
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table report.report_audit_events
  alter column created_by_run_id type text;
alter table report.report_audit_events
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- composed_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table report.report_narratives
  alter column composed_by_run_id type text;
alter table report.report_narratives
  add constraint composed_by_run_id_width check (char_length(composed_by_run_id) <= 31);

-- built_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table report.report_packages
  alter column built_by_run_id type text;
alter table report.report_packages
  add constraint built_by_run_id_width check (char_length(built_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table report.report_sections
  alter column created_by_run_id type text;
alter table report.report_sections
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table report.report_variances
  alter column created_by_run_id type text;
alter table report.report_variances
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- created_by_run_id: char(26), too narrow to hold one, limit 31
alter table subledger.aging_snapshots
  alter column created_by_run_id type text;
alter table subledger.aging_snapshots
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- posted_run_id: char(26), too narrow to hold one, limit 31
alter table subledger.deferral_lines
  alter column posted_run_id type text;
alter table subledger.deferral_lines
  add constraint posted_run_id_width check (char_length(posted_run_id) <= 31);

-- posted_run_id: char(26), too narrow to hold one, limit 31
alter table subledger.depreciation_schedule
  alter column posted_run_id type text;
alter table subledger.depreciation_schedule
  add constraint posted_run_id_width check (char_length(posted_run_id) <= 31);

-- posted_run_id: char(26), too narrow to hold one, limit 31
alter table subledger.loan_schedule
  alter column posted_run_id type text;
alter table subledger.loan_schedule
  add constraint posted_run_id_width check (char_length(posted_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
-- posted_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table subledger.pay_register_entries
  alter column created_by_run_id type text,
  alter column posted_run_id type text;
alter table subledger.pay_register_entries
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);
alter table subledger.pay_register_entries
  add constraint posted_run_id_width check (char_length(posted_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
-- posted_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table subledger.pay_runs
  alter column created_by_run_id type text,
  alter column posted_run_id type text;
alter table subledger.pay_runs
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);
alter table subledger.pay_runs
  add constraint posted_run_id_width check (char_length(posted_run_id) <= 31);

-- created_by_run_id: char(26), too narrow to hold one, limit 31
alter table subledger.payment_applications
  alter column created_by_run_id type text;
alter table subledger.payment_applications
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- approval_run_id: char(26), too narrow to hold one, limit 31
-- posting_run_id: char(26), too narrow to hold one, limit 31
alter table subledger.payroll_approvals
  alter column approval_run_id type text,
  alter column posting_run_id type text;
alter table subledger.payroll_approvals
  add constraint approval_run_id_width check (char_length(approval_run_id) <= 31);
alter table subledger.payroll_approvals
  add constraint posting_run_id_width check (char_length(posting_run_id) <= 31);

-- created_by_run_id: char(26), too narrow to hold one, limit 31
alter table subledger.statement_documents
  alter column created_by_run_id type text;
alter table subledger.statement_documents
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- created_by_run_id: char(26), too narrow to hold one, limit 31
alter table subledger.vendor_credits
  alter column created_by_run_id type text;
alter table subledger.vendor_credits
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- created_by_run_id: char(26), too narrow to hold one, limit 31
alter table subledger.writeoff_proposals
  alter column created_by_run_id type text;
alter table subledger.writeoff_proposals
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table tax.data_lines
  alter column created_by_run_id type text;
alter table tax.data_lines
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- built_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table tax.data_sets
  alter column built_by_run_id type text;
alter table tax.data_sets
  add constraint built_by_run_id_width check (char_length(built_by_run_id) <= 31);

-- created_by_run_id: char(31), already wide enough, converted so every run id column is one type, limit 31
alter table tax.w9_states
  alter column created_by_run_id type text;
alter table tax.w9_states
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

-- 2. ledger.run_log.candidate_ids ---------------------------------------------
--
-- The port JSON stringifies every array before it reaches the driver, so
-- '["01J...","01J..."]' arrives at a char(26)[] column and Postgres refuses it
-- with 22P02 malformed array literal. Confirmed live during migration 0019,
-- which moved run_sequences.child_run_ids and suspense_items.related_ids to
-- jsonb for this reason and left this column behind. Every run writes an intent
-- row carrying its candidate ids, so this is the one array column a run cannot
-- avoid. The cast to text[] before to_jsonb is not decoration: bpchar pads to
-- the declared width, casting to text drops the trailing blanks, and a padded id
-- is not the id the run holds in memory. A transform expression may not contain
-- a subquery, so the trim has to ride on the cast rather than on an unnest.
alter table ledger.run_log
  alter column candidate_ids type jsonb
  using to_jsonb(candidate_ids::text[]);

-- 3. subledger.vendors.aliases ------------------------------------------------
--
-- The last array column a run can reach. Nothing writes a vendor through the
-- port today, only the read at vendors_for_client, so this has not failed yet,
-- which is the same sentence the run id widths earned. VendorRow.aliases is a
-- string[] and the first insert or update of a vendor would refuse for the same
-- reason candidate_ids did. The gin index is recreated on the jsonb column, so
-- an alias containment lookup keeps an index to use.
drop index if exists subledger.vendors_alias_gin;
alter table subledger.vendors
  alter column aliases drop default;
alter table subledger.vendors
  alter column aliases type jsonb
  using to_jsonb(coalesce(aliases, '{}'::text[]));
alter table subledger.vendors
  alter column aliases set default '[]'::jsonb;
alter table subledger.vendors
  add constraint vendors_aliases_is_array check (jsonb_typeof(aliases) = 'array');
create index vendors_alias_gin on subledger.vendors using gin (aliases);

commit;
