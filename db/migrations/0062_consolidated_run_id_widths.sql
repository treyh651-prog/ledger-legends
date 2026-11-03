-- 0062_consolidated_run_id_widths.sql
--
-- Two corrections found by script/check-schema.ts right after 0061 landed.
--
-- 1. report.consolidated_packages.built_by_run_id and
--    report.consolidated_sections.created_by_run_id were written as
--    char(31) -- the shape every run id column had before migration 0020
--    widened them all to text plus a named length check, because char(n)
--    pads short values and a fixed-width column stops being "one type"
--    the moment one of them is still char. 0061 copied the pre-0020 shape
--    from report_packages/report_sections by mistake; this migration
--    applies 0020's own fix to the two new columns, same named convention.
--
-- 2. sched.run_policies.reason for RPT-BUILD-CONSOLIDATED-PACKAGE was
--    seeded with slightly different wording than server/runs/policy.ts's
--    own RUN_POLICIES entry -- check-schema.ts compares the two by exact
--    string and the database is corrected to match the TypeScript source.
--
-- Forward only. No down migration.

begin;

alter table report.consolidated_packages
  alter column built_by_run_id type text;
alter table report.consolidated_packages
  add constraint built_by_run_id_width check (char_length(built_by_run_id) <= 31);

alter table report.consolidated_sections
  alter column created_by_run_id type text;
alter table report.consolidated_sections
  add constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31);

update sched.run_policies
  set reason = 'combines two or more entities'' figures into one package, and a firm decides when that is ready to build -- there is no group scoped schedule concept for a clock to use the way RPT-BUILD-PACKAGE''s own schedule is per client'
  where run_type = 'RPT-BUILD-CONSOLIDATED-PACKAGE';

commit;
