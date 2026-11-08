-- 0072_ar_issue_invoice.sql
--
-- Audit finding (rerun, 2026-11-06): AR-CHARGE-LATEFEES creates a fee
-- invoice as status 'draft' with no mechanism anywhere to move it to
-- posted and give it a journal entry -- a late fee could be charged and
-- then never actually reach the books. New AR-ISSUE-INVOICE run closes
-- the gap ("the ordinary invoicing path" its own header comment already
-- promised existed). No table/column change, same as every other new run
-- type -- only the compliance seed row this migration adds.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('AR-ISSUE-INVOICE', 'manual',
   'posts a draft invoice''s sale to the general ledger and makes it revenue, the same reasoning AR-CREATE-INVOICE itself gives, and a late fee is exactly the kind of charge a person should look at before it becomes one', true)
on conflict (run_type) do nothing;

commit;
