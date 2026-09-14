-- ---------------------------------------------------------------------------
-- 0002a. ledger.client_policies.
--
-- Doc 00 Part 2 and doc 02 TXN-SPLIT-SETTLEMENTS step 4 both require a per
-- client settings row the coding runs read at execution rather than infer.
-- Doc 04 never gave it a create table statement, and migration 0015 alters it
-- as though it already exists, so applying 0015 against an empty database
-- failed on a relation that nothing had ever created. This file closes that
-- gap and is numbered 0002a so it lands with the rest of the ledger core,
-- before anything that alters or references it.
--
-- Base columns only. The five equity and fiscal year columns stay in 0015
-- where they were written, so the two files still read the way the decision
-- log describes them.
--
-- The id is text rather than char(26) because the seeded policy ids in the
-- test fixtures are short readable strings, not ULIDs, and a length constraint
-- here would reject them for no accounting reason.
-- ---------------------------------------------------------------------------

begin;

create table if not exists ledger.client_policies (
  id                  text primary key,
  client_id           uuid not null references tenancy.clients(id),
  firm_id             uuid not null references tenancy.firms(id),

  functional_currency char(3) not null default 'USD',

  -- Integer cents, doc 00 Part 2 default 250000. Nullable because a client
  -- with no stated threshold is a real state and not a zero threshold.
  capitalize_over     bigint,

  -- Doc 02 step 4. Gross booked at sale time credits 1910 rather than revenue.
  gross_at_sale_time  boolean not null default false,

  -- Doc 02 Part D rule promotion condition 5.
  cleanup_engagement  boolean not null default false,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (client_id),
  constraint client_policy_capitalize_positive check (
    coalesce(capitalize_over, 0) >= 0),
  constraint client_policy_currency check (functional_currency ~ '^[A-Z]{3}$')
);

create index on ledger.client_policies (client_id);
create index on ledger.client_policies (firm_id);

alter table ledger.client_policies enable row level security;
alter table ledger.client_policies force row level security;
create policy client_isolation on ledger.client_policies
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on ledger.client_policies
  for each row execute function tenancy.freeze_discriminators();

grant select, insert, update on ledger.client_policies to app_web, app_worker;

commit;
