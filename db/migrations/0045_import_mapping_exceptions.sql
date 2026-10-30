-- 0045_import_mapping_exceptions.sql
-- Connects an uploaded bank or card statement to the import pipeline.
-- IMPORT-PARSE-FEED already refused a file whose header does not match a
-- stored mapping profile, or whose institution has no profile at all, but
-- nothing recorded that refusal anywhere a bookkeeper would see it. This adds
-- the table IMPORT-FLAG-MAPPING-NEEDED writes to, and the column that lets a
-- document point at the bank account it is a statement for, the same way
-- linked_transaction_id already lets a document point at a transaction.
-- Forward only. No down migration.

begin;

alter table docvault.documents
  add column linked_bank_account_id char(26) references ledger.bank_accounts(id);

create table import.mapping_exceptions (
  id             char(26) primary key,        -- ULID
  client_id      uuid not null references tenancy.clients(id),
  firm_id        uuid not null references tenancy.firms(id),

  bank_account_id char(26) not null references ledger.bank_accounts(id),
  source_document_id char(26) references docvault.documents(id),
  institution_name text not null,
  source_format  text not null,

  error_code     text not null,
  error_message  text not null,

  status         text not null default 'open',
  opened_at      timestamptz not null default now(),
  opened_by_run_id text,
  resolved_at    timestamptz,
  resolved_by_run_id text,

  version        integer not null default 1,

  constraint mapping_exception_status check (status in ('open', 'resolved')),
  constraint mapping_exception_resolved_complete check (
    status <> 'resolved' or (resolved_at is not null and resolved_by_run_id is not null))
);

-- One open subject per account. IMPORT-FLAG-MAPPING-NEEDED reopens the same
-- row on a later failure rather than inserting a second one, so a bookkeeper
-- never sees two open rows about the same account.
create unique index mapping_exception_one_open_per_account
  on import.mapping_exceptions (client_id, bank_account_id) where status = 'open';
create index on import.mapping_exceptions (client_id, status);
create index on import.mapping_exceptions (firm_id);
create index on import.mapping_exceptions (source_document_id) where source_document_id is not null;

alter table import.mapping_exceptions enable row level security;
alter table import.mapping_exceptions force row level security;

create policy client_isolation on import.mapping_exceptions
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

create trigger trg_freeze_discriminators before update on import.mapping_exceptions
  for each row execute function tenancy.freeze_discriminators();

commit;
