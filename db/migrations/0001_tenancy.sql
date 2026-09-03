-- 0001_tenancy.sql
-- Implements doc 04 Part 10 (tenancy), doc 04 Part 0 (ground rules, the membership
-- function, RLS enabled and forced, discriminator indexes) and doc 04 Part 13 row 0001.
-- Amended by doc 05 Part 2 (D1) and doc 05 Part 4 (D3): a client engagement is a real
-- table here because entitlement.grants and the reporting basis both hang off it.
-- Forward only. No down migration.

begin;

create extension if not exists pgcrypto;

create schema if not exists tenancy;

-- Least privilege baseline. The web role reaches tenant data through views,
-- functions and RLS, never through a default public grant.
revoke all on schema public from public;

-- Application roles referenced by the grant and revoke statements in every later
-- migration. Created without login here; credentials are managed outside migrations.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_web') then
    create role app_web nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_worker') then
    create role app_worker nologin;
  end if;
end
$$;

grant usage on schema tenancy to app_web, app_worker;

-- ---------------------------------------------------------------------------
-- Core tenancy tables. uuid ids, because creation order does not matter here.
-- ---------------------------------------------------------------------------

create table tenancy.firms (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique,
  created_at    timestamptz not null default now(),
  archived_at   timestamptz
);

create table tenancy.users (
  id            uuid primary key default gen_random_uuid(),
  auth_subject  text not null unique,            -- 'sub' from WorkOS or Clerk
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
  engagement_scope jsonb not null default '{}',  -- drives the conditional close gates
  chart_template_id text,
  -- Doc 05 Part 7 D6: periodic inventory with weighted average cost, recorded per
  -- client so a client with real unit level data becomes a setting change.
  inventory_method text not null default 'periodic_weighted_average',
  onboarded_at  timestamptz,
  archived_at   timestamptz,
  constraint client_fye check (fiscal_year_end_month between 1 and 12),
  constraint client_currency check (functional_currency = 'USD'),
  constraint client_inventory_method check (
    inventory_method in ('periodic_weighted_average','none'))
);

-- Doc 05 Part 2 and Part 4. The engagement is the source of entitlement and of the
-- default reporting basis. It never changes how anything posts.
create table tenancy.engagements (
  id              uuid primary key default gen_random_uuid(),
  firm_id         uuid not null references tenancy.firms(id),
  client_id       uuid not null references tenancy.clients(id),
  name            text not null,
  status          text not null default 'draft',
  service_level   text not null,
  reporting_basis text not null default 'accrual',
  scope           jsonb not null default '{}',
  start_date      date not null,
  end_date        date,
  -- vault.documents id of the executed engagement letter. No foreign key, because
  -- vault is created later and the vault side already references tenancy.
  letter_document_id char(26),
  signed_at       timestamptz,
  terminated_at   timestamptz,
  termination_reason text,
  -- Doc 05 Part 7 D9. Fifteen business days, recorded so the promise is data.
  offboarding_export_days integer not null default 15,
  created_at      timestamptz not null default now(),
  created_by      uuid not null,
  constraint eng_status check (status in ('draft','sent','signed','active','terminated')),
  constraint eng_basis check (reporting_basis in ('accrual','cash','both')),
  constraint eng_dates check (end_date is null or end_date >= start_date),
  constraint eng_signed_has_letter check (
    status not in ('signed','active') or (letter_document_id is not null and signed_at is not null)),
  constraint eng_offboarding_days check (offboarding_export_days > 0)
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
  on tenancy.memberships (user_id, firm_id,
    (coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  where revoked_at is null;
create index on tenancy.memberships (user_id) where revoked_at is null;
create index on tenancy.memberships (firm_id) where revoked_at is null;
create index on tenancy.memberships (client_id) where revoked_at is null;

create index on tenancy.clients (firm_id) where archived_at is null;
create index on tenancy.engagements (client_id, start_date desc);
create index on tenancy.engagements (firm_id);

-- ---------------------------------------------------------------------------
-- Doc 04 Part 0, the membership function. Defined once so a policy change never
-- means rewriting a predicate thirty times.
-- ---------------------------------------------------------------------------

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

revoke all on function tenancy.current_actor() from public;
revoke all on function tenancy.has_client_access(uuid) from public;
revoke all on function tenancy.has_firm_access(uuid) from public;
grant execute on function tenancy.current_actor() to app_web, app_worker;
grant execute on function tenancy.has_client_access(uuid) to app_web, app_worker;
grant execute on function tenancy.has_firm_access(uuid) to app_web, app_worker;

-- Doc 04 Part 0: both discriminators are immutable. A row does not change tenant.
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

-- Firm only variant for tables that carry firm_id without client_id.
create or replace function tenancy.freeze_firm_discriminator()
returns trigger language plpgsql as $$
begin
  if new.firm_id is distinct from old.firm_id then
    raise exception 'tenant_discriminator_immutable on %', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trg_freeze_discriminators
  before update on tenancy.engagements
  for each row execute function tenancy.freeze_discriminators();

-- ---------------------------------------------------------------------------
-- RLS. Enabled and forced, because the table owner is otherwise exempt and the
-- owner is exactly the role a maintenance script runs as.
-- ---------------------------------------------------------------------------

alter table tenancy.clients enable row level security;
alter table tenancy.clients force row level security;
alter table tenancy.memberships enable row level security;
alter table tenancy.memberships force row level security;
alter table tenancy.engagements enable row level security;
alter table tenancy.engagements force row level security;

create policy firm_isolation on tenancy.clients
  using ( (select tenancy.has_firm_access(firm_id)) );
create policy own_memberships on tenancy.memberships
  using ( user_id = (select tenancy.current_actor())
          or (select tenancy.has_firm_access(firm_id)) );
create policy client_isolation on tenancy.engagements
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

commit;
