-- 0040_doc_scanned_at_allows_not_scanned.sql
--
-- Migration 0031 added 'not_scanned' to doc_scan_status and to
-- doc_scan_before_use, for a document Supabase Storage has no scanner for.
-- It never touched the sibling constraint doc_scanned_at (migration 0008):
--   check (scan_status = 'pending' or scanned_at is not null)
-- which still demands a scanned_at timestamp for every scan_status except
-- 'pending' -- including the new 'not_scanned' -- and DOC-RECORD-UPLOAD never
-- writes one, because there was nothing to scan and fabricating a timestamp
-- for a scan that never ran would be worse than leaving the column null.
-- Every document upload through Supabase Storage has been refused by this
-- constraint since 0031 shipped; nothing caught it because the suite's
-- in-memory store does not enforce it.
--
-- The fix exempts 'not_scanned' the same way 'pending' already is: nothing
-- that was never scanned should be required to carry the time it was scanned.
--
-- Forward only. No down migration.

begin;

alter table docvault.documents drop constraint doc_scanned_at;

alter table docvault.documents add constraint doc_scanned_at
  check (scan_status in ('pending', 'not_scanned') or scanned_at is not null);

commit;
