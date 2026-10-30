-- 0037_chart_accounts_explicit_ambiguous_type.sql
--
-- Migration 0019 built ledger.chart_accounts as a five field convenience view
-- over ledger.accounts and, correctly, had its insert trigger refuse to guess
-- an account_type for the 8000 and 9000 blocks, where doc 00's own map allows
-- two answers. Nothing before today had ever logged a tenancy level id
-- through run_log_items (see migration 0036) or created a first real client
-- against enforced RLS, so nothing had ever exercised INTAKE-BUILD-CHART
-- against real Postgres either: every one of the 49 run framework tests runs
-- against the in memory port, which has been letting the five field insert
-- pretend account 8000 "Interest income" classifies itself. It does not, and
-- the first real client creation anywhere refused at the standard chart,
-- every industry template, every tier, with chart_accounts_ambiguous_block.
--
-- The fix migration 0019's own trigger comment asks for: let the caller state
-- account_type and normal_side explicitly for exactly the rows where the
-- block map cannot. The view gains both columns, nullable, pass through only.
-- The trigger uses them only for the 8000 and 9000 blocks, and only when
-- both are present and valid; every other block keeps deriving from the
-- account number alone, unchanged, so a row from before this migration and a
-- row from after it reach the table identically. A 8000 or 9000 block insert
-- that still omits them is still refused, which matters for INTAKE-BUILD-CHART's
-- addAccounts path (a firm adding a custom account by hand): that path does
-- not supply either field and stays refused on purpose. Teaching it to carry
-- the same two fields is a later, separate change, not silently loosened here.
--
-- server/runs/runs/intake-shared.ts now states other_income, other_expense,
-- tax, or memo on the nine 8000 and 9000 block accounts the standard
-- templates carry (8000, 8010, 8100, 8200, 8900, 9000, 9200, 9900, 9910),
-- read from doc 00's own description of each account, not guessed.

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
    a.normal_side
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

  -- Doc 00 Part 1, the same blocks acct_block_matches_type enforces. The normal
  -- side follows from the type and is not a second decision. Unchanged for
  -- every block this always covered; an explicit account_type or normal_side
  -- the caller sent for one of these is not consulted, so a row shaped like
  -- every row before this migration behaves exactly as it did before it.
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
    client_id, firm_id, account_number, name, account_type, normal_side
  ) values (
    new.client_id, new.firm_id, new.account_number, new.name, derived_type, derived_side
  );

  -- The id the caller sent is discarded. The view's id is derived, so returning
  -- the derived form is the only answer a later read will agree with.
  new.id := new.client_id::text || '-' || new.account_number;
  return new;
end;
$$;

commit;
