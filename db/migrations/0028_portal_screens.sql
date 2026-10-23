-- 0028_portal_screens.sql
--
-- Portal screens on the API, docs/11-api.md and NOTES 223 to 226.
--
-- Three client side runs appear in this migration. Each is manual tier, since
-- a person at the client, or a person at the firm replying, is the only thing
-- that can start one.
--
--   1. PORTAL-ANSWER-REQUEST. The client answers an open portal request in
--      words. ledger.portal_requests gains the answer columns and the request
--      moves from open to satisfied. Document requests are not answered here,
--      because a document needs an upload and object storage is not set up.
--   2. PORTAL-POST-MESSAGE. A message between the client and the firm, kept
--      in ledger.portal_messages. Both directions post through the same run.
--      The row says which side wrote it. No email goes out, the thread is
--      read inside the product on both planes.
--   3. ENG-SIGN-LETTER. The client signs the engagement letter already on
--      file in docvault. The run inserts docvault.signature_evidence and moves
--      tenancy.engagements from draft or sent to signed. Activation, signed
--      to active, is a separate firm run.

begin;

-- 1. Answer columns on portal requests. answered_by is the portal user who
--    wrote the answer. The status check from 0019 stays as it is, an answered
--    request is a satisfied one.
alter table ledger.portal_requests
  add column answer      text,
  add column answered_at timestamptz,
  add column answered_by uuid references tenancy.users(id);

alter table ledger.portal_requests
  add constraint portal_answer_complete check (
    (answer is null and answered_at is null and answered_by is null)
    or (answer is not null and answered_at is not null and answered_by is not null));

-- 2. Messages between the client and the firm.
create table ledger.portal_messages (
  id              char(26) primary key,        -- ULID
  client_id       uuid not null references tenancy.clients(id),
  firm_id         uuid not null references tenancy.firms(id),

  author_user_id  uuid not null references tenancy.users(id),
  author_scope    text not null,               -- who wrote it
  body            text not null,
  created_by_run_id text not null,

  version         integer not null default 1,
  created_at      timestamptz not null default now(),

  constraint portal_message_scope check (author_scope in ('client', 'firm')),
  constraint portal_message_body check (char_length(btrim(body)) between 1 and 4000),
  constraint created_by_run_id_width check (char_length(created_by_run_id) <= 31),
  unique (client_id, id)
);

create index portal_messages_client on ledger.portal_messages (client_id, created_at, id);
create index portal_messages_firm on ledger.portal_messages (firm_id);

alter table ledger.portal_messages enable row level security;
alter table ledger.portal_messages force row level security;

create policy client_isolation on ledger.portal_messages
  using ( (select tenancy.has_client_access(client_id)) )
  with check ( (select tenancy.has_client_access(client_id)) );

grant select, insert on ledger.portal_messages to app_web, app_worker;

-- 3. Policies for the three runs.
insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('PORTAL-ANSWER-REQUEST', 'manual', 'a person at the client answers an open request from the portal, and nothing else can answer for them', false),
  ('PORTAL-POST-MESSAGE', 'manual', 'a person at the client or the firm writes a message, and a clock has nothing to say', false),
  ('ENG-SIGN-LETTER', 'manual', 'the client signs the engagement letter from the portal, the signature record is theirs alone', false)
on conflict (run_type) do nothing;

commit;
