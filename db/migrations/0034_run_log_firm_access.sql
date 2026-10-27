-- 0034_run_log_firm_access.sql
--
-- client_isolation on ledger.run_log (migration 0003) only grants access
-- through tenancy.has_client_access(client_id), which joins to an existing
-- tenancy.clients row. The run framework logs a run's intent row, in its own
-- transaction, before the run's own work runs (server/runs/execute.ts, Phase
-- 1, "the intent row, in its own short transaction"). For INTAKE-CREATE-CLIENT
-- that intent row names a client_id that does not exist yet, because creating
-- it is the run, and the policy correctly, uselessly, refuses the write: no
-- firm can ever onboard a client with row level security enforced, which is
-- every production deployment. This was never caught because the test suite
-- runs the run framework against an in memory stand in with no RLS at all,
-- and real Postgres testing to date has used a role that bypasses RLS.
--
-- run_log and its three sibling tables already carry firm_id on every row,
-- not only client_id. tenancy.has_firm_access(firm_id), defined in migration
-- 0001 beside has_client_access, checks firm scoped membership directly
-- against tenancy.memberships and needs no client row to exist. Widening the
-- policy to accept either keeps every existing guarantee: a client scoped
-- actor (the portal) still has only has_client_access, so this changes
-- nothing about what a client can see; a firm member gains exactly what firm
-- scope already means everywhere else in this schema, access to their own
-- firm's rows, including the one being created right now.

begin;

drop policy client_isolation on ledger.run_log;
create policy client_isolation on ledger.run_log
  using ( tenancy.has_firm_access(firm_id) or (select tenancy.has_client_access(client_id)) )
  with check ( tenancy.has_firm_access(firm_id) or (select tenancy.has_client_access(client_id)) );

drop policy client_isolation on ledger.run_log_items;
create policy client_isolation on ledger.run_log_items
  using ( tenancy.has_firm_access(firm_id) or (select tenancy.has_client_access(client_id)) )
  with check ( tenancy.has_firm_access(firm_id) or (select tenancy.has_client_access(client_id)) );

drop policy client_isolation on ledger.run_log_events;
create policy client_isolation on ledger.run_log_events
  using ( tenancy.has_firm_access(firm_id) or (select tenancy.has_client_access(client_id)) )
  with check ( tenancy.has_firm_access(firm_id) or (select tenancy.has_client_access(client_id)) );

drop policy client_isolation on ledger.run_sequences;
create policy client_isolation on ledger.run_sequences
  using ( tenancy.has_firm_access(firm_id) or (select tenancy.has_client_access(client_id)) )
  with check ( tenancy.has_firm_access(firm_id) or (select tenancy.has_client_access(client_id)) );

commit;
