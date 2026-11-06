-- 0065_setup_creators_run_policy.sql
--
-- Audit fix (problem 7): seven kinds of setup data had no creation path at
-- all. Eight new CFG-CREATE-* runs close that gap (budgets and budget
-- thresholds are two separate runs, so eight runs cover the audit's seven
-- kinds). Same pattern as every prior round that registered a new run
-- type -- their own sched.run_policies seed row, no table or column
-- change. None of these eight is ever scheduled (all manual tier), so
-- writes_ledger is false for all of them, same as every other CFG-* run.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('CFG-CREATE-FIXED-ASSET', 'manual',
   'naming a real asset, its cost, and how it depreciates is a judgment a person makes once, and a clock has no asset of its own to discover', false),
  ('CFG-CREATE-LOAN', 'manual',
   'entering a real lender''s note and its own amortization table is a one time setup decision, and a clock has no loan of its own to discover', false),
  ('CFG-CREATE-DEFERRAL-SCHEDULE', 'manual',
   'naming a prepaid policy, a deferred revenue contract, or an intangible''s amortization term is a one time setup decision', false),
  ('CFG-CREATE-ACCRUAL-TEMPLATE', 'manual',
   'naming a recurring accrual and which basis computes its amount is a judgment a person makes once', false),
  ('CFG-CREATE-ARAP-POLICY', 'manual',
   'setting a client''s late fee terms and write off thresholds is a judgment a person makes once', false),
  ('CFG-CREATE-BANKCODE-MAPPING', 'manual',
   'deciding what a bank''s own code means on this client''s books is a judgment a person makes', false),
  ('CFG-CREATE-BUDGET-LINES', 'manual',
   'entering a budget is a judgment a person makes once per period', false),
  ('CFG-CREATE-BUDGET-THRESHOLD', 'manual',
   'deciding what counts as a real variance is a judgment a person makes', false)
on conflict (run_type) do nothing;

commit;
