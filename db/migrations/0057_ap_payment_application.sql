-- 0057_ap_payment_application.sql
--
-- subledger.vendor_payments and subledger.bill_applications, mirroring
-- subledger.customer_payments and subledger.payment_applications
-- (0014_ar_ap.sql) column for column. Nothing in the original run set ever
-- paid a bill in the general case -- AP-APPLY-DISCOUNTS only ever fires for
-- bills carrying 2/10-net-30-style discount terms, and an ordinary bill
-- payment was coded as a plain expense transaction with no link back to the
-- bill row at all. AP-RECORD-PAYMENT and AP-APPLY-PAYMENTS, added in
-- server/runs/policy.ts below, are that missing general path, built to the
-- same four-tier allocation AR-APPLY-PAYMENTS already uses.
--
-- Forward only. No down migration.

begin;

create table subledger.vendor_payments (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  vendor_id      char(26) not null references subledger.vendors(id),
  payment_date   date not null,
  amount_cents   bigint not null,
  applied_cents  bigint not null default 0,

  on_hold        boolean not null default false,
  match_hint     text,                        -- one bill number, or null
  transaction_id char(26),                    -- the register row it arrived on
  clearing_account char(4) not null,
  status         text not null default 'unapplied',
  applied_tier   integer,

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint vpay_status check (status in (
    'unapplied','partially_applied','applied','void')),
  constraint vpay_amount_sane check (amount_cents > 0),
  constraint vpay_applied_within check (
    applied_cents >= 0 and applied_cents <= amount_cents),
  constraint vpay_tier_range check (applied_tier is null or applied_tier between 1 and 4),
  foreign key (client_id, clearing_account)
    references ledger.accounts (client_id, account_number)
);

create index vpay_open_by_date
  on subledger.vendor_payments (client_id, payment_date)
  where status in ('unapplied','partially_applied');

create table subledger.vendor_remittance_lines (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  payment_id     char(26) not null references subledger.vendor_payments(id),
  line_number    integer not null,
  bill_number    text not null,
  amount_cents   bigint not null,

  created_at     timestamptz not null default now(),

  constraint vrem_line_unique unique (payment_id, line_number),
  constraint vrem_amount_sane check (amount_cents > 0)
);

create table subledger.bill_applications (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  payment_id     char(26) not null references subledger.vendor_payments(id),
  bill_id        char(26) not null references subledger.bills(id),
  applied_cents  bigint not null,
  application_date date not null,
  tier           integer not null,
  state          text not null default 'applied',
  posted_entry_id char(26),
  created_by_run_id char(26),

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint billapp_state check (state in ('proposed','applied','reversed')),
  constraint billapp_amount_sane check (applied_cents > 0),
  constraint billapp_tier_range check (tier between 1 and 4),
  constraint billapp_once_per_pair unique (payment_id, bill_id)
);

create index billapp_by_bill on subledger.bill_applications (bill_id);

alter table subledger.vendor_payments enable row level security;
alter table subledger.vendor_payments force row level security;
alter table subledger.vendor_remittance_lines enable row level security;
alter table subledger.vendor_remittance_lines force row level security;
alter table subledger.bill_applications enable row level security;
alter table subledger.bill_applications force row level security;

create policy client_isolation on subledger.vendor_payments
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.vendor_remittance_lines
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.bill_applications
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on subledger.vendor_payments
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.vendor_remittance_lines
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.bill_applications
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on subledger.vendor_payments
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.bill_applications
  for each row execute function ledger.guard_manual_override();

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('AP-RECORD-PAYMENT', 'manual',
   'names which vendor a withdrawal already on the register belongs to, once, and a clock cannot discover whose bill it pays, the same reasoning AR-RECORD-PAYMENT gives for a customer deposit',
   false),
  ('AP-APPLY-PAYMENTS', 'propose',
   'posts cash against bills, which changes what is owed to a vendor and is a general ledger write, the same reasoning AR-APPLY-PAYMENTS gives for a customer payment',
   true);

commit;
