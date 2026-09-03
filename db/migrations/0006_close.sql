-- 0006_close.sql
-- Implements doc 04 Part 7 (close runs and close gate results). Doc 04 Part 13 row 0006.
-- Amended by doc 05 Part 8: the gate code space now runs G01 through G19, because
-- doc 05 adds G18 (the approver is not the preparer) and G19 (a cash effect line
-- carries a cash event date that is not locked ahead of it). The gate code check
-- already accepts any Gnn value, so the space widens without a format change.
-- A gate is computed live. This table is the historical record of what a gate
-- returned at the moment of closing, which is evidence, not a checkbox.
-- Forward only. No down migration.

begin;

create table ledger.close_runs (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  period_start   date not null,
  period_end     date not null,
  status         text not null,
  prepared_by    uuid,
  approved_by    uuid,
  closed_at      timestamptz,
  closed_by      uuid,
  closed_with_exceptions boolean not null default false,
  period_lock_id uuid references ledger.period_locks(id),
  constraint close_status check (status in ('in_progress','closed','reopened','abandoned')),
  constraint close_period_sane check (period_end >= period_start),
  -- Doc 05 Part 5, gate G18. Two people is exactly enough to run the one control
  -- that matters, so the separation is structural rather than advisory.
  constraint close_approver_not_preparer check (
    status <> 'closed' or approved_by is distinct from prepared_by),
  constraint close_closed_complete check (
    status <> 'closed' or (closed_at is not null and closed_by is not null))
);

create table ledger.close_gate_results (
  id             char(26) primary key,
  close_run_id   char(26) not null references ledger.close_runs(id),
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  gate_code      char(3) not null,            -- 'G01' through 'G19'
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
create index on ledger.close_runs (firm_id, period_start desc);
create index on ledger.close_gate_results (client_id, close_run_id);
create index on ledger.close_gate_results (firm_id);
create index on ledger.close_gate_results (close_run_id, gate_code);

alter table ledger.close_runs enable row level security;
alter table ledger.close_runs force row level security;
alter table ledger.close_gate_results enable row level security;
alter table ledger.close_gate_results force row level security;
create policy client_isolation on ledger.close_runs
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on ledger.close_gate_results
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on ledger.close_runs
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on ledger.close_gate_results
  for each row execute function tenancy.freeze_discriminators();

commit;
