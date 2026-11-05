-- 0063_recurring_template_run_policy.sql
--
-- CFG-CREATE-RECURRING-TEMPLATE's seed row in sched.run_policies, the same
-- table migration 0022 seeded the original registry into and every round
-- since has added its own new run types to. No schema change -- the table
-- that was missing was the writer for subledger.recurring_templates/
-- recurring_splits (apply-writer.ts had no insert case for either), not a
-- new table or column.
--
-- Forward only. No down migration.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('CFG-CREATE-RECURRING-TEMPLATE', 'manual',
   'a person at the firm names the amount, the cadence, and which accounts a recurring entry posts to, once, and a clock has no recurring obligation of its own to discover', false)
on conflict (run_type) do nothing;

commit;
