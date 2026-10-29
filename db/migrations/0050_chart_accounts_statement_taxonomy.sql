-- 0050_chart_accounts_statement_taxonomy.sql
--
-- ledger.accounts has carried statement_line, parent_number, and is_control
-- since migration 0002 and nothing has ever written or read any of the three:
-- server/runs/tables.ts's ChartAccountRow never modeled them, and migration
-- 0037's five field ledger.chart_accounts view (the only path anything writes
-- an account through) does not expose them, so even a caller that wanted to
-- set them had no way to.
--
-- statement_line is now derived at insert time from the account number, the
-- same way account_type and normal_side already are, by the application
-- (server/runs/runs/statement-taxonomy.ts), not by this trigger: the label
-- text is a naming decision that belongs with the other application level
-- naming (doc 01's STATEMENT grouping), not duplicated into SQL. is_control is
-- likewise set by the caller, true only for the two accounts the app already
-- treats as the canonical AR and AP subledger controls. parent_number stays
-- unset; no rollup hierarchy is designed yet and this migration does not
-- invent one.
--
-- Same two step shape as 0037/0038: the view has to be dropped and recreated
-- to add columns, which drops its instead of insert trigger along with it
-- (0038's own lesson), so the trigger is recreated here too rather than left
-- for a second migration to rediscover the same failure.

begin;

drop view ledger.chart_accounts;
create view ledger.chart_accounts
  with (security_invoker = true) as
  select
    a.client_id::text || '-' || a.account_number as id,
    a.firm_id,
    a.client_id,
    a.account_number,
    a.name,
    a.account_type,
    a.normal_side,
    a.statement_line,
    a.parent_number,
    a.is_control
  from ledger.accounts a;

create or replace function ledger.chart_accounts_insert()
returns trigger language plpgsql as $$
declare
  block char(1);
  derived_type text;
  derived_side text;
begin
  if new.account_number is null or new.account_number !~ '^[0-9]{4}$' then
    raise exception 'chart_accounts_bad_account_number %', coalesce(new.account_number, 'null')
      using errcode = 'check_violation';
  end if;

  block := left(new.account_number, 1);

  if block = '1' then
    derived_type := 'asset';      derived_side := 'debit';
  elsif block = '2' then
    derived_type := 'liability';  derived_side := 'credit';
  elsif block = '3' then
    derived_type := 'equity';     derived_side := 'credit';
  elsif block = '4' then
    derived_type := 'revenue';    derived_side := 'credit';
  elsif block = '5' then
    derived_type := 'cogs';       derived_side := 'debit';
  elsif block in ('6', '7') then
    derived_type := 'expense';    derived_side := 'debit';
  elsif block = '8' then
    if new.account_type in ('other_income', 'other_expense') and new.normal_side in ('debit', 'credit') then
      derived_type := new.account_type;
      derived_side := new.normal_side;
    else
      raise exception 'chart_accounts_ambiguous_block on account % %, the 8000 block is other_income or other_expense and the insert named neither. Set account_type to one of those two and normal_side, or insert into ledger.accounts directly.',
        new.account_number, coalesce(new.name, '')
        using errcode = 'check_violation';
    end if;
  elsif block = '9' then
    if new.account_type in ('tax', 'memo') and new.normal_side in ('debit', 'credit') then
      derived_type := new.account_type;
      derived_side := new.normal_side;
    else
      raise exception 'chart_accounts_ambiguous_block on account % %, the 9000 block is tax or memo and the insert named neither. Set account_type to one of those two and normal_side, or insert into ledger.accounts directly.',
        new.account_number, coalesce(new.name, '')
        using errcode = 'check_violation';
    end if;
  else
    raise exception 'chart_accounts_unmapped_block on account % %', new.account_number,
      coalesce(new.name, '')
      using errcode = 'check_violation';
  end if;

  insert into ledger.accounts (
    client_id, firm_id, account_number, name, account_type, normal_side,
    statement_line, parent_number, is_control
  ) values (
    new.client_id, new.firm_id, new.account_number, new.name, derived_type, derived_side,
    new.statement_line, new.parent_number, coalesce(new.is_control, false)
  );

  new.id := new.client_id::text || '-' || new.account_number;
  return new;
end;
$$;

drop trigger if exists trg_chart_accounts_insert on ledger.chart_accounts;
create trigger trg_chart_accounts_insert instead of insert on ledger.chart_accounts
  for each row execute function ledger.chart_accounts_insert();

commit;
