-- 0069_run_log_partition_extension.sql
--
-- Earlier security/setup audit (a separate, earlier audit from the ten
-- action-audit problems, see the plan file's "Earlier audit findings,
-- still open" section): migration 0003 only created monthly partitions
-- for ledger.run_log and ledger.run_log_items through August 2027. A
-- partitioned table refuses an insert whose partition key falls outside
-- every partition that exists -- confirmed by reading 0003 directly,
-- there is no default partition and nothing in the codebase ever created
-- a later one. Every run posts to run_log, so this was a hard stop on
-- the whole application starting 2027-09-01, not a degraded mode.
--
-- 0003's own comment named the intended fix: "A scheduled job creates
-- the next month well ahead of the boundary." That job was never built.
-- Every other schema change in this codebase is applied by a person
-- through the Supabase SQL editor (doc 04 Part 13, this migration
-- included) -- building an automated task that runs DDL from the
-- running application would be a real architectural departure from that,
-- not a a mechanical fix, so it is not done here. This migration instead
-- extends the horizon by more than five years, the same hardcoded-list
-- shape 0003 itself used, which turns a hard production stop into a
-- maintenance task with a long lead time. Whoever next revisits the
-- scheduler should decide, deliberately, whether a recurring job is
-- worth building before this list runs out again.
--
-- Forward only. No down migration.

begin;

create table ledger.run_log_2027_09 partition of ledger.run_log
  for values from ('2027-09-01') to ('2027-10-01');
create table ledger.run_log_2027_10 partition of ledger.run_log
  for values from ('2027-10-01') to ('2027-11-01');
create table ledger.run_log_2027_11 partition of ledger.run_log
  for values from ('2027-11-01') to ('2027-12-01');
create table ledger.run_log_2027_12 partition of ledger.run_log
  for values from ('2027-12-01') to ('2028-01-01');
create table ledger.run_log_2028_01 partition of ledger.run_log
  for values from ('2028-01-01') to ('2028-02-01');
create table ledger.run_log_2028_02 partition of ledger.run_log
  for values from ('2028-02-01') to ('2028-03-01');
create table ledger.run_log_2028_03 partition of ledger.run_log
  for values from ('2028-03-01') to ('2028-04-01');
create table ledger.run_log_2028_04 partition of ledger.run_log
  for values from ('2028-04-01') to ('2028-05-01');
create table ledger.run_log_2028_05 partition of ledger.run_log
  for values from ('2028-05-01') to ('2028-06-01');
create table ledger.run_log_2028_06 partition of ledger.run_log
  for values from ('2028-06-01') to ('2028-07-01');
create table ledger.run_log_2028_07 partition of ledger.run_log
  for values from ('2028-07-01') to ('2028-08-01');
create table ledger.run_log_2028_08 partition of ledger.run_log
  for values from ('2028-08-01') to ('2028-09-01');
create table ledger.run_log_2028_09 partition of ledger.run_log
  for values from ('2028-09-01') to ('2028-10-01');
create table ledger.run_log_2028_10 partition of ledger.run_log
  for values from ('2028-10-01') to ('2028-11-01');
create table ledger.run_log_2028_11 partition of ledger.run_log
  for values from ('2028-11-01') to ('2028-12-01');
create table ledger.run_log_2028_12 partition of ledger.run_log
  for values from ('2028-12-01') to ('2029-01-01');
create table ledger.run_log_2029_01 partition of ledger.run_log
  for values from ('2029-01-01') to ('2029-02-01');
create table ledger.run_log_2029_02 partition of ledger.run_log
  for values from ('2029-02-01') to ('2029-03-01');
create table ledger.run_log_2029_03 partition of ledger.run_log
  for values from ('2029-03-01') to ('2029-04-01');
create table ledger.run_log_2029_04 partition of ledger.run_log
  for values from ('2029-04-01') to ('2029-05-01');
create table ledger.run_log_2029_05 partition of ledger.run_log
  for values from ('2029-05-01') to ('2029-06-01');
create table ledger.run_log_2029_06 partition of ledger.run_log
  for values from ('2029-06-01') to ('2029-07-01');
create table ledger.run_log_2029_07 partition of ledger.run_log
  for values from ('2029-07-01') to ('2029-08-01');
create table ledger.run_log_2029_08 partition of ledger.run_log
  for values from ('2029-08-01') to ('2029-09-01');
create table ledger.run_log_2029_09 partition of ledger.run_log
  for values from ('2029-09-01') to ('2029-10-01');
create table ledger.run_log_2029_10 partition of ledger.run_log
  for values from ('2029-10-01') to ('2029-11-01');
create table ledger.run_log_2029_11 partition of ledger.run_log
  for values from ('2029-11-01') to ('2029-12-01');
create table ledger.run_log_2029_12 partition of ledger.run_log
  for values from ('2029-12-01') to ('2030-01-01');
create table ledger.run_log_2030_01 partition of ledger.run_log
  for values from ('2030-01-01') to ('2030-02-01');
create table ledger.run_log_2030_02 partition of ledger.run_log
  for values from ('2030-02-01') to ('2030-03-01');
create table ledger.run_log_2030_03 partition of ledger.run_log
  for values from ('2030-03-01') to ('2030-04-01');
create table ledger.run_log_2030_04 partition of ledger.run_log
  for values from ('2030-04-01') to ('2030-05-01');
create table ledger.run_log_2030_05 partition of ledger.run_log
  for values from ('2030-05-01') to ('2030-06-01');
create table ledger.run_log_2030_06 partition of ledger.run_log
  for values from ('2030-06-01') to ('2030-07-01');
create table ledger.run_log_2030_07 partition of ledger.run_log
  for values from ('2030-07-01') to ('2030-08-01');
create table ledger.run_log_2030_08 partition of ledger.run_log
  for values from ('2030-08-01') to ('2030-09-01');
create table ledger.run_log_2030_09 partition of ledger.run_log
  for values from ('2030-09-01') to ('2030-10-01');
create table ledger.run_log_2030_10 partition of ledger.run_log
  for values from ('2030-10-01') to ('2030-11-01');
create table ledger.run_log_2030_11 partition of ledger.run_log
  for values from ('2030-11-01') to ('2030-12-01');
create table ledger.run_log_2030_12 partition of ledger.run_log
  for values from ('2030-12-01') to ('2031-01-01');
create table ledger.run_log_2031_01 partition of ledger.run_log
  for values from ('2031-01-01') to ('2031-02-01');
create table ledger.run_log_2031_02 partition of ledger.run_log
  for values from ('2031-02-01') to ('2031-03-01');
create table ledger.run_log_2031_03 partition of ledger.run_log
  for values from ('2031-03-01') to ('2031-04-01');
create table ledger.run_log_2031_04 partition of ledger.run_log
  for values from ('2031-04-01') to ('2031-05-01');
create table ledger.run_log_2031_05 partition of ledger.run_log
  for values from ('2031-05-01') to ('2031-06-01');
create table ledger.run_log_2031_06 partition of ledger.run_log
  for values from ('2031-06-01') to ('2031-07-01');
create table ledger.run_log_2031_07 partition of ledger.run_log
  for values from ('2031-07-01') to ('2031-08-01');
create table ledger.run_log_2031_08 partition of ledger.run_log
  for values from ('2031-08-01') to ('2031-09-01');
create table ledger.run_log_2031_09 partition of ledger.run_log
  for values from ('2031-09-01') to ('2031-10-01');
create table ledger.run_log_2031_10 partition of ledger.run_log
  for values from ('2031-10-01') to ('2031-11-01');
create table ledger.run_log_2031_11 partition of ledger.run_log
  for values from ('2031-11-01') to ('2031-12-01');
create table ledger.run_log_2031_12 partition of ledger.run_log
  for values from ('2031-12-01') to ('2032-01-01');
create table ledger.run_log_2032_01 partition of ledger.run_log
  for values from ('2032-01-01') to ('2032-02-01');
create table ledger.run_log_2032_02 partition of ledger.run_log
  for values from ('2032-02-01') to ('2032-03-01');
create table ledger.run_log_2032_03 partition of ledger.run_log
  for values from ('2032-03-01') to ('2032-04-01');

-- Each new partition needs its own copy of 0003's idempotency index, the
-- same loop 0003 itself used -- a partitioned table cannot carry a unique
-- index with a where clause, so it lives on each partition instead.
do $$
declare p text;
begin
  foreach p in array array[
    'run_log_2027_09','run_log_2027_10','run_log_2027_11','run_log_2027_12',
    'run_log_2028_01','run_log_2028_02','run_log_2028_03','run_log_2028_04',
    'run_log_2028_05','run_log_2028_06','run_log_2028_07','run_log_2028_08',
    'run_log_2028_09','run_log_2028_10','run_log_2028_11','run_log_2028_12',
    'run_log_2029_01','run_log_2029_02','run_log_2029_03','run_log_2029_04',
    'run_log_2029_05','run_log_2029_06','run_log_2029_07','run_log_2029_08',
    'run_log_2029_09','run_log_2029_10','run_log_2029_11','run_log_2029_12',
    'run_log_2030_01','run_log_2030_02','run_log_2030_03','run_log_2030_04',
    'run_log_2030_05','run_log_2030_06','run_log_2030_07','run_log_2030_08',
    'run_log_2030_09','run_log_2030_10','run_log_2030_11','run_log_2030_12',
    'run_log_2031_01','run_log_2031_02','run_log_2031_03','run_log_2031_04',
    'run_log_2031_05','run_log_2031_06','run_log_2031_07','run_log_2031_08',
    'run_log_2031_09','run_log_2031_10','run_log_2031_11','run_log_2031_12',
    'run_log_2032_01','run_log_2032_02','run_log_2032_03']
  loop
    execute format(
      'create unique index %I on ledger.%I (idempotency_key)
         where mode = ''apply'' and status in (''completed'',''completed_with_skips'',''no_op'')',
      p || '_idem', p);
  end loop;
end
$$;

create table ledger.run_log_items_2027_09 partition of ledger.run_log_items
  for values from ('2027-09-01') to ('2027-10-01');
create table ledger.run_log_items_2027_10 partition of ledger.run_log_items
  for values from ('2027-10-01') to ('2027-11-01');
create table ledger.run_log_items_2027_11 partition of ledger.run_log_items
  for values from ('2027-11-01') to ('2027-12-01');
create table ledger.run_log_items_2027_12 partition of ledger.run_log_items
  for values from ('2027-12-01') to ('2028-01-01');
create table ledger.run_log_items_2028_01 partition of ledger.run_log_items
  for values from ('2028-01-01') to ('2028-02-01');
create table ledger.run_log_items_2028_02 partition of ledger.run_log_items
  for values from ('2028-02-01') to ('2028-03-01');
create table ledger.run_log_items_2028_03 partition of ledger.run_log_items
  for values from ('2028-03-01') to ('2028-04-01');
create table ledger.run_log_items_2028_04 partition of ledger.run_log_items
  for values from ('2028-04-01') to ('2028-05-01');
create table ledger.run_log_items_2028_05 partition of ledger.run_log_items
  for values from ('2028-05-01') to ('2028-06-01');
create table ledger.run_log_items_2028_06 partition of ledger.run_log_items
  for values from ('2028-06-01') to ('2028-07-01');
create table ledger.run_log_items_2028_07 partition of ledger.run_log_items
  for values from ('2028-07-01') to ('2028-08-01');
create table ledger.run_log_items_2028_08 partition of ledger.run_log_items
  for values from ('2028-08-01') to ('2028-09-01');
create table ledger.run_log_items_2028_09 partition of ledger.run_log_items
  for values from ('2028-09-01') to ('2028-10-01');
create table ledger.run_log_items_2028_10 partition of ledger.run_log_items
  for values from ('2028-10-01') to ('2028-11-01');
create table ledger.run_log_items_2028_11 partition of ledger.run_log_items
  for values from ('2028-11-01') to ('2028-12-01');
create table ledger.run_log_items_2028_12 partition of ledger.run_log_items
  for values from ('2028-12-01') to ('2029-01-01');
create table ledger.run_log_items_2029_01 partition of ledger.run_log_items
  for values from ('2029-01-01') to ('2029-02-01');
create table ledger.run_log_items_2029_02 partition of ledger.run_log_items
  for values from ('2029-02-01') to ('2029-03-01');
create table ledger.run_log_items_2029_03 partition of ledger.run_log_items
  for values from ('2029-03-01') to ('2029-04-01');
create table ledger.run_log_items_2029_04 partition of ledger.run_log_items
  for values from ('2029-04-01') to ('2029-05-01');
create table ledger.run_log_items_2029_05 partition of ledger.run_log_items
  for values from ('2029-05-01') to ('2029-06-01');
create table ledger.run_log_items_2029_06 partition of ledger.run_log_items
  for values from ('2029-06-01') to ('2029-07-01');
create table ledger.run_log_items_2029_07 partition of ledger.run_log_items
  for values from ('2029-07-01') to ('2029-08-01');
create table ledger.run_log_items_2029_08 partition of ledger.run_log_items
  for values from ('2029-08-01') to ('2029-09-01');
create table ledger.run_log_items_2029_09 partition of ledger.run_log_items
  for values from ('2029-09-01') to ('2029-10-01');
create table ledger.run_log_items_2029_10 partition of ledger.run_log_items
  for values from ('2029-10-01') to ('2029-11-01');
create table ledger.run_log_items_2029_11 partition of ledger.run_log_items
  for values from ('2029-11-01') to ('2029-12-01');
create table ledger.run_log_items_2029_12 partition of ledger.run_log_items
  for values from ('2029-12-01') to ('2030-01-01');
create table ledger.run_log_items_2030_01 partition of ledger.run_log_items
  for values from ('2030-01-01') to ('2030-02-01');
create table ledger.run_log_items_2030_02 partition of ledger.run_log_items
  for values from ('2030-02-01') to ('2030-03-01');
create table ledger.run_log_items_2030_03 partition of ledger.run_log_items
  for values from ('2030-03-01') to ('2030-04-01');
create table ledger.run_log_items_2030_04 partition of ledger.run_log_items
  for values from ('2030-04-01') to ('2030-05-01');
create table ledger.run_log_items_2030_05 partition of ledger.run_log_items
  for values from ('2030-05-01') to ('2030-06-01');
create table ledger.run_log_items_2030_06 partition of ledger.run_log_items
  for values from ('2030-06-01') to ('2030-07-01');
create table ledger.run_log_items_2030_07 partition of ledger.run_log_items
  for values from ('2030-07-01') to ('2030-08-01');
create table ledger.run_log_items_2030_08 partition of ledger.run_log_items
  for values from ('2030-08-01') to ('2030-09-01');
create table ledger.run_log_items_2030_09 partition of ledger.run_log_items
  for values from ('2030-09-01') to ('2030-10-01');
create table ledger.run_log_items_2030_10 partition of ledger.run_log_items
  for values from ('2030-10-01') to ('2030-11-01');
create table ledger.run_log_items_2030_11 partition of ledger.run_log_items
  for values from ('2030-11-01') to ('2030-12-01');
create table ledger.run_log_items_2030_12 partition of ledger.run_log_items
  for values from ('2030-12-01') to ('2031-01-01');
create table ledger.run_log_items_2031_01 partition of ledger.run_log_items
  for values from ('2031-01-01') to ('2031-02-01');
create table ledger.run_log_items_2031_02 partition of ledger.run_log_items
  for values from ('2031-02-01') to ('2031-03-01');
create table ledger.run_log_items_2031_03 partition of ledger.run_log_items
  for values from ('2031-03-01') to ('2031-04-01');
create table ledger.run_log_items_2031_04 partition of ledger.run_log_items
  for values from ('2031-04-01') to ('2031-05-01');
create table ledger.run_log_items_2031_05 partition of ledger.run_log_items
  for values from ('2031-05-01') to ('2031-06-01');
create table ledger.run_log_items_2031_06 partition of ledger.run_log_items
  for values from ('2031-06-01') to ('2031-07-01');
create table ledger.run_log_items_2031_07 partition of ledger.run_log_items
  for values from ('2031-07-01') to ('2031-08-01');
create table ledger.run_log_items_2031_08 partition of ledger.run_log_items
  for values from ('2031-08-01') to ('2031-09-01');
create table ledger.run_log_items_2031_09 partition of ledger.run_log_items
  for values from ('2031-09-01') to ('2031-10-01');
create table ledger.run_log_items_2031_10 partition of ledger.run_log_items
  for values from ('2031-10-01') to ('2031-11-01');
create table ledger.run_log_items_2031_11 partition of ledger.run_log_items
  for values from ('2031-11-01') to ('2031-12-01');
create table ledger.run_log_items_2031_12 partition of ledger.run_log_items
  for values from ('2031-12-01') to ('2032-01-01');
create table ledger.run_log_items_2032_01 partition of ledger.run_log_items
  for values from ('2032-01-01') to ('2032-02-01');
create table ledger.run_log_items_2032_02 partition of ledger.run_log_items
  for values from ('2032-02-01') to ('2032-03-01');
create table ledger.run_log_items_2032_03 partition of ledger.run_log_items
  for values from ('2032-03-01') to ('2032-04-01');

commit;
