-- 0023_auth.sql
-- Login support. Three things, each small on its own.
--
-- 1. Two columns on tenancy.users that the login flow writes: last_seen_at
--    (touched by the actor middleware, at most once a minute) and invited_by
--    (the firm user who created the invitation, null for the bootstrap owner).
--
-- 2. A visibility fix on tenancy.clients. Migration 0001 protected the
--    clients table with firm_isolation, which is has_firm_access(firm_id).
--    has_firm_access is true for any membership in the firm, including a
--    client scoped one, so a client user could read the names and entity
--    types of every other client in the firm. The table now uses
--    has_client_access(id) for reads, and firm scoped membership for writes.
--
-- 3. Grants that make the app_web role usable by the interface. Migration
--    0001 created app_web and app_worker with no login and said that later
--    migrations grant table access. Some did, most did not. The reason it
--    matters now: on Supabase the postgres role carries BYPASSRLS, so a
--    server that connects as postgres is not subject to any policy, and the
--    row level security written since 0001 is decorative for interface
--    traffic. The server's actor transaction runs `set local role app_web`
--    when APP_DB_ROLE is set (see server/db/with-actor.ts), which needs the
--    connecting role to be a member of app_web and app_web to have the table
--    grants. This migration does both, then re-applies the narrow grants
--    that earlier migrations chose on purpose.
--
-- Forward only. No data is moved.

begin;

-- ---------------------------------------------------------------------------
-- 1. tenancy.users columns
-- ---------------------------------------------------------------------------

alter table tenancy.users
  add column if not exists last_seen_at timestamptz,
  add column if not exists invited_by uuid references tenancy.users(id);

comment on column tenancy.users.last_seen_at is
  'Set by the actor middleware when a verified token resolves to this user. Throttled, so it is accurate to about a minute.';
comment on column tenancy.users.invited_by is
  'Firm user who created the invitation. Null for the bootstrap owner.';

-- ---------------------------------------------------------------------------
-- 2. tenancy.clients visibility
-- ---------------------------------------------------------------------------

-- Firm scoped membership in the firm. Client scoped users are not firm
-- staff, and firm staff are the only ones who create or edit client rows.
create or replace function tenancy.is_firm_staff(p_firm_id uuid)
returns boolean
language sql
stable
security definer
set search_path = tenancy, pg_temp
as $$
  select exists (
    select 1
    from tenancy.memberships m
    where m.user_id = tenancy.current_actor()
      and m.firm_id = p_firm_id
      and m.scope = 'firm'
      and m.revoked_at is null
  );
$$;

revoke all on function tenancy.is_firm_staff(uuid) from public;
grant execute on function tenancy.is_firm_staff(uuid) to app_web, app_worker;

drop policy if exists firm_isolation on tenancy.clients;

create policy client_select on tenancy.clients
  for select
  using ((select tenancy.has_client_access(id)));

create policy client_insert on tenancy.clients
  for insert
  with check ((select tenancy.is_firm_staff(firm_id)));

create policy client_update on tenancy.clients
  for update
  using ((select tenancy.is_firm_staff(firm_id)))
  with check ((select tenancy.is_firm_staff(firm_id)));

-- No delete policy. Clients are archived with status, never deleted.

-- ---------------------------------------------------------------------------
-- 3. app_web becomes usable
-- ---------------------------------------------------------------------------

-- The role that applies migrations (postgres on Supabase) becomes a member
-- of app_web so a session can `set local role app_web`. The migration runs
-- as that role, so current_user is the right target.
do $$
begin
  execute format('grant app_web to %I', current_user);
exception
  when others then
    raise notice 'could not grant app_web to %, grant it by hand: %', current_user, sqlerrm;
end
$$;

-- Schema usage, table read and write, sequence use, function execute, for
-- every schema the migrations created. No delete anywhere: the system is
-- forward only, and the tables that need deletion protection already have
-- triggers for it.
do $$
declare
  s text;
begin
  foreach s in array array[
    'tenancy', 'ledger', 'subledger', 'entitlement', 'docvault', 'import',
    'intake', 'tax', 'practice', 'close', 'report', 'deliverable', 'sched'
  ]
  loop
    if exists (select 1 from pg_namespace where nspname = s) then
      execute format('grant usage on schema %I to app_web, app_worker', s);
      execute format('grant select, insert, update on all tables in schema %I to app_web, app_worker', s);
      execute format('grant usage, select on all sequences in schema %I to app_web, app_worker', s);
      execute format('grant execute on all functions in schema %I to app_web, app_worker', s);
      execute format('alter default privileges in schema %I grant select, insert, update on tables to app_web, app_worker', s);
      execute format('alter default privileges in schema %I grant usage, select on sequences to app_web, app_worker', s);
      execute format('alter default privileges in schema %I grant execute on functions to app_web, app_worker', s);
    end if;
  end loop;
end
$$;

-- Narrow grants that earlier migrations chose on purpose, restated so the
-- blanket grant above does not widen them.

-- 0003: run log tables are insert only. A log that can be edited is not evidence.
revoke update on ledger.run_log, ledger.run_log_items, ledger.run_log_events,
  ledger.run_sequences from app_web, app_worker;

-- 0005: tax thresholds are reference data, read only to the app.
revoke insert, update on subledger.tax_thresholds from app_web, app_worker;

-- 0008: audit and signature events are append only.
revoke update on docvault.audit_events from app_web, app_worker;
revoke update on docvault.signature_events from app_web, app_worker;

-- 0022: run policies are operator configuration, read only to the app.
revoke insert, update on sched.run_policies from app_web, app_worker;

-- Memberships are written by the invitation and bootstrap paths, which run
-- as the connecting role, not as an actor. Reads through app_web are fine.
-- Users likewise: the actor lookup by auth_subject happens before an actor
-- is known, so it runs as the connecting role.

commit;
