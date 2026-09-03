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
