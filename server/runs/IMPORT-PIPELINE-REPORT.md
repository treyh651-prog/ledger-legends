# Register and import pipeline, delivery report

## Gates

- `npx tsc --noEmit` clean, no output.
- `npx tsx server/runs/__tests__/index.ts` 40 tests passed, 0 failed.
- `npx tsx script/check-style.ts` no long dashes, 159 files scanned.

## Files created

| File | Lines |
| --- | --- |
| `db/migrations/0011_transaction_register.sql` | 371 |
| `server/runs/runs/import-parse-feed.ts` | 887 |
| `server/runs/runs/import-commit-batch.ts` | 496 |
| `server/runs/__tests__/import-pipeline.ts` | 645 |

## Files modified

`db/migrations/README.md`, `server/runs/NOTES.md` (296 lines, decisions 15 to 28
appended), `server/runs/contract.ts`, `server/runs/tables.ts`,
`server/runs/db.ts`, `server/runs/db-memory.ts`, `server/runs/db-postgres.ts`,
`server/runs/apply-writer.ts`, `server/runs/run-log.ts`, `server/runs/ids.ts`,
`server/runs/registry.ts`, `server/runs/index.ts`,
`server/runs/__tests__/fixtures.ts`, `server/runs/__tests__/index.ts`.

Nothing under `client/`, `docs/`, `.github/`, `package.json`, or migrations 0001
to 0010 was touched. The `client/` entries in `git status` and the two `tmp-*.mjs`
files belong to the parallel agent.

## Register columns and why each exists

Provenance: `id`, `firm_id`, `client_id`, `bank_account_id`, `account_number`.
Tenancy keys carry RLS. The account number is denormalized because every coding
run filters on the cash account without joining.

Feed facts: `posted_on`, `amount_cents` bigint, `currency`, `description`,
`check_number`, `bank_code`, `bank_transaction_id`, `source`, `import_batch_id`,
`staged_row_id`. What the bank said, unmodified, plus the link back to the file
it came from. `bank_transaction_id` is the dedup key.

Vendor normalization: `normalized_description`, `normalization_version`,
`vendor_id`. VEN-MATCH-NORMALIZE writes the first two, VEN-MATCH-ASSIGN the
third, and the version lets a normalizer change be replayed against old rows.

Coding answer: `coded_account_number`, `coded_class_id`, `coded_location_id`,
`coding_confidence`, `cascade_level`, `coding_rule_id`, `coding_rule_version`,
`coded_by_run_id`, `coded_at`. The cascade provenance doc 02 requires. The level
plus rule id and version answers which of the nine runs decided this and under
which version of which rule.

Duplicates: `dedup_state`, `duplicate_of_transaction_id`. Distinguishes a row
rejected on a bank id from a row held for review with no bank id.

Transfers and settlements: `transfer_pair_id`, `transfer_role`,
`settlement_batch_id`, `processor_fee_cents`. TXN-PAIR-TRANSFERS and the
processor settlement run.

Suspense: `suspense_reason`, `suspense_item_id`, `suspense_opened_at`. The
reason code enum from doc 00, including SUS-11 for foreign currency.

Ledger link: `journal_entry_id`. Null until the cascade posts. The commit run
writes register rows and posts nothing, so this closes later.

Reconciliation: `cleared`, `cleared_date`, `reconciliation_id`,
`match_tier`, `matched_at`. REC-MATCH-TIERED matches on account, date window,
and amount, and records which tier produced the match.

Batch reversal: `status`, `reversed_by_run_id`, `reversed_at`. Nothing is
deleted and every partial index carries `status = 'active'`.

Manual authority: `manual_override`, `overridden_by`, `overridden_at`. Enforced
by `trg_guard_manual_override`, mirroring run invariant 8.

Version and audit: `version`, `created_at`, `updated_at`, `created_by`,
`updated_by`. `version` is what makes a stale preview detectable.

Also in 0011: `ledger.bank_accounts`, eight foreign keys closing doc 06 C9, and
`bank_account_id` on `import.batches` and `import.staged_rows`.

## Three way decisions

Recorded in full as items 15 to 28 of `server/runs/NOTES.md`.

## Tests

Six new tests in the existing hand rolled harness, no new dependencies:

1. header mismatch refusal, a shifted column and a renamed column, with a
   matching control that proves preview and apply parity;
2. PDF payload refusal by byte signature whatever the file is named;
3. dedup on the bank supplied id at parse time, at commit time as a separate
   recheck, and at the store level as a unique violation;
4. the hold for review path when there is no bank id, including reviewer
   acceptance;
5. batch reversal as a unit, plus a reconciled row blocking the whole reversal;
6. two tenant negative, no staged row, batch, or register row crosses a firm or
   client boundary.
