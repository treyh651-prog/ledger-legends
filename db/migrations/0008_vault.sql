-- 0008_vault.sql
-- Implements doc 04 Part 12 (document metadata and audit events). Doc 04 Part 13 row 0008.
-- Amendments folded in before writing:
--   Doc 05 Part 3 (D2): the document type list is extended with invoice_ap,
--   invoice_ar, processor_statement, insurance_policy, lease, formation_document,
--   payroll_register and correspondence, and the intake safety rules become columns:
--   a one hundred megabyte ceiling, magic byte verification of the content type,
--   a scan result that must be clean before a document is linkable, and a derived
--   preview object key beside the untouched original.
--   Doc 05 Part 7 (D7): seven year retention with Object Lock in governance mode
--   only, and retention starts at the document period end rather than upload date.
--   Doc 05 Part 7 (D8): the engagement signature evidence tables.
-- Bytes live in S3. This schema holds metadata and the audit trail. No URLs, no
-- credentials, no bytes, and no taxpayer identification numbers.
-- Forward only. No down migration.

begin;

create schema if not exists vault;
grant usage on schema vault to app_web, app_worker;

create table vault.documents (
  id             char(26) primary key,        -- ULID, and part of the object key
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  doc_type       text not null,
  title          text not null,
  period_start   date,
  period_end     date,
  tax_year       integer,

  -- S3 coordinates. No URLs, no credentials, no bytes.
  bucket         text not null,
  object_key     text not null,
  s3_version_id  text,
  storage_class  text not null default 'STANDARD',
  kms_key_alias  text not null,
  object_lock_mode text,
  object_lock_until date,
  -- Doc 05 D7. Retention runs from the period the document belongs to.
  retention_starts_on date,

  byte_size      bigint,
  content_type   text,
  sha256_hex     char(64),
  -- Doc 05 Part 3, size and safety.
  magic_verified boolean not null default false,
  scan_status    text not null default 'pending',
  scanned_at     timestamptz,
  preview_object_key text,

  status         text not null default 'pending',
  uploaded_at    timestamptz,
  head_verified_at timestamptz,

  linked_vendor_id char(26),
  linked_asset_id  char(26),
  linked_loan_id   char(26),
  linked_transaction_id char(26),
  request_id     char(26),                    -- portal request this satisfied
  contains_tin   boolean not null default false,

  uploaded_by    uuid,
  created_at     timestamptz not null default now(),
  archived_at    timestamptz,

  constraint doc_type_check check (doc_type in (
    'bank_statement','card_statement','w9','engagement_letter','invoice','receipt',
    'loan_agreement','asset_invoice','payroll_report','tax_return','other',
    'invoice_ap','invoice_ar','processor_statement','insurance_policy','lease',
    'formation_document','payroll_register','correspondence')),
  constraint doc_status check (status in ('pending','uploaded','verified','quarantined','failed')),
  -- The object key must embed the tenant path, so a mismatch is unsaveable.
  constraint doc_key_shape check (
    object_key = 'firm/' || firm_id::text || '/client/' || client_id::text
                 || '/' || id || '/' || split_part(object_key, '/', 6)),
  -- Doc 05 D7. Governance mode only. Compliance mode cannot be shortened by anyone
  -- for any reason, and a seven year hold on a document you were asked to delete is
  -- a problem with no exit.
  constraint doc_lock_mode check (object_lock_mode is null or object_lock_mode = 'GOVERNANCE'),
  constraint doc_lock_window check (
    object_lock_until is null or retention_starts_on is null
    or object_lock_until >= retention_starts_on),
  constraint doc_verified_needs_head check (
    status not in ('uploaded','verified') or head_verified_at is not null),
  constraint doc_hash_when_verified check (status <> 'verified' or sha256_hex is not null),
  -- Long retention prefixes must carry a lock.
  constraint doc_retention_for_sensitive check (
    doc_type not in ('engagement_letter','bank_statement','card_statement','w9',
                     'payroll_register','payroll_report','tax_return')
    or object_lock_mode is not null),
  -- Doc 05 Part 3. One hundred megabytes, magic bytes, clean scan before linkable.
  constraint doc_size_ceiling check (byte_size is null or byte_size <= 104857600),
  constraint doc_scan_status check (scan_status in ('pending','clean','infected','failed')),
  constraint doc_scan_before_use check (
    status not in ('uploaded','verified') or (scan_status = 'clean' and magic_verified)),
  constraint doc_scanned_at check (scan_status = 'pending' or scanned_at is not null)
);

create unique index doc_one_key on vault.documents (bucket, object_key);
create index on vault.documents (client_id, doc_type, period_start desc);
create index on vault.documents (firm_id);
create index on vault.documents (client_id, status) where status <> 'verified';
create index on vault.documents (client_id, tax_year) where doc_type = 'w9';

create table vault.audit_events (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  document_id    char(26) references vault.documents(id),
  action         text not null,
  actor_id       uuid,
  actor_kind     text not null,
  presigned_expires_at timestamptz,
  ip_inet        inet,
  user_agent     text,
  run_id         char(26),
  detail         jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  constraint audit_action check (action in (
    'row_created','presigned_put_issued','head_verified','presigned_get_issued',
    'download_completed','metadata_updated','archived','restored_from_version',
    'lock_applied','access_denied','scan_completed'))
);

create index on vault.audit_events (client_id, created_at desc);
create index on vault.audit_events (document_id, created_at desc);
create index on vault.audit_events (firm_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Doc 05 Part 7 (D8). Engagement letter signature evidence. A typed name alone is
-- not sufficient if a client later disputes scope. Everything here is captured at
-- the moment of signing, because none of it can be reconstructed afterward.
-- ---------------------------------------------------------------------------

create table vault.signature_evidence (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  document_id    char(26) not null references vault.documents(id),
  engagement_id  uuid references tenancy.engagements(id),

  -- The exact bytes presented, so the signed version can be proven later.
  document_sha256_hex char(64) not null,
  document_byte_size  bigint not null,

  signer_name    text not null,
  signer_email   text not null,
  signer_user_id uuid references tenancy.users(id),   -- null when unauthenticated
  signer_title   text,

  -- Server time only. A client supplied timestamp is not evidence.
  signed_at      timestamptz not null default now(),
  signer_ip      inet not null,
  user_agent     text not null,

  -- Consent to electronic signature, recorded as its own event and pointed at here.
  consent_event_id char(26),
  consent_given_at timestamptz,
  consent_text   text,

  signature_method text not null,
  status         text not null default 'pending',
  voided_at      timestamptz,
  void_reason    text,
  created_at     timestamptz not null default now(),

  constraint sig_method check (signature_method in ('typed_name','drawn','click_to_sign')),
  constraint sig_status check (status in ('pending','signed','declined','voided')),
  constraint sig_hash_format check (document_sha256_hex ~ '^[0-9a-f]{64}$'),
  constraint sig_signed_needs_consent check (
    status <> 'signed'
    or (consent_event_id is not null and consent_given_at is not null and consent_text is not null)),
  constraint sig_void_reason check (voided_at is null or void_reason is not null)
);

create unique index sig_one_signed_per_document
  on vault.signature_evidence (document_id) where status = 'signed';
create index on vault.signature_evidence (client_id, signed_at desc);
create index on vault.signature_evidence (firm_id);
create index on vault.signature_evidence (engagement_id) where engagement_id is not null;

-- The full sequence of view, scroll to end, consent and sign events, in order.
create table vault.signature_events (
  id             char(26) primary key,        -- ULID
  evidence_id    char(26) not null references vault.signature_evidence(id),
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),
  sequence_number integer not null,
  event_type     text not null,
  occurred_at    timestamptz not null default now(),   -- server clock
  ip_inet        inet,
  user_agent     text,
  page_number    integer,
  detail         jsonb not null default '{}',
  unique (evidence_id, sequence_number),
  constraint sigev_type check (event_type in (
    'document_viewed','page_viewed','scrolled_to_end','consent_given',
    'signature_applied','signature_declined','document_downloaded')),
  constraint sigev_sequence check (sequence_number > 0)
);

create index on vault.signature_events (evidence_id, sequence_number);
create index on vault.signature_events (client_id, occurred_at desc);
create index on vault.signature_events (firm_id);

-- ---------------------------------------------------------------------------
-- RLS and immutability.
-- ---------------------------------------------------------------------------

alter table vault.documents enable row level security;
alter table vault.documents force row level security;
alter table vault.audit_events enable row level security;
alter table vault.audit_events force row level security;
alter table vault.signature_evidence enable row level security;
alter table vault.signature_evidence force row level security;
alter table vault.signature_events enable row level security;
alter table vault.signature_events force row level security;

create policy client_isolation on vault.documents
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on vault.audit_events
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on vault.signature_evidence
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );
create policy client_isolation on vault.signature_events
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on vault.documents
  for each row execute function tenancy.freeze_discriminators();
create trigger trg_freeze_discriminators before update on vault.signature_evidence
  for each row execute function tenancy.freeze_discriminators();

revoke update, delete, truncate on vault.audit_events from app_web, app_worker;
revoke update, delete, truncate on vault.signature_events from app_web, app_worker;

create rule audit_events_no_update as on update to vault.audit_events do instead nothing;
create rule audit_events_no_delete as on delete to vault.audit_events do instead nothing;
create rule signature_events_no_update as on update to vault.signature_events do instead nothing;
create rule signature_events_no_delete as on delete to vault.signature_events do instead nothing;

commit;
