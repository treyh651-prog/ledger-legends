-- 0074_notification_preferences.sql
--
-- Email feature, broad scope. docs/09-architecture-and-decisions.md is
-- explicit about the shape this has to take: "When we wire external email,
-- it is opt in per client per notification type, per D4 compliance
-- framing" -- D4 (docs/05-decisions.md Part 5) is the line the firm must
-- not cross, since Jose and Rosario are not CPAs. One row per (client,
-- notification type), absent means off -- opt in, not opt out. Only the two
-- client-facing notification types this round builds are listed in the
-- check constraint; staff escalation email (PRAC-ESCALATE-OVERDUE) never
-- reaches a client's inbox, so it is not gated by this table at all.
--
-- Same shape every other CFG-* run's own settings table already uses
-- (subledger.arap_policies, ledger.client_policies): manual_override triple
-- and its guard trigger, the discriminator freeze trigger, client_isolation
-- RLS, a leading client_id index.

begin;

create table tenancy.notification_preferences (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  notification_type text not null,
  enabled        boolean not null default false,

  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint notification_pref_one_per_type unique (client_id, notification_type),
  constraint notification_pref_type check (notification_type in (
    'document_request_nudge', 'substantiation_request_raised'))
);

create index notification_preferences_client on tenancy.notification_preferences (client_id);

alter table tenancy.notification_preferences enable row level security;
alter table tenancy.notification_preferences force row level security;

create policy client_isolation on tenancy.notification_preferences
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on tenancy.notification_preferences
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on tenancy.notification_preferences
  for each row execute function ledger.guard_manual_override();

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('CFG-SET-NOTIFICATION-PREFERENCE', 'manual',
   'turning on a client-facing email notification is a deliberate per-client, per-type choice a person makes, never a default -- the D4 compliance framing docs/09 states for this feature', false)
on conflict (run_type) do nothing;

commit;
