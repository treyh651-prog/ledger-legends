-- 0032_engagement_billing_status.sql
--
-- A firm set flag on the engagement: is the client current on what they owe
-- the firm for the bookkeeping engagement itself, or past due. This is
-- deliberately not a billing subsystem. Migration 0007 recorded that decision
-- on purpose ("no payment lifecycle columns of any kind and no processor
-- identifiers") and this column does not cross that line: no amounts, no
-- invoice rows, no payment history, no processor of any kind. It is a single
-- state a person at the firm sets by hand, the same shape as `status` already
-- on this table, and the client's portal is allowed to read only this one
-- column's value, never anything else about the engagement's billing.
--
-- Defaults to 'current' so every existing engagement starts in good standing
-- rather than retroactively flagged past due.

begin;

alter table tenancy.engagements
  add column billing_status text not null default 'current';

alter table tenancy.engagements
  add constraint eng_billing_status check (billing_status in ('current', 'past_due'));

commit;
