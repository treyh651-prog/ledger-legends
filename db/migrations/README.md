# Migrations

Plain forward only DDL. No down migrations. Applied by the `migrator` role over a
direct connection, never over the Neon pooler, per doc 04 Part 13.

Order follows the doc 04 Part 13 migration table, amended by doc 05 Part 8. Doc 05
amendments are folded into the create table statements rather than applied as later
alters, per doc 05 Part 9 step 2.

| File | Purpose |
|---|---|
| `0001_tenancy.sql` | Firms, users, clients, engagements, memberships, the membership functions, the discriminator freeze trigger, RLS enabled and forced, and the public schema revoke. |
| `0002_ledger_core.sql` | Ledger schema, accounts, clearing accounts, categories and versions, journal entries and lines with the three cash basis columns, the balanced entry trigger, period locks and the lock enforcement triggers. |
| `0002a_client_policies.sql` | The per client settings row the coding runs read at execution. Doc 04 never wrote its create statement and migration 0015 alters it, so it is numbered to land with the ledger core rather than after the file that depends on it. |
| `0003_run_log.sql` | Run log, items, events and sequences with monthly partitions, insert only enforcement, per partition idempotency indexes, and the manual override guard function. |
| `0004_rules.sql` | Rules, rule versions, and the selection index that encodes the tie breaking order. |
| `0005_subledgers.sql` | Fixed assets, depreciation schedule, deferral schedules and lines, loans and loan schedule, vendors with last four only, the dated tax thresholds with seed rows, recurring templates and splits. |
| `0006_close.sql` | Close runs and close gate results, with the approver separated from the preparer for gate G18. |
| `0007_entitlement.sql` | Entitlement schema with tiers, features, tier features, effective dated grants, overrides, and `has_feature`. No subscriptions table and no payment columns. |
| `0008_vault.sql` | Document metadata with the extended type list and the intake safety columns, audit events, and the engagement signature evidence and event tables. |
| `0009_import.sql` | Versioned column mapping profiles and their history, import staging batches, and staged rows with import time deduplication. |
| `0010_run_storage.sql` | Payroll approval records, CPA handoff packages and items, offboarding exports and their file manifest. |
| `0011_transaction_register.sql` | Bank and card accounts, the bank transaction register the coding cascade operates on, and the foreign keys that doc 06 C9 left dangling. |
| `0012_reconciliation.sql` | The bank side of reconciliation: statements, statement lines, match batches, the tier that decided each match, and the difference a clearing run hangs its gate on. |
| `0013_period_end.sql` | The six columns the module 4 period end runs read or write and the subledgers of 0005 did not have. |
| `0014_ar_ap.sql` | The receivable and payable subledger: customers, invoices, bills, payments, credit memos, applications, and the write off path. |
| `0015_close.sql` | Module 6 storage: substantiation records, gate evaluations, document requests, opening balances, period open and close, and the fiscal year close. |
| `0016_reporting.sql` | The report schema: report packages, budgets, budget variances, cash forecast weeks, and period narratives. |
| `0017_compliance_practice.sql` | The tax and practice schemas, plus storage for payroll approval, register posting, the CPA handoff, and the offboarding export. |
| `0018_intake.sql` | Per column mapping profile detail for wizard step 4, and the resumable wizard session a draft lives in. |
| `0019_run_table_gaps.sql` | The seven row map tables that had no create statement in any earlier file, and the jsonb array columns that replaced the first two `char(26)[]` columns a run could reach. |
| `0020_run_id_widths.sql` | Every run id column widened from `char(26)` to `text` with a named length check, because a run execution id is thirty one characters and a sequence id is thirty three. Also the last two array columns, `run_log.candidate_ids` and `vendors.aliases`, moved to jsonb. |

## Conventions held across every file

Money is `bigint` cents. There is no `numeric`, `money` or floating point money
column anywhere. `numeric(4,2)` appears once, on the declining balance factor, which
is a rate and not an amount.

Every tenant table carries `firm_id` and `client_id`, has row level security enabled
and forced, has a `client_isolation` policy that wraps
`tenancy.has_client_access(client_id)` in a `select`, has a leading `client_id`
index, and has the discriminator freeze trigger on update.

No credential column exists in any schema. Vendors store `tin_last_four` only. The
full taxpayer identification number lives in the signed W-9 in the vault.

## Deviations from the literal doc 04 text

Both are in `0003_run_log.sql` and are commented at the point of use.

1. The partial unique idempotency index is created on each partition rather than on
   the partitioned parent, because Postgres rejects a unique index with a `where`
   clause on a partitioned table.
2. Insert only enforcement on the two partitioned log tables uses a trigger rather
   than a rewrite rule, because rules are not supported on partitioned tables. The
   rule form is kept on `run_log_events` and on the vault audit tables, which are
   not partitioned.

## Applied against a real database, 2026-09-14

First application to real Postgres, a Supabase project on Postgres 17. Four
things came out of it, and all four are folded into the files above rather than
patched on the side.

1. **The `vault` schema is renamed `docvault`.** Supabase reserves `vault` for
   Supabase Vault and owns it as `supabase_admin`, so `create table
   vault.documents` fails with permission denied. The document store keeps every
   table, column, constraint, policy and trigger it had. Only the schema name
   moved. Prose in the specification documents still calls it the vault, because
   that is what it is.

2. **`0002a_client_policies.sql` is new.** `ledger.client_policies` is read by
   the coding runs and altered by 0015, and no migration ever created it. It is
   numbered 0002a so it lands with the rest of the ledger core, ahead of the
   0015 alter that assumes it.

3. **0017 reconciles `subledger.vendors` instead of re-adding to it.** 0005 had
   already declared `entity_type` over a different vocabulary and a
   `tin_last_four` column. 0017 now drops the older check, converts the existing
   values to the vocabulary the runs read, sets the column not null with the
   `unknown` default, moves the four digits onto `tin_last4`, and drops
   `tin_last_four` so there is one spelling of that fact.

4. **Seven tables the runs expect still have no create statement**:
   `transfer_pairs`, `suspense_items`, `bank_code_mappings`, `settlement_rows`,
   `document_links`, `portal_requests`, `documentation_exceptions`. Four more
   exist under a schema the physical table map in `db-postgres.ts` does not
   point at: `chart_accounts`, `mapping_profile_columns`, `wizard_sessions`,
   `run_sequence`. None of this was visible while the runs only ever ran against
   the in memory port.

## The eleven row map gaps, closed by 0019

`0019_run_table_gaps.sql` answers item 4 above, and `script/check-schema.ts` is
the gate that keeps it answered. The gate parses the `RowMap` keys out of
`server/runs/tables.ts`, resolves each one through the physical table map the
Postgres port itself exports, and fails if any key names a relation the
database does not have. It reads the database through the Supabase connector,
so it needs no credential of its own.

Seven of the eleven were genuinely missing and are created by 0019:
`ledger.transfer_pairs`, `ledger.suspense_items`, `ledger.bank_code_mappings`,
`subledger.settlement_rows`, `ledger.document_links`, `ledger.portal_requests`
and `ledger.documentation_exceptions`. Each holds the full tenant convention
listed above, plus the override guard and a named check constraint on every
enumerated column.

`chart_accounts` was not missing a table, it was asking for a second one.
`ChartAccountRow` is five fields and `ledger.accounts` needs an account type
and a normal side, so 0019 creates `ledger.chart_accounts` as a view with
`security_invoker` on and an instead of insert trigger that derives the type
from the doc 00 account block. The 8000 and 9000 blocks each carry two possible
types, so the trigger raises and names the account rather than guessing.

The remaining three, `mapping_profile_columns`, `wizard_sessions` and
`run_sequence`, exist in SQL under names the physical table map did not carry.
That map is fixed in `db-postgres.ts`, not here.

0019 also repairs `ledger.run_sequences`, which could not accept the row the
sequence runner writes: the id was seven characters too short for a `RUNSEQ-`
prefixed ULID, there was no `actor_id`, and `status` was mandatory with no
default and no field behind it. It is now derived on insert from
`stopped_at_step`. `child_run_ids` moves to jsonb, because the port JSON
encodes every array before it reaches the driver and a text array column
rejects that literal.

Two things found and deliberately not fixed in 0019, both written up in
`postgres-wire-report.md`: seventy seven run id columns across migrations 0003
to 0014 are still `char(26)` and cannot hold a 31 character run id, and
`ledger.run_log.candidate_ids` is a `char(26)[]` with the same array encoding
problem `child_run_ids` had. Both want their own migration.

## The run id widths, closed by 0020

Both of the defects 0019 wrote down and left alone are fixed here. Every run id
column is now `text` with a named `char_length` check, sixty seven of them
across fifty two tables plus the partitions the parents recurse into, because a
run execution id is `RUNX-` in front of a 26 character ULID and a sequence id is
`RUNSEQ-` in front of the same ULID. `script/check-schema.ts` imports those two
widths from `server/runs/ids.ts` and fails on any run id column that is a fixed
width character type, so the next table cannot reintroduce the defect.

The count in the 0019 write up, seventy seven columns across forty seven tables,
does not reconcile with this pass. It matched on the column name, which pulls in
three foreign keys to entity ULIDs and misses nine real run id columns the row
map cannot reach. The derivation and the difference are in
`run-id-widths-report.md`.

`ledger.run_log.candidate_ids` and `subledger.vendors.aliases` were the last two
array columns any mapped table had and are both jsonb now. The vendor alias gin
index was recreated on the jsonb column.

One thing found and deliberately not fixed in 0020, written up in
`run-id-widths-report.md`: the named queries in the Postgres port disagree with
the column names in the database in fifty five places, and thirteen of them pass
an array parameter as a SQL array cast the port's own encoder cannot produce.
Widening the columns does not make those queries run. That wants its own change
and its own gate.
