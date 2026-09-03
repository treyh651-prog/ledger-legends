-- 0013_period_end.sql
-- Doc 02 module 4. What the six period end runs need and the subledgers do not have.
--
-- Migration 0005 gave this module most of what it needs: fixed assets and a
-- depreciation schedule, deferral schedules and their allocation lines, loans
-- and an amortization schedule, and the recurring template and split tables.
-- Writing the six runs against those tables exposed six gaps. Each one is a
-- column a run has to read or write and cannot, not a preference.
--
--   1. There is no way to say that an accrual was superseded by the real bill
--      or invoice. PER-REVERSE-ACCRUALS is required to skip an accrual whose
--      document arrived, and without a link column it cannot tell the two
--      cases apart. linked_document_id is added to the journal entry, to the
--      deferral schedule, and to the deferral line.
--   2. There is no auto reversal marker on a journal entry. PER-POST-ACCRUALS
--      stamps the day the entry reverses and PER-REVERSE-ACCRUALS selects on
--      it. The entry already carries reverses_entry_id from 0002, so only the
--      day itself is missing. reverses_on carries it.
--   3. subledger.fixed_assets has no half month convention flag and its method
--      check refuses macrs. Both are required by the module 4 brief.
--      half_month_convention is a boolean beside the existing convention
--      column rather than a new value inside it, because the two answer
--      different questions: convention says how the first year is treated and
--      the flag says whether an acquisition or disposal month is halved.
--   4. ddb_factor is numeric(4,2). Nothing else in this schema stores a rate
--      as a decimal, and the depreciation run does bigint arithmetic, so a
--      basis point integer column is added beside it and backfilled.
--   5. ledger.transactions has no link to the schedule that released it, so a
--      register row cannot be traced back to the prepaid it belongs to.
--      amortization_schedule_id closes that.
--   6. Accrual templates do not exist at all. Doc 02 PER-POST-ACCRUALS names
--      four calculation bases and there is no table holding any of them.
--
-- Six subledger tables also gain a version column. Every run freezes its scope
-- by hashing the version of each row that participated, which is what makes a
-- stale preview detectable, and a table with no version column cannot take
-- part in that.
--
-- Doc 00 Part 1: money is bigint integer cents, debit positive, credit
-- negative. Nothing added here is a coding column, and the manual override
-- guard from 0005 stays exactly as it is.
--
-- Nothing in this migration computes a tax liability. Depreciation method is
-- stored as a bookkeeping mechanic. A tax position is CPA work and routes to
-- CPA-BUILD-HANDOFF.
--
-- Forward only. No down migration.

begin;

-- ---------------------------------------------------------------------------
-- 1. Auto reversal and supersession on the journal entry.
--
-- An accrual is a promise to undo itself. reverses_on is the day that undoing
-- happens, which is the first day of the following period, and it is stored on
-- the entry rather than derived so that a person can move it and the run will
-- honor the move. reverses_entry_id, already present from 0002, points forward
-- at the reversal once it exists. linked_document_id points sideways at the
-- real bill or invoice that made the accrual unnecessary.
-- ---------------------------------------------------------------------------

alter table ledger.journal_entries
  add column reverses_on date,
  add column linked_document_id char(26),
  add column accrual_template_id char(26);

-- A reversal that is dated before the thing it reverses is not a reversal.
alter table ledger.journal_entries
  add constraint je_reverses_after_entry
    check (reverses_on is null or reverses_on > entry_date);

create index je_awaiting_reversal
  on ledger.journal_entries (client_id, reverses_on)
  where reverses_on is not null and reverses_entry_id is null;

-- ---------------------------------------------------------------------------
-- 2. The register points at the schedule that released it.
-- ---------------------------------------------------------------------------

alter table ledger.transactions
  add column amortization_schedule_id char(26);

create index txn_by_amortization_schedule
  on ledger.transactions (amortization_schedule_id)
  where amortization_schedule_id is not null;

-- ---------------------------------------------------------------------------
-- 3 and 4. Fixed asset method, convention, and rate storage.
--
-- The method check is replaced rather than extended in place, because a check
-- constraint cannot be added to. macrs joins the list. A MACRS recovery period
-- is stored in years because that is the unit the published tables use, and
-- converting it to months here would throw away the year boundary the tables
-- are keyed on.
-- ---------------------------------------------------------------------------

alter table subledger.fixed_assets
  add column half_month_convention boolean not null default false,
  add column macrs_recovery_years integer,
  add column ddb_factor_bps integer,
  add column version integer not null default 1;

update subledger.fixed_assets
  set ddb_factor_bps = (ddb_factor * 10000)::integer
  where ddb_factor is not null;

alter table subledger.fixed_assets
  drop constraint fa_method,
  add constraint fa_method check (method in (
    'straight_line','ddb','ddb_150','macrs','sum_of_years',
    'units_of_production','none'));

alter table subledger.fixed_assets
  drop constraint fa_life_required,
  add constraint fa_life_required check (
    (method = 'units_of_production' and units_total is not null)
    or (method = 'macrs' and macrs_recovery_years is not null)
    or (method = 'none')
    or (life_months is not null and life_months > 0));

alter table subledger.fixed_assets
  add constraint fa_macrs_recovery check (
    macrs_recovery_years is null
    or macrs_recovery_years in (3, 5, 7, 10, 15, 20)),
  add constraint fa_ddb_factor_bps check (
    method not in ('ddb', 'ddb_150') or ddb_factor_bps is not null);

-- ---------------------------------------------------------------------------
-- 5. Supersession and versioning on the deferral tables.
-- ---------------------------------------------------------------------------

alter table subledger.deferral_schedules
  add column linked_document_id char(26),
  add column version integer not null default 1;

alter table subledger.deferral_lines
  add column linked_document_id char(26),
  add column version integer not null default 1;

alter table subledger.loans
  add column version integer not null default 1;

alter table subledger.loan_schedule
  add column version integer not null default 1;

alter table subledger.depreciation_schedule
  add column version integer not null default 1;

-- ---------------------------------------------------------------------------
-- 6. Recurring templates gain a posting date rule and a driver amount.
--
-- Doc 02 PER-POST-RECURRING allows two posting date rules, the last day of the
-- period or a stated day of the month clamped to the month length, and it
-- allows a template whose split lines are basis points of a stored driver
-- rather than fixed amounts. Neither had a column.
-- ---------------------------------------------------------------------------

alter table subledger.recurring_templates
  add column posting_date_rule text not null default 'period_end',
  add column driver_amount_cents bigint;

alter table subledger.recurring_templates
  add constraint rec_posting_date_rule
    check (posting_date_rule in ('period_end', 'day_n')),
  add constraint rec_day_n_needs_day
    check (posting_date_rule <> 'day_n' or day_of_month is not null);

-- ---------------------------------------------------------------------------
-- 7. Accrual templates.
--
-- Doc 02 PER-POST-ACCRUALS names four calculation bases and no others, so the
-- check constraint is closed rather than open. A basis that is not one of the
-- four is a specification question, not a data question, and a template that
-- carried one would post an amount nobody could reproduce.
--
-- The three accrual shapes doc 02 lists are bills received not entered, wages
-- earned not paid, and revenue earned not billed. All three are the same
-- mechanic: one debit account, one credit account, and a way of arriving at an
-- amount. Doc 05 D5 stands: payroll never disburses. A wage accrual credits an
-- accrued liability and nothing here moves cash.
-- ---------------------------------------------------------------------------

create table subledger.accrual_templates (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  name           text not null,
  accrual_kind   text not null,               -- what the accrual is for
  basis          text not null,               -- how the amount is arrived at

  debit_account  char(4) not null,
  credit_account char(4) not null,
  category_id    text,

  -- One of these four is read, chosen by basis. The others stay null.
  fixed_amount_cents bigint,                  -- basis 'fixed_amount'
  source_document_id char(26),                -- basis 'from_document'
  source_document_amount_cents bigint,        -- basis 'from_document'
  daily_rate_cents bigint,                    -- basis 'daily_rate_x_days'
  day_count      integer,                     -- basis 'daily_rate_x_days'
  base_cents     bigint,                      -- basis 'percent_of_base'
  percent_bps    integer,                     -- basis 'percent_of_base'

  entry_memo     text not null,
  -- True is the normal case. An accrual that does not reverse is a permanent
  -- adjustment wearing an accrual's clothes, so it has to be stated.
  auto_reverse   boolean not null default true,
  is_active      boolean not null default true,

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint acc_kind check (accrual_kind in (
    'bill_received_not_entered','wages_earned_not_paid',
    'revenue_earned_not_billed','other')),
  constraint acc_basis check (basis in (
    'fixed_amount','from_document','daily_rate_x_days','percent_of_base')),
  constraint acc_basis_inputs check (
    (basis = 'fixed_amount'      and fixed_amount_cents is not null) or
    (basis = 'from_document'     and source_document_id is not null
                                 and source_document_amount_cents is not null) or
    (basis = 'daily_rate_x_days' and daily_rate_cents is not null
                                 and day_count is not null) or
    (basis = 'percent_of_base'   and base_cents is not null
                                 and percent_bps is not null)),
  constraint acc_percent_sane check (
    percent_bps is null or percent_bps between 0 and 1000000),
  constraint acc_days_sane check (day_count is null or day_count >= 0),
  foreign key (client_id, debit_account)  references ledger.accounts (client_id, account_number),
  foreign key (client_id, credit_account) references ledger.accounts (client_id, account_number)
);

create index acc_templates_active
  on subledger.accrual_templates (client_id, is_active);

alter table subledger.accrual_templates enable row level security;
alter table subledger.accrual_templates force row level security;

create policy client_isolation on subledger.accrual_templates
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on subledger.accrual_templates
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on subledger.accrual_templates
  for each row execute function ledger.guard_manual_override();

commit;
