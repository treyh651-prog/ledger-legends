-- 0044_run_policies_missing_rows.sql
--
-- sched.run_policies (migration 0022) is seeded from RUN_POLICIES in
-- server/runs/policy.ts, and script/check-schema.ts reads the table back
-- against the source so the two cannot drift silently. Running that check
-- for the first time against this project (it needs either the Supabase
-- connector or DATABASE_URL, and this session had neither configured until
-- now) found nine rows missing: every run this engagement added beyond
-- doc 02's original 49 was added to RUN_POLICIES and to the registry, but
-- never to this table.
--
-- The practical effect: sched.schedules has a composite foreign key on
-- (run_type, tier) into this table, so none of the nine could ever be
-- scheduled, including REC-IMPORT-STATEMENT (unattended) and TXN-POST-CODED
-- (propose), both of which are legitimate candidates for a cadence. A
-- schedule naming either would have failed on a foreign key violation
-- rather than a clean application level refusal.
--
-- tier, reason, and writes_ledger below are copied verbatim from
-- server/runs/policy.ts so script/check-schema.ts passes against this row
-- the same way it does every other.
--
-- Forward only. No down migration.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('SETUP-ADD-BANK-ACCOUNT', 'manual', 'names a bank or card account and which chart account it feeds, once, and a clock has no account of its own to discover', false),
  ('AR-CREATE-CUSTOMER', 'manual', 'a person at the firm records a new customer by name, once, and a clock has no customer of its own to discover', false),
  ('AR-CREATE-INVOICE', 'manual', 'posts the sale to the general ledger and bills a named customer, so the run prepares and a person decides, the same reasoning SETUP-IMPORT-BALANCES gives for the opening entry', true),
  ('REC-IMPORT-STATEMENT', 'unattended', 'records exactly what the bank statement says, touches no ledger account, and a repeat on the same statement id changes nothing', false),
  ('AP-CREATE-VENDOR', 'manual', 'a person at the firm records a new vendor by legal name, once, and a clock has no vendor of its own to discover', false),
  ('AP-CREATE-BILL', 'manual', 'posts the payable to the general ledger from a named vendor''s bill, so the run prepares and a person decides, the same reasoning AR-CREATE-INVOICE gives for billing a customer', true),
  ('AR-RECORD-PAYMENT', 'manual', 'names which customer a deposit already on the register belongs to, once, and a clock cannot discover whose cash it is', false),
  ('AR-CREATE-CREDITMEMO', 'manual', 'posts a reversal to the general ledger and credits a named customer''s balance, so the run prepares and a person decides, the same reasoning AR-CREATE-INVOICE gives for billing one', true),
  ('TXN-POST-CODED', 'propose', 'posts the ordinary coded transaction to its own real account, a general ledger write, the same reasoning TXN-SWEEP-SUSPENSE gives for posting to suspense', true);

commit;
