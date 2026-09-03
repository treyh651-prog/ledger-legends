-- 0017_compliance_practice.sql
-- Doc 02 module 8 tax, doc 02 module 9 practice, and the four doc 05 runs that
-- had no storage: PAY-APPROVE-RUN, PAY-POST-REGISTER, CPA-BUILD-HANDOFF, and
-- OFFBOARD-BUILD-EXPORT.
--
-- Migrations 0001 through 0016 built the ledger, the import pipeline, the coding
-- cascade, reconciliation, the period end subledgers, the receivable and payable
-- subledger, the close, and the report schema. None of them created a place to
-- record a compiled 1099 data set, a W-9 collection state, a practice task, an
-- escalation, a workload notice, a nudge decision, an approved payroll run, a
-- posted payroll register, a CPA handoff archive, or an offboarding export. The
-- nine runs in this module cannot be written against the schema as it stands, so
-- this migration creates three schemas worth of storage rather than only adding
-- columns.
--
-- What is created here, and why each table has to exist:
--
--   1. tax.thresholds. Doc 02 TAX-BUILD-1099 rule 1 says the 1099 threshold is
--      read from a dated configuration table and never from a constant. Two
--      rows are seeded: 60000 cents for payments dated before January 1, 2026
--      and 200000 cents on or after, following section 70433 of the One Big
--      Beautiful Bill Act. A rerun of calendar year 2025 therefore produces 600
--      dollar behavior with no code change. The table is firm scoped because a
--      federal threshold is not a per client fact. See NOTES.md entry 112.
--   2. tax.data_sets and tax.data_lines. The compiled payee data set handed to
--      the client's CPA. One header per client per calendar year, one line per
--      payee per form box. COMPILATION ONLY, which is a column that can hold
--      one value and a constraint that enforces it.
--   3. tax.w9_states. One row per vendor per year carrying the collection state,
--      the request behind it, and the last four digits of the taxpayer
--      identification number and nothing more of it.
--   4. practice.practice_states. One row per client carrying the stage, the
--      three named holders, the escalation ladder days, the unavailable member
--      list, and the paused and at risk flags. Doc 02 module 9 reads all of
--      these and tenancy.clients carries none of them. See NOTES.md entry 114.
--   5. practice.task_catalog and practice.tasks. The catalog of standard work
--      and the generated rows, one per client per period per catalog code.
--   6. practice.escalations. Append only. Doc 02 PRAC-ESCALATE-OVERDUE says an
--      escalation record is never deleted, so the table is insert only and the
--      reversal shape does not exist for it.
--   7. practice.workload_notices. One row per firm member per as of date with
--      the overdue count and the oldest overdue task, which is the surface the
--      brief asks for.
--   8. practice.request_nudges. The nudge decision log. There is no address
--      column and no message body column anywhere in it, because nothing in
--      this module sends anything.
--   9. subledger.pay_runs and subledger.pay_register_entries. D5 separates
--      approval from posting. An approved pay run authorizes no disbursement,
--      which is a boolean column with a check constraint rather than a sentence
--      in a comment, and the register entry row is the one place a payroll
--      journal entry may come from.
--  10. deliverable.cpa_handoffs and deliverable.offboard_exports. The two
--      archive headers, each carrying its manifest as jsonb, its checksum, the
--      ledger fingerprint it was built from, and the D7 vault retention stamps.
--
-- Migration 0010 already created subledger.payroll_approvals,
-- deliverable.cpa_handoff_packages, and deliverable.offboarding_exports against
-- vault.documents with a not null register reference. Those tables assume bytes
-- already exist in the vault, which a run cannot produce. The four runs here
-- carry the object key they will occupy instead, the same call NOTES.md entry
-- 101 made for the report package, so the 0010 tables are left untouched and
-- these are the run owned tables. See NOTES.md entry 117.
--
-- Every money column is bigint integer cents, debit positive and credit
-- negative, per doc 00 Part 1. Every table a run writes carries a version
-- column and the manual override columns with the override guard trigger,
-- because the override contract in doc 03 Part 6 is a property of the store.
--
-- COMPLIANCE. Ledger Legends is not a CPA firm. Nothing in this migration files,
-- issues, submits, or transmits a tax document. tax.data_sets holds compiled
-- data provided to the client's CPA for filing. There is no form number column,
-- no transmitter control code, no submission identifier, and no filed at
-- timestamp anywhere in this file, because no run may create one. There is also
-- no address, recipient, or message body column, because no run in this module
-- sends anything.
--
-- CONSTRAINT. No model, no score, no learned parameter. Every column holds
-- either a figure another run produced, a stored threshold, or a stored setting
-- a person set.
--
-- Forward only. No down migration.

begin;

create schema if not exists tax;
create schema if not exists practice;
grant usage on schema tax to app_web, app_worker;
grant usage on schema practice to app_web, app_worker;

-- ---------------------------------------------------------------------------
-- 0. Vendor columns the tax module reads.
--
-- Doc 02 TAX-BUILD-1099 reads vendor entity type, because a corporation is
-- excluded and an incorporated attorney is not. Migration 0015 gave the vendor a
-- W-9 flag and an expiry and stopped there. The entity type belongs on the
-- vendor rather than in a parallel table, because it is a fact about the payee
-- furnished on the W-9 and not a fact about a data set.
--
-- payment_hold is the flag the brief names: a vendor with no W-9 that carries a
-- hold is left out of the compiled set entirely rather than compiled with a
-- warning, because a hold is a decision a person made about that payee.
--
-- tin_last4 is four characters wide on purpose. There is nowhere in this schema
-- to put a full taxpayer identification number, which is what makes doc 02
-- TAX-TRACK-W9 rule 5 enforceable rather than aspirational.
-- ---------------------------------------------------------------------------

alter table subledger.vendors
  add column entity_type text not null default 'unknown',
  add column payment_hold boolean not null default false,
  add column tin_last4 char(4);

alter table subledger.vendors
  add constraint vendor_entity_type check (entity_type in (
    'individual','sole_proprietor','partnership','llc','c_corporation',
    's_corporation','government','tax_exempt','unknown'));

alter table subledger.vendors
  add constraint vendor_tin_last4 check (tin_last4 is null or tin_last4 ~ '^[0-9]{4}$');

-- ---------------------------------------------------------------------------
-- 1. The dated 1099 threshold. Configuration, never a constant.
--
-- effective_to is null on the open ended row. A run selects the row whose range
-- contains January 1 of the reporting year, so the answer for a year never
-- depends on the day the run happens to execute.
-- ---------------------------------------------------------------------------

create table tax.thresholds (
  id             char(26) primary key,        -- ULID
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  form_family    text not null default '1099',
  effective_from date not null,
  effective_to   date,
  threshold_cents bigint not null,
  source_note    text not null default '',

  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint threshold_family check (form_family in ('1099')),
  constraint threshold_window check (effective_to is null or effective_to >= effective_from),
  constraint threshold_positive check (threshold_cents > 0),
  constraint threshold_one_per_start unique (firm_id, form_family, effective_from)
);

create index thresholds_firm on tax.thresholds (firm_id, effective_from);

-- ---------------------------------------------------------------------------
-- 2. The compiled payee data set.
--
-- compilation_only can hold one value. The constraint is the point: a later
-- change that wanted to mark a data set as filed would have to drop a named
-- constraint, which is a visible act rather than a quiet one.
-- ---------------------------------------------------------------------------

create table tax.data_sets (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  tax_year       integer not null,
  period_start   date not null,
  period_end     date not null,

  threshold_cents bigint not null,
  threshold_effective_from date not null,
  threshold_effective_to   date,

  payee_count      integer not null default 0,
  reportable_count integer not null default 0,
  approaching_count integer not null default 0,
  excluded_count   integer not null default 0,
  backup_withholding_count integer not null default 0,
  reportable_total_cents bigint not null default 0,
  excluded_card_total_cents bigint not null default 0,

  state          text not null default 'compiled',
  -- One value only. This data set is never a filing.
  compilation_only boolean not null default true,
  handoff_statement text not null,

  content_checksum char(64) not null,
  ledger_fingerprint char(64) not null,

  vault_object_key text not null,
  vault_object_lock_mode text not null default 'GOVERNANCE',
  vault_retention_starts_on date not null,
  vault_object_lock_until date not null,

  built_by_run_id char(31),
  built_at       timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint data_set_one_per_year unique (client_id, tax_year),
  constraint data_set_state check (state in ('compiled')),
  constraint data_set_compilation_only check (compilation_only = true),
  constraint data_set_window check (period_end >= period_start),
  constraint data_set_lock_mode check (vault_object_lock_mode = 'GOVERNANCE'),
  constraint data_set_counts_nonneg check (
    payee_count >= 0 and reportable_count >= 0 and approaching_count >= 0
    and excluded_count >= 0 and backup_withholding_count >= 0)
);

create index data_sets_year on tax.data_sets (client_id, tax_year desc);

-- ---------------------------------------------------------------------------
-- 3. One compiled line per payee per form box.
--
-- A payee with amounts in two classes produces two lines, per doc 02 rule 5,
-- and both are measured against the aggregate payee total rather than the box
-- total, which is why payee_total_cents sits on every line.
-- ---------------------------------------------------------------------------

create table tax.data_lines (
  id             char(26) primary key,        -- ULID
  data_set_id    char(26) not null references tax.data_sets(id),
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  payee_id       char(26) not null,
  payee_name     text not null,
  class_1099     text not null,
  form_code      text not null,
  box_code       text not null,

  gross_paid_cents bigint not null,
  excluded_card_cents bigint not null default 0,
  excluded_class_none_cents bigint not null default 0,
  reportable_cents bigint not null,
  payee_total_cents bigint not null,

  state          text not null,
  w9_state       text not null,
  backup_withholding_required boolean not null default false,
  entity_excluded boolean not null default false,
  attorney_exception_applied boolean not null default false,
  -- Four characters, and there is nowhere here to put more than four.
  tin_last4      char(4),
  reason         text not null,

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint data_line_one_per_box unique (data_set_id, payee_id, box_code),
  constraint data_line_class check (class_1099 in ('nec','attorney','misc_rent','misc_other')),
  constraint data_line_form check (form_code in ('1099-NEC','1099-MISC')),
  constraint data_line_box check (box_code in ('NEC-1','MISC-1','MISC-3','MISC-10')),
  constraint data_line_state check (state in ('reportable','approaching_threshold')),
  constraint data_line_w9 check (w9_state in (
    'on_file_complete','on_file_incomplete','requested_pending','requested_overdue','missing')),
  constraint data_line_tin_last4 check (tin_last4 is null or tin_last4 ~ '^[0-9]{4}$'),
  constraint data_line_amounts_nonneg check (
    gross_paid_cents >= 0 and excluded_card_cents >= 0
    and excluded_class_none_cents >= 0 and reportable_cents >= 0
    and payee_total_cents >= 0)
);

create index data_lines_set on tax.data_lines (client_id, data_set_id);
create index data_lines_payee on tax.data_lines (client_id, payee_id);

-- ---------------------------------------------------------------------------
-- 4. W-9 collection state per vendor per year.
--
-- Two columns describe the state because the brief and doc 02 ask two different
-- questions. state is the collection stage the brief names, and status_code is
-- the ordered five value list doc 02 rule 1 assigns. They are stored separately
-- rather than derived from one another, so a reader can see both answers.
-- ---------------------------------------------------------------------------

create table tax.w9_states (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  tax_year       integer not null,
  vendor_id      char(26) not null,
  vendor_name    text not null,

  state          text not null,
  status_code    text not null,
  requested_on   date,
  received_on    date,
  expires_on     date,
  on_file        boolean not null default false,
  request_id     char(26),
  escalation     text not null default 'none',
  age_days       integer not null default 0,
  tin_last4      char(4),

  as_of_date     date not null,
  last_refreshed_on date,
  refresh_count  integer not null default 0,
  detail         text not null default '',

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint w9_one_per_vendor_year unique (client_id, vendor_id, tax_year),
  constraint w9_state check (state in (
    'not_requested','requested','received','on_file','expired')),
  constraint w9_status_code check (status_code in (
    'on_file_complete','on_file_incomplete','requested_pending','requested_overdue','missing')),
  constraint w9_escalation check (escalation in ('none','lead')),
  constraint w9_tin_last4 check (tin_last4 is null or tin_last4 ~ '^[0-9]{4}$'),
  constraint w9_age_nonneg check (age_days >= 0 and refresh_count >= 0)
);

create index w9_states_year on tax.w9_states (client_id, tax_year desc);

-- ---------------------------------------------------------------------------
-- 5. The practice state of one client.
--
-- One row per client. It carries the stage, the three named holders the
-- escalation ladder points at, the ladder days themselves, the members who are
-- unavailable for the period, and the paused and at risk flags. Doc 02 module 9
-- calls the ladder configurable per client, which means the days are data.
-- ---------------------------------------------------------------------------

create table practice.practice_states (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  client_name    text not null,
  stage          text not null default 'active',
  service_frequency text not null default 'monthly',

  lead_id        char(26),
  preparer_id    char(26),
  partner_id     char(26),
  unavailable_member_ids jsonb not null default '[]',
  out_of_office_member_ids jsonb not null default '[]',

  escalation_assignee_days integer not null default 1,
  escalation_lead_days     integer not null default 3,
  escalation_partner_days  integer not null default 7,
  escalation_at_risk_days  integer not null default 14,

  engagement_paused boolean not null default false,
  nudges_paused    boolean not null default false,
  at_risk          boolean not null default false,
  at_risk_set_on   date,

  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint practice_one_per_client unique (client_id),
  constraint practice_stage check (stage in (
    'prospect','onboarding','active','paused','offboarded')),
  constraint practice_frequency check (service_frequency in (
    'monthly','quarterly','annual')),
  constraint practice_ladder_ordered check (
    escalation_assignee_days < escalation_lead_days
    and escalation_lead_days < escalation_partner_days
    and escalation_partner_days < escalation_at_risk_days),
  constraint practice_ladder_positive check (escalation_assignee_days > 0)
);

create index practice_states_firm on practice.practice_states (firm_id);

-- ---------------------------------------------------------------------------
-- 6. The task catalog and the generated tasks.
--
-- due_offset_days counts forward from the period end, which is where a
-- bookkeeping deadline actually hangs. A weekend result shifts to the following
-- Monday, per doc 02, and there is no holiday calendar, which the run states in
-- words rather than pretending otherwise.
-- ---------------------------------------------------------------------------

create table practice.task_catalog (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  catalog_code   text not null,
  title          text not null,
  kind           text not null,
  role           text not null,
  scope_key      text,
  gate_code      text,
  predecessor_code text,
  due_offset_days integer not null default 0,
  frequency      text not null default 'monthly',
  is_active      boolean not null default true,

  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint catalog_one_per_code unique (client_id, catalog_code),
  constraint catalog_kind check (kind in ('checklist','deadline','gate_target')),
  constraint catalog_role check (role in ('preparer','reviewer')),
  constraint catalog_frequency check (frequency in ('monthly','quarterly','annual')),
  constraint catalog_gate_target_has_gate check (
    kind <> 'gate_target' or gate_code is not null)
);

create table practice.tasks (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  period_start   date not null,
  period_end     date not null,
  catalog_code   text not null,
  title          text not null,
  kind           text not null,
  role           text not null,
  gate_code      text,

  due_date       date not null,
  due_date_set_on date not null,
  state          text not null default 'open',
  blocked_by_code text,
  assignee_id    char(26),
  assignment_reason text not null default '',

  escalation_rung text not null default 'none',
  last_escalated_on date,
  comment_count  integer not null default 0,
  time_entry_count integer not null default 0,
  completed_on   date,

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint task_one_per_period_code unique (client_id, period_start, catalog_code),
  constraint task_kind check (kind in ('checklist','deadline','gate_target')),
  constraint task_role check (role in ('preparer','reviewer')),
  constraint task_state check (state in ('open','blocked','complete')),
  constraint task_rung check (escalation_rung in (
    'none','assignee','lead','partner','at_risk')),
  constraint task_window check (period_end >= period_start),
  constraint task_blocked_has_predecessor check (
    state <> 'blocked' or blocked_by_code is not null),
  constraint task_complete_has_date check (
    state <> 'complete' or completed_on is not null),
  constraint task_counts_nonneg check (comment_count >= 0 and time_entry_count >= 0)
);

create index tasks_period on practice.tasks (client_id, period_start);
create index tasks_due on practice.tasks (client_id, due_date);

-- ---------------------------------------------------------------------------
-- 7. Escalations. Append only, per doc 02 PRAC-ESCALATE-OVERDUE.
--
-- One row per task per due date per rung, which is what makes each rung fire
-- exactly once. A due date change produces a row of its own carrying both dates,
-- so extending a deadline to dodge a rung is visible rather than silent.
-- ---------------------------------------------------------------------------

create table practice.escalations (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  task_id        char(26) not null references practice.tasks(id),
  as_of_date     date not null,
  due_date       date not null,
  days_overdue   integer not null,
  rung           text not null,
  recipient_id   char(26),
  recipient_role text not null,
  prior_rung     text not null default 'none',
  reason         text not null,
  reset_from_due_date date,
  reset_to_due_date   date,

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint escalation_one_per_rung unique (task_id, due_date, rung),
  constraint escalation_rung check (rung in (
    'assignee','lead','partner','at_risk','due_date_reset')),
  constraint escalation_recipient_role check (recipient_role in (
    'assignee','lead','partner','firm','predecessor_owner')),
  constraint escalation_days check (days_overdue >= 0)
);

create index escalations_task on practice.escalations (client_id, task_id);

-- ---------------------------------------------------------------------------
-- 8. Workload notices. One per firm member per as of date.
--
-- The count and the oldest overdue task are both on the row because a member
-- who reads a count without an age cannot tell twelve tasks a day late from
-- twelve tasks a quarter late.
-- ---------------------------------------------------------------------------

create table practice.workload_notices (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  as_of_date     date not null,
  member_id      char(26) not null,
  member_role    text not null,
  overdue_count  integer not null default 0,
  oldest_due_date date,
  oldest_task_id char(26),
  max_days_overdue integer not null default 0,
  detail         text not null default '',

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint notice_one_per_member_day unique (client_id, member_id, as_of_date),
  constraint notice_role check (member_role in ('assignee','lead','partner','firm')),
  constraint notice_counts check (overdue_count >= 0 and max_days_overdue >= 0)
);

create index notices_day on practice.workload_notices (client_id, as_of_date desc);

-- ---------------------------------------------------------------------------
-- 9. Nudge decisions. A log, not an outbox.
--
-- There is no recipient column, no address column, and no message body column.
-- The run refreshes a next check date and writes a row saying which nudge number
-- came due. A person decides what actually leaves the firm.
-- ---------------------------------------------------------------------------

create table practice.request_nudges (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  request_id     char(26) not null references close.document_requests(id),
  as_of_date     date not null,
  nudge_number   integer not null,
  escalation_age_days integer not null,
  age_days       integer not null,
  next_check_on  date not null,
  action         text not null,
  detail         text not null default '',

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint nudge_one_per_number unique (client_id, request_id, nudge_number),
  constraint nudge_action check (action in (
    'nudge_due','schedule_exhausted','call_task')),
  constraint nudge_numbers check (
    nudge_number >= 1 and escalation_age_days > 0 and age_days >= 0)
);

create index nudges_request on practice.request_nudges (client_id, request_id);

-- ---------------------------------------------------------------------------
-- 10. Approved payroll runs, and the register entries posted from them.
--
-- D5 is the whole design here. Approval is review and never disbursement
-- authority, so authorizes_disbursement can hold one value and a named
-- constraint refuses the other. A test asserts the constraint by name, because a
-- guarantee nobody can point at is not a guarantee.
--
-- The register object key is not null. PAY-POST-REGISTER posts only from a
-- register that exists as an object with a checksum, never from a keyed total,
-- because the register is the evidence that makes gate G11 meaningful.
-- ---------------------------------------------------------------------------

create table subledger.pay_runs (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  provider_name  text not null,
  pay_period_start date not null,
  pay_period_end   date not null,
  pay_date       date not null,
  period_start   date not null,
  period_end     date not null,
  employee_count integer,

  register_vault_object_key text not null,
  register_checksum char(64) not null,

  gross_cents             bigint not null,
  employer_tax_cents      bigint not null default 0,
  employee_withholding_cents bigint not null default 0,
  net_cents               bigint not null,

  status         text not null default 'approved',
  approved_by    char(26),
  approved_at    timestamptz not null default now(),
  approval_statement text not null,
  -- One value only. Approval is review. It moves no money.
  authorizes_disbursement boolean not null default false,

  posted_entry_id char(26) references ledger.journal_entries(id),
  posted_at      timestamptz,
  posted_run_id  char(31),

  vault_object_lock_mode text not null default 'GOVERNANCE',
  vault_retention_starts_on date not null,
  vault_object_lock_until date not null,

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint pay_run_one_per_provider_date unique (
    client_id, provider_name, pay_date, pay_period_start),
  constraint pay_run_status check (status in ('approved','posted')),
  constraint pay_run_period_sane check (pay_period_end >= pay_period_start),
  constraint pay_run_window check (period_end >= period_start),
  constraint pay_run_amounts_nonneg check (
    gross_cents >= 0 and employer_tax_cents >= 0
    and employee_withholding_cents >= 0 and net_cents >= 0),
  constraint pay_run_net_within_gross check (net_cents <= gross_cents),
  constraint pay_run_no_disbursement_authority check (authorizes_disbursement = false),
  constraint pay_run_lock_mode check (vault_object_lock_mode = 'GOVERNANCE'),
  constraint pay_run_register_checksum check (register_checksum ~ '^[0-9a-f]{64}$'),
  constraint pay_run_posted_complete check (
    status <> 'posted' or (posted_entry_id is not null and posted_at is not null))
);

create index pay_runs_date on subledger.pay_runs (client_id, pay_date desc);
create index pay_runs_status on subledger.pay_runs (client_id, status);

create table subledger.pay_register_entries (
  id             char(26) primary key,        -- ULID
  pay_run_id     char(26) not null references subledger.pay_runs(id),
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  period_start   date not null,
  period_end     date not null,
  pay_date       date not null,
  entry_id       char(26) references ledger.journal_entries(id),
  posted_run_id  char(31),
  line_count     integer not null default 0,

  gross_cents        bigint not null,
  employer_tax_cents bigint not null default 0,
  withholding_cents  bigint not null default 0,
  net_cents          bigint not null,
  wage_account       char(4) not null,
  employer_tax_account char(4) not null,
  withholding_account  char(4) not null,
  funding_account      char(4) not null,
  detail             text not null default '',

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  -- One entry per pay run per period per client, which is the brief's rule
  -- expressed as a constraint rather than as a comment in a run.
  constraint register_one_per_run_period unique (client_id, pay_run_id, period_start),
  constraint register_window check (period_end >= period_start),
  constraint register_amounts_nonneg check (
    gross_cents >= 0 and employer_tax_cents >= 0
    and withholding_cents >= 0 and net_cents >= 0),
  constraint register_line_count check (line_count >= 0)
);

create index register_entries_run on subledger.pay_register_entries (client_id, pay_run_id);

-- ---------------------------------------------------------------------------
-- 11. The CPA handoff archive.
--
-- The manifest is jsonb on the header rather than a child table, the same call
-- report.report_sections made for its figures: an archive reopened a year from
-- now has to show the manifest it showed on delivery day, and a snapshot does
-- that where a live join does not.
--
-- COMPLIANCE. There is no filed_at column, no form column, and no submission
-- column. The scope statement is the point of the run: it says in writing that
-- this is compiled bookkeeping, not an audit, not a review, not a compilation
-- report under professional standards, and not tax advice.
-- ---------------------------------------------------------------------------

create table deliverable.cpa_handoffs (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  tax_year       integer not null,
  period_start   date not null,
  period_end     date not null,
  scope_kind     text not null,
  reporting_basis text not null default 'both',
  is_fiscal_year_end boolean not null default false,

  status         text not null default 'complete',
  artifact_count integer not null default 0,
  open_item_count integer not null default 0,
  artifacts      jsonb not null default '[]',
  open_items     jsonb not null default '[]',
  scope_statement text not null,
  tax_data_set_id char(26) references tax.data_sets(id),

  content_checksum char(64) not null,
  ledger_fingerprint char(64) not null,

  vault_object_key text not null,
  vault_object_lock_mode text not null default 'GOVERNANCE',
  vault_retention_starts_on date not null,
  vault_object_lock_until date not null,

  built_by_run_id char(31),
  built_at       timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint handoff_one_per_scope unique (client_id, period_start, scope_kind),
  constraint handoff_scope_kind check (scope_kind in ('period','fiscal_year')),
  constraint handoff_basis check (reporting_basis in ('accrual','cash','both')),
  constraint handoff_status check (status in ('complete')),
  constraint handoff_window check (period_end >= period_start),
  constraint handoff_lock_mode check (vault_object_lock_mode = 'GOVERNANCE'),
  constraint handoff_counts_nonneg check (
    artifact_count >= 0 and open_item_count >= 0)
);

create index handoffs_year on deliverable.cpa_handoffs (client_id, tax_year desc);

-- ---------------------------------------------------------------------------
-- 12. The offboarding export archive. D9.
--
-- due_on is fifteen business days from the request day, carried as data so the
-- promise in the engagement letter is a column somebody can check. Open formats
-- only, which is a check constraint on every file in the manifest rather than a
-- convention.
-- ---------------------------------------------------------------------------

create table deliverable.offboard_exports (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  requested_on   date not null,
  production_days integer not null default 15,
  due_on         date not null,
  history_start  date,
  history_end    date not null,
  period_start   date not null,
  period_end     date not null,

  status         text not null default 'complete',
  file_count     integer not null default 0,
  document_count integer not null default 0,
  total_row_count integer not null default 0,
  files          jsonb not null default '[]',

  manifest_checksum char(64) not null,
  content_checksum  char(64) not null,
  ledger_fingerprint char(64) not null,

  vault_object_key text not null,
  vault_object_lock_mode text not null default 'GOVERNANCE',
  vault_retention_starts_on date not null,
  vault_object_lock_until date not null,

  built_by_run_id char(31),
  built_at       timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint export_one_per_request unique (client_id, requested_on),
  constraint export_status check (status in ('complete')),
  constraint export_production_days check (production_days = 15),
  constraint export_due_after_request check (due_on > requested_on),
  constraint export_history check (history_start is null or history_end >= history_start),
  constraint export_lock_mode check (vault_object_lock_mode = 'GOVERNANCE'),
  constraint export_counts_nonneg check (
    file_count >= 0 and document_count >= 0 and total_row_count >= 0)
);

create index exports_request on deliverable.offboard_exports (client_id, requested_on desc);

-- ---------------------------------------------------------------------------
-- 13. Row level security, discriminator freeze, and the override guard.
--
-- Same three properties every table in 0013 through 0016 carries. Tenant
-- isolation is a policy on the row and not a predicate a run remembers to add,
-- the discriminator columns cannot be edited after insert, and a row carrying
-- the manual override flag refuses an automated write.
--
-- tax.thresholds is the one firm scoped table here, so it uses the firm access
-- function. A federal threshold is not a per client fact and pretending it was
-- one would put the same two rows under every client.
-- ---------------------------------------------------------------------------

alter table tax.thresholds enable row level security;
alter table tax.thresholds force row level security;
alter table tax.data_sets enable row level security;
alter table tax.data_sets force row level security;
alter table tax.data_lines enable row level security;
alter table tax.data_lines force row level security;
alter table tax.w9_states enable row level security;
alter table tax.w9_states force row level security;
alter table practice.practice_states enable row level security;
alter table practice.practice_states force row level security;
alter table practice.task_catalog enable row level security;
alter table practice.task_catalog force row level security;
alter table practice.tasks enable row level security;
alter table practice.tasks force row level security;
alter table practice.escalations enable row level security;
alter table practice.escalations force row level security;
alter table practice.workload_notices enable row level security;
alter table practice.workload_notices force row level security;
alter table practice.request_nudges enable row level security;
alter table practice.request_nudges force row level security;
alter table subledger.pay_runs enable row level security;
alter table subledger.pay_runs force row level security;
alter table subledger.pay_register_entries enable row level security;
alter table subledger.pay_register_entries force row level security;
alter table deliverable.cpa_handoffs enable row level security;
alter table deliverable.cpa_handoffs force row level security;
alter table deliverable.offboard_exports enable row level security;
alter table deliverable.offboard_exports force row level security;

create policy firm_isolation on tax.thresholds
  using ( (select tenancy.has_firm_access(firm_id)) )
  with check ( (select tenancy.has_firm_access(firm_id)) );
create policy client_isolation on tax.data_sets
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on tax.data_lines
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on tax.w9_states
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on practice.practice_states
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on practice.task_catalog
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on practice.tasks
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on practice.escalations
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on practice.workload_notices
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on practice.request_nudges
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.pay_runs
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.pay_register_entries
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on deliverable.cpa_handoffs
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on deliverable.offboard_exports
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

-- tax.thresholds carries firm_id and no client_id, so it takes the firm only
-- variant of the freeze.
create trigger trg_freeze_discriminators before update on tax.thresholds
  for each row execute function tenancy.freeze_firm_discriminator();
create trigger trg_freeze_discriminators before update on tax.data_sets
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on tax.data_lines
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on tax.w9_states
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on practice.practice_states
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on practice.task_catalog
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on practice.tasks
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on practice.escalations
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on practice.workload_notices
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on practice.request_nudges
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.pay_runs
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.pay_register_entries
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on deliverable.cpa_handoffs
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on deliverable.offboard_exports
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on tax.thresholds
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on tax.data_sets
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on tax.data_lines
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on tax.w9_states
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on practice.practice_states
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on practice.task_catalog
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on practice.tasks
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on practice.escalations
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on practice.workload_notices
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on practice.request_nudges
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.pay_runs
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.pay_register_entries
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on deliverable.cpa_handoffs
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on deliverable.offboard_exports
  for each row execute function ledger.guard_manual_override();

-- ---------------------------------------------------------------------------
-- 14. The seeded threshold rows.
--
-- Doc 02 TAX-BUILD-1099 rule 1. Payments dated before January 1, 2026 use 60000
-- cents. Payments dated on or after use 200000 cents, following section 70433 of
-- the One Big Beautiful Bill Act, which raised the Form 1099-NEC and Form
-- 1099-MISC threshold from 600 dollars to 2,000 dollars with inflation indexing
-- from 2027. The 2027 indexed row is added when the figure is published, which
-- is a data change and not a code change.
-- ---------------------------------------------------------------------------

insert into tax.thresholds (
  id, firm_id, form_family, effective_from, effective_to, threshold_cents, source_note)
select
  upper(substr(md5(f.id::text || ':1099:600'), 1, 26)),
  f.id,
  '1099',
  date '1900-01-01',
  date '2025-12-31',
  60000,
  'Six hundred dollar threshold in force for payments dated before January 1, 2026.'
from tenancy.firms f
on conflict do nothing;

insert into tax.thresholds (
  id, firm_id, form_family, effective_from, effective_to, threshold_cents, source_note)
select
  upper(substr(md5(f.id::text || ':1099:2000'), 1, 26)),
  f.id,
  '1099',
  date '2026-01-01',
  null,
  200000,
  'Two thousand dollar threshold, OBBBA section 70433, indexed from 2027.'
from tenancy.firms f
on conflict do nothing;

commit;
