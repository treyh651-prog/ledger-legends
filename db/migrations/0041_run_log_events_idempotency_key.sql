-- 0041_run_log_events_idempotency_key.sql
--
-- The real fix for the dead idempotency guarantee. Migration 0003 put a
-- partial unique index on run_log (idempotency_key) where mode = 'apply'
-- and status in ('completed', 'completed_with_skips', 'no_op'). That index
-- has never matched a single row: run_log.status is always 'started', by
-- design (doc 03 Part 9, trg_run_log_insert_only) -- every real status
-- transition is an appended run_log_events row instead. The application
-- layer (db-postgres.ts applied_run_by_idempotency_key) already works
-- around this correctly, but the invariant deserves a real constraint, not
-- just application code that has to get it right every time.
--
-- The fix: denormalize idempotency_key onto run_log_events, populate it
-- only on the terminal event of an apply execution that actually completed,
-- and put the partial unique index there instead, where status transitions
-- actually live. run_log_events is not partitioned, so this is one ordinary
-- partial unique index, not the per-partition dance 0003 needed.
--
-- The old per-partition indexes on run_log are dropped: they have never
-- fired, never will (status can't change after insert), and documented a
-- guarantee the schema didn't actually provide. The column and the rest of
-- run_log's shape are untouched.
--
-- Forward only. No down migration.

begin;

alter table ledger.run_log_events
  add column idempotency_key text;

-- Backfill: every existing completed/completed_with_skips/no_op apply
-- execution gets its key copied onto its own terminal event row. The no
-- update rule below (migration 0003) would otherwise turn this into a
-- silent no-op, so it is dropped and recreated around the backfill, inside
-- this same transaction -- the insert-only guarantee is never actually
-- open to anything outside this migration.
drop rule run_log_events_no_update on ledger.run_log_events;

update ledger.run_log_events e
set idempotency_key = r.idempotency_key
from ledger.run_log r
where r.id = e.run_id
  and r.mode = 'apply'
  and e.event in ('completed', 'completed_with_skips', 'no_op');

create rule run_log_events_no_update as on update to ledger.run_log_events do instead nothing;

create unique index run_log_events_idem
  on ledger.run_log_events (idempotency_key)
  where idempotency_key is not null;

-- Drop the dead per-partition indexes from migration 0003. They were never
-- reachable (run_log.status is always 'started') and are superseded by
-- run_log_events_idem above.
do $$
declare p text;
begin
  foreach p in array array[
    'run_log_2026_09','run_log_2026_10','run_log_2026_11','run_log_2026_12',
    'run_log_2027_01','run_log_2027_02','run_log_2027_03','run_log_2027_04',
    'run_log_2027_05','run_log_2027_06','run_log_2027_07','run_log_2027_08']
  loop
    execute format('drop index if exists ledger.%I', p || '_idem');
  end loop;
end
$$;

commit;
