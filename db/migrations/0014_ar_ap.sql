-- 0014_ar_ap.sql
-- Doc 02 module 5. The receivable and payable subledger, which does not exist yet.
--
-- Migration 0005 created the subledger schema and gave it vendors, fixed
-- assets, deferrals, loans, and recurring templates. It never created a
-- customer, an invoice, a bill, a payment, or a credit memo, and 0013 did not
-- add them either. Writing the six module 5 runs against the schema as it
-- stands is not possible: there is nothing to age, nothing to state, nothing to
-- apply a payment to, and nothing to write off. So this migration creates the
-- subledger rather than only adding columns to it.
--
-- What is created here, and why each table has to exist:
--
--   1. subledger.customers. The receivable counterparty, plus the four late fee
--      columns the module 5 brief names: late_fee_enabled, annualized_rate_bp,
--      grace_days, and do_not_pursue. A rate is stored in basis points because
--      doc 00 Part 1 forbids a decimal rate anywhere in this schema.
--   2. subledger.invoices. Original amount, tax, applied payments, applied
--      credits, and written off amount, all bigint cents, so the open balance
--      is a subtraction rather than a query over a history table. A late fee
--      invoice is an invoice with parent_invoice_id set, which is what makes
--      the fee traceable to the invoice that earned it and keeps the fee out
--      of its own fee base.
--   3. subledger.credit_memos and subledger.customer_payments, with
--      subledger.remittance_lines beside the payment. Remittance is structured
--      rows, never free text parsed at run time, for the same reason bill terms
--      are structured: an amount nobody can reproduce is worse than no amount.
--   4. subledger.payment_applications. The link table AR-APPLY-PAYMENTS writes,
--      carrying the tier that resolved it so a reviewer can see why.
--   5. subledger.aging_snapshots. One row per document per as of date per side,
--      plus one tie row per side carrying the control balance and the signed
--      difference gate G04 reads.
--   6. subledger.statement_documents and subledger.statement_items. A statement
--      is built in state draft and is never delivered by a run. There is no
--      delivery column here and no external address column anywhere.
--   7. subledger.writeoff_proposals. Age, balance, method, tax portion, and the
--      approval authority that allowed the write off to be prepared at all.
--   8. subledger.bills and subledger.vendor_credits, the payable side, with
--      terms stored as discount_bps, discount_days, and net_days rather than a
--      terms string.
--   9. subledger.arap_policies. One row per client holding the thresholds and
--      the account numbers the six runs read. Absent means every default in doc
--      02 module 5 applies.
--
-- subledger.vendors gains early_discount_rule, which decides whether a taken
-- discount lands in a purchase discount income account or becomes a vendor
-- credit. The rule is stored per vendor because it is a vendor agreement, not a
-- firm preference.
--
-- Every money column is bigint integer cents, debit positive and credit
-- negative, per doc 00 Part 1. Every rate is an integer basis point count.
-- Every table that a run writes carries a version column, because a run freezes
-- its scope by hashing the version of each row that participated and a table
-- with no version column cannot take part in that. Every table carries the
-- manual override columns and the override guard trigger, because the override
-- contract in doc 03 Part 6 is a property of the store and not of a run.
--
-- Nothing in this migration computes a tax liability, files a form, or emits a
-- legal notice. A late fee is a contractual bookkeeping mechanic, an early
-- payment discount is a vendor agreement, and a write off is a bookkeeping
-- entry. The written off sales tax column exists so the tax payable account is
-- not left overstated, which is bookkeeping, not a tax position. A tax position
-- is CPA work and routes to CPA-BUILD-HANDOFF.
--
-- Forward only. No down migration.

begin;

-- ---------------------------------------------------------------------------
-- 1. Policy. One row per client, and absent means the doc 02 defaults apply.
--
-- The account numbers live here rather than being hardcoded in a run, because
-- doc 00 Part 4 gives blocks and not fixed numbers, and a client chart can put
-- the receivable control anywhere inside the 1100 block. A run that could not
-- read the number would have to guess.
-- ---------------------------------------------------------------------------

create table subledger.arap_policies (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  -- Doc 02 ARAP-REFRESH-AGING rule 2. Read, never inferred.
  aging_basis    text not null default 'due_date',

  -- Doc 02 AR-BUILD-STATEMENTS rule 1 and rule 3.
  minimum_statement_balance_cents bigint not null default 100,
  statement_type text not null default 'open_item',
  message_neutral  text,
  message_reminder text,
  message_firm     text,
  message_final    text,

  -- Doc 02 AR-CHARGE-LATEFEES. The client floor and ceiling. A per customer
  -- rate and grace window override the client grace window.
  grace_days     integer not null default 10,
  late_fee_minimum_cents bigint not null default 0,
  late_fee_maximum_cents bigint,
  suppress_below_minimum_fee boolean not null default true,

  -- Doc 02 AR-WRITEOFF-UNCOLLECTIBLE rule 1, 2, and 4.
  writeoff_age_days integer not null default 180,
  writeoff_minimum_cents bigint not null default 100,
  required_attempts integer not null default 3,
  writeoff_method text not null default 'direct',
  approval_tier1_cents bigint not null default 100000,

  -- Doc 02 AP-APPLY-DISCOUNTS rule 3.
  discount_base_excludes_freight_tax boolean not null default true,

  -- The chart, per doc 00 Part 4 blocks.
  ar_control_account   char(4) not null,      -- 1100 block
  ar_clearing_account  char(4) not null,      -- receipts awaiting application
  allowance_account    char(4),               -- 1100 block, allowance method
  bad_debt_account     char(4),               -- 6000 to 7999, direct method
  sales_tax_account    char(4),               -- 2400 block
  late_fee_revenue_account char(4),           -- 4000 block
  ap_control_account   char(4) not null,      -- 2000 block
  ap_clearing_account  char(4) not null,      -- where a payment is funded from
  purchase_discount_account char(4),          -- 8000 block, other income
  vendor_credit_account char(4),              -- 2000 block

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint arap_policy_one_per_client unique (client_id),
  constraint arap_aging_basis check (aging_basis in ('due_date','invoice_date')),
  constraint arap_statement_type check (
    statement_type in ('open_item','balance_forward')),
  constraint arap_writeoff_method check (writeoff_method in ('allowance','direct')),
  constraint arap_grace_sane check (grace_days >= 0),
  constraint arap_age_sane check (writeoff_age_days >= 0),
  constraint arap_attempts_sane check (required_attempts >= 0),
  constraint arap_minimums_sane check (
    minimum_statement_balance_cents >= 0
    and writeoff_minimum_cents >= 0
    and late_fee_minimum_cents >= 0
    and (late_fee_maximum_cents is null or late_fee_maximum_cents >= 0)),
  -- The allowance method needs an allowance account and the direct method needs
  -- a bad debt account. Doc 02 lists the missing account as a blocking
  -- condition, so the schema refuses the combination outright.
  constraint arap_writeoff_accounts check (
    (writeoff_method = 'allowance' and allowance_account is not null)
    or (writeoff_method = 'direct' and bad_debt_account is not null))
);

alter table subledger.arap_policies enable row level security;
alter table subledger.arap_policies force row level security;

create policy client_isolation on subledger.arap_policies
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on subledger.arap_policies
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on subledger.arap_policies
  for each row execute function ledger.guard_manual_override();

-- ---------------------------------------------------------------------------
-- 2. Customers.
--
-- The late fee columns are per customer because a late fee is a term of one
-- customer agreement. late_fee_enabled has to be true before a fee is computed
-- at all, which is the difference between a policy that exists and a policy
-- that was agreed to. do_not_pursue is one of the two authorities that let a
-- write off be prepared, and it is a standing decision a person records once.
--
-- statement_document_id is where AR-BUILD-STATEMENTS attaches the draft it
-- built. There is no delivery column and no email column. A statement is
-- client facing correspondence and a run does not send it.
-- ---------------------------------------------------------------------------

create table subledger.customers (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  name           text not null,
  is_active      boolean not null default true,

  statement_suppressed boolean not null default false,
  statement_type text,                        -- null follows the client policy
  application_preference text not null default 'oldest_first',

  late_fee_enabled boolean not null default false,
  annualized_rate_bp integer,                 -- basis points a year, not a decimal
  grace_days     integer,                     -- null follows the client policy
  flat_fee_cents bigint,                      -- the flat alternative to a rate
  late_fee_exempt boolean not null default false,

  do_not_pursue  boolean not null default false,
  payment_plan_active boolean not null default false,

  statement_document_id char(26),
  statement_document_date date,

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint cust_application_preference check (
    application_preference in ('oldest_first','none')),
  constraint cust_statement_type check (
    statement_type is null or statement_type in ('open_item','balance_forward')),
  constraint cust_grace_sane check (grace_days is null or grace_days >= 0),
  constraint cust_rate_sane check (
    annualized_rate_bp is null or annualized_rate_bp between 0 and 1000000),
  constraint cust_flat_sane check (flat_fee_cents is null or flat_fee_cents >= 0),
  -- A fee that is switched on with neither a rate nor a flat amount computes
  -- nothing, so the schema refuses the state rather than letting a run report
  -- it every night.
  constraint cust_fee_inputs check (
    late_fee_enabled = false
    or annualized_rate_bp is not null
    or flat_fee_cents is not null)
);

create index cust_by_name on subledger.customers (client_id, name);

alter table subledger.customers enable row level security;
alter table subledger.customers force row level security;

create policy client_isolation on subledger.customers
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on subledger.customers
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on subledger.customers
  for each row execute function ledger.guard_manual_override();

-- ---------------------------------------------------------------------------
-- 3. Invoices.
--
-- Open balance is original minus applied payments minus applied credits minus
-- written off, per doc 02 ARAP-REFRESH-AGING rule 1. The three subtrahends are
-- stored as running totals rather than derived from the application table on
-- every read, because the aging run reads every open document on every
-- execution and a running total is the only shape that stays cheap.
--
-- A late fee invoice carries parent_invoice_id, is_late_fee, and fee_months.
-- fee_months is what makes a rerun charge nothing: the fee run sums the months
-- already charged against the parent and charges only the difference.
-- ---------------------------------------------------------------------------

create table subledger.invoices (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  customer_id    char(26) not null references subledger.customers(id),
  invoice_number text not null,
  invoice_date   date not null,
  due_date       date not null,

  original_amount_cents bigint not null,
  tax_cents      bigint not null default 0,
  applied_payments_cents bigint not null default 0,
  applied_credits_cents bigint not null default 0,
  written_off_cents bigint not null default 0,

  status         text not null default 'posted',
  in_dispute     boolean not null default false,
  collection_attempts integer not null default 0,

  parent_invoice_id char(26),
  is_late_fee    boolean not null default false,
  fee_months     integer,

  -- The second of the two write off authorities. A person sets this on the one
  -- invoice they looked at.
  writeoff_approved boolean not null default false,

  ar_account     char(4) not null,
  revenue_account char(4) not null,

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint inv_number_unique unique (client_id, invoice_number),
  constraint inv_status check (status in (
    'draft','posted','paid','void','written_off')),
  constraint inv_dates check (due_date >= invoice_date),
  constraint inv_amount_sane check (original_amount_cents >= 0),
  constraint inv_tax_within_amount check (
    tax_cents >= 0 and tax_cents <= original_amount_cents),
  constraint inv_applied_sane check (
    applied_payments_cents >= 0 and applied_credits_cents >= 0
    and written_off_cents >= 0),
  -- Doc 02 AR-APPLY-PAYMENTS test assertion: no invoice ever shows a negative
  -- open balance after application. The store refuses it.
  constraint inv_no_negative_open check (
    original_amount_cents
      - applied_payments_cents - applied_credits_cents - written_off_cents >= 0),
  constraint inv_fee_shape check (
    (is_late_fee = false and parent_invoice_id is null and fee_months is null)
    or (is_late_fee = true and parent_invoice_id is not null
        and fee_months is not null and fee_months > 0)),
  foreign key (client_id, ar_account) references ledger.accounts (client_id, account_number),
  foreign key (client_id, revenue_account) references ledger.accounts (client_id, account_number)
);

create index inv_open_by_customer
  on subledger.invoices (client_id, customer_id, due_date)
  where status in ('posted','draft');

create index inv_by_parent
  on subledger.invoices (parent_invoice_id)
  where parent_invoice_id is not null;

alter table subledger.invoices enable row level security;
alter table subledger.invoices force row level security;

create policy client_isolation on subledger.invoices
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on subledger.invoices
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on subledger.invoices
  for each row execute function ledger.guard_manual_override();

-- ---------------------------------------------------------------------------
-- 4. Credit memos and customer payments, with structured remittance.
--
-- A payment arrives on the register coded to the receivable clearing account.
-- Application is what moves it from the clearing account to the control
-- account, so the payment row stores the clearing account it landed in and the
-- register row it came from.
--
-- match_hint names one invoice. A remittance covering several invoices is rows
-- in subledger.remittance_lines, one per invoice, with the amount the payer
-- stated. Doc 02 AP-APPLY-DISCOUNTS rule 1 refuses to parse terms from free
-- text and the same reasoning applies here: a remittance read out of a text
-- blob is an amount nobody can reproduce.
-- ---------------------------------------------------------------------------

create table subledger.credit_memos (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  customer_id    char(26) not null references subledger.customers(id),
  memo_number    text not null,
  memo_date      date not null,
  amount_cents   bigint not null,
  applied_cents  bigint not null default 0,
  status         text not null default 'open',

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint memo_status check (status in ('open','applied','void')),
  constraint memo_amount_sane check (amount_cents >= 0),
  constraint memo_applied_within check (
    applied_cents >= 0 and applied_cents <= amount_cents)
);

create table subledger.customer_payments (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  customer_id    char(26) not null references subledger.customers(id),
  payment_date   date not null,
  amount_cents   bigint not null,
  applied_cents  bigint not null default 0,

  on_hold        boolean not null default false,
  match_hint     text,                        -- one invoice number, or null
  transaction_id char(26),                    -- the register row it arrived on
  clearing_account char(4) not null,
  status         text not null default 'unapplied',
  applied_tier   integer,

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint pay_status check (status in (
    'unapplied','partially_applied','applied','void')),
  constraint pay_amount_sane check (amount_cents > 0),
  -- Doc 02 AR-APPLY-PAYMENTS test assertion: the sum of applied amounts never
  -- exceeds the payment amount, in any fixture.
  constraint pay_applied_within check (
    applied_cents >= 0 and applied_cents <= amount_cents),
  constraint pay_tier_range check (applied_tier is null or applied_tier between 1 and 4),
  foreign key (client_id, clearing_account)
    references ledger.accounts (client_id, account_number)
);

create index pay_open_by_date
  on subledger.customer_payments (client_id, payment_date)
  where status in ('unapplied','partially_applied');

create table subledger.remittance_lines (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  payment_id     char(26) not null references subledger.customer_payments(id),
  line_number    integer not null,
  invoice_number text not null,
  amount_cents   bigint not null,

  created_at     timestamptz not null default now(),

  constraint rem_line_unique unique (payment_id, line_number),
  constraint rem_amount_sane check (amount_cents > 0)
);

create table subledger.payment_applications (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  payment_id     char(26) not null references subledger.customer_payments(id),
  invoice_id     char(26) not null references subledger.invoices(id),
  applied_cents  bigint not null,
  application_date date not null,
  -- Which of the four doc 02 tiers resolved this application. Stored so a
  -- reviewer can see why, and so tier 3 and tier 4 work stays distinguishable
  -- from tier 1 and tier 2 work.
  tier           integer not null,
  state          text not null default 'applied',
  posted_entry_id char(26),
  created_by_run_id char(26),

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint app_state check (state in ('proposed','applied','reversed')),
  constraint app_amount_sane check (applied_cents > 0),
  constraint app_tier_range check (tier between 1 and 4),
  constraint app_once_per_pair unique (payment_id, invoice_id)
);

create index app_by_invoice on subledger.payment_applications (invoice_id);

-- ---------------------------------------------------------------------------
-- 5. Aging snapshots.
--
-- One row per document per as of date per side, plus one tie row per side. The
-- tie row has a null document and carries the control balance and the signed
-- difference, which is what gate G04 reads. Keeping the tie in the same table
-- as the buckets means a reader who has the snapshot has the proof with it.
--
-- The unique constraint over as of date, side, and document is what makes the
-- run idempotent: a second execution on the same date finds its own rows and
-- either agrees with them or supersedes them in place.
-- ---------------------------------------------------------------------------

create table subledger.aging_snapshots (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  as_of_date     date not null,
  side           text not null,
  aging_basis    text not null,

  party_id       char(26),
  party_name     text not null,
  document_id    char(26),
  document_number text,
  document_date  date,
  basis_date     date,
  age_days       integer,

  bucket         text not null,
  open_balance_cents bigint not null default 0,

  -- Tie rows only. Doc 02 ARAP-REFRESH-AGING rule 5.
  control_account char(4),
  control_balance_cents bigint,
  tie_difference_cents bigint,
  subledger_out_of_tie boolean not null default false,

  created_by_run_id char(26),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint aging_side check (side in ('receivable','payable')),
  constraint aging_basis_value check (aging_basis in ('due_date','invoice_date')),
  constraint aging_bucket check (bucket in (
    'current','b1_30','b31_60','b61_90','b91_plus','credits','tie')),
  constraint aging_tie_shape check (
    (bucket = 'tie' and document_id is null and control_account is not null)
    or (bucket <> 'tie' and document_id is not null)),
  constraint aging_one_per_document unique (client_id, as_of_date, side, document_id)
);

create index aging_by_date
  on subledger.aging_snapshots (client_id, as_of_date, side);

-- ---------------------------------------------------------------------------
-- 6. Statement documents.
--
-- State is draft and there is no other state a run can write. There is no
-- delivered_at column, no recipient column, and no address column, because the
-- run that builds a statement does not send it and nothing in this schema
-- should imply that it could. Delivery is an operator action against the
-- portal and it lands in the audit log, not here.
-- ---------------------------------------------------------------------------

create table subledger.statement_documents (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  customer_id    char(26) not null references subledger.customers(id),
  statement_date date not null,
  statement_type text not null,
  state          text not null default 'draft',

  opening_balance_cents bigint not null default 0,
  activity_cents bigint not null default 0,
  closing_balance_cents bigint not null default 0,

  message_band   text not null,
  message_text   text not null,
  oldest_item_age_days integer not null default 0,
  item_count     integer not null default 0,

  created_by_run_id char(26),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint stmt_type check (statement_type in ('open_item','balance_forward')),
  constraint stmt_state check (state in ('draft','superseded')),
  constraint stmt_band check (message_band in (
    'neutral','reminder','firm','final_notice')),
  -- Doc 02 AR-BUILD-STATEMENTS rule 3. Prior closing plus period activity must
  -- equal the closing balance exactly, and the statement is not produced if it
  -- does not, so the store refuses a statement that does not foot.
  constraint stmt_foots check (
    opening_balance_cents + activity_cents = closing_balance_cents),
  constraint stmt_one_per_customer_date unique (client_id, customer_id, statement_date)
);

create table subledger.statement_items (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  statement_id   char(26) not null references subledger.statement_documents(id),
  line_number    integer not null,
  item_kind      text not null,
  document_id    char(26) not null,
  document_number text not null,
  document_date  date not null,
  original_cents bigint not null default 0,
  applied_cents  bigint not null default 0,
  open_cents     bigint not null default 0,
  running_balance_cents bigint not null default 0,

  created_at     timestamptz not null default now(),

  constraint stmt_item_kind check (item_kind in ('invoice','payment','credit')),
  constraint stmt_item_unique unique (statement_id, line_number)
);

-- ---------------------------------------------------------------------------
-- 7. Write off proposals.
--
-- authority records which of the two standing decisions allowed the proposal to
-- be prepared: the customer flag or the per invoice approval. A proposal with
-- neither is a review item and carries a null authority, and nothing posts
-- against it.
-- ---------------------------------------------------------------------------

create table subledger.writeoff_proposals (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  invoice_id     char(26) not null references subledger.invoices(id),
  customer_id    char(26) not null references subledger.customers(id),
  as_of_date     date not null,
  age_days       integer not null,
  open_balance_cents bigint not null,
  net_cents      bigint not null,
  tax_cents      bigint not null default 0,
  method         text not null,
  approval_route text not null,
  authority      text,
  collection_attempts integer not null default 0,
  state          text not null default 'proposed',
  posted_entry_id char(26),

  created_by_run_id char(26),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint wo_method check (method in ('allowance','direct')),
  constraint wo_route check (approval_route in ('preparer_and_lead','partner')),
  constraint wo_authority check (
    authority is null or authority in ('do_not_pursue','manual_approve')),
  constraint wo_state check (state in ('proposed','posted','withdrawn')),
  -- Doc 02 AR-WRITEOFF-UNCOLLECTIBLE test assertion: the written off tax
  -- portion plus the written off net equals the invoice open balance exactly.
  constraint wo_parts_foot check (net_cents + tax_cents = open_balance_cents),
  -- Nothing posts without one of the two authorities. The store holds the line
  -- even if a future run forgets to.
  constraint wo_posted_needs_authority check (
    state <> 'posted' or authority is not null),
  constraint wo_one_per_invoice_date unique (client_id, invoice_id, as_of_date)
);

-- ---------------------------------------------------------------------------
-- 8. Bills and vendor credits, the payable side.
--
-- Terms are structured: discount basis points, discount days, and net days.
-- There is no terms text column, because doc 02 AP-APPLY-DISCOUNTS rule 1 says
-- terms are never parsed from free text at run time and a column that existed
-- would eventually be parsed.
-- ---------------------------------------------------------------------------

create table subledger.bills (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  vendor_id      char(26) not null references subledger.vendors(id),
  bill_number    text not null,
  bill_date      date not null,
  due_date       date not null,

  original_amount_cents bigint not null,
  freight_cents  bigint not null default 0,
  tax_cents      bigint not null default 0,
  paid_cents     bigint not null default 0,
  discount_taken_cents bigint not null default 0,
  credits_cents  bigint not null default 0,

  discount_bps   integer,
  discount_days  integer,
  net_days       integer,

  status         text not null default 'posted',
  on_hold        boolean not null default false,
  in_dispute     boolean not null default false,
  ap_account     char(4) not null,
  expense_account char(4) not null,

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint bill_number_unique unique (client_id, bill_number),
  constraint bill_status check (status in ('draft','posted','paid','void')),
  constraint bill_dates check (due_date >= bill_date),
  constraint bill_amount_sane check (original_amount_cents >= 0),
  constraint bill_parts_within check (
    freight_cents >= 0 and tax_cents >= 0
    and freight_cents + tax_cents <= original_amount_cents),
  constraint bill_settled_sane check (
    paid_cents >= 0 and discount_taken_cents >= 0 and credits_cents >= 0),
  constraint bill_no_negative_open check (
    original_amount_cents - paid_cents - discount_taken_cents - credits_cents >= 0),
  -- 2/10 net 30 is discount_bps 200, discount_days 10, net_days 30. All three
  -- or none, because two of the three describe nothing usable.
  constraint bill_terms_complete check (
    (discount_bps is null and discount_days is null)
    or (discount_bps is not null and discount_days is not null
        and net_days is not null and net_days >= discount_days)),
  constraint bill_discount_sane check (
    discount_bps is null or discount_bps between 0 and 10000),
  foreign key (client_id, ap_account) references ledger.accounts (client_id, account_number),
  foreign key (client_id, expense_account)
    references ledger.accounts (client_id, account_number)
);

create index bill_open_by_date
  on subledger.bills (client_id, bill_date)
  where status in ('posted','draft');

create table subledger.vendor_credits (
  id             char(26) primary key,
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  vendor_id      char(26) not null references subledger.vendors(id),
  bill_id        char(26) references subledger.bills(id),
  credit_date    date not null,
  amount_cents   bigint not null,
  applied_cents  bigint not null default 0,
  state          text not null default 'open',
  source         text not null default 'early_payment_discount',
  posted_entry_id char(26),
  created_by_run_id char(26),

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint vc_state check (state in ('open','applied','void')),
  constraint vc_amount_sane check (amount_cents > 0),
  constraint vc_applied_within check (
    applied_cents >= 0 and applied_cents <= amount_cents)
);

-- ---------------------------------------------------------------------------
-- 9. The vendor discount rule.
--
-- Whether a taken early payment discount is other income or a credit against
-- the next bill is a term of the vendor agreement, so it is stored per vendor.
-- Null means income, which is the common case, and the run reads the column
-- rather than deciding.
-- ---------------------------------------------------------------------------

alter table subledger.vendors
  add column early_discount_rule text;

alter table subledger.vendors
  add constraint vendor_early_discount_rule check (
    early_discount_rule is null
    or early_discount_rule in ('purchase_discount_income','vendor_credit'));

-- ---------------------------------------------------------------------------
-- 10. Row level security and the override guard on everything added above.
-- ---------------------------------------------------------------------------

alter table subledger.credit_memos enable row level security;
alter table subledger.credit_memos force row level security;
alter table subledger.customer_payments enable row level security;
alter table subledger.customer_payments force row level security;
alter table subledger.remittance_lines enable row level security;
alter table subledger.remittance_lines force row level security;
alter table subledger.payment_applications enable row level security;
alter table subledger.payment_applications force row level security;
alter table subledger.aging_snapshots enable row level security;
alter table subledger.aging_snapshots force row level security;
alter table subledger.statement_documents enable row level security;
alter table subledger.statement_documents force row level security;
alter table subledger.statement_items enable row level security;
alter table subledger.statement_items force row level security;
alter table subledger.writeoff_proposals enable row level security;
alter table subledger.writeoff_proposals force row level security;
alter table subledger.bills enable row level security;
alter table subledger.bills force row level security;
alter table subledger.vendor_credits enable row level security;
alter table subledger.vendor_credits force row level security;

create policy client_isolation on subledger.credit_memos
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.customer_payments
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.remittance_lines
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.payment_applications
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.aging_snapshots
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.statement_documents
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.statement_items
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.writeoff_proposals
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.bills
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.vendor_credits
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on subledger.credit_memos
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.customer_payments
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.remittance_lines
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.payment_applications
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.aging_snapshots
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.statement_documents
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.statement_items
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.writeoff_proposals
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.bills
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.vendor_credits
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on subledger.credit_memos
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.customer_payments
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.payment_applications
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.aging_snapshots
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.statement_documents
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.writeoff_proposals
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.bills
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.vendor_credits
  for each row execute function ledger.guard_manual_override();

commit;
