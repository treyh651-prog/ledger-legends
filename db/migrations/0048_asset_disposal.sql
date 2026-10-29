-- 0048_asset_disposal.sql
--
-- PER-DISPOSE-ASSET was added to RUN_POLICIES in server/runs/policy.ts and to
-- the registry; tier, reason, and writes_ledger below are copied verbatim.
--
-- subledger.fixed_assets.disposal_entry_id has existed since the asset table
-- was built with no foreign key at all, the same gap migration 0047 closed
-- for documents.linked_vendor_id, linked_asset_id, and linked_loan_id.
--
-- Forward only. No down migration.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('PER-DISPOSE-ASSET', 'manual', 'which asset left the books, on what day, and for how much is a decision a person makes once, looking at a bill of sale or a disposal memo, and a clock has no sale of its own to discover', true);

alter table subledger.fixed_assets
  add constraint fa_disposal_entry_fk foreign key (disposal_entry_id) references ledger.journal_entries(id);

commit;
