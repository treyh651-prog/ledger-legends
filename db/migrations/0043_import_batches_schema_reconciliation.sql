-- 0043_import_batches_schema_reconciliation.sql
--
-- Documentation migration. import.batches has carried bank_account_id and
-- version in production for as long as the app has used them -- every run
-- that reads an import batch reads both (ImportBatchRow.bankAccountId,
-- ImportBatchRow.version) -- but neither column was ever added by a tracked
-- migration. 0009_import.sql, the table's own migration, has neither. Found
-- while seeding real clients this session and verified directly against
-- live schema before writing this file: both columns, and the foreign key
-- on bank_account_id, already exist on production exactly as declared here.
--
-- This migration changes nothing on the database that already has them (the
-- IF NOT EXISTS / existence-checked forms below are no-ops there). What it
-- fixes is the migration history itself: a fresh environment built only
-- from tracked migrations was missing both columns and the app would fail
-- the moment any run touched an import batch. After this file, it will not.
--
-- Forward only. No down migration.

begin;

alter table import.batches
  add column if not exists bank_account_id char(26),
  add column if not exists version integer not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'batches_bank_account_id_fkey'
  ) then
    alter table import.batches
      add constraint batches_bank_account_id_fkey
      foreign key (bank_account_id) references ledger.bank_accounts(id);
  end if;
end
$$;

commit;
