-- 0049_run_policies_import_review.sql
--
-- IMPORT-REVIEW-STAGED-ROW was added to RUN_POLICIES in server/runs/policy.ts
-- and to the registry; tier, reason, and writes_ledger below are copied
-- verbatim.
--
-- Forward only. No down migration.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('IMPORT-REVIEW-STAGED-ROW', 'manual', 'whether two same day, same amount charges are one purchase repeated or two different ones is a judgment a person makes once, looking at the statement, the same reasoning IMPORT-COMMIT-BATCH itself is not unattended for', false);

commit;
