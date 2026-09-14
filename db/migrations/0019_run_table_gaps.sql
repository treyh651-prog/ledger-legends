-- 0019_run_table_gaps.sql
-- The eleven row map keys that did not resolve to anything in real Postgres.
--
-- Every run had only ever executed against the in memory port, so nothing ever
-- proved that the tables named in `RowMap` exist in SQL. Migrations 0001
-- through 0018 applied cleanly and still left eleven keys pointing at nothing.
-- Four of those were a map problem and are fixed in `db-postgres.ts`. Seven had
-- no create statement in any migration, and they are created here.
--
-- What this migration creates, and why each table has to exist:
--
--   1. ledger.transfer_pairs. TXN-PAIR-TRANSFERS writes one row per matched
--      outbound and inbound leg. The pairing has to be a row rather than only
--      the `paired_with_id` column on the register, because a person confirming
--      a pair the run guessed is a fact about the pair and not about either leg.
--   2. ledger.suspense_items. The whole output of level 9 of the cascade, and
--      the only record of why a transaction is parked. The register carries one
--      suspense reason, and a transaction can collect several over a month.
--   3. ledger.bank_code_mappings. Level 8 reads this. Doc 04 never modeled it,
--      so the column set comes from TXN-MAP-BANKCODES.
--   4. subledger.settlement_rows. An uploaded processor report row, which is
--      the evidence side of the level 4 split. It is a subledger record, not a
--      ledger row, which is why it sits with the other subledgers.
--   5. ledger.document_links. What the receipt check reads. A document already
--      knows the transaction it was filed against, but a transaction can carry
--      more than one document and the check needs the set, not the last one.
--   6. ledger.portal_requests. One open ask per client owned suspense code, so
--      a daily sweep does not stack four copies of the same question.
--   7. ledger.documentation_exceptions. The coding applies and the support is
--      missing. That is not a suspense routing, so it needs its own table or it
--      would have to be spelled as one.
--
-- ledger.chart_accounts becomes an updatable view over ledger.accounts with an
-- instead of insert trigger. See section 8 and NOTES.md entry 135.
--
-- ledger.run_sequences is reconciled with the row the sequence runner writes.
-- See section 9 and NOTES.md entry 137.
--
-- Conventions held here because a table that skips them is a tenancy hole:
-- firm_id and client_id on every table, row level security enabled and forced,
-- a client_isolation policy wrapping tenancy.has_client_access in a select on
-- both using and with check, a leading client_id index and a firm_id index, the
-- discriminator freeze trigger, the override guard where the row can be
-- claimed by a person, money as bigint cents, and a named check constraint on
-- every enumerated text column spelling out the values the TypeScript union
-- allows.
--
-- Run execution ids are 31 characters, 'RUNX-' and a ULID, so every run id
-- column here is char(31). Sequence ids are 33, 'RUNSEQ-' and a ULID.
--
-- COMPLIANCE. Nothing here computes a tax liability or sends anything. A portal
-- request is a row saying a question is open. No address column, no delivery
-- column, no credential column.
--
-- Forward only. No down migration.

begin;

-- ---------------------------------------------------------------------------
-- 1. Transfer pairs.
--
-- One row per pair, keyed so neither leg can appear in two pairs. The register
-- already carries paired_with_id on both legs, and that column cannot record
-- who confirmed the pair or which run proposed it.
-- ---------------------------------------------------------------------------

create table ledger.transfer_pairs (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  outbound_txn_id char(26) not null,
  inbound_txn_id  char(26) not null,
  created_by_run_id char(31) not null,
  -- A person agreeing with the pair the run proposed. TXN-PAIR-TRANSFERS reads
  -- this and leaves a confirmed pair alone rather than re-proposing it.
  manually_confirmed boolean not null default false,

  version        integer not null default 1,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint pair_legs_distinct check (outbound_txn_id <> inbound_txn_id),
  constraint pair_override_complete check (
    not manual_override or (manual_override_by is not null and manual_override_at is not null)),
  -- One pair per leg. Two pairs sharing a leg would double count the transfer.
  constraint pair_one_per_outbound unique (client_id, outbound_txn_id),
  constraint pair_one_per_inbound unique (client_id, inbound_txn_id),
  unique (client_id, id),
  foreign key (client_id, outbound_txn_id)
    references ledger.transactions (client_id, id),
  foreign key (client_id, inbound_txn_id)
    references ledger.transactions (client_id, id)
);

create index transfer_pairs_client on ledger.transfer_pairs (client_id, id);
create index transfer_pairs_firm on ledger.transfer_pairs (firm_id);
create index transfer_pairs_by_run on ledger.transfer_pairs (created_by_run_id);

-- ---------------------------------------------------------------------------
-- 2. Suspense items.
--
-- Level 9 of the cascade produces nothing but these. The reason code format is
-- the same one the register enforces, so a code that exists on one and not the
-- other is impossible. related_ids is jsonb rather than char(26)[] because the
-- port encodes every array valued field as JSON on the way in, and a text array
-- column rejects that literal. See NOTES.md entry 136.
--
-- A withdrawn item stays. TXN-SWEEP-SUSPENSE reads the history to honor an
-- earlier step's code, and deleting the row would lose the reason the item was
-- ever parked.
-- ---------------------------------------------------------------------------

create table ledger.suspense_items (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  transaction_id char(26) not null,
  reason_code    char(6) not null,
  account_number char(4) not null,            -- the clearing account it parks in
  detail         text not null,
  -- Other rows the routing decision depended on, for example both legs of a
  -- suspected transfer. Ordered, because the run writes them in decision order.
  related_ids    jsonb not null default '[]'::jsonb,
  created_by_run_id char(31) not null,
  -- Set when a later run or a person resolves the item. The row stays either way.
  withdrawn_by_run_id char(31),

  version        integer not null default 1,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint sus_reason_format check (reason_code ~ '^SUS-[0-9]{2}$'),
  constraint sus_related_is_array check (jsonb_typeof(related_ids) = 'array'),
  constraint sus_override_complete check (
    not manual_override or (manual_override_by is not null and manual_override_at is not null)),
  unique (client_id, id),
  foreign key (client_id, transaction_id)
    references ledger.transactions (client_id, id),
  foreign key (client_id, account_number)
    references ledger.accounts (client_id, account_number)
);

create index suspense_items_client on ledger.suspense_items (client_id, id);
create index suspense_items_firm on ledger.suspense_items (firm_id);
create index suspense_items_txn on ledger.suspense_items (client_id, transaction_id);
-- The sweep and the escalation runs walk what is still parked.
create index suspense_items_open
  on ledger.suspense_items (client_id, reason_code)
  where withdrawn_by_run_id is null;
-- Doc 03. The undo plan for a run reads back exactly what that run wrote.
create index suspense_items_by_run
  on ledger.suspense_items (firm_id, created_by_run_id);

-- ---------------------------------------------------------------------------
-- 3. Bank code mappings.
--
-- Level 8 of the cascade. The bank or card issuer sends a category code and the
-- firm decides once what that code means for a client. institution_id holds
-- '*' for the fallback row, which is what lets a client carry one general
-- mapping plus per institution corrections without a second table.
-- ---------------------------------------------------------------------------

create table ledger.bank_code_mappings (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  institution_id text not null default '*',
  bank_code      text not null,
  category_id    text not null,
  is_active      boolean not null default true,

  version        integer not null default 1,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint bcm_code_present check (bank_code <> ''),
  constraint bcm_institution_present check (institution_id <> ''),
  constraint bcm_override_complete check (
    not manual_override or (manual_override_by is not null and manual_override_at is not null)),
  -- One answer per code per institution. Two active rows for the same code
  -- would make level 8 depend on row order.
  constraint bcm_one_per_code unique (client_id, institution_id, bank_code),
  unique (client_id, id),
  foreign key (client_id, category_id)
    references ledger.categories (client_id, id)
);

create index bcm_client on ledger.bank_code_mappings (client_id, id);
create index bcm_firm on ledger.bank_code_mappings (firm_id);
create index bcm_lookup
  on ledger.bank_code_mappings (client_id, bank_code, institution_id)
  where is_active;

-- ---------------------------------------------------------------------------
-- 4. Settlement rows.
--
-- One row per payout line on an uploaded processor report. The physical table
-- map already pointed at subledger.settlement_rows, which did not exist, so it
-- is created where the map says it lives.
--
-- Money is bigint cents. fee_cents is stored negative, per doc 02
-- TXN-SPLIT-SETTLEMENTS step 2, so gross plus fee is net rather than gross
-- minus fee.
--
-- There is deliberately no check that gross plus fee equals net. A processor
-- report that does not add up is a real thing that arrives, and the run reports
-- the mismatch by name. A constraint here would refuse to store the row the
-- firm needs to look at. See NOTES.md entry 138.
-- ---------------------------------------------------------------------------

create table subledger.settlement_rows (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  processor_key  text not null,               -- 'STRIPE', 'SQUARE', a key not a name
  payout_id      text not null,               -- the processor's own payout identifier
  payout_date    date not null,
  gross_cents    bigint not null,
  fee_cents      bigint not null,
  net_cents      bigint not null,
  -- The reference the processor prints on the bank line, where it prints one.
  -- Null means the match has to go by date and net amount alone.
  batch_reference text,

  revenue_category_id text not null,
  fee_category_id     text not null,
  -- Set when the split run consumes the row. This is what makes a rerun report
  -- settlement_already_split instead of posting the same gross twice.
  matched_transaction_id char(26),

  version        integer not null default 1,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint settle_processor_key check (processor_key ~ '^[A-Z0-9_]+$'),
  constraint settle_payout_present check (payout_id <> ''),
  constraint settle_fee_not_positive check (fee_cents <= 0),
  constraint settle_override_complete check (
    not manual_override or (manual_override_by is not null and manual_override_at is not null)),
  -- One row per payout line per processor. A second upload of the same report
  -- has to collide rather than double the revenue.
  constraint settle_one_per_payout unique (client_id, processor_key, payout_id),
  unique (client_id, id),
  foreign key (client_id, revenue_category_id)
    references ledger.categories (client_id, id),
  foreign key (client_id, fee_category_id)
    references ledger.categories (client_id, id),
  foreign key (client_id, matched_transaction_id)
    references ledger.transactions (client_id, id)
);

create index settle_client on subledger.settlement_rows (client_id, id);
create index settle_firm on subledger.settlement_rows (firm_id);
-- The split run reads a date window and matches on net amount.
create index settle_window
  on subledger.settlement_rows (client_id, payout_date, payout_id);
create index settle_unsplit
  on subledger.settlement_rows (client_id, payout_date)
  where matched_transaction_id is null;

-- ---------------------------------------------------------------------------
-- 5. Document links.
--
-- docvault.documents already carries linked_transaction_id, which holds one
-- transaction per document. The receipt check asks the other question: every
-- document filed against a transaction. document_type is denormalized from the
-- document so the check does not have to read the vault, and it is constrained
-- to the vault's own vocabulary so the two cannot disagree.
-- ---------------------------------------------------------------------------

create table ledger.document_links (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  transaction_id char(26) not null,
  document_id    char(26) not null references docvault.documents(id),
  document_type  text not null,

  version        integer not null default 1,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint doclink_type check (document_type in (
    'bank_statement','card_statement','w9','engagement_letter','invoice','receipt',
    'loan_agreement','asset_invoice','payroll_report','tax_return','other',
    'invoice_ap','invoice_ar','processor_statement','insurance_policy','lease',
    'formation_document','payroll_register','correspondence')),
  constraint doclink_override_complete check (
    not manual_override or (manual_override_by is not null and manual_override_at is not null)),
  -- Filing the same document against the same transaction twice is one fact.
  constraint doclink_one_per_pair unique (client_id, transaction_id, document_id),
  unique (client_id, id),
  foreign key (client_id, transaction_id)
    references ledger.transactions (client_id, id)
);

create index doclink_client on ledger.document_links (client_id, id);
create index doclink_firm on ledger.document_links (firm_id);
create index doclink_txn on ledger.document_links (client_id, transaction_id);
create index doclink_document on ledger.document_links (document_id);

-- ---------------------------------------------------------------------------
-- 6. Portal requests.
--
-- One open ask per client owned suspense code. The partial unique index is the
-- dedup rule TXN-SWEEP-SUSPENSE and REC-FLAG-STALE both depend on: a daily run
-- finds the open request and skips rather than asking the same question again.
-- Satisfied and waived rows stay, so the history of what was asked survives.
--
-- transaction_id is nullable because a request can be about a client and not
-- about one line, for example a missing bank statement for a whole month.
-- ---------------------------------------------------------------------------

create table ledger.portal_requests (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  transaction_id char(26),
  reason_code    char(6) not null,
  detail         text not null,
  status         text not null default 'open',
  opened_on      date not null,
  due_on         date not null,
  created_by_run_id char(31) not null,
  -- When the ask was recorded, which is not the day it covers. The aging the
  -- practice runs report is measured from opened_on.
  requested_at   timestamptz not null default now(),

  version        integer not null default 1,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint portal_reason_format check (reason_code ~ '^SUS-[0-9]{2}$'),
  constraint portal_status check (status in ('open','satisfied','waived')),
  constraint portal_due_after_opened check (due_on >= opened_on),
  constraint portal_override_complete check (
    not manual_override or (manual_override_by is not null and manual_override_at is not null)),
  unique (client_id, id),
  foreign key (client_id, transaction_id)
    references ledger.transactions (client_id, id)
);

create index portal_client on ledger.portal_requests (client_id, id);
create index portal_firm on ledger.portal_requests (firm_id);
create index portal_open
  on ledger.portal_requests (client_id, reason_code, due_on)
  where status = 'open';

create unique index portal_one_open_per_txn_reason
  on ledger.portal_requests (client_id, transaction_id, reason_code)
  where status = 'open' and transaction_id is not null;
-- The client level ask has no transaction, and a null never collides in a
-- multi column unique index, so that case needs its own index.
create unique index portal_one_open_per_client_reason
  on ledger.portal_requests (client_id, reason_code)
  where status = 'open' and transaction_id is null;

-- ---------------------------------------------------------------------------
-- 7. Documentation exceptions.
--
-- Doc 02 TXN-APPLY-RULES steps 7 and 8. The category applied and the support
-- the category requires is absent. The coding stands, so this is not a suspense
-- routing and it does not stop the cascade. Two kinds only, because the two
-- checks that raise it are the class check and the receipt check.
-- ---------------------------------------------------------------------------

create table ledger.documentation_exceptions (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  transaction_id char(26) not null,
  kind           text not null,
  category_id    text not null,               -- the category whose rule was missed
  detail         text not null,
  status         text not null default 'open',
  created_by_run_id char(31) not null,
  opened_at      timestamptz not null default now(),

  version        integer not null default 1,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint docx_kind check (kind in ('missing_class','missing_receipt')),
  constraint docx_status check (status in ('open','resolved')),
  constraint docx_override_complete check (
    not manual_override or (manual_override_by is not null and manual_override_at is not null)),
  unique (client_id, id),
  foreign key (client_id, transaction_id)
    references ledger.transactions (client_id, id),
  foreign key (client_id, category_id)
    references ledger.categories (client_id, id)
);

create index docx_client on ledger.documentation_exceptions (client_id, id);
create index docx_firm on ledger.documentation_exceptions (firm_id);
-- One open exception per transaction per kind. A rerun refreshes nothing and
-- raises nothing, which is the property the rules run relies on.
create unique index docx_one_open_per_txn_kind
  on ledger.documentation_exceptions (client_id, transaction_id, kind)
  where status = 'open';

-- ---------------------------------------------------------------------------
-- 8. ledger.chart_accounts as a view over ledger.accounts.
--
-- ChartAccountRow is {id, firmId, clientId, accountNumber, name} and the intake
-- run inserts exactly that. The real chart is ledger.accounts, keyed by
-- (client_id, account_number), with no id column, and it requires account_type
-- and normal_side plus the doc 00 block map constraint. A five field insert
-- cannot satisfy it, and the in memory port has been letting the intake run
-- pretend otherwise.
--
-- The view exposes id as client_id and account_number joined by a hyphen, which
-- is derived rather than stored, so repeated reads are stable and no second
-- identity for an account is invented. security_invoker is on, so the row level
-- security policy on ledger.accounts applies to the reader and not to the view
-- owner.
--
-- The instead of insert trigger derives account_type and normal_side from the
-- account number using the same block map migration 0002 encodes as
-- acct_block_matches_type. For the 8000 and 9000 blocks the map allows two
-- answers and there is nothing in a five field row to choose between them, so
-- the trigger refuses. A guessed account type is a misstatement that survives
-- into every statement built on top of it. See NOTES.md entry 135.
-- ---------------------------------------------------------------------------

create view ledger.chart_accounts
  with (security_invoker = true) as
  select
    a.client_id::text || '-' || a.account_number as id,
    a.firm_id,
    a.client_id,
    a.account_number,
    a.name
  from ledger.accounts a;

create or replace function ledger.chart_accounts_insert()
returns trigger language plpgsql as $$
declare
  block char(1);
  derived_type text;
  derived_side text;
begin
  if new.account_number is null or new.account_number !~ '^[0-9]{4}$' then
    raise exception 'chart_accounts_bad_account_number %', coalesce(new.account_number, 'null')
      using errcode = 'check_violation';
  end if;

  block := left(new.account_number, 1);

  -- Doc 00 Part 1, the same blocks acct_block_matches_type enforces. The normal
  -- side follows from the type and is not a second decision.
  if block = '1' then
    derived_type := 'asset';      derived_side := 'debit';
  elsif block = '2' then
    derived_type := 'liability';  derived_side := 'credit';
  elsif block = '3' then
    derived_type := 'equity';     derived_side := 'credit';
  elsif block = '4' then
    derived_type := 'revenue';    derived_side := 'credit';
  elsif block = '5' then
    derived_type := 'cogs';       derived_side := 'debit';
  elsif block in ('6', '7') then
    derived_type := 'expense';    derived_side := 'debit';
  elsif block = '8' then
    raise exception 'chart_accounts_ambiguous_block on account % %, the 8000 block is other_income or other_expense and a five field row does not say which. Insert into ledger.accounts directly with an explicit account_type and normal_side.',
      new.account_number, coalesce(new.name, '')
      using errcode = 'check_violation';
  elsif block = '9' then
    raise exception 'chart_accounts_ambiguous_block on account % %, the 9000 block is tax or memo and a five field row does not say which. Insert into ledger.accounts directly with an explicit account_type and normal_side.',
      new.account_number, coalesce(new.name, '')
      using errcode = 'check_violation';
  else
    raise exception 'chart_accounts_unmapped_block on account % %', new.account_number,
      coalesce(new.name, '')
      using errcode = 'check_violation';
  end if;

  insert into ledger.accounts (
    client_id, firm_id, account_number, name, account_type, normal_side
  ) values (
    new.client_id, new.firm_id, new.account_number, new.name, derived_type, derived_side
  );

  -- The id the caller sent is discarded. The view's id is derived, so returning
  -- the derived form is the only answer a later read will agree with.
  new.id := new.client_id::text || '-' || new.account_number;
  return new;
end;
$$;

create trigger trg_chart_accounts_insert instead of insert on ledger.chart_accounts
  for each row execute function ledger.chart_accounts_insert();

-- ---------------------------------------------------------------------------
-- 9. ledger.run_sequences reconciled with the row the sequence runner writes.
--
-- The row map key run_sequence resolves to ledger.run_sequences once the
-- physical table map is corrected, and the row sequence.ts inserts still did
-- not fit the table migration 0003 created. Three things were wrong, and all
-- three are the kind of thing only a real insert finds:
--
--   id is char(26) and a sequence id is 'RUNSEQ-' and a ULID, which is 33.
--   actor_id is on the row and was on no column, so the sequence had no record
--   of who started it.
--   status is not null with no default and is not on the row at all. It is
--   derivable: a sequence that stopped at a step stopped, and one that did not
--   completed. A before insert trigger derives it rather than a default
--   guessing one value for both cases.
--
-- child_run_ids moves from char(26)[] to jsonb for the same reason
-- suspense_items.related_ids is jsonb. See NOTES.md entries 136 and 137.
-- ---------------------------------------------------------------------------

alter table ledger.run_sequences
  alter column id type char(33),
  alter column status drop not null,
  alter column child_run_ids drop default,
  alter column child_run_ids type jsonb using to_jsonb(child_run_ids),
  alter column child_run_ids set default '[]'::jsonb,
  add column actor_id uuid;

alter table ledger.run_sequences
  add constraint seq_child_run_ids_is_array check (jsonb_typeof(child_run_ids) = 'array');

create or replace function ledger.run_sequence_status()
returns trigger language plpgsql as $$
begin
  if new.status is null then
    new.status := case when new.stopped_at_step is null then 'completed' else 'stopped' end;
  end if;
  return new;
end;
$$;

create trigger trg_run_sequence_status before insert on ledger.run_sequences
  for each row execute function ledger.run_sequence_status();

-- ---------------------------------------------------------------------------
-- 10. The two tables migration 0018 created declare their run id columns five
-- characters too narrow.
--
-- A run execution id is 31 characters. Migration 0018 declared every run id
-- column char(26), which is the ULID width without the 'RUNX-' prefix, so the
-- first insert from a run would have been refused for length. Nothing writes
-- these tables yet, which is why it was invisible. The same mistake exists in
-- migrations 0003 through 0014 on a further eighty columns and is written up in
-- the report rather than fixed here, because a width change across the run log
-- partitions is its own migration and does not belong in this one.
-- ---------------------------------------------------------------------------

alter table import.mapping_profile_columns
  alter column created_by_run_id type char(31);

alter table intake.wizard_sessions
  alter column created_by_run_id type char(31),
  alter column chart_run_id type char(31),
  alter column tasks_run_id type char(31),
  alter column requests_run_id type char(31),
  alter column balances_run_id type char(31);

-- ---------------------------------------------------------------------------
-- 11. Row level security, the discriminator freeze, and the override guard.
--
-- The same three properties every tenant table carries. Tenant isolation is a
-- policy on the row and not a predicate a run remembers to add, the two
-- discriminator columns cannot be edited after insert, and a row a person
-- claimed refuses an automated write.
--
-- All seven carry the override columns, including the two no run writes today.
-- A firm maintained bank code mapping and a document link are both things a
-- person edits, and the guard costs nothing on a table nothing updates.
-- ---------------------------------------------------------------------------

alter table ledger.transfer_pairs enable row level security;
alter table ledger.transfer_pairs force row level security;
alter table ledger.suspense_items enable row level security;
alter table ledger.suspense_items force row level security;
alter table ledger.bank_code_mappings enable row level security;
alter table ledger.bank_code_mappings force row level security;
alter table subledger.settlement_rows enable row level security;
alter table subledger.settlement_rows force row level security;
alter table ledger.document_links enable row level security;
alter table ledger.document_links force row level security;
alter table ledger.portal_requests enable row level security;
alter table ledger.portal_requests force row level security;
alter table ledger.documentation_exceptions enable row level security;
alter table ledger.documentation_exceptions force row level security;

create policy client_isolation on ledger.transfer_pairs
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on ledger.suspense_items
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on ledger.bank_code_mappings
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on subledger.settlement_rows
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on ledger.document_links
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on ledger.portal_requests
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on ledger.documentation_exceptions
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on ledger.transfer_pairs
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on ledger.suspense_items
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on ledger.bank_code_mappings
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on subledger.settlement_rows
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on ledger.document_links
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on ledger.portal_requests
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on ledger.documentation_exceptions
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on ledger.transfer_pairs
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on ledger.suspense_items
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on ledger.bank_code_mappings
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on subledger.settlement_rows
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on ledger.document_links
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on ledger.portal_requests
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on ledger.documentation_exceptions
  for each row execute function ledger.guard_manual_override();

-- ---------------------------------------------------------------------------
-- 12. Grants.
--
-- ledger.chart_accounts gets select and insert only. There is no instead of
-- update trigger on it, because nothing updates a chart account through the
-- run port and a granted update would fail at the statement rather than at the
-- grant. A rename goes to ledger.accounts, which is where the row lives.
-- ---------------------------------------------------------------------------

grant select, insert, update on ledger.transfer_pairs to app_web, app_worker;
grant select, insert, update on ledger.suspense_items to app_web, app_worker;
grant select, insert, update on ledger.bank_code_mappings to app_web, app_worker;
grant select, insert, update on subledger.settlement_rows to app_web, app_worker;
grant select, insert, update on ledger.document_links to app_web, app_worker;
grant select, insert, update on ledger.portal_requests to app_web, app_worker;
grant select, insert, update on ledger.documentation_exceptions to app_web, app_worker;
grant select, insert on ledger.chart_accounts to app_web, app_worker;
grant execute on function ledger.chart_accounts_insert() to app_web, app_worker;

commit;
