-- 0035_run_log_items_target_id_nullable.sql
--
-- server/runs/contract.ts declares RunError.rowId as `Ulid | null`, commented
-- "null for run level errors": a failure that is about the run as a whole,
-- not about one particular row, has no row to name. server/runs/run-log.ts
-- writes that value straight into target_id on the item it logs. The column
-- was declared not null in migration 0003, so the first run level error or
-- run level skip logged against real Postgres fails on the log write itself,
-- which is worse than the failure it was trying to record: the operator sees
-- a database error instead of the reason the run refused.
--
-- No other constraint or index on this table depends on target_id being
-- present (see the create table in migration 0003); dropping not null is the
-- whole fix. Postgres propagates this to every monthly partition of
-- ledger.run_log_items automatically.

begin;

alter table ledger.run_log_items alter column target_id drop not null;

commit;
