-- 0068_close_override_gate_and_bankcode_reason.sql
--
-- Two corrections found by script/check-schema.ts after applying
-- migrations 0063-0067.
--
-- 1. CLOSE-OVERRIDE-GATE (problem 4, commit cf5de0a, 2026-11-06) never
--    got a migration at all -- that round's own plan note reasoned "no
--    live-DB check needed, no schema or query-catalog change" because
--    close.gate_results.manual_override/override_reason already existed
--    and were already queried, which is true, but missed that
--    registering a brand new run type still needs its own
--    sched.run_policies seed row, the same as every other round. Seeded
--    here, same reason string as server/runs/policy.ts's own entry.
--
-- 2. sched.run_policies.reason for CFG-CREATE-BANKCODE-MAPPING was
--    seeded (migration 0065) with shorter wording than
--    server/runs/policy.ts's current RUN_POLICIES entry -- the reason
--    string was extended in code sometime after 0065 was written,
--    without a corrective migration. check-schema.ts compares the two
--    by exact string and the database is corrected to match the
--    TypeScript source, same pattern migration 0062 already used for
--    this exact class of drift.
--
-- Forward only. No down migration.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('CLOSE-OVERRIDE-GATE', 'manual',
   'accepting a known gate exception and writing down why is a decision a person makes on purpose, and a clock has no exception of its own to accept', false)
on conflict (run_type) do nothing;

update sched.run_policies
  set reason = 'deciding what a bank''s own code means on this client''s books is a judgment a person makes, the same reasoning CFG-CREATE-RULE gives for its own category mapping'
  where run_type = 'CFG-CREATE-BANKCODE-MAPPING';

commit;
