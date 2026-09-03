-- 0011_transaction_register.sql
-- Closes doc 06 correction C9. The bank transaction register.
--
-- Document 04 defines subledgers, schedules, and the journal, but never the
-- register the coding cascade operates on, so several id columns in migrations
-- 0002, 0005, 0008, and 0009 had no foreign key target and the import pipeline
-- had nothing to import into. This migration adds the register, adds the bank
-- and card account table it hangs off, and then points every dangling
-- transaction id column at it.
--
-- The column set is derived from what the runs actually need, not invented:
--   IMPORT-COMMIT-BATCH writes the feed facts, the batch link, the staged row
--   link, the bank supplied id, and the posted entry link.
--   The nine coding runs of doc 02 module 2 read and write the normalized
--   vendor, the duplicate decision, the transfer pair link, the settlement
--   link, the recurring template link, the rule link, the vendor default link,
--   the bank code, and the suspense routing, and every one of them stamps the
--   cascade level that produced the answer.
--   REC-MATCH-TIERED, REC-CLEAR-MATCHED, and REC-FLAG-STALE match on amount,
--   sign, date, and check number, then write cleared, cleared date, instrument
--   type, the stale flag, and the escheat review flag.
--
-- Doc 00 Part 1: money is bigint integer cents, debit positive, credit
-- negative. Doc 00 Part 7: any value set by a person carries the override flag
-- and no run may write over it, which is why the guard trigger is attached here
-- as well as on journal entries.
--
-- There is no PDF derived column here and there never will be one. Every row in
-- this table came from a structured feed or from a person.
--
-- Forward only. No down migration.

begin;

-- ---------------------------------------------------------------------------
-- Bank and card accounts. Doc 04 Part 14 item 4 left these unmodeled, and the
-- register cannot reference an account table that does not exist, so it is
-- created here. One row per real world funding source. account_number is the
-- chart account the source posts to, which is how a register row reaches the
-- ledger without the ledger knowing anything about feeds.
-- ---------------------------------------------------------------------------

create table ledger.bank_accounts (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  account_number char(4) not null,            -- the chart account this feeds
  nickname       text not null,
  kind           text not null default 'bank',
  institution_name text not null,
  institution_id text,                        -- routing or feed side identifier
  mask_last4     char(4),
  currency       char(3) not null default 'USD',

  -- Doc 02 module 2 level 4. A processor payout lands in a destination account
  -- and the settlement split run needs to know which account that is.
  is_processor_destination boolean not null default false,

  -- REC-MATCH-TIERED tier 3. Default 0 disables tier 3, hard ceiling 100 cents.
  amount_tolerance_cents bigint not null default 0,

  is_active      boolean not null default true,
  opened_on      date,
  closed_on      date,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint bank_kind check (kind in ('bank','card','loan','processor')),
  constraint bank_currency check (currency = 'USD'),
  constraint bank_tolerance_range check (amount_tolerance_cents between 0 and 100),
  constraint bank_mask_numeric check (mask_last4 is null or mask_last4 ~ '^[0-9]{4}$'),
  constraint bank_dates check (closed_on is null or opened_on is null or closed_on >= opened_on),
  unique (client_id, id),
  foreign key (client_id, account_number)
    references ledger.accounts (client_id, account_number)
);

create index on ledger.bank_accounts (client_id) where is_active;
create index on ledger.bank_accounts (client_id, account_number);
create index on ledger.bank_accounts (firm_id);

-- ---------------------------------------------------------------------------
-- The register.
--
-- One row per observed bank or card transaction. This is the working set of the
-- coding cascade, the target of the import pipeline, and the book side of
-- reconciliation. It is not the ledger. A register row becomes accounting when
-- journal_entry_id is filled in, and the ledger stays the authority on balances.
-- ---------------------------------------------------------------------------

create table ledger.transactions (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  -- Where it came from ------------------------------------------------------
  bank_account_id char(26) not null,
  account_number char(4) not null,            -- denormalized for the cash side
  source         text not null default 'import',
  import_batch_id char(26) references import.batches(id),
  staged_row_id  char(26) references import.staged_rows(id),
  -- The bank supplied unique id. Doc 05 Part 3: where the file carries one it is
  -- the dedup key and a repeat is rejected outright. Null means the format did
  -- not carry one, which is what puts a suspected repeat on the review path.
  bank_transaction_id text,
  imported_at    timestamptz,

  -- What the feed said, never edited by a run --------------------------------
  posted_date    date not null,
  amount_cents   bigint not null,             -- signed, debit positive
  currency       char(3) not null default 'USD',
  description    text not null,               -- raw bank descriptor
  bank_merchant_name text,                    -- merchant name where the bank sends one
  check_number   text,
  bank_code      text,                        -- bank or card category code, level 8

  -- Vendor normalization, doc 00 Part 5 and TXN-NORMALIZE-VENDORS ------------
  vendor_normalized text,
  vendor_normalization_version integer,
  normalization_degraded boolean not null default false,
  vendor_id      char(26) references subledger.vendors(id),

  -- The coding answer and where it came from --------------------------------
  category_id    text,
  category_version integer,
  -- Doc 00 Part 3. 0 manual, 1 locked period, 2 duplicate, 3 transfer,
  -- 4 settlement, 5 recurring, 6 rule, 7 vendor default, 8 bank code,
  -- 9 suspense. Every level records that it produced the answer.
  cascade_level  smallint,
  rule_id        text references ledger.rules(id),
  rule_version   integer,
  matched_conditions jsonb,                   -- the conditions the rule matched on
  auto_posted_under_rule_promotion boolean not null default false,
  template_id    char(26) references subledger.recurring_templates(id),
  template_version integer,

  class_id       char(26),                    -- dimensions, doc 04 Part 14 item 2
  location_id    char(26),
  program_id     char(26),

  -- Level 2, duplicates ------------------------------------------------------
  duplicate_flag boolean not null default false,
  duplicate_of_transaction_id char(26) references ledger.transactions(id),
  legitimate_repeat boolean not null default false,

  -- Level 3, transfers, and level 4, processor settlements -------------------
  paired_with_id char(26) references ledger.transactions(id),
  settlement_of_transaction_id char(26) references ledger.transactions(id),
  is_processor_settlement boolean not null default false,

  -- Level 9, suspense, doc 00 Part 4 -----------------------------------------
  suspense_reason char(6),
  suspense_owner text,
  suspense_opened_on date,
  suspense_escalates_on date,

  -- The ledger link ----------------------------------------------------------
  journal_entry_id char(26) references ledger.journal_entries(id),
  posted_at      timestamptz,

  -- Reconciliation, doc 02 module 3 ------------------------------------------
  instrument_type text not null default 'other',
  cleared        boolean not null default false,
  cleared_date   date,                        -- the statement line date, not the book date
  stale_flagged  boolean not null default false,
  stale_flagged_on date,
  escheat_review boolean not null default false,
  voided         boolean not null default false,
  void_of_transaction_id char(26) references ledger.transactions(id),
  reissue_of_transaction_id char(26) references ledger.transactions(id),

  -- Batch reversal. A committed batch is reversible as a unit until any row in
  -- it is reconciled, so a reversed row stays visible and stops being a candidate.
  status         text not null default 'active',
  reversed_by_run_id char(26),
  reversed_at    timestamptz,

  -- Manual authority, doc 00 Part 7 ------------------------------------------
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  version        integer not null default 1,
  created_at     timestamptz not null default now(),
  created_by     uuid,
  updated_at     timestamptz not null default now(),

  constraint txn_source check (source in ('import','manual','conversion')),
  constraint txn_status check (status in ('active','reversed')),
  constraint txn_amount_nonzero check (amount_cents <> 0),
  -- Doc 00 Part 1. Foreign currency is out of scope, and a row that is not USD
  -- is only allowed to exist while it carries the SUS-11 routing that says so.
  constraint txn_currency_scope check (currency = 'USD' or suspense_reason = 'SUS-11'),
  constraint txn_instrument check (instrument_type in (
    'issued_check','electronic','deposit','other')),
  constraint txn_cascade_level check (cascade_level is null or cascade_level between 0 and 9),
  constraint txn_suspense_format check (suspense_reason is null or suspense_reason ~ '^SUS-[0-9]{2}$'),
  constraint txn_suspense_owner check (suspense_owner is null or suspense_owner in (
    'firm','client','system')),
  constraint txn_suspense_complete check (
    suspense_reason is null
    or (suspense_owner is not null and suspense_opened_on is not null)),
  constraint txn_level_9_is_suspense check (cascade_level <> 9 or suspense_reason is not null),
  constraint txn_level_0_is_manual check (cascade_level <> 0 or manual_override),
  constraint txn_level_5_needs_template check (
    cascade_level <> 5 or (template_id is not null and template_version is not null)),
  constraint txn_level_6_needs_rule check (
    cascade_level <> 6 or (rule_id is not null and rule_version is not null)),
  constraint txn_category_versioned check (category_id is null or category_version is not null),
  constraint txn_override_complete check (
    not manual_override or (manual_override_by is not null and manual_override_at is not null)),
  constraint txn_duplicate_has_original check (
    not duplicate_flag or duplicate_of_transaction_id is not null),
  constraint txn_not_own_duplicate check (duplicate_of_transaction_id <> id),
  constraint txn_not_own_pair check (paired_with_id <> id),
  constraint txn_not_own_settlement check (settlement_of_transaction_id <> id),
  constraint txn_cleared_dated check (not cleared or cleared_date is not null),
  constraint txn_stale_dated check (not stale_flagged or stale_flagged_on is not null),
  constraint txn_escheat_needs_stale check (not escheat_review or stale_flagged),
  constraint txn_normalization_versioned check (
    vendor_normalized is null or vendor_normalization_version is not null),
  constraint txn_posted_complete check (
    journal_entry_id is null or posted_at is not null),
  constraint txn_reversal_complete check (
    status <> 'reversed' or (reversed_by_run_id is not null and reversed_at is not null)),
  constraint txn_import_provenance check (
    source <> 'import' or (import_batch_id is not null and staged_row_id is not null)),
  unique (client_id, id),
  foreign key (client_id, bank_account_id)
    references ledger.bank_accounts (client_id, id),
  foreign key (client_id, account_number)
    references ledger.accounts (client_id, account_number),
  foreign key (client_id, category_id)
    references ledger.categories (client_id, id)
);

-- Doc 05 Part 3. The bank supplied id is the dedup key. The grain is the bank
-- account rather than the chart account number, because two feeds can post to
-- the same four digit cash account and a bank id is only unique inside the
-- account that issued it.
create unique index txn_bank_id_unique
  on ledger.transactions (client_id, bank_account_id, bank_transaction_id)
  where bank_transaction_id is not null;

-- The working set of every coding run: uncoded, not overridden, in date order.
create index txn_uncoded
  on ledger.transactions (client_id, posted_date, id)
  where category_id is null and manual_override = false and status = 'active';

-- TXN-NORMALIZE-VENDORS, TXN-APPLY-RULES, TXN-APPLY-VENDORDEFAULTS, and the
-- recurring template match all probe by normalized vendor.
create index txn_vendor_normalized
  on ledger.transactions (client_id, vendor_normalized)
  where vendor_normalized is not null;

-- TXN-DETECT-DUPLICATES: same client, same account, same absolute amount, same
-- normalized vendor, dates within 3 days.
create index txn_duplicate_probe
  on ledger.transactions (client_id, bank_account_id, abs(amount_cents), posted_date);

-- TXN-PAIR-TRANSFERS: equal absolute amount, opposite sign, within 3 days, and
-- neither side already paired.
create index txn_unpaired
  on ledger.transactions (client_id, abs(amount_cents), posted_date)
  where paired_with_id is null and status = 'active';

-- REC-MATCH-TIERED and REC-FLAG-STALE walk the uncleared book side per account.
create index txn_uncleared
  on ledger.transactions (client_id, bank_account_id, posted_date)
  where cleared = false and status = 'active';
create index txn_check_number
  on ledger.transactions (client_id, bank_account_id, check_number)
  where check_number is not null;

-- TXN-SWEEP-SUSPENSE and the escalation runs walk open suspense.
create index txn_suspense_open
  on ledger.transactions (client_id, suspense_reason, suspense_escalates_on)
  where suspense_reason is not null;

-- Batch reversal as a unit, and rule attribution for the rule hit report.
create index txn_by_batch
  on ledger.transactions (import_batch_id)
  where import_batch_id is not null;
create index txn_by_rule
  on ledger.transactions (client_id, rule_id)
  where rule_id is not null;
create index txn_by_entry
  on ledger.transactions (journal_entry_id)
  where journal_entry_id is not null;
create index on ledger.transactions (client_id, posted_date desc);
create index on ledger.transactions (firm_id);

-- ---------------------------------------------------------------------------
-- Row level security. Enabled and forced, same shape as every other tenant
-- table, so a superuser owned connection cannot read around the policy either.
-- ---------------------------------------------------------------------------

alter table ledger.bank_accounts enable row level security;
alter table ledger.bank_accounts force row level security;
alter table ledger.transactions enable row level security;
alter table ledger.transactions force row level security;

create policy client_isolation on ledger.bank_accounts
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on ledger.transactions
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on ledger.bank_accounts
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on ledger.transactions
  for each row execute function tenancy.freeze_discriminators();

-- Doc 00 Part 7 and doc 03 Part 6. A row carrying the override flag is
-- invisible to every run except as a skip, and the database refuses the write
-- rather than trusting the application to remember.
create trigger trg_guard_manual_override before update on ledger.transactions
  for each row execute function ledger.guard_manual_override();

-- ---------------------------------------------------------------------------
-- Doc 06 C9, second half. Every transaction id column written before the
-- register existed now points at it.
-- ---------------------------------------------------------------------------

alter table ledger.journal_entries
  add constraint je_source_transaction_fk
  foreign key (source_transaction_id) references ledger.transactions(id);

alter table ledger.journal_lines
  add constraint jl_source_transaction_fk
  foreign key (source_transaction_id) references ledger.transactions(id);

alter table subledger.fixed_assets
  add constraint fa_source_transaction_fk
  foreign key (source_transaction_id) references ledger.transactions(id);

alter table subledger.deferral_schedules
  add constraint defer_source_transaction_fk
  foreign key (source_transaction_id) references ledger.transactions(id);

alter table subledger.loan_schedule
  add constraint loan_matched_transaction_fk
  foreign key (matched_transaction_id) references ledger.transactions(id);

alter table vault.documents
  add constraint doc_linked_transaction_fk
  foreign key (linked_transaction_id) references ledger.transactions(id);

alter table import.staged_rows
  add constraint staged_duplicate_transaction_fk
  foreign key (duplicate_of_transaction_id) references ledger.transactions(id);

alter table import.staged_rows
  add constraint staged_committed_transaction_fk
  foreign key (committed_transaction_id) references ledger.transactions(id);

-- Migration 0009 could only name the four digit chart account, because the bank
-- and card account table did not exist yet. A feed belongs to one funding
-- source, and two sources can post to the same chart account, so the batch and
-- its staged rows carry the funding source now that there is one to carry.
alter table import.batches
  add column bank_account_id char(26) references ledger.bank_accounts(id);

alter table import.staged_rows
  add column bank_account_id char(26) references ledger.bank_accounts(id);

create index on import.staged_rows (bank_account_id) where bank_account_id is not null;

commit;
