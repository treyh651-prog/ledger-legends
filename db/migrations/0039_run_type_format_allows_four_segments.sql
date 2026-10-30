-- 0039_run_type_format_allows_four_segments.sql
--
-- run_type_format (migration 0003) requires exactly three hyphen separated
-- segments: '^[A-Z]+-[A-Z]+-[A-Z0-9]+$'. Every run type minted since then that
-- carries a fourth word -- ENG-SET-BILLING-STATUS, SETUP-ADD-BANK-ACCOUNT, and
-- the "-UNDO" suffix doc 03 Part 7 puts on every run type's own reversal --
-- has four segments, not three, and the insert was refused outright. Nothing
-- caught this before now because nothing had posted one of these run types
-- against real Postgres with the constraint enforced; the in-memory test
-- double the suite runs against does not have it.
--
-- The fix widens the pattern to one or more segments after the first, which
-- accepts every run type minted so far, three segment or four, and does not
-- loosen the one rule that matters: every segment is still upper case letters
-- and digits only, and the first word is still required.
--
-- run_log is a partitioned table (migration 0003); a constraint declared on
-- the parent is inherited by every partition, so dropping and re-adding it
-- here on the parent alone reaches every existing and future partition.
--
-- Forward only. No down migration.

begin;

alter table ledger.run_log drop constraint run_type_format;

alter table ledger.run_log add constraint run_type_format
  check (run_type ~ '^[A-Z]+(-[A-Z0-9]+)+$');

commit;
