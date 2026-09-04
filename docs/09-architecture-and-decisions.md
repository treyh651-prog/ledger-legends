# Architecture And Decisions

The engineering summary. What was built, why it is shaped that way, what is known to still need work, and the decision log index.

## What exists today

Forty nine runs across ten modules, plus a run framework, plus twelve database migrations, plus a client portal, plus a bookkeeper firm workspace. 818 tests passing on the last commit. Type check clean, books foot, no long dashes in 290 files, build succeeds.

Module 1 intake: INTAKE-BUILD-CHART, INTAKE-SEED-TASKS, INTAKE-OPEN-REQUESTS, SETUP-IMPORT-BALANCES.

Module 2 coding: TXN-NORMALIZE-VENDORS, TXN-DETECT-DUPLICATES, TXN-PAIR-TRANSFERS, TXN-SPLIT-SETTLEMENTS, TXN-APPLY-RECURRING, TXN-APPLY-RULES, TXN-APPLY-VENDORDEFAULTS, TXN-MAP-BANKCODES, TXN-SWEEP-SUSPENSE.

Module 3 reconciliation: REC-MATCH-TIERED, REC-CLEAR-MATCHED, REC-FLAG-STALE.

Module 4 period end: PER-POST-RECURRING, PER-AMORTIZE-PREPAIDS, PER-SPLIT-LOAN, PER-POST-ACCRUALS, PER-REVERSE-ACCRUALS, PER-POST-DEPRECIATION.

Module 5 AR and AP: AR-REFRESH-AGING, AR-BUILD-STATEMENTS, AR-APPLY-PAYMENTS, AR-CHARGE-LATEFEES, AP-APPLY-EARLYDISCOUNT, AR-WRITEOFF-UNCOLLECTIBLE.

Module 6 substantiation and close: SUB-TIE-BALANCES, SUB-RAISE-REQUESTS, CLS-EVALUATE-GATES, CLS-LOCK-PERIOD, CLS-ROLL-FORWARD, CLS-POST-YEAREND.

Module 7 reporting: RPT-BUILD-PACKAGE, RPT-FLAG-VARIANCES, RPT-REBUILD-FORECAST, RPT-COMPOSE-NARRATIVE.

Module 8 tax compilation: TAX-BUILD-1099, W9-TRACK.

Module 9 practice: PRC-GENERATE-WORK, PRC-ESCALATE-OVERDUE, PRC-NUDGE-REQUESTS.

Payroll and offboarding: PAY-APPROVE-RUN, PAY-POST-REGISTER, CPA-BUILD-HANDOFF, OFFBOARD-BUILD-EXPORT.

Ninety pipeline tests across the modules chain runs in order and prove their invariants together, not just alone.

## The run framework

Every run implements a single interface: describe scope, preview proposals, apply. Preview and apply are the same code path with a boolean flag, which forces preview to equal apply byte for byte. If they diverge, the framework refuses the apply as a stale preview.

Every proposal is deterministic given scope: derived IDs via a seeded ULID, RUN_ID_PLACEHOLDER for the run id, NOW_PLACEHOLDER for timestamps, ACTOR_PLACEHOLDER for who applied it, all substituted at write time by apply-writer. This is what lets preview and apply produce byte-identical hashes.

Every run stamps the cascade level, the rule id, the rule version, and the source that decided it into provenance columns on the row. A change to a rule tomorrow does not erase the fact that a July row was coded by version 2 of that rule.

Every run respects manual override, at both the run level and the store level. Every run skips a locked period with reason locked_period rather than throwing. Every run must be idempotent, which means running it twice against the same scope makes no additional writes.

Money is bigint cents throughout. There is a lint that fails the build if float appears anywhere under server/.

## The nineteen close gates

G01 clearing and suspense at zero (1900, 1910, 1920, 1930, 1990).
G02 bank register cleared to statement per bank account.
G03 reconciliation difference zero per bank account.
G04 AR subledger equals AR control.
G05 AP subledger equals AP control.
G06 inventory count equals inventory GL.
G07 fixed assets schedule equals asset GL.
G08 loan schedule equals loan liability GL.
G09 prepaid schedule equals prepaid asset GL.
G10 payroll register equals payroll liability GL.
G11 current period reversal set equals prior period accrual set.
G12 depreciation posted for every open asset.
G13 every rule assignment carries a rule version.
G14 no journal line dated in a locked period.
G15 every posted line carries a cascade level and a rule id, or the manual override reason.
G16 the trial balance foots to zero.
G17 no orphan document requests older than 30 days without owner change.
G18 preparer is not the approver for any run in the period (D4).
G19 cash basis derived equals accrual basis minus AR change minus AP change (D3).

CLS-EVALUATE-GATES runs every one as a pure boolean plus a payload of blocking rows. CLS-LOCK-PERIOD refuses to run if any gate returns false. Every gate has a passing and a failing test.

## Migrations

0001 tenancy. 0002 ledger core with cash basis columns baked in. 0003 run log. 0004 rules. 0005 subledgers. 0006 close. 0007 entitlement (renamed from billing per D1). 0008 vault. 0009 import. 0010 run storage. 0011 transaction register. 0012 reconciliation adds statement_lines and rec_batches. 0013 period end adds linked_document_id, half_month_convention, amortization_schedule_id, and prepaid_allocations. 0014 AR and AP adds thirteen subledger tables that did not exist. 0015 close adds seven tables in a new close schema. 0016 reporting adds ten tables in a new report schema. 0017 compliance and practice adds tax, payroll, CPA handoff, offboard, and practice tables with four named check constraints. 0018 intake adds mapping profiles, wizard sessions, and standard chart plumbing.

Every migration since 0014 uses RLS enable and force, a client_isolation policy, a discriminator freeze trigger to prevent tenancy predicates being disabled, and an override guard trigger where writes must never touch overridden rows.

## Named database constraints

pay_run_no_disbursement_authority. Refuses any attempt to set authorizes_disbursement true on a payroll approval. Payroll never disburses in this software.

register_one_per_run_period. One posted register per pay run per period per client.

export_production_days. Offboarding archives must complete within fifteen business days per D9.

data_set_compilation_only. Tax data sets carry the compilation only banner and cannot be marked as a filing.

## The decision log

server/runs/NOTES.md is 128 entries long. Every entry has three to five options, the choice made, and the reasoning. A summary of the highest impact ones:

D1 to D9 in docs/05-decisions.md: bundled entitlement, intake formats (no PDF statements), accrual native cash derived, non CPA scope, payroll approve only, weighted average periodic inventory, seven year vault, SHA-256 signature evidence, fifteen business day offboard export.

Framework defects the tests caught: scopeHashFor did not carry the period, so two adjacent periods deduped as one (fixed in period end module). ACTOR_PLACEHOLDER did not exist so preview and apply refused each other when a run needed to stamp its applier (fixed in close module). Ledger fingerprint needed in scope hash for reporting and close runs so a rebuild after a posting produces fresh output rather than a stale dedupe hit (fixed in reporting module).

Real accounting defects the tests caught: dayGap returned absolute value so a bill not yet due aged as past due (fixed in AR and AP). foreignCurrencySkip was not enforced at level 6 so a euro row with a matching rule was coded rather than routed to SUS-11 (fixed in coding module). Duplicate detection collided rows with null normalized vendor as empty string (fixed in coding module). 1099 header counted a payee before exclusion dropped its lines (fixed in tax module). Offboarding counted its own run log into the export manifest (fixed in offboarding). AP discount did not write the ledger so the subledger drifted from the payable control (fixed in AR and AP). Suspense account was 6900 (expense) rather than 1990 (asset) so unresolved items understated net income (fixed in suspense correction).

None of these would have shipped with obvious defects. Every one was caught by the pipeline test that runs the module as a whole rather than by review of a single run.

## What is still not built

Backend wiring. The runs execute against an in memory port today. Migrations exist but are not run. Next block wires a real Postgres, runs the twelve migrations, seeds the templates, and swaps the in memory port for the real one.

Trigger.dev scheduling. Nothing runs on a clock yet. Nightly aging, weekly forecast, monthly close sweeps all need it.

Manual override management UI. The framework respects overrides and refuses to touch them. There is no page yet where you set, view, or clear one. All overrides today are set through the row edit dialog on the transaction page.

Reason code resolution workflow UI. Reason codes get assigned. There is no dedicated resolution page yet that walks a bookkeeper or a client through resolving them in sequence. Today you work them through Open items.

Document request loop end to end. The bookkeeper side exists at Open items. The client side exists at Portal documents. The two sides are not yet threaded through a single conversation view.

Intake wizard finish button binding to the four setup runs. The wizard creates the client record today. The four setup runs are wired and tested. The button that runs them from the wizard on Finish is not yet on the wizard, so today the runs are invoked separately after the wizard writes the client.

Mapping profiles page. Saved mapping profiles per bank account exist as a data structure. A dedicated page to review, edit, and preview them against sample rows is not yet built.

Real external sends. Every notify side effect writes to the audit log tonight. When we wire external email, it is opt in per client per notification type, per D4 compliance framing.

## Testing

818 unit and pipeline tests, one hand rolled harness. Print based, no jest or vitest dependency. Every test file is registered in server/runs/__tests__/index.ts. Each run has at least ten tests. Each pipeline chains a module and asserts the module level invariants that a single run cannot prove.

CI runs on every push: tsc types clean, books foot, no float money, no localStorage, no long dashes, no plaintext credentials, no has_feature in tenancy or ledger migrations (entitlement is not a tenancy predicate, D1), then all 818 tests, then build.

## Constraints that are baked in, not aspirational

Money is bigint cents. Full stop. The build fails otherwise.

No AI in the software. No ML in the software. Every automation is deterministic rules. This is a product decision, not a technical limit. It is what makes the software auditable at all.

No external sends tonight. Every notify is an audit row.

No localStorage or sessionStorage anywhere in the client. The preview iframe blocks it and it would silently break in production too. State is in memory and URL only.

No PDF statement parsing ever. This is a database constraint, not a policy line item. Attempts refuse.

No em dashes, no en dashes, no hyphens as sentence connectors in comments, prose, or UI copy. A script scans 290 files on every push and fails the build if it finds one.

Manual override wins and stays. No run touches an overridden row. If a rule should fire and it does not, the row carries an override, clear it and the rule fires.

## The three options rule

Every defect, every ambiguity, every place the specs are underspecified, three to five options with the choice and the reason are written to server/runs/NOTES.md. 128 entries as of today, still growing. Never fix silently.
