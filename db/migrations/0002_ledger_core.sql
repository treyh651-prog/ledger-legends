-- 0002_ledger_core.sql
-- Implements doc 04 Part 1 (accounts, clearing accounts, categories and versions),
-- doc 04 Part 7 and doc 03 Part 8 (period locks and the enforcement trigger), and
-- the journal entry and line DDL that doc 04 Part 14 item 1 leaves open.
-- Doc 04 Part 13 row 0002.
-- Amendments folded in before writing, per doc 05 Part 9 step 2:
--   Doc 05 Part 4 (D3): cash_effect, cash_event_date and cash_source_line are columns
--   of the ledger.journal_lines create table, not a later alter, together with the
--   jl_cash_effect and jl_cash_dated constraints.
-- Money is bigint cents. Debit positive, credit negative. One signed amount column.
-- Forward only. No down migration.

begin;

create schema if not exists ledger;

-- No direct table access for the web role. Views with security_invoker and RPCs only.
grant usage on schema ledger to app_web, app_worker;

-- ---------------------------------------------------------------------------
-- Doc 04 Part 1. Accounts.
-- ---------------------------------------------------------------------------

create table ledger.accounts (
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  account_number char(4) not null,
  name           text not null,
  account_type   text not null,
  normal_side    text not null,
  parent_number  char(4),
  contra_of      char(4),
  is_active      boolean not null default true,
  is_control     boolean not null default false,
  statement_line text,
  template_id    text,
  template_version integer,
  created_at     timestamptz not null default now(),

  primary key (client_id, account_number),

  constraint acct_numeric   check (account_number ~ '^[0-9]{4}$'),
  constraint acct_side      check (normal_side in ('debit','credit')),
  constraint acct_type      check (account_type in (
    'asset','liability','equity','revenue','cogs','expense',
    'other_income','other_expense','tax','memo')),
  -- The block map from doc 00 Part 1, enforced rather than documented.
  constraint acct_block_matches_type check (
    (account_number between '1000' and '1999' and account_type = 'asset') or
    (account_number between '2000' and '2999' and account_type = 'liability') or
    (account_number between '3000' and '3999' and account_type = 'equity') or
    (account_number between '4000' and '4999' and account_type = 'revenue') or
    (account_number between '5000' and '5999' and account_type = 'cogs') or
    (account_number between '6000' and '7999' and account_type = 'expense') or
    (account_number between '8000' and '8999' and account_type in ('other_income','other_expense')) or
    (account_number between '9000' and '9999' and account_type in ('tax','memo'))
  ),
  -- Accumulated depreciation and amortization pair by offset of 100.
  constraint acct_contra_offset check (
    contra_of is null
    or (account_number::int - contra_of::int) = 100
  ),
  foreign key (client_id, contra_of)
    references ledger.accounts (client_id, account_number)
);

create index on ledger.accounts (client_id) where is_active;
create index on ledger.accounts (firm_id);
create unique index accounts_one_contra_per_cost
  on ledger.accounts (client_id, contra_of) where contra_of is not null;

alter table ledger.accounts enable row level security;
alter table ledger.accounts force row level security;
create policy client_isolation on ledger.accounts
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on ledger.accounts
  for each row execute function tenancy.freeze_discriminators();

-- Seeded on every client. must_be_zero_at_close feeds gate G01.
create table ledger.clearing_accounts (
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  account_number char(4) not null,
  must_be_zero_at_close boolean not null,
  support_list_required boolean not null default false,
  primary key (client_id, account_number),
  foreign key (client_id, account_number)
    references ledger.accounts (client_id, account_number),
  constraint clearing_block check (account_number in ('1900','1910','1920','1930','1990'))
);

create index on ledger.clearing_accounts (client_id);
create index on ledger.clearing_accounts (firm_id);

alter table ledger.clearing_accounts enable row level security;
alter table ledger.clearing_accounts force row level security;
create policy client_isolation on ledger.clearing_accounts
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on ledger.clearing_accounts
  for each row execute function tenancy.freeze_discriminators();

-- ---------------------------------------------------------------------------
-- Doc 04 Part 1. Categories and category versions.
-- ---------------------------------------------------------------------------

create table ledger.categories (
  id             text primary key,            -- 'CAT-' plus slug
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,
  name           text not null,
  account_number char(4) not null,
  normal_side    text not null,
  tax_treatment  text not null,
  class_1099     text not null default 'none',
  requires_receipt_over bigint,               -- integer cents, nullable
  requires_class boolean not null default false,
  capitalize_over bigint,                     -- integer cents, nullable
  restriction_relevant boolean not null default false,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Needed so the composite foreign keys in doc 04 Part 5 and Part 9 have a
  -- unique target. Doc 04 declares those keys without declaring this constraint.
  unique (client_id, id),

  constraint cat_id_format check (id ~ '^CAT-[A-Z0-9-]+$'),
  constraint cat_side  check (normal_side in ('debit','credit')),
  constraint cat_tax   check (tax_treatment in (
    'deductible','meals_50','nondeductible','owner_draw','owner_contribution',
    'personal','capital','transfer','not_applicable')),
  constraint cat_1099  check (class_1099 in ('none','nec','misc_rent','misc_other','attorney')),
  constraint cat_thresholds_positive check (
    coalesce(requires_receipt_over, 0) >= 0 and coalesce(capitalize_over, 0) >= 0),
  foreign key (client_id, account_number)
    references ledger.accounts (client_id, account_number)
);

create index on ledger.categories (client_id) where is_active;
create index on ledger.categories (client_id, account_number);
create index on ledger.categories (firm_id);

alter table ledger.categories enable row level security;
alter table ledger.categories force row level security;
create policy client_isolation on ledger.categories
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on ledger.categories
  for each row execute function tenancy.freeze_discriminators();

-- History. Versioned reference data never rewrites itself.
create table ledger.category_versions (
  category_id text not null,
  version     integer not null,
  client_id   uuid not null,
  firm_id     uuid not null,
  snapshot    jsonb not null,
  valid_from  timestamptz not null default now(),
  valid_to    timestamptz,
  changed_by  uuid not null,
  change_note text,
  primary key (category_id, version)
);

create index on ledger.category_versions (client_id, category_id);
create index on ledger.category_versions (firm_id);

alter table ledger.category_versions enable row level security;
alter table ledger.category_versions force row level security;
create policy client_isolation on ledger.category_versions
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

-- ---------------------------------------------------------------------------
-- Journal entries and lines. Doc 04 Part 14 item 1 leaves this open and states
-- the requirement: lines sum to exactly zero per entry, enforced by a deferred
-- constraint trigger. That is what is written here.
-- ---------------------------------------------------------------------------

create table ledger.journal_entries (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  entry_date     date not null,
  entry_type     text not null default 'standard',
  status         text not null default 'draft',
  memo           text,
  source         text not null default 'manual',

  -- Provenance. A posted entry says which run and which evidence produced it.
  run_id         char(26),
  source_transaction_id char(26),
  source_document_id char(26),
  reverses_entry_id char(26) references ledger.journal_entries(id),
  reversed_by_entry_id char(26) references ledger.journal_entries(id),

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  posted_at      timestamptz,
  posted_by      uuid,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint je_status check (status in ('draft','posted','reversed','void')),
  constraint je_type check (entry_type in (
    'standard','adjusting','reversing','closing','opening','accrual','depreciation',
    'amortization','loan_split','payroll','recurring','import','correction')),
  constraint je_source check (source in ('manual','run','import','conversion')),
  constraint je_posted_complete check (
    status not in ('posted','reversed') or (posted_at is not null and posted_by is not null)),
  constraint je_reversal_shape check (
    entry_type <> 'reversing' or reverses_entry_id is not null)
);

create index on ledger.journal_entries (client_id, entry_date desc);
create index on ledger.journal_entries (client_id, status) where status = 'draft';
create index on ledger.journal_entries (firm_id, entry_date desc);
create index on ledger.journal_entries (run_id) where run_id is not null;

create table ledger.journal_lines (
  id             char(26) primary key,        -- ULID
  entry_id       char(26) not null references ledger.journal_entries(id),
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  line_number    integer not null,
  account_number char(4) not null,
  category_id    text,
  -- Signed. Debit positive, credit negative. Doc 00 Part 1.
  amount_cents   bigint not null,
  memo           text,

  -- Dimensions, never accounts. Doc 00 Part 2 and doc 04 Part 14 item 2, which
  -- leaves the dimension tables unmodeled, so these carry no foreign key yet.
  class_id       char(26),
  location_id    char(26),
  program_id     char(26),

  -- Provenance for the coding cascade.
  cascade_level  smallint,
  rule_id        text,
  rule_version   integer,
  category_version integer,
  suspense_reason char(6),
  source_transaction_id char(26),

  -- Doc 05 Part 4 (D3). Cash basis is a derived report over these three columns.
  -- The ledger stays accrual native and there is never a second set of books.
  cash_effect      text not null default 'none',
  cash_event_date  date,
  cash_source_line char(26),

  created_at     timestamptz not null default now(),

  unique (entry_id, line_number),
  constraint jl_line_number check (line_number > 0),
  constraint jl_amount_nonzero check (amount_cents <> 0),
  constraint jl_cascade_level check (cascade_level is null or cascade_level between 0 and 9),
  constraint jl_suspense_format check (suspense_reason is null or suspense_reason ~ '^SUS-[0-9]{2}$'),
  constraint jl_cash_effect check (cash_effect in ('none','cash','accrual_only')),
  constraint jl_cash_dated  check (cash_effect <> 'cash' or cash_event_date is not null),
  foreign key (client_id, account_number)
    references ledger.accounts (client_id, account_number),
  foreign key (client_id, category_id)
    references ledger.categories (client_id, id)
);

create index on ledger.journal_lines (client_id, account_number);
create index on ledger.journal_lines (entry_id);
create index on ledger.journal_lines (firm_id);
create index on ledger.journal_lines (client_id, category_id) where category_id is not null;
create index on ledger.journal_lines (client_id, cash_event_date)
  where cash_effect = 'cash';
create index on ledger.journal_lines (client_id, suspense_reason)
  where suspense_reason is not null;

-- Doc 00 Part 1 and doc 04 Part 14 item 1. Lines sum to exactly zero per entry,
-- checked at commit so an entry can be built line by line inside one transaction.
-- Drafts are exempt, because a draft is a work in progress. A posted entry is not.
create or replace function ledger.assert_entry_balanced()
returns trigger language plpgsql as $$
declare
  v_entry char(26) := coalesce(new.entry_id, old.entry_id);
  v_status text;
  v_sum bigint;
begin
  select status into v_status from ledger.journal_entries where id = v_entry;
  if v_status is null or v_status = 'draft' then
    return null;
  end if;
  select coalesce(sum(amount_cents), 0) into v_sum
    from ledger.journal_lines where entry_id = v_entry;
  if v_sum <> 0 then
    raise exception 'entry_not_balanced: entry % nets % cents', v_entry, v_sum
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger trg_entry_balanced
  after insert or update or delete on ledger.journal_lines
  deferrable initially deferred
  for each row execute function ledger.assert_entry_balanced();

alter table ledger.journal_entries enable row level security;
alter table ledger.journal_entries force row level security;
alter table ledger.journal_lines enable row level security;
alter table ledger.journal_lines force row level security;
create policy client_isolation on ledger.journal_entries
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on ledger.journal_lines
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on ledger.journal_entries
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on ledger.journal_lines
  for each row execute function tenancy.freeze_discriminators();

-- ---------------------------------------------------------------------------
-- Doc 03 Part 8. Period locks and the enforcement trigger. The database is the
-- first line of defense, not the application.
-- ---------------------------------------------------------------------------

create table ledger.period_locks (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null references tenancy.firms(id),
  client_id     uuid not null references tenancy.clients(id),
  period_start  date not null,
  period_end    date not null,
  locked_at     timestamptz not null default now(),
  locked_by     uuid not null,
  closed_with_exceptions boolean not null default false,
  exception_note text,
  unlocked_at   timestamptz,          -- non null means this lock is historical
  unlocked_by   uuid,
  unlock_reason text,
  constraint period_sane check (period_end >= period_start),
  constraint exception_needs_note check (
    not closed_with_exceptions or exception_note is not null
  ),
  constraint unlock_needs_reason check (
    unlocked_at is null or (unlocked_by is not null and unlock_reason is not null))
);

create index on ledger.period_locks (client_id, period_start, period_end);
create index on ledger.period_locks (firm_id);
create index on ledger.period_locks (client_id) where unlocked_at is null;

alter table ledger.period_locks enable row level security;
alter table ledger.period_locks force row level security;
create policy client_isolation on ledger.period_locks
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create or replace function ledger.enforce_period_lock()
returns trigger language plpgsql as $$
declare
  d date := coalesce(new.entry_date, old.entry_date);
  c uuid := coalesce(new.client_id, old.client_id);
begin
  if exists (
    select 1 from ledger.period_locks pl
    where pl.client_id = c
      and pl.unlocked_at is null
      and d between pl.period_start and pl.period_end
  ) then
    raise exception 'locked_period: % is inside a locked period for client %', d, c
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

create constraint trigger trg_period_lock_je
  after insert or update or delete on ledger.journal_entries
  deferrable initially immediate
  for each row execute function ledger.enforce_period_lock();

-- A line carries no entry_date of its own, so the line level guard reads the date
-- from its entry. Without this, a line could be added to an entry already inside a
-- locked period and the entry level trigger would never fire.
create or replace function ledger.enforce_period_lock_line()
returns trigger language plpgsql as $$
declare
  v_entry char(26) := coalesce(new.entry_id, old.entry_id);
  d date;
  c uuid := coalesce(new.client_id, old.client_id);
begin
  select entry_date into d from ledger.journal_entries where id = v_entry;
  if d is null then
    return coalesce(new, old);
  end if;
  if exists (
    select 1 from ledger.period_locks pl
    where pl.client_id = c
      and pl.unlocked_at is null
      and d between pl.period_start and pl.period_end
  ) then
    raise exception 'locked_period: % is inside a locked period for client %', d, c
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

create constraint trigger trg_period_lock_jl
  after insert or update or delete on ledger.journal_lines
  deferrable initially immediate
  for each row execute function ledger.enforce_period_lock_line();

commit;
