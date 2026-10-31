-- 0056_run_policies_txn_void.sql
--
-- TXN-VOID and TXN-VOID-AND-REISSUE were added to RUN_POLICIES in
-- server/runs/policy.ts and to the registry; tier, reason, and
-- writes_ledger below are copied verbatim.
--
-- Forward only. No down migration.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('TXN-VOID', 'manual', 'killing a transaction reverses whatever it already posted, a correction a person decides on and names a reason for, never something a clock infers', true),
  ('TXN-VOID-AND-REISSUE', 'manual', 'same judgment as TXN-VOID, plus the corrected amount or date being reissued is itself a person''s call', true);

commit;
