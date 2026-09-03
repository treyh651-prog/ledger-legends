-- 0009_import.sql
-- Implements doc 05 Part 3 (D2), pipeline one: versioned column mapping profiles,
-- import staging batches, and staged rows with import time deduplication.
-- Runs served: IMPORT-PARSE-FEED and IMPORT-COMMIT-BATCH.
-- Placed after vault because a batch points at the uploaded source document.
-- Doc 05 Part 9 step 3 moves the import pipeline early in the build order; the
-- migration number reflects dependency order, not build priority.
-- There is no PDF statement parser and no column in this schema invites one.
-- Forward only. No down migration.

begin;

create schema if not exists import;
grant usage on schema import to app_web, app_worker;

-- ---------------------------------------------------------------------------
-- Column mapping profiles. Configured once per institution by a person, reused,
-- and versioned. A header row that does not match stops the import and asks,
-- because a silent column shift is the worst failure this pipeline can have.
-- ---------------------------------------------------------------------------

create table import.mapping_profiles (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  institution_name text not null,
  account_number char(4),                     -- the ledger cash or card account
  file_format    text not null,

  -- Header contract. The fingerprint is compared exactly on every parse.
  header_fingerprint text not null,
  header_row_number integer not null default 1,
  skip_rows      integer not null default 0,

  date_column    text not null,
  date_format    text not null,
  description_column text not null,
  -- Either one signed amount column, or a separate debit and credit pair.
  amount_column  text,
  debit_column   text,
  credit_column  text,
  sign_convention text not null default 'debit_positive',
  currency       char(3) not null default 'USD',

  bank_id_column text,                        -- bank supplied unique id when present
  check_number_column text,
  bank_code_column text,

  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  unique (client_id, institution_name, file_format, version),
  constraint map_file_format check (file_format in ('csv','xlsx')),
  constraint map_sign_convention check (sign_convention in (
    'debit_positive','credit_positive','separate_columns')),
  constraint map_currency check (currency = 'USD'),
  constraint map_skip_rows check (skip_rows >= 0 and header_row_number > 0),
  constraint map_amount_basis check (
    (amount_column is not null and debit_column is null and credit_column is null)
    or (amount_column is null and debit_column is not null and credit_column is not null)),
  constraint map_separate_columns_agree check (
    sign_convention <> 'separate_columns' or debit_column is not null),
  foreign key (client_id, account_number)
    references ledger.accounts (client_id, account_number)
);

create index on import.mapping_profiles (client_id) where is_active;
create index on import.mapping_profiles (client_id, institution_name);
create index on import.mapping_profiles (firm_id);
create unique index map_one_active_per_institution
  on import.mapping_profiles (client_id, institution_name, file_format) where is_active;

-- History, same shape as the category and rule version tables. A profile is never
-- edited in place, because a file parsed under version 2 must stay explainable.
create table import.mapping_profile_versions (
  profile_id  char(26) not null,
  version     integer not null,
  client_id   uuid not null references tenancy.clients(id),
  firm_id     uuid not null references tenancy.firms(id),
  snapshot    jsonb not null,
  valid_from  timestamptz not null default now(),
  valid_to    timestamptz,
  changed_by  uuid not null,
  change_note text,
  primary key (profile_id, version)
);

create index on import.mapping_profile_versions (client_id, profile_id);
create index on import.mapping_profile_versions (firm_id);

-- ---------------------------------------------------------------------------
-- Staging batches. A batch is reversible as a unit until any row in it is
-- reconciled, so a bad import is one undo rather than an afternoon.
-- ---------------------------------------------------------------------------

create table import.batches (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  name           text not null,
  source_format  text not null,
  source_document_id char(26) references vault.documents(id),
  account_number char(4),
  mapping_profile_id char(26) references import.mapping_profiles(id),
  mapping_profile_version integer,

  status         text not null default 'parsing',
  reject_reason  text,
  row_count      integer not null default 0,
  accepted_count integer not null default 0,
  rejected_count integer not null default 0,
  held_count     integer not null default 0,
  earliest_row_date date,
  latest_row_date  date,
  net_cents      bigint not null default 0,

  parsed_run_id    char(26),
  committed_run_id char(26),
  committed_at     timestamptz,
  reversed_run_id  char(26),
  reversed_at      timestamptz,
  reversal_blocked boolean not null default false,

  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint batch_status check (status in (
    'parsing','parsed','in_review','committed','reversed','rejected','failed')),
  constraint batch_format check (source_format in ('ofx','qfx','qbo','camt053','csv','xlsx')),
  constraint batch_counts_nonneg check (
    row_count >= 0 and accepted_count >= 0 and rejected_count >= 0 and held_count >= 0),
  -- A mapped file needs the profile and the version it was parsed under.
  constraint batch_mapping_required check (
    source_format not in ('csv','xlsx')
    or (mapping_profile_id is not null and mapping_profile_version is not null)),
  constraint batch_commit_complete check (
    status <> 'committed' or (committed_run_id is not null and committed_at is not null)),
  constraint batch_reversal_complete check (
    status <> 'reversed' or (reversed_run_id is not null and reversed_at is not null)),
  constraint batch_reject_reason check (status <> 'rejected' or reject_reason is not null),
  constraint batch_dates check (
    latest_row_date is null or earliest_row_date is null or latest_row_date >= earliest_row_date),
  foreign key (client_id, account_number)
    references ledger.accounts (client_id, account_number)
);

create index on import.batches (client_id, status);
create index on import.batches (client_id, created_at desc);
create index on import.batches (firm_id);
create index on import.batches (mapping_profile_id) where mapping_profile_id is not null;

-- ---------------------------------------------------------------------------
-- Staged rows. Nothing here is in the ledger yet. Deduplication happens on this
-- table, before the coding cascade, so TXN-DETECT-DUPLICATES is a second net.
-- ---------------------------------------------------------------------------

create table import.staged_rows (
  id             char(26) primary key,        -- ULID
  batch_id       char(26) not null references import.batches(id),
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  row_number     integer not null,
  raw_row        jsonb not null,              -- exactly what the file said

  posted_on      date,
  description    text,
  normalized_description text,
  amount_cents   bigint,                      -- signed, debit positive
  currency       char(3) not null default 'USD',
  account_number char(4),
  bank_transaction_id text,                   -- bank supplied unique id when the format carries one
  check_number   text,
  bank_code      text,

  dedup_state    text not null default 'unique',
  duplicate_of_transaction_id char(26),
  duplicate_of_staged_row_id char(26) references import.staged_rows(id),
  review_state   text not null default 'none',
  reviewed_by    uuid,
  reviewed_at    timestamptz,

  -- Filled at commit. The transaction register itself is doc 04 Part 14 item 4 and
  -- is not modeled yet, so this carries no foreign key.
  committed_transaction_id char(26),
  committed_entry_id char(26) references ledger.journal_entries(id),
  committed_at   timestamptz,

  error_code     text,
  error_message  text,
  created_at     timestamptz not null default now(),

  unique (batch_id, row_number),
  constraint staged_currency check (currency = 'USD'),
  constraint staged_dedup_state check (dedup_state in (
    'unique','rejected_duplicate','held_for_review','confirmed_repeat','committed')),
  constraint staged_review_state check (review_state in ('none','pending','accepted','rejected')),
  constraint staged_duplicate_has_target check (
    dedup_state not in ('rejected_duplicate','held_for_review')
    or duplicate_of_transaction_id is not null or duplicate_of_staged_row_id is not null),
  constraint staged_commit_complete check (
    dedup_state <> 'committed' or committed_at is not null),
  constraint staged_error_pair check (
    (error_code is null and error_message is null) or error_code is not null),
  foreign key (client_id, account_number)
    references ledger.accounts (client_id, account_number)
);

-- Where the file carries a bank supplied id, that id is the key and a repeat is
-- rejected outright rather than reviewed.
create unique index staged_bank_id_unique
  on import.staged_rows (client_id, account_number, bank_transaction_id)
  where bank_transaction_id is not null;
create index on import.staged_rows (batch_id, dedup_state);
create index on import.staged_rows (client_id, posted_on);
create index on import.staged_rows (client_id, normalized_description);
create index on import.staged_rows (firm_id);

-- ---------------------------------------------------------------------------
-- RLS.
-- ---------------------------------------------------------------------------

alter table import.mapping_profiles enable row level security;
alter table import.mapping_profiles force row level security;
alter table import.mapping_profile_versions enable row level security;
alter table import.mapping_profile_versions force row level security;
alter table import.batches enable row level security;
alter table import.batches force row level security;
alter table import.staged_rows enable row level security;
alter table import.staged_rows force row level security;

create policy client_isolation on import.mapping_profiles
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on import.mapping_profile_versions
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on import.batches
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on import.staged_rows
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on import.mapping_profiles
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on import.batches
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on import.staged_rows
  for each row execute function tenancy.freeze_discriminators();

commit;
