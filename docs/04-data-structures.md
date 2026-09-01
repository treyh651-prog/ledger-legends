# Ledger Legends: data structures

Status: schema document. Keys off `00-conventions.md`, which is the authority on money, account numbering, identifiers, versioning, the override flag, suspense reason codes, and close gates. Keys off `03-run-framework.md` for the run log contract. Backend is Neon Postgres, WorkOS AuthKit or Clerk for identity only, and a private S3 bucket for the vault, per `alt-data-platform.md` sections 5 and 8.

Everything below is the schema the mock data layer has been standing in for. It is written as migration ready DDL with the reasoning attached, because in six months the reasoning is the part that will be missing.

---

## Part 0. Ground rules that apply to every table

**Money is `bigint` cents.** Never `numeric`, never `money`, never `double precision`. `bigint` because integer cents in a `bigint` covers roughly 92 quadrillion dollars, and because arithmetic on it is exact and fast. `numeric` would also be exact but invites a decimal to sneak in at a boundary. The type itself is the enforcement.

**Signed lines.** One `amount_cents` column per journal line. Debit positive, credit negative. No debit column and no credit column anywhere in storage, per the conventions doc. Presentation splits the sign.

**Identifiers.** ULIDs stored as `char(26)` for anything read in time order, which is run logs, run items, audit events, journal entries, and documents. `uuid` for slow moving tables where creation order does not matter, notably firms, clients, and memberships. Accounts are the four digit string. Categories are `CAT-` plus slug. Rules are `RULE-` plus ULID. Do not mix: a table's id type is part of its contract.

**Two discriminators, always.** Every tenant table carries both `firm_id` and `client_id`. Not just `client_id`, because the practice management surfaces query by firm across clients, and a join through `clients` on every one of those queries is both slower and easier to get wrong in an RLS predicate. Both columns are immutable, enforced by trigger. A row does not change tenant.

**RLS enabled and forced.** `enable row level security` plus `force row level security` on every tenant table. Forced matters because the table owner is otherwise exempt, and the owner is exactly the role a migration or a maintenance script runs as.

**Indexes on the discriminators.** Every tenant table gets a leading `client_id` index, and the composite indexes lead with `client_id` too. An RLS predicate that cannot use an index turns every query into a sequential scan with a function call per row.

**Retire, never delete.** `is_active` or an `archived_at` timestamp on reference data. Financial records are appended and reversed, not removed.

### Schemas

| Schema | Contents | Reachable by `app_web` |
|---|---|---|
| `tenancy` | Firms, clients, memberships, users | Through views and functions |
| `ledger` | Accounts, categories, journal entries and lines, period locks, run log | No direct table access, views with `security_invoker = true` and RPCs only |
| `subledger` | Fixed assets, prepaids, amortization, loans, vendors, recurring templates | Views and RPCs |
| `billing` | Entitlements, tiers, subscriptions, feature flags | Read only views |
| `vault` | Document metadata, audit events | Through the API only |

Splitting `ledger` out is the decision from `alt-data-platform.md` phase 1: double entry tables sit in a schema no web facing role can reach directly. A bug in a route handler cannot write a journal line.

### The membership function

Every RLS policy on every table calls this and nothing else. It is defined once so a policy change never means rewriting a predicate thirty times.

```sql
create or replace function tenancy.current_actor()
returns uuid
language sql
stable
security definer
set search_path = tenancy, pg_catalog
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$$;

create or replace function tenancy.has_client_access(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = tenancy, pg_catalog
as $$
  select exists (
    select 1
    from tenancy.memberships m
    join tenancy.clients c on c.firm_id = m.firm_id
    where m.user_id  = tenancy.current_actor()
      and m.revoked_at is null
      and c.id = p_client_id
      and (m.scope = 'firm' or m.client_id = p_client_id)
  );
$$;

create or replace function tenancy.has_firm_access(p_firm_id uuid)
returns boolean
language sql
stable
security definer
set search_path = tenancy, pg_catalog
as $$
  select exists (
    select 1 from tenancy.memberships m
    where m.user_id = tenancy.current_actor()
      and m.firm_id = p_firm_id
      and m.revoked_at is null
  );
$$;

revoke all on function tenancy.has_client_access(uuid) from public;
grant execute on function tenancy.has_client_access(uuid) to app_web, app_worker;
```

Four details that all matter.

`security definer` so the function can read `memberships` while `memberships` itself is behind RLS. Without it the policy would need to read a table the caller cannot see, and the policy would recurse.

`set search_path` pinned, because a `security definer` function without a pinned search path is a privilege escalation waiting for someone to create a shadowing object.

`stable`, and every policy wraps the call in a `select`:

```sql
create policy client_isolation on subledger.fixed_assets
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
```

The `select` wrapper is not cosmetic. It lets the planner treat the result as an InitPlan evaluated once per statement rather than once per row. On a 50,000 row scan that is the difference between a fast query and a timeout. This is the pattern `alt-data-platform.md` section 5 calls "a `security definer` membership function wrapped in `select` so it caches per statement."

Entitlements are deliberately absent from this function. Authorization by tenancy and authorization by paid tier are two different questions and mixing them produces a policy that silently denies data when a card expires. See Part 11.

---

## Part 1. Accounts and categories

Two tables, per Part 2 of the conventions doc. This is the structural decision the whole coding model rests on.

```sql
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
  -- The block map from the conventions doc, enforced rather than documented.
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
```

Why the primary key is `(client_id, account_number)` and not a surrogate id: the account number is the natural key, humans type it, and every join from a journal line wants it. A surrogate would force a lookup to answer "what account is 6420" on every screen. The tradeoff is that renumbering an account is a data migration, which is correct, because renumbering an account is a serious act.

Why `acct_block_matches_type` is a check constraint and not validation code: the block map is a hard convention and the depreciation run depends on the 15xx and 16xx relationship. A constraint makes a violating chart impossible to insert from any path.

Why `acct_contra_offset` is a constraint: the conventions doc calls the offset of 100 a hard convention because the depreciation run relies on it. The `accounts_one_contra_per_cost` unique index adds that a single accumulated account cannot serve two cost accounts, which would make the register ambiguous.

The five clearing accounts are seeded on every chart regardless of template, and the seed is asserted by a migration test rather than by remembering.

```sql
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
alter table ledger.clearing_accounts enable row level security;
alter table ledger.clearing_accounts force row level security;
```

1900 carries `must_be_zero_at_close = false` and `support_list_required = true`, which is exactly gate G08. The other four carry `true` and feed G01. Encoding the gate inputs as data means the gate query reads the table instead of hard coding four account numbers.

### Categories

```sql
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
alter table ledger.category_versions enable row level security;
alter table ledger.category_versions force row level security;
```

`capitalize_over` defaults to 250000 cents at the client level, matching the de minimis safe harbor of 2,500 dollars per invoice or item for a taxpayer without applicable financial statements ([IRS tangible property final regulations](https://www.irs.gov/businesses/small-businesses-self-employed/tangible-property-final-regulations)). It is per client because the election is annual and the client's own written policy governs. A transaction over the threshold routes to `SUS-09` and the fixed asset register rather than to expense.

Naming note: the attribute is `1099_class` in the conventions doc. The column is `class_1099` because a Postgres identifier cannot start with a digit without quoting, and quoted mixed identifiers are a permanent tax on every query. The API keeps the documented name and maps it.

`class_1099` of `attorney` exists because legal fees for services are generally reported on Form 1099-NEC even when the firm is a corporation ([Anchin](https://www.anchin.com/articles/faqs-new-1099-nec-and-1099-misc-rules-beginning-in-2026/)), so the corporation exclusion in the 1099 run needs an exception path.

The version snapshot table is what makes a run log defensible six months later. A transaction coded under category version 2 keeps saying version 2 forever, and version 2 is still readable.

---

## Part 2. Fixed asset register

Two tables. Assets, and the depreciation schedule rows that a run posts from. The schedule is materialized rather than computed on demand, because the operator needs to see next month's amount before it posts, and because a method change must not silently rewrite history.

```sql
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
  -- Section 179 and bonus reduce the depreciable base for the book method only
  -- when the client's book policy follows tax. Default is no.
  depreciable_base_cents bigint generated always as
    (cost_cents - salvage_cents) stored,

  method         text not null,
  life_months    integer,
  ddb_factor     numeric(4,2),                -- 2.00 for double declining
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
  -- Offset of 100, per the conventions doc. Hard, because the run relies on it.
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
```

`accum_account` is stored even though the convention says it is `cost_account` plus 100. Storing it plus constraining it gives both properties: the run reads a column instead of computing an account number, and a wrong pairing cannot be saved. Never make a posting run derive an account number at runtime from arithmetic it cannot verify.

`depreciable_base_cents` is a stored generated column so no caller can compute the base differently. There is exactly one definition of base and it lives in the schema.

`method = 'none'` exists for land, which is in the register for completeness and reporting but never depreciates. Modeling it as a method beats a nullable method plus a boolean.

`convention` is per asset, not per client, because a mid quarter convention can be forced on a single acquisition year and the register must be able to say which assets used which.

### Depreciation schedule

```sql
create table subledger.depreciation_schedule (
  id             char(26) primary key,
  asset_id       char(26) not null references subledger.fixed_assets(id),
  client_id      uuid not null,
  firm_id        uuid not null,

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
```

`dep_one_posting_per_period` is the real double post protection. The run's idempotency key helps, but a partial unique index makes a second posting for the same asset and period impossible from any path, including a manual entry made by a person at 2am.

`schedule_version` plus a `superseded` status is how a method or life change works. The old rows stay, marked superseded, and the new version starts at the first unposted period. Posted history is never recomputed. This is the versioning rule from the conventions doc applied to a subledger.

The final period amount is a plug: computed as `depreciable_base_cents` minus accumulated through the prior period, so rounding never leaves a stray cent of net book value. Integer cents means rounding drift is real and must be absorbed deliberately in one known place.

---

## Part 3. Prepaid and amortization schedules

Prepaids, intangible amortization, and deferred revenue are the same shape: an amount sitting in a balance sheet account that releases to the income statement on a schedule. One table pattern, a `kind` discriminator, separate accounts.

```sql
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
  -- Blocks per the conventions doc, by kind.
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
  client_id      uuid not null,
  firm_id        uuid not null,
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
```

One table instead of three because the mechanics are identical and the differences are account blocks and sign. Three tables would mean three release runs, three sets of tests, and three places to fix the same rounding bug. The `def_balance_block` constraint keeps the kinds from bleeding into each other's account ranges.

Accruals live here too, with `reversal_entry_id` on the line, because an accrual is a deferral that reverses rather than releases. Gate G13 reads this table for both.

`sum(amount_cents) = total_cents` per schedule version is asserted by the generator and by a property test rather than a constraint, since a cross row sum constraint would need a trigger and the generator is the only writer.

---

## Part 4. Loans and amortization schedules

```sql
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
  client_id      uuid not null,
  firm_id        uuid not null,
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
```

`annual_rate_bps` as an integer in basis points, because there are no floats anywhere in this codebase and a rate is the most tempting place to break that. 7.25 percent is 725.

`loan_split_adds_up` is the constraint that pays for itself. The single most common bookkeeping defect on a loan is a payment posted entirely to principal or entirely to expense. The schedule is generated once, the split is arithmetically guaranteed, and `LOAN-SPLIT-PAYMENTS` matches a bank transaction to a schedule row and posts the split it finds there.

Variable rate loans get a new `schedule_version` on every rate change, effective from the first unposted payment. Posted payments are never recomputed.

`matched_transaction_id` is nullable and set at match time, so an early payoff or a skipped payment shows as an unmatched schedule row that a human resolves, rather than a silently wrong split.

---

## Part 5. Vendors

Vendors carry coding defaults, 1099 status, and W-9 tracking. The security decision here is deliberate and non negotiable: the full taxpayer identification number is never stored in Postgres.

```sql
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

  -- W-9 and TIN. Last four only, ever.
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
```

Why last four only. A full EIN or SSN in a Postgres table is a breach that ends the practice. Everything the software actually needs it for works on last four plus the document: matching a payee to a prior year filing, confirming a W-9 is on file, and showing a human enough to verify against the PDF. The full number lives in the signed W-9 in the S3 vault, behind Object Lock, presigned reads, and CloudTrail data events. Filing a 1099 means an operator opens the document at filing time through an audited presigned GET. No column, no index, no backup copy, no accidental log line.

`tin_verified_at` and `tin_verification_result` record that a TIN match check was performed without recording the number. `backup_withholding_required` is the derived flag, set when no valid W-9 with a correct TIN is on file, which matters because the backup withholding trigger moved to 2,000 dollars alongside the reporting threshold and is indexed for inflation from 2027 ([Littler](https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds)).

`normalized_name` plus `normalizer_version` because the normalization function is versioned like everything else in the conventions doc. When the normalizer changes, a backfill run recomputes the column and the version records which vendors were matched under which rules.

`aliases` as an array with a GIN index rather than a child table, because it is a short list, it is read on every coding pass, and it is never queried independently of its vendor.

The 1099 threshold itself is not on this table. It is a dated configuration value, because the Form 1099-NEC and 1099-MISC threshold rose from 600 dollars to 2,000 dollars for payments made on or after January 1, 2026, with inflation indexing from 2027 ([Littler](https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds)), and a prior year rerun must still produce 600 dollar behavior:

```sql
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
-- Global reference data, not tenant scoped. No RLS, read only to app roles.
```

Seeded with `1099_nec` at 60000 cents through tax year 2025 and 200000 cents from 2026, and `1099_k_amount` at 2000000 cents with `transaction_count` 200, since section 70432 reinstated the 20,000 dollar and 200 transaction thresholds for third party network reporting ([Littler](https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds)). `source_url` is on the row because a threshold without a citation is a number nobody will trust in three years.

---

## Part 6. Recurring entry templates

```sql
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

  cadence        text,                        -- monthly, quarterly, annual, semi_monthly, weekly
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
  client_id      uuid not null,
  firm_id        uuid not null,
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
  foreign key (client_id, account_number) references ledger.accounts (client_id, account_number)
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
```

Fixed splits are the reason this is two tables. The real world case is a 2,400 dollar monthly payment where 1,850 is rent, 400 is common area maintenance, and the rest is utilities that vary. `rec_split_one_basis` forces each line to be exactly one of a fixed cents amount, a percentage in basis points, or the remainder line. `rec_one_remainder_per_version` allows at most one remainder line per template version, which is what makes the split total to the transaction amount without float arithmetic or a rounding argument.

Percent splits use basis points and allocate largest remainder, so the parts always sum exactly to the whole. The allocation function is shared with the mixed business and personal split path for `SUS-07`.

Splits are versioned with the template, not edited in place, so an entry posted under version 3 can still be explained after version 4 ships.

---

## Part 7. Period locks

Full DDL and the enforcement trigger are in `03-run-framework.md` Part 8, because the enforcement is a framework guarantee rather than a schema detail. Restated here for completeness of the schema map, with the additions that belong to the close rather than to runs.

```sql
-- See 03-run-framework.md Part 8 for ledger.period_locks and the trigger.

create table ledger.close_runs (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  period_start   date not null,
  period_end     date not null,
  status         text not null,
  closed_at      timestamptz,
  closed_by      uuid,
  closed_with_exceptions boolean not null default false,
  period_lock_id uuid references ledger.period_locks(id),
  constraint close_status check (status in ('in_progress','closed','reopened','abandoned'))
);

create table ledger.close_gate_results (
  id             char(26) primary key,
  close_run_id   char(26) not null references ledger.close_runs(id),
  client_id      uuid not null,
  firm_id        uuid not null,
  gate_code      char(3) not null,            -- 'G01' through 'G17'
  result         text not null,
  evaluated_at   timestamptz not null default now(),
  detail         jsonb not null default '{}',
  not_applicable_reason text,
  override_by    uuid,
  override_reason text,
  override_at    timestamptz,
  constraint gate_code_format check (gate_code ~ '^G[0-9]{2}$'),
  constraint gate_result check (result in ('pass','fail','not_applicable')),
  constraint gate_na_reason check (result <> 'not_applicable' or not_applicable_reason is not null),
  constraint gate_override_complete check (
    override_by is null or (override_reason is not null and override_at is not null))
);

create index on ledger.close_runs (client_id, period_start desc);
create index on ledger.close_gate_results (client_id, close_run_id);
create index on ledger.close_gate_results (firm_id);
create index on ledger.close_gate_results (close_run_id, gate_code);

alter table ledger.close_runs enable row level security;
alter table ledger.close_runs force row level security;
alter table ledger.close_gate_results enable row level security;
alter table ledger.close_gate_results force row level security;
```

Important reading of the conventions doc: a gate is computed live against the ledger and never stored as a checkbox. `close_gate_results` is not a checkbox. It is the historical record of what a gate returned at the moment of closing, which is evidence. Live evaluation always recomputes and never reads this table for a pass or fail decision.

`gate_override_complete` encodes the override requirement of a named person plus a written reason. `closed_with_exceptions` propagates to `period_locks` so the flag rides with the lock, appears on the statement header, and cannot be cleared retroactively. There is no update path that clears it; the only resolution is a later corrected close, which is a new `close_runs` row.

---

## Part 8. Run log and run items

The framework contract is in `03-run-framework.md` Part 9. This is the storage.

```sql
create table ledger.run_log (
  id             char(26) not null,           -- ULID inside 'RUNX-'
  client_id      uuid not null,
  firm_id        uuid not null,

  run_type       text not null,               -- MODULE-VERB-OBJECT
  run_version    integer not null,
  mode           text not null,               -- 'preview' or 'apply'
  status         text not null,

  idempotency_key text not null,
  scope_hash     text not null,
  scope_input    jsonb not null,
  candidate_count integer not null default 0,
  candidate_ids  char(26)[],                  -- null when count exceeds 5000
  period_start   date,
  period_end     date,

  actor_id       uuid not null,
  actor_kind     text not null,               -- 'human','schedule','sequence'
  trigger_source text not null,               -- 'button','cron','sequence','api'
  sequence_id    char(26),
  sequence_step  integer,

  versions_used  jsonb not null default '[]', -- [{kind, id, version}, ...]

  proposed_count integer not null default 0,
  skipped_count  integer not null default 0,
  error_count    integer not null default 0,
  skips_by_reason jsonb not null default '{}',
  net_cents      bigint not null default 0,
  entries_created integer not null default 0,
  entries_reversed integer not null default 0,

  preview_run_id char(26),
  original_run_id char(26),
  attempt        integer not null default 1,

  git_sha        text,
  release_id     text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  duration_ms    integer,

  primary key (id, started_at),
  constraint run_mode check (mode in ('preview','apply')),
  constraint run_status check (status in (
    'started','completed','completed_with_skips','no_op','refused',
    'rejected_locked','deduplicated','failed','abandoned')),
  constraint run_actor_kind check (actor_kind in ('human','schedule','sequence')),
  constraint run_type_format check (run_type ~ '^[A-Z]+-[A-Z]+-[A-Z0-9]+$'),
  -- A run that writes the ledger must net to zero.
  constraint run_posting_nets_zero check (
    mode = 'preview' or entries_created = 0 or net_cents = 0)
) partition by range (started_at);

-- Monthly partitions. Retention is a detach, never a delete.
create table ledger.run_log_2026_09 partition of ledger.run_log
  for values from ('2026-09-01') to ('2026-10-01');

create unique index run_log_idem
  on ledger.run_log (idempotency_key)
  where mode = 'apply' and status in ('completed','completed_with_skips','no_op');

create index on ledger.run_log (client_id, run_type, started_at desc);
create index on ledger.run_log (firm_id, started_at desc);
create index on ledger.run_log (client_id, status) where status = 'started';
create index on ledger.run_log (sequence_id) where sequence_id is not null;

create table ledger.run_log_items (
  id             char(26) not null,
  run_id         char(26) not null,
  client_id      uuid not null,
  firm_id        uuid not null,

  target_table   text not null,
  target_id      char(26) not null,
  decision       text not null,               -- 'proposed','applied','skipped','errored'

  before_values  jsonb,
  after_values   jsonb,

  cascade_level  smallint,
  rule_id        text,
  rule_version   integer,
  template_id    char(26),
  template_version integer,
  schedule_line_id char(26),

  suspense_reason char(6),                    -- 'SUS-nn'
  skip_reason    text,
  journal_entry_id char(26),
  error_code     text,
  error_message  text,

  created_at     timestamptz not null default now(),
  primary key (id, created_at),
  constraint item_decision check (decision in ('proposed','applied','skipped','errored')),
  constraint item_cascade_level check (cascade_level is null or cascade_level between 0 and 9),
  constraint item_suspense_format check (suspense_reason is null or suspense_reason ~ '^SUS-[0-9]{2}$'),
  constraint item_skip_has_reason check (decision <> 'skipped' or skip_reason is not null),
  constraint item_error_has_code check (decision <> 'errored' or error_code is not null)
) partition by range (created_at);

create index on ledger.run_log_items (run_id);
create index on ledger.run_log_items (client_id, target_table, target_id);
create index on ledger.run_log_items (firm_id);
create index on ledger.run_log_items (client_id, suspense_reason)
  where suspense_reason is not null;

create table ledger.run_log_events (
  id             char(26) primary key,
  run_id         char(26) not null,
  client_id      uuid not null,
  firm_id        uuid not null,
  event          text not null,               -- 'completed','failed','retried','undone','abandoned'
  detail         jsonb not null default '{}',
  created_at     timestamptz not null default now()
);

create table ledger.run_sequences (
  id             char(26) primary key,
  client_id      uuid not null,
  firm_id        uuid not null,
  name           text not null,
  status         text not null,
  child_run_ids  char(26)[] not null default '{}',
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  stopped_at_step integer,
  constraint seq_status check (status in ('running','completed','stopped','failed'))
);

alter table ledger.run_log       enable row level security;
alter table ledger.run_log       force  row level security;
alter table ledger.run_log_items enable row level security;
alter table ledger.run_log_items force  row level security;
alter table ledger.run_log_events enable row level security;
alter table ledger.run_log_events force row level security;
alter table ledger.run_sequences enable row level security;
alter table ledger.run_sequences force row level security;

create policy client_isolation on ledger.run_log
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
-- Same policy shape on items, events, and sequences.

-- Insert only. See 03-run-framework.md Part 9.
revoke update, delete, truncate on ledger.run_log, ledger.run_log_items,
  ledger.run_log_events, ledger.run_sequences from app_web, app_worker;
create rule run_log_no_update as on update to ledger.run_log do instead nothing;
create rule run_log_no_delete as on delete to ledger.run_log do instead nothing;
```

Design notes.

Partitioned by `started_at` monthly, which forces `started_at` into the primary key. That is acceptable because ULIDs already sort by time and every query is time bounded anyway. The payoff is that seven year retention and the eighteen month item level trim are partition detaches, which is consistent with having revoked delete.

`candidate_ids` is stored inline up to 5,000 ids and null above that, with `scope_hash` always present. Storing 200,000 ULIDs in an array would bloat the log without adding evidentiary value, and the hash is what idempotency actually needs.

`run_log_idem` is a partial unique index rather than a column constraint so that a `failed` execution does not permanently poison a key. A failed run changed nothing, so retrying it with the same key must be allowed.

`versions_used` as JSONB rather than a child table because it is written once, read whole, and never queried by element in a hot path. This is the row that answers "which rule version coded this" six months later.

`run_posting_nets_zero` is a cheap structural guarantee that a logged apply which created entries reported a zero net, matching gate G05 and the property test in the run framework.

---

## Part 9. Rules

```sql
create table ledger.rules (
  id             text primary key,            -- 'RULE-' plus ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  name           text not null,
  priority       integer not null default 100,
  condition_count integer not null,
  conditions     jsonb not null,
  target_category_id text not null,
  target_class_id char(26),

  scope_kind     text not null default 'client',  -- 'client' or 'firm_library'
  effective_from date,
  effective_to   date,
  is_active      boolean not null default true,
  hit_count      integer not null default 0,
  last_hit_at    timestamptz,

  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint rule_id_format check (id ~ '^RULE-[0-9A-HJKMNP-TV-Z]{26}$'),
  constraint rule_priority check (priority between 0 and 1000),
  constraint rule_condition_count check (condition_count >= 1),
  -- The stored count must agree with the payload, since tie breaking uses it.
  constraint rule_count_matches check (
    condition_count = jsonb_array_length(conditions)),
  constraint rule_scope check (scope_kind in ('client','firm_library')),
  constraint rule_dates check (effective_to is null or effective_from is null
    or effective_to >= effective_from),
  foreign key (client_id, target_category_id)
    references ledger.categories (client_id, id)
);

-- The exact tie breaking order from the conventions doc, as an index.
create index rules_selection
  on ledger.rules (client_id, priority desc, condition_count desc, id asc)
  where is_active;
create index on ledger.rules (firm_id);
create index rules_conditions_gin on ledger.rules using gin (conditions);

create table ledger.rule_versions (
  rule_id     text not null,
  version     integer not null,
  client_id   uuid not null,
  firm_id     uuid not null,
  snapshot    jsonb not null,
  valid_from  timestamptz not null default now(),
  valid_to    timestamptz,
  changed_by  uuid not null,
  change_note text,
  primary key (rule_id, version)
);

alter table ledger.rules enable row level security;
alter table ledger.rules force row level security;
alter table ledger.rule_versions enable row level security;
alter table ledger.rule_versions force row level security;
create policy client_isolation on ledger.rules
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on ledger.rule_versions
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
```

`rules_selection` is the index that makes the cascade deterministic and fast at the same time. It is ordered exactly as the conventions doc specifies tie breaking: explicit integer priority descending, then condition count descending as a specificity proxy, then rule id ascending. The selection query reads the index in order and stops.

`condition_count` is denormalized because it is a tie break input. `rule_count_matches` keeps it honest, so a rule cannot win on specificity it does not have.

Two surviving rules that target different categories are not resolved by the index. They route to `SUS-19` with both rule ids surfaced, per the conventions doc. The database's job is to make the ordering deterministic; the run's job is to refuse to guess.

`conditions` as JSONB with a GIN index rather than a condition child table. Conditions are read whole on every evaluation, never partially, and the GIN index supports the rule maintenance screens that ask which rules mention a given vendor string. A child table would add a join to the hottest path in the product.

`scope_kind = 'firm_library'` rules are templates copied into a client, not shared at evaluation time. Evaluation never crosses a client boundary, which keeps the two tenant negative test meaningful.

---

## Part 10. Tenancy

```sql
create table tenancy.firms (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique,
  created_at    timestamptz not null default now(),
  archived_at   timestamptz
);

create table tenancy.users (
  id            uuid primary key default gen_random_uuid(),
  auth_subject  text not null unique,         -- 'sub' from WorkOS or Clerk
  email         text not null,
  display_name  text,
  created_at    timestamptz not null default now(),
  disabled_at   timestamptz
);

create table tenancy.clients (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null references tenancy.firms(id),
  name          text not null,
  entity_type   text not null,
  is_nonprofit  boolean not null default false,
  fiscal_year_end_month smallint not null default 12,
  functional_currency char(3) not null default 'USD',
  capitalize_over_cents bigint not null default 250000,
  engagement_scope jsonb not null default '{}',  -- drives conditional close gates
  chart_template_id text,
  onboarded_at  timestamptz,
  archived_at   timestamptz,
  constraint client_fye check (fiscal_year_end_month between 1 and 12),
  constraint client_currency check (functional_currency = 'USD')
);

create table tenancy.memberships (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references tenancy.users(id),
  firm_id       uuid not null references tenancy.firms(id),
  client_id     uuid references tenancy.clients(id),   -- null means firm wide
  scope         text not null,
  role          text not null,
  granted_at    timestamptz not null default now(),
  granted_by    uuid not null,
  revoked_at    timestamptz,
  revoked_by    uuid,
  constraint mem_scope check (scope in ('firm','client')),
  constraint mem_client_matches_scope check (
    (scope = 'firm' and client_id is null) or (scope = 'client' and client_id is not null)),
  constraint mem_role check (role in ('owner','manager','preparer','reviewer','client_user','read_only'))
);

create unique index mem_unique_active
  on tenancy.memberships (user_id, firm_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where revoked_at is null;
create index on tenancy.memberships (user_id) where revoked_at is null;
create index on tenancy.memberships (firm_id) where revoked_at is null;
create index on tenancy.memberships (client_id) where revoked_at is null;

alter table tenancy.clients enable row level security;
alter table tenancy.clients force row level security;
alter table tenancy.memberships enable row level security;
alter table tenancy.memberships force row level security;
create policy firm_isolation on tenancy.clients
  using ( (select tenancy.has_firm_access(firm_id)) );
create policy own_memberships on tenancy.memberships
  using ( user_id = (select tenancy.current_actor())
          or (select tenancy.has_firm_access(firm_id)) );

-- Immutable discriminators, applied to every tenant table.
create or replace function tenancy.freeze_discriminators()
returns trigger language plpgsql as $$
begin
  if new.firm_id is distinct from old.firm_id
     or new.client_id is distinct from old.client_id then
    raise exception 'tenant_discriminator_immutable on %', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
```

`memberships` is the only authority on who can see what. The JWT from WorkOS or Clerk carries `sub` and nothing authoritative, per `alt-data-platform.md` section 5, so revoking a staff member takes effect on the next statement rather than the next token refresh. `revoked_at` rather than a delete, because "who had access in March" is a question an auditor asks.

`engagement_scope` drives the conditional close gates. Gates G09 through G14 and G16 read it to return not applicable with a reason rather than failing. That is why it is on the client row and not inferred from whether data happens to exist.

`functional_currency` is constrained to USD today, since foreign currency is out of scope and anything else routes to `SUS-11`. The column exists so the constraint is the only thing that changes when scope expands.

---

## Part 11. Entitlements and tiers

Kept strictly separate from tenancy. This is a deliberate boundary, not an organizational preference.

```sql
create table billing.tiers (
  id            text primary key,             -- 'solo','practice','firm'
  name          text not null,
  sort_order    integer not null,
  is_public     boolean not null default true
);

create table billing.features (
  id            text primary key,             -- 'fixed_assets','1099_run','portal_requests'
  name          text not null,
  description   text not null
);

create table billing.tier_features (
  tier_id       text not null references billing.tiers(id),
  feature_id    text not null references billing.features(id),
  limit_value   integer,                      -- null means unlimited
  primary key (tier_id, feature_id)
);

create table billing.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null references tenancy.firms(id),
  tier_id       text not null references billing.tiers(id),
  status        text not null,
  client_seats  integer,
  current_period_end date,
  external_ref  text,                         -- processor subscription id
  created_at    timestamptz not null default now(),
  constraint sub_status check (status in ('trialing','active','past_due','canceled','paused'))
);

create unique index sub_one_active_per_firm
  on billing.subscriptions (firm_id) where status in ('trialing','active','past_due');

create table billing.entitlement_overrides (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null references tenancy.firms(id),
  feature_id    text not null references billing.features(id),
  granted       boolean not null,
  limit_value   integer,
  reason        text not null,
  granted_by    uuid not null,
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index on billing.subscriptions (firm_id);
create index on billing.entitlement_overrides (firm_id, feature_id);

-- Read only to the app. Entitlements are never a row visibility predicate.
create or replace function billing.has_feature(p_firm_id uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = billing, pg_catalog
as $$
  select coalesce(
    (select o.granted
       from billing.entitlement_overrides o
      where o.firm_id = p_firm_id and o.feature_id = p_feature
        and (o.expires_at is null or o.expires_at > now())
      order by o.created_at desc limit 1),
    exists (
      select 1
        from billing.subscriptions s
        join billing.tier_features tf on tf.tier_id = s.tier_id
       where s.firm_id = p_firm_id
         and s.status in ('trialing','active','past_due')
         and tf.feature_id = p_feature),
    false);
$$;
```

Why the separation is strict. If a tier check ever appears inside an RLS policy, then a lapsed card makes a client's ledger rows disappear, a close breaks, and a report silently changes. Tenancy answers "is this your data" and the answer never changes with billing state. Entitlements answer "can you use this feature right now" and are checked in the API layer and the UI, above the data layer, where a `402` or a disabled button is the correct outcome.

Concrete consequences:

- No table in `ledger`, `subledger`, `tenancy`, or `vault` references anything in `billing`.
- `tenancy.has_client_access` does not call `billing.has_feature`, and CI greps for that.
- A `past_due` subscription keeps read access to everything. It blocks new applies of gated runs. Books are never held hostage.
- A run gated by entitlement reports `entitlement_not_included` as a skip reason, so the log shows why it did nothing instead of appearing to have found nothing.
- Downgrading a tier never deletes data. Fixed asset rows survive losing the fixed asset feature; they become read only.

---

## Part 12. Document vault metadata

Bytes live in a private S3 bucket. Postgres holds metadata and the audit trail, per `alt-data-platform.md` sections 1, 5, and 8, where the deciding argument is that Supabase Storage objects are excluded from its own backups while S3 gives versioning, Object Lock, and CloudTrail data events.

```sql
create table vault.documents (
  id             char(26) primary key,        -- ULID, and part of the object key
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  doc_type       text not null,
  title          text not null,
  period_start   date,
  period_end     date,
  tax_year       integer,

  -- S3 coordinates. No URLs, no credentials, no bytes.
  bucket         text not null,
  object_key     text not null,
  s3_version_id  text,
  storage_class  text not null default 'STANDARD',
  kms_key_alias  text not null,
  object_lock_mode text,
  object_lock_until date,

  byte_size      bigint,
  content_type   text,
  sha256_hex     char(64),

  status         text not null default 'pending',
  uploaded_at    timestamptz,
  head_verified_at timestamptz,

  linked_vendor_id char(26),
  linked_asset_id  char(26),
  linked_loan_id   char(26),
  linked_transaction_id char(26),
  request_id     char(26),                    -- portal request this satisfied
  contains_tin   boolean not null default false,

  uploaded_by    uuid,
  created_at     timestamptz not null default now(),
  archived_at    timestamptz,

  constraint doc_type_check check (doc_type in (
    'bank_statement','card_statement','w9','engagement_letter','invoice','receipt',
    'loan_agreement','asset_invoice','payroll_report','tax_return','other')),
  constraint doc_status check (status in ('pending','uploaded','verified','quarantined','failed')),
  -- The object key must embed the tenant path, so a mismatch is unsaveable.
  constraint doc_key_shape check (
    object_key = 'firm/' || firm_id::text || '/client/' || client_id::text
                 || '/' || id || '/' || split_part(object_key, '/', 6)),
  constraint doc_lock_mode check (object_lock_mode is null
    or object_lock_mode in ('GOVERNANCE','COMPLIANCE')),
  constraint doc_verified_needs_head check (
    status not in ('uploaded','verified') or head_verified_at is not null),
  constraint doc_hash_when_verified check (status <> 'verified' or sha256_hex is not null),
  -- Long retention prefixes must carry a lock.
  constraint doc_retention_for_sensitive check (
    doc_type not in ('engagement_letter','bank_statement','w9')
    or object_lock_mode is not null)
);

create unique index doc_one_key on vault.documents (bucket, object_key);
create index on vault.documents (client_id, doc_type, period_start desc);
create index on vault.documents (firm_id);
create index on vault.documents (client_id, status) where status <> 'verified';
create index on vault.documents (client_id, tax_year) where doc_type = 'w9';

create table vault.audit_events (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null,
  firm_id        uuid not null,
  document_id    char(26) references vault.documents(id),
  action         text not null,
  actor_id       uuid,
  actor_kind     text not null,
  presigned_expires_at timestamptz,
  ip_inet        inet,
  user_agent     text,
  run_id         char(26),
  detail         jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  constraint audit_action check (action in (
    'row_created','presigned_put_issued','head_verified','presigned_get_issued',
    'download_completed','metadata_updated','archived','restored_from_version',
    'lock_applied','access_denied'))
);

create index on vault.audit_events (client_id, created_at desc);
create index on vault.audit_events (document_id, created_at desc);
create index on vault.audit_events (firm_id, created_at desc);

alter table vault.documents enable row level security;
alter table vault.documents force row level security;
alter table vault.audit_events enable row level security;
alter table vault.audit_events force row level security;
create policy client_isolation on vault.documents
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on vault.audit_events
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

revoke update, delete, truncate on vault.audit_events from app_web, app_worker;
```

`doc_key_shape` is the constraint worth defending. The object key is derived from the row, in the order `alt-data-platform.md` phase 2 specifies: insert the row first, derive the key from the row id, issue a presigned PUT scoped to exactly that key, then flip to `uploaded` only after a HeadObject check. Because the key must contain both discriminators and the row id, a document row can never point at another tenant's object even if application code builds a key wrong. RLS on the row plus the key shape constraint means row visibility and object addressing cannot disagree.

`status` starts at `pending` and only reaches `verified` after a hash check, so an abandoned upload is visibly abandoned rather than a broken link on a screen. The `client_id, status` partial index is what the reconciliation sweeper reads.

`audit_events` is insert only and is written before the presigned GET is returned, not after. If the audit write fails, the URL is not issued. That is what makes the audit trail a database invariant rather than a log line, and it is why `presigned_get_issued` and `download_completed` are separate actions: the first is what the system did, the second is what CloudTrail can confirm.

`contains_tin` marks the documents whose bytes hold a full taxpayer identification number, which per Part 5 is the only place a full TIN exists. Those documents get the shortest presigned lifetime and generate an audit event on every view without exception.

`s3_version_id` is stored because versioning is on and the restore drill requires restoring specific prior versions. A restore writes a `restored_from_version` audit event and updates the column; it never creates a second document row, because the document is the same document.

---

## Part 13. Migration order

Sequenced so nothing irreversible happens before isolation is proven, following `alt-data-platform.md` phase 1.

| Migration | Contents | Gate before proceeding |
|---|---|---|
| `0001_tenancy.sql` | Firms, users, clients, memberships, the membership functions, RLS enabled and forced, discriminator indexes, `revoke all on schema public from public` | Two tenant negative test green, and failing loudly when a policy is dropped |
| `0002_ledger_core.sql` | `ledger` schema, accounts, clearing accounts, categories and versions, journal entries and lines, period locks and the enforcement trigger | Trial balance foots to zero property test green, locked period trigger test green |
| `0003_run_log.sql` | Run log, items, events, sequences, partitions, insert only rules, override guard trigger | Insert only assertions green |
| `0004_rules.sql` | Rules, rule versions, selection index | Determinism test on rule selection green |
| `0005_subledgers.sql` | Fixed assets, depreciation schedule, deferrals, loans, vendors, recurring templates and splits | Golden fixture per run green |
| `0006_close.sql` | Close runs, gate results | All seventeen gates evaluable against a seeded client |
| `0007_billing.sql` | Tiers, features, tier features, subscriptions, overrides | CI check that no tenant table references `billing` |
| `0008_vault.sql` | Documents, audit events | Upload, verify, presign, and restore from version all exercised by hand once |

Applied by the `migrator` role over a direct connection, never over the Neon pooler, per Neon's guidance that schema migrations and session state dependent work should not use PgBouncer in transaction mode ([Neon connection pooling](https://neon.com/docs/connect/connection-pooling)).

---

## Part 14. Open items

1. Journal entry and line DDL is referenced throughout and belongs in `02-ledger.md`, which does not exist yet. The constraint that lines sum to exactly zero per entry needs a deferred constraint trigger, and that design should be settled there rather than assumed here.
2. Class, location, and program dimension tables are referenced by id from splits and lines and need their own small section. They are dimensions, never accounts, per the conventions doc.
3. Whether `vault.audit_events` should be partitioned. Probably yes, on the same monthly pattern as the run log, once volume is known.
4. Bank feed and reconciliation tables. Gate G03 depends on them and they are not modeled here.
