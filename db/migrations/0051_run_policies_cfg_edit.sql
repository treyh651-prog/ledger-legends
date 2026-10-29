-- 0051_run_policies_cfg_edit.sql
--
-- CFG-EDIT-CATEGORY, CFG-EDIT-RULE, and CFG-EDIT-MAPPING-PROFILE were added
-- to RUN_POLICIES in server/runs/policy.ts and to the registry; tier,
-- reason, and writes_ledger below are copied verbatim.
--
-- Forward only. No down migration.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('CFG-EDIT-CATEGORY', 'manual', 'a person at the firm decides what a category is called, where it posts, and how it is taxed, never something a clock infers', false),
  ('CFG-EDIT-RULE', 'manual', 'a rule is configurable by a user and therefore capable of encoding a mistake at scale, the same reason TXN-APPLY-RULES itself names for why editing one is a person''s decision', false),
  ('CFG-EDIT-MAPPING-PROFILE', 'manual', 'which bank column means what is a judgment a person makes once per institution, and a wrong guess here silently books amounts to the wrong sign or date', false);

commit;
