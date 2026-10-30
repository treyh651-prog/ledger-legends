-- 0042_credit_memo_accounts.sql
--
-- subledger.credit_memos has no GL account columns at all: migration 0014
-- built it as a pure subledger record, crediting a customer's balance
-- without anywhere to say which receivable control account and which
-- revenue (or sales returns) account the offsetting entry touches. Every
-- sibling document that posts -- invoices, bills -- carries exactly this
-- pair (ar_account + revenue_account on invoices, ap_account +
-- expense_account on bills), stored on the row rather than only in policy,
-- so the document remembers what it posted against even after a policy
-- change. Nothing in the original run set ever created a credit memo
-- either, so this gap was never exercised.
--
-- Table has zero rows (verified before writing this migration), so both
-- columns can be added not null with no backfill and no transient default.
--
-- Forward only. No down migration.

begin;

alter table subledger.credit_memos
  add column ar_account char(4) not null,
  add column revenue_account char(4) not null;

alter table subledger.credit_memos
  add constraint credit_memos_ar_account_fk
    foreign key (client_id, ar_account) references ledger.accounts (client_id, account_number),
  add constraint credit_memos_revenue_account_fk
    foreign key (client_id, revenue_account) references ledger.accounts (client_id, account_number);

commit;
