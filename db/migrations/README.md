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
| `0003_run_log.sql` | Run log, items, events and sequences with monthly partitions, insert only enforcement, per partition idempotency indexes, and the manual override guard function. |
| `0004_rules.sql` | Rules, rule versions, and the selection index that encodes the tie breaking order. |
| `0005_subledgers.sql` | Fixed assets, depreciation schedule, deferral schedules and lines, loans and loan schedule, vendors with last four only, the dated tax thresholds with seed rows, recurring templates and splits. |
| `0006_close.sql` | Close runs and close gate results, with the approver separated from the preparer for gate G18. |
| `0007_entitlement.sql` | Entitlement schema with tiers, features, tier features, effective dated grants, overrides, and `has_feature`. No subscriptions table and no payment columns. |
| `0008_vault.sql` | Document metadata with the extended type list and the intake safety columns, audit events, and the engagement signature evidence and event tables. |
| `0009_import.sql` | Versioned column mapping profiles and their history, import staging batches, and staged rows with import time deduplication. |
| `0010_run_storage.sql` | Payroll approval records, CPA handoff packages and items, offboarding exports and their file manifest. |
| `0011_transaction_register.sql` | Bank and card accounts, the bank transaction register the coding cascade operates on, and the foreign keys that doc 06 C9 left dangling. |

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
