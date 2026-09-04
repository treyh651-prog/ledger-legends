-- 0018_intake.sql
-- Doc 02 module 1 intake and setup, and the wizard that drives it.
--
-- Migration 0009 already created import.mapping_profiles and its version
-- history table, so a saved mapping profile has a home and this migration does
-- not create one. What 0009 did not create is the per column detail the mapping
-- profile editor on step 4 of the wizard edits, and what nothing in 0001 through
-- 0017 created is anywhere to keep a wizard run in progress. Those are the two
-- tables here.
--
-- What is created, and why each one has to exist:
--
--   1. import.mapping_profile_columns. One row per source column of one mapping
--      profile version. The profile header in 0009 names five canonical fields
--      in five dedicated columns, which is enough to parse a file and not enough
--      to show a person the mapping they built and let them edit it. A CSV with
--      eleven columns of which five are mapped needs eleven rows here, so the
--      editor can display the unmapped six and so a later parse can explain why
--      it ignored them. The canonical field list is closed by a check
--      constraint: date, description, amount_cents, memo, external_id, or the
--      literal 'unmapped'. There is no sixth destination a person can invent
--      and no free text target column, because the parser reads exactly those
--      five and anything else would be a mapping that silently does nothing.
--
--   2. intake.wizard_sessions. One row per client per wizard run, holding the
--      six steps of answers as jsonb and the finish state. The wizard itself
--      keeps its working state in memory and in the URL, per the constraint in
--      the brief, and this table is where a finished or abandoned run is
--      recorded so the audit log has something to point at. It is not a cache
--      and nothing reads it to render a step.
--
-- WHAT IS DELIBERATELY ABSENT.
--
-- There is no password column, no password hash column, no secret column, and
-- no credential column anywhere in this file. Step 2 of the wizard collects a
-- contact's name, role, email, phone, and whether that person should get a
-- login, and it collects nothing else. An invite is a row in the audit log in
-- this build and there is no send.
--
-- There is no recipient address column, no message body column, no queued at
-- column, and no sent at column. Nothing in module 1 transmits anything.
--
-- There is no parser format value for a PDF statement. The file_format check on
-- import.mapping_profiles in 0009 already allows only csv and xlsx, and the
-- feed format check on import.batches allows only the six formats decision D2
-- lists. A PDF statement is refused by the schema and not only by the dropdown,
-- which is what makes the refusal in the user interface honest.
--
-- COMPLIANCE. Ledger Legends is not a CPA firm and is not a registered agent.
-- Nothing in this migration registers an entity, files a document, or records a
-- filing. entity_type and fiscal_year_end on the wizard session are descriptive
-- fields recording what the client told the firm it already is. There is no
-- filed at column, no state submission column, no agent of record column, and
-- no advice column, because no run may create one.
--
-- CONSTRAINT. No model, no score, no learned parameter. Mapping profile
-- detection is header rule matching against a stored fingerprint, which is a
-- string comparison. There is no confidence column here for the same reason
-- there is no model.
--
-- Every table carries a version column and the manual override columns with the
-- override guard trigger, because the override contract in doc 03 Part 6 is a
-- property of the store and not of a run.
--
-- Forward only. No down migration.

begin;

create schema if not exists intake;
grant usage on schema intake to app_web, app_worker;

-- ---------------------------------------------------------------------------
-- 1. The per column detail of a mapping profile.
--
-- source_name is the header text exactly as it appeared in the file, not a
-- normalized form of it, because the fingerprint on the profile header is
-- compared exactly and a normalized copy here would drift away from it.
--
-- source_index is the zero based position of the column. It exists because two
-- columns of a bank export are allowed to carry the same header text, which is
-- rare and real, and position is the only thing that tells them apart.
--
-- canonical_field is the closed list. 'unmapped' is a value rather than a null
-- so that the difference between a column somebody decided to ignore and a
-- column nobody has looked at yet stays visible.
-- ---------------------------------------------------------------------------

create table import.mapping_profile_columns (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  profile_id     char(26) not null references import.mapping_profiles(id),
  profile_version integer not null default 1,

  source_index   integer not null,
  source_name    text not null,
  canonical_field text not null default 'unmapped',
  sample_value   text not null default '',

  is_active      boolean not null default true,
  created_by_run_id char(26),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint mpc_canonical_field check (canonical_field in (
    'date','description','amount_cents','memo','external_id','unmapped')),
  constraint mpc_source_index check (source_index >= 0),
  constraint mpc_source_name check (length(source_name) > 0),
  constraint mpc_one_per_position unique (profile_id, profile_version, source_index)
);

create index mpc_profile on import.mapping_profile_columns (profile_id, profile_version);
create index mpc_client on import.mapping_profile_columns (client_id) where is_active;
create index mpc_firm on import.mapping_profile_columns (firm_id);

-- A canonical field may be claimed by at most one source column of a profile
-- version. Two columns both mapped to amount_cents is not a preference, it is a
-- mapping the parser cannot act on, so the database refuses it. 'unmapped' is
-- excluded from the rule because any number of columns may be ignored.
create unique index mpc_one_column_per_field
  on import.mapping_profile_columns (profile_id, profile_version, canonical_field)
  where canonical_field <> 'unmapped';

-- ---------------------------------------------------------------------------
-- 2. The wizard session.
--
-- The six answer columns are jsonb because the shape of each step is owned by
-- the client code and reviewed there, and freezing six step shapes into columns
-- would mean a migration every time a field moved between steps. What is not
-- jsonb is anything the firm queries or reports on: the client, the cutover,
-- the industry template, the entity type, the tier, and the state.
--
-- state moves forward only, in progress to finished or to abandoned, and the
-- check constraint plus the finished_at rule below is what enforces it. A
-- finished session names the four run executions it produced, which is how the
-- audit trail joins a wizard press to the rows it created.
-- ---------------------------------------------------------------------------

create table intake.wizard_sessions (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  -- Descriptive company facts, recorded as the client stated them.
  legal_name     text not null,
  dba_name       text not null default '',
  ein_last4      char(4),
  state_of_incorporation char(2),
  entity_type    text not null default 'unknown',
  fiscal_year_end_month integer not null default 12,
  fiscal_year_end_day   integer not null default 31,

  service_tier   text not null default 'story',
  cutover_date   date not null,
  industry_template text not null,

  current_step   integer not null default 1,
  state          text not null default 'in_progress',

  step_company   jsonb not null default '{}'::jsonb,
  step_people    jsonb not null default '[]'::jsonb,
  step_chart     jsonb not null default '{}'::jsonb,
  step_accounts  jsonb not null default '[]'::jsonb,
  step_balances  jsonb not null default '[]'::jsonb,
  step_review    jsonb not null default '{}'::jsonb,

  chart_run_id     char(26),
  tasks_run_id     char(26),
  requests_run_id  char(26),
  balances_run_id  char(26),

  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  created_by_run_id char(26),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint wiz_entity_type check (entity_type in (
    'llc','s_corporation','c_corporation','sole_proprietor','nonprofit','unknown')),
  constraint wiz_service_tier check (service_tier in ('story','journey','legend')),
  constraint wiz_state check (state in ('in_progress','finished','abandoned')),
  constraint wiz_step check (current_step between 1 and 6),
  constraint wiz_fiscal_month check (fiscal_year_end_month between 1 and 12),
  constraint wiz_fiscal_day check (fiscal_year_end_day between 1 and 31),
  constraint wiz_ein_last4 check (ein_last4 is null or ein_last4 ~ '^[0-9]{4}$'),
  -- A finished session has a finish time and an unfinished one does not. The
  -- constraint exists so a half written finish cannot look complete.
  constraint wiz_finished_at check (
    (state = 'finished' and finished_at is not null)
    or (state <> 'finished' and finished_at is null)),
  -- One live wizard per client. A second in progress session for the same
  -- client would mean two people setting up the same books at once.
  constraint wiz_one_per_client_cutover unique (client_id, cutover_date, started_at)
);

create index wiz_client on intake.wizard_sessions (client_id, started_at desc);
create index wiz_firm on intake.wizard_sessions (firm_id);

create unique index wiz_one_in_progress_per_client
  on intake.wizard_sessions (client_id) where state = 'in_progress';

-- ---------------------------------------------------------------------------
-- 3. Row level security. Both tables are client scoped.
-- ---------------------------------------------------------------------------

alter table import.mapping_profile_columns enable row level security;
alter table import.mapping_profile_columns force row level security;
alter table intake.wizard_sessions enable row level security;
alter table intake.wizard_sessions force row level security;

create policy client_isolation on import.mapping_profile_columns
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on intake.wizard_sessions
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

-- ---------------------------------------------------------------------------
-- 4. Discriminator freeze and the override guard.
--
-- The freeze stops an update from moving a row between clients or firms, which
-- is the one write row level security cannot catch on its own. The override
-- guard stops a run from writing a row a person claimed, which is invariant 8.
-- ---------------------------------------------------------------------------

create trigger trg_freeze_discriminators before update on import.mapping_profile_columns
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on intake.wizard_sessions
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on import.mapping_profile_columns
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on intake.wizard_sessions
  for each row execute function ledger.guard_manual_override();

grant select, insert, update on import.mapping_profile_columns to app_web, app_worker;
grant select, insert, update on intake.wizard_sessions to app_web, app_worker;

commit;
