-- 0024_tiers.sql
-- Service tiers as data. Implements the tiers brief (NOTES entries 211 to
-- 219). The public pricing page at ledgerlegends.pro is the source for every
-- word in the seed below. shared/tiers.ts carries the same rows in
-- TypeScript, and script/check-schema.ts fails when the two disagree.
--
-- What this fixes. tenancy.engagements.service_level was free text. The
-- client code said ledger, ledger_plus, legend. Doc 08 said Story, Journey,
-- Legend. Nothing in the database said which was right or what a level
-- included. After this migration the column is a foreign key to a three row
-- table, and what a level includes is a row in tenancy.tier_features.
--
-- What this does not do. There is no price column anywhere (decision D1,
-- doc 05 Part 2). Pricing belongs to the engagement letter. Payroll and
-- cleanup are add ons on the public page, so they are rows in
-- tenancy.engagement_addons and never tiers. An add on grants no feature.
--
-- entitlement.* from 0007 is left in place and untouched. Its tiers (solo,
-- practice, firm) describe a firm level product that this product does not
-- sell, and no code reads it. Retiring it is a separate decision.
--
-- 0023 is reserved for the auth brief running in parallel. This file does
-- not depend on it.
--
-- Pre check, run through the connector before this was written:
--   tenancy.engagements had zero rows, so there was nothing to delete and
--   the constraint below is added without a backfill.
--
-- Forward only. No down migration.

begin;

-- ---------------------------------------------------------------------------
-- 1. The three tiers.
--
-- rank is the only thing hasFeature reads. A feature at rank 1 is included
-- at rank 2 because 2 >= 1, and for no other reason. revenue_*_cents is the
-- page's band for placing a client and is a guide, not a constraint.
-- ---------------------------------------------------------------------------

create table tenancy.service_tiers (
  id                    text primary key,
  name                  text not null,
  rank                  integer not null,
  tagline               text not null,
  revenue_floor_cents   bigint not null,
  revenue_ceiling_cents bigint,
  created_at            timestamptz not null default now(),
  constraint service_tier_id check (id in ('ledger', 'ledger_plus', 'legend')),
  constraint service_tier_rank unique (rank),
  constraint service_tier_rank_range check (rank between 0 and 2),
  constraint service_tier_floor check (revenue_floor_cents >= 0),
  constraint service_tier_band check (
    revenue_ceiling_cents is null or revenue_ceiling_cents > revenue_floor_cents)
);

insert into tenancy.service_tiers
  (id, name, rank, tagline, revenue_floor_cents, revenue_ceiling_cents) values
  ('ledger', 'Ledger', 0,
   'Monthly bank and card reconciliation, expense categorization with bank rules, and monthly financial statements.',
   0, 10000000),
  ('ledger_plus', 'Ledger+', 1,
   'Everything in Ledger, light AR and AP tracking, a quarterly performance summary, and priority support.',
   10000000, 25000000),
  ('legend', 'Legend', 2,
   'Everything in Ledger+, custom reports and KPI dashboards, accrual and loan tracking, a monthly review, and CPA ready books for tax time.',
   25000000, null);

-- ---------------------------------------------------------------------------
-- 2. What each tier adds.
--
-- Each feature appears once, at the lowest tier that includes it. A unique
-- index on feature_key enforces that rule, so a second row for the same key
-- at a higher tier is an error rather than a duplicate. Inclusion above the
-- listed tier is derived by rank in the view below and in hasFeature.
-- ---------------------------------------------------------------------------

create table tenancy.tier_features (
  tier_id      text not null references tenancy.service_tiers(id),
  feature_key  text not null,
  label        text not null,
  summary      text not null,
  primary key (tier_id, feature_key),
  constraint tier_feature_key_format check (feature_key ~ '^[a-z][a-z0-9_]*$'),
  constraint tier_feature_label_present check (label <> ''),
  constraint tier_feature_summary_present check (summary <> '')
);

create unique index tier_feature_lowest_tier_only
  on tenancy.tier_features (feature_key);

insert into tenancy.tier_features (tier_id, feature_key, label, summary) values
  -- Ledger. The page: monthly bank and card reconciliation, expense
  -- categorization with bank rules, monthly financial statements.
  ('ledger', 'statements', 'Monthly financial statements',
   'Profit and loss, balance sheet, and cash flow for every closed month.'),
  ('ledger', 'transactions', 'Your transactions',
   'Every posted transaction on your accounts with the category we used.'),
  ('ledger', 'documents', 'Documents and upload',
   'Send us receipts and statements, and keep the file history.'),
  ('ledger', 'requests', 'Open requests',
   'The short list of what we still need from you this month.'),
  ('ledger', 'messages', 'Messages',
   'Talk to the people doing your books, in one thread.'),
  ('ledger', 'reconciliation_status', 'Monthly reconciliation',
   'Every bank and card account reconciled each month, with the status shown on your statements.'),
  ('ledger', 'bank_rules', 'Categorization with bank rules',
   'Expenses categorized by rules written for your accounts, and the rule shown next to the transaction.'),

  -- Ledger+. The page: light AR and AP tracking, quarterly performance
  -- summary, priority support.
  ('ledger_plus', 'aging', 'AR and AP tracking',
   'Who owes you, who you owe, and how late each one is.'),
  ('ledger_plus', 'compare', 'Month over month',
   'This month against last month, line by line, with the drivers called out.'),
  ('ledger_plus', 'quarterly_summary', 'Quarterly performance summary',
   'A written summary of the quarter from the person who closed it, delivered after the quarter''s last close.'),
  ('ledger_plus', 'priority_support', 'Priority support',
   'Your messages go to the front of the queue.'),

  -- Legend. The page: custom reports and KPI dashboards, accrual and loan
  -- tracking, monthly review, CPA ready books for tax time.
  ('legend', 'custom_reports', 'Custom reports and KPI dashboards',
   'Reports built for your business. The budget, forecast, narrative and scenario screens are part of this.'),
  ('legend', 'budget', 'Budget versus actual',
   'Where spending landed against the plan, by account.'),
  ('legend', 'forecast', 'Thirteen week cash forecast',
   'Cash in and cash out by week for the next thirteen weeks.'),
  ('legend', 'narrative', 'Period narrative',
   'A written read on the month from the person who closed it.'),
  ('legend', 'scenarios', 'Scenario comparison',
   'The same forecast under slower collections or a change in spend.'),
  ('legend', 'consolidation', 'Group consolidation',
   'Two or more entities combined into one set of statements.'),
  ('legend', 'open_period', 'Accrual tracking',
   'The month in progress before it closes, with accruals shown as draft.'),
  ('legend', 'loans', 'Loan tracking',
   'Each loan''s balance, with payments split between principal and interest.'),
  ('legend', 'monthly_review', 'Monthly review',
   'A scheduled review of the month with the person who closed it.'),
  ('legend', 'cpa_packet', 'CPA ready books',
   'A packet compiled for your CPA at tax time. We compile the books; we do not prepare tax forms.');

-- ---------------------------------------------------------------------------
-- 3. The engagement names a tier.
--
-- A foreign key rather than a check constraint, so adding a tier is an
-- insert and not an alter. The pre check found zero engagement rows, so no
-- backfill and no deletion.
-- ---------------------------------------------------------------------------

alter table tenancy.engagements
  add constraint eng_service_level_fk
  foreign key (service_level) references tenancy.service_tiers(id);

-- Lets a child table carry both discriminators and prove they match the
-- engagement in one foreign key. id is already the primary key, so this adds
-- no new uniqueness, only a target.
alter table tenancy.engagements
  add constraint eng_id_tenant_unique unique (id, firm_id, client_id);

-- ---------------------------------------------------------------------------
-- 4. Add ons.
--
-- Payroll and cleanup attach to an engagement at any tier. The row carries
-- firm_id and client_id like every tenant table so the usual isolation
-- policy applies, and the composite foreign key keeps them honest against
-- the engagement. terms holds what was agreed in the letter: scope, the
-- payroll provider, the cleanup period range. Never a price.
-- ---------------------------------------------------------------------------

create table tenancy.engagement_addons (
  id             uuid primary key default gen_random_uuid(),
  firm_id        uuid not null references tenancy.firms(id),
  client_id      uuid not null references tenancy.clients(id),
  engagement_id  uuid not null,
  addon          text not null,
  started_at     date not null,
  ended_at       date,
  terms          jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  created_by     uuid not null,
  constraint addon_kind check (addon in ('payroll', 'cleanup')),
  constraint addon_dates check (ended_at is null or ended_at >= started_at),
  constraint addon_terms_is_object check (jsonb_typeof(terms) = 'object'),
  constraint addon_engagement_fk
    foreign key (engagement_id, firm_id, client_id)
    references tenancy.engagements (id, firm_id, client_id)
);

-- One live row per add on per engagement. An add on that ends and starts
-- again is a second row with dates, not an update over the first.
create unique index addon_one_current_per_engagement
  on tenancy.engagement_addons (engagement_id, addon) where ended_at is null;
create index on tenancy.engagement_addons (client_id);
create index on tenancy.engagement_addons (firm_id);

alter table tenancy.engagement_addons enable row level security;
alter table tenancy.engagement_addons force row level security;

create policy client_isolation on tenancy.engagement_addons
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on tenancy.engagement_addons
  for each row execute function tenancy.freeze_discriminators();

-- ---------------------------------------------------------------------------
-- 5. What a client is entitled to, derived.
--
-- One row per (client, feature) from the active engagement. A feature at a
-- lower rank is included by the join on rank, so nothing here is stored
-- twice. security_invoker makes the view run as the caller, which means the
-- client_isolation policy on tenancy.engagements decides what the caller
-- sees: a client scoped actor sees only its own client's rows. Add ons are
-- not in this view, on purpose. They grant nothing.
--
-- "Active" is the engagement row whose status is active and whose dates
-- cover today. The partial unique index below makes "the" honest: a client
-- has at most one active engagement.
-- ---------------------------------------------------------------------------

create unique index eng_one_active_per_client
  on tenancy.engagements (client_id) where status = 'active';

create view tenancy.client_entitlements
  with (security_invoker = true)
as
  select e.client_id,
         e.firm_id,
         e.id          as engagement_id,
         t.id          as tier_id,
         t.rank,
         tf.feature_key
    from tenancy.engagements e
    join tenancy.service_tiers t  on t.id = e.service_level
    join tenancy.service_tiers lt on lt.rank <= t.rank
    join tenancy.tier_features tf on tf.tier_id = lt.id
   where e.status = 'active'
     and e.start_date <= current_date
     and (e.end_date is null or e.end_date >= current_date);

comment on view tenancy.client_entitlements is
  'Feature keys the active engagement entitles a client to, derived by tier rank. Runs as the caller, so engagement row level security applies.';

-- ---------------------------------------------------------------------------
-- 6. Row level security on the reference tables, and grants.
--
-- The tier tables are reference data: readable by anybody the application
-- lets in, writable by nobody. Nothing the application runs may invent a
-- tier or move a feature between tiers. That is a migration.
--
-- No earlier migration granted select on tenancy.engagements to the
-- application roles, and the view runs as the caller, so the grant is made
-- here. Row level security on engagements is enabled and forced, so the
-- grant exposes only the rows the caller's membership reaches.
-- ---------------------------------------------------------------------------

alter table tenancy.service_tiers enable row level security;
alter table tenancy.service_tiers force row level security;
alter table tenancy.tier_features enable row level security;
alter table tenancy.tier_features force row level security;

create policy reference_readable on tenancy.service_tiers
  for select using (true);
create policy reference_readable on tenancy.tier_features
  for select using (true);

grant select on tenancy.service_tiers, tenancy.tier_features to app_web, app_worker;
grant select on tenancy.engagements to app_web, app_worker;
grant select on tenancy.client_entitlements to app_web, app_worker;
grant select, insert, update on tenancy.engagement_addons to app_web, app_worker;

commit;
