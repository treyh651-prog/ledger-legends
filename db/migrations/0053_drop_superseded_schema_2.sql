-- 0053_drop_superseded_schema_2.sql
--
-- Continuing the cleanup migration 0052 started: more orphan-column hits
-- turned out to be dead schema superseded by a later migration, not missing
-- wiring. Confirmed against the live DB before writing this: both targets
-- are empty.

begin;

-- 1. subledger.fixed_assets.ddb_factor: migration 0013 added ddb_factor_bps,
--    backfilled it from this column, and swapped the check constraint over to
--    fa_ddb_factor_bps -- but never dropped the old column or its own
--    fa_ddb_factor constraint. depreciation-shared.ts has used only
--    ddbFactorBps ever since; ddb_factor has zero references anywhere in
--    server/.
alter table subledger.fixed_assets drop constraint fa_ddb_factor;
alter table subledger.fixed_assets drop column ddb_factor;

-- 2. ledger.transactions.amortization_schedule_id: added by migration 0013
--    to "trace a register row back to the prepaid it belongs to," but
--    subledger.deferral_schedules.source_transaction_id already provided
--    that exact linkage, in the reverse direction, six migrations earlier
--    (migration 0005). Loans use a separate reverse-direction link
--    (loan_schedule.matched_transaction_id). Never referenced anywhere in
--    server/; its partial index is dropped automatically with the column.
alter table ledger.transactions drop column amortization_schedule_id;

commit;
