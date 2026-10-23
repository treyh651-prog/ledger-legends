-- 0026_categories_pk.sql
--
-- Two things the screens brief needs before a second client can exist.
--
-- 1. Category ids are slugs (NOTES 126), the same slug for every client that
--    uses the standard chart. ledger.categories kept a primary key on id alone,
--    so the second client's INTAKE-BUILD-CHART failed on categories_pkey
--    (api-report.md finding 1). Every referencing foreign key already targets
--    (client_id, id) through categories_client_id_id_key, so the primary key
--    moves to that pair and the old unique constraint goes, because the new
--    primary key is the same index. The foreign keys that depend on the
--    unique constraint are dropped and re added from the catalog.
--
-- 2. INTAKE-ACTIVATE-ENGAGEMENT, the run that moves a draft engagement to
--    active once its letter is signed, or once the firm records that the
--    letter was signed outside the system. Manual tier. The reason text
--    mirrors RUN_POLICIES in server/runs/policy.ts, which
--    script/check-schema.ts reads back.

begin;

-- Every foreign key that targets ledger.categories is dropped, the key is
-- swapped, and each one is re added from its own stored definition. Reading
-- the definitions back from the catalog means no constraint name is guessed
-- here and a key added by a later migration is carried along too.
do $$
declare
  fk record;
begin
  create temp table categories_fks on commit drop as
    select c.conrelid::regclass as rel, c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.contype = 'f' and c.confrelid = 'ledger.categories'::regclass;
  for fk in select * from categories_fks loop
    execute format('alter table %s drop constraint %I', fk.rel, fk.conname);
  end loop;

  alter table ledger.categories drop constraint categories_pkey;
  alter table ledger.categories drop constraint if exists categories_client_id_id_key;
  alter table ledger.categories add primary key (client_id, id);

  for fk in select * from categories_fks loop
    execute format('alter table %s add constraint %I %s', fk.rel, fk.conname, fk.def);
  end loop;
end $$;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('INTAKE-ACTIVATE-ENGAGEMENT', 'manual', 'turns a draft engagement active once the letter is signed, which is a decision the firm records on purpose and never one a clock infers', false)
on conflict (run_type) do nothing;

commit;
