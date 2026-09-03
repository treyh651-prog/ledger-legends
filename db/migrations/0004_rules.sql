-- 0004_rules.sql
-- Implements doc 04 Part 9 (rules, rule versions, the selection index that encodes
-- the doc 00 Part 3 tie breaking order). Doc 04 Part 13 row 0004.
-- Forward only. No down migration.

begin;

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

-- The exact tie breaking order from doc 00 Part 3, as an index.
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

create index on ledger.rule_versions (client_id, rule_id);
create index on ledger.rule_versions (firm_id);

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
create trigger trg_freeze_discriminators before update on ledger.rules
  for each row execute function tenancy.freeze_discriminators();

commit;
