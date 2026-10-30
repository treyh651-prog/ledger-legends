-- 0038_chart_accounts_trigger_reattach.sql
--
-- Migration 0037's drop view / create view on ledger.chart_accounts dropped
-- the instead of insert trigger along with the old view (a trigger belongs to
-- the relation it is on) and never recreated it, leaving plain insert
-- reaching the view directly: "cannot insert into column \"id\" of view
-- \"chart_accounts\"", Postgres code 0A000, found testing 0037 itself before
-- it ever reached the application. Re-creates the trigger against the
-- function 0037 already defined; nothing else changes.

begin;

drop trigger if exists trg_chart_accounts_insert on ledger.chart_accounts;
create trigger trg_chart_accounts_insert instead of insert on ledger.chart_accounts
  for each row execute function ledger.chart_accounts_insert();

commit;
