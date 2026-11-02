-- 0060_drop_dead_clearing_accounts.sql
--
-- Tier A item 7's last unresolved piece (migration 0052 already dropped
-- ledger.close_runs/close_gate_results as superseded, but left
-- ledger.clearing_accounts for its own check -- see that migration's own
-- comment #3 and the "Blocked" note in memory). Confirmed against the live
-- DB first: zero rows, same as everything else 0052 dropped.
--
-- ledger.clearing_accounts (must_be_zero_at_close/support_list_required) has
-- no TS model, no query, no writer anywhere in server/runs -- grepped
-- repo-wide, zero hits outside this migration and 0002's own create. The
-- functional need it was meant to serve is already met by two independent
-- hardcoded account-number lists: close-shared.ts's CLEARING_ACCOUNTS (which
-- gate G01 actually checks for a zero balance) and intake-shared.ts's
-- MANDATORY_CLEARING_ACCOUNTS (which INTAKE-BUILD-CHART actually enforces
-- exist on a new chart). Same pattern already decided for
-- ledger.accounts.contra_of: the DB table/column is cosmetic once the same
-- information already lives in application code, and not worth wiring up
-- unless something starts reading it instead.
--
-- Forward only. No down migration.

begin;

drop table ledger.clearing_accounts;

commit;
