-- 0005_subledgers.sql
-- Implements doc 04 Part 2 (fixed assets and depreciation schedule), Part 3
-- (deferral schedules and lines), Part 4 (loans and loan schedule), Part 5
-- (vendors and the dated tax thresholds), and Part 6 (recurring templates and
-- splits). Doc 04 Part 13 row 0005.
-- Security decision carried through unchanged: no credential columns anywhere and
-- no full taxpayer identification number. Vendors store tin_last_four only.
-- The override guard trigger from 0003 is attached here to every table that
-- carries the manual override flag.
-- Forward only. No down migration.

begin;

create schema if not exists subledger;
grant usage on schema subledger to app_web, app_worker;

-- ---------------------------------------------------------------------------
-- Doc 04 Part 2. Fixed assets.
-- ---------------------------------------------------------------------------

create table subledger.fixed_assets (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  tag            text,                        -- client's own asset tag
  description    text not null,
  asset_class    text not null,
  -- The 1500 to 1600 pairing convention, stored not inferred.
  cost_account   char(4) not null,
  accum_account  char(4) not null,
  expense_account char(4) not null,           -- depreciation expense, 6xxx

  acquired_on    date not null,
  placed_in_service_on date not null,
  cost_cents     bigint not null,
  salvage_cents  bigint not null default 0,
  depreciable_base_cents bigint generated always as
    (cost_cents - salvage_cents) stored,

  method         text not null,
  life_months    integer,
  ddb_factor     numeric(4,2),                -- 2.00 for double declining, not money
  units_total    bigint,                      -- for units of production
  convention     text not null default 'mid_month',

  status         text not null default 'active',
  disposed_on    date,
  disposal_proceeds_cents bigint,
  disposal_entry_id char(26),

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  source_transaction_id char(26),
  source_document_id char(26),
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint fa_cost_block  check (cost_account  between '1500' and '1799'),
  constraint fa_accum_block check (accum_account between '1600' and '1899'),
  -- Offset of 100, per doc 00 Part 1. Hard, because the run relies on it.
  constraint fa_pairing check ((accum_account::int - cost_account::int) = 100),
  constraint fa_cost_positive check (cost_cents > 0),
  constraint fa_salvage_sane check (salvage_cents >= 0 and salvage_cents < cost_cents),
  constraint fa_method check (method in (
    'straight_line','ddb','ddb_150','sum_of_years','units_of_production','none')),
  constraint fa_convention check (convention in ('full_month','mid_month','mid_quarter','mid_year','actual_days')),
  constraint fa_life_required check (
    (method = 'units_of_production' and units_total is not null)
    or (method = 'none')
    or (life_months is not null and life_months > 0)),
  constraint fa_ddb_factor check (
    (method not in ('ddb','ddb_150')) or ddb_factor is not null),
  constraint fa_status check (status in ('active','fully_depreciated','disposed','written_off')),
  constraint fa_disposal_complete check (
    status <> 'disposed' or (disposed_on is not null and disposal_entry_id is not null)),
  constraint fa_in_service_after_acquired check (placed_in_service_on >= acquired_on),
  foreign key (client_id, cost_account)   references ledger.accounts (client_id, account_number),
  foreign key (client_id, accum_account)  references ledger.accounts (client_id, account_number),
  foreign key (client_id, expense_account) references ledger.accounts (client_id, account_number)
);

create index on subledger.fixed_assets (client_id, status);
create index on subledger.fixed_assets (client_id, cost_account);
create index on subledger.fixed_assets (firm_id);
create index on subledger.fixed_assets (client_id, placed_in_service_on);

alter table subledger.fixed_assets enable row level security;
alter table subledger.fixed_assets force row level security;
create policy client_isolation on subledger.fixed_assets
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on subledger.fixed_assets
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_guard_manual_override before update on subledger.fixed_assets
  for each row execute function ledger.guard_manual_override();

create table subledger.depreciation_schedule (
  id             char(26) primary key,
  asset_id       char(26) not null references subledger.fixed_assets(id),
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  period_start   date not null,
  period_end     date not null,
  period_number  integer not null,            -- 1 based
  schedule_version integer not null default 1,

  amount_cents   bigint not null,             -- always positive, sign applied at posting
  accumulated_after_cents bigint not null,
  nbv_after_cents bigint not null,

  status         text not null default 'scheduled',
  posted_entry_id char(26),
  posted_run_id  char(26),
  posted_at      timestamptz,

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  unique (asset_id, schedule_version, period_number),
  constraint dep_amount_nonneg check (amount_cents >= 0),
  constraint dep_period_sane check (period_end >= period_start),
  constraint dep_status check (status in ('scheduled','posted','skipped','superseded')),
  constraint dep_posted_complete check (
    status <> 'posted' or (posted_entry_id is not null and posted_run_id is not null))
);

create index on subledger.depreciation_schedule (client_id, period_start, status);
create unique index dep_one_posting_per_period
  on subledger.depreciation_schedule (asset_id, period_start)
  where status = 'posted';
create index on subledger.depreciation_schedule (firm_id);

alter table subledger.depreciation_schedule enable row level security;
alter table subledger.depreciation_schedule force row level security;
create policy client_isolation on subledger.depreciation_schedule
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on subledger.depreciation_schedule
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_guard_manual_override before update on subledger.depreciation_schedule
  for each row execute function ledger.guard_manual_override();

-- ---------------------------------------------------------------------------
-- Doc 04 Part 3. Prepaids, intangible amortization, deferred revenue, accruals.
-- One table pattern, a kind discriminator, separate account blocks.
-- ---------------------------------------------------------------------------

create table subledger.deferral_schedules (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  kind           text not null,
  description    text not null,
  vendor_id      char(26),
  counterparty   text,

  balance_account char(4) not null,           -- 13xx prepaid, 17xx intangible, 25xx deferred revenue
  release_account char(4) not null,           -- 6xxx expense, or 4xxx revenue
  accum_account   char(4),                    -- 17xx contra for intangibles only

  total_cents    bigint not null,
  service_start  date not null,
  service_end    date not null,
  method         text not null default 'straight_line_monthly',
  periods        integer not null,

  status         text not null default 'active',
  source_transaction_id char(26),
  source_document_id char(26),

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint def_kind check (kind in ('prepaid','intangible_amortization','deferred_revenue','accrual')),
  constraint def_total_positive check (total_cents > 0),
  constraint def_dates check (service_end >= service_start),
  constraint def_periods check (periods > 0),
  constraint def_method check (method in ('straight_line_monthly','straight_line_daily','custom')),
  constraint def_status check (status in ('active','complete','cancelled','superseded')),
  -- Blocks per doc 00 Part 1, by kind.
  constraint def_balance_block check (
    (kind = 'prepaid'                 and balance_account between '1300' and '1399') or
    (kind = 'intangible_amortization' and balance_account between '1700' and '1799') or
    (kind = 'deferred_revenue'        and balance_account between '2500' and '2599') or
    (kind = 'accrual'                 and balance_account between '2200' and '2299')),
  constraint def_accum_for_intangibles check (
    (kind <> 'intangible_amortization') or accum_account is not null),
  constraint def_accum_pairing check (
    accum_account is null or (accum_account::int - balance_account::int) = 100),
  foreign key (client_id, balance_account) references ledger.accounts (client_id, account_number),
  foreign key (client_id, release_account) references ledger.accounts (client_id, account_number)
);

create index on subledger.deferral_schedules (client_id, kind, status);
create index on subledger.deferral_schedules (firm_id);

create table subledger.deferral_lines (
  id             char(26) primary key,
  schedule_id    char(26) not null references subledger.deferral_schedules(id),
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  schedule_version integer not null default 1,
  period_number  integer not null,
  period_start   date not null,
  period_end     date not null,
  amount_cents   bigint not null,
  remaining_after_cents bigint not null,
  status         text not null default 'scheduled',
  posted_entry_id char(26),
  posted_run_id  char(26),
  posted_at      timestamptz,
  reversal_entry_id char(26),                 -- accruals reverse next period
  manual_override boolean not null default false,
  unique (schedule_id, schedule_version, period_number),
  constraint defl_amount_nonneg check (amount_cents >= 0),
  constraint defl_status check (status in ('scheduled','posted','skipped','superseded'))
);

create index on subledger.deferral_lines (client_id, period_start, status);
create unique index defl_one_posting_per_period
  on subledger.deferral_lines (schedule_id, period_start) where status = 'posted';
create index on subledger.deferral_lines (firm_id);

alter table subledger.deferral_schedules enable row level security;
alter table subledger.deferral_schedules force row level security;
alter table subledger.deferral_lines enable row level security;
alter table subledger.deferral_lines force row level security;
create policy client_isolation on subledger.deferral_schedules
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.deferral_lines
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on subledger.deferral_schedules
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.deferral_lines
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_guard_manual_override before update on subledger.deferral_schedules
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.deferral_lines
  for each row execute function ledger.guard_manual_override();

-- ---------------------------------------------------------------------------
-- Doc 04 Part 4. Loans and the amortization schedule.
-- ---------------------------------------------------------------------------

create table subledger.loans (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  lender_name    text not null,
  vendor_id      char(26),
  reference      text,
  loan_type      text not null,

  principal_account_lt char(4) not null,      -- 27xx long term debt
  principal_account_cp char(4),               -- 26xx current portion, optional
  interest_account     char(4) not null,      -- 8xxx interest expense
  funding_account      char(4),               -- 10xx cash that received proceeds

  original_principal_cents bigint not null,
  origination_date date not null,
  first_payment_date date not null,
  term_months    integer not null,
  annual_rate_bps integer not null,           -- basis points, integer, no floats
  day_count      text not null default '30_360',
  payment_cents  bigint,                      -- null for interest only or variable
  balloon_cents  bigint not null default 0,
  rate_type      text not null default 'fixed',

  status         text not null default 'active',
  payoff_date    date,
  manual_override boolean not null default false,
  source_document_id char(26),
  created_at     timestamptz not null default now(),

  constraint loan_type_check check (loan_type in (
    'term','sba','line_of_credit','equipment','mortgage','vehicle','shareholder','other')),
  constraint loan_rate_type check (rate_type in ('fixed','variable')),
  constraint loan_day_count check (day_count in ('30_360','actual_365','actual_360')),
  constraint loan_principal_positive check (original_principal_cents > 0),
  constraint loan_rate_sane check (annual_rate_bps between 0 and 10000),
  constraint loan_term check (term_months > 0),
  constraint loan_lt_block check (principal_account_lt between '2700' and '2999'),
  constraint loan_cp_block check (principal_account_cp is null
    or principal_account_cp between '2600' and '2699'),
  constraint loan_interest_block check (interest_account between '8000' and '8999'),
  constraint loan_status check (status in ('active','paid_off','refinanced','written_off')),
  foreign key (client_id, principal_account_lt) references ledger.accounts (client_id, account_number),
  foreign key (client_id, interest_account) references ledger.accounts (client_id, account_number)
);

create index on subledger.loans (client_id, status);
create index on subledger.loans (firm_id);

create table subledger.loan_schedule (
  id             char(26) primary key,
  loan_id        char(26) not null references subledger.loans(id),
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  schedule_version integer not null default 1,

  payment_number integer not null,
  due_date       date not null,
  payment_cents  bigint not null,
  principal_cents bigint not null,
  interest_cents bigint not null,
  escrow_cents   bigint not null default 0,
  fees_cents     bigint not null default 0,
  balance_after_cents bigint not null,

  status         text not null default 'scheduled',
  matched_transaction_id char(26),
  posted_entry_id char(26),
  posted_run_id  char(26),
  posted_at      timestamptz,
  manual_override boolean not null default false,

  unique (loan_id, schedule_version, payment_number),
  constraint loan_split_adds_up check (
    payment_cents = principal_cents + interest_cents + escrow_cents + fees_cents),
  constraint loan_components_nonneg check (
    principal_cents >= 0 and interest_cents >= 0
    and escrow_cents >= 0 and fees_cents >= 0),
  constraint loan_balance_nonneg check (balance_after_cents >= 0),
  constraint loan_sched_status check (status in ('scheduled','posted','skipped','superseded'))
);

create index on subledger.loan_schedule (client_id, due_date, status);
create index on subledger.loan_schedule (loan_id, status);
create index on subledger.loan_schedule (firm_id);
create unique index loan_one_posting_per_payment
  on subledger.loan_schedule (loan_id, payment_number) where status = 'posted';

alter table subledger.loans enable row level security;
alter table subledger.loans force row level security;
alter table subledger.loan_schedule enable row level security;
alter table subledger.loan_schedule force row level security;
create policy client_isolation on subledger.loans
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.loan_schedule
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on subledger.loans
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.loan_schedule
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_guard_manual_override before update on subledger.loans
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.loan_schedule
  for each row execute function ledger.guard_manual_override();

-- ---------------------------------------------------------------------------
-- Doc 04 Part 5. Vendors. Last four of the taxpayer identification number only,
-- ever. The full number lives in the signed W-9 in the vault and nowhere else.
-- ---------------------------------------------------------------------------

create table subledger.vendors (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  legal_name     text not null,
  dba_name       text,
  normalized_name text not null,              -- output of the versioned normalizer
  normalizer_version integer not null,
  aliases        text[] not null default '{}',

  -- Coding defaults, cascade level 7.
  default_category_id text,
  default_class_id char(26),
  default_1099_class text,
  is_related_party boolean not null default false,
  is_employee      boolean not null default false,

  entity_type    text,
  is_corporation boolean not null default false,
  is_attorney    boolean not null default false,

  -- W-9 and TIN. Last four only, ever. No credential column exists on this table
  -- or anywhere else in this schema.
  w9_status      text not null default 'not_requested',
  w9_requested_at timestamptz,
  w9_received_at  timestamptz,
  w9_document_id char(26),                    -- vault.documents, the actual PDF
  tin_type       text,
  tin_last_four  char(4),
  tin_verified_at timestamptz,
  tin_verification_result text,
  backup_withholding_required boolean not null default false,

  payment_terms_days integer,
  remit_address  jsonb,
  is_active      boolean not null default true,
  manual_override boolean not null default false,
  created_at     timestamptz not null default now(),

  constraint vendor_entity check (entity_type is null or entity_type in (
    'individual','sole_prop','single_member_llc','partnership','llc','c_corp','s_corp',
    'nonprofit','government','foreign')),
  constraint vendor_w9_status check (w9_status in (
    'not_requested','requested','received','on_file_verified','refused','not_required')),
  constraint vendor_tin_type check (tin_type is null or tin_type in ('ssn','ein','itin','atin')),
  constraint vendor_tin_last_four check (tin_last_four is null or tin_last_four ~ '^[0-9]{4}$'),
  constraint vendor_1099_class check (default_1099_class is null or default_1099_class in
    ('none','nec','misc_rent','misc_other','attorney')),
  constraint vendor_w9_doc_when_received check (
    w9_status not in ('received','on_file_verified') or w9_document_id is not null),
  -- Attorneys are reportable even when incorporated.
  constraint vendor_attorney_is_nec check (
    not is_attorney or default_1099_class in ('attorney','nec')),
  foreign key (client_id, default_category_id)
    references ledger.categories (client_id, id) deferrable initially deferred
);

create index on subledger.vendors (client_id, normalized_name);
create index on subledger.vendors (client_id) where is_active;
create index on subledger.vendors (firm_id);
create index on subledger.vendors (client_id, w9_status)
  where w9_status in ('not_requested','requested','refused');
create index vendors_alias_gin on subledger.vendors using gin (aliases);

alter table subledger.vendors enable row level security;
alter table subledger.vendors force row level security;
create policy client_isolation on subledger.vendors
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on subledger.vendors
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_guard_manual_override before update on subledger.vendors
  for each row execute function ledger.guard_manual_override();

-- Dated threshold configuration. Global reference data, not tenant scoped, so no
-- RLS. A prior year rerun must still produce prior year behavior.
create table subledger.tax_thresholds (
  id              char(26) primary key,
  threshold_key   text not null,              -- '1099_nec', '1099_misc', 'backup_withholding', '1099_k_amount'
  tax_year        integer not null,
  amount_cents    bigint not null,
  transaction_count integer,                  -- 1099-K only
  source_note     text not null,
  source_url      text not null,
  unique (threshold_key, tax_year)
);

grant select on subledger.tax_thresholds to app_web, app_worker;

insert into subledger.tax_thresholds
  (id, threshold_key, tax_year, amount_cents, transaction_count, source_note, source_url)
values
  ('01J0THRESH1099NEC2025AAAAA','1099_nec', 2025, 60000, null,
   'Pre 2026 Form 1099-NEC reporting threshold of 600 dollars.',
   'https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds'),
  ('01J0THRESH1099NEC2026AAAAA','1099_nec', 2026, 200000, null,
   'Section 70433 raised the Form 1099-NEC threshold to 2,000 dollars for payments made on or after January 1, 2026.',
   'https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds'),
  ('01J0THRESH1099MISC2025AAAA','1099_misc', 2025, 60000, null,
   'Pre 2026 Form 1099-MISC reporting threshold of 600 dollars.',
   'https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds'),
  ('01J0THRESH1099MISC2026AAAA','1099_misc', 2026, 200000, null,
   'Section 70433 raised the Form 1099-MISC threshold to 2,000 dollars from January 1, 2026.',
   'https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds'),
  ('01J0THRESHBACKUPWH2026AAAA','backup_withholding', 2026, 200000, null,
   'Backup withholding trigger moved to 2,000 dollars, indexed for inflation from 2027.',
   'https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds'),
  ('01J0THRESH1099K2026AAAAAAA','1099_k_amount', 2026, 2000000, 200,
   'Section 70432 reinstated the 20,000 dollar and 200 transaction thresholds for third party network reporting.',
   'https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds')
on conflict (threshold_key, tax_year) do nothing;

-- ---------------------------------------------------------------------------
-- Doc 04 Part 6. Recurring templates and their splits.
-- ---------------------------------------------------------------------------

create table subledger.recurring_templates (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  name           text not null,
  match_kind     text not null,               -- 'transaction_match' or 'generated_entry'
  vendor_id      char(26),
  match_normalized_name text,
  match_amount_cents bigint,
  match_amount_tolerance_cents bigint not null default 0,
  match_account_number char(4),

  cadence        text,
  day_of_month   integer,
  next_due_date  date,
  start_date     date,
  end_date       date,

  split_mode     text not null default 'single',
  entry_memo_template text,
  is_active      boolean not null default true,
  manual_override boolean not null default false,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint rec_match_kind check (match_kind in ('transaction_match','generated_entry')),
  constraint rec_split_mode check (split_mode in ('single','fixed_amount','fixed_percent')),
  constraint rec_cadence check (cadence is null or cadence in
    ('weekly','semi_monthly','monthly','quarterly','semi_annual','annual')),
  constraint rec_day_of_month check (day_of_month is null or day_of_month between 1 and 31),
  constraint rec_generated_needs_cadence check (
    match_kind <> 'generated_entry' or (cadence is not null and next_due_date is not null)),
  constraint rec_tolerance_nonneg check (match_amount_tolerance_cents >= 0)
);

create table subledger.recurring_splits (
  id             char(26) primary key,
  template_id    char(26) not null references subledger.recurring_templates(id),
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  template_version integer not null,
  line_number    integer not null,

  category_id    text not null,
  account_number char(4) not null,
  -- Exactly one of these is set, enforced below.
  fixed_amount_cents bigint,
  percent_bps    integer,                     -- basis points of 10000
  is_remainder   boolean not null default false,

  class_id       char(26),
  location_id    char(26),
  program_id     char(26),
  memo           text,

  unique (template_id, template_version, line_number),
  constraint rec_split_one_basis check (
    (fixed_amount_cents is not null)::int
    + (percent_bps is not null)::int
    + is_remainder::int = 1),
  constraint rec_percent_range check (percent_bps is null or percent_bps between 1 and 10000),
  foreign key (client_id, account_number) references ledger.accounts (client_id, account_number),
  foreign key (client_id, category_id) references ledger.categories (client_id, id)
);

create index on subledger.recurring_templates (client_id) where is_active;
create index on subledger.recurring_templates (client_id, next_due_date) where is_active;
create index on subledger.recurring_templates (client_id, match_normalized_name);
create index on subledger.recurring_templates (firm_id);
create index on subledger.recurring_splits (client_id, template_id);
create index on subledger.recurring_splits (firm_id);
create unique index rec_one_remainder_per_version
  on subledger.recurring_splits (template_id, template_version) where is_remainder;

alter table subledger.recurring_templates enable row level security;
alter table subledger.recurring_templates force row level security;
alter table subledger.recurring_splits enable row level security;
alter table subledger.recurring_splits force row level security;
create policy client_isolation on subledger.recurring_templates
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.recurring_splits
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on subledger.recurring_templates
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.recurring_splits
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_guard_manual_override before update on subledger.recurring_templates
  for each row execute function ledger.guard_manual_override();

commit;
