-- 0007_entitlement.sql
-- Implements doc 04 Part 11 (tiers, features, tier features, overrides, has_feature)
-- as amended by doc 05 Part 2 (D1) and doc 05 Part 8. Doc 04 Part 13 row 0007,
-- renamed from 0007_billing.sql.
-- Amendments folded in before writing:
--   The billing schema is created as entitlement. There is no billing schema.
--   billing.subscriptions is not created at all. entitlement.grants replaces it,
--   effective dated and sourced from the engagement, with no payment lifecycle
--   columns of any kind and no processor identifiers.
-- The boundary that survives unchanged: no table in ledger, subledger, tenancy or
-- vault references anything in entitlement, and entitlement is never a row
-- visibility predicate. It is checked in the API and the UI.
-- Forward only. No down migration.

begin;

create schema if not exists entitlement;
grant usage on schema entitlement to app_web, app_worker;

create table entitlement.tiers (
  id            text primary key,             -- 'solo','practice','firm'
  name          text not null,
  sort_order    integer not null,
  is_public     boolean not null default true
);

create table entitlement.features (
  id            text primary key,             -- 'fixed_assets','1099_run','portal_requests'
  name          text not null,
  description   text not null
);

create table entitlement.tier_features (
  tier_id       text not null references entitlement.tiers(id),
  feature_id    text not null references entitlement.features(id),
  limit_value   integer,                      -- null means unlimited
  primary key (tier_id, feature_id)
);

-- Doc 05 Part 2. Entitlement is effective dated and comes from the engagement.
-- Six months from now the answerable question is what a client could see on a
-- given date, and a column overwritten in place cannot answer it.
create table entitlement.grants (
  id             uuid primary key default gen_random_uuid(),
  firm_id        uuid not null references tenancy.firms(id),
  client_id      uuid not null references tenancy.clients(id),
  engagement_id  uuid not null references tenancy.engagements(id),
  tier_id        text not null references entitlement.tiers(id),
  effective_from date not null,
  effective_to   date,                          -- null means current
  set_by         uuid not null,
  reason         text not null,
  created_at     timestamptz not null default now(),
  constraint grant_dates check (effective_to is null or effective_to > effective_from)
);

create unique index grant_one_current_per_client
  on entitlement.grants (client_id) where effective_to is null;

create index on entitlement.grants (client_id, effective_from desc);
create index on entitlement.grants (firm_id);

create table entitlement.entitlement_overrides (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null references tenancy.firms(id),
  feature_id    text not null references entitlement.features(id),
  granted       boolean not null,
  limit_value   integer,
  reason        text not null,
  granted_by    uuid not null,
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index on entitlement.entitlement_overrides (firm_id, feature_id);

-- Read only to the app. Entitlements are never a row visibility predicate.
-- Same signature as doc 04 Part 11, reading grants and resolving the row where
-- effective_to is null.
create or replace function entitlement.has_feature(p_firm_id uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = entitlement, pg_catalog
as $$
  select coalesce(
    (select o.granted
       from entitlement.entitlement_overrides o
      where o.firm_id = p_firm_id and o.feature_id = p_feature
        and (o.expires_at is null or o.expires_at > now())
      order by o.created_at desc limit 1),
    exists (
      select 1
        from entitlement.grants g
        join entitlement.tier_features tf on tf.tier_id = g.tier_id
       where g.firm_id = p_firm_id
         and g.effective_to is null
         and tf.feature_id = p_feature),
    false);
$$;

revoke all on function entitlement.has_feature(uuid, text) from public;
grant execute on function entitlement.has_feature(uuid, text) to app_web, app_worker;

grant select on entitlement.tiers, entitlement.features, entitlement.tier_features,
  entitlement.grants, entitlement.entitlement_overrides to app_web, app_worker;

commit;
