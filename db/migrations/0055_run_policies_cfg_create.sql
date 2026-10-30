-- 0055_run_policies_cfg_create.sql
--
-- CFG-CREATE-CATEGORY, CFG-CREATE-RULE, and CFG-CREATE-MAPPING-PROFILE were
-- added to RUN_POLICIES in server/runs/policy.ts and to the registry;
-- tier, reason, and writes_ledger below are copied verbatim.
--
-- Forward only. No down migration.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('CFG-CREATE-CATEGORY', 'manual', 'what a category is called, where it posts, and how it is taxed is a person''s judgment to invent, never something a run infers, the same reason CFG-EDIT-CATEGORY gives for editing one', false),
  ('CFG-CREATE-RULE', 'manual', 'a rule is configurable by a user and therefore capable of encoding a mistake at scale, the same reason CFG-EDIT-RULE and TXN-APPLY-RULES itself give for why a rule is a person''s decision', false),
  ('CFG-CREATE-MAPPING-PROFILE', 'manual', 'which bank column means what is a judgment a person makes once per institution, and a wrong guess here silently books amounts to the wrong sign or date, the same reason CFG-EDIT-MAPPING-PROFILE gives for editing one', false);

commit;
