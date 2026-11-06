-- 0064_default_schedules_run_policy.sql
--
-- SETUP-CREATE-DEFAULT-SCHEDULES' seed row in sched.run_policies, the same
-- table migration 0022 seeded the original registry into and every round
-- since has added its own new run types to. No schema change -- the table
-- that was missing a writer was sched.schedules itself (apply-writer.ts had
-- no insert case for it at all), audit fix problem 5: nothing, not a run,
-- not a screen, not a migration, ever inserted a client's first schedule.
--
-- Forward only. No down migration.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('SETUP-CREATE-DEFAULT-SCHEDULES', 'manual',
   'decides a client''s books should start running themselves, once, and a clock has no schedule of its own to invent', false)
on conflict (run_type) do nothing;

commit;
