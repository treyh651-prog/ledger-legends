-- 0054_client_policy_versions.sql
--
-- CFG-EDIT-CLIENT-POLICY (server/runs/runs/cfg-edit-client-policy.ts) is the
-- first writer ledger.client_policies has ever had outside test fixtures.
-- Giving it the same version/history shape categories, rules, and mapping
-- profiles already have: a version column on the live row, and an
-- insert-only history table keyed by client_id (the row's real identity per
-- its own unique(client_id) constraint) rather than its synthetic text id,
-- which exists only for test-fixture readability per 0002a's own comment.
--
-- Forward only. No down migration.

begin;

alter table ledger.client_policies
  add column version integer not null default 1;

create table ledger.client_policy_versions (
  client_id   uuid not null,
  version     integer not null,
  firm_id     uuid not null,
  snapshot    jsonb not null,
  valid_from  timestamptz not null default now(),
  valid_to    timestamptz,
  changed_by  uuid not null,
  change_note text,
  primary key (client_id, version)
);

create index on ledger.client_policy_versions (firm_id);

alter table ledger.client_policy_versions enable row level security;
alter table ledger.client_policy_versions force row level security;
create policy client_isolation on ledger.client_policy_versions
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

-- CFG-EDIT-CLIENT-POLICY was added to RUN_POLICIES in server/runs/policy.ts
-- and to the registry; tier, reason, and writes_ledger below are copied
-- verbatim.
insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('CFG-EDIT-CLIENT-POLICY', 'manual', 'functional currency, entity kind, and which account equity closes into are judgments a person makes about who this client is, never something a run infers', false);

commit;
