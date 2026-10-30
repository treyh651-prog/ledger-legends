-- 0052_drop_superseded_schema.sql
--
-- A fresh orphan-column sweep flagged several columns as "never written by
-- the application." Research this round found most of them are not missed
-- wiring on a live table -- they are leftovers on a table an earlier
-- migration created, which a later migration superseded with a differently
-- shaped table the app actually uses. Confirmed against the live DB before
-- writing this: every table/column dropped below has zero rows (or, for
-- run_log/recurring_templates, zero rows carrying a non-default value in the
-- dropped columns).
--
-- Forward only. No down migration.

begin;

-- 1. ledger.run_log: proposed_count/skipped_count/error_count/skips_by_reason/
--    net_cents/entries_created/entries_reversed/finished_at/duration_ms/attempt
--    were never modeled in RunLogRow and never written -- the equivalent data
--    (proposalCount/skipCount/errorCount/skipCountsByReason) is written to
--    ledger.run_log_events instead, by run-log.ts's writeRunLog/appendEvent.
--    run_posting_nets_zero was vacuously true on every row ever inserted,
--    since entries_created/net_cents always sat at their zero defaults.
--    The table itself stays -- it is the live run-execution-intent log.
alter table ledger.run_log drop constraint run_posting_nets_zero;
alter table ledger.run_log
  drop column proposed_count,
  drop column skipped_count,
  drop column error_count,
  drop column skips_by_reason,
  drop column net_cents,
  drop column entries_created,
  drop column entries_reversed,
  drop column finished_at,
  drop column duration_ms,
  drop column attempt;

-- 2. subledger.payroll_approvals: whole table, zero rows, no TS model, no
--    query, no writer anywhere in server/runs. PAY-APPROVE-RUN and
--    PAY-POST-REGISTER record approval/posting provenance on pay_runs and
--    pay_register_entries instead (approvedBy/approvedAt/postedRunId/
--    postedEntryId/postedAt), which is what actually ships.
drop table subledger.payroll_approvals;

-- 3. ledger.close_runs / ledger.close_gate_results: whole tables, zero rows,
--    no TS model, no query, no writer anywhere in server/runs. Superseded by
--    close.periods (opened_by_run_id/locked_by_run_id/locked_at) and
--    close.close_gate_results, which is what cls-evaluate-gates.ts actually
--    queries. Drop the child first for the close_run_id foreign key.
drop table ledger.close_gate_results;
drop table ledger.close_runs;

-- 4. subledger.tax_thresholds: whole table, superseded by tax.thresholds
--    (firm scoped), which is what tax-shared.ts's thresholdFor() actually
--    queries. Already select-only since migration 0023 revoked insert/update.
--    Its six seed rows are preserved here since nothing else will keep them:
--      1099-NEC:  $600 threshold pre-2026, $2,000 for payments from 2026-01-01
--      1099-MISC: same $600 -> $2,000 change
--      Backup withholding trigger: $2,000 from 2026, indexed for inflation from 2027
--      1099-K: $20,000 and 200-transaction thresholds reinstated for 2026 (section 70432)
--      (source for all of the above: section 70432/70433,
--       https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds)
drop table subledger.tax_thresholds;

-- 5. subledger.recurring_templates: drop match_account_number and
--    match_amount_tolerance_cents only -- both superseded by bank_account_id
--    and amount_floor_cents/amount_ceiling_cents, which is what
--    txn-apply-recurring.ts's templateMatches() actually matches on, and
--    neither is modeled in RecurringTemplateRow. next_due_date is
--    deliberately NOT touched here: rec_generated_needs_cadence requires it
--    not-null for a 'generated_entry' template, so it is a required field for
--    an as-yet-unbuilt code path (nothing creates a generated_entry template
--    today), not dead schema -- left for its own decision.
alter table subledger.recurring_templates drop constraint rec_tolerance_nonneg;
alter table subledger.recurring_templates
  drop column match_account_number,
  drop column match_amount_tolerance_cents;

commit;
