# Ledger Legends: run specifications

Status: implementation spec. This file is subordinate to `docs/00-conventions.md`. Where this file and the conventions file disagree, the conventions file wins and this file is the defect.

Scope: 43 runs across intake and setup, transactions and coding, reconciliation, recurring and period end, AR and AP, substantiation, close, reporting, and practice. Each run is a deterministic rule.

---

## Part A. The determinism contract

Ledger Legends contains no artificial intelligence and no machine learning. Nothing here trains, infers, scores, or predicts.

1. **Identical input produces identical output.** A run executed twice over an unchanged data set produces byte identical proposals, byte identical postings, and the same ordered log. The only differences permitted between two executions are the run execution id, the wall clock timestamp, and the actor.
2. **Every output is explainable in one sentence a client understands.** The engine stores the sentence, not a rationalization generated later. Example: "Coded to CAT-SOFTWARE by RULE-01HX7 at cascade level 6 because the normalized vendor string equals ADOBE and the amount is between 1000 and 99900 cents."
3. **No confidence values.** There is no score, no percentage, no probability, no ranking by likelihood. A run either resolves a case under a stated rule or it does not resolve it and records a skip reason or a suspense code.
4. **No fuzzy matching.** Matching is exact equality on normalized values, or numeric equality within a stated integer cent tolerance, or date equality within a stated integer day window. Tolerances and windows are configuration values with defaults stated in each spec. There is no edit distance, no token similarity, no phonetic match, no embedding.
5. **Ordering is total.** Wherever a run iterates a set, the iteration order is stated as an explicit sort with a final unique tie breaker, normally the record id ascending. No run may depend on database return order.
6. **Arithmetic is integer cents.** No floating point value enters any computation. Where a rate is applied, the rate is stored as an integer basis point or an integer numerator and denominator, and the result is rounded by the shared rounding rule below.
7. **Rounding rule.** All allocation and rate arithmetic uses round half away from zero at the cent. Where a total must be preserved across n allocated parts, the first n minus 1 parts are rounded and the final part is the total minus the sum of the earlier parts. The final part is always the chronologically last period, or where there is no time order, the part with the highest sequence number. Residual never disappears and never duplicates.
8. **Version stamping.** Every write records the run type version, the rule version, the category version, and the vendor normalization function version in force at execution. A later change never rewrites an earlier stamp.

### Common run envelope

Every run, without exception, carries the following. Individual specs below state only what is specific to that run.

| Envelope field | Meaning |
|---|---|
| `run_type` | `<MODULE>-<VERB>-<OBJECT>` |
| `run_execution_id` | `RUNX-` plus ULID |
| `scope` | client id, period id or date range, and optional account filter |
| `mode` | `preview` or `apply`. Preview computes everything and writes nothing but the log. |
| `actor` | user id, or `scheduler` |
| `started_at`, `finished_at` | timestamps |
| `counts` | considered, acted, skipped, blocked, errored |
| `outcome` | `completed`, `completed_with_skips`, `blocked`, `failed` |

Every run supports `mode = preview`. A preview execution is logged and is a valid CI target.

### Common log record

Every run writes one run execution header plus one line item per considered record. A line item carries the record id, the decision (`acted`, `skipped`, `blocked`), the deterministic reason string, the cascade level or rule id where applicable, the before value, the after value, and the version stamps. Log records are append only. Nothing in the log is ever updated or deleted.

### Reversal model

There are three reversal shapes and every run states which one it uses.

- **Shape R1, proposal withdrawal.** The run only proposed. Reversal deletes the open proposals created by that run execution and logs the withdrawal. No ledger effect.
- **Shape R2, field restore.** The run wrote a field on an existing record. Reversal restores the before value captured in the log, for rows that have not since been manually overridden. Rows overridden after the run are left alone and reported as `skipped_manual_override`.
- **Shape R3, reversing journal entry.** The run posted journal entries. Reversal posts a mirror entry with opposite signs, dated per the rule stated in the spec, linked to the original by `reverses_entry_id`. Original entries are never deleted or edited. If the original period is locked, the reversing entry is dated the first day of the earliest open period and the log records `SUS-20` handling.

---

## Part B. Execution order for the coding runs, and why

The coding runs implement the cascade in Part 3 of the conventions document. The cascade is evaluated per transaction, but the runs execute as a fixed pipeline over a batch, because several levels need a completed set before they can decide. The order is not a preference. Each step depends on state the previous step produced.

| Step | Run | Cascade level served | Why it must be here |
|---|---|---|---|
| 0 | `TXN-NORMALIZE-VENDORS` | Feeds levels 2, 6, 7 | Duplicate detection, rules, and vendor defaults all compare normalized strings. Normalizing after any of them would make matches depend on import order. |
| 1 | `TXN-DETECT-DUPLICATES` | 2 | A duplicate must be flagged before anything codes it, otherwise the books carry a coded double count that later runs treat as real activity. |
| 2 | `TXN-PAIR-TRANSFERS` | 3 | Stated explicitly in the conventions. An unpaired internal transfer coded by a rule inflates revenue and expense at the same time. Pairing needs both sides present, so it is a batch step, not a per row step. |
| 3 | `TXN-SPLIT-SETTLEMENTS` | 4 | Processor deposits are net of fees. If a rule codes the net deposit to revenue first, gross revenue and processor fees are both understated and 1910 never clears. Runs after transfer pairing because a processor payout between two client accounts must not be mistaken for a transfer. |
| 4 | `TXN-APPLY-RECURRING` | 5 | Templates carry fixed splits that are more specific than any single rule and must not be overwritten by a broad rule. |
| 5 | `TXN-APPLY-RULES` | 6 | The general engine. Runs after every structural level so it only sees transactions with no structural interpretation. |
| 6 | `TXN-APPLY-VENDORDEFAULTS` | 7 | A fallback for a known vendor with no rule. Deliberately weaker than a rule so a rule can carve out an exception. |
| 7 | `TXN-MAP-BANKCODES` | 8 | The weakest signal, a bank supplied code. Last because it is the coarsest. |
| 8 | `TXN-SWEEP-SUSPENSE` | 9 | Terminates the cascade. Everything unresolved lands in 1990 with a reason code. Must run last, otherwise it would sweep rows that a later step would have resolved. |

Two consequences of the order.

- Any run in steps 1 to 7 that finds a transaction already resolved at a lower numbered level skips it and records `already_resolved_level_n`. There is no second decision.
- A rerun of the whole pipeline after a rule change is safe. Steps 1 to 8 skip rows with a manual override flag, skip rows in locked periods, and skip rows already resolved at a level below the one they serve. Only rows currently sitting in 1990 or currently uncoded can change.

Rerun policy for the pipeline as a whole: `TXN-SWEEP-SUSPENSE` writes suspense postings that are reversed by `TXN-SWEEP-SUSPENSE` reversal before a full pipeline rerun. The orchestrator does this automatically when the operator selects "rerun coding for this period".

---

## Part C. No run crosses a locked period

This is a single rule enforced in one place, not repeated logic per run.

**Rule.** Every run passes its intended write set through one gate function, `assert_open(client_id, effective_date)`. The function returns open, locked, or not_yet_opened. A write to a locked date is refused at the data layer, not at the run layer, so a run that forgets the check still cannot write.

**Behavior for reads.** Runs may read locked periods freely. Comparatives, aging history, roll forward balances, prior year 1099 totals, and depreciation to date all read across locked periods. Reading is never blocked.

**Behavior for writes.**

1. A transaction dated in a locked period is skipped at cascade level 1 with skip reason `locked_period`. It is not coded, not swept to suspense, and not counted as an exception for the current period.
2. A run whose natural posting date falls in a locked period, for example a prepaid release for a month that closed while the schedule was inactive, posts instead on the first day of the earliest open period and records `redated_from_locked_period` on the entry and in the log, with suspense reason `SUS-20` raised on the source item where a source item exists.
3. A reversal targeting a locked period follows shape R3 with the redate rule above. Locked entries are never deleted or edited.
4. A run scoped by an operator to a locked period returns outcome `blocked` immediately with a single log line and no per record work. It does not partially execute.
5. A period closed with exceptions is still locked. The exception flag changes reporting, not write authority.
6. Unlocking is not a run. It is a manual administrative action outside this document, recorded in close history, and it invalidates nothing already logged.

---

## Part D. Which runs may auto post, and which may only propose

The dividing line is simple and it is about authority rather than difficulty. A run may post when the entry it produces is fully determined by a schedule, a document, or an arithmetic identity that a person already approved. A run must only propose when the entry encodes a judgment about what something is or whether somebody will pay.

### May auto post

| Run | Why posting is safe |
|---|---|
| `TXN-PAIR-TRANSFERS` | Both sides exist in the bank feed. The entry moves money between two accounts the client owns and has no income statement effect. |
| `TXN-SPLIT-SETTLEMENTS` | Gross, fee, and net come from the processor settlement file and must sum exactly. Refuses to post if they do not. |
| `TXN-SWEEP-SUSPENSE` | Posting to 1990 is the safe destination by design. Not posting would leave a transaction invisible, which the conventions forbid. |
| `PER-POST-RECURRING` | Template approved once by a human, with a fixed amount or a fixed split. |
| `PER-AMORTIZE-PREPAID` | Straight line release from an approved schedule. |
| `PER-SPLIT-LOANPAYMENT` | Split comes from a lender amortization schedule already loaded and approved. |
| `PER-POST-DEPRECIATION` | Method, life, and in service date approved at asset setup. |
| `PER-REVERSE-ACCRUALS` | Mechanical mirror of an entry that already posted. |
| `REC-CLEAR-MATCHED` | Sets a cleared flag, no journal effect. |
| `AR-APPLY-PAYMENTS` | Only posts on an exact single invoice match or an explicit remittance instruction. Everything else proposes. |
| `CLOSE-ROLL-FORWARD`, `CLOSE-POST-YEAREND` | Arithmetic identity over a closed period, executed after gates pass. |
| `ARAP-REFRESH-AGING` | Derived data only, no journal effect. |

### Must only propose

| Run | Why a person must approve |
|---|---|
| `TXN-APPLY-RULES` | Configurable by a user and therefore capable of encoding a mistake at scale. Default is propose. See the promotion rule below. |
| `TXN-APPLY-VENDORDEFAULTS`, `TXN-MAP-BANKCODES` | Weaker signals than a rule. Always propose. |
| `TXN-APPLY-RECURRING` | Proposes the coding of a bank transaction against a template. The template posting run is separate. |
| `TXN-DETECT-DUPLICATES` | Flags only. Never deletes, never merges. Stated in the conventions. |
| `REC-MATCH-TIERED` | Tier 1 may post the match link, tiers 2 and 3 propose. See the run spec. |
| `REC-FLAG-STALE` | Flags for a human decision to void, write off, or confirm. |
| `PER-POST-ACCRUALS` | The estimate is a judgment even when the calculation is mechanical. Proposes, then posts on approval. |
| `AR-CHARGE-LATEFEES` | Client relationship decision. |
| `AP-APPLY-DISCOUNTS` | Depends on a payment actually being made by the discount date. |
| `AR-WRITEOFF-UNCOLLECTIBLE` | Never automatic at any age. |
| `SUB-TIEOUT-ACCOUNTS` | Computes variance, sets no tie out state above `computed`. A human sets `tied`. |
| `TAX-BUILD-1099` | Produces a draft return set for review before filing. |
| `RPT-COMPOSE-NARRATIVE` | Draft text always editable before it reaches a client. |
| All intake and practice runs | Create tasks and requests, never ledger effect. |

### Rule promotion, the only path from propose to post

`TXN-APPLY-RULES` may post for a specific rule only when all of the following are true, evaluated at execution time and recorded on the entry.

1. The rule has `auto_post_enabled` set true by a named firm user, with the date and user id stored.
2. The rule has at least 25 accepted applications and zero rejected applications at its current version. Editing the rule resets both counters to zero and clears `auto_post_enabled`.
3. The rule targets a category whose `tax_treatment` is not `personal`, `owner_draw`, `owner_contribution`, or `capital`.
4. The transaction amount is at or below the rule's `auto_post_ceiling`, default 250000 cents.
5. The client is not flagged `cleanup_engagement`.

If any condition fails, the run proposes. The failed condition is named in the log.

---

## Part E. Run specifications

Each specification below uses the same eleven headings in the same order.

---

## Module 1. Intake and setup

### INTAKE-BUILD-CHART, Build chart of accounts from template

**Fires from.** `/intake` step 10, the review and open the file step. Also available as a rerun from `/clients` accounts and systems tab while the client is in stage `onboarding`.

**Purpose.** Materialize a client specific chart of accounts and category set from a chart template plus the engagement scope answers captured in the wizard.

**Scope options.** Client only. No period. No account filter. One client per execution.

**Inputs read.** Chart template `TPL-*` and its version, the intake scope answers (entity type, nonprofit flag, inventory in scope, payroll in scope, sales tax in scope, fixed asset register in scope, related entities in scope), the client functional currency, and the global mandatory account list.

**Deterministic rule.**
1. Load the selected template at its current version. Sort template accounts by account number ascending.
2. Include an account when its `always` flag is true, or when its `scope_key` is present in the client scope answers with value true.
3. Force include the five clearing and suspense accounts 1900, 1910, 1920, 1930, 1990 regardless of template, per Part 1 of the conventions. If the template omits any of them, create it from the global definition and log `forced_mandatory_account`.
4. For every included fixed asset cost account in 1500 to 1599, require the matching accumulated depreciation account at cost account number plus 100. Create it if the template lacks it. If the target number is already occupied by an account that is not the matching contra account, do not create anything, record `contra_pair_collision`, and mark the run `completed_with_skips`.
5. If the client is a nonprofit, replace the 3000 to 3999 equity block with the two net asset classes, with donor restrictions and without donor restrictions, and set `restriction_relevant` true on every revenue category flagged `contribution` in the template.
6. Create categories from the template category set, one row each, each mapping to exactly one included account. A category whose account was not included is not created and is logged `category_account_out_of_scope`.
7. Set `capitalize_over` on every category with `tax_treatment = capital` to the client setting if present, otherwise 250000 cents.
8. Iteration is by account number ascending then category slug ascending. Creation order is deterministic and reproducible.

**Deliberately skips.** Template accounts whose scope key is false, reason `out_of_engagement_scope`. Any account number already present on the client chart, reason `account_exists`, with no overwrite of the existing name or type. Categories mapping to excluded accounts, reason `category_account_out_of_scope`.

**Writes.** Accounts, categories, and the client chart version stamp. Posts nothing to the ledger, since a chart is not a transaction. This run creates records but produces no journal entry, so it is neither propose nor post in the ledger sense. It is a structural write and requires an operator to confirm in the wizard before it executes.

**Logs.** Template id and version, every account created with its source (`template`, `forced_mandatory`, `contra_pair`), every account skipped with reason, every category created and skipped, and the resulting counts.

**Reverses.** Shape R2 at the record level, restricted. Reversal deletes only accounts and categories created by this run execution that have zero transactions, zero journal lines, and zero rule references. Anything with usage is retained and reported as `retained_in_use`. Mandatory clearing accounts are never deleted.

**Blocked by.** Client already has a chart with at least one posted journal entry. No template selected. Intake scope answers incomplete. Functional currency not set.

**Test assertions.**
- Running against `TPL-NONPROFIT` produces exactly two accounts in 3000 to 3999.
- Every produced chart contains 1900, 1910, 1920, 1930, and 1990, for all four seeded templates.
- For every account created in 1500 to 1599, the account at number plus 100 exists and is typed contra asset.
- Every created category resolves to exactly one existing account.
- Two executions against the same fixture produce identical account and category sets, compared as sorted id lists.
- With inventory out of scope, no 1200 to 1299 account is created.

---

### INTAKE-SEED-TASKS, Seed the engagement task list

**Fires from.** `/intake` step 10 on file open. Also fires from `/clients` scope tab when an operator changes engagement scope and confirms the change.

**Purpose.** Create the recurring and one time task list that the engagement scope implies, so nothing depends on somebody remembering the standard checklist.

**Scope options.** Client, and optionally a starting period. Defaults to the first open period.

**Inputs read.** Engagement scope answers, service frequency (monthly, quarterly, annual), the standard task catalog with each entry's scope key and due day offset, assigned lead and preparer from the access and roles step, and the client period calendar.

**Deterministic rule.**
1. Select catalog tasks whose `scope_key` is true in the client scope, or whose `always` flag is true.
2. For each selected task, generate occurrences for the next 12 periods from the starting period, using the task frequency. A monthly task generates 12, a quarterly task generates 4 on period end months 3, 6, 9, 12 of the client fiscal year, an annual task generates 1 in the fiscal year end period.
3. Due date equals period end date plus `due_day_offset` calendar days. If the result falls on a Saturday it moves to the following Monday, and if it falls on a Sunday it moves to the following Monday. No other holiday calendar is applied, because a holiday calendar is client and jurisdiction specific and would make output non reproducible across environments.
4. Assignment: preparer role tasks go to the client preparer, review role tasks go to the client lead. If either is unset, the task is created unassigned and counted in `unassigned`.
5. Iteration order is catalog code ascending then period ascending.

**Deliberately skips.** A task occurrence that already exists for the same catalog code, client, and period, reason `task_exists`. Occurrences in a locked period, reason `locked_period`. Catalog entries out of scope, reason `out_of_engagement_scope`.

**Writes.** Task rows only. Never posts. No ledger effect.

**Logs.** Catalog codes selected, occurrences created per code, occurrences skipped with reason, unassigned count, and the due date rule version.

**Reverses.** Shape R1 style deletion of task occurrences created by this execution that are still in state `open` and have no comments, no time entries, and no linked requests. Tasks in any other state are retained and reported.

**Blocked by.** No service frequency set. No period calendar for the client. Client stage is `prospect`.

**Test assertions.**
- With payroll out of scope, zero tasks with catalog code prefix `PAY` exist.
- A quarterly task produces exactly 4 occurrences over 12 months, in the correct fiscal quarter end periods for a June fiscal year end client.
- No generated due date is a Saturday or a Sunday.
- Rerunning immediately creates zero new tasks and logs every candidate as `task_exists`.

---

### INTAKE-OPEN-REQUESTS, Open the initial client document requests

**Fires from.** `/intake` step 10, and `/requests` via the action "open standard requests".

**Purpose.** Create the opening document requests the engagement needs, so the client portal has a populated "what we need" list on day one.

**Scope options.** Client, and optionally a prior records date range for historical documents.

**Inputs read.** Engagement scope, the prior records answers from step 6, the accounts inventory from step 5, the standard request catalog with escalation ages, and existing open requests for the client.

**Deterministic rule.**
1. Always request: signed engagement letter if unsigned, Form W-9 if the client is itself a payee of the firm and no W-9 is on file, and prior year final trial balance if the client is not a new entity formed in the current fiscal year.
2. For every bank and card account in the accounts inventory, request statements for each month in the prior records range that has no statement document on file. One request per account per month.
3. If fixed asset register is in scope, request the depreciation schedule. If payroll is in scope, request the most recent four payroll provider reports. If sales tax is in scope, request the last filed return. If related entities are in scope, request the related entity list with ownership percentages.
4. Escalation age comes from the catalog, defaulting to 10 days. Client owned suspense codes referenced by a request inherit the escalation age from Part 4 of the conventions when the request is generated from a suspense item.
5. Iteration order is request catalog code ascending, then account number ascending, then period ascending.

**Deliberately skips.** A request identical in catalog code, account, and period to an existing open or satisfied request, reason `request_exists`. Documents already on file, reason `document_on_file`. Requests for months before the engagement start date, reason `before_engagement_start`.

**Writes.** Request rows and portal notifications. Proposes nothing to the ledger. No journal effect.

**Logs.** Requests created per catalog code, skips with reason, and the resulting count of open requests by owner.

**Reverses.** Deletion of requests created by this execution that are still `open` with zero uploads and zero messages. Anything touched by the client is retained.

**Blocked by.** No portal access configured for the client. Client stage is `prospect`.

**Test assertions.**
- A client with 3 bank accounts and a 6 month prior records range, with no statements on file, receives exactly 18 statement requests.
- Zero duplicate requests exist after two consecutive executions.
- With sales tax out of scope, zero requests with catalog code prefix `TAX` exist.
- Every created request carries an escalation age greater than zero.

---

### SETUP-IMPORT-BALANCES, Import and validate opening balances

**Fires from.** `/intake` step 6, prior records, and `/journal` via "import opening balances".

**Purpose.** Load the prior year closing trial balance as the opening balance journal entry and prove it balances before anything else is posted.

**Scope options.** Client and a single opening date, which must equal the day before the first open period start.

**Inputs read.** The uploaded trial balance file mapped to account numbers, the client chart, the opening date, and any existing opening balance entry.

**Deterministic rule.**
1. Parse the mapped file into integer cents. A value that cannot be parsed as an exact integer cent, including any value with more than two decimal places, fails the whole import. No rounding on import, ever.
2. Every source account number must exist on the client chart. Unmapped numbers fail the import with a list, they are not created silently.
3. Build one journal entry dated the opening date, source `opening_balance`, one line per account, debit positive and credit negative.
4. Sum all lines. The entry posts only if the sum is exactly zero. If the sum is not zero, the run refuses. It does not plug the difference to suspense, because an opening balance that does not balance is a data problem, not a coding problem.
5. Retained earnings or net assets is imported as given. The run never computes it.
6. Line order is account number ascending.

**Deliberately skips.** Accounts with a zero balance in the source, reason `zero_balance_line_omitted`. Nothing else is skipped, because a partial opening balance is worse than none.

**Writes.** One posted journal entry, marked `source = opening_balance` and `system_generated = true`. Posts, not proposes, but only after the operator confirms the preview and only when the balance test passes.

**Logs.** Line count, total absolute value, the balance test result, unmapped account list, and the file checksum.

**Reverses.** Shape R3. A reversing entry dated the same opening date if that period is open, otherwise the first day of the earliest open period with `redated_from_locked_period`.

**Blocked by.** An opening balance entry already exists for the client. The opening date falls inside a locked period. Any account in the file is missing from the chart. The lines do not sum to zero.

**Test assertions.**
- A file summing to a non zero total produces outcome `blocked` and writes zero journal lines.
- A file with a value of 100.005 fails parsing and writes nothing.
- After a successful import, the trial balance for the opening date nets to zero.
- Reversal produces a net zero effect on every account touched.

---

## Module 2. Transactions and coding

All nine runs in this module obey Part B execution order and Part C locked period handling. All nine skip any row with the manual override flag set, cascade level 0, reason `manual_override`, and none of them ever clears that flag.

### TXN-NORMALIZE-VENDORS, Normalize vendor descriptors

**Fires from.** `/transactions` on feed import, and manually from `/transactions` via "rerun coding".

**Purpose.** Produce the versioned normalized vendor string that duplicate detection, rules, and vendor defaults all compare against.

**Scope options.** Client, period or date range, and optional bank account filter.

**Inputs read.** Raw bank descriptor, bank supplied merchant name where present, the processor prefix list, the store and terminal suffix pattern list, and the current normalization function version.

**Deterministic rule.** Apply in this exact order to the raw descriptor.
1. Uppercase using invariant casing.
2. Replace every character that is not A to Z, 0 to 9, or a space with a single space.
3. Collapse runs of whitespace to one space and trim both ends.
4. Strip a known processor prefix when the string starts with it followed by a space. The prefix list is data, sorted longest first so the longest match wins. Only one prefix is stripped per string.
5. Strip a trailing store or terminal number, defined as a trailing token matching one to six digits, optionally preceded by the literal token `STORE` or `TERM` or a single `#`. Only one trailing token group is stripped.
6. Collapse whitespace again and trim.
7. If the result is an empty string, keep the result from step 3 and set `normalization_degraded = true`.

The function is pure. It reads no other transaction and no history.

**Deliberately skips.** Rows already carrying a normalized string produced by the current function version, reason `already_normalized_current_version`. Rows in a locked period, reason `locked_period`. Rows with the manual override flag on the vendor field, reason `manual_override`.

**Writes.** `vendor_normalized` and `vendor_normalization_version` on the transaction. No ledger effect. Posts nothing.

**Logs.** Raw string, output string, version, and which steps altered the string.

**Reverses.** Shape R2, restore the prior normalized string and version from the log.

**Blocked by.** Normalization function version not set. Scope resolves to a locked period only.

**Test assertions.**
- `SQ *BLUE BOTTLE COFFEE #1147` normalizes to `BLUE BOTTLE COFFEE`.
- `tst* joe's pizza  ` and `TST* JOE S PIZZA` both normalize to `JOE S PIZZA`.
- The function is idempotent: normalizing an already normalized string returns the same string.
- A descriptor consisting only of digits keeps a non empty output and sets `normalization_degraded`.
- Two prefixes present strips exactly one.

---

### TXN-DETECT-DUPLICATES, Flag possible duplicate transactions

**Fires from.** `/transactions`, after import and from "rerun coding".

**Purpose.** Identify transactions that may be the same economic event captured twice, and stop them being coded until a person decides.

**Scope options.** Client, period or date range, optional account filter.

**Inputs read.** Transactions in scope plus transactions in the surrounding 3 day buffer outside the scope window, the normalized vendor string, existing `legitimate_repeat` links, and existing duplicate flags.

**Deterministic rule.** Two transactions A and B are a duplicate candidate pair when all of the following hold, per Part 3 of the conventions.
1. Same client.
2. Same bank or card account.
3. Equal absolute amount, exact integer cents, no tolerance.
4. Equal normalized vendor string, exact equality, no fuzzy comparison.
5. Absolute difference between the two dates is 3 calendar days or fewer.
6. Neither is linked to the other as a `legitimate_repeat`.
7. Neither carries a manual override marking it distinct.

Evaluation order: sort candidates by date ascending, then absolute amount ascending, then transaction id ascending. Within a group of three or more mutually matching transactions, the earliest by that sort is the retained original and every later member is flagged against it. Flagging is one directional, later points at earlier, so the graph has no cycles.

**Deliberately skips.** Rows already flagged from a prior execution with the same original, reason `duplicate_flag_exists`. Rows linked as `legitimate_repeat`, reason `confirmed_repeat`. Locked period rows, reason `locked_period`. Manual override rows, reason `manual_override`.

**Writes.** A duplicate flag with a pointer to the retained original, and suspense reason `SUS-05` on the flagged row so `TXN-SWEEP-SUSPENSE` routes it. Proposes only. Never deletes, never merges, never voids. The conventions make this absolute.

**Logs.** Every pair with both ids, the four matched attributes, the date gap in days, and the retained original id.

**Reverses.** Shape R2, remove flags created by this execution where a human has not since confirmed or rejected them. Confirmed and rejected flags are retained.

**Blocked by.** Vendor normalization has not run at the current version for the scope. Scope is entirely locked.

**Test assertions.**
- Two identical amounts 4 days apart produce zero flags.
- Two identical amounts 3 days apart produce exactly one flag, on the later row.
- Three mutually matching rows produce two flags, both pointing at the earliest row, and zero flags pointing at each other.
- A pair linked as `legitimate_repeat` produces zero flags across unlimited reruns.
- Amounts of 10000 and 10001 cents produce zero flags. There is no near amount tolerance.
- Every flagged row carries `SUS-05`.

---

### TXN-PAIR-TRANSFERS, Pair internal transfers through 1920

**Fires from.** `/transactions`, and automatically in the coding pipeline at step 2.

**Purpose.** Recognize money moving between two accounts the client owns and book it through transfer clearing so it never touches revenue or expense.

**Scope options.** Client, period or date range, optional account filter. The counterparty search always spans every account of the client regardless of the account filter, otherwise a filtered run would create false unpaired items.

**Inputs read.** Transactions in scope plus a 3 day buffer, the client account list, existing pair links, and account 1920.

**Deterministic rule.** Transaction A pairs with transaction B when all hold, per Part 3.
1. Same client.
2. Different bank or card accounts, both belonging to that client.
3. Equal absolute amount, exact integer cents.
4. Opposite signs.
5. Date difference of 3 calendar days or fewer.
6. Neither side already paired.

Candidate selection and ambiguity:
- For each unpaired transaction, collect all counterparties satisfying the six tests.
- If exactly one counterparty is found and that counterparty also finds exactly one candidate, namely this transaction, the pair is made. Mutual uniqueness is required in both directions.
- If more than one counterparty is found, or the counterparty finds more than one candidate, no pair is made for any member of that ambiguous set. Every member routes to suspense with `SUS-04`. Ambiguity is a human decision and the engine does not break the tie by date proximity or by anything else.
- Iteration order is date ascending, then absolute amount ascending, then transaction id ascending, so the pairing outcome is reproducible.

Posting: the outbound side debits 1920 and credits the source bank account. The inbound side debits the destination bank account and credits 1920. Both lines carry category `CAT-TRANSFER`. Net effect on 1920 is exactly zero per pair, which is what gate G01 later verifies.

**Deliberately skips.** Already paired rows, reason `already_paired`. Ambiguous sets, reason `ambiguous_pair_routed_SUS-04`. Locked period rows, reason `locked_period`. Manual override rows, reason `manual_override`. Rows already flagged duplicate, reason `duplicate_pending`, because the duplicate question is decided first.

**Writes.** Two journal entries through 1920, a pair link between the two transactions, and category `CAT-TRANSFER` on both. Posts automatically. Authorized to post because both sides are observed facts in the bank feed and the entry has no income statement effect.

**Logs.** Both transaction ids, both account ids, amount, date gap, the entry ids created, and for ambiguous sets, every candidate id considered.

**Reverses.** Shape R3 for the journal entries plus removal of the pair link and the category, for pairs created by this execution and not since manually confirmed.

**Blocked by.** Account 1920 missing from the chart. Either side dated in a locked period, in which case that specific pair is blocked and reported rather than the whole run.

**Test assertions.**
- A matched pair leaves account 1920 with a balance of exactly zero.
- Neither side of a paired transfer appears in any revenue or expense account.
- A transaction with two equal and opposite candidates produces zero pairs and three `SUS-04` items across the set.
- A pair 4 days apart is not paired.
- Same account both sides is never paired.
- Rerunning produces zero new pairs and zero new entries.

---

### TXN-SPLIT-SETTLEMENTS, Split processor settlements through 1910

**Fires from.** `/transactions`, and the coding pipeline at step 3. Also fires when a settlement report is uploaded through `/requests` document review.

**Purpose.** Turn a net processor deposit into gross revenue, processor fee expense, and a net cash line so revenue is not understated by the fee.

**Scope options.** Client, period or date range, and optional processor filter.

**Inputs read.** Bank deposits on accounts flagged as processor destinations, uploaded settlement report rows (payout id, payout date, gross cents, fee cents, net cents, batch reference), account 1910, the processor fee category, and the client revenue category mapped to that processor.

**Deterministic rule.**
1. Match a bank deposit to a settlement payout when the payout reference string on the bank descriptor equals the payout id, exact equality after normalization. If there is no reference, match on equal net amount in exact cents and payout date within 2 calendar days, and only when exactly one settlement row satisfies both. Two or more candidates means no match.
2. Verify the arithmetic identity `gross + fee = net`, with fee stored as a negative integer. If it does not hold exactly, do not post. Route the deposit to suspense with `SUS-17` and log both figures.
3. On a verified match post one entry: debit the bank account for net, debit the processor fee expense category for the absolute fee, credit the mapped revenue category for gross. Lines sum to zero.
4. Where the client policy books gross at sale time rather than at settlement, the credit goes to 1910 instead of revenue and the earlier sales entry has already debited 1910. Policy is a per client setting read at execution, not inferred.
5. A deposit on a processor account with no settlement row yet available goes to suspense with `SUS-12`, the only system owned code. It clears without human action when the settlement file lands and this run executes again.
6. Iteration order is payout date ascending, then payout id ascending.

**Deliberately skips.** Deposits already split by a prior execution, reason `settlement_already_split`. Deposits on non processor accounts, reason `not_a_processor_account`. Settlement rows with no corresponding bank deposit, reason `awaiting_bank_deposit`. Locked period rows, reason `locked_period`.

**Writes.** One posted journal entry per verified payout, the link between deposit and settlement row, and suspense entries for the unresolved cases. Posts automatically, because gross, fee, and net all come from the processor file and the identity is checked before posting.

**Logs.** Payout id, gross, fee, net, the identity check result, the matched deposit id, the entry id, and the client gross policy flag.

**Reverses.** Shape R3, reversing entries plus removal of the deposit to settlement link.

**Blocked by.** Account 1910 missing. No processor fee category mapped. No revenue category mapped for the processor.

**Test assertions.**
- After splitting a payout of gross 100000, fee negative 2900, net 97100, revenue is credited exactly 100000 and 1910 nets to zero for the batch.
- A settlement row where gross plus fee does not equal net posts nothing and creates one `SUS-17` item.
- A deposit with no settlement row creates exactly one `SUS-12` item and no journal entry.
- When the settlement file later arrives, rerunning clears the `SUS-12` item with no human action and the suspense account returns to zero for that item.
- Two settlement rows with the same net amount and date and no reference produce zero matches.

---

### TXN-APPLY-RECURRING, Apply recurring templates and fixed splits to transactions

**Fires from.** `/transactions`, and the coding pipeline at step 4.

**Purpose.** Code a bank transaction that matches an approved recurring template, including any fixed multi category split, without a rule having to encode the split.

**Scope options.** Client, period or date range, optional account filter, optional single template.

**Inputs read.** Active recurring templates for the client with their version, template match conditions (normalized vendor equality, account, amount expectation, expected day of month), the template split definition, and transactions in scope not yet resolved at a lower cascade level.

**Deterministic rule.**
1. A template matches a transaction when the normalized vendor string equals the template vendor exactly, the bank account equals the template account, and the transaction date day of month is within the template `day_window`, default 5 calendar days either side of the expected day.
2. Amount test. If the template is `fixed_amount`, the transaction amount must equal the template amount exactly. If the template is `variable_amount`, the amount must fall within the template band, expressed as absolute integer cents floor and ceiling, both inclusive. If the amount falls outside either test the template does not match and the transaction continues down the cascade.
3. If two or more templates match, apply none. Route to suspense with `SUS-19` and name both template ids, using the same conflict discipline the conventions set for rules.
4. Split allocation. A template split is stored either as fixed integer cents per line, which must sum to the transaction amount exactly, or as integer basis points per line summing to exactly 10000. Basis point splits are allocated by the Part A rounding rule, with the residual assigned to the line with the highest sequence number. A fixed cent split that does not sum to the amount does not apply, and routes to `SUS-17`.
5. Iteration order is transaction date ascending, then transaction id ascending. Templates are evaluated in template id ascending order so conflict reporting is stable.

**Deliberately skips.** Transactions resolved at cascade levels 0 through 4, reason `already_resolved_level_n`. Inactive templates, reason `template_inactive`. Locked period rows, reason `locked_period`.

**Writes.** A coding proposal per transaction, carrying the template id, the template version, and the full split. Proposes only. The operator accepts on `/transactions`, or the rule promotion path does not apply here because templates are approved per template rather than per rule.

**Logs.** Template id and version, match conditions that passed, the amount test result, the split lines with the residual line named, and any conflict ids.

**Reverses.** Shape R1, withdraw proposals from this execution. Accepted proposals are reversed by the coding reversal path, shape R2 on the category field.

**Blocked by.** No active templates for the client, in which case the run completes with zero considered rather than failing.

**Test assertions.**
- A 10000 cent transaction split 3333 or 3333 or 3334 basis point style allocates 3333, 3333, and 3334, with 3334 on the highest sequence line, and the three lines sum to 10000.
- Two matching templates produce zero proposals and one `SUS-19` item naming both template ids.
- A fixed amount template misses by 1 cent and produces no match, and the transaction is available to the rules run.
- A transaction 6 days from the expected day with a 5 day window produces no match.
- Rerunning produces identical proposals with identical split cents.

---

### TXN-APPLY-RULES, Apply categorization rules

**Fires from.** `/transactions` accept and reject controls, `/rules` after a rule is created or edited, and the coding pipeline at step 5.

**Purpose.** Apply the firm authored rule set to unresolved transactions at cascade level 6.

**Scope options.** Client, period or date range, optional account filter, optional single rule id for a targeted rerun.

**Inputs read.** Active rules with priority, conditions, target category, version, accepted and rejected counters, `auto_post_enabled`, `auto_post_ceiling`, the normalized vendor string, transaction amount, sign, bank account, and bank supplied code.

**Deterministic rule.**
1. Condition types are limited to exact equality on the normalized vendor string, prefix match on the normalized vendor string where the prefix is a whole token boundary, integer cent amount range with inclusive bounds, sign equals debit or credit, bank account equality, and bank code equality. Nothing else. There is no substring similarity and no wildcard beyond the token boundary prefix.
2. A rule matches when every one of its conditions is true. Conditions are conjunctive only. There is no OR at the rule level, because a disjunction is two rules and two rules are individually auditable.
3. Selection among matching rules, exactly as Part 3 of the conventions states: highest integer priority wins, then highest condition count, then lowest rule id.
4. If two or more rules survive all three tests and target different categories, apply none, route to suspense with `SUS-19`, and surface every surviving rule id. If they survive all three tests and target the same category, apply it and log `benign_tie`.
5. Sign sanity. If the resolved category `normal_side` disagrees with the transaction sign, do not apply. Route to suspense with `SUS-10` where the category is tax related, otherwise `SUS-03`, and log the disagreement.
6. Capitalization check. If the category has `capitalize_over` set and the absolute amount is at or above it, do not expense. Route to suspense with `SUS-09` for fixed asset register handling.
7. Receipt check. If the category has `requires_receipt_over` set, the amount is at or above it, and no document is linked, apply the category and additionally raise `SUS-06` as a documentation exception. Coding is known, only support is missing, so the coding still applies.
8. Class check. If the category has `requires_class` true and the transaction has no class or job dimension, apply the category and raise a documentation exception requiring the dimension before close.
9. Iteration order is transaction date ascending then transaction id ascending, and rules are evaluated in the selection order above.

**Deliberately skips.** Transactions resolved at cascade levels 0 through 5, reason `already_resolved_level_n`. Disabled rules, reason `rule_disabled`. Locked period rows, reason `locked_period`. Rows with an open duplicate flag, reason `duplicate_pending`.

**Writes.** A coding proposal by default, carrying rule id, rule version, and the matched conditions. Posts directly only when every one of the five rule promotion conditions in Part D is true, and the entry then records `auto_posted_under_rule_promotion` with the counter values at execution time.

**Logs.** Per transaction: every rule that matched, the winning rule and which of the three tie break tests decided it, the category applied, the cascade level, and any suspense code raised.

**Reverses.** Shape R1 for proposals. Shape R2 for applied categories, restoring the prior category and provenance. Auto posted rows reverse through R2 as well, since the coding change is a field on the transaction and its ledger line, and the reversal reposts the line to its prior destination.

**Blocked by.** Vendor normalization not current for the scope. Zero active rules, which completes with zero acted rather than failing.

**Test assertions.**
- Rule priority 100 with 1 condition beats rule priority 50 with 5 conditions.
- Equal priority resolves to the rule with more conditions.
- Equal priority and equal condition count resolves to the lowest rule id.
- Two rules identical on all three tests targeting different categories produce zero codings and one `SUS-19` item listing both ids.
- A credit transaction matched to a debit normal side category produces zero codings and one suspense item.
- A 300000 cent transaction matching a category with `capitalize_over` of 250000 produces `SUS-09` and no expense posting.
- A rule with 24 accepted applications does not auto post. At 25 with zero rejections and the flag on, it does.
- Editing a rule resets accepted and rejected counters to zero and clears `auto_post_enabled`.
- Transactions coded under rule version 2 still report version 2 after the rule is edited to version 3.

---

### TXN-APPLY-VENDORDEFAULTS, Apply vendor default categories

**Fires from.** `/transactions`, `/rules` vendor tab, and the coding pipeline at step 6.

**Purpose.** Code a transaction for a known vendor that no rule covered, using the single default category recorded for that vendor.

**Scope options.** Client, period or date range, optional vendor filter.

**Inputs read.** The vendor master keyed by normalized vendor string, the vendor default category and its version, and unresolved transactions.

**Deterministic rule.**
1. Resolve the vendor by exact equality between the transaction normalized vendor string and the vendor master normalized key. One exact key, one vendor. No aliasing beyond explicit alias rows, and an alias row is itself an exact string.
2. If the vendor has exactly one active default category, apply it at cascade level 7.
3. If the vendor has more than one active default, which is a data defect, apply none and route to `SUS-19`.
4. Apply the same sign sanity, capitalization, receipt, and class checks stated in `TXN-APPLY-RULES` steps 5 through 8, using the same suspense codes.
5. Iteration order is transaction date ascending then transaction id ascending.

**Deliberately skips.** Transactions resolved at levels 0 through 6, reason `already_resolved_level_n`. Vendors with no default, reason `no_vendor_default`. Locked period rows, reason `locked_period`.

**Writes.** A coding proposal only. This run never auto posts under any configuration, because a vendor default is a weaker statement than a rule and carries no promotion path.

**Logs.** Vendor id, normalized key matched, default category and version, cascade level 7, and any suspense code raised.

**Reverses.** Shape R1 for proposals, shape R2 for accepted codings.

**Blocked by.** Vendor normalization not current for the scope.

**Test assertions.**
- A transaction whose normalized vendor differs by one character from the vendor key produces zero proposals. Exactness is the point.
- A vendor with two active defaults produces zero proposals and one `SUS-19` item.
- A transaction already coded by a rule is skipped with `already_resolved_level_6`.
- No execution of this run under any settings produces a posted entry.

---

### TXN-MAP-BANKCODES, Apply bank and card code mappings

**Fires from.** `/transactions`, and the coding pipeline at step 7.

**Purpose.** Use the bank or card issuer supplied classification code as the last coding signal before suspense.

**Scope options.** Client, period or date range, optional bank account or institution filter.

**Inputs read.** The bank code on the transaction, the institution id, the code mapping table keyed by institution plus code, and unresolved transactions.

**Deterministic rule.**
1. Look up the mapping by exact equality on institution id and bank code. A mapping defined for institution `*` is used only when no institution specific mapping exists for that code. The institution specific mapping always wins, with no other precedence logic.
2. Apply the mapped category at cascade level 8.
3. If a code maps to a category that is inactive on this client's chart, apply none and route to `SUS-03`.
4. Apply the sign sanity, capitalization, receipt, and class checks from `TXN-APPLY-RULES` steps 5 through 8.
5. Iteration order is transaction date ascending then transaction id ascending.

**Deliberately skips.** Transactions resolved at levels 0 through 7, reason `already_resolved_level_n`. Transactions with a null or empty bank code, reason `no_bank_code`. Codes with no mapping, reason `no_code_mapping`. Locked period rows, reason `locked_period`.

**Writes.** A coding proposal only. Never posts. The bank code is the coarsest signal in the cascade and gets the least authority.

**Logs.** Institution id, raw bank code, mapping row id, whether the institution specific or the wildcard mapping was used, and the category applied.

**Reverses.** Shape R1 for proposals, shape R2 for accepted codings.

**Blocked by.** Nothing beyond scope validity. An empty mapping table completes with zero acted.

**Test assertions.**
- With both a wildcard and an institution specific mapping for code `5812`, the institution specific mapping is applied.
- A blank bank code is skipped with `no_bank_code` and is available to the suspense sweep.
- A mapping to an inactive category produces zero codings and one `SUS-03` item.
- No execution of this run produces a posted entry.

---

### TXN-SWEEP-SUSPENSE, Sweep unresolved transactions to 1990

**Fires from.** `/transactions` as the pipeline terminator, `/close` pre close check as a repair action, and on schedule nightly.

**Purpose.** Guarantee that no transaction is ever uncoded by posting every unresolved item to account 1990 with a reason code, which is what makes "nothing uncategorized" true by construction.

**Scope options.** Client, period or date range, optional account filter.

**Inputs read.** Every transaction in scope with no resolved category, any reason code already attached by an earlier pipeline step, the category attributes needed for reason selection, the client owner map for each suspense code, and account 1990.

**Deterministic rule.**
1. Take the reason code already set by an earlier step if one is present. An earlier step's code always wins, since it knows more than the sweep does.
2. Otherwise select the reason code by this ordered decision list. First match wins and evaluation stops.
   1. Currency other than the client functional currency: `SUS-11`.
   2. Date in a locked period and the transaction is still uncoded: `SUS-20`.
   3. Amount at or above the category or client `capitalize_over` and no category resolved: `SUS-09`.
   4. Bank account flagged as a processor destination and no settlement row available: `SUS-12`.
   5. Descriptor matches the chargeback or reversal token list, exact token equality: `SUS-13`.
   6. Transaction sign is credit, money in, and no vendor or source resolved: `SUS-02`.
   7. Transaction sign is debit, money out, and no vendor resolved: `SUS-01`.
   8. Vendor resolved but no category resolved: `SUS-03`.
3. Post one journal entry per transaction: the bank line as observed, and the balancing line to 1990. The entry carries the reason code, the owner from Part 4 of the conventions, the escalation age, and the computed escalation date equal to the transaction posting date plus the escalation age in calendar days.
4. If the resulting reason code is client owned, create exactly one portal request linked to the transaction, unless an open request already covers it.
5. Iteration order is transaction date ascending then transaction id ascending, so reason assignment is reproducible.

**Deliberately skips.** Transactions with a resolved category, reason `resolved`. Transactions already sitting in 1990 with the same reason code, reason `already_in_suspense`. Locked period transactions are not posted to suspense, they are reported with `locked_period` and, where the operator asked for repair, a `SUS-20` item is created in the earliest open period instead.

**Writes.** Posted journal entries to 1990, reason codes, escalation dates, and portal requests for client owned codes. Posts automatically. Posting is authorized precisely because 1990 is the safe destination and the alternative, leaving the row invisible, is what the conventions forbid.

**Logs.** Per transaction: the reason code, which decision list step selected it, the owner, the escalation date, the entry id, and the request id where one was created.

**Reverses.** Shape R3. Reversing entries clear 1990 for the affected items. The orchestrator calls this reversal automatically before a full coding pipeline rerun, so a rerun never double posts suspense.

**Blocked by.** Account 1990 missing from the chart. The whole scope being locked.

**Test assertions.**
- After the full pipeline runs over any fixture, zero transactions in the scope have a null category.
- Every 1990 line carries a reason code from SUS-01 to SUS-20 and a non null escalation date.
- A reason code set by `TXN-DETECT-DUPLICATES` as `SUS-05` is preserved and is not overwritten by the decision list.
- Every client owned code has exactly one linked open portal request, never two.
- Running the sweep twice produces the same 1990 balance, not double.
- Reversal followed by a full pipeline rerun leaves 1990 with the same balance as the first run.
- `SUS-12` is the only code produced with owner `system`.

---

## Module 3. Reconciliation

### REC-MATCH-TIERED, Tiered automatic statement matching

**Fires from.** `/reconcile`, on statement import and from the "auto match" control.

**Purpose.** Link statement lines to book transactions using three explicitly bounded tiers, so a person only handles what the tiers could not decide.

**Scope options.** Client, one bank or card account, one statement period. Never more than one account per execution, because cross account matching is transfer pairing and belongs to a different run.

**Inputs read.** Statement lines for the period, unmatched book transactions for the account dated up to statement end date plus the tier 3 window, existing match links, the account matching tolerance settings, and the check number field where the account is a checking account.

**Deterministic rule.** Tiers execute in order. A statement line matched at a tier is removed from the candidate pool before the next tier runs. A book transaction matched at a tier is likewise removed.

**Tier 1, exact.** Equal absolute amount in exact cents, equal sign, and equal date. Additionally, if both records carry a check number, the check numbers must be equal. A tier 1 match requires mutual uniqueness: exactly one statement line and exactly one book transaction satisfy each other. Confidence is not computed and not stored, because the condition is either satisfied or not.

**Tier 2, dated window.** Equal absolute amount in exact cents, equal sign, and date difference of 3 calendar days or fewer. Mutual uniqueness required. Where more than one candidate exists on either side, no match is made at tier 2 and the whole ambiguous set drops to manual.

**Tier 3, tolerance.** Absolute amount difference at or below `amount_tolerance_cents`, default 0 and configurable per account with a hard ceiling of 100 cents, equal sign, date difference of 5 calendar days or fewer, and mutual uniqueness. Tier 3 is disabled when the tolerance is 0, which is the default. A tier 3 match records the exact cent difference on the link and raises a variance item for review.

Tie breaking within a tier is not permitted. Ambiguity always drops to manual rather than being resolved by proximity, because a wrong match hides a real error.

Iteration order inside each tier is statement line date ascending, then absolute amount ascending, then statement line id ascending.

**Deliberately skips.** Statement lines already matched, reason `already_matched`. Book transactions already matched, reason `already_matched`. Book transactions dated after statement end date plus the tier window, reason `outside_window`. Transactions in a locked period are still matchable, since a match link is not a ledger write, but any adjustment they would require is skipped with `locked_period`.

**Writes.** Match links. Tier 1 links are written directly, because the condition is exact identity on amount, sign, date, and check number. Tier 2 and tier 3 links are written as proposals requiring operator acceptance on `/reconcile`. No journal entry is ever created by this run.

**Logs.** Per statement line: the tier that matched or `unmatched`, the book transaction id, the amount difference, the date difference, and for ambiguous sets every candidate id considered.

**Reverses.** Shape R1 for proposals, and for tier 1 links a straightforward unlink of links created by this execution that a human has not confirmed.

**Blocked by.** No statement imported for the period. Statement opening balance does not equal the prior period reconciled closing balance, which is a data integrity failure the operator must resolve first.

**Test assertions.**
- Two book transactions of the same amount and date against one statement line produce zero matches and three items in the manual pool.
- With tolerance 0, an amount difference of 1 cent produces zero matches.
- With tolerance set to 100, a 1 cent difference matches at tier 3 and the link records a difference of 1.
- Setting tolerance to 101 is rejected by configuration validation.
- Different check numbers on the same amount and date produce zero tier 1 matches.
- Rerunning immediately produces zero new links.
- The sum of matched book amounts plus unmatched book amounts equals the total book amount for the period, always.

---

### REC-CLEAR-MATCHED, Clear matched items and compute the reconciliation difference

**Fires from.** `/reconcile`, after matching, and from the reconciled banner control.

**Purpose.** Mark matched items cleared as of the statement date and compute the reconciliation difference that gate G03 tests.

**Scope options.** Client, one account, one statement period.

**Inputs read.** Confirmed match links, statement opening and closing balance, book balance at statement end, cleared flags, and outstanding items from prior periods.

**Deterministic rule.**
1. For every confirmed match link in the period, set the book transaction `cleared = true` and `cleared_date = statement_line_date`. The statement date governs, not the book date, because the bank determines clearing.
2. Compute the reconciliation as: statement closing balance, minus deposits in transit, meaning uncleared book debits to cash dated on or before statement end, plus outstanding payments, meaning uncleared book credits to cash dated on or before statement end, equals adjusted book balance. Difference equals adjusted book balance minus book balance at statement end. All arithmetic in integer cents.
3. A difference of exactly zero sets the reconciliation state to `reconciled`. Any non zero difference, including 1 cent, sets `out_of_balance` and stores the signed difference. There is no acceptable difference threshold at this run, because gate G03 requires zero.
4. Unmatched items are left uncleared and carried forward as outstanding.
5. Iteration order is transaction id ascending.

**Deliberately skips.** Proposed but unconfirmed match links, reason `match_not_confirmed`. Items already cleared with the same cleared date, reason `already_cleared`. Locked period items, reason `locked_period`, which never blocks the computation since clearing a flag on a locked row is refused but reading it is not.

**Writes.** Cleared flags, cleared dates, and the reconciliation record with its difference. Posts flags, not journal entries. No ledger effect at all.

**Logs.** Count cleared, statement closing balance, deposits in transit total, outstanding payments total, adjusted book balance, book balance, and the signed difference.

**Reverses.** Shape R2, restore cleared flags and cleared dates to their prior values and delete the reconciliation record created by this execution.

**Blocked by.** Statement closing balance not entered. Any confirmed match link pointing at a deleted transaction.

**Test assertions.**
- A fully matched period produces a difference of exactly 0 and state `reconciled`.
- A difference of 1 cent produces state `out_of_balance`, never `reconciled`.
- Cleared date equals the statement line date, not the book transaction date, in every cleared row.
- Deposits in transit plus outstanding payments reconcile the statement balance to the book balance exactly.
- Reversal restores the prior cleared state on every affected row.

---

### REC-FLAG-STALE, Flag stale uncleared items

**Fires from.** `/reconcile` outstanding items panel, and on schedule at period end.

**Purpose.** Surface uncleared items old enough that they are probably void, duplicated, or never going to clear, and force a human decision.

**Scope options.** Client, optional single account, and an as of date defaulting to the latest reconciled period end.

**Inputs read.** Uncleared book transactions on cash and card accounts, their dates, the stale thresholds, existing stale flags, and any void or reissue links.

**Deterministic rule.**
1. Age in calendar days equals the as of date minus the transaction date.
2. Thresholds by instrument type, all configurable per client with these defaults: issued check 90 days, electronic payment 30 days, deposit 10 days, other 60 days.
3. An item is stale when age is greater than or equal to its threshold and it is not cleared and it is not already voided.
4. A stale item is flagged with suspense reason `SUS-18`, owner firm, escalation 30 days per Part 4 of the conventions.
5. An issued check at or above 180 days additionally sets `escheat_review = true`, because unclaimed property rules attach at state specific dwell times and the run does not attempt to apply state law, it only raises the review.
6. Iteration order is transaction date ascending then transaction id ascending.

**Deliberately skips.** Cleared items, reason `cleared`. Items already flagged stale at the same threshold, reason `stale_flag_exists`. Voided items, reason `already_voided`. Items dated after the as of date, reason `future_of_as_of_date`.

**Writes.** Stale flags with `SUS-18` and the escheat review flag. Proposes only. This run never voids, never writes off, and never posts. Voiding a check has a payee consequence and belongs to a person.

**Logs.** Item id, instrument type, age in days, threshold applied, and the flag written.

**Reverses.** Shape R2, remove flags created by this execution that a human has not acted on.

**Blocked by.** No as of date resolvable, meaning the client has never reconciled and has no period end.

**Test assertions.**
- A check aged exactly 90 days with a 90 day threshold is flagged. At 89 days it is not.
- A deposit aged 11 days is flagged under the 10 day deposit threshold while a check of the same age is not.
- A check aged 200 days carries both `SUS-18` and `escheat_review`.
- No execution of this run voids or writes off any item.
- Rerunning produces zero new flags.

---

## Module 4. Recurring and period end

### PER-POST-RECURRING, Post recurring journal templates

**Fires from.** `/journal` recurring templates panel, and on schedule on the template posting day.

**Purpose.** Post the fixed and scheduled journal entries a client has every period, from templates a person already approved.

**Scope options.** Client, one period, optional single template.

**Inputs read.** Active recurring journal templates with their version, template lines with account, category, amount or basis points, class dimension, memo text, the posting day rule, and entries already posted from each template.

**Deterministic rule.**
1. Select templates whose schedule includes this period: monthly always, quarterly on fiscal quarter end periods, annual on the fiscal year end period.
2. Posting date equals the template posting day rule applied to the period: `period_end` uses the last calendar day of the period, `day_n` uses day n, and if day n exceeds the days in the month it uses the last day of the month.
3. Amounts. A fixed amount template posts its stored cents exactly. A basis point template applies its basis points to the stated driver amount, which must be a stored value such as a lease base or a stated allocation base, and never a computed estimate. Allocation uses the Part A rounding rule with the residual on the highest sequence line.
4. Every entry must sum to exactly zero before posting. A template that does not balance does not post, and the run reports `template_unbalanced` and continues to the next template.
5. Iteration order is template id ascending.

**Deliberately skips.** Templates already posted for this period, reason `already_posted_this_period`, keyed by template id plus period so a rerun is safe. Inactive templates, reason `template_inactive`. Templates whose posting date falls in a locked period, reason `locked_period`, with no redating, because a recurring template for a closed month is not a correction and should be handled by a person.

**Writes.** Posted journal entries marked `source = recurring_template` with the template id and version. Posts automatically, authorized because a human approved the template and the amounts are fixed or driven by a stored value.

**Logs.** Template id and version, posting date, entry id, line count, and the balance check result.

**Reverses.** Shape R3, reversing entry dated the same date if open, otherwise the earliest open period.

**Blocked by.** The target period is locked, in which case the whole run is blocked. Any referenced account is inactive.

**Test assertions.**
- Running twice for the same period posts exactly one entry per template.
- A template with a posting day of 31 in a 30 day month posts on day 30.
- A template whose lines do not sum to zero posts nothing and is reported.
- A quarterly template posts in exactly 4 of 12 periods for a client with a June fiscal year end, in the correct periods.
- Reversal leaves every affected account at its pre run balance.

---

### PER-AMORTIZE-PREPAID, Release prepaid expense on schedule

**Fires from.** `/journal` schedules panel, `/close` as a gate G13 remediation, and on schedule at period end.

**Purpose.** Move the current period portion of a prepaid balance from the 1300 block to the expense category named on the schedule.

**Scope options.** Client, one period, optional single schedule.

**Inputs read.** Prepaid schedules with total cents, start period, term in periods, prepaid asset account, target expense category, class dimension, per period allocation table, and releases already posted.

**Deterministic rule.**
1. At schedule creation the full allocation table is computed once and stored. Per period amount equals total cents divided by term, integer division, and the remainder is added to the final period. The table is stored, not recomputed at each run, so a later change to the rounding rule cannot alter a schedule already in flight.
2. For the target period, read the table row for that period. Post a debit to the expense category and a credit to the prepaid asset account for exactly that amount.
3. Short first period handling: if the schedule has `prorate_first_period` true, the first period amount equals total cents times days remaining in the first period divided by total days in the term, integer arithmetic with round half away from zero, and the residual is carried into the final period. This is decided at schedule creation and stored in the table.
4. Sum of the stored table must equal total cents exactly. A table that does not is a creation time error and the schedule cannot be activated.
5. Iteration order is schedule id ascending.

**Deliberately skips.** Schedules already released for this period, reason `already_released_this_period`. Schedules not yet started, reason `before_start_period`. Fully released schedules, reason `schedule_complete`. Schedules whose target period is locked, reason `locked_period`, with the redate rule from Part C applied when the operator runs catch up mode.

**Writes.** One posted journal entry per schedule per period, marked `source = prepaid_schedule`. Posts automatically, authorized because the schedule and its full table were approved at creation.

**Logs.** Schedule id, period index, amount released, remaining balance after release, and whether the row was the residual bearing final period.

**Reverses.** Shape R3, and the schedule period is marked unreleased so a corrected rerun can post again.

**Blocked by.** Target period locked in non catch up mode. Prepaid account or target category inactive.

**Test assertions.**
- A 100000 cent prepaid over 12 periods releases 8333 in periods 1 through 11 and 8337 in period 12, and the 12 amounts sum to exactly 100000.
- The prepaid account balance is exactly zero after the final release.
- Running twice for one period posts one entry.
- A schedule created before a rounding rule change still releases its originally stored amounts.
- Catch up mode over 3 missed locked periods posts 3 entries into the earliest open period, each flagged `redated_from_locked_period`.

---

### PER-SPLIT-LOANPAYMENT, Split loan payments from the amortization schedule

**Fires from.** `/transactions` for a payment on a loan linked account, `/journal` schedules panel, and the coding pipeline as a recurring template variant.

**Purpose.** Split a loan payment into principal, interest, and escrow or fee components using the lender amortization schedule rather than any estimate.

**Scope options.** Client, period or date range, optional single loan.

**Inputs read.** Loan records with the loaded amortization schedule (payment number, due date, total payment cents, principal cents, interest cents, escrow cents, ending balance cents), the loan liability account in 2600 or 2700, the interest expense account in 8000 to 8999, the escrow asset or expense target, and bank transactions on the paying account.

**Deterministic rule.**
1. Identify the payment by exact match on total payment cents and payment due date within 5 calendar days, with mutual uniqueness against the schedule rows. If two schedule rows are candidates, no split is made and the transaction routes to `SUS-14`.
2. Post: debit the loan liability for the schedule principal, debit interest expense for the schedule interest, debit the escrow target for the schedule escrow, credit the bank account for the total. Lines sum to zero.
3. The schedule is authoritative. The run never computes interest from a rate. If schedule principal plus interest plus escrow does not equal the schedule total payment exactly, the schedule row is rejected as invalid and the transaction routes to `SUS-17`.
4. Overpayment and underpayment. If the bank amount differs from the schedule total, do not split. Route to `SUS-14` for a human, because a differing amount usually means an extra principal payment or a missed payment and both change the remaining schedule.
5. After posting, the loan liability balance must equal the schedule ending balance for that payment number. If it does not, post the entry and raise a variance item naming both figures. Never plug.
6. Iteration order is payment due date ascending then payment number ascending.

**Deliberately skips.** Payments already split, reason `already_split`. Loans with no schedule loaded, reason `no_amortization_schedule`, and those route to `SUS-14`. Locked period rows, reason `locked_period`.

**Writes.** One posted journal entry per payment, linked to the schedule row and the payment number. Posts automatically, authorized because every component comes from a lender document loaded and approved in advance.

**Logs.** Loan id, payment number, principal, interest, escrow, total, the bank transaction id, the resulting liability balance, and the schedule ending balance for comparison.

**Reverses.** Shape R3, and the schedule row is marked unpaid so a corrected rerun can apply.

**Blocked by.** No schedule loaded. Loan liability account inactive. Target period locked.

**Test assertions.**
- Principal plus interest plus escrow equals the bank credit in every posted entry, exactly.
- After the final scheduled payment the loan liability balance is exactly zero.
- A bank payment 1 cent different from the schedule total produces zero entries and one `SUS-14` item.
- A schedule row whose components do not sum to its total produces zero entries and one `SUS-17` item.
- The run never derives interest from a rate, verified by a fixture where the stated rate would produce a different figure than the schedule and the schedule figure is the one posted.

---

### PER-POST-ACCRUALS, Accrue expenses and revenue at period end

**Fires from.** `/journal` accruals panel, `/close` as a G13 remediation, and on schedule at period end.

**Purpose.** Record expenses incurred and revenue earned in the period that have no invoice or bill yet, from explicitly defined accrual items.

**Scope options.** Client, one period, optional single accrual item.

**Inputs read.** Accrual definitions (source type, target expense or revenue category, accrual liability or asset account, calculation basis, and whether it auto reverses), the source data named by the basis, existing accruals for the period, and any bill or invoice already recorded that the accrual would double count.

**Deterministic rule.** Only four calculation bases exist, and each is arithmetic over stored values. There is no estimation model.
1. `fixed_amount`: the stored cents.
2. `from_document`: cents read from a linked unposted bill, invoice, or vendor statement already uploaded.
3. `daily_rate_x_days`: stored daily rate cents times the count of days in the period covered, integer multiplication.
4. `percent_of_base`: stored basis points times a stored base amount, rounded by the Part A rule.

Steps:
1. Compute the amount by the item's basis. If the basis inputs are incomplete, produce nothing for that item and report `accrual_inputs_incomplete`.
2. Double count guard. If a posted bill or invoice already exists for the same vendor or customer, same period, and equal amount within 0 cents, do not accrue and report `source_document_already_posted`.
3. Build one proposal per accrual item: debit the expense category and credit the accrual liability in the 2200 block, or debit the accrued receivable in the 1100 block and credit revenue for a revenue accrual.
4. Dated the last calendar day of the period.
5. If the item is marked `auto_reverse`, stamp `reverses_on = first day of the following period` on the proposal so `PER-REVERSE-ACCRUALS` can find it.
6. Iteration order is accrual item id ascending.

**Deliberately skips.** Items already accrued for the period, reason `already_accrued_this_period`. Inactive items, reason `item_inactive`. Items whose source document is already posted, reason `source_document_already_posted`. Locked period, reason `locked_period`.

**Writes.** Draft journal entries in state `proposed`. Proposes only. The amount is a judgment even when the arithmetic is mechanical, so a person approves before it hits the ledger. Approval on `/journal` posts the entry unchanged, and any edit before approval is recorded as a manual override on the entry.

**Logs.** Item id, basis used, every input value read, the computed amount, the double count guard result, and the `reverses_on` date where set.

**Reverses.** Shape R1 for unapproved proposals. Approved and posted accruals reverse through shape R3, which is also the normal path taken by `PER-REVERSE-ACCRUALS`.

**Blocked by.** Target period locked. Accrual liability account missing from the chart.

**Test assertions.**
- A `daily_rate_x_days` item at 1000 cents per day over 31 days proposes exactly 31000.
- A `percent_of_base` item at 250 basis points on 1000000 proposes exactly 25000.
- An item whose bill was already posted for the same period and amount proposes nothing.
- Every proposal has lines summing to exactly zero.
- No execution of this run posts to the ledger without an approval action.
- Every item marked `auto_reverse` carries a `reverses_on` date equal to the first day of the next period.

---

### PER-REVERSE-ACCRUALS, Auto reverse accruals in the following period

**Fires from.** `/journal` on period open, and on schedule on the first day of each period.

**Purpose.** Reverse the prior period accruals that were marked auto reverse, so the actual bill or invoice lands in a clean period without a double count.

**Scope options.** Client, one period, meaning the period the reversals post into.

**Inputs read.** Posted journal entries with `reverses_on` equal to a date inside the target period, their lines, and any reversal already posted against them.

**Deterministic rule.**
1. Select posted entries whose `reverses_on` date falls in the target period and which have no existing reversal.
2. For each, create one entry with every line sign flipped, the same accounts, the same categories, the same class dimensions, and the same memo prefixed with `Reversal of`.
3. Post it dated the `reverses_on` date.
4. Link it to the original by `reverses_entry_id`, and mark the original `reversed = true`.
5. Iteration order is original entry date ascending then entry id ascending.

**Deliberately skips.** Entries already reversed, reason `already_reversed`. Entries without `reverses_on`, reason `not_marked_auto_reverse`. Manually adjusted originals still reverse, since the reversal mirrors whatever posted.

**Writes.** Posted reversing journal entries. Posts automatically, authorized because it is a mechanical mirror of an entry that a person already approved, and failing to reverse causes a guaranteed double count.

**Logs.** Original entry id, reversal entry id, posting date, and the line count mirrored.

**Reverses.** A reversal of a reversal is permitted and follows shape R3, producing an entry that restores the accrual. The chain is fully linked and auditable.

**Blocked by.** The target period is locked. The original entry period is locked, which does not block, since the reversal posts into the later period by design.

**Test assertions.**
- Original plus reversal nets to exactly zero on every account touched.
- Running twice produces exactly one reversal per original.
- The reversal date equals the original `reverses_on` date.
- An accrual not marked auto reverse produces no reversal.
- Every reversal carries a populated `reverses_entry_id`.

---

### PER-POST-DEPRECIATION, Post depreciation and amortization

**Fires from.** `/journal` fixed asset panel, `/close` as the gate G12 remediation, and on schedule at period end.

**Purpose.** Post the period depreciation and amortization for every in service asset, using the method and life set at asset setup.

**Scope options.** Client, one period, optional single asset or asset class.

**Inputs read.** The fixed asset register (cost cents, salvage cents, in service date, life in months, method, cost account in 1500 to 1599 or intangible in 1700 to 1799, depreciation expense category, disposal date and disposal state), accumulated depreciation balances, and periods already posted per asset.

**Deterministic rule.**
1. Contra account resolution. The accumulated depreciation account is the cost account number plus 100, per Part 1 of the conventions. If that account does not exist, do not post for that asset and report `contra_account_missing`. The run never guesses a contra account.
2. Depreciable base equals cost minus salvage.
3. Methods. Only three are supported, all closed form.
   - `straight_line`: monthly amount equals depreciable base divided by life in months, integer division, with the accumulated remainder posted in the final month so total depreciation equals depreciable base exactly.
   - `double_declining`: monthly rate is 2 divided by life in months applied to opening net book value, computed in integer cents with round half away from zero, floored so net book value never falls below salvage. Switch to straight line over remaining months when the straight line amount for the remaining life exceeds the declining amount, evaluated at the start of each month, which is a deterministic comparison rather than an option.
   - `units_of_production`: depreciable base times units this period divided by total estimated units, with units entered by a person for the period. If units are not entered, post nothing and report `units_not_entered`.
4. Convention. The in service month is a full month if the in service day is on or before the 15th, otherwise depreciation starts the following month. This is the stored client convention and is applied identically to every asset.
5. Disposal. An asset with a disposal date in or before the period posts depreciation through the disposal month only, and this run does not post the gain or loss on disposal. Disposal accounting is a separate manual entry, because proceeds are a fact the run does not have.
6. Never post more than depreciable base cumulatively. The final period amount equals depreciable base minus accumulated to date.
7. Iteration order is asset id ascending. One journal entry per asset class per period, with one line pair per asset, so the ledger stays readable.

**Deliberately skips.** Assets fully depreciated, reason `fully_depreciated`. Assets not yet in service, reason `not_in_service`. Assets disposed in a prior period, reason `disposed`. Assets already posted for the period, reason `already_posted_this_period`. Assets with a missing contra account, reason `contra_account_missing`. Locked period, reason `locked_period`.

**Writes.** Posted journal entries debiting the depreciation expense category and crediting the matching accumulated depreciation account. Posts automatically, authorized because method, life, salvage, and in service date were all approved at asset setup and the arithmetic is closed form.

**Logs.** Per asset: cost, salvage, method, life, months elapsed, opening accumulated, amount posted, closing accumulated, closing net book value, and the contra account used.

**Reverses.** Shape R3, and the asset period is marked unposted so a corrected rerun can apply.

**Blocked by.** Target period locked. Fixed asset register out of engagement scope, in which case the run reports not applicable rather than failing, matching gate G12 behavior.

**Test assertions.**
- An asset at 1520 posts its credit to 1620 and to no other account.
- Straight line over 36 months on a base of 100000 posts amounts summing to exactly 100000, with the residual in month 36.
- Net book value never falls below salvage under double declining.
- Double declining switches to straight line at the deterministic crossover month and the total still equals depreciable base.
- An asset placed in service on the 16th produces zero depreciation in that month.
- An asset with a missing contra account produces zero postings and one reported skip.
- Running twice for one period posts one entry per asset.
- No execution posts a gain or loss on disposal.

---

## Module 5. AR and AP

### ARAP-REFRESH-AGING, Refresh receivable and payable aging

**Fires from.** `/aging`, on open and on the refresh control, and on schedule nightly.

**Purpose.** Recompute the aging buckets for every open invoice and bill as of a stated date and prove the totals tie to the control accounts.

**Scope options.** Client, an as of date defaulting to today or to period end when run inside a close, and a side filter of receivable, payable, or both.

**Inputs read.** Open invoices and bills with invoice date, due date, original amount, applied payments, credits, and write offs, the AR control account in the 1100 block, the AP control account in the 2000 block, and the client aging basis setting.

**Deterministic rule.**
1. Open balance equals original amount minus applied payments minus applied credits minus write offs, in integer cents. Items with an open balance of exactly zero are closed and excluded.
2. Age in days equals the as of date minus the aging basis date, where the basis is `due_date` by default and `invoice_date` when the client setting says so. The setting is read, never inferred.
3. Buckets, using inclusive lower and upper bounds so no day falls between two buckets: current is age at or below 0, bucket one is 1 to 30, bucket two is 31 to 60, bucket three is 61 to 90, and over 90 is 91 or more.
4. An item with a credit balance, meaning a negative open balance, is reported in a separate credits line and is never netted into a bucket, because netting hides an unapplied payment.
5. Totals tie check: the sum of every receivable open balance must equal the AR control account balance as of the same date, and the same for payable. A difference sets `subledger_out_of_tie` with the signed difference, which is what gate G04 reads.
6. Iteration order is customer or vendor name ascending, then invoice or bill date ascending, then document id ascending.

**Deliberately skips.** Fully paid items, reason `zero_open_balance`. Voided items, reason `voided`. Draft invoices and bills, reason `not_posted`. Documents dated after the as of date, reason `future_of_as_of_date`.

**Writes.** The aging snapshot rows and the tie check result. Derived data only. Posts nothing and proposes nothing to the ledger.

**Logs.** As of date, aging basis used, item count per bucket, totals per bucket, control account balances, and the signed tie difference for each side.

**Reverses.** Not applicable as a ledger action. The snapshot is replaced by the next execution, and prior snapshots are retained and readable by date.

**Blocked by.** AR or AP control account missing from the chart. No as of date.

**Test assertions.**
- Bucket totals plus the credits line equal total open receivables, exactly.
- An item due exactly 30 days before the as of date lands in bucket one, and at 31 days in bucket two.
- An item due on the as of date lands in current.
- A credit balance item never appears inside an aging bucket.
- With a seeded out of tie fixture, the run reports the exact signed difference rather than adjusting anything.
- Two executions on the same as of date produce identical bucket totals.

---

### AR-BUILD-STATEMENTS, Build customer statements

**Fires from.** `/aging` receivable tab, and `/package` when the statement section is selected.

**Purpose.** Produce a per customer statement of open items and activity for a stated period, ready to send through the portal.

**Scope options.** Client, one statement date, optional single customer, and statement type of open item or balance forward.

**Inputs read.** The aging snapshot for the statement date, invoices, payments, credit memos, customer contact and delivery preference, and the client statement template with its minimum balance and dunning message thresholds.

**Deterministic rule.**
1. Include a customer when their open balance as of the statement date is greater than or equal to `minimum_statement_balance`, default 100 cents, and they are not marked `statement_suppressed`.
2. Open item statements list every open document with date, number, original amount, applied amount, and open balance, ordered by document date ascending then document id ascending.
3. Balance forward statements show the prior statement closing balance, then every transaction in the period ordered the same way, then the closing balance. Prior closing plus period activity must equal the closing balance exactly, and the statement is not produced if it does not.
4. The aging summary block on the statement uses the identical bucket definitions as `ARAP-REFRESH-AGING`. There is no second aging implementation.
5. Message selection is threshold driven, not written per customer. Bands are: nothing over 30 days uses the neutral message, something in 31 to 60 uses reminder text, something in 61 to 90 uses firm text, and something over 90 uses final notice text. The band with the oldest open item governs. The message text is a stored template with merge fields, never generated.
6. Iteration order is customer name ascending then customer id ascending.

**Deliberately skips.** Customers below the minimum balance, reason `below_minimum_balance`. Suppressed customers, reason `statement_suppressed`. Customers with only credit balances, reason `credit_balance_only`, since a statement demanding a negative amount is a defect.

**Writes.** Statement documents in state `draft` plus optional portal delivery records. Proposes only. Nothing is delivered without an operator send action, because a statement is client facing correspondence.

**Logs.** Customers included and excluded with reasons, the message band selected per customer with the oldest item age that selected it, and the totals per statement.

**Reverses.** Shape R1, delete drafts created by this execution that have not been sent. Sent statements are never deleted, only superseded by a later statement.

**Blocked by.** No aging snapshot for the statement date. Statement template missing.

**Test assertions.**
- Every statement total equals the customer open balance in the aging snapshot for the same date.
- A customer whose oldest open item is 61 days receives the firm band message, not the final notice band.
- A balance forward statement where prior closing plus activity does not equal closing produces no statement.
- No statement is delivered without an explicit send action.
- Two executions produce identical statement content for an unchanged fixture.

---

### AR-APPLY-PAYMENTS, Apply customer payments to invoices

**Fires from.** `/aging` receivable tab, `/transactions` on a customer deposit, and on remittance file upload.

**Purpose.** Match received payments to open invoices under explicit rules and leave anything ambiguous for a person.

**Scope options.** Client, period or date range, optional single customer.

**Inputs read.** Unapplied payments and credit memos, open invoices, remittance advice lines where uploaded, the customer application preference, and account 1900 where undeposited funds is used.

**Deterministic rule.** Application tiers, in order. A payment satisfied at a tier stops there.
1. **Remittance instruction.** If a remittance line names an invoice number that exists and is open, apply to that invoice up to its open balance. Multiple named invoices apply in the order given on the remittance. This tier applies even when the payment does not fully cover the named invoices.
2. **Exact single invoice.** Exactly one open invoice for that customer has an open balance equal to the payment amount in exact cents. Apply in full.
3. **Exact combination.** A combination of two or three open invoices sums exactly to the payment amount and is the only such combination. If more than one combination exists, apply none. Combinations of four or more are not attempted, because the count of possible sets grows and the answer stops being obvious to a reviewer.
4. **Customer preference.** If the customer preference is `oldest_first` and none of the tiers above resolved, propose an application oldest invoice first by due date ascending then invoice id ascending, consuming each invoice fully before moving to the next, with any remainder left unapplied as a credit.
5. If no tier resolves, leave the payment unapplied and raise an open item for review. An unapplied payment is never forced onto an invoice.
6. Overpayment leaves the excess as an unapplied credit on the customer. It is never applied to a future invoice that does not exist yet.
7. Iteration order is payment date ascending then payment id ascending.

**Deliberately skips.** Already applied payments, reason `already_applied`. Payments on hold, reason `payment_on_hold`. Invoices in a locked period may still receive an application, since the application is a subledger link, but any resulting journal entry follows the Part C redate rule.

**Writes.** Payment application records and the associated journal entries where the client books AR gross. Tiers 1 and 2 post automatically, because the instruction or the exact identity leaves no judgment. Tiers 3 and 4 propose and require operator acceptance.

**Logs.** Payment id, tier that resolved it, every invoice applied with the amount applied, the remainder left unapplied, and for tier 3, every combination considered when more than one existed.

**Reverses.** Shape R2 for application links, restoring open balances, plus shape R3 for any posted entry.

**Blocked by.** AR control account missing. Customer not resolvable on the payment.

**Test assertions.**
- A payment equal to exactly one open invoice applies at tier 2 and leaves zero unapplied.
- A payment equal to the sum of two invoices, where two different pairs also sum to the same amount, applies nothing and is reported for review.
- A remittance naming an invoice applies to that invoice even when a different invoice matches the amount exactly.
- An overpayment of 5000 cents leaves exactly 5000 cents unapplied as a credit.
- The sum of applied amounts never exceeds the payment amount, in any fixture.
- No invoice ever shows a negative open balance after application.

---

### AR-CHARGE-LATEFEES, Compute late fees on overdue receivables

**Fires from.** `/aging` receivable tab, and on schedule at month end.

**Purpose.** Compute the contractual late fee on overdue invoices so a person can decide whether to charge it.

**Scope options.** Client, an as of date, optional single customer.

**Inputs read.** Open invoices with due date and open balance, the client late fee policy (grace days, rate in basis points per month or flat cents, minimum fee, maximum cumulative fee, and compounding flag set to false always), customer level exemptions, and late fees already charged per invoice.

**Deterministic rule.**
1. Eligible when open balance is greater than zero, age past due is greater than `grace_days` with a default of 10, the customer is not exempt, and the invoice is not in dispute.
2. Months overdue equals the integer count of whole 30 day blocks from due date plus grace days to the as of date. Partial blocks do not count. This avoids calendar month ambiguity entirely.
3. Fee equals open balance times rate basis points times months overdue divided by 10000, rounded by the Part A rule, or the flat cents times months overdue where the policy is flat.
4. Fees never compound. The base is always the original open balance excluding previously charged fees, because the compounding flag is fixed false.
5. Apply the minimum fee floor and the maximum cumulative fee ceiling. Cumulative includes fees already charged on the same invoice, so the ceiling is never exceeded across executions.
6. Subtract fees already charged for the same invoice and the same months overdue, so a rerun charges nothing.
7. Iteration order is customer name ascending then invoice due date ascending then invoice id ascending.

**Deliberately skips.** Exempt customers, reason `customer_exempt`. Disputed invoices, reason `invoice_in_dispute`. Invoices inside the grace window, reason `within_grace_period`. Invoices at the cumulative ceiling, reason `fee_ceiling_reached`. Computed fees below the minimum where the policy says suppress, reason `below_minimum_fee`.

**Writes.** Proposed late fee invoices or invoice lines, in state `draft`. Proposes only, always. Charging a client's customer a fee is a relationship decision and no configuration enables auto posting here.

**Logs.** Invoice id, days past due, months overdue counted, base amount, rate applied, computed fee, floor and ceiling effects, and fees previously charged.

**Reverses.** Shape R1, delete drafts from this execution that have not been issued.

**Blocked by.** No late fee policy configured for the client, which completes with zero considered.

**Test assertions.**
- An invoice 39 days past due with 10 grace days produces 0 months and no fee. At 40 days it produces 1 month.
- A fee is never computed on a base that includes a prior fee.
- The cumulative fee across multiple executions never exceeds the configured maximum.
- Rerunning on the same as of date produces zero additional fees.
- No execution issues a fee invoice without an operator action.

---

### AP-APPLY-DISCOUNTS, Identify and apply early payment discounts

**Fires from.** `/aging` payable tab, and the payment run preparation screen.

**Purpose.** Identify bills where paying by a stated date earns a stated discount, and compute the exact discounted amount.

**Scope options.** Client, a planned payment date, optional single vendor.

**Inputs read.** Open bills with terms parsed into discount percentage in basis points, discount days, and net days, bill date, open balance, and the discount base policy which states whether freight and tax are excluded.

**Deterministic rule.**
1. Terms are stored as structured fields, never parsed from free text at run time. A bill without structured terms is skipped, not interpreted.
2. Discount is available when the planned payment date is on or before bill date plus discount days, evaluated as calendar days with no weekend adjustment, because vendor terms are stated in calendar days.
3. Discount base equals open balance, minus freight and minus tax when the client policy excludes them. The policy is a stored setting.
4. Discount amount equals discount base times discount basis points divided by 10000, rounded by the Part A rule. Payment amount equals open balance minus discount amount.
5. Annualized benefit is reported for information as discount basis points times 36500 divided by the count of days between the discount date and the net due date, integer arithmetic. It is reported only and never drives a decision automatically.
6. If the planned payment date is after the discount date, report `discount_expired` with the date it lapsed, so the loss is visible.
7. Iteration order is discount date ascending then bill id ascending.

**Deliberately skips.** Bills with no discount terms, reason `no_discount_terms`. Bills already paid, reason `already_paid`. Bills on hold, reason `payment_hold`. Disputed bills, reason `bill_in_dispute`.

**Writes.** A proposed payment amount and a proposed discount taken line on the payment batch. Proposes only. The discount is only earned if the payment actually settles by the date, which the run cannot guarantee, so it never posts.

**Logs.** Bill id, terms used, discount date, planned payment date, discount base, discount amount, payment amount, annualized benefit, and any expiry.

**Reverses.** Shape R1, remove proposals from the payment batch.

**Blocked by.** No planned payment date supplied.

**Test assertions.**
- A bill dated the 1st with 10 discount days and a planned payment on the 11th qualifies. On the 12th it does not.
- A discount on a base of 100000 at 200 basis points computes exactly 2000 and a payment of 98000.
- With the exclude policy on, freight and tax are removed from the base and the computed discount changes accordingly.
- No execution of this run posts a payment or a discount to the ledger.
- Rerunning with the same planned date produces identical proposals.

---

### AR-WRITEOFF-UNCOLLECTIBLE, Propose uncollectible write offs

**Fires from.** `/aging` receivable tab, and `/close` as a receivable review step.

**Purpose.** Identify receivables that meet the client's stated write off criteria and prepare the entry for approval.

**Scope options.** Client, an as of date, optional single customer.

**Inputs read.** Open invoices with age and open balance, collection activity history, the client write off policy (age threshold, balance threshold, required collection attempts, and approval level by amount), the allowance for doubtful accounts in the 1100 block, the bad debt expense category, and the client's allowance versus direct write off method setting.

**Deterministic rule.**
1. Candidate when age past due is at or above `writeoff_age_days` with a default of 365, and open balance is at or above `writeoff_minimum_cents` with a default of 100, and the count of logged collection attempts is at or above `required_attempts` with a default of 3, and the customer is not in an active payment plan, and the invoice is not in dispute.
2. Under the allowance method, the entry debits the allowance account and credits accounts receivable. Under the direct write off method it debits bad debt expense and credits accounts receivable. The method is a stored client setting and is never chosen by the run.
3. Sales tax previously recorded on the invoice is written off in the same proportion as the invoice balance, computed by the Part A rounding rule, so the tax payable account is not left overstated. Where the client is not registered for sales tax, this step is inert.
4. Approval routing: amounts at or below `approval_tier_1_cents` require the preparer plus the lead, and amounts above require the partner. The routing is recorded on the proposal.
5. Iteration order is open balance descending then invoice id ascending, so the largest exposures appear first on the review list.

**Deliberately skips.** Invoices under the age or balance thresholds, reasons `below_age_threshold` and `below_balance_threshold`. Fewer than the required attempts, reason `insufficient_collection_activity`. Active payment plans, reason `payment_plan_active`. Disputed invoices, reason `invoice_in_dispute`. Anything in a locked period, reason `locked_period`.

**Writes.** A draft journal entry per approved batch and a write off proposal per invoice. Proposes only, at every age and every amount. There is no configuration that lets this run post. Writing off a receivable ends collection and changes the tax position, so it always needs a named approver.

**Logs.** Invoice id, age, balance, collection attempt count, the method applied, the tax portion computed, the approval tier, and the resulting draft entry id.

**Reverses.** Shape R1 for unapproved proposals. An approved and posted write off reverses through shape R3, which is the recovery path when a written off receivable is later collected.

**Blocked by.** Allowance account missing under the allowance method. Bad debt category missing under the direct method. Target period locked.

**Test assertions.**
- An invoice at 364 days past due produces no proposal, and at 365 it does.
- An invoice with 2 logged collection attempts produces no proposal under a 3 attempt policy.
- Under the allowance method, zero bad debt expense is proposed.
- The written off tax portion plus the written off net equals the invoice open balance exactly.
- No execution of this run posts a journal entry directly.
- A proposal above the tier 1 amount routes to partner approval.

---

## Module 6. Substantiation

### SUB-TIEOUT-ACCOUNTS, Compute balance sheet tie out variances

**Fires from.** `/substantiation`, on open and on the refresh control, and inside `/close` for gate G07.

**Purpose.** Compare every balance sheet account's ledger balance to its supporting amount and compute the variance that gate G07 reads.

**Scope options.** Client, one period, optional single account or account range.

**Inputs read.** Ledger balances at period end for every account below 4000, the support definition per account (subledger total, statement balance, schedule total, external confirmation, or manual supported amount), attached documents, prior period tie out state, and preparer and reviewer assignments.

**Deterministic rule.**
1. Support source per account is a stored definition, never inferred. Bank and card accounts use the reconciled statement balance. AR and AP use the subledger total from `ARAP-REFRESH-AGING`. Prepaid uses the schedule remaining balance. Fixed assets use the register cost total and the register accumulated total. Loans use the amortization schedule ending balance. Everything else uses a manual supported amount with a document attached.
2. Variance equals ledger balance minus supported amount, in integer cents, signed.
3. State assignment. Variance of exactly 0 with support present sets `computed_tied`. Variance of exactly 0 with no support present sets `unsupported`. Any non zero variance sets `variance_open` with the signed amount. There is no materiality threshold that turns a non zero variance into tied, because gate G07 requires either tied or an approved variance carrying a reason and a reviewer.
4. The run never sets `tied`. Only a named human sets `tied`, and only from `computed_tied`. The distinction is the whole control.
5. Wrong side check for gate G15: if the balance sign contradicts the account's normal side and no stated reason exists, raise `wrong_side_no_reason` on the account.
6. Iteration order is account number ascending.

**Deliberately skips.** Income statement accounts, reason `not_a_balance_sheet_account`. Accounts with a zero ledger balance and a zero supported amount, reason `both_zero`, which are reported as tied by definition and need no document. Inactive accounts with zero balance, reason `inactive_zero`.

**Writes.** Tie out rows with the computed variance and the computed state. Proposes only. It writes no ledger entry and it never marks an account tied.

**Logs.** Account, ledger balance, supported amount, support source, variance, computed state, documents attached count, and any wrong side finding.

**Reverses.** Shape R2, restore prior tie out rows for the period, leaving human set `tied` states untouched.

**Blocked by.** Period has no closing balances computable, meaning no posted entries. Support definitions missing for more than zero accounts does not block, it produces `unsupported` states.

**Test assertions.**
- Every account below 4000 with a non zero balance appears in the output exactly once.
- An account whose ledger equals support is `computed_tied`, never `tied`.
- No execution of this run produces state `tied`.
- A 1 cent variance produces `variance_open`, not tied.
- A negative cash balance with no stated reason raises `wrong_side_no_reason`.
- The AR tie out variance equals the tie difference reported by `ARAP-REFRESH-AGING` for the same date.

---

### SUB-RAISE-REQUESTS, Raise substantiation document requests

**Fires from.** `/substantiation` via the raise request button and the bulk action, and inside the pre close check.

**Purpose.** Turn unsupported balances and open suspense items into concrete portal requests with owners and escalation dates.

**Scope options.** Client, one period, optional account filter, and an owner filter of client or firm.

**Inputs read.** Tie out rows in states `unsupported` and `variance_open`, open suspense items with client owned reason codes, the escalation ages from Part 4 of the conventions, the request catalog, and existing open requests.

**Deterministic rule.**
1. One request per unsupported account per period, carrying the account, the period, the ledger balance, and the specific document named in the support definition.
2. One request per open suspense item whose reason code has owner `client`, per Part 4. Codes with owner `firm` produce an internal task instead of a portal request, and `SUS-12` with owner `system` produces neither, because it clears itself.
3. Escalation date equals the request creation date plus the escalation age from the conventions table for that code, or plus the catalog default of 10 days for a substantiation request.
4. Deduplication is on the tuple of client, request catalog code, account, period, and linked item id. An open or satisfied request on the same tuple suppresses a new one.
5. Requests are grouped for delivery so the client receives one portal notification per execution rather than one per request.
6. Iteration order is account number ascending, then suspense item date ascending, then item id ascending.

**Deliberately skips.** Tie out rows in state `tied` or `computed_tied`, reason `support_present`. Firm owned suspense codes, reason `firm_owned_internal_task`. `SUS-12`, reason `system_owned_self_clearing`. Existing matching requests, reason `request_exists`. Waived items, reason `explicitly_waived`.

**Writes.** Portal requests, internal tasks, and portal notifications. Proposes only in the ledger sense, since it never posts. Request creation is itself the output.

**Logs.** Every request created with the tuple used for deduplication, the escalation date, the owner, and the linked account or suspense item, plus every suppression with its reason.

**Reverses.** Delete requests created by this execution that remain open with zero uploads and zero messages, and delete the linked notifications. Anything the client touched is retained.

**Blocked by.** Portal access not configured. No tie out rows for the period, in which case it completes with zero considered.

**Test assertions.**
- Every client owned open suspense item has exactly one open request, and no firm owned item has any.
- Zero `SUS-12` items produce a request.
- Every created request has an escalation date matching the conventions table age for its code.
- A second execution creates zero additional requests.
- Gate G17 passes on a fixture where every generated request is satisfied or waived.

---

## Module 7. Close

### CLOSE-CHECK-GATES, Pre close gate check

**Fires from.** `/close`, on open and on the run check control.

**Purpose.** Evaluate all seventeen close gates live against the ledger and return pass, fail with a drill down list, or not applicable with the scope reason.

**Scope options.** Client and one period. Never a range, because a close is per period.

**Inputs read.** Every gate reads directly from the ledger and the subledgers. Nothing is read from a stored checkbox. The engagement scope answers determine which conditional gates apply.

**Deterministic rule.** Each gate is a query returning a boolean plus a drill down list. Gates evaluate in G01 to G17 order and all of them evaluate every time. A failing gate never short circuits the rest, because the operator needs the full list.

| Gate | Test as implemented |
|---|---|
| G01 | Balances of 1910, 1920, 1930, and 1990 at period end are each exactly 0 |
| G02 | Count of journal entries in state draft or proposed dated in the period is 0 |
| G03 | Every account flagged bank or card has a reconciliation for the period in state reconciled with difference exactly 0 |
| G04 | AR subledger total equals the AR control balance and AP subledger total equals the AP control balance, both to the cent |
| G05 | Sum of every journal line dated on or before period end is exactly 0 |
| G06 | Count of transactions dated in the period with a null category is 0 |
| G07 | Every balance sheet account has tie out state `tied`, or `variance_open` with a non empty reason and a non null reviewer |
| G08 | 1900 balance equals the deposits in transit list total. Not applicable when 1900 has never been used |
| G09 | Inventory subledger total equals the inventory control balance. Conditional on inventory in scope |
| G10 | Sales tax payable balance equals the filed or computed return figure. Conditional on sales tax in scope |
| G11 | Payroll liability balances equal the payroll provider report totals. Conditional on payroll in scope |
| G12 | Every in service asset has a depreciation posting for the period, or a documented skip. Conditional on the fixed asset register in scope |
| G13 | Every active prepaid schedule and accrual item has a posting for the period. Conditional on schedules existing |
| G14 | Sum of due to and due from related party accounts across the group is exactly 0. Conditional on related entities in scope |
| G15 | Count of accounts with a balance on the wrong side of their normal side and no stated reason is 0 |
| G16 | Net assets with donor restrictions roll forward reconciles and every expense line carries a functional classification. Conditional on nonprofit |
| G17 | Count of client requests older than their escalation age and not satisfied and not waived is 0 |

Overrides. A gate may be overridden with a named person and a written reason. An override is recorded against the gate and the period, sets `closed_with_exceptions` on the period, and cannot be cleared. It only stops being visible when a later corrected close supersedes it, and the history retains both.

**Deliberately skips.** Conditional gates outside engagement scope return `not_applicable` with the scope reason. They are not counted as passes and are not counted as failures.

**Writes.** A gate result set attached to the period plus the drill down lists. Proposes nothing and posts nothing. It changes no ledger value at all.

**Logs.** Every gate with its result, the count in its drill down list, the query duration, and every override with the person, reason, and timestamp.

**Reverses.** Not applicable. Results are recomputed on the next execution. Prior result sets are retained by timestamp for the close history.

**Blocked by.** Period does not exist. Period already locked, in which case the run returns the historical result set read only.

**Test assertions.**
- All seventeen gates return a result for every execution, either pass, fail, or not applicable.
- A fixture with 1 cent in 1990 fails G01 and the drill down names the transaction.
- A fixture with one uncoded transaction fails G06, and after `TXN-SWEEP-SUSPENSE` runs it passes G06 and fails G01, which is the intended trade.
- No gate reads a stored boolean, verified by mutating a ledger row and observing the gate result change without any run executing.
- An overridden gate leaves `closed_with_exceptions` true and the flag cannot be cleared by any subsequent run.
- Nonprofit gate G16 returns not applicable for a for profit client, with the scope reason populated.

---

### CLOSE-LOCK-PERIOD, Lock the period

**Fires from.** `/close`, the lock control, enabled only after `CLOSE-CHECK-GATES` has run in the same session.

**Purpose.** Freeze the period so no transaction may be created, modified, or coded inside it, and no run may write to it.

**Scope options.** Client and one period. One period per execution, and periods must lock in chronological order.

**Inputs read.** The latest gate result set for the period, override records, the prior period lock state, and the acting user's authority level.

**Deterministic rule.**
1. Require a gate result set computed after the last ledger write in the period. If any ledger write happened after the last gate check, refuse and require a recheck. This closes the window where a change lands between the check and the lock.
2. Every gate must be pass, not applicable, or explicitly overridden. Any gate in fail with no override refuses the lock.
3. The prior period must already be locked, or be the first period of the engagement. Periods lock in order with no gaps.
4. On lock: set the period state to locked, snapshot the trial balance at period end into the immutable close record, record the acting user, the timestamp, every override, and the `closed_with_exceptions` flag.
5. The lock takes effect at the data layer. Every write path checks period state, so nothing depends on a run remembering to check.
6. A locked period may be reopened only by an administrative action outside this run, which is itself recorded in close history and never deletes the prior close record.

**Deliberately skips.** Nothing. A lock is all or nothing. There is no partial lock and no per account lock.

**Writes.** Period state, the close record, and the trial balance snapshot. Posts no journal entry. The close record is immutable.

**Logs.** Gate result set id used, every override with person and reason, the acting user, the snapshot checksum, and the resulting period state.

**Reverses.** Not by a run. Reopening is a separate administrative action requiring a named administrator, and it appends to close history rather than removing the original close record.

**Blocked by.** Any gate failing without an override. A stale gate result set. The prior period not locked. The acting user lacking lock authority.

**Test assertions.**
- Locking a period whose prior period is open is refused.
- After lock, an attempted transaction write dated in the period is refused at the data layer, verified by calling the write path directly rather than through a run.
- After lock, `TXN-APPLY-RULES` scoped to that period returns outcome `blocked` and writes nothing.
- A ledger write after the gate check invalidates the lock attempt.
- The trial balance snapshot nets to exactly zero.
- `closed_with_exceptions` persists on the close record and appears on statement headers for that period.

---

### CLOSE-ROLL-FORWARD, Roll balances forward and open the next period

**Fires from.** `/close`, immediately after a successful lock.

**Purpose.** Establish the opening balances of the next period from the closed period's ending balances and open it for posting.

**Scope options.** Client, the closed period, and the next period as the target.

**Inputs read.** The immutable trial balance snapshot from the close record, the client period calendar, and the chart of accounts.

**Deterministic rule.**
1. Opening balance of every balance sheet account in the next period equals its ending balance in the snapshot, exactly, with no recomputation from transactions. The snapshot is the authority so a later correcting entry in an earlier open period cannot silently alter a completed roll forward.
2. Income statement accounts, 4000 through 9999, open at zero within the fiscal year to date view. They do not roll into equity at a period roll forward, only at year end.
3. If the next period does not exist in the calendar, create it from the calendar definition.
4. Set the next period state to open. Only one period is opened per execution.
5. The roll forward writes no journal entry. Opening balances are derived from the snapshot, not posted, so the ledger has one source of truth.
6. Iteration order is account number ascending.

**Deliberately skips.** Accounts with a zero ending balance and no activity, reason `zero_no_activity`, since carrying zeros forward adds noise.

**Writes.** Period opening balance records and the next period state. Posts no journal entry. Authorized to write automatically because it is an arithmetic identity over a locked and snapshotted period.

**Logs.** Source close record id, account count rolled, the sum of rolled balances which must be zero, and the next period id opened.

**Reverses.** Reversal deletes the opening balance records and returns the next period to `not_yet_opened`, permitted only when the next period has zero posted transactions.

**Blocked by.** The source period is not locked. A close record snapshot is missing. The next period is already open with posted activity.

**Test assertions.**
- The sum of rolled opening balances is exactly zero.
- Every balance sheet account opening balance equals the snapshot ending balance to the cent.
- No income statement account carries a non zero opening balance within the fiscal year.
- Reversal is refused when the next period already has posted transactions.
- Executing twice opens exactly one period.

---

### CLOSE-POST-YEAREND, Post the year end close to retained earnings or net assets

**Fires from.** `/close`, only on the fiscal year end period, after that period is locked.

**Purpose.** Zero every income statement account into retained earnings, or into net assets for a nonprofit, and open the new fiscal year.

**Scope options.** Client and one fiscal year. One execution per fiscal year.

**Inputs read.** Ending balances of accounts 4000 through 9999 from the year end close record snapshot, the equity target account or the two net asset class accounts, the nonprofit flag, the donor restriction dimension where applicable, and any prior year end entry for the same year.

**Deterministic rule.**
1. Build one journal entry dated the last calendar day of the fiscal year, source `year_end_close`.
2. One line per income statement account with a non zero ending balance, each line the exact opposite sign of that balance, so every one of those accounts ends at exactly zero.
3. The balancing line goes to retained earnings for a for profit client. For a nonprofit, per FASB ASU 2016-14, the balancing amount splits into net assets with donor restrictions and net assets without donor restrictions, allocated by the donor restriction dimension carried on the revenue and expense lines. Amounts with no restriction dimension go to without donor restrictions. There is no third class, because ASU 2016-14 replaced three with two.
4. The entry must sum to exactly zero before posting. Any rounding residual from the nonprofit split lands on the without donor restrictions line, which is the highest sequence line.
5. After posting, every account from 4000 to 9999 must have an ending balance of exactly zero. If any does not, the entry is rolled back in full and the run reports `year_end_not_flat`.
6. Line order is account number ascending, with the equity lines last.

**Deliberately skips.** Income statement accounts with a zero ending balance, reason `zero_balance`. Memo accounts in 9000 to 9999 flagged `never_on_published_statement` are still closed, because a memo account carrying a balance into a new year is a defect.

**Writes.** One posted journal entry. Posts automatically, authorized because it is an arithmetic identity over a locked year with a verified snapshot, executed only after the year end period passed its gates.

**Logs.** Fiscal year, account count closed, total closed to equity, the nonprofit split by class where applicable, the flatness verification result, and the entry id.

**Reverses.** Shape R3. Since the year end period is locked by the time this runs, the reversing entry posts on the first day of the earliest open period and is flagged `redated_from_locked_period`. A correcting year end close is then posted as a new entry, and both remain in history.

**Blocked by.** The fiscal year end period is not locked. A year end entry already exists for the year. The equity target account is missing. For a nonprofit, either net asset class account missing.

**Test assertions.**
- After the run, every account from 4000 to 9999 has a balance of exactly zero.
- Retained earnings increases by exactly the net income of the year, to the cent.
- For a nonprofit fixture, exactly two net asset accounts receive postings and the split totals equal net income exactly.
- A nonprofit split with a rounding residual puts the residual on the without donor restrictions line and the entry still sums to zero.
- Running twice for the same fiscal year posts one entry.
- A memo account with a balance is closed to zero.

---

## Module 8. Reporting

### RPT-BUILD-PACKAGE, Build the client report package

**Fires from.** `/package`, the build control, and on schedule after a period locks.

**Purpose.** Assemble the selected report sections for a closed period into one package ready for portal delivery.

**Scope options.** Client, one period, a section list, and a comparison basis of prior period, prior year, or budget.

**Inputs read.** The locked period close record and its trial balance snapshot, the section catalog, statement definitions, the aging snapshot, the budget variance output, the forecast output, the narrative draft, the client branding record, and the `closed_with_exceptions` flag.

**Deterministic rule.**
1. Only a locked period may be packaged. An open period produces a package clearly watermarked `draft, period not closed` on every page, and this is a hard rule rather than a preference.
2. Sections render in the catalog sequence order, never in selection order, so every package for every client has the same shape.
3. Every figure comes from the close record snapshot, not from a live query, so a package regenerated a year later shows the same numbers it showed on delivery day.
4. Comparison columns come from the corresponding snapshot of the comparison period. If that period has no snapshot, the column is omitted and the omission is stated on the page rather than being silently blank.
5. If `closed_with_exceptions` is true, the exception banner prints on the cover and on every statement header, listing each overridden gate with its written reason. It cannot be suppressed by a section selection.
6. The package carries a content checksum over every rendered figure, so a later regeneration can be proved identical.

**Deliberately skips.** Sections whose source data does not exist, reason `section_source_missing`, printed as an omission note. Sections not selected, reason `not_selected`. Nonprofit only sections for a for profit client, reason `out_of_scope`.

**Writes.** A package document in state `draft` plus a delivery record when sent. Proposes only. A person presses send. No ledger effect.

**Logs.** Section list rendered, omissions with reasons, snapshot ids used per section, the comparison basis, the exception banner state, and the content checksum.

**Reverses.** Shape R1, delete draft packages from this execution. Delivered packages are never deleted, only superseded by a later version with a new checksum.

**Blocked by.** Period not locked, which downgrades rather than blocks by producing the watermarked draft. No close record snapshot blocks entirely.

**Test assertions.**
- Two executions over the same locked period produce identical content checksums.
- A package for a period closed with exceptions prints the banner on every statement header.
- A missing comparison snapshot produces a stated omission, never a blank column.
- Section order is identical across two clients with different selections.
- Every figure in the package equals the corresponding figure in the close record snapshot.

---

### RPT-FLAG-VARIANCES, Flag budget variances

**Fires from.** `/budget`, on open and on the refresh control, and inside package build.

**Purpose.** Compare actual to budget by account and dimension and flag lines outside the stated thresholds.

**Scope options.** Client, one period or a year to date range, and optional class, job, or department filter.

**Inputs read.** Actual balances by account and dimension for the range, budget rows for the same range, the client variance thresholds (percentage in basis points and an absolute cents floor), and prior period flags.

**Deterministic rule.**
1. Variance equals actual minus budget in integer cents. Variance percentage equals variance times 10000 divided by the absolute budget, in basis points, computed only when the budget is non zero.
2. A line is flagged when the absolute variance is at or above `variance_floor_cents`, default 50000, and the absolute variance percentage is at or above `variance_threshold_bp`, default 500 which is 5 percent. Both conditions must hold, so a large percentage on a tiny budget does not flood the report and a large dollar amount on a huge budget does not either.
3. Where budget is exactly zero and actual is non zero, the percentage is undefined. The line is flagged as `unbudgeted_activity` when the absolute actual is at or above the floor. No division is attempted.
4. Direction labels are mechanical: for revenue accounts a positive variance is `favorable`, for expense accounts a positive variance is `unfavorable`. The label comes from the account range, not from interpretation.
5. Flags are ordered by absolute variance descending, then account number ascending.
6. Nothing about the flag is a prediction. It is a comparison of two stored numbers against two stored thresholds.

**Deliberately skips.** Accounts with no budget row and no actual, reason `no_activity`. Balance sheet accounts, reason `not_budgeted`, unless the client budgets them explicitly. Dimensions excluded by the filter, reason `filtered_out`.

**Writes.** Variance flag rows and the summary counts. Proposes only. No ledger effect and no narrative text.

**Logs.** Line count evaluated, flagged count, thresholds used, and per flagged line the actual, budget, variance, percentage, and label.

**Reverses.** Not applicable as a ledger action. Flags are replaced by the next execution and prior flag sets are retained by timestamp.

**Blocked by.** No budget loaded for the range, which completes with zero considered and a stated reason.

**Test assertions.**
- A line 6 percent over budget by 40000 cents is not flagged under a 50000 cent floor.
- A line 4 percent over budget by 900000 cents is not flagged under a 500 basis point threshold.
- A line 6 percent over by 60000 cents is flagged.
- A zero budget with 60000 cents of actual is flagged as `unbudgeted_activity` with no percentage computed.
- A positive variance on a 4000 series account is labeled favorable and on a 6000 series account unfavorable.
- Two executions produce identical flag sets.

---

### RPT-REBUILD-FORECAST, Rebuild the thirteen week cash forecast

**Fires from.** `/forecast`, the rebuild control, and on schedule weekly.

**Purpose.** Rebuild the thirteen week cash forecast from committed and scheduled items only, with named stress scenarios applied as arithmetic multipliers.

**Scope options.** Client, a start week defaulting to the current week, a horizon fixed at 13 weeks, and a scenario of base, slow collections, or revenue shortfall.

**Inputs read.** Current cash balances by account, open AR with due dates and the client's stored historical days to pay per customer where recorded, open AP with due dates, recurring template amounts and schedules, loan amortization schedules, payroll schedule amounts, known one time items entered by a person, and the scenario definitions.

**Deterministic rule.**
1. Opening cash equals the sum of cash account balances as of the start date, from the ledger.
2. Inflows include only open invoices and manually entered expected receipts. An invoice is placed in the week containing its due date under the base scenario. There is no prediction of unbilled revenue, and no forecast line is ever created from a trend.
3. Outflows include open bills at their due date week, recurring templates at their posting date week, loan payments at their scheduled date week, payroll at its scheduled date week, and manually entered one time items.
4. Scenarios are stored arithmetic transforms, not models.
   - `base`: no transform.
   - `slow_collections`: every AR inflow shifts later by `slow_shift_days`, default 30 calendar days. Amounts are unchanged.
   - `revenue_shortfall`: every AR inflow amount is multiplied by `shortfall_bp`, default 8000 which is 80 percent, rounded by the Part A rule. Timing is unchanged.
   Scenario parameters are visible on the screen next to the result, because a scenario the reader cannot see the parameters of is not a forecast, it is a guess.
5. Where a customer has a stored historical days to pay value, entered or computed as a plain average of settled invoices for that customer, the base scenario may use due date plus that value. This is a stored arithmetic average over actual history and it is displayed as such. It is off by default and enabled per client.
6. Weekly closing cash equals prior closing plus inflows minus outflows. Any week with a negative closing balance is flagged `projected_shortfall` with the exact amount and the first shortfall week is reported at the top.
7. Iteration order is week ascending, then item due date ascending, then item id ascending.

**Deliberately skips.** Items outside the 13 week horizon, reason `outside_horizon`. Disputed items, reason `in_dispute`. Items already settled, reason `settled`. Draft invoices and bills, reason `not_posted`.

**Writes.** Forecast rows per week per scenario. Proposes only. No ledger effect. A forecast never becomes an entry.

**Logs.** Opening cash, item count per category, scenario and its parameters, weekly totals, and every shortfall week with its amount.

**Reverses.** Not applicable. Rebuilt on each execution, prior versions retained by timestamp.

**Blocked by.** No cash accounts on the chart.

**Test assertions.**
- Week 1 opening cash equals the ledger cash balance on the start date, to the cent.
- Sum of weekly inflows equals the sum of included open AR under the base scenario.
- `slow_collections` moves every AR inflow exactly 30 days later and changes no amount.
- `revenue_shortfall` multiplies every AR inflow by exactly 80 percent and moves no date.
- No forecast line exists without a source document id or a manual entry id.
- Two executions with the same inputs produce identical weekly closing balances.

---

### RPT-COMPOSE-NARRATIVE, Compose the period narrative from thresholds

**Fires from.** `/narrative`, the generate control, and inside package build.

**Purpose.** Produce a first draft of the management commentary using stored sentence templates selected by threshold tests over the closed books, with no language model involved.

**Scope options.** Client, one closed period, a comparison basis, and an audience of owner or lender.

**Inputs read.** The close record snapshot, the comparison snapshot, the variance flag set from `RPT-FLAG-VARIANCES`, the aging snapshot, the forecast output, the gate result set including any exceptions, and the sentence template library keyed by trigger code with an audience variant.

**Deterministic rule.** This run assembles sentences. It does not write them.
1. Every sentence in the library has a trigger code, an audience, a priority integer, and merge fields. A sentence enters the draft only when its trigger test passes.
2. Trigger tests are threshold comparisons over stored figures. Examples, all configurable: `REV_UP` when revenue change is at or above 1000 basis points against the comparison, `REV_DOWN` at or below negative 1000, `GM_SHIFT` when gross margin moves at or above 300 basis points, `CASH_DOWN` when cash falls at or above 15 percent, `AR_AGING_UP` when the over 90 bucket grows at or above 20 percent, `EXPENSE_SPIKE` for each variance flag labeled unfavorable, `SHORTFALL_WEEK` when the forecast has a projected shortfall inside 13 weeks, and `CLOSED_WITH_EXCEPTIONS` when any gate was overridden.
3. Merge fields are filled with formatted figures taken from the snapshot. No number in the narrative is computed inside this run. Every one is a figure another run already produced, which is why the narrative can never disagree with the statements.
4. Sentence order is section order, then priority descending, then trigger code ascending.
5. Cap the draft at `max_sentences_per_section`, default 5, dropping lowest priority first, so the draft stays readable. Dropped sentences are logged, not deleted from consideration silently.
6. If no trigger fires in a section, the section prints its stored neutral sentence. There is no attempt to find something to say.
7. `CLOSED_WITH_EXCEPTIONS` is never droppable by the cap. It always prints.

**Deliberately skips.** Triggers whose source data is missing, reason `trigger_source_missing`. Sentences for the other audience, reason `audience_mismatch`. Sentences already manually edited in an existing draft for the period, reason `manual_edit_present`, because a person's words are never overwritten.

**Writes.** A narrative draft in state `draft`, fully editable. Proposes only. No draft reaches a client without a person sending it.

**Logs.** Every trigger evaluated with its computed value, the threshold, and whether it fired, every sentence included with its template id, and every sentence dropped by the cap.

**Reverses.** Shape R1, delete unedited drafts from this execution. Edited drafts are retained.

**Blocked by.** Period not locked. No sentence template library configured.

**Test assertions.**
- Every number appearing in the draft matches a figure in the close record snapshot exactly, verified by parsing the merge field values.
- No sentence appears whose trigger did not fire, verified against the trigger log.
- A period closed with exceptions always contains the exceptions sentence, even when the section cap is exceeded.
- Two executions over the same closed period produce byte identical draft text.
- A section with no firing trigger prints exactly one neutral sentence.
- Manually edited sentences survive a regeneration untouched.

---

### TAX-BUILD-1099, Build the 1099 reportable payee set

**Fires from.** `/tax-forms`, the build control, and on schedule in January for the prior calendar year.

**Purpose.** Determine which payees are reportable for a calendar year, on which form and in which box, using the threshold effective for that year.

**Scope options.** Client, one calendar year, and optional single payee. The year drives the threshold, never today's date.

**Inputs read.** All payments to vendors dated inside the calendar year, the payment method on each payment, vendor records with entity type, W-9 state, TIN presence, and the `1099_class` on each category coded, the dated threshold configuration table, the state filing configuration, and any prior filed forms for the year.

**Deterministic rule.**
1. **Threshold is read from a dated configuration table, never a constant.** The table holds an effective start date, an effective end date, and a threshold in cents. Seeded rows: payments dated before January 1, 2026 use 60000 cents, and payments dated on or after January 1, 2026 use 200000 cents, following section 70433 of the One Big Beautiful Bill Act which raised the Form 1099-NEC and Form 1099-MISC threshold from 600 dollars to 2,000 dollars for payments made on or after January 1, 2026, with inflation indexing from 2027 ([Littler](https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds)). The run selects the row whose effective range contains January 1 of the reporting year, so a rerun of calendar year 2025 produces 600 dollar behavior and calendar year 2026 produces 2,000 dollar behavior with no code change. Indexed thresholds for 2027 onward are added as new rows when published.
2. **Aggregate per payee per calendar year.** Sum every payment to the payee dated inside the year, across every category and every bank account, per the aggregation requirement ([Anchin](https://www.anchin.com/articles/faqs-new-1099-nec-and-1099-misc-rules-beginning-in-2026/)). Comparison is against the threshold for that year, inclusive: a payee at exactly the threshold is reportable.
3. **Payment method exclusion.** Payments made by credit card, debit card, or a third party settlement organization are excluded from the payee total, because those are reportable by the processor on Form 1099-K. Exclusion is by the stored payment method on the transaction, not by inference from the descriptor.
4. **Entity exclusion and the attorney exception.** Corporations, both C and S, are excluded, based on the entity type on the furnished Form W-9. **Attorneys are reportable even when incorporated**, so a payee whose category `1099_class` is `attorney` is never excluded by entity type. Legal fees for services are generally reported on Form 1099-NEC even where the law firm is a corporation ([Anchin](https://www.anchin.com/articles/faqs-new-1099-nec-and-1099-misc-rules-beginning-in-2026/)). Also never excluded by entity type: medical and health care payments, and gross proceeds paid to an attorney.
5. **Form and box routing by `1099_class` on the category coded, per payment.** `nec` routes to Form 1099-NEC box 1. `attorney` routes to Form 1099-NEC box 1 for fees for services, and to Form 1099-MISC box 10 where the payment is flagged gross proceeds. `misc_rent` routes to Form 1099-MISC box 1. `misc_other` routes to Form 1099-MISC box 3. `none` is excluded from the total entirely. A payee with amounts in more than one class produces more than one form, and each form's box amount is tested against the threshold on the aggregate payee total, not per box, because the threshold is measured per payee per year.
6. **Backup withholding flag.** Where the payee total meets the threshold and no valid W-9 with a taxpayer identification number is on file, flag `backup_withholding_required` at the same 2,000 dollar trigger, indexed from 2027 ([Littler](https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds)). The run flags. It never withholds.
7. **Near threshold watch list.** Payees at or above 80 percent of the threshold and below it are listed as `approaching_threshold` so W-9 collection starts before year end. They are not reportable and are never included in a filing set.
8. Iteration order is payee name ascending then payee id ascending. Amounts are integer cents throughout, and the form renders dollars only at the display boundary.

**Deliberately skips.** Payees below the threshold, reason `below_threshold_for_year`. Card and third party network payments, reason `reportable_by_processor_1099k`. Corporations without an attorney or medical class, reason `corporation_excluded`. Categories with `1099_class` of `none`, reason `class_none`. Payees already filed for the year, reason `already_filed`, unless correction mode is selected. Payments dated outside the calendar year, reason `outside_calendar_year`, with no accrual basis adjustment, because 1099 reporting is cash basis by payment date.

**Writes.** A draft reportable payee set with per form and per box amounts, plus the backup withholding flags and the approaching threshold list. Proposes only, always. A filing is a legal submission and requires review and a named submitter.

**Logs.** The threshold row selected with its effective dates and value, the reporting year, per payee the gross total, excluded card and processor amounts, the entity exclusion decision and whether the attorney exception overrode it, the per box split, the W-9 state, and the backup withholding flag.

**Reverses.** Shape R1, delete the draft set. A filed set is never deleted. Corrections are produced as a new corrected set linked to the original.

**Blocked by.** No dated threshold row covering the reporting year, which is a hard block because guessing a threshold is unacceptable. Client tax identification number missing. Reporting year not complete when not in preview mode.

**Test assertions.**
- A payee paid 1,800 dollars in calendar year 2026 is not reportable. The same payee paid 1,800 dollars in calendar year 2025 is reportable.
- A payee paid exactly 2,000 dollars in 2026 is reportable, since the comparison is inclusive.
- A rerun of calendar year 2025 after the 2026 row is added still uses 60000 cents, proving the threshold is dated configuration and not a constant.
- An incorporated law firm paid 5,000 dollars appears on Form 1099-NEC box 1. An incorporated plumbing company paid 5,000 dollars does not appear at all.
- A payee paid 3,000 dollars entirely by credit card is not reportable, and the excluded amount is shown in the log.
- A payee paid 1,500 dollars by check and 2,000 dollars by card in 2026 is not reportable, because only the 1,500 counts.
- A reportable payee with no W-9 carries `backup_withholding_required`, and no withholding is computed or posted.
- A payee at 1,700 dollars in 2026 appears on the approaching threshold list and in no filing set.
- Rent of 2,400 dollars routes to Form 1099-MISC box 1 and not to Form 1099-NEC.
- Two executions over the same year produce identical payee sets and identical box amounts.

---

### TAX-TRACK-W9, Track W-9 collection status

**Fires from.** `/tax-forms` W-9 tab, `/portal/sign` on submission, and on schedule monthly.

**Purpose.** Maintain the W-9 status of every payee who is reportable or approaching the threshold, and request what is missing.

**Scope options.** Client, one calendar year, optional payee filter, and a status filter.

**Inputs read.** The payee set and approaching threshold list from `TAX-BUILD-1099`, W-9 documents on file with signature date and entity type, stored taxpayer identification number presence and last four digits, prior request history, and the year end date.

**Deterministic rule.**
1. Status per payee is assigned by this ordered list, first match wins: `on_file_complete` when a signed W-9 exists with an entity type and a taxpayer identification number recorded, `on_file_incomplete` when the document exists but either field is blank, `requested_pending` when a request is open, `requested_overdue` when a request is open past its escalation age, and `missing` otherwise.
2. Create a W-9 request for every payee in status `missing` or `on_file_incomplete` who is reportable or approaching the threshold. One open request per payee per year, deduplicated on client, payee, and year.
3. Escalation age for a W-9 request is 10 days, and an overdue request escalates to the engagement lead rather than generating a second request.
4. Before January 1 of the filing year, display the standard warning that the reporting set is provisional until the calendar year closes. This is a display state driven by the date, not a judgment.
5. Only the last four digits of any taxpayer identification number are ever rendered or written to a log. The full value lives in the encrypted field and is never included in any log line, any export, or any narrative.
6. Iteration order is status severity descending, meaning missing first, then payee name ascending.

**Deliberately skips.** Payees below the approaching threshold, reason `not_near_threshold`. Payees with a complete W-9, reason `w9_on_file_complete`. Payees excluded as corporations without the attorney or medical exception, reason `not_reportable`. Existing open requests, reason `request_exists`.

**Writes.** W-9 status rows, portal requests, and escalations. Proposes only. It writes no ledger entry and it never withholds.

**Logs.** Payee id, status assigned and which decision step assigned it, request id created, escalation state, and the last four digits only.

**Reverses.** Delete requests created by this execution that remain open with zero uploads. Status rows are recomputed on the next execution.

**Blocked by.** Portal access not configured, which still allows status computation but suppresses request creation, reported as `requests_suppressed_no_portal`.

**Test assertions.**
- No log line, export, or narrative anywhere in the system contains more than the last four digits of a taxpayer identification number, verified by a repository wide fixture scan.
- A payee with a signed W-9 missing an entity type is `on_file_incomplete` and receives a request.
- Exactly one open W-9 request exists per payee per year after repeated executions.
- A request open 11 days is `requested_overdue` and escalates to the lead without creating a second request.
- Every payee flagged `backup_withholding_required` by `TAX-BUILD-1099` has a W-9 status other than `on_file_complete`.

---

## Module 9. Practice

### PRAC-GENERATE-TASKS, Generate period work

**Fires from.** `/board`, and on schedule on the first day of each period.

**Purpose.** Create the period's work items for every active client from the engagement scope and the task catalog, so the board reflects the real workload without anyone building it.

**Scope options.** All active clients or a single client, one period, and an optional team filter.

**Inputs read.** Active clients with engagement scope and service frequency, the task catalog, the client period calendar, existing tasks for the period, assignments and roles, and the team capacity settings.

**Deterministic rule.**
1. Selection and due date logic are identical to `INTAKE-SEED-TASKS` steps 1 to 3, including the weekend shift to Monday and the absence of a holiday calendar. There is one implementation shared by both runs.
2. Dependencies are stored on the catalog as predecessor codes. A task with an unmet predecessor is created in state `blocked` rather than `open`, and it moves to `open` when the predecessor completes. This is a state transition on completion, not a recomputation.
3. Assignment: preparer tasks to the client preparer, review tasks to the client lead. If the assignee is marked unavailable for the whole period, the task is created unassigned and appears in the unassigned column. The run never reassigns to a different person, because balancing workload is a decision a manager makes.
4. Iteration order is client name ascending, then catalog code ascending.

**Deliberately skips.** Existing tasks for the same client, code, and period, reason `task_exists`. Clients in stage `prospect` or `offboarded`, reason `client_not_active`. Out of scope catalog entries, reason `out_of_engagement_scope`. Locked periods, reason `locked_period`.

**Writes.** Task rows. Proposes only in the sense that it never touches the ledger. Task creation is the output and it requires no approval.

**Logs.** Per client the count created, blocked, and unassigned, and every skip with its reason.

**Reverses.** Delete tasks created by this execution that remain in state `open` or `blocked` with no comments and no time entries.

**Blocked by.** No period calendar. No active clients, which completes with zero considered.

**Test assertions.**
- Running twice for one period creates each task exactly once.
- A task whose predecessor is incomplete is created in state `blocked`.
- No generated due date falls on a Saturday or a Sunday.
- A client with payroll out of scope receives zero payroll tasks.
- Tasks for an unavailable assignee are unassigned, never reassigned automatically.

---

### PRAC-ESCALATE-OVERDUE, Escalate overdue work

**Fires from.** `/board` overdue filter, and on schedule daily.

**Purpose.** Move overdue tasks up the escalation ladder on a fixed schedule so nothing sits silently past its due date.

**Scope options.** All active clients or a single client, an as of date defaulting to today, optional team filter.

**Inputs read.** Open and blocked tasks with due dates, the escalation ladder for the client and task type, prior escalation records, assignee and lead and partner identities, and out of office records.

**Deterministic rule.**
1. Days overdue equals the as of date minus the due date, counted in calendar days. Zero or negative means not overdue.
2. Ladder, all configurable per client with these defaults: at 1 day notify the assignee, at 3 days notify the engagement lead, at 7 days notify the partner, at 14 days flag the client engagement as `at_risk` on the firm overview.
3. Each rung fires exactly once per task per due date. Changing the due date resets the ladder and the reset is logged with the old and new dates, so extending a due date to dodge an escalation is visible.
4. Blocked tasks escalate against the blocking predecessor's owner rather than their own assignee, because chasing the wrong person is worse than not chasing.
5. An assignee marked out of office escalates immediately to the next rung, skipping the assignee rung.
6. Iteration order is days overdue descending, then client name ascending, then task id ascending.

**Deliberately skips.** Tasks not overdue, reason `not_overdue`. Completed tasks, reason `task_complete`. Rungs already fired for the current due date, reason `rung_already_fired`. Tasks on clients marked `engagement_paused`, reason `engagement_paused`.

**Writes.** Escalation records, notifications, and the `at_risk` flag on the engagement. Proposes only. No ledger effect and no task reassignment.

**Logs.** Task id, days overdue, rung fired, recipient, prior rung history, and any due date reset with both dates.

**Reverses.** Escalation records are append only and are never deleted. Reversal is not offered. The `at_risk` flag is cleared by task completion, not by a reversal.

**Blocked by.** No escalation ladder configured, which completes with zero acted.

**Test assertions.**
- A task 1 day overdue fires exactly one notification, to the assignee.
- Running daily for 10 consecutive days on the same task fires exactly 4 notifications, one per rung.
- Changing the due date resets the ladder and the reset is logged with both dates.
- An out of office assignee causes the lead rung to fire first.
- A blocked task notifies the predecessor owner, not its own assignee.
- No execution reassigns a task.

---

### PRAC-NUDGE-REQUESTS, Nudge outstanding client requests

**Fires from.** `/requests`, the nudge control, and on schedule daily.

**Purpose.** Send scheduled reminders on open client document requests using each request's escalation age, and stop when a person takes over.

**Scope options.** All active clients or a single client, an as of date, and an optional request type filter.

**Inputs read.** Open client requests with creation date and escalation age, the suspense reason code behind each request where one exists, prior nudge history, client communication preferences and quiet hours, and portal message threads.

**Deterministic rule.**
1. Age in days equals the as of date minus the request creation date.
2. Nudge schedule, relative to the request's escalation age E taken from Part 4 of the conventions for suspense generated requests or from the catalog otherwise: first nudge at the integer floor of E divided by 2 days, second nudge at E days, third nudge at E plus 7 days, then a stop. After the third nudge the request escalates to the engagement lead as a call task, because a fourth automated message is noise.
3. Maximum one nudge message per client per day across all requests. Requests due to nudge on the same day are batched into one message listing each item, ordered by age descending then request id ascending. This is a hard cap.
4. No nudge is sent when the client has replied on the request thread within the last 2 days, reason `recent_client_reply`, because a reminder on top of a reply damages the relationship.
5. Quiet hours and client preferred day settings shift a nudge to the next permitted day. The shift is a stored setting, never inferred from behavior.
6. Iteration order is client name ascending, then request age descending, then request id ascending.

**Deliberately skips.** Satisfied requests, reason `request_satisfied`. Waived requests, reason `explicitly_waived`. Requests already at the third nudge, reason `nudge_schedule_exhausted`. Firm owned items, reason `firm_owned_not_client_facing`. `SUS-12` items, reason `system_owned_self_clearing`. Clients with nudges paused, reason `nudges_paused`.

**Writes.** Portal messages, nudge history records, and a call task after the third nudge. Proposes only. No ledger effect.

**Logs.** Client, requests included in the batched message, nudge number per request, the escalation age used, any suppression with its reason, and the message id.

**Reverses.** Nudge history is append only. Sent messages are never deleted. A message may be superseded by a later message in the thread.

**Blocked by.** Portal access not configured. Client communication preferences missing, which defaults to the standard schedule and logs the default.

**Test assertions.**
- A request with an escalation age of 10 days nudges on day 5, day 10, and day 17, and never again.
- Five requests due on the same day for one client produce exactly one message listing five items.
- A client reply yesterday suppresses today's nudge on that request.
- Zero nudges are sent for firm owned suspense items or for `SUS-12`.
- After the third nudge a call task exists for the engagement lead and no fourth message is sent.
- Gate G17 drill down and the nudge target list agree on the same fixture.

---

## Part F. CI fixture requirements

The following assertions are global and apply to every run in this document. A fixture suite that does not enforce them is incomplete.

1. **Determinism.** Every run executes twice against a frozen fixture. Outputs are compared field by field, excluding only `run_execution_id`, timestamps, and actor. Any other difference fails the build.
2. **Idempotence.** Every run executes twice in `apply` mode against the same fixture. The second execution acts on zero records and the ledger balance is unchanged.
3. **Balance.** After every posting run, the trial balance nets to exactly zero and every individual journal entry sums to exactly zero.
4. **Integer cents.** A static check rejects any float literal, float cast, or division producing a non integer in the run modules. This is already enforced by the CI rule in Part 1 of the conventions and it extends to every run here.
5. **Locked period.** Every run is executed with a scope that includes a locked period. Each must return zero writes into that period and a log line naming the block.
6. **Manual override.** Every coding run is executed against a fixture where every candidate row carries the manual override flag. Each must act on zero rows.
7. **Propose versus post.** Every run in the propose only list in Part D is executed in `apply` mode against a fixture designed to trigger it. Each must produce zero posted journal entries. A run that posts when Part D says it may not is a build failure, not a warning.
8. **Suspense coverage.** After the full coding pipeline over any fixture, zero transactions in scope have a null category, and every 1990 line carries a code in SUS-01 to SUS-20 with an owner and an escalation date.
9. **Reversal.** Every run with a shape R3 reversal is run and then reversed. Every affected account returns to its pre run balance to the cent, and zero original entries are deleted or modified.
10. **No AI surface.** A repository scan asserts that no run module imports a model client, no run output field is named `confidence`, `score`, `probability`, `likelihood`, or `prediction`, and no matching function computes a string distance. This test exists to keep the determinism contract enforceable rather than aspirational.
11. **Explainability.** Every written value produced by a run has a non empty reason string in the log, and every reason string resolves to a stored template plus merge fields, never to free text assembled at run time.

---

## Part G. Run index

| Module | Runs |
|---|---|
| Intake and setup | `INTAKE-BUILD-CHART`, `INTAKE-SEED-TASKS`, `INTAKE-OPEN-REQUESTS`, `SETUP-IMPORT-BALANCES` |
| Transactions and coding | `TXN-NORMALIZE-VENDORS`, `TXN-DETECT-DUPLICATES`, `TXN-PAIR-TRANSFERS`, `TXN-SPLIT-SETTLEMENTS`, `TXN-APPLY-RECURRING`, `TXN-APPLY-RULES`, `TXN-APPLY-VENDORDEFAULTS`, `TXN-MAP-BANKCODES`, `TXN-SWEEP-SUSPENSE` |
| Reconciliation | `REC-MATCH-TIERED`, `REC-CLEAR-MATCHED`, `REC-FLAG-STALE` |
| Recurring and period end | `PER-POST-RECURRING`, `PER-AMORTIZE-PREPAID`, `PER-SPLIT-LOANPAYMENT`, `PER-POST-ACCRUALS`, `PER-REVERSE-ACCRUALS`, `PER-POST-DEPRECIATION` |
| AR and AP | `ARAP-REFRESH-AGING`, `AR-BUILD-STATEMENTS`, `AR-APPLY-PAYMENTS`, `AR-CHARGE-LATEFEES`, `AP-APPLY-DISCOUNTS`, `AR-WRITEOFF-UNCOLLECTIBLE` |
| Substantiation | `SUB-TIEOUT-ACCOUNTS`, `SUB-RAISE-REQUESTS` |
| Close | `CLOSE-CHECK-GATES`, `CLOSE-LOCK-PERIOD`, `CLOSE-ROLL-FORWARD`, `CLOSE-POST-YEAREND` |
| Reporting | `RPT-BUILD-PACKAGE`, `RPT-FLAG-VARIANCES`, `RPT-REBUILD-FORECAST`, `RPT-COMPOSE-NARRATIVE`, `TAX-BUILD-1099`, `TAX-TRACK-W9` |
| Practice | `PRAC-GENERATE-TASKS`, `PRAC-ESCALATE-OVERDUE`, `PRAC-NUDGE-REQUESTS` |

Total: 43 runs.
