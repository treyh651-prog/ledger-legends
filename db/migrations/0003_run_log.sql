-- 0003_run_log.sql
-- Implements doc 04 Part 8 (run log, run log items, run log events, run sequences,
-- monthly partitions, insert only enforcement) and doc 03 Part 9 (what the log must
-- mean). Doc 04 Part 13 row 0003, including the override guard trigger.
-- Two deliberate deviations from the doc 04 text, both noted inline below:
--   1. The partial unique idempotency index is created per partition, because
--      Postgres rejects a unique index with a where clause on a partitioned table.
--   2. Immutability on the partitioned tables uses a trigger rather than a rule,
--      because rules are not a supported object on a partitioned table. Rules stay
--      on the two tables that are not partitioned.
-- Forward only. No down migration.

begin;

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

-- Monthly partitions. Retention is a detach, never a delete. A scheduled job creates
-- the next month well ahead of the boundary.
create table ledger.run_log_2026_09 partition of ledger.run_log
  for values from ('2026-09-01') to ('2026-10-01');
create table ledger.run_log_2026_10 partition of ledger.run_log
  for values from ('2026-10-01') to ('2026-11-01');
create table ledger.run_log_2026_11 partition of ledger.run_log
  for values from ('2026-11-01') to ('2026-12-01');
create table ledger.run_log_2026_12 partition of ledger.run_log
  for values from ('2026-12-01') to ('2027-01-01');
create table ledger.run_log_2027_01 partition of ledger.run_log
  for values from ('2027-01-01') to ('2027-02-01');
create table ledger.run_log_2027_02 partition of ledger.run_log
  for values from ('2027-02-01') to ('2027-03-01');
create table ledger.run_log_2027_03 partition of ledger.run_log
  for values from ('2027-03-01') to ('2027-04-01');
create table ledger.run_log_2027_04 partition of ledger.run_log
  for values from ('2027-04-01') to ('2027-05-01');
create table ledger.run_log_2027_05 partition of ledger.run_log
  for values from ('2027-05-01') to ('2027-06-01');
create table ledger.run_log_2027_06 partition of ledger.run_log
  for values from ('2027-06-01') to ('2027-07-01');
create table ledger.run_log_2027_07 partition of ledger.run_log
  for values from ('2027-07-01') to ('2027-08-01');
create table ledger.run_log_2027_08 partition of ledger.run_log
  for values from ('2027-08-01') to ('2027-09-01');

-- Doc 04 Part 8 states this as one partial unique index on the parent. A partitioned
-- table cannot carry a unique index with a where clause, so it is created on each
-- partition. The guarantee holds inside a month, which is the window an idempotency
-- key is replayed in, and the run framework also checks the key before executing.
do $$
declare p text;
begin
  foreach p in array array[
    'run_log_2026_09','run_log_2026_10','run_log_2026_11','run_log_2026_12',
    'run_log_2027_01','run_log_2027_02','run_log_2027_03','run_log_2027_04',
    'run_log_2027_05','run_log_2027_06','run_log_2027_07','run_log_2027_08']
  loop
    execute format(
      'create unique index %I on ledger.%I (idempotency_key)
         where mode = ''apply'' and status in (''completed'',''completed_with_skips'',''no_op'')',
      p || '_idem', p);
  end loop;
end
$$;

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

create table ledger.run_log_items_2026_09 partition of ledger.run_log_items
  for values from ('2026-09-01') to ('2026-10-01');
create table ledger.run_log_items_2026_10 partition of ledger.run_log_items
  for values from ('2026-10-01') to ('2026-11-01');
create table ledger.run_log_items_2026_11 partition of ledger.run_log_items
  for values from ('2026-11-01') to ('2026-12-01');
create table ledger.run_log_items_2026_12 partition of ledger.run_log_items
  for values from ('2026-12-01') to ('2027-01-01');
create table ledger.run_log_items_2027_01 partition of ledger.run_log_items
  for values from ('2027-01-01') to ('2027-02-01');
create table ledger.run_log_items_2027_02 partition of ledger.run_log_items
  for values from ('2027-02-01') to ('2027-03-01');
create table ledger.run_log_items_2027_03 partition of ledger.run_log_items
  for values from ('2027-03-01') to ('2027-04-01');
create table ledger.run_log_items_2027_04 partition of ledger.run_log_items
  for values from ('2027-04-01') to ('2027-05-01');
create table ledger.run_log_items_2027_05 partition of ledger.run_log_items
  for values from ('2027-05-01') to ('2027-06-01');
create table ledger.run_log_items_2027_06 partition of ledger.run_log_items
  for values from ('2027-06-01') to ('2027-07-01');
create table ledger.run_log_items_2027_07 partition of ledger.run_log_items
  for values from ('2027-07-01') to ('2027-08-01');
create table ledger.run_log_items_2027_08 partition of ledger.run_log_items
  for values from ('2027-08-01') to ('2027-09-01');

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

create index on ledger.run_log_events (run_id, created_at);
create index on ledger.run_log_events (client_id, created_at desc);
create index on ledger.run_log_events (firm_id);

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

create index on ledger.run_sequences (client_id, started_at desc);
create index on ledger.run_sequences (firm_id);

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
create policy client_isolation on ledger.run_log_items
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on ledger.run_log_events
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on ledger.run_sequences
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

-- Insert only. Doc 03 Part 9. A log that can be edited is not evidence.
revoke update, delete, truncate on ledger.run_log, ledger.run_log_items,
  ledger.run_log_events, ledger.run_sequences from app_web, app_worker;

create or replace function ledger.reject_log_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'run_log_is_insert_only on %', tg_table_name
    using errcode = 'check_violation';
end;
$$;

create trigger trg_run_log_insert_only
  before update or delete on ledger.run_log
  for each row execute function ledger.reject_log_mutation();
create trigger trg_run_log_items_insert_only
  before update or delete on ledger.run_log_items
  for each row execute function ledger.reject_log_mutation();

create rule run_log_events_no_update as on update to ledger.run_log_events do instead nothing;
create rule run_log_events_no_delete as on delete to ledger.run_log_events do instead nothing;

-- ---------------------------------------------------------------------------
-- Override guard. Doc 00 Part 7 and doc 03 Part 1: a run never has authority a
-- person does not. A row carrying the manual override flag is invisible to every
-- run except as a skip, so a write inside a run context is refused here. The run
-- context is the session setting app.run_id, which the framework sets and a human
-- session does not.
-- ---------------------------------------------------------------------------

create or replace function ledger.guard_manual_override()
returns trigger language plpgsql as $$
begin
  if coalesce(old.manual_override, false)
     and nullif(current_setting('app.run_id', true), '') is not null then
    raise exception 'manual_override_protected on % row %', tg_table_name, old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trg_guard_manual_override
  before update on ledger.journal_entries
  for each row execute function ledger.guard_manual_override();

commit;
