-- 0067_report_release_state.sql
--
-- Audit fix (problem 9): report.report_packages and report.report_narratives
-- had no "released" state and no firm review gate before a built package or
-- narrative reached the client portal -- confirmed by reading
-- portal-router.ts's own reportsFor()/narrativeFor() directly, neither
-- filtered at all. "superseded" (report_packages) turned out to be
-- vestigial: packageIdOf() derives one id per (client, period, basis), so
-- a rebuild always field-writes the same row, and nothing in the registry
-- ever wrote "superseded". narrative_state's own comment ("there is no
-- sent state here, because nothing in this module sends anything")
-- predates this finding.
--
-- New run types RPT-RELEASE-PACKAGE/RPT-RELEASE-NARRATIVE are the only
-- writers of "released", and portal-router.ts now filters to it. Also
-- seeds both run types' sched.run_policies rows, same pattern as every
-- prior round.
--
-- Forward only. No down migration.

begin;

alter table report.report_packages drop constraint package_state;
alter table report.report_packages add constraint package_state
  check (state in ('draft', 'superseded', 'released'));

alter table report.report_narratives drop constraint narrative_state;
alter table report.report_narratives add constraint narrative_state
  check (state in ('draft', 'released'));

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('RPT-RELEASE-PACKAGE', 'manual',
   'deciding a package is ready for the client to see is a judgment a person makes on purpose, and a clock did not review it', false),
  ('RPT-RELEASE-NARRATIVE', 'manual',
   'deciding a narrative is ready for the client to see is a judgment a person makes on purpose, and a clock did not review it', false)
on conflict (run_type) do nothing;

commit;
