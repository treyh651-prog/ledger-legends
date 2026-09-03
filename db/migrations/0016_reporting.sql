-- 0016_reporting.sql
-- Doc 02 module 8. Reporting, which has no storage yet.
--
-- Migrations 0001 through 0015 built the ledger, the import pipeline, the
-- coding cascade, reconciliation, the period end subledgers, the receivable and
-- payable subledger, and the close. None of them created a place to record a
-- report package, a budget, a budget variance, a cash forecast, or a period
-- narrative. The four module 8 runs cannot be written against the schema as it
-- stands, so this migration creates the report schema rather than only adding
-- columns.
--
-- What is created here, and why each table has to exist:
--
--   1. report.budgets. RPT-FLAG-VARIANCES compares actual to budget, and there
--      is no budget anywhere in migrations 0001 through 0015. One row per
--      client per period per account, carrying an integer cents figure in the
--      ledger sign convention, is the smallest thing that makes the comparison
--      possible. See NOTES.md entry 100.
--   2. report.budget_thresholds. The flag rule takes an absolute cents floor
--      and a basis point threshold, and the brief asks for a per account
--      override of the percentage. A row with a null account number is the
--      client default and a row with an account number overrides it for that
--      account. See NOTES.md entry 99.
--   3. report.report_packages. The header of one period package: the period, the
--      basis, the comparison basis, the watermark, the exception banner state,
--      the content checksum, the ledger fingerprint it was built from, and the
--      vault retention stamps required by D7.
--   4. report.report_sections. One row per catalog section, carrying its figures
--      as a jsonb snapshot. The figures are a snapshot and not a live query,
--      because a package regenerated a year later has to show the numbers it
--      showed on delivery day.
--   5. report.report_variances. One row per evaluated account per period,
--      flagged or not, with both thresholds recorded on the row so a reader a
--      year later can see what the comparison was made against.
--   6. report.cash_forecast_runs and report.cash_forecast_weeks. A header per
--      rebuild with its scenario and parameters, and thirteen week rows under
--      it. The week rows carry their source items as jsonb so no forecast line
--      exists without a source document id.
--   7. report.report_narratives. One draft per client per period per audience,
--      holding the selected sentences, the full trigger log, and the assembled
--      body text.
--   8. report.payroll_approvals. The forecast reads approved payroll, and no
--      table in this schema carries a future dated approved payroll amount. See
--      NOTES.md entry 103.
--   9. report.report_audit_events. The module sends nothing. Its only delivery
--      side effect is an audit row of type report_available or
--      narrative_available. vault.audit_events constrains its action column to
--      a list that does not contain either value, so the reporting audit trail
--      gets its own table rather than a loosened constraint on the vault. See
--      NOTES.md entry 102.
--
-- Vault retention lives on the package row rather than in vault.documents. A
-- run has no bytes to upload and cannot satisfy the scan and magic verification
-- columns vault.documents requires before a document is usable, so the package
-- carries the object key it will occupy, the governance lock mode, the
-- retention start at period end, and the seven year lock date. See NOTES.md
-- entry 101.
--
-- Every money column is bigint integer cents, debit positive and credit
-- negative, per doc 00 Part 1. Every table a run writes carries a version
-- column and the manual override columns with the override guard trigger,
-- because the override contract in doc 03 Part 6 is a property of the store.
--
-- COMPLIANCE. Nothing here computes a tax liability, states an opinion, or
-- offers assurance. A narrative row holds descriptive prose assembled from
-- stored figures by a fixed template. There is no delivery column and no
-- external address column anywhere in this migration, because no run in this
-- module sends anything.
--
-- CONSTRAINT. No model, no score, no learned parameter. Every column here holds
-- either a figure another run produced or a stored threshold a person set.
--
-- Forward only. No down migration.

begin;

create schema if not exists report;

-- ---------------------------------------------------------------------------
-- 1. Budgets. The other half of a variance.
--
-- The sign convention is the ledger convention, so a revenue budget is a credit
-- and an expense budget is a debit. Storing budgets as positive magnitudes
-- would force every comparison to know which way to flip, and that knowledge
-- would then live in two places.
-- ---------------------------------------------------------------------------

create table report.budgets (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  period_start   date not null,
  period_end     date not null,
  account_number char(4) not null,
  class_id       char(26),
  location_id    char(26),
  program_id     char(26),
  budget_cents   bigint not null,
  source         text not null default 'entered',

  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint budget_one_per_account unique (client_id, period_start, account_number),
  constraint budget_window check (period_end >= period_start),
  constraint budget_source check (source in ('entered', 'imported', 'rolled_forward'))
);

create index budgets_period on report.budgets (client_id, period_start);

-- ---------------------------------------------------------------------------
-- 2. Budget thresholds. The client default and the per account override.
--
-- A null account number is the client default. An account number names the one
-- account the row overrides. The unique constraint is on the pair, so a client
-- has at most one default and at most one override per account.
-- ---------------------------------------------------------------------------

create table report.budget_thresholds (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  -- Null means this row is the client wide default.
  account_number char(4),
  variance_floor_cents bigint not null default 50000,
  variance_threshold_bp integer not null default 1000,
  note           text not null default '',

  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint threshold_one_per_subject unique (client_id, account_number),
  constraint threshold_floor_sign check (variance_floor_cents >= 0),
  constraint threshold_bp_sign check (variance_threshold_bp >= 0)
);

-- ---------------------------------------------------------------------------
-- 3. Report packages. The header of one assembled period package.
--
-- The content checksum is the reason two executions over the same locked period
-- can be proved identical. The ledger fingerprint is the reason a rebuild after
-- a posting produces a fresh package instead of a stale deduplication hit: it
-- is part of the scope hash of the run, and it is stored here so a reader can
-- see which ledger the package describes.
-- ---------------------------------------------------------------------------

create table report.report_packages (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  period_start   date not null,
  period_end     date not null,
  basis          text not null default 'accrual',
  comparison_basis text not null default 'prior_period',
  comparison_available boolean not null default false,
  comparison_note text not null default '',
  state          text not null default 'draft',
  -- Doc 02 rule 1. An open period is packaged, and the watermark says so on
  -- every page. Null once the period is locked.
  watermark      text,
  closed_with_exceptions boolean not null default false,
  exception_banner text,
  section_count  integer not null default 0,
  omission_count integer not null default 0,
  content_checksum text not null,
  ledger_fingerprint text not null,

  -- D7. Governance mode, retention starting at period end, seven years.
  vault_object_key text not null,
  vault_object_lock_mode text not null default 'GOVERNANCE',
  vault_retention_starts_on date not null,
  vault_object_lock_until date not null,

  built_by_run_id char(31),
  built_at       timestamptz not null,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint package_one_per_period unique (client_id, period_start, comparison_basis),
  constraint package_window check (period_end >= period_start),
  constraint package_state check (state in ('draft', 'superseded')),
  constraint package_basis check (basis in ('accrual', 'cash')),
  constraint package_comparison check (
    comparison_basis in ('prior_period', 'prior_year', 'budget', 'none')),
  -- D7 allows governance mode only. Compliance mode cannot be shortened by
  -- anybody, and a seven year hold with no exit is a problem with no exit.
  constraint package_lock_mode check (vault_object_lock_mode = 'GOVERNANCE'),
  constraint package_retention_after_period check (
    vault_retention_starts_on >= period_end),
  constraint package_lock_after_retention check (
    vault_object_lock_until > vault_retention_starts_on),
  constraint package_counts check (section_count >= 0 and omission_count >= 0)
);

create index report_packages_period on report.report_packages (client_id, period_start);

-- ---------------------------------------------------------------------------
-- 4. Report sections. One row per catalog section, figures frozen as jsonb.
--
-- The sequence column carries the catalog order, never the selection order, so
-- every package for every client has the same shape. A section that could not
-- be rendered is stored with status omitted and a written reason rather than
-- being left out, because a missing section that says nothing is the section a
-- reader will not notice is missing.
-- ---------------------------------------------------------------------------

create table report.report_sections (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  package_id     char(26) not null references report.report_packages(id),
  sequence       integer not null,
  section_code   text not null,
  section_title  text not null,
  status         text not null,
  omission_reason text,
  as_of_date     date not null,
  -- Doc 02 rule 5. The banner prints on every statement header and cannot be
  -- suppressed by a section selection, so it is stored per section.
  banner_text    text,
  lines          jsonb not null default '[]'::jsonb,
  content_checksum text not null,

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint section_one_per_package unique (package_id, section_code),
  constraint section_status check (status in ('rendered', 'omitted')),
  constraint section_sequence check (sequence > 0),
  constraint section_reason_present check (
    (status = 'omitted' and omission_reason is not null)
    or (status = 'rendered' and omission_reason is null))
);

create index report_sections_package on report.report_sections (package_id, sequence);

-- ---------------------------------------------------------------------------
-- 5. Variance flags. One row per evaluated account, flagged or not.
--
-- Both thresholds are copied onto the row. A flag read six months later has to
-- say what it was compared against, and a live read of the threshold table
-- would answer with whatever the threshold is today.
--
-- The percentage column is null where the budget is zero, because there is no
-- percentage to state and a zero there would read as no variance.
-- ---------------------------------------------------------------------------

create table report.report_variances (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  period_start   date not null,
  period_end     date not null,
  account_number char(4) not null,
  account_name   text not null,

  actual_cents   bigint not null,
  budget_cents   bigint not null,
  variance_cents bigint not null,
  -- Variance times 10000 over the absolute budget, in basis points. Null when
  -- the budget is exactly zero, where no division is attempted.
  variance_bp    integer,
  direction      text not null,
  flagged        boolean not null default false,
  flag_code      text not null,
  floor_cents    bigint not null,
  threshold_bp   integer not null,
  detail         text not null default '',

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint variance_one_per_account unique (client_id, period_start, account_number),
  constraint variance_direction check (
    direction in ('favorable', 'unfavorable', 'neutral')),
  constraint variance_flag_code check (
    flag_code in ('within_threshold', 'over_threshold', 'unbudgeted_activity')),
  -- A zero budget can never carry a percentage, and a non zero budget always
  -- can. The schema refuses both of the other two combinations.
  constraint variance_bp_present check (
    (budget_cents = 0 and variance_bp is null)
    or (budget_cents <> 0 and variance_bp is not null))
);

create index report_variances_flagged on report.report_variances (client_id, period_start, flagged);

-- ---------------------------------------------------------------------------
-- 6a. Cash forecast headers. One per rebuild, per scenario.
--
-- The scenario parameters are stored on the header because doc 02 rule 4 says a
-- scenario the reader cannot see the parameters of is not a forecast. A reader
-- of the header can always state the shift in days and the multiplier in basis
-- points that produced the weeks below it.
-- ---------------------------------------------------------------------------

create table report.cash_forecast_runs (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  period_start   date not null,
  period_end     date not null,
  start_date     date not null,
  end_date       date not null,
  horizon_weeks  integer not null default 13,
  scenario       text not null default 'base',
  slow_shift_days integer not null default 30,
  shortfall_bp   integer not null default 8000,
  use_history    boolean not null default false,

  opening_cash_cents bigint not null,
  total_inflow_cents bigint not null default 0,
  total_outflow_cents bigint not null default 0,
  closing_cash_cents bigint not null,
  first_shortfall_week integer,
  shortfall_week_count integer not null default 0,
  item_count     integer not null default 0,
  ledger_fingerprint text not null,

  built_by_run_id char(31),
  built_at       timestamptz not null,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint forecast_one_per_scenario unique (client_id, period_start, scenario),
  constraint forecast_horizon check (horizon_weeks = 13),
  constraint forecast_scenario check (
    scenario in ('base', 'slow_collections', 'revenue_shortfall')),
  constraint forecast_window check (end_date > start_date),
  constraint forecast_shortfall_week check (
    first_shortfall_week is null
    or (first_shortfall_week between 1 and horizon_weeks))
);

-- ---------------------------------------------------------------------------
-- 6b. Cash forecast weeks. Thirteen rows under each header.
--
-- Closing equals opening plus inflow minus outflow, and the schema checks it,
-- because a forecast whose weeks do not foot is not a forecast. The items
-- column holds the source rows that produced the week, so no line exists
-- without a source document id or a manual entry id.
-- ---------------------------------------------------------------------------

create table report.cash_forecast_weeks (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  forecast_run_id char(26) not null references report.cash_forecast_runs(id),
  week_number    integer not null,
  week_start     date not null,
  week_end       date not null,

  opening_cents  bigint not null,
  ar_inflow_cents bigint not null default 0,
  other_inflow_cents bigint not null default 0,
  ap_outflow_cents bigint not null default 0,
  recurring_outflow_cents bigint not null default 0,
  loan_outflow_cents bigint not null default 0,
  payroll_outflow_cents bigint not null default 0,
  inflow_cents   bigint not null default 0,
  outflow_cents  bigint not null default 0,
  closing_cents  bigint not null,
  shortfall      boolean not null default false,
  items          jsonb not null default '[]'::jsonb,

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint forecast_week_one_per_run unique (forecast_run_id, week_number),
  constraint forecast_week_number check (week_number between 1 and 13),
  constraint forecast_week_window check (week_end > week_start),
  constraint forecast_week_foots check (
    closing_cents = opening_cents + inflow_cents - outflow_cents),
  constraint forecast_week_inflow_parts check (
    inflow_cents = ar_inflow_cents + other_inflow_cents),
  constraint forecast_week_outflow_parts check (
    outflow_cents = ap_outflow_cents + recurring_outflow_cents
      + loan_outflow_cents + payroll_outflow_cents)
);

create index forecast_weeks_run on report.cash_forecast_weeks (forecast_run_id, week_number);

-- ---------------------------------------------------------------------------
-- 7. Narrative drafts. One per client per period per audience.
--
-- The draft is always editable and always a draft. The manual_edit column is
-- what stops a regeneration from writing over words a person wrote, which doc
-- 02 states as the skip reason manual_edit_present.
--
-- The trigger log is stored whole. Doc 02 requires that no sentence appears
-- whose trigger did not fire, and that claim is only checkable if the triggers
-- that did not fire are recorded next to the ones that did.
-- ---------------------------------------------------------------------------

create table report.report_narratives (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  period_start   date not null,
  period_end     date not null,
  audience       text not null default 'owner',
  comparison_basis text not null default 'prior_period',
  state          text not null default 'draft',
  sentence_count integer not null default 0,
  dropped_count  integer not null default 0,
  max_sentences_per_section integer not null default 5,
  sentences      jsonb not null default '[]'::jsonb,
  trigger_log    jsonb not null default '[]'::jsonb,
  body_text      text not null default '',
  content_checksum text not null,
  ledger_fingerprint text not null,
  manual_edit    boolean not null default false,

  composed_by_run_id char(31),
  composed_at    timestamptz not null,
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint narrative_one_per_audience unique (client_id, period_start, audience),
  constraint narrative_audience check (audience in ('owner', 'lender')),
  -- A narrative is a draft. There is no sent state here, because nothing in
  -- this module sends anything.
  constraint narrative_state check (state = 'draft'),
  constraint narrative_counts check (sentence_count >= 0 and dropped_count >= 0),
  constraint narrative_cap check (max_sentences_per_section > 0)
);

-- ---------------------------------------------------------------------------
-- 8. Payroll approvals. A future dated approved payroll amount.
--
-- The forecast reads approved payroll and nothing in migrations 0001 through
-- 0015 carries one. A recurring template is a posting instruction and a payroll
-- register substantiates a balance already on the books, so neither answers the
-- question the forecast asks, which is how much leaves the bank on a named day.
-- ---------------------------------------------------------------------------

create table report.payroll_approvals (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  pay_date       date not null,
  -- Total cash leaving the bank, stated as a positive magnitude.
  amount_cents   bigint not null,
  funding_account char(4) not null,
  status         text not null default 'approved',
  approved_by    uuid,
  approved_on    date,
  detail         text not null default '',

  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint payroll_status check (status in ('approved', 'draft', 'paid', 'void')),
  constraint payroll_amount_sign check (amount_cents >= 0)
);

create index payroll_approvals_date on report.payroll_approvals (client_id, pay_date);

-- ---------------------------------------------------------------------------
-- 9. Reporting audit events. The whole of this module's delivery surface.
--
-- Nothing in module 8 sends. A package that finished building records that it
-- is available, a narrative that finished composing records the same, and a
-- person is the one who decides anything leaves the firm. Two action values,
-- and no address column to send to.
-- ---------------------------------------------------------------------------

create table report.report_audit_events (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  version        integer not null default 1,

  period_start   date not null,
  action         text not null,
  subject_table  text not null,
  subject_id     char(26) not null,
  detail         text not null default '',

  created_by_run_id char(31),
  created_at     timestamptz not null default now(),
  manual_override boolean not null default false,
  manual_override_by uuid,
  manual_override_at timestamptz,

  constraint report_audit_one_per_subject unique (client_id, action, subject_id),
  constraint report_audit_action check (
    action in ('report_available', 'narrative_available'))
);

-- ---------------------------------------------------------------------------
-- 10. Row level security, discriminator freeze, and the override guard.
--
-- Same three properties every table in 0013, 0014 and 0015 carries. Tenant
-- isolation is a policy on the row and not a predicate a run remembers to add,
-- the discriminator columns cannot be edited after insert, and a row carrying
-- the manual override flag refuses an automated write.
-- ---------------------------------------------------------------------------

alter table report.budgets enable row level security;
alter table report.budgets force row level security;
alter table report.budget_thresholds enable row level security;
alter table report.budget_thresholds force row level security;
alter table report.report_packages enable row level security;
alter table report.report_packages force row level security;
alter table report.report_sections enable row level security;
alter table report.report_sections force row level security;
alter table report.report_variances enable row level security;
alter table report.report_variances force row level security;
alter table report.cash_forecast_runs enable row level security;
alter table report.cash_forecast_runs force row level security;
alter table report.cash_forecast_weeks enable row level security;
alter table report.cash_forecast_weeks force row level security;
alter table report.report_narratives enable row level security;
alter table report.report_narratives force row level security;
alter table report.payroll_approvals enable row level security;
alter table report.payroll_approvals force row level security;
alter table report.report_audit_events enable row level security;
alter table report.report_audit_events force row level security;

create policy client_isolation on report.budgets
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on report.budget_thresholds
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on report.report_packages
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on report.report_sections
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on report.report_variances
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on report.cash_forecast_runs
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on report.cash_forecast_weeks
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on report.report_narratives
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on report.payroll_approvals
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on report.report_audit_events
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on report.budgets
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on report.budget_thresholds
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on report.report_packages
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on report.report_sections
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on report.report_variances
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on report.cash_forecast_runs
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on report.cash_forecast_weeks
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on report.report_narratives
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on report.payroll_approvals
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on report.report_audit_events
  for each row execute function tenancy.freeze_discriminators();

create trigger trg_guard_manual_override before update on report.budgets
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on report.budget_thresholds
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on report.report_packages
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on report.report_sections
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on report.report_variances
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on report.cash_forecast_runs
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on report.cash_forecast_weeks
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on report.report_narratives
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on report.payroll_approvals
  for each row execute function ledger.guard_manual_override();
create trigger trg_guard_manual_override before update on report.report_audit_events
  for each row execute function ledger.guard_manual_override();

commit;
