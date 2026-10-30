-- 0047_document_links_vendor_asset_loan.sql
-- docvault.documents.linked_vendor_id, linked_asset_id, and linked_loan_id
-- have existed with no foreign key at all since whichever migration first
-- added them alongside linked_transaction_id, and nothing in server/runs
-- ever read or wrote any of the three. linked_transaction_id is the one of
-- the four that actually works, FK included; this brings the other three up
-- to the same standard rather than leaving them as columns that merely exist.
-- Forward only. No down migration.

begin;

alter table docvault.documents
  add constraint doc_linked_vendor_fk foreign key (linked_vendor_id) references subledger.vendors(id),
  add constraint doc_linked_asset_fk foreign key (linked_asset_id) references subledger.fixed_assets(id),
  add constraint doc_linked_loan_fk foreign key (linked_loan_id) references subledger.loans(id);

commit;
