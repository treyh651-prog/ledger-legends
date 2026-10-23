-- 0025_api_intake_client.sql
--
-- The API layer makes client creation a run. INTAKE-CREATE-CLIENT writes the
-- tenancy.clients row and its draft engagement as two row insert proposals, so
-- the firm's first real client is created by the engine with an intent row, a
-- frozen scope, and a preview the apply has to agree with. Doc 11.
--
-- The run is manual, like the other intake steps. A clock has no reason to
-- create a client. The reason text mirrors RUN_POLICIES in
-- server/runs/policy.ts, which script/check-schema.ts reads back.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('INTAKE-CREATE-CLIENT', 'manual', 'the first intake step, run once when the firm starts a client from the interface, and a clock has no reason to create a client', false)
on conflict (run_type) do nothing;

commit;
