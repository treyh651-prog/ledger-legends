-- 0015_close.sql
-- Doc 02 module 6. Substantiation and close, which has no storage yet.
--
-- Migrations 0001 through 0014 built the ledger, the import pipeline, the
-- coding cascade, reconciliation, the period end subledgers, and the receivable
-- and payable subledger. None of them created a place to record that an account
-- was substantiated, that a gate was evaluated, that a document was asked for,
-- that a period was opened, or that a fiscal year was closed. The six module 6
-- runs cannot be written against the schema as it stands, so this migration
-- creates the close schema rather than only adding columns.
--
-- What is created here, and why each table has to exist:
--
--   1. close.periods. A period is currently implied by the existence of a lock
--      row, which means an open period has no identity and CLOSE-ROLL-FORWARD
--      has nothing to open. One row per client per period, with a status of
--      open or locked, is what makes the sentence "set the period status to
--      locked" mean something.
--   2. close.sub_tieouts. One row per substantiated balance sheet account per
--      period, carrying the ledger balance, the supported balance, the signed
--      variance, and whether the two agree. SUB-TIEOUT-ACCOUNTS never posts, so
--      its whole output is this table.
--   3. close.substantiation_records. The supporting figures that live outside
--      the ledger and outside every subledger built so far: a physical
--      inventory count and a payroll register. Both are a number a person
--      produced from a document, so both are stored the same way, with the
--      kind naming which one it is.
--   4. close.document_requests. One row per open item, deduplicated by a
--      subject key, carrying the owner, the age in days, and the escalation
--      state. SUB-RAISE-REQUESTS refreshes a row rather than creating a second
--      one, which is why the subject key is unique per client.
--   5. close.close_gate_results. One row per gate per period, with an outcome
--      of pass, fail, or not_applicable and a payload holding the rows that
--      blocked it. The payload is a snapshot and not a live query, because a
--      gate result read a week later has to say what was true when it ran.
--   6. close.opening_balances. What CLOSE-ROLL-FORWARD writes. Opening
--      balances are copied from the immutable trial balance snapshot on the
--      prior period lock, never recomputed, and never posted as an entry.
--   7. close.closing_entries. One row per fiscal year, naming the entry that
--      closed revenue and expense to equity. Idempotency per fiscal year is a
--      lookup against this table rather than a scan of the ledger.
--
-- ledger.period_locks gains the snapshot columns CLOSE-LOCK-PERIOD records: the
-- gate result set it read, the trial balance it froze, and a fingerprint of the
-- ledger rows in the period. The fingerprint is what lets a later run prove the
-- gate set was evaluated after the last ledger write rather than before it.
--
-- ledger.client_policies gains the entity kind and the three equity accounts
-- CLOSE-POST-YEAREND closes into, because doc 00 puts equity in a block and not
-- at a fixed number, and a nonprofit closes to two net asset classes rather
-- than to retained earnings.
--
-- subledger.vendors gains the two W-9 columns SUB-RAISE-REQUESTS reads. A W-9
-- on file with an expiry date is a document fact about a vendor, so it belongs
-- on the vendor row.
--
-- Every money column is bigint integer cents, debit positive and credit
-- negative, per doc 00 Part 1. Every table a run writes carries a version
-- column and the manual override columns with the override guard trigger,
-- because the override contract in doc 03 Part 6 is a property of the store.
--
-- COMPLIANCE. Nothing here computes a tax liability, files a form, or issues a
-- return. Closing revenue and expense to retained earnings or to net assets is
-- a bookkeeping mechanic. A tax position is CPA work and routes to
-- CPA-BUILD-HANDOFF. There is no delivery column anywhere in this migration and
-- no external address column, because no run in this module sends anything.
--
-- Forward only. No down migration.

begin;

create schema if not exists close;

-- ---------------------------------------------------------------------------
-- 1. Periods. An open period with an identity.
--
-- The status column is the whole point. Before this table a period was open
-- because no lock row covered it, which is a fact about an absence and cannot
-- be opened, closed, or pointed at. CLOSE-ROLL-FORWARD opens exactly one
-- period, and CLOSE-LOCK-PERIOD moves one from open to locked.
-- ---------------------------------------------------------------------------

create table close.periods (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  period_start   date not null,
  period_end     date not null,
  -- The fiscal year the period belongs to. Stored rather than derived because a
  -- fiscal year that does not start in January is a client fact.
  fiscal_year_start date not null,
  fiscal_year_end   date not null,

  status         text not null default 'open',
  opened_by_run_id char(31),
  opened_at      timestamptz,
  locked_by_run_id char(31),
  locked_at      timestamptz,
  -- The period this one took its opening balances from, null for the first.
  rolled_from_period_start date,

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint close_period_one_per_client unique (client_id, period_start),
  constraint close_period_status check (status in ('open', 'locked')),
  constraint close_period_window check (period_end >= period_start),
  constraint close_period_fiscal_window check (fiscal_year_end >= fiscal_year_start)
);

create index close_periods_client_status on close.periods (client_id, status);

-- ---------------------------------------------------------------------------
-- 2. Tie outs. One row per substantiated account per period.
--
-- The state column carries the three values doc 02 names and deliberately does
-- not carry a fourth called tied. A run computes agreement, a person confirms
-- it, and the two are not the same claim, so the boolean records what the
-- arithmetic said and the state records what the run is willing to assert.
-- ---------------------------------------------------------------------------

create table close.sub_tieouts (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  period_start   date not null,
  period_end     date not null,
  account_number char(4) not null,
  account_name   text not null,

  -- Which substantiation source answered for this account.
  source_kind    text not null,
  source_ref     text,

  ledger_balance_cents    bigint not null,
  supported_balance_cents bigint,
  -- Ledger minus supported, signed, per doc 02. Null when unsupported.
  variance_cents bigint,
  tied           boolean not null default false,
  -- Doc 02. A balance sitting on the side the account cannot hold, with no
  -- reason recorded, is its own finding and not a variance.
  wrong_side_no_reason boolean not null default false,
  state          text not null,
  detail         text not null default '',

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint sub_tieout_one_per_account unique (client_id, period_start, account_number),
  constraint sub_tieout_state check (
    state in ('computed_tied', 'unsupported', 'variance_open')),
  constraint sub_tieout_source_kind check (
    source_kind in (
      'statement_balance', 'aging_total', 'schedule_remaining',
      'roll_forward_net', 'physical_count', 'register_total', 'none'))
);

create index sub_tieouts_open on close.sub_tieouts (client_id, period_start, state);

-- ---------------------------------------------------------------------------
-- 3. Substantiation records. The figures that come from outside the ledger.
--
-- An inventory count and a payroll register are the same shape: a period, an
-- account, a number, and the person who produced it. Two thin tables would say
-- the same thing twice, so the kind column names which document the number came
-- from and one table holds both.
-- ---------------------------------------------------------------------------

create table close.substantiation_records (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  kind           text not null,
  account_number char(4) not null,
  period_start   date not null,
  period_end     date not null,
  -- The supported balance in the ledger sign convention, so an inventory count
  -- is positive and a payroll liability register is negative.
  supported_balance_cents bigint not null,
  source_ref     text,
  prepared_by    uuid,
  prepared_on    date,

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint substantiation_one_per_account unique (client_id, period_start, kind, account_number),
  constraint substantiation_kind check (
    kind in ('inventory_count', 'payroll_register', 'other'))
);

-- ---------------------------------------------------------------------------
-- 4. Document requests. One row per open item, refreshed rather than repeated.
--
-- The subject key is the identity of the ask. Doc 02 dedupes on the client, the
-- catalog code, the account, the period, and the linked item, so the run builds
-- that tuple into one string and the unique constraint holds it. A second
-- execution refreshes the age and the escalation on the row that is already
-- there, which is what keeps a client from receiving the same question twice.
--
-- There is no delivery column here. A request is a record of what is missing,
-- and nothing in this module sends it anywhere.
-- ---------------------------------------------------------------------------

create table close.document_requests (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  subject_key    text not null,
  catalog_code   text not null,
  owner          text not null,
  account_number char(4),
  period_start   date not null,
  linked_item_id char(26),
  detail         text not null default '',

  status         text not null default 'open',
  opened_on      date not null,
  as_of_date     date not null,
  aging_days     integer not null default 0,
  escalates_on   date not null,
  escalation     text not null default 'none',
  owner_changed_on date,
  last_refreshed_on date,
  refresh_count  integer not null default 0,

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint document_request_one_per_subject unique (client_id, subject_key),
  constraint document_request_owner check (owner in ('firm', 'client', 'system')),
  constraint document_request_status check (status in ('open', 'satisfied', 'waived')),
  constraint document_request_escalation check (
    escalation in ('none', 'first', 'second', 'final')),
  constraint document_request_aging check (aging_days >= 0)
);

create index document_requests_open on close.document_requests (client_id, status, escalates_on);

-- ---------------------------------------------------------------------------
-- 5. Gate results. One row per gate per period, with the blocking rows kept.
--
-- The payload is jsonb and it is a snapshot. A gate that failed in March has to
-- keep saying why in June, and a live query cannot do that because the rows it
-- would read have since been fixed. CLOSE-LOCK-PERIOD reads the outcome column
-- and refuses on a single fail, so the outcome is constrained to three values
-- and there is no null.
-- ---------------------------------------------------------------------------

create table close.close_gate_results (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  period_start   date not null,
  period_end     date not null,
  gate_code      char(3) not null,            -- G01 through G19
  gate_title     text not null,
  outcome        text not null,
  blocking_count integer not null default 0,
  payload        jsonb not null default '[]'::jsonb,
  scope_reason   text,
  -- The ledger rows the gate read, hashed. CLOSE-LOCK-PERIOD compares this to a
  -- fresh fingerprint so a gate set evaluated before the last ledger write
  -- cannot be used to lock a period.
  ledger_fingerprint text not null,

  evaluated_at   timestamptz not null,
  evaluated_by_run_id char(31),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  override_reason text,

  constraint gate_result_one_per_period unique (client_id, period_start, gate_code),
  constraint gate_result_outcome check (outcome in ('pass', 'fail', 'not_applicable')),
  constraint gate_result_blocking check (blocking_count >= 0),
  -- A fail with no blocking rows and a pass with blocking rows are both a run
  -- that did not finish thinking. The schema refuses both.
  constraint gate_result_blocking_agrees check (
    (outcome = 'fail' and blocking_count > 0)
    or (outcome <> 'fail' and blocking_count = 0))
);

-- ---------------------------------------------------------------------------
-- 6. Opening balances. Copied forward, never recomputed.
--
-- Doc 02 CLOSE-ROLL-FORWARD copies from the immutable snapshot on the prior
-- period lock. Recomputing from the ledger would produce a number that drifts
-- if a later correction lands in the closed period, which is exactly the drift
-- a lock exists to prevent.
-- ---------------------------------------------------------------------------

create table close.opening_balances (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  period_start   date not null,
  account_number char(4) not null,
  opening_balance_cents bigint not null,
  source_period_start date not null,
  source_kind    text not null default 'prior_period_snapshot',

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint opening_balance_one_per_account unique (client_id, period_start, account_number)
);

-- ---------------------------------------------------------------------------
-- 7. Closing entries. One row per fiscal year.
--
-- The ledger already holds the entry. This table holds the claim that the
-- fiscal year was closed, which is what makes a second execution report the
-- work as already done instead of closing the same year twice.
-- ---------------------------------------------------------------------------

create table close.closing_entries (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  fiscal_year_start date not null,
  fiscal_year_end   date not null,
  entry_id       char(26) not null references ledger.journal_entries(id),
  entry_date     date not null,
  entity_kind    text not null,
  equity_account char(4) not null,
  closed_revenue_cents bigint not null,
  closed_expense_cents bigint not null,
  closed_net_cents     bigint not null,
  account_count  integer not null default 0,

  posted_by_run_id char(31),
  posted_at      timestamptz not null,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint closing_entry_one_per_year unique (client_id, fiscal_year_end),
  constraint closing_entry_entity_kind check (entity_kind in ('for_profit', 'nonprofit'))
);

-- ---------------------------------------------------------------------------
-- 8. Period locks gain the snapshot columns.
--
-- Doc 02 CLOSE-LOCK-PERIOD records the gate result set it read and the trial
-- balance it froze. Both are stored on the lock because both are evidence about
-- that lock and neither should be reachable through a query that could return a
-- different answer later.
-- ---------------------------------------------------------------------------

alter table ledger.period_locks
  add column status text not null default 'locked',
  add column gate_results_snapshot jsonb not null default '[]'::jsonb,
  add column trial_balance_snapshot jsonb not null default '[]'::jsonb,
  add column ledger_fingerprint text not null default '',
  add column locked_by_run_id char(31);

alter table ledger.period_locks
  add constraint period_lock_status check (status in ('locked', 'unlocked'));

-- ---------------------------------------------------------------------------
-- 9. Client policy gains the entity kind and the equity accounts.
--
-- Doc 00 Part 4 puts equity in the 3000 block and does not fix a number inside
-- it, so the account CLOSE-POST-YEAREND closes into has to be read. A nonprofit
-- closes to the two ASU 2016-14 net asset classes, and the residual lands in
-- the class without donor restrictions, so both accounts are named here.
-- ---------------------------------------------------------------------------

alter table ledger.client_policies
  add column entity_kind text not null default 'for_profit',
  add column retained_earnings_account char(4),
  add column net_assets_without_restrictions_account char(4),
  add column net_assets_with_restrictions_account char(4),
  add column fiscal_year_end_month integer not null default 12;

alter table ledger.client_policies
  add constraint client_policy_entity_kind check (
    entity_kind in ('for_profit', 'nonprofit')),
  add constraint client_policy_fiscal_month check (
    fiscal_year_end_month between 1 and 12),
  -- A for profit needs retained earnings and a nonprofit needs the class
  -- without donor restrictions. Without one of them the year end close has
  -- nowhere to put the result, and doc 02 lists that as blocking.
  add constraint client_policy_equity_present check (
    (entity_kind = 'for_profit' and retained_earnings_account is not null)
    or (entity_kind = 'nonprofit'
        and net_assets_without_restrictions_account is not null)
    or (retained_earnings_account is null
        and net_assets_without_restrictions_account is null));

-- ---------------------------------------------------------------------------
-- 10. Vendors gain the two W-9 columns.
--
-- SUB-RAISE-REQUESTS asks for a W-9 that is absent or expired. Whether one is
-- on file, and when it stops being current, are facts about the vendor, so they
-- live on the vendor row rather than in a request table that would then be the
-- only record of them.
-- ---------------------------------------------------------------------------

alter table subledger.vendors
  add column w9_on_file boolean not null default false,
  add column w9_expires_on date;

-- ---------------------------------------------------------------------------
-- 11. Row level security, discriminator freeze, and the override guard.
--
-- Same three properties every table in 0013 and 0014 carries. Tenant isolation
-- is a policy on the row and not a predicate a run remembers to add, the
-- discriminator columns cannot be edited after insert, and a row carrying the
-- manual override flag refuses an automated write.
-- ---------------------------------------------------------------------------

alter table close.periods enable row level security;
alter table close.periods force row level security;
alter table close.sub_tieouts enable row level security;
alter table close.sub_tieouts force row level security;
alter table close.substantiation_records enable row level security;
alter table close.substantiation_records force row level security;
alter table close.document_requests enable row level security;
alter table close.document_requests force row level security;
alter table close.close_gate_results enable row level security;
alter table close.close_gate_results force row level security;
alter table close.opening_balances enable row level security;
alter table close.opening_balances force row level security;
alter table close.closing_entries enable row level security;
alter table close.closing_entries force row level security;

create policy client_isolation on close.periods
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on close.sub_tieouts
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on close.substantiation_records
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on close.document_requests
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on close.close_gate_results
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on close.opening_balances
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on close.closing_entries
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on close.periods
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on close.sub_tieouts
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on close.substantiation_records
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on close.document_requests
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on close.close_gate_results
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on close.opening_balances
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on close.closing_entries
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on close.periods
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on close.sub_tieouts
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on close.substantiation_records
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on close.document_requests
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on close.close_gate_results
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on close.opening_balances
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on close.closing_entries
  for each row execute function ledger.guard_manual_override();

commit;
