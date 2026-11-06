-- 0066_substantiation_record_run_policy.sql
--
-- CFG-CREATE-SUBSTANTIATION-RECORD's seed row in sched.run_policies, same
-- pattern as migrations 0063-0065. No schema change -- apply-writer.ts
-- already had a real insert case for close.substantiation_records (built
-- ahead of its own writer, it turns out), the table that was missing was
-- a run, found while wiring a UI for PAY-APPROVE-RUN (problem 8): its own
-- precondition, a payroll register recorded for the period, could never
-- be satisfied without this.
--
-- Forward only. No down migration.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('CFG-CREATE-SUBSTANTIATION-RECORD', 'manual',
   'a person counted the inventory or pulled the payroll register, and writing down what they found and where it is filed is a decision a person makes once', false)
on conflict (run_type) do nothing;

commit;
