-- 0036_run_log_items_target_id_width.sql
--
-- target_id holds the id of whatever row a proposal touched (run-log.ts,
-- proposalRowId), which is not always a run id, so migration 0020 correctly
-- left it at char(26): every ledger and subledger row this framework has ever
-- logged against is a ULID, 26 characters, same reasoning that migration
-- widened run id columns to 31 or 33 for. INTAKE-CREATE-CLIENT is the first
-- run in the registry whose proposals are row_insert on tenancy.clients and
-- tenancy.engagements, and tenancy's own ids are uuid, 36 characters with the
-- dashes. The first client ever created against real Postgres refused at the
-- log write with 22001, value too long for type character(26), for exactly
-- the reason doc 0020 documents happening to every run id column before it.
--
-- Same fix, same shape: text with a named length check rather than a wider
-- fixed width, because the next id scheme this framework logs against is a
-- constraint change here rather than another table rewrite. 36 covers a uuid
-- exactly; nothing in this schema mints an id longer than that today.

begin;

alter table ledger.run_log_items
  alter column target_id type text;
alter table ledger.run_log_items
  add constraint target_id_width check (target_id is null or char_length(target_id) <= 36);

commit;
