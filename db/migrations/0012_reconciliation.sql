-- 0012_reconciliation.sql
-- Doc 02 module 3. The reconciliation working set.
--
-- Migration 0011 gave the register the book side of reconciliation: cleared,
-- cleared_date, instrument_type, stale_flagged, escheat_review, and the per
-- account amount tolerance tier 3 reads. It gave the bank side nothing. There
-- is no statement, no statement line, no batch to hang a difference on, and no
-- place to record which tier decided a match. So REC-MATCH-TIERED had nothing
-- to match against, REC-CLEAR-MATCHED had nowhere to store the difference gate
-- G03 tests, and REC-FLAG-STALE had no owner or escalation column of its own.
--
-- This migration adds three things:
--   1. ledger.rec_batches, one row per account per statement period, carrying
--      the statement balance, the cleared ledger balance, the difference, who
--      opened it, and when it closed.
--   2. ledger.statement_lines, the bank side of the match. A statement arrives
--      as CSV or OFX and lands here with its statement id and statement date
--      already stamped by the import.
--   3. The match columns on ledger.transactions: which statement, which line,
--      which tier, what confidence, and which batch.
--
-- Doc 00 Part 1: money is bigint integer cents, debit positive, credit
-- negative. Doc 00 Part 7 and doc 03 Part 6: a value a person set carries the
-- override flag and no run may write over it. None of the columns added here
-- are coding columns, which is the whole reason a row carrying the override
-- flag can still be matched and still be cleared. Clearing a flag is not
-- coding. The guard trigger from 0011 stays exactly as it is.
--
-- Forward only. No down migration.

begin;

-- ---------------------------------------------------------------------------
-- Reconciliation batches.
--
-- One row per bank or card account per statement period. REC-MATCH-TIERED
-- opens it, REC-CLEAR-MATCHED closes it with the difference on it. The balance
-- columns carry the _cents suffix the rest of the schema uses, because a
-- column named statement_balance with a bigint of cents in it is exactly how a
-- report ends up dividing by 100 twice.
-- ---------------------------------------------------------------------------

create table ledger.rec_batches (
  id             char(26) primary key,        -- ULID, derived from the statement id
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  bank_account_id char(26) not null references ledger.bank_accounts(id),
  statement_id   char(26) not null,
  statement_period text not null,             -- 'YYYY-MM', the period the statement covers
  period_start   date not null,
  period_end     date not null,

  -- What the bank says the account held at the close of the period.
  statement_balance_cents bigint not null,
  -- The sum of every cleared register row on the account through period end.
  -- Null until REC-CLEAR-MATCHED has run.
  cleared_ledger_balance_cents bigint,
  -- statement_balance_cents minus cleared_ledger_balance_cents. Gate G03 needs
  -- this at exactly zero, so there is no tolerance column here on purpose.
  diff_cents     bigint,

  state          text not null default 'open',
  opened_by      uuid not null,               -- the person or schedule behind the run
  opened_at      timestamptz not null,
  opened_by_run_id char(26),
  closed_at      timestamptz,
  closed_by_run_id char(26),

  version        integer not null default 1,
  created_at     timestamptz not null default now(),

  constraint rec_state check (state in ('open','reconciled','out_of_balance')),
  constraint rec_period check (period_end >= period_start),
  -- A reconciled batch is one whose difference is exactly zero. Any other
  -- difference is out of balance, including one cent.
  constraint rec_reconciled_is_zero check (
    state <> 'reconciled' or diff_cents = 0),
  constraint rec_closed_has_diff check (
    closed_at is null or (diff_cents is not null and cleared_ledger_balance_cents is not null)),
  unique (client_id, bank_account_id, statement_id)
);

create index on ledger.rec_batches (client_id, bank_account_id, period_end desc);
create index on ledger.rec_batches (client_id, state) where state = 'open';
create index on ledger.rec_batches (firm_id);

-- ---------------------------------------------------------------------------
-- Statement lines. The bank side of the match.
--
-- A statement line is not a register row and never becomes one. The register
-- is what the books say happened, the statement is what the bank says
-- happened, and reconciliation is the question of whether those two agree.
-- Collapsing them into one table would make that question unaskable.
-- ---------------------------------------------------------------------------

create table ledger.statement_lines (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  bank_account_id char(26) not null references ledger.bank_accounts(id),
  statement_id   char(26) not null,
  -- The date the bank put on the line. This is the date that governs clearing,
  -- not the book date, because the bank determines when money moved.
  statement_date date not null,

  amount_cents   bigint not null,             -- signed, same convention as the register
  currency       char(3) not null default 'USD',
  description    text not null,
  normalized_vendor text,                     -- tier 3 reads this, never the raw descriptor
  check_number   text,
  source_format  text not null default 'csv',

  -- The match, written by REC-MATCH-TIERED --------------------------------
  rec_batch_id   char(26) references ledger.rec_batches(id),
  match_tier     smallint,
  match_confidence smallint,
  -- The exact cent difference a tier 3 match absorbed. Zero at tiers 1, 2, 4.
  match_diff_cents bigint,
  -- Tier 1 is exact identity and is confirmed on write. Tiers 2, 3, and 4 are
  -- proposals a person accepts on /reconcile, which is what doc 02 means by a
  -- link requiring operator acceptance.
  match_confirmed boolean not null default false,
  matched_transaction_id char(26) references ledger.transactions(id),
  -- Tier 4 matches one deposit against several book rows, so the count is
  -- carried and matched_transaction_id stays null for a group.
  matched_transaction_count integer not null default 0,
  matched_by_run_id char(26),

  version        integer not null default 1,
  created_at     timestamptz not null default now(),

  constraint stmt_amount_nonzero check (amount_cents <> 0),
  constraint stmt_currency check (currency = 'USD'),
  constraint stmt_format check (source_format in ('csv','ofx','qfx','qbo','xlsx')),
  constraint stmt_tier_range check (match_tier is null or match_tier between 1 and 4),
  -- Confidence is a rendering of the tier and nothing else. It is not a score,
  -- not a percentage, and not a probability, which is why the allowed values
  -- are the four constants and not a range.
  constraint stmt_confidence_values check (
    match_confidence is null or match_confidence in (70, 80, 90, 100)),
  constraint stmt_confidence_needs_tier check (
    (match_tier is null) = (match_confidence is null)),
  constraint stmt_match_shape check (
    match_tier is null
    or (match_tier = 4 and matched_transaction_id is null and matched_transaction_count >= 2)
    or (match_tier < 4 and matched_transaction_id is not null and matched_transaction_count = 1)),
  constraint stmt_confirmed_needs_match check (
    match_confirmed = false or match_tier is not null),
  unique (client_id, bank_account_id, statement_id, id)
);

create index on ledger.statement_lines (client_id, statement_id, statement_date);
create index stmt_unmatched
  on ledger.statement_lines (client_id, bank_account_id, statement_date)
  where match_tier is null;
create index on ledger.statement_lines (matched_transaction_id)
  where matched_transaction_id is not null;
create index on ledger.statement_lines (firm_id);

-- ---------------------------------------------------------------------------
-- The match columns on the register.
--
-- cleared and cleared_date already exist from 0011 and are not duplicated
-- here. cleared is the cleared flag doc 02 asks for, and a second boolean
-- holding the same fact is two sources of truth for one question.
-- ---------------------------------------------------------------------------

alter table ledger.transactions
  add column statement_id char(26),
  add column statement_line_id char(26) references ledger.statement_lines(id),
  add column statement_date date,
  add column match_tier smallint,
  add column match_confidence smallint,
  add column rec_batch_id char(26) references ledger.rec_batches(id),
  -- REC-FLAG-STALE assigns an owner and a follow up date. These are stale
  -- columns, not suspense columns, so flagging a stale item never touches the
  -- coding a person may have set by hand.
  add column stale_owner text,
  add column stale_escalates_on date;

alter table ledger.transactions
  add constraint txn_match_tier_range
    check (match_tier is null or match_tier between 1 and 4),
  add constraint txn_match_confidence_values
    check (match_confidence is null or match_confidence in (70, 80, 90, 100)),
  add constraint txn_match_needs_line
    check (match_tier is null or statement_line_id is not null),
  add constraint txn_match_dated
    check (match_tier is null or statement_date is not null),
  add constraint txn_stale_owner_values
    check (stale_owner is null or stale_owner in ('firm','client','system')),
  add constraint txn_stale_owner_needs_flag
    check (stale_owner is null or stale_flagged = true);

-- The index the brief asks for by name. Every reconciliation read starts from
-- the batch, so the batch pointer is the one that has to be indexed.
create index rec_batches_id
  on ledger.transactions (rec_batch_id)
  where rec_batch_id is not null;

create index txn_by_statement_line
  on ledger.transactions (statement_line_id)
  where statement_line_id is not null;

create index txn_outstanding
  on ledger.transactions (client_id, bank_account_id, posted_date)
  where cleared = false and status = 'active';

-- ---------------------------------------------------------------------------
-- Row level security, same shape as every other tenant table.
-- ---------------------------------------------------------------------------

alter table ledger.rec_batches enable row level security;
alter table ledger.rec_batches force row level security;
alter table ledger.statement_lines enable row level security;
alter table ledger.statement_lines force row level security;

create policy client_isolation on ledger.rec_batches
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on ledger.statement_lines
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on ledger.rec_batches
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on ledger.statement_lines
  for each row execute function tenancy.freeze_discriminators();

commit;
