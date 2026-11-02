-- 0058_bill_applications_run_id_width.sql
--
-- 0057 defined bill_applications.created_by_run_id as char(26), copied from
-- payment_applications' own column as it reads in 0014 -- missing that
-- 0020_run_id_widths.sql later widened every run id column in the schema to
-- text with a 31 character check, because a run execution id is thirty one
-- characters, not twenty six. check-schema.ts caught the mismatch before
-- anything was written to the column. Corrective, not a rewrite of 0057:
-- forward only, same convention as every migration in this project.
--
-- Forward only. No down migration.

begin;

alter table subledger.bill_applications
  alter column created_by_run_id type text;
alter table subledger.bill_applications
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

commit;
