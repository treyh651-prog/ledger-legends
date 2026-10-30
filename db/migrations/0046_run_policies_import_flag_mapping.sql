-- 0046_run_policies_import_flag_mapping.sql
--
-- IMPORT-FLAG-MAPPING-NEEDED and IMPORT-REJECT-BATCH (migration 0045) were
-- added to RUN_POLICIES in server/runs/policy.ts and to the registry, and
-- migration 0044's own note says what happens to a run left out of this
-- table: script/check-schema.ts reads it back against RUN_POLICIES and fails
-- on any run missing, scheduled or not. tier, reason, and writes_ledger below
-- are copied verbatim from server/runs/policy.ts.
--
-- Forward only. No down migration.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('IMPORT-FLAG-MAPPING-NEEDED', 'unattended', 'records that a parse could not get past the mapping check, touches no ledger account, and a repeat of the same failure lands on the same open row', false),
  ('IMPORT-REJECT-BATCH', 'manual', 'throwing out a staged statement is a decision a person makes once, looking at the mapping, the same reasoning IMPORT-COMMIT-BATCH itself is not unattended for', false);

commit;
