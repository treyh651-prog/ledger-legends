-- 0059_rule_coding_review.sql
--
-- Rule accept/reject + promotion counters. ledger.rules has carried
-- accepted_count/rejected_count/auto_post_enabled/auto_post_enabled_by/
-- auto_post_ceiling_cents since migration 0021, and TXN-APPLY-RULES has
-- carried the full five-condition promotion gate (autoPostAllowed, doc 02
-- Part D) since before this round -- nothing has ever written the two
-- counters or the enabled flag, so the gate has been dead code. This
-- migration adds the one thing that was still missing: a place on
-- ledger.transactions to record whether a rule-coded row has been reviewed
-- yet, and what the reviewer decided. TXN-ACCEPT-CODING and TXN-RECODE
-- (server/runs/runs/) are the first writers of all of it.
--
-- Forward only. No down migration.

begin;

alter table ledger.transactions
  add column rule_reviewed_at timestamptz,
  add column rule_review_outcome text;

alter table ledger.transactions
  add constraint txn_rule_review_outcome check (
    rule_review_outcome is null or rule_review_outcome in ('accepted', 'rejected')),
  add constraint txn_rule_review_consistency check (
    (rule_reviewed_at is null) = (rule_review_outcome is null));

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('TXN-ACCEPT-CODING', 'manual', 'confirming a rule got a transaction right is a person''s judgment, and it is what feeds the accepted count doc 02 Part D promotes a rule on', false),
  ('TXN-RECODE', 'manual', 'fixing a miscoded transaction reverses whatever it already posted and reposts it correctly, the same kind of correction TXN-VOID makes, and it is what feeds the rejected count that keeps a rule honest', true),
  ('CFG-DISABLE-RULE-AUTOPOST', 'manual', 'a person can always revoke a rule''s auto post privilege without needing to manufacture a reject first', false);

commit;
