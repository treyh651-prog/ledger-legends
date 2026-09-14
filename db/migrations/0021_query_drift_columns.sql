-- 0021_query_drift_columns.sql
-- The columns the run port reads and writes that no earlier migration created.
--
-- Migration 0019 created the tables a run can address and 0020 sized the run id
-- columns. Neither asked the narrower question this file answers: for every
-- named query in `server/runs/db-postgres.ts`, does every identifier it selects
-- or filters on exist. Resolving all 98 queries against
-- `information_schema.columns` found 49 table and column pairs that did not.
--
-- Most of those were a name disagreement over a column that is already there,
-- and those are fixed in the port, because a rename in the database is a second
-- thing to keep in step and the schema is the side that is applied, verified and
-- described in the README. This file holds only the remainder, where the run
-- framework has a field it must persist and the table has nowhere to put it.
-- Each group says why the column is the schema's job and not the query's.
--
-- Every table altered here is empty, so the not null columns take a default and
-- no backfill is needed.
--
-- Forward only. No down migration.

begin;

-- ---------------------------------------------------------------------------
-- 1. Run log items. The proposal itself.
--
-- Doc 04 Part 8 gave the item row `before_values` and `after_values`, which
-- describe the row as it was and as it became. A preview run produces neither,
-- because nothing is written, and what it has to record is the proposal it
-- would have applied. `run-log.ts` has written `proposalJson` since the first
-- version of the framework and the tests assert on it, so the column is the
-- missing half of the preview audit trail rather than a duplicate of the after
-- image.
-- ---------------------------------------------------------------------------

alter table ledger.run_log_items
  add column proposal_json jsonb;

-- ---------------------------------------------------------------------------
-- 2. Run log events. The counts a terminal event carries.
--
-- Doc 04 Part 8 put the run counts on `run_log` and left the event table as an
-- id, an event name and a jsonb detail. That holds the final state of a run and
-- loses the state at each event, which is the one thing an insert only event
-- table exists to keep: a retried run emits two terminal events and the counts
-- differ between them. Reading them back out of `detail` would make every
-- consumer parse json for values the framework already has as scalars, and
-- would put the same defect one layer down where no catalog check can see it.
-- ---------------------------------------------------------------------------

alter table ledger.run_log_events
  add column attempt          integer not null default 1,
  add column proposal_count   integer not null default 0,
  add column skip_count       integer not null default 0,
  add column error_count      integer not null default 0,
  add column net_cents        bigint  not null default 0,
  add column entries_created  integer not null default 0,
  add column entries_reversed integer not null default 0,
  add column skip_counts_by_reason jsonb not null default '{}',
  add column duration_ms      integer not null default 0,
  -- The run an undo points back at, and the run a retry replaced. Text rather
  -- than char for the reason migration 0020 gives: a run execution id is 31
  -- characters and the widths are not the schema's business to guess.
  add column related_run_id   text;

alter table ledger.run_log_events
  add constraint run_log_event_related_run_id_len
  check (related_run_id is null or length(related_run_id) <= 33);

-- ---------------------------------------------------------------------------
-- 3. Journal entries. Provenance that is not a transaction or a document.
--
-- 0002 modeled provenance as `source_transaction_id` and `source_document_id`,
-- which covers the two sources that existed then. A depreciation entry comes
-- from a schedule line, an accrual from a template, a loan split from an
-- amortization row, and none of those are a transaction or a document. The
-- framework records the source as a table name, a row id and the version of
-- that row it read, which is what makes an entry reproducible and what the undo
-- run matches on.
--
-- `run_type` and `run_version` are denormalized from `run_log` on purpose. An
-- entry outlives the monthly run log partition it was written under, and the
-- question "which run type produced this" has to survive the detach.
--
-- `redated_from_locked_period` carries the date the entry would have had if the
-- period had been open, which is the evidence a reviewer needs and the only
-- record that the redating happened at all.
-- ---------------------------------------------------------------------------

alter table ledger.journal_entries
  add column redated_from_locked_period date,
  add column source_table  text,
  add column source_row_id char(26),
  add column source_version integer,
  add column run_type      text,
  add column run_version   integer;

-- ---------------------------------------------------------------------------
-- 4. Journal lines. The entry date and the net asset restriction.
--
-- `entry_date` is a copy of the value on the parent entry. It is here because
-- every report that groups lines by period would otherwise join to the entry
-- table for one date column, and because the line is the grain the run port
-- writes. The balanced entry trigger already keeps lines and their entry in
-- step, so the copy cannot drift without the trigger firing.
--
-- `restriction` is the net asset class a nonprofit line carries. 0015 named the
-- two restriction accounts on the close side and never gave the line the class
-- that selects between them.
-- ---------------------------------------------------------------------------

alter table ledger.journal_lines
  add column entry_date  date,
  add column restriction text;

alter table ledger.journal_lines
  add constraint jl_restriction check (
    restriction is null
    or restriction in ('with_donor_restrictions','without_donor_restrictions'));

-- ---------------------------------------------------------------------------
-- 5. Transactions. The feed side account identifier.
--
-- 0011 put `institution_id` on `bank_accounts`, which is right for an account
-- that keeps one identifier for its life. A register row also carries the
-- identifier the feed sent with it, and the two differ exactly when the feed
-- changes an identifier, which is the case reconciliation has to see rather
-- than have silently corrected by a join.
-- ---------------------------------------------------------------------------

alter table ledger.transactions
  add column institution_id text;

-- ---------------------------------------------------------------------------
-- 6. Rules. Promotion state.
--
-- 0004 gave a rule a hit count. Promotion needs to know how many of those hits
-- a person accepted and how many they rejected, because the ratio is what makes
-- a rule eligible, and it needs to record that auto posting was switched on,
-- who switched it on, and the amount above which it still stops for review.
-- `hit_count` cannot answer any of those.
-- ---------------------------------------------------------------------------

alter table ledger.rules
  add column accepted_count integer not null default 0,
  add column rejected_count integer not null default 0,
  add column auto_post_enabled boolean not null default false,
  add column auto_post_enabled_by uuid,
  add column auto_post_ceiling_cents bigint;

alter table ledger.rules
  add constraint rules_promotion_counts check (
    accepted_count >= 0 and rejected_count >= 0),
  add constraint rules_auto_post_attributed check (
    auto_post_enabled = false or auto_post_enabled_by is not null);

-- ---------------------------------------------------------------------------
-- 7. Recurring templates. The amount window and the account.
--
-- 0005 modeled a template that matches one exact amount. Doc 02 module 4 also
-- allows a template whose amount varies inside a floor and a ceiling, and a day
-- window around the expected day, and both are how a utility bill is matched.
-- `bank_account_id` is which funding source the template expects the charge on,
-- without which a template matches the same bill twice across two accounts.
-- ---------------------------------------------------------------------------

alter table subledger.recurring_templates
  add column bank_account_id char(26),
  add column amount_mode text not null default 'fixed_amount',
  add column amount_floor_cents bigint,
  add column amount_ceiling_cents bigint,
  add column day_window integer;

alter table subledger.recurring_templates
  add constraint rt_amount_mode check (
    amount_mode in ('fixed_amount','variable_amount')),
  add constraint rt_amount_window check (
    amount_floor_cents is null or amount_ceiling_cents is null
    or amount_floor_cents <= amount_ceiling_cents),
  add constraint rt_day_window check (day_window is null or day_window between 0 and 15);

-- ---------------------------------------------------------------------------
-- 8. Vendors. The version of the default category.
--
-- A category is versioned and the vendor default has to name which version it
-- pinned, for the same reason a coded transaction records `category_version`.
-- Without it a category edit silently rewrites what every past coding meant.
-- ---------------------------------------------------------------------------

alter table subledger.vendors
  add column default_category_version integer;

-- ---------------------------------------------------------------------------
-- 9. Loans. The escrow account.
--
-- 0005 gave a loan a funding, interest and two principal accounts. A mortgage
-- payment also splits into escrow, and the loan schedule already carries
-- `escrow_cents`, so the amount had a column and the account it posts to did
-- not.
-- ---------------------------------------------------------------------------

alter table subledger.loans
  add column escrow_account char(4);

-- ---------------------------------------------------------------------------
-- 10. Import batches and staged rows. Optimistic concurrency.
--
-- Every other table a run updates carries `version`, and the port's update path
-- reads it. 0009 left it off these two, which makes the import pipeline the one
-- place where two concurrent runs can overwrite each other unnoticed.
-- ---------------------------------------------------------------------------

alter table import.batches
  add column version integer not null default 1;

alter table import.staged_rows
  add column version integer not null default 1;

commit;
