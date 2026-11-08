-- 0073_practice_member_id_width.sql
--
-- Found while researching the email feature: practice.practice_states'
-- lead_id/preparer_id/partner_id, practice.tasks.assignee_id,
-- practice.escalations.recipient_id, and practice.workload_notices.member_id
-- were all declared char(26) (ULID width), but every real value they ever
-- hold is a tenancy.users.id -- a uuid, 36 characters with hyphens, per
-- 0001_tenancy.sql. A real assignment through the Board screen's own
-- useFirmTeam()/firmMembers() path (server/auth/actor-store.ts) sends a real
-- uuid straight through PRAC-UPDATE-TASK (no length validation in its own
-- scope schema) into this column -- which Postgres would refuse outright
-- ("value too long for type character(26)"). Never caught because the
-- in-memory test double (db-memory.ts) does not enforce column widths, and
-- every test fixture for these fields (server/runs/__tests__/prc-fixtures.ts)
-- uses short opaque placeholder strings rather than a real uuid.
--
-- Widened to plain uuid, not uuid references tenancy.users(id) -- matching
-- the existing manual_override_by uuid columns on these same five tables,
-- which already carry an actor reference with no foreign key. A real
-- firm-wide "no single recipient" case (escalations.recipient_id, rung
-- at_risk) legitimately stores null, so no column here is widened to
-- not null that was previously nullable.
--
-- No data migration: every environment's own practice.* tables are empty of
-- any row that ever held a 26 character value in one of these columns (the
-- write path has never successfully completed against real Postgres), so a
-- plain type change is safe.

begin;

alter table practice.practice_states
  alter column lead_id type uuid using lead_id::uuid,
  alter column preparer_id type uuid using preparer_id::uuid,
  alter column partner_id type uuid using partner_id::uuid;

alter table practice.tasks
  alter column assignee_id type uuid using assignee_id::uuid;

alter table practice.escalations
  alter column recipient_id type uuid using recipient_id::uuid;

alter table practice.workload_notices
  alter column member_id type uuid using member_id::uuid;

commit;
