# Module 4, period end. Build report

## New files

| File | Lines |
| --- | --- |
| db/migrations/0013_period_end.sql | 254 |
| server/runs/runs/per-shared.ts | 259 |
| server/runs/runs/per-post-recurring.ts | 440 |
| server/runs/runs/per-amortize-prepaids.ts | 531 |
| server/runs/runs/per-split-loan.ts | 589 |
| server/runs/runs/per-post-accruals.ts | 385 |
| server/runs/runs/per-reverse-accruals.ts | 300 |
| server/runs/runs/per-post-depreciation.ts | 636 |
| server/runs/__tests__/per-fixtures.ts | 410 |
| server/runs/__tests__/per-post-recurring.ts | 303 |
| server/runs/__tests__/per-amortize-prepaids.ts | 304 |
| server/runs/__tests__/per-split-loan.ts | 284 |
| server/runs/__tests__/per-post-accruals.ts | 268 |
| server/runs/__tests__/per-reverse-accruals.ts | 253 |
| server/runs/__tests__/per-post-depreciation.ts | 323 |
| server/runs/__tests__/per-pipeline.ts | 298 |

Modified: registry.ts, ids.ts, tables.ts, contract.ts, apply-writer.ts, db.ts,
db-memory.ts, db-postgres.ts, __tests__/index.ts, __tests__/coding-fixtures.ts,
NOTES.md. Nothing in client/, docs/, .github/ or package.json was touched.

## Run types

PER-POST-RECURRING, PER-AMORTIZE-PREPAID, PER-SPLIT-LOANPAYMENT,
PER-POST-ACCRUALS, PER-REVERSE-ACCRUALS, PER-POST-DEPRECIATION, registered in
`PERIOD_END_ORDER` with reversals first so a period opens before it posts.

## Gates

* `npx tsc --noEmit` clean
* `npx tsx server/runs/__tests__/index.ts` 247 passing, up from the 155 baseline
* `npx tsx script/check-style.ts` no long dashes, 206 files scanned
* `npx tsx script/check-books.ts` ALL CHECKS PASSED
* `npm run build` dist/index.cjs 795.7kb
* no `parseFloat` anywhere in server/

## Migration

Yes, 0013_period_end.sql was needed. journal_entries gained reverses_on,
linked_document_id and accrual_template_id plus a check and an index,
transactions gained amortization_schedule_id, fixed_assets gained
half_month_convention, macrs_recovery_years, ddb_factor_bps and version, the
deferral, loan and depreciation tables gained version columns,
recurring_templates gained posting_date_rule and driver_amount_cents, and
subledger.accrual_templates is new with the client isolation policy and the
freeze and override triggers.

## Decisions

Records 54 through 64 in server/runs/NOTES.md, each with three to five options,
the choice and the reason. The framework defect is record 54: `scopeHashFor`
omitted the period, so February deduplicated against January and posted nothing.
