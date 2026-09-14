-- 0022_scheduler.sql
-- The scheduler, and the compliance boundary it has to respect.
--
-- Trigger.dev is the clock now. The operator installed their GitHub app and
-- created a project, and the earlier plan for a ticker inside this process is
-- withdrawn. See NOTES.md entry 180 for the withdrawal and entry 181 for the
-- four shapes that were weighed before tasks connecting straight to Postgres
-- was chosen.
--
-- The consequence that this migration exists to absorb: the clock is now a
-- service somebody else operates. It can retry a task, run a deploy twice,
-- fire while a previous deploy is still in flight, or miss a window entirely
-- while their side is having a bad morning. None of that is visible from
-- inside this database unless the database is the thing that decides what was
-- due and what has already been done.
--
-- So the ledger of windows lives here, and the one constraint that carries the
-- whole idempotency story is this:
--
--   constraint window_one_per_schedule_start unique (schedule_id, window_start)
--
-- A Trigger.dev retry of a task that already inserted its window row collides
-- with that constraint and stops. Not because the task was written carefully,
-- and not because their retry policy was configured a particular way, but
-- because the second insert is refused by Postgres. That is the difference
-- between an idempotent system and a system that has been idempotent so far.
--
-- Three tables:
--
--   1. sched.run_policies, the compliance tier of every registered run. A
--      reference table, seeded here, read only to the application roles.
--   2. sched.schedules, one row per thing that should happen for one client.
--   3. sched.windows, one row per schedule per due window.
--
-- What is deliberately not here: a mutable next_run_at column as the only
-- record of what is due. A schedule's next window is derived from its cadence
-- and the last window that completed, in server/runs/dates.ts, so a window
-- that was missed stays missing and visible rather than being overwritten by
-- the next tick. A single mutable pointer cannot tell the difference between
-- "nothing was due" and "three things were due and nobody ran them".
--
-- Conventions from 0019 held here: firm and client foreign keys on the tenant
-- tables, row level security enabled and forced, the client_isolation policy
-- wrapping tenancy.has_client_access in a select on both using and with check,
-- a leading client_id index and a firm_id index, the discriminator freeze
-- trigger, the override guard, version, named check constraints on every
-- enumerated text column, and grants to app_web and app_worker.
--
-- Run id columns are text rather than char(31). Migration 0020 moved every run
-- id column off the fixed width character type and script/check-schema.ts
-- fails a new one, so these match. trigger_run_id is text because it holds
-- Trigger.dev's identifier, whose shape is theirs and not ours.
--
-- COMPLIANCE. sched.run_policies is the machine readable half of the boundary
-- in docs and in server/runs/policy.ts. Two named check constraints do the
-- enforcement, and neither of them is a convention a caller can forget:
--
--   sched_tier_never_manual        a manual run cannot be scheduled at all.
--   sched_mode_matches_tier        an unattended run schedules in apply mode,
--                                  a propose run schedules in preview mode,
--                                  and there is no third option.
--
-- The composite foreign key (run_type, tier) into sched.run_policies is what
-- makes the second constraint true rather than hopeful. A schedule cannot
-- claim a tier the policy table does not give that run.
--
-- Forward only. No down migration.

begin;

create schema if not exists sched;

-- ---------------------------------------------------------------------------
-- 1. sched.run_policies.
--
-- No firm_id and no client_id, and that is a deliberate departure from the
-- convention rather than an oversight. The tier of a run is a property of the
-- software, not of a tenant. A per client tier would mean one client's
-- configuration could make CLOSE-LOCK-PERIOD unattended, which is exactly the
-- thing the tier exists to prevent, and it would also mean the table could not
-- be seeded until a client existed. Row level security is still enabled and
-- forced, with a read only policy, so the application roles can read the
-- tiers and cannot write them. Only a migration changes a tier. NOTES 183.
--
-- writes_ledger is denormalized from server/runs/registry.ts so the ledger
-- half of the classification rule is checkable in SQL. A run that posts to the
-- general ledger is never unattended, and the constraint below says so.
-- ---------------------------------------------------------------------------

create table sched.run_policies (
  run_type      text primary key,
  tier          text not null,
  -- Why this run carries this tier. Seeded from RUN_POLICIES in
  -- server/runs/policy.ts, and read back by script/check-schema.ts so the two
  -- cannot drift.
  reason        text not null,
  writes_ledger boolean not null,

  version       integer not null default 1,
  created_at    timestamptz not null default now(),

  constraint run_policy_tier check (tier in ('unattended', 'propose', 'manual')),
  constraint run_policy_reason_present check (reason <> ''),
  constraint run_policy_type_format check (run_type ~ '^[A-Z0-9]+(-[A-Z0-9]+)+$'),
  -- The machine checkable half of the classification rule. A run that posts to
  -- the general ledger prepares and waits, or it is started by a person.
  constraint run_policy_ledger_not_unattended
    check (not writes_ledger or tier <> 'unattended'),
  -- The target of the composite foreign key on sched.schedules. Without this
  -- a schedule could name a tier the policy table does not agree with.
  constraint run_policy_type_tier unique (run_type, tier)
);

alter table sched.run_policies enable row level security;
alter table sched.run_policies force row level security;

-- Readable by anybody the application lets in, writable by nobody. A tier
-- change is a migration, which is the point.
create policy reference_readable on sched.run_policies
  for select using (true);

-- ---------------------------------------------------------------------------
-- 2. sched.schedules.
--
-- One row per thing that should happen for one client. The cadence is stored
-- in the shape a person would say it out loud, and the timezone it is
-- interpreted in travels with it, because a cadence without a zone is only
-- correct for half the year. See NOTES 185.
--
-- Four cadences, and the fourth is the reason this is not a cron string
-- column. A close calendar is written in business days: the third business day
-- of the month is a real instruction a firm gives, and no cron expression can
-- say it. Storing a cron string would also mean the daylight saving question
-- has to be answered somewhere else, by somebody, later.
--
-- local_hour and local_minute are the wall clock time in timezone. The UTC
-- instant is computed in server/runs/dates.ts at the moment a window is
-- resolved and stored on the window row, never here, because the offset that
-- turns 06:00 in Denver into an instant is different in January and in July.
-- ---------------------------------------------------------------------------

create table sched.schedules (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  -- A short name the operator reads in npm run sched:status. Unique per
  -- client so two schedules for the same run can be told apart by what they
  -- are for rather than by their identifier.
  name           text not null,
  run_type       text not null,
  -- Denormalized from sched.run_policies through the composite foreign key
  -- below, so the mode constraint can be a plain check.
  tier           text not null,
  -- apply for unattended, preview for propose. Constrained against the tier.
  execution_mode text not null,

  cadence        text not null,
  -- Populated for exactly one cadence each, enforced by cadence_shape below.
  weekday        text,
  day_of_month   integer,
  business_day   integer,

  local_hour     integer not null,
  local_minute   integer not null default 0,
  timezone       text not null default 'America/Denver',

  enabled        boolean not null default true,
  effective_from date not null,
  effective_to   date,

  -- The run's scope, as the run's own zod schema wants it, minus the dates the
  -- window supplies. Empty object for a run whose scope is the client alone.
  scope_json     jsonb not null default '{}'::jsonb,

  -- The failure signal. Two in a row is the threshold the operator surface
  -- highlights, because one failure is a bad night and two is a broken thing.
  -- Reset to zero by a window that succeeds.
  consecutive_failures integer not null default 0,
  last_failure_at      timestamptz,
  last_failure_detail  text,

  version        integer not null default 1,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint sched_name_present check (name <> ''),
  constraint sched_cadence check (cadence in (
    'daily', 'weekly', 'monthly_day', 'monthly_business_day')),
  constraint sched_weekday check (weekday is null or weekday in (
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')),
  constraint sched_execution_mode check (execution_mode in ('preview', 'apply')),
  constraint sched_tier check (tier in ('unattended', 'propose', 'manual')),
  constraint sched_hour_range check (local_hour between 0 and 23),
  constraint sched_minute_range check (local_minute between 0 and 59),
  constraint sched_day_of_month_range check (
    day_of_month is null or day_of_month between 1 and 31),
  constraint sched_business_day_range check (
    business_day is null or business_day between 1 and 23),
  constraint sched_timezone_present check (timezone <> ''),
  constraint sched_effective_order check (
    effective_to is null or effective_to >= effective_from),
  constraint sched_scope_is_object check (jsonb_typeof(scope_json) = 'object'),
  constraint sched_failures_not_negative check (consecutive_failures >= 0),
  -- Exactly the column the cadence needs, and none of the others. A weekly
  -- schedule carrying a day_of_month is a row two readers disagree about.
  constraint cadence_shape check (
    (cadence = 'daily'
       and weekday is null and day_of_month is null and business_day is null)
    or (cadence = 'weekly'
       and weekday is not null and day_of_month is null and business_day is null)
    or (cadence = 'monthly_day'
       and weekday is null and day_of_month is not null and business_day is null)
    or (cadence = 'monthly_business_day'
       and weekday is null and day_of_month is null and business_day is not null)
  ),
  -- The compliance boundary, first half. A manual run is never scheduled.
  constraint sched_tier_never_manual check (tier <> 'manual'),
  -- The compliance boundary, second half. There is one legal mode per tier.
  constraint sched_mode_matches_tier check (
    (tier = 'unattended' and execution_mode = 'apply')
    or (tier = 'propose' and execution_mode = 'preview')
  ),
  constraint sched_override_complete check (
    not manual_override or (manual_override_by is not null and manual_override_at is not null)),
  constraint sched_one_name_per_client unique (client_id, name),
  unique (client_id, id),
  -- The tier on this row has to be the tier the policy table gives this run.
  foreign key (run_type, tier) references sched.run_policies (run_type, tier)
);

create index schedules_client on sched.schedules (client_id, id);
create index schedules_firm on sched.schedules (firm_id);
-- The tick reads every enabled schedule across all clients, which is the one
-- query that is not client scoped, because a Trigger.dev schedule per client
-- would mean their dashboard has to grow every time the firm signs one.
create index schedules_enabled on sched.schedules (firm_id, run_type)
  where enabled;
-- The operator surface leads with what is broken.
create index schedules_failing on sched.schedules (firm_id, consecutive_failures)
  where consecutive_failures >= 2;

-- ---------------------------------------------------------------------------
-- 3. sched.windows.
--
-- One row per schedule per due window. window_start is the UTC instant the
-- cadence fired at, computed in the schedule's own zone. window_end is the
-- start of the next window, so the pair is half open and two consecutive
-- windows cannot both claim the same moment.
--
-- The unique constraint on (schedule_id, window_start) is the whole point of
-- this table. Everything else here is evidence.
--
-- run_id is the run execution id the window produced, so a row here can be
-- traced into ledger.run_log and from there into every entry the run wrote.
-- trigger_run_id is the identifier in the Trigger.dev dashboard, so the trace
-- goes the other way too. Without it a person looking at a failed task on
-- their side has no way back to what it was supposed to be doing.
-- ---------------------------------------------------------------------------

create table sched.windows (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  schedule_id    char(26) not null,
  -- The UTC instant the cadence fired at, and the local day it represents.
  -- The local day is stored rather than derived because reading "did last
  -- night run" off a UTC timestamp in Denver in July is a subtraction nobody
  -- should have to do at a glance.
  window_start   timestamptz not null,
  window_end     timestamptz not null,
  local_day      date not null,

  status         text not null default 'due',
  attempt_count  integer not null default 0,

  -- The run this window produced, once it produced one.
  run_id         text,
  run_status     text,
  error_code     text,
  error_detail   text,
  skip_reason    text,

  -- Trigger.dev's own identifier for the task run that touched this window.
  trigger_run_id text,

  claimed_at     timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,

  version        integer not null default 1,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,
  created_at     timestamptz not null default now(),

  constraint window_status check (status in (
    'due', 'running', 'succeeded', 'failed', 'skipped')),
  constraint window_order check (window_end > window_start),
  constraint window_attempts_not_negative check (attempt_count >= 0),
  -- A skipped window says why. A skip with no reason is a window nobody can
  -- audit, and the catch up bound produces skips on purpose.
  constraint window_skip_has_reason check (
    status <> 'skipped' or (skip_reason is not null and skip_reason <> '')),
  -- A failed window says what failed, for the same reason.
  constraint window_failure_has_detail check (
    status <> 'failed' or (error_code is not null and error_code <> '')),
  constraint window_override_complete check (
    not manual_override or (manual_override_by is not null and manual_override_at is not null)),

  -- The idempotency story, in one line. A Trigger.dev retry that reaches this
  -- insert a second time is refused by the database.
  constraint window_one_per_schedule_start unique (schedule_id, window_start),

  unique (client_id, id),
  foreign key (client_id, schedule_id) references sched.schedules (client_id, id)
);

create index windows_client on sched.windows (client_id, id);
create index windows_firm on sched.windows (firm_id);
-- The status read the operator surface and the sweep both make: the recent
-- history of one schedule, newest first.
create index windows_by_schedule on sched.windows (schedule_id, window_start desc);
-- What the sweep looks for. A window that is still due, or that was claimed
-- and never finished.
create index windows_outstanding on sched.windows (firm_id, window_start)
  where status in ('due', 'running');

-- ---------------------------------------------------------------------------
-- 4. Row level security, the discriminator freeze, and the override guard.
--
-- The same three properties every tenant table carries. sched.run_policies is
-- above and is not a tenant table, so it gets the read only policy instead.
--
-- The override columns are on both tables even though no run writes them
-- today. A person who pins a window skipped by hand, or freezes a schedule
-- while a client is being migrated, has made a decision, and invariant 8 says
-- automation does not write over it.
-- ---------------------------------------------------------------------------

alter table sched.schedules enable row level security;
alter table sched.schedules force row level security;
alter table sched.windows enable row level security;
alter table sched.windows force row level security;

create policy client_isolation on sched.schedules
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on sched.windows
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on sched.schedules
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on sched.windows
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on sched.schedules
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on sched.windows
  for each row execute function ledger.guard_manual_override();

-- ---------------------------------------------------------------------------
-- 5. Grants.
--
-- The tier table is select only to both roles. Nothing the application runs
-- may reclassify a run, which is the property that makes the boundary worth
-- having when the caller is a service outside this process.
-- ---------------------------------------------------------------------------

grant usage on schema sched to app_web, app_worker;
grant select on sched.run_policies to app_web, app_worker;
grant select, insert, update on sched.schedules to app_web, app_worker;
grant select, insert, update on sched.windows to app_web, app_worker;

-- ---------------------------------------------------------------------------
-- 6. The tiers, all of them.
--
-- Generated from RUN_POLICIES in server/runs/policy.ts, which is the source.
-- script/check-schema.ts reads this table back and fails when the two differ,
-- so a run reclassified in TypeScript without a migration is a red gate rather
-- than a database that quietly disagrees with the code.
-- ---------------------------------------------------------------------------

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('INTAKE-BUILD-CHART', 'manual', 'runs once when the firm finishes the intake wizard, and a second chart build for a client that already has a chart is a mistake rather than a refresh', false),
  ('INTAKE-SEED-TASKS', 'manual', 'one time wizard step that seeds the whole task catalog, so a repeat on a clock would stack a second copy of the firm''s workload', false),
  ('INTAKE-OPEN-REQUESTS', 'manual', 'one time wizard step whose output is a list of asks addressed to the client, and the first thing a new client hears from the firm is not a thing a clock decides to send', false),
  ('SETUP-IMPORT-BALANCES', 'manual', 'posts the opening balance entry to the general ledger once, and a wrong opening balance misstates every period built on top of it', true),
  ('IMPORT-PARSE-FEED', 'unattended', 'parses a feed into staging, touches no ledger account, and a reparse of the same feed lands on the same staged rows', false),
  ('IMPORT-COMMIT-BATCH', 'propose', 'commits a staged batch into the register and the ledger, and which batch commits is a decision a person makes after looking at the mapping', true),
  ('TXN-NORMALIZE-VENDORS', 'unattended', 'rewrites a vendor key on the register, changes no amount and no account, and respects the manual override flag', false),
  ('TXN-DETECT-DUPLICATES', 'unattended', 'sets a flag on a row so a person can look at it, and posts nothing', false),
  ('TXN-PAIR-TRANSFERS', 'propose', 'posts the clearing entry that closes a transfer pair, which is a general ledger write', true),
  ('TXN-SPLIT-SETTLEMENTS', 'propose', 'posts gross revenue and processor fees as separate ledger lines from a report that does not always add up', true),
  ('TXN-APPLY-RECURRING', 'propose', 'posts an entry from a template, and a template that has drifted from reality posts a wrong number every period until somebody looks', true),
  ('TXN-APPLY-RULES', 'unattended', 'assigns a category from a rule the firm wrote, writes no journal line, and refuses a row a person has claimed', false),
  ('TXN-APPLY-VENDORDEFAULTS', 'unattended', 'assigns the vendor''s default category, a classification the firm already recorded, and posts nothing', false),
  ('TXN-MAP-BANKCODES', 'unattended', 'maps the bank''s own category code through a table the firm maintains, and posts nothing', false),
  ('TXN-SWEEP-SUSPENSE', 'propose', 'parks a transaction in a clearing account with a ledger entry and opens a portal request the client reads', true),
  ('REC-MATCH-TIERED', 'unattended', 'proposes matches between statement lines and register rows, writes no ledger entry, and a wrong match is undone by rematching', false),
  ('REC-CLEAR-MATCHED', 'unattended', 'flags matched lines cleared inside a reconciliation batch, which is derived from the match and reversible', false),
  ('REC-FLAG-STALE', 'unattended', 'reports what clearing left outstanding, which is a measurement and not a change', false),
  ('PER-REVERSE-ACCRUALS', 'propose', 'posts reversing entries into the general ledger', true),
  ('PER-POST-RECURRING', 'propose', 'posts recurring entries into the general ledger', true),
  ('PER-AMORTIZE-PREPAID', 'propose', 'posts the period''s amortization into the general ledger', true),
  ('PER-SPLIT-LOANPAYMENT', 'propose', 'posts principal, interest and escrow into the general ledger from a schedule that a refinance can silently invalidate', true),
  ('PER-POST-ACCRUALS', 'propose', 'posts accrual entries into the general ledger', true),
  ('PER-POST-DEPRECIATION', 'propose', 'posts depreciation into the general ledger', true),
  ('AR-APPLY-PAYMENTS', 'propose', 'posts cash against invoices, which changes what a customer owes and is a general ledger write', true),
  ('AP-APPLY-DISCOUNTS', 'propose', 'settles a payable early and posts the discount, which is a general ledger write', true),
  ('AR-CHARGE-LATEFEES', 'propose', 'a late fee has an outside party on the other end of it, and a fee charged in error is a phone call from a customer rather than a row somebody quietly fixes', false),
  ('AR-WRITEOFF-UNCOLLECTIBLE', 'propose', 'writing off a receivable gives up on collecting from a named customer and posts the loss, so the run prepares the writeoff proposal and a person decides', true),
  ('ARAP-REFRESH-AGING', 'unattended', 'recomputes the aging snapshot from invoices and payments that already exist, which is derived and posts nothing', false),
  ('AR-BUILD-STATEMENTS', 'propose', 'a statement is a document a customer reads, so it is built and held rather than released by a clock', false),
  ('SUB-TIEOUT-ACCOUNTS', 'unattended', 'compares a subledger against its control account and records the difference, which is a measurement', false),
  ('SUB-RAISE-REQUESTS', 'propose', 'raises document requests the client sees and has to answer, which is correspondence and not bookkeeping', false),
  ('CLOSE-CHECK-GATES', 'unattended', 'evaluates the close gates and records pass or fail, which changes nothing and is the report a person reads before deciding', false),
  ('CLOSE-LOCK-PERIOD', 'manual', 'a clock must not lock a period, because the lock is the firm''s assertion that the period is finished and every later correction has to be redated around it', false),
  ('CLOSE-ROLL-FORWARD', 'propose', 'carries balances into the next period and is only correct once the period behind it is closed, which is a manual act it cannot verify happened for the right reason', false),
  ('CLOSE-POST-YEAREND', 'manual', 'posts the year end closing entries, which zero the income statement into equity, and a year that closes itself on a clock is a year nobody signed off', true),
  ('RPT-BUILD-PACKAGE', 'unattended', 'renders a snapshot of figures that are already on the books, and posts nothing', false),
  ('RPT-FLAG-VARIANCES', 'unattended', 'compares the package against budget and flags the gaps, which is derived', false),
  ('RPT-REBUILD-FORECAST', 'unattended', 'recomputes the cash forecast from current balances, and a forecast is a projection nobody posts', false),
  ('RPT-COMPOSE-NARRATIVE', 'unattended', 'writes a description of what the other three reporting runs found into the package, where releasing the package to a client is a separate act', false),
  ('TAX-BUILD-1099', 'propose', 'compiles the data set behind a government filing with named payees on it, and the amounts are attested by a person before anybody files them', false),
  ('TAX-TRACK-W9', 'unattended', 'refreshes the W-9 status of each payee from the documents already in the vault, and contacts nobody', false),
  ('PRAC-GENERATE-TASKS', 'unattended', 'creates the firm''s own workload for the period from its own catalog, and is idempotent per period', false),
  ('PRAC-ESCALATE-OVERDUE', 'unattended', 'raises an internal notice about the firm''s own overdue work, which nobody outside the firm sees', false),
  ('PRAC-NUDGE-REQUESTS', 'propose', 'a nudge is a message to the client, and how often a client is chased is a relationship decision rather than a cadence', false),
  ('PAY-APPROVE-RUN', 'manual', 'approval is the human act itself, and a clock that approves a payroll has removed the only review the posting step depends on', false),
  ('PAY-POST-REGISTER', 'propose', 'posts the payroll register into the general ledger, which is a ledger write even though it disburses nothing', true),
  ('CPA-BUILD-HANDOFF', 'propose', 'builds the archive an outside CPA works from, and which period is handed over is a decision the firm makes once', false),
  ('OFFBOARD-BUILD-EXPORT', 'manual', 'a client is offboarded because a contract ended, which is a fact no table in this system holds, so nothing here should be able to start it', false);

commit;
