-- 0033_eng_set_billing_status_policy.sql
--
-- The compliance tier row for ENG-SET-BILLING-STATUS (server/runs/policy.ts),
-- registered in server/runs/registry.ts. Manual: a person at the firm marks
-- the engagement current or past due by hand. There is no payment event in
-- this system for a clock to read, so the run is never scheduled and never
-- runs unattended; sched_tier_never_manual (migration 0022) enforces that in
-- the schema, not just in review.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('ENG-SET-BILLING-STATUS', 'manual', 'a person at the firm marks the engagement current or past due by hand, because this system has no payment event for a clock to read', false)
on conflict (run_type) do nothing;

commit;
