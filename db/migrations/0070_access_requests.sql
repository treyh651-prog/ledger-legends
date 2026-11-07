-- 0070_access_requests.sql
-- Self service access requests. Until now every tenancy.users/memberships
-- row was created by an invitation (server/auth/invitations.ts), which
-- always runs as a firm admin actor who already has firm access -- an
-- unambiguous case for the existing own_memberships RLS policy. A client
-- who signs up on their own has no actor at all yet: no tenancy.users row,
-- no membership, nothing for current_actor() to resolve. This table is the
-- queue between that moment and a firm choosing to grant real access.
--
-- The insert happens before any actor exists, so it cannot lean on
-- current_actor() the way every other write in this schema does. The
-- server verifies the person's bearer token itself (the same check
-- requireUser performs) and sets a second, narrower session variable
-- naming only the subject it just verified -- current_requesting_subject(),
-- one step upstream of current_actor(). The insert and self read policies
-- below are written in terms of that, so the restriction is a real RLS
-- policy and not application code's word alone, the same discipline every
-- other tenant table in this schema already follows.
--
-- Forward only. No down migration.

begin;

create table tenancy.access_requests (
  id                      uuid primary key default gen_random_uuid(),
  auth_subject            text not null,
  email                   text not null,
  firm_id                 uuid not null references tenancy.firms(id),
  requested_client_name   text not null,
  message                 text,
  status                  text not null default 'pending',
  created_at              timestamptz not null default now(),
  resolved_at             timestamptz,
  resolved_by             uuid references tenancy.users(id),
  resulting_membership_id uuid references tenancy.memberships(id),
  rejection_reason        text,
  constraint ar_status check (status in ('pending', 'approved', 'rejected')),
  constraint ar_resolved_matches_status check (
    (status = 'pending' and resolved_at is null and resolved_by is null)
    or (status in ('approved', 'rejected') and resolved_at is not null and resolved_by is not null)),
  constraint ar_approved_has_membership check (
    (status = 'approved') = (resulting_membership_id is not null)),
  constraint ar_rejected_has_reason check (
    status <> 'rejected' or rejection_reason is not null)
);

-- One open request per person per firm at a time. A rejected or approved
-- row does not count, so a person may ask again after either outcome.
create unique index access_requests_one_pending
  on tenancy.access_requests (auth_subject, firm_id)
  where status = 'pending';

create index on tenancy.access_requests (firm_id) where status = 'pending';
create index on tenancy.access_requests (auth_subject);

create or replace function tenancy.current_requesting_subject()
returns text
language sql
stable
security definer
set search_path = tenancy, pg_catalog
as $$
  select nullif(current_setting('app.requesting_subject', true), '');
$$;

revoke all on function tenancy.current_requesting_subject() from public;
grant execute on function tenancy.current_requesting_subject() to app_web, app_worker;

alter table tenancy.access_requests enable row level security;
alter table tenancy.access_requests force row level security;

-- The person who just verified their own token may create a request naming
-- themselves, and read anything they have submitted, under any firm.
create policy self_submit on tenancy.access_requests
  for insert
  with check (auth_subject = tenancy.current_requesting_subject());

create policy self_read on tenancy.access_requests
  for select
  using (auth_subject = tenancy.current_requesting_subject());

-- Firm staff see and resolve their own firm's queue. Resolving is an
-- update only -- insert stays self_submit's alone, matching how
-- own_memberships never lets firm staff insert on someone else's behalf.
create policy firm_review on tenancy.access_requests
  for select
  using ((select tenancy.has_firm_access(firm_id)));

create policy firm_resolve on tenancy.access_requests
  for update
  using ((select tenancy.has_firm_access(firm_id)))
  with check ((select tenancy.has_firm_access(firm_id)));

create trigger trg_freeze_access_request_firm
  before update on tenancy.access_requests
  for each row execute function tenancy.freeze_firm_discriminator();

commit;
