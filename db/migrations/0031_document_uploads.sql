-- 0031_document_uploads.sql
-- Document uploads through the product, on Supabase Storage. NOTES 256.
--
-- Migration 0008 wrote docvault.documents for S3 with Object Lock and a virus
-- scan in the path. The product now stores bytes in a private Supabase Storage
-- bucket, which encrypts at rest, has no Object Lock, and has no scanner. Three
-- constraints are widened for that provider and nothing else changes:
--   1. storage_provider names which rules apply. S3 rows keep every rule.
--   2. A document can be 'uploaded' with scan_status 'not_scanned' once its
--      magic bytes were verified by the server. 'verified' still needs 'clean'.
--   3. The lock requirement for sensitive types applies to S3 rows only.
-- Also the run policy row for DOC-RECORD-UPLOAD and the private bucket itself.
-- Forward only. No down migration.

begin;

alter table docvault.documents
  add column if not exists storage_provider text not null default 's3';

alter table docvault.documents
  drop constraint if exists doc_storage_provider,
  add constraint doc_storage_provider check (storage_provider in ('s3', 'supabase'));

alter table docvault.documents
  drop constraint if exists doc_scan_status,
  add constraint doc_scan_status check (scan_status in ('pending', 'not_scanned', 'clean', 'infected', 'failed'));

alter table docvault.documents
  drop constraint if exists doc_scan_before_use,
  add constraint doc_scan_before_use check (
    status not in ('uploaded', 'verified')
    or (magic_verified and scan_status in ('clean', 'not_scanned'))),
  drop constraint if exists doc_verified_needs_clean_scan,
  add constraint doc_verified_needs_clean_scan check (status <> 'verified' or scan_status = 'clean');

alter table docvault.documents
  drop constraint if exists doc_retention_for_sensitive,
  add constraint doc_retention_for_sensitive check (
    storage_provider <> 's3'
    or doc_type not in ('engagement_letter','bank_statement','card_statement','w9',
                        'payroll_register','payroll_report','tax_return')
    or object_lock_mode is not null);

-- One run records one upload. A person sends the file; a clock never does.
insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('DOC-RECORD-UPLOAD', 'manual', 'a person sends one file from the portal or the firm plane, and the record is written only after the bytes are stored', false)
on conflict (run_type) do nothing;

-- The private bucket. Nothing is public; the server signs every download with
-- the service role for sixty seconds. Mime list and ceiling match
-- shared/uploads.ts; the server enforces both before the bucket sees a byte.
-- storage.buckets exists only on Supabase, so a plain Postgres (the migration
-- test, a local database) skips this block and the server still runs without
-- a store, answering 501 with the missing settings named.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'documents', 'documents', false, 104857600,
      array['application/pdf', 'image/png', 'image/jpeg', 'text/csv',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
    )
    on conflict (id) do nothing;
  end if;
end $$;

commit;
