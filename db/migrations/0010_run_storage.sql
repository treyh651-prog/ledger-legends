-- 0010_run_storage.sql
-- Implements the storage the remaining new runs in doc 05 need.
--   Doc 05 Part 6 (D5): PAY-APPROVE-RUN and PAY-POST-REGISTER need an approval
--   record tied to a payroll register document that is already in the vault.
--   The firm never moves money, so the record states that in a column that can
--   only hold one value.
--   Doc 05 Part 5 (D4): CPA-BUILD-HANDOFF needs a package header, an item per
--   artifact, and the written statement of what the firm did and did not do.
--   Doc 05 Part 7 (D9): OFFBOARD-BUILD-EXPORT needs an export header, a file
--   manifest with a row count and a checksum per file, and the fifteen business
--   day due date carried as data.
-- Money is bigint cents. Every table carries both discriminators, RLS enabled and
-- forced, and a leading client_id index.
-- Forward only. No down migration.

begin;

create schema if not exists deliverable;
grant usage on schema deliverable to app_web, app_worker;

-- ---------------------------------------------------------------------------
-- Payroll approval records. Doc 05 Part 6.
-- ---------------------------------------------------------------------------

create table subledger.payroll_approvals (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  provider_name  text not null,
  pay_period_start date not null,
  pay_period_end   date not null,
  pay_date       date not null,
  employee_count integer,

  -- The register in the vault is the evidence that makes gate G11 meaningful.
  -- PAY-POST-REGISTER refuses to run against a manually keyed total.
  register_document_id char(26) not null references vault.documents(id),

  gross_cents             bigint not null,
  employer_tax_cents      bigint not null default 0,
  employee_withholding_cents bigint not null default 0,
  net_cents               bigint not null,

  status         text not null default 'approved',
  approved_by    uuid not null,
  approved_at    timestamptz not null default now(),
  approval_statement text not null,
  -- Approval is review, never disbursement authority. The column exists so the
  -- distinction is enforced rather than described.
  authorizes_disbursement boolean not null default false,

  approval_run_id char(26),
  posting_run_id  char(26),
  posted_entry_id char(26) references ledger.journal_entries(id),
  posted_at      timestamptz,

  manual_override boolean not null default false,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  constraint pay_status check (status in ('approved','posted','rejected','superseded')),
  constraint pay_period_sane check (pay_period_end >= pay_period_start),
  constraint pay_amounts_nonneg check (
    gross_cents >= 0 and employer_tax_cents >= 0
    and employee_withholding_cents >= 0 and net_cents >= 0),
  constraint pay_net_within_gross check (net_cents <= gross_cents),
  constraint pay_no_disbursement_authority check (authorizes_disbursement = false),
  constraint pay_posted_complete check (
    status <> 'posted' or (posted_entry_id is not null and posted_at is not null)),
  constraint pay_employee_count check (employee_count is null or employee_count >= 0),
  unique (client_id, provider_name, pay_date, pay_period_start)
);

create index on subledger.payroll_approvals (client_id, pay_date desc);
create index on subledger.payroll_approvals (client_id, status);
create index on subledger.payroll_approvals (firm_id);
create index on subledger.payroll_approvals (register_document_id);

alter table subledger.payroll_approvals enable row level security;
alter table subledger.payroll_approvals force row level security;
create policy client_isolation on subledger.payroll_approvals
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create trigger trg_freeze_discriminators before update on subledger.payroll_approvals
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_guard_manual_override before update on subledger.payroll_approvals
  for each row execute function ledger.guard_manual_override();

-- ---------------------------------------------------------------------------
-- CPA handoff packages. Doc 05 Part 5.
-- ---------------------------------------------------------------------------

create table deliverable.cpa_handoff_packages (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  tax_year       integer not null,
  period_start   date not null,
  period_end     date not null,
  reporting_basis text not null default 'both',

  status         text not null default 'building',
  built_run_id   char(26),
  built_at       timestamptz,

  -- The point of the run. Compiled bookkeeping, not an audit, not a review, not a
  -- compilation report under professional standards, and not tax advice.
  scope_statement text not null,
  archive_document_id char(26) references vault.documents(id),
  manifest       jsonb not null default '{}',
  sha256_hex     char(64),
  file_count     integer not null default 0,
  total_bytes    bigint not null default 0,

  delivered_at   timestamptz,
  delivered_to   text,
  delivered_by   uuid,
  created_at     timestamptz not null default now(),
  created_by     uuid not null,

  unique (client_id, tax_year, period_start, period_end),
  constraint cpa_status check (status in ('building','complete','delivered','superseded','failed')),
  constraint cpa_basis check (reporting_basis in ('accrual','cash','both')),
  constraint cpa_period_sane check (period_end >= period_start),
  constraint cpa_complete_has_archive check (
    status not in ('complete','delivered')
    or (archive_document_id is not null and sha256_hex is not null and built_at is not null)),
  constraint cpa_delivered_complete check (
    status <> 'delivered' or (delivered_at is not null and delivered_to is not null)),
  constraint cpa_counts_nonneg check (file_count >= 0 and total_bytes >= 0)
);

create table deliverable.cpa_handoff_items (
  id             char(26) primary key,
  package_id     char(26) not null references deliverable.cpa_handoff_packages(id),
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  artifact_kind  text not null,
  reporting_basis text,
  file_name      text not null,
  file_format    text not null,
  row_count      integer,
  byte_size      bigint,
  sha256_hex     char(64),
  document_id    char(26) references vault.documents(id),
  detail         jsonb not null default '{}',
  created_at     timestamptz not null default now(),

  unique (package_id, file_name),
  -- One value per content item listed in doc 05 Part 5.
  constraint cpa_item_kind check (artifact_kind in (
    'trial_balance','general_ledger_detail','balance_sheet','income_statement',
    'fixed_asset_register','loan_amortization_detail','payee_1099_data_set',
    'w9_exception_list','accrual_schedule','prepaid_schedule','tie_out_results',
    'suspense_history','scope_statement')),
  constraint cpa_item_basis check (reporting_basis is null
    or reporting_basis in ('accrual','cash','both')),
  constraint cpa_item_format check (file_format in ('csv','xlsx','pdf','json','txt')),
  constraint cpa_item_counts check (
    (row_count is null or row_count >= 0) and (byte_size is null or byte_size >= 0))
);

create index on deliverable.cpa_handoff_packages (client_id, tax_year desc);
create index on deliverable.cpa_handoff_packages (firm_id);
create index on deliverable.cpa_handoff_items (client_id, package_id);
create index on deliverable.cpa_handoff_items (firm_id);

-- ---------------------------------------------------------------------------
-- Offboarding exports. Doc 05 Part 7 (D9). Open formats only, no fee, fifteen
-- business days, and a manifest with a row count and a checksum per file.
-- ---------------------------------------------------------------------------

create table deliverable.offboarding_exports (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  engagement_id  uuid references tenancy.engagements(id),

  requested_at   timestamptz not null default now(),
  requested_by   uuid not null,
  due_on         date not null,               -- fifteen business days from the request
  status         text not null default 'requested',

  built_run_id   char(26),
  built_at       timestamptz,
  archive_document_id char(26) references vault.documents(id),
  manifest_document_id char(26) references vault.documents(id),
  sha256_hex     char(64),
  file_count     integer not null default 0,
  total_bytes    bigint not null default 0,
  document_count integer not null default 0,
  period_start   date,
  period_end     date,

  delivered_at   timestamptz,
  delivered_to   text,
  delivery_method text,
  notes          text,

  constraint off_status check (status in (
    'requested','building','complete','delivered','cancelled','failed')),
  constraint off_complete_has_archive check (
    status not in ('complete','delivered')
    or (archive_document_id is not null and manifest_document_id is not null
        and sha256_hex is not null and built_at is not null)),
  constraint off_delivered_complete check (
    status <> 'delivered' or (delivered_at is not null and delivered_to is not null)),
  constraint off_counts_nonneg check (
    file_count >= 0 and total_bytes >= 0 and document_count >= 0),
  constraint off_period_sane check (
    period_end is null or period_start is null or period_end >= period_start)
);

create table deliverable.offboarding_export_files (
  id             char(26) primary key,
  export_id      char(26) not null references deliverable.offboarding_exports(id),
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  path           text not null,               -- folder tree by year and type
  artifact_kind  text not null,
  file_format    text not null,
  row_count      integer,
  byte_size      bigint not null,
  sha256_hex     char(64) not null,
  source_document_id char(26) references vault.documents(id),
  created_at     timestamptz not null default now(),

  unique (export_id, path),
  constraint off_file_kind check (artifact_kind in (
    'chart_of_accounts','categories','category_account_map','journal_entries',
    'journal_lines','ar_register','ap_register','fixed_asset_register','loan_register',
    'deferral_register','inventory_register','trial_balance','balance_sheet',
    'income_statement','vault_document','manifest')),
  -- Open formats only. The point is that the next bookkeeper can use it.
  constraint off_file_format check (file_format in (
    'csv','json','txt','pdf','png','jpg','tiff','xlsx','docx','eml','msg','heic')),
  constraint off_file_hash check (sha256_hex ~ '^[0-9a-f]{64}$'),
  constraint off_file_counts check (
    byte_size >= 0 and (row_count is null or row_count >= 0))
);

create index on deliverable.offboarding_exports (client_id, requested_at desc);
create index on deliverable.offboarding_exports (client_id, status);
create index on deliverable.offboarding_exports (firm_id);
create index on deliverable.offboarding_export_files (client_id, export_id);
create index on deliverable.offboarding_export_files (firm_id);

-- ---------------------------------------------------------------------------
-- RLS on everything in this migration.
-- ---------------------------------------------------------------------------

alter table deliverable.cpa_handoff_packages enable row level security;
alter table deliverable.cpa_handoff_packages force row level security;
alter table deliverable.cpa_handoff_items enable row level security;
alter table deliverable.cpa_handoff_items force row level security;
alter table deliverable.offboarding_exports enable row level security;
alter table deliverable.offboarding_exports force row level security;
alter table deliverable.offboarding_export_files enable row level security;
alter table deliverable.offboarding_export_files force row level security;

create policy client_isolation on deliverable.cpa_handoff_packages
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on deliverable.cpa_handoff_items
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on deliverable.offboarding_exports
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on deliverable.offboarding_export_files
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on deliverable.cpa_handoff_packages
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on deliverable.cpa_handoff_items
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on deliverable.offboarding_exports
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on deliverable.offboarding_export_files
  for each row execute function tenancy.freeze_discriminators();

commit;
