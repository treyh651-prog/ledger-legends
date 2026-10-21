# Run framework notes

Implementation notes for `server/runs`, the contract all 49 automation runs plug
into. Read `docs/03-run-framework.md` first. This file records where doc 03 was
ambiguous, what was chosen, and what the tests do and do not prove.

## Layout

| File | Lines | Purpose |
| --- | --- | --- |
| `contract.ts` | 330 | Run interface, proposal shapes, statuses, error codes |
| `tables.ts` | 236 | Row shapes for every table a run may read or write |
| `db.ts` | 206 | The narrow port: query, transaction, advisory lock, insert, update |
| `db-memory.ts` | 518 | In memory port used by the tests, guards included |
| `db-postgres.ts` | 440 | Postgres port written against the `pg` style API, not executed here |
| `ids.ts` | 167 | ULIDs, canonical json, scope hash, idempotency key |
| `dates.ts` | 87 | ISO day math, period lock lookup, reversal dating |
| `apply-writer.ts` | 192 | The only place a proposal becomes a row |
| `run-log.ts` | 332 | Intent row, item rows, terminal events |
| `execute.ts` | 803 | The single execute path for both modes |
| `undo.ts` | 328 | Reversal semantics and the undo run |
| `sequence.ts` | 156 | Ordered sequences, each child logged separately |
| `registry.ts` | 35 | Run type lookup |
| `index.ts` | 27 | Barrel |
| `runs/txn-pair-transfers.ts` | 444 | Reference run, proves the contract end to end |
| `__tests__/harness.ts` | 120 | Hand rolled harness in the style of `script/check-books.ts` |
| `__tests__/fixtures.ts` | 162 | Two firms, two clients each |
| `__tests__/index.ts` | 897 | 34 tests |

Run the tests with `npx tsx server/runs/__tests__/index.ts`. Typecheck with
`npx tsc --noEmit`. Both are green. No npm dependency was added and nothing
outside `server/runs/` was modified.

## The one property everything else rests on

`execute()` has one code path. Preview and apply resolve the same scope, call the
same `propose`, derive status the same way, and write the same log shape. The
only difference is the last step: preview throws a `RollbackSignal` carrying the
outcome so the transaction unwinds, apply calls `run.apply` and commits. There is
no second implementation of anything, which is why the test asserting that
preview and apply produce byte identical canonical json for proposals and skips
is not a coincidence, it is structural.

## Invariant coverage

Doc 03 Part 12 lists twelve invariants. Coverage against the in memory port:

| # | Invariant | Covered | Test |
| --- | --- | --- | --- |
| 1 | Entries balance | yes | every posted entry sums to zero, and `assertEntryShape` refuses an unbalanced set before any write |
| 2 | Trial balance foots | yes | the full set of lines nets zero, checked again after undo |
| 3 | Net zero posting | yes | 1920 nets zero per pair, reported `netCents` is zero |
| 4 | No orphan lines | yes | every line points at an entry that exists |
| 5 | Undo restores | yes | four tests: field writes revert, posted entries get mirror entries and are never deleted, locked period reversals redate to the first open day with SUS-20, and undo is refused when no open period exists |
| 6 | Idempotent apply | yes | a second apply of the same scope proposes nothing and posts nothing, a replayed apply either deduplicates or is refused as stale, plus a direct test that the key varies with type, version, firm, client, scope hash, and mode |
| 7 | Locked periods untouched | yes | both sides skipped, no entry, no field write, plus the store level period lock guard |
| 8 | Overrides untouched | yes | an overridden row is skipped and counted, its category is unchanged, and the store itself raises `OVERRIDE_PROTECTED_ROW` when a run tries anyway |
| 9 | Suspense terminates | partial | every member of an ambiguous transfer set ends as a SUS-04 item. The full claim, that no transaction can end a cascade with a null category, needs the whole coding pipeline including TXN-SWEEP-SUSPENSE, which is not implemented yet |
| 10 | Contra pairing | no | this is a depreciation property, and PER-POST-DEPRECIATION is not implemented. Nothing in the framework blocks it |
| 11 | Total partition | yes | five candidates across five different fates, every one accounted for exactly once |
| 12 | Cents only | yes | every stored and proposed amount is `bigint`, and the canonical encoder refuses a non integer number outright |

Also covered, beyond the table:

- The two tenant negative test. Two firms, two clients inside one firm, identical
  amounts, identical dates, identical normalized vendor strings. No cross firm or
  cross client pairing, no other tenant row touched, and firm B cannot read firm
  A's run log row through the port.
- Preview writes no ledger rows but does write its log row.
- Apply is refused when any error exists, and refused when no preview id is given.
- Eight terminal statuses, none of them partial.
- The run log refuses an update with `IMMUTABLE_LOG`.
- Provenance carries cascade level and run version on the item rows.
- A sequence writes one log row per child and one sequence row.
- The advisory lock is released when the transaction ends, and a second run of the
  same type and key is rejected rather than queued.
- The sweeper marks an orphaned started row abandoned.
- Transfer pairing specifics: the 3 day window is inclusive at 3 and excludes 4,
  same sign never pairs, unequal amounts never pair, two entries on the same
  account never pair, and a scope filtered to one account still searches every
  account of the client for a counterparty.

Not covered by a test:

- Invariant 10, contra pairing, as above.
- The third undo refusal, a later posted entry depending on the original. The code
  path exists and queries `journal_entries_referencing`, but constructing a
  dependent entry needs a second posting run that does not exist yet.
- Serialization retry under real concurrency. The in memory port raises
  `SerializationFailure` on a write write conflict and `execute` retries up to
  three attempts, but the test suite is single threaded so the retry loop is
  reached only by construction, not by a real race.
- Everything in `db-postgres.ts`. There is no Postgres in this sandbox, so it is
  correctness by inspection only.

## Where doc 03 was ambiguous and what was chosen

1. **Overridden rows are both excluded and reported.** Doc 03 says the scope
   predicate excludes rows carrying the manual override flag, and also requires a
   `manual_override` skip reason and a reported count, while the partition
   invariant requires candidates to equal proposals plus skips plus errors. Chosen:
   the candidate query excludes overridden rows from the working set, a separate
   ids only query collects them, they are added to `candidateIds` and to
   `FrozenScope.overriddenIds`, and they are emitted as `manual_override` skips.
   They are therefore counted and reported without ever being loaded on a write
   path. The store level guard is the backstop if a run ignores all of this.

2. **The idempotency key needs the scope hash, the intent row needs the key.**
   Chosen: resolve the scope first in a read only transaction, compute the key,
   write the intent row, then resolve again inside the locked main transaction and
   compare the two hashes. A mismatch means the world moved between freezing and
   locking. In apply that is `STALE_PREVIEW`, in preview it is `SCOPE_DRIFT`, and
   the status is `refused` either way.

3. **Status for a preview whose proposal set contains errors.** Doc 03 defines
   refusal in terms of apply. Chosen: `refused` in both modes, so status
   derivation is genuinely identical across modes and the operator sees the signal
   at preview time rather than after clicking apply.

4. **Actor kind inside the session.** A run triggered by a person is still
   automation. The session actor kind is therefore never `human`, only `run`,
   `schedule`, or `sequence`. If a run could present itself as human the override
   guard and the rule that only a human clears an override would both be
   meaningless.

5. **A deduplicated execution writes no new run log row.** The unique idempotency
   key on `run_log` for mode apply would reject it. The original execution id is
   returned on the outcome as `deduplicatedFrom`.

6. **The pair link is a field write, not a table insert.** Mutual
   `transactions.pairedWithId` writes rather than a `transfer_pairs` insert, so the
   proposal set stays the only channel to the database and undo stays mechanical.
   `transfer_pairs` is still read, because a manually confirmed link there must
   block re pairing.

7. **Ambiguous transfers are proposals, not skips.** A SUS-04 routing is work the
   run performs, so it belongs in proposals. This also keeps the partition honest
   and satisfies the doc 02 assertion that an ambiguous set of three produces
   three SUS-04 items.

8. **`ApplySink` was added to `RunContext`.** Doc 03 Part 9 wants the created
   journal entry id on each log item, while `apply` returns void. The sink is
   where apply records what it wrote so the log can name it.

9. **`Run.type` widened to `AnyRunTypeId`.** So an undo run can carry the type
   `<ORIGINAL>-UNDO` without a second interface.

10. **The reversal horizon.** Doc 03 refuses undo when there is no open period
    after the locked one, but in this model the absence of a lock is what makes a
    day open, so a lock running to 2099 would technically hand back an open day in
    2100. Chosen: a reversal must land within 366 days of the original date or the
    undo is refused with `UNDO_NO_OPEN_PERIOD`. A reversal that cannot land within
    a year is a decision for a person.

11. **A second undo of the same run.** The undo run's scope includes the count of
    prior `undone_by` events, so a second attempt gets a different key rather than
    deduplicating into the first, runs `propose`, and is refused with
    `UNDO_ALREADY_DONE`. The operator sees a refusal with a reason instead of a
    silent replay of an old success.

12. **A SUS-04 item is not withdrawn by undo.** Undoing a pairing run reverses the
    ledger effect and the field writes. It does not withdraw suspense items,
    because the ambiguity the item records really happened and a person still has
    to decide it.

13. **Apply called with no preview id.** Returns a `refused` outcome rather than
    throwing, and writes no log row, because nothing was ever frozen or locked. It
    is caller misuse, not a run that failed.

14. **Row versions.** The in memory port bumps a row's `version` field on update,
    mirroring what a Postgres trigger does. This is what makes a stale preview
    detectable after a prior apply changed the same rows.

## The register and the import pipeline, migration 0011 and module 3

Doc 04 never defined the bank transaction register, so its columns were derived
from what the runs actually need: what IMPORT-COMMIT-BATCH writes, what the nine
module 2 coding runs read and write, what REC-MATCH-TIERED matches against, and
what the coding cascade provenance requires. Each of the decisions below is a
place where the docs left a real choice open. Three options were written down,
one was picked, and the reason is recorded.

Migration 0011 shipped the register and the import pipeline. It did not ship the
bank side, so module 3 needed `db/migrations/0012_reconciliation.sql`. That
migration adds `ledger.rec_batches` and `ledger.statement_lines`, and adds
`statement_id`, `statement_line_id`, `statement_date`, `match_tier`,
`match_confidence`, `rec_batch_id`, `stale_owner` and `stale_escalates_on` to
`ledger.transactions`. It does not add a `cleared_flag`, because 0011 already has
`cleared` and `cleared_date`, which decision 42 explains. Both new tables get RLS
enabled and forced with the same `client_isolation` policy the rest of the schema
uses, and the same discriminator freeze trigger, so a reconciliation row cannot
be moved to another tenant any more than a transaction can. The batch index the
brief asks for is `rec_batches_id`.

15. **The dedup grain on the bank supplied id.** Options: key it on
    `(client_id, account_number, bank_transaction_id)` matching what migration
    0009 did on staged rows, key it on
    `(client_id, bank_account_id, bank_transaction_id)`, or make the id globally
    unique. Chosen: the bank account grain. Two feeds can post to the same four
    digit cash account, and a bank supplied id is only unique inside the account
    that issued it, so the account number grain would create false duplicates
    across two real accounts and the global grain would collide between banks.
    Migration 0011 also adds `bank_account_id` to `import.batches` and
    `import.staged_rows` so the staging side can key the same way.

16. **Foreign currency in the register.** Options: reject a non USD row at
    import, allow any currency freely, or allow it only while it is routed to
    suspense. Chosen: `check (currency = 'USD' or suspense_reason = 'SUS-11')`.
    Doc 00 sends foreign currency to SUS-11 for a person to handle rather than
    dropping the row, and a free currency column would quietly let a mixed
    currency total foot to a number that means nothing.

17. **Batch reversal representation.** Options: delete the register rows,
    post a mirror register row, or carry a status column. Chosen:
    `status in ('active','reversed')` plus `reversed_by_run_id` and
    `reversed_at`. Nothing is deleted, so the audit trail of what the bank said
    survives, and every partial index the coding runs select on carries
    `status = 'active'`, so a reversed row stops being a candidate without any
    run having to remember to filter it.

18. **The missing bank account table.** Options: leave the register unlinked to
    a funding source, point it at `ledger.accounts` only, or model
    `ledger.bank_accounts` in this migration. Chosen: model it. The register
    cannot carry a foreign key to a table that does not exist, the TypeScript
    port already assumed a `bank_accounts` table, and reconciliation needs the
    per account amount tolerance and the processor destination flag to live
    somewhere.

19. **How a run proposes a row that does not exist yet.** Options: extend the
    proposal union with a `row_insert` shape, make `writeField` upsert, or let
    the import runs write outside the proposal set. Chosen: the fourth proposal
    shape. Doc 03 makes the proposal set the only channel between propose and
    apply, and both alternatives punch a hole in that: an upsert hides a create
    inside an update, and a direct write means preview cannot show what apply
    would do.

20. **Ids for rows that do not exist yet.** Options: call `ulid()` in propose,
    have apply assign the ids, or derive them. Chosen: derive them.
    `ids.derivedId(seed, kind, ordinal)` hashes the seed and encodes the
    ordinal, so a staged row id is a pure function of the batch id and the row
    number. `ulid()` carries randomness, and apply re-derives its proposals and
    compares them against the preview byte for byte, so random ids would make
    every apply refuse itself as stale.

21. **The execution id and the clock inside a proposal.** Same defect, found the
    same way: `parsed_run_id`, `committed_run_id`, `committed_at` and
    `created_at` differ between the preview and the apply, so stamping them in
    propose made apply refuse itself. Options: drop the columns from the
    proposal and lose the provenance, exempt named fields from the parity
    comparison, or substitute them at write time. Chosen: substitution.
    `apply-writer` exports `RUN_ID_PLACEHOLDER` and `NOW_PLACEHOLDER`, a run
    writes the placeholder, and the writer swaps in the real values. The
    proposal set stays deterministic and the row still records who wrote it and
    when. Exempting fields from the comparison was rejected because it weakens
    the one check that makes a reviewed preview mean anything.

22. **XLSX.** Options: add a spreadsheet dependency, unzip and read the sheet
    XML inside the run, or take the cells as a grid the upload boundary already
    flattened. Chosen: the grid. No new npm dependency is allowed, and a
    workbook reader written inside a run would be a second parser to trust for
    no gain, since the mapping profile logic is identical once the cells are
    rows and columns.

23. **CAMT.053.** Options: write a partial XML reader now, silently fall back to
    the CSV path, or refuse with a named code. Chosen: refuse with
    `FORMAT_NOT_IMPLEMENTED`. Doc 05 accepts the format, so the enum keeps it,
    but a half parser that guesses at an ISO 20022 document is worse than an
    honest refusal, and the fallback would run a bank statement through the
    wrong reader.

24. **A PDF that arrives named as something else.** Doc 05 is absolute that
    there is no PDF parser and there will not be one. Options: trust the format
    argument, check the file name, or check the bytes. Chosen: the bytes. The
    parser refuses any payload beginning with `%PDF` with
    `PDF_NOT_SUPPORTED`, because a renamed file is the only way this rule gets
    tested in practice.

25. **A row the parser could not read.** Options: drop it, fail the whole file,
    or stage it with an error code. Chosen: stage it with an error code and
    count it as rejected. The batch counts have to add up to the file, and an
    operator needs to see the four rows that failed rather than wonder why the
    file had 96 rows and the batch has 92. A zero amount is treated the same
    way, which mirrors the `txn_amount_nonzero` constraint in the register.

26. **Whether IMPORT-COMMIT-BATCH posts a journal entry.** Doc 05 answers
    "posts: yes" for this run, which reads two ways. Options: post a cash entry
    per row now, post nothing and set `writes_ledger` false, or write ledger
    data and post no entry. Chosen: the third. A register row is ledger data, so
    the run takes the ledger isolation level and requires an open period, but an
    uncoded transaction has no second side yet, so there is no balanced entry to
    post. The coding cascade posts it later and links back through
    `journal_entry_id`.

27. **Undoing a parse.** Options: delete the staged rows, leave the batch
    untouched, or close the batch. Chosen: close the batch. The undo marks it
    `rejected` with reason `parse_undone`, which takes it out of every commit
    path. The staged rows are evidence of what the file said and are inert once
    the batch is closed, so deleting them would destroy the record of a rejected
    duplicate for no benefit.

28. **A reconciled row inside a batch being reversed.** Doc 05 says a batch is
    reversible as a unit until any row in it is reconciled, and doc 03 says
    partial undo does not exist. Options: reverse the unreconciled rows, unclear
    the reconciled row and reverse everything, or block the whole reversal.
    Chosen: block it, through `BatchReversalBlocked`, which the framework turns
    into a `failed` outcome naming the reconciled rows. A person unreconciles
    first. The two alternatives either invent partial undo or silently undo a
    reconciliation somebody signed off on.

## The module 2 coding cascade, the nine runs

The nine runs of doc 02 Module 2 turn a raw bank descriptor into a coded row.
The cascade is ten levels deep, every level is weaker evidence than the one above
it, and the order the runs execute in is the reason each one can trust what the
previous one wrote. `CODING_CASCADE_ORDER` in `registry.ts` is the machine
readable form of that order and `server/runs/__tests__/coding-pipeline.ts` walks
it, so the ordering is a test rather than a comment.

Two rules hold across all nine. First, cascade provenance. Every run writes the
level that decided the row plus the identifier and version of the thing that
decided it, so the question of why a transaction was coded a particular way has
an answer six months later without a person reconstructing anything. Second, the
override contract of invariant 8. No run touches a row carrying the manual
override flag. The candidate query is asked with `includeOverridden: false`, the
frozen scope still lists the overridden ids so they are counted and reported, and
`apply-writer.ts` refuses the write a second time at the store level. A run that
forgets the first check still cannot get past the second.

29. **Whether the coding runs share a module or repeat themselves.** Nine files
    each needing the level table, the SUS catalog, the scope schema, the sign
    convention, and the same override and lock guards. Options: repeat the code
    in each run, put the shared pieces in `contract.ts`, or add one module beside
    the runs. Chosen: `runs/coding-cascade.ts`. Repeating it means nine copies of
    the level numbers to keep in step, and `contract.ts` is the framework and
    should not know what a vendor is. A module beside the runs keeps the cascade
    rules in one readable place and keeps the framework generic.

30. **Where the reason code catalog lives.** Options: read the twenty codes from
    the database, derive them from doc 00 at build time, or state them in code.
    Chosen: state them in code, in `SUS_CATALOG`, with the owner and escalation
    age from doc 00 Part 5 beside each one. The escalation age is arithmetic the
    sweep has to do while it is deciding, a database read would make the reason
    code decision depend on seed data being present, and a row that reaches the
    floor of the cascade with no reason code is exactly the outcome the design
    forbids. The register constraint `txn_suspense_complete` is the backstop.

31. **What normalization does with a descriptor that normalizes to nothing.** A
    descriptor of nothing but a terminal number, `POS 004471`, reduces to the
    empty string at step 5. Options: store the empty string, leave the column
    null, or keep the step 3 text and flag the row. Chosen: keep the step 3 text
    and set `normalization_degraded`. An empty key makes every such row look like
    a duplicate of every other such row, which is worse than a noisy key, and a
    null would stop duplicate detection and rules from ever seeing the row again
    with no record of why.

32. **How duplicate detection treats a row that has not been normalized.** The
    key is the bank account, the absolute amount, and the normalized vendor.
    Options: fall back to the raw descriptor, treat a null vendor as an empty
    string, or skip the row. Chosen: skip it with `missing_prerequisite`. This
    one was found by a test rather than by reading. Treating null as the empty
    string made two unrelated unnormalized rows collide on the same key, which is
    a false duplicate flag on real money. Skipping makes the dependency on step 1
    explicit and the skip tells an operator what to run.

33. **Which copy of a duplicate is the loser.** Options: the row with the later
    posted date, the row imported later, or the row with the higher id. Chosen:
    the earliest posted date is the original and every later copy carries
    `duplicate_of_transaction_id` pointing back at it, ties inside a day breaking
    on the id. The bank saw the earlier one first, the constraint
    `txn_duplicate_has_original` needs the pointer to resolve, and a rule based
    on import order would give different answers on a reimport.

34. **The tolerance on a settlement split.** A net deposit has to reconcile to
    gross plus fees. Options: allow a small cent tolerance, plug the difference
    to a rounding account, or require exact equality. Chosen: exact equality, and
    anything else routes SUS-17 with the two amounts named. A tolerance is a
    silent revenue misstatement inside the tolerance and a plug line is the same
    thing with a name on it. Doc 02 gives the fee and the gross from the
    processor report, so exact is achievable and any gap is a real question.

35. **Rounding a percentage split.** Basis points that sum to 10000 still do not
    divide a cent evenly. Options: round each line and let the total drift, put
    the drift on the first line, or allocate by largest remainder. Chosen:
    largest remainder with ties going to the highest line number. It is the only
    one of the three that always sums to the whole amount, which is what keeps
    the entry balanced, and fixing the tie to the last line makes a rerun produce
    the same cents rather than merely the same total.

36. **What a rule conflict does.** Two rules survive the tie break of doc 00 Part
    3 with different target categories. Options: take the lower rule id, take the
    most recently updated rule, or refuse. Chosen: refuse, apply nothing, and
    route SUS-19 naming every surviving rule id. The tie break exists to produce
    a winner from priority, condition count, and id, so two survivors with
    different answers means the rules themselves disagree. Guessing hides the
    defect in the rule set, which is the thing that actually needs fixing. A tie
    on the same category is not a conflict and is applied, with a benign tie
    logged.

37. **Whether the later steps may overwrite an earlier decision on a rerun.** A
    row coded at level 7 and then run through the rule step again. Options: let
    the stronger level win and rewrite, refuse to touch the row, or refuse only
    inside a sequence. Chosen: every run stands down on any row already resolved
    at a level above its own and records `already_resolved_level_N`. Rewriting a
    coding a person has already seen is churn with no audit trail beyond two runs
    disagreeing, and the documented order means the case only arises when
    somebody ran the steps out of order. The vendor default ordering test shows
    exactly that churn, which is why the order is the fix rather than the rewrite.

38. **Where the foreign currency check belongs.** Doc 00 Part 1 puts any non
    functional currency row in suspense with SUS-11, and the register constraint
    `txn_currency_scope` allows no other outcome. Options: filter those rows out
    of the candidate query, route SUS-11 from whichever run sees the row first, or
    have every coding step stand down and let the sweep do it. Chosen: the third.
    Filtering hides the rows from the reports that count candidates, and routing
    from several runs would put the same reason code in four places. Levels 5
    through 8 skip with `out_of_scope_engagement` naming SUS-11, and the sweep is
    the single place the code is issued. This was found by the pipeline test,
    where a euro charge with a matching rule was being coded at level 6.

39. **Whether the sweep posts a row that sits in a locked period.** Options: post
    it into the locked period, redate it to the first open day, or leave it. This
    run writes to the ledger, so posting into a closed period is not available.
    Chosen: leave it, with a `locked_period` skip that names SUS-20 as what is
    waiting. Redating a suspense posting moves an unexplained amount into a
    period it did not happen in, and the framework already has a redate path for
    the runs where doc 02 asks for one. This one is not asked for.

40. **Whether the sweep opens a portal request every time it runs.** Options:
    always insert, never insert, or insert once per open question. Chosen: insert
    once per transaction and reason code, and only when the catalog says the
    client owns the code. Asking the same question twice is how a portal stops
    being read, and firm owned codes such as SUS-01 are the firm's own work and
    should never appear in front of a client. The existing open requests are read
    first and the key is the transaction id with the reason code.

41. **How the sweep chooses between its own reason and one an earlier step
    raised.** A row can arrive at the floor already carrying a SUS-05 from
    duplicate detection or a SUS-19 from the rule step. Options: recompute the
    reason from the row, keep the earliest code, or keep the most severe code.
    Chosen: keep the earliest code, breaking ties on the lowest code string. The
    earlier step had more context than the sweep does, the sweep would recompute
    a generic SUS-01 and lose the real reason, and severity is not a field any
    document defines. The tie break on the code string is there so a rerun
    produces the same reason rather than whichever row came back first.

## The module 3 reconciliation runs

Three runs turn a bank statement into a signed off difference. `REC-MATCH-TIERED`
proposes the matches, `REC-CLEAR-MATCHED` records what cleared and computes the
difference, `REC-FLAG-STALE` chases what never cleared. `RECONCILIATION_ORDER` in
`registry.ts` states the order and `server/runs/__tests__/rec-pipeline.ts` walks
it, so the order is a test and not a comment.

Doc 00 gate G03 is the whole reason these exist: every bank and card account
reconciled through period end with a zero difference. The runs are built so the
difference is always produced and always visible, including when it is large.
A batch that cannot reconcile still closes, with the number on the batch row and
a state of `out_of_balance`. Hiding a difference is worse than reporting one.

### The override contract in module 3

Invariant 8 says no run changes the coding of a row carrying the manual override
flag. Module 3 splits that into two halves, because reconciliation writes facts
that are not coding.

Matching and clearing include overridden rows. Whether the bank showed a
transaction is the bank's statement about the world, not an opinion about how the
row should be classified, and an operating account cannot reconcile if the rows a
person touched by hand are invisible to it. So `REC-MATCH-TIERED` and
`REC-CLEAR-MATCHED` ask for candidates with `includeOverridden: true`, and the
only fields they write on the register are `statement_id`, `statement_line_id`,
`statement_date`, `match_tier`, `match_confidence`, `rec_batch_id`, `cleared`,
and `cleared_date`. None of those is a coding field, none of them is in
`OVERRIDE_WATCHED_FIELDS`, and the store level guard in `apply-writer.ts` still
refuses anything that is. The overridden rows are counted in `overriddenInScope`
on every run so the report shows them rather than swallowing them.

`REC-FLAG-STALE` skips them instead, with a `manual_override` skip. Flagging is
not a fact the bank supplied. It assigns an owner and starts a thirty day
escalation clock, which is a judgment about the row, and the person who set the
override already owns it.

The tests that hold this line are `rec match, an overridden row is matched and
never recoded`, `rec clear, an overridden row clears and is never recoded`,
`rec stale, an overridden row is skipped and never recoded`, and
`rec pipeline, the override row is matched, cleared, and never recoded`. Three of
them walk every proposal the run produced and assert no coding field name appears
in any of them, so the guarantee is about the proposal set and not about the
particular rows in the fixture.

42. **Whether to add `cleared_flag` as the brief names it.** Migration 0011
    already ships `transactions.cleared` and `transactions.cleared_date`, and
    doc 04 documents `cleared` as the register's own field. Options: add
    `cleared_flag` and leave `cleared` unused, add it and keep the two in step
    with a trigger, rename `cleared` to `cleared_flag`, or use `cleared`.
    Chosen: use `cleared`. Two columns for one fact is how a book ends up with
    two answers to whether a check cashed, a trigger is a moving part guarding a
    problem that need not exist, and a rename would break the import pipeline and
    the check-books script for a word. The brief's `cleared_flag` and the
    schema's `cleared` are the same field and 0012 adds no second one.

43. **Where statement lines live.** A statement is a list of lines from the bank,
    and none of them is a book entry. Options: import them as register rows with
    a marker, hold them only in the import staging table, or give them their own
    table. Chosen: `ledger.statement_lines` in migration 0012. Register rows are
    the client's books and putting the bank's rows in there means every report,
    every total, and every gate has to remember to filter them out, which is a
    filter somebody eventually forgets. Staging is cleared on commit and the match
    state has to outlive the import. Its own table also gives the match fields
    somewhere honest to live: `match_tier`, `match_confidence`, `match_diff_cents`
    and `matched_transaction_count` describe the line, not the book row.

44. **What `match_confidence` means.** Options: a computed score from date
    distance and amount distance and vendor similarity, a per tier constant, or a
    free number each tier picks. Chosen: a per tier constant, `CONFIDENCE` in
    `rec-shared.ts`, at 100, 90, 80 and 70. Doc 02 Part A invariant 3 wants a run
    to be reproducible from its inputs, and a similarity score is exactly the kind
    of number that drifts when the scoring function is tuned, changing what a
    person sees on a batch they already reviewed. A constant per tier says the
    only thing the confidence is really claiming, which is which rule fired.
    `match_diff_cents` carries the one piece of real measurement, the cents the
    match absorbed.

45. **The tier 2 window.** The brief says five days, doc 02 module 3 says three,
    and `txn-pair-transfers` uses three for transfer pairing. Options: three,
    five, or a scope option. Chosen: a scope option, `windowDays`, defaulting to
    five as the brief asks. A firm with weekend heavy card settlement needs more
    than three and a firm with clean ACH wants fewer false candidates, so the
    number is a policy and not a constant. The default follows the brief because
    the brief is the newer instruction. The test `rec match, the window is
    inclusive and one day past it is no match` pins the boundary in both
    directions so a later change to the default cannot quietly widen it.

46. **What makes the tier 3 cent tolerance safe.** A tolerance on amount alone
    matches unrelated money. Options: tolerance alone, tolerance plus a vendor
    match, tolerance plus a vendor match plus a tighter window, or no tier 3.
    Chosen: tolerance plus a required normalized vendor equality, with the
    tolerance defaulting to one cent and capped at one hundred by
    `MAX_TOLERANCE_CENTS`. Two payments to two different vendors one cent apart
    are common in any month with volume, and matching them is a silent error that
    reconciles to zero while being wrong. Requiring the vendor makes the tolerance
    an answer to rounding and card processor fees, which is the case it exists
    for. The cap stops a scope from turning tier 3 into a dollar wide net. The
    exact absorbed difference is written to `match_diff_cents` so the cent is
    posted rather than lost, which is what the pipeline test asserts.

47. **How tier 4 chooses among possible groups.** A deposit of 750.00 against a
    pool of open invoices can have several subsets that sum to it. Options: take
    the first group found, take the smallest, take the one closest in date, or
    refuse when there is more than one. Chosen: consider groups of two to four
    same sign rows inside the window, prefer the smallest qualifying group, and
    when more than one distinct group of that size sums to the line, write
    nothing and report `ambiguous_candidate`. Guessing between two explanations
    of the same deposit is how a receivable gets closed against the wrong
    customer, and that error is invisible until the customer calls. The pool is
    capped at `DEFAULT_CANDIDATE_POOL_CAP` of twelve rows because subset search
    grows fast and a run that hangs on a busy account is its own outage. Over the
    cap the run reports `candidate_pool_over_cap` and leaves the line for a
    person.

48. **Which tiers clear without a person.** Options: clear every tier, clear none
    until accepted, or split by tier. Chosen: split. Tier 1 is an exact amount on
    the exact date, which is identity rather than inference, so it is written with
    `match_confirmed` true and clears on its own. Tiers 2 through 4 are proposals
    and clear only after a person accepts them, which is the state the reconcile
    screen writes. `REC-CLEAR-MATCHED` skips an unaccepted match and names
    `match_not_confirmed` in the detail. The scope option `clearUnconfirmed`
    exists for a firm that wants the older behavior, defaulting off. Auto clearing
    an inferred match is how a difference of zero stops meaning anything.

49. **Where the stale flag is written.** Options: write SUS-18 into
    `transactions.suspense_reason` the way the coding cascade does, add dedicated
    stale columns, or track the whole thing in `suspense_items` alone. Chosen:
    dedicated columns, `stale_flagged`, `stale_flagged_on`, `stale_owner`,
    `stale_escalates_on` and `escheat_review`, plus a SUS-18 item and one portal
    request. `suspense_reason` is a coding column, it is watched by the override
    guard, and writing it would overwrite whatever coding question the row was
    already carrying: a stale check is not a miscoded check. Items alone would
    give the run no cheap way to ask whether it already flagged a row, which is
    what makes a daily run idempotent.

50. **The stale threshold.** The brief says sixty days by default, doc 02 gives
    per instrument ages. Options: sixty flat, per instrument, or per instrument
    with an override. Chosen: per instrument with an explicit override.
    `STALE_THRESHOLD_DAYS` holds ninety for an issued check, thirty for an
    electronic item, ten for a deposit and sixty for anything else, which is the
    brief's number as the default bucket. A deposit that has not appeared in two
    weeks is a real problem and a check outstanding for two months is normal, so
    one flat number is either noisy or blind. A scope `thresholdDays` overrides
    all four for the firm that wants the simple rule. At `ESCHEAT_REVIEW_DAYS` of
    one hundred and eighty the run also sets `escheat_review`, because past that
    age the question stops being a bank question and becomes an unclaimed property
    question. Nothing is filed, the column only says look.

51. **What the difference is and when a batch reconciles.** Options: statement
    balance minus cleared ledger balance, the reverse, or absolute value. Chosen:
    statement minus cleared, so a positive difference means the bank shows more
    money than the cleared books do, matching how a difference is read on a paper
    reconciliation. Zero is `reconciled`, anything else is `out_of_balance`, and
    both states close the batch with `closed_at` set. The cleared ledger balance
    counts every cleared row on the account through period end and not only the
    rows this batch cleared, because a balance is cumulative and last month's
    cleared check is still cleared.

52. **The batch lifecycle across two runs.** Options: open the batch in a third
    run, open it on import, or open it in matching and close it in clearing.
    Chosen: the third. Matching inserts the batch at `derivedId(statementId,
    "rec-batch", 0)`, so a rerun finds it rather than opening a second one, and
    clearing writes the balances, the difference, the state and `closed_at`. A
    separate opener would be a run that does nothing a person can see, and opening
    on import would leave a batch standing for a statement nobody reconciled.
    `REC-CLEAR-MATCHED` refuses with `REC_NO_OPEN_BATCH` when matching never ran
    and with `REC_BATCH_ALREADY_CLOSED` when the difference was already signed
    off, because a closed difference is history and rewriting it silently changes
    a number somebody already approved.

53. **A framework change: `provenance.cascadeLevel` is now `number | null`.**
    Every proposal carries provenance, and until now the cascade level was a
    required number. A reconciliation write belongs to no cascade level: the
    cascade is about how a row was coded, and matching a statement line is not
    coding. Options: write a sentinel such as zero or ninety nine, invent a level
    ten for reconciliation, add a separate provenance shape, or widen the field to
    nullable. Chosen: widen it. A sentinel would show up in the level distribution
    reports as coding activity that never happened, an invented level would put
    reconciliation inside a ladder it is not part of, and a second provenance
    shape doubles the surface every consumer has to handle. The run log column was
    already nullable, so the change lines the TypeScript type up with the schema
    rather than against it. All ninety six existing framework tests pass unchanged
    after it.

## Module 4, period end

54. **A defect in the framework, found by the second month.** `scopeHashFor`
    hashed the candidate ids and their versions and nothing else. Every period
    end run takes a scope of client plus period, and in January and February a
    client usually has the same twelve rows at the same versions, so February
    hashed to the same scope as January, the execution log said the work was
    already applied, and the run posted nothing. Options: leave the hash alone
    and give every run its own dedupe query, hash the whole scope object, add
    the period as a named optional field, put the period in the derived entry id
    only, or make the period part of the candidate id list. Chosen: an optional
    `period` on `scopeHashFor`, spread into the hashed object only when it is
    defined. Hashing the whole scope would change every existing hash and break
    the idempotence of the modules already shipped. Per run dedupe queries move
    a framework invariant into six places where it can rot separately. The
    derived entry id already carries the period, so the entries were unique, but
    the execution log short circuited before it ever reached them, which is the
    worse failure because it reports success. The named field leaves every
    pre-existing hash byte identical, which the ninety six framework tests
    confirm.

55. **Run type ids do not match their filenames in two places.**
    `per-amortize-prepaids.ts` declares `PER-AMORTIZE-PREPAID` and
    `per-split-loan.ts` declares `PER-SPLIT-LOANPAYMENT`. Options: rename the
    files to match the type ids, rename the type ids to match the files, keep
    the spec's type ids and the task's filenames, or add an alias table.
    Chosen: keep both as given. The type id is written into every row in the
    execution log and every journal entry's `runType`, so it is data and
    renaming it orphans history. The filename is what the task asked for and is
    only a path. An alias table is a second source of truth for a string. The
    registry is the one place both appear, so the mismatch is visible where it
    matters and nowhere else.

56. **Accruals: the spec proposes drafts, the task says post.** Doc 02 describes
    `PER-POST-ACCRUALS` producing draft entries for review. The task says post
    them. Options: post, draft, post only when the template is marked trusted,
    or draft with an auto approve flag on the scope. Chosen: post. A draft
    accrual that nobody approves leaves the period understated, which is the
    failure the run exists to prevent, and the accrual is reversed on the first
    of the next period anyway, so a wrong accrual costs one month of a wrong
    number and not a permanent one. The template is the review: a person wrote
    it, and `isActive` and `manualOverride` are the two switches that stop it.

57. **The half month convention and MACRS at the same time.** Options: apply the
    convention inside each method, apply it as a uniform pass over the monthly
    series after the method has run, ignore it for MACRS because the published
    tables already assume a half year convention, or refuse the combination.
    Chosen: a uniform last pass. The method decides how much of the base belongs
    to each month, and the convention decides how much of the first and last
    month the asset was actually in service, so they are two separate questions
    and folding one into the other means writing it three times. The pass halves
    the first month and appends the carried half as an extra trailing month, so
    the series always sums to the depreciable base exactly. Refusing the
    combination would leave a real asset with no schedule.

58. **Depreciation stops at the base, not at the formula.** Declining balance
    never reaches zero and MACRS tables are rounded, so the arithmetic and the
    ledger disagree in the last month by a few cents. Options: post the formula
    and let the asset go past the base, post the formula and post a correcting
    entry at disposal, cap the last month at what is left, or spread the rounding
    across the life. Chosen: cap the last month. Cost minus salvage is the whole
    of what can ever be written off, and an asset with negative book value is a
    number no one can explain. `evenSplit` carries the residual to the last
    month for the same reason.

59. **The loan split requires a cleared payment.** The spec matches a schedule
    row to a register row on amount and date. The task adds that an uncleared
    payment is skipped. Options: post on the schedule date regardless, post when
    a register row exists in any state, require cleared, or require cleared only
    for the cash line and accrue the rest. Chosen: require cleared, with the
    skip reason `missing_prerequisite` and the detail `payment_not_cleared`. The
    entry credits cash, and cash the bank has not confirmed is a payment that may
    still bounce or be reissued. The fourth option would post interest expense
    against a suspense account and then need a second run to clean it up, which
    is more moving parts for a payment that clears two days later anyway.

60. **What the split debits when the loan has both a current and a long term
    account.** Options: debit the long term account, debit the current portion,
    split the principal between them by the twelve month rule, or refuse when
    both are set. Chosen: the long term account, `principalAccountLt`. The
    current portion reclass is a period end presentation entry driven by the
    remaining schedule, not by one payment, so a run that splits one payment does
    not know the answer, and computing it here would produce twelve small
    reclasses a year instead of one. `principalAccountCp` stays for the reclass
    run that belongs to a later module.

61. **A bank amount that disagrees with the schedule goes to a person.** Options:
    plug the difference to interest expense, plug it to principal, prorate it,
    post the schedule and let the bank line stay unreconciled, or route to
    suspense and post nothing. Chosen: route to suspense with `SUS-14` and post
    nothing. A rate reset, an extra principal payment and a late fee all look
    identical at this level, and each one wants a different entry. Plugging to
    interest hides a principal payment and misstates the note balance for the
    rest of the term. A schedule row whose own components do not foot is the
    same class of problem and gets `SUS-17`, which is also the code used when the
    running balance column contradicts the split. In that last case the split
    still posts, because the components are internally consistent and only the
    memo column disagrees.

62. **Detecting an accrual that was already reversed.** Options: write
    `reversedByEntryId` back onto the original when the reversal posts, query for
    an entry whose `reversalOf` points at the original, keep a separate
    reversals table, or trust the execution log. Chosen: the query, through
    `journal_entries_referencing`. Writing back to a posted entry means a run
    mutating a row in a closed period, which invariant 6 exists to prevent, and
    the log is scoped to a run type and version so a reversal a person posted by
    hand would be invisible to it. The query sees every reversal however it got
    there, which is the point: the run's job is to make sure the accrual is gone,
    not to be the one that removed it.

63. **The prepaid allocation table when `deferral_lines` is empty.** Options:
    refuse until a schedule run has written the lines, compute the allocation in
    memory and post from it without persisting, compute it and propose the lines
    as row inserts, or write the lines in a separate run first. Chosen: compute
    and propose the inserts. The run then persists the same table it posted from,
    so the next month reads a stored line rather than recomputing a day weighted
    series that has to come out identical, and a person can see the whole
    remaining schedule. Refusing would make the run depend on a module that does
    not exist yet. Posting from memory without persisting means the answer is
    only ever as stable as the code that derived it.

64. **New entries in `OVERRIDE_WATCHED_FIELDS`, and why `status` is not one.**
    Options: watch every column these runs write, watch the posting columns
    only, watch the status columns too, or leave the list alone. Chosen: add the
    posting and balance columns, `postedEntryId`, `postedRunId`, `postedAt`,
    `matchedTransactionId`, `accumulatedAfterCents`, `nbvAfterCents`,
    `remainingAfterCents`, `linkedDocumentId` and `reversalEntryId`, and leave
    `status` out. Every status change these runs make travels with a posted entry
    id, so watching the posting columns already covers it, and `status` is also
    the column a person legitimately moves by hand when they close a loan or
    write off an asset. Watching it would turn a normal edit into an override
    conflict on a row nothing was going to touch again.

## Module 5, AR and AP

65. **The subledger tables did not exist, so 0014 creates them.** The task
    allowed for a migration that adds the missing policy columns to `customers`
    and `vendors`. There were no `customers` or `invoices` or `bills` tables at
    all: `subledger` held vendors, rules and a few coding artifacts, and nothing
    that carried an open balance. Options: build the runs against the existing
    journal tables and derive every balance from entry lines, add the five
    policy columns to `vendors` and treat vendors as the only party table, put
    the receivable and payable documents in a single polymorphic `documents`
    table, create one table per document kind, or wait and ask. Chosen: create
    one table per kind, thirteen of them, in `subledger`, with the same row
    level security, discriminator freeze and override guard triggers 0013 uses.
    Deriving balances from the ledger cannot express a remittance advice or a
    payment term, and a polymorphic table means every query filters on a kind
    column and every column is nullable for half its rows. Waiting was not an
    option that produced working code. The cost is a large migration, which is
    honest about the size of what was missing.

66. **Where the account numbers live.** Options: constants in the run files,
    columns on the client record, a row per client in a policy table, or on each
    document. Chosen: a policy table, `arap_policies`, with a resolved default
    when no row exists, plus `arAccount` on the invoice and `apAccount` and
    `expenseAccount` on the bill for the cases where one document really does
    post somewhere else. Constants cannot survive a second client with a
    different chart. Client columns would put ten accounts on a table that is
    about engagements. The policy row also carries the thresholds, the write off
    method and the statement message text, which all want to move together and
    all want a version so a run can freeze them into a scope hash.

67. **AR-REFRESH-AGING became ARAP-REFRESH-AGING and covers both sides.** The
    task names the file `ar-refresh-aging.ts` and doc 02 names the run type
    `ARAP-REFRESH-AGING`. Options: implement two runs, implement one receivable
    run and leave the payable side unbuilt, or implement one run with a `side`
    in the scope. Chosen: one run with `side` defaulting to `both`. The bucket
    arithmetic, the tie row and the snapshot table are identical on either side
    and only the sign of the control balance differs, so two runs would be one
    file copied with a minus sign in it. The file keeps the name the task asked
    for and the run keeps the type doc 02 asked for.

68. **The aging is a rebuild, not an append.** Options: insert a fresh set of
    snapshot rows every run and read the newest, delete and reinsert, update the
    rows in place through field writes, or keep only the latest and drop the
    history. Chosen: derived ids from the as of date, the side and the document
    id, so a rerun addresses the same rows, then `already_applied` when the
    content is unchanged and a field write of only the moved columns when it is
    not. Appending makes every reader carry a subquery for the latest run and
    makes two runs of the same date look like a doubled receivable, which is
    exactly the class of bug the pipeline test exists to catch. Deleting loses
    the record that the earlier figure was ever reported.

69. **The tie row is a row, not an exception.** Options: refuse the run when the
    subledger does not tie to the control account, log a warning, write the
    difference onto every detail row, or write one tie row per side carrying the
    control balance, the subledger total and the signed difference. Chosen: the
    tie row, with `subledgerOutOfTie` set. An aging that refuses to exist when
    it disagrees with the ledger is an aging you cannot use to find out why it
    disagrees. The difference is the first number a person looks for, so it is
    stated once, in cents, with a sign, and the detail rows stay clean.

70. **The statement opening balance is the residual.** A statement header has to
    foot: opening plus activity equals closing. Two of those three can be
    computed from the documents and the third has to give. Options: compute
    opening from the prior statement, compute opening from the ledger as of the
    day before, compute activity from the ledger and derive opening, or compute
    closing and activity from the documents and let opening be the residual.
    Chosen: the residual. Closing is what the customer owes now and activity is
    what happened in the window, and both are readable off the same rows the
    itemised section is built from. Deriving opening from a prior statement
    chains an error forward forever, and the first statement has no prior. The
    residual can never make the header disagree with its own lines.

71. **Rebuilding a statement supersedes rather than edits.** Options: update the
    document in place, insert a second draft and let the reader choose, delete
    and reinsert, or set the old document to `superseded` and repoint the
    customer at the new one. Chosen: supersede and repoint. A statement is a
    document that may already have been shown to someone, so the figures it
    stated should stay recoverable. Two live drafts for one customer and one
    date is an ambiguity a reader cannot resolve. Rebuilding with unchanged
    figures skips as `already_applied` and writes nothing at all.

72. **The four tiers of payment matching, and what the tolerance means.**
    Options for a payment with no remittance advice: oldest first always, refuse
    anything not exactly equal to one invoice, search combinations without
    limit, or a stated cascade. Chosen: the cascade, remittance lines, then a
    `matchHint`, then a unique combination of up to three open invoices, then
    oldest first, with the tier recorded on the payment and on every application
    row. Unbounded combination search finds a subset of a long ledger that sums
    to the payment by coincidence and applies cash to invoices nobody paid.
    Three is the depth at which a real remittance is either obvious or has an
    advice attached. When more than one combination sums to the payment the run
    refuses with `combination_not_unique` rather than picking the first, because
    two answers is not an answer. The one cent per invoice tolerance is applied
    to the advice total, so a five line remittance may be five cents out and no
    more, and a mismatch beyond that is `remittance_sum_mismatch`.

73. **A late fee is a draft invoice and posts no entry.** Options: post the fee
    to fee revenue and receivable immediately, post it to a suspense account,
    prepare a draft invoice with no entry, or record it only in the aging.
    Chosen: a draft invoice carrying `parentInvoiceId` and `feeMonths`, with no
    journal entry, so `writesLedger` is false. A late fee is a charge to a
    customer, and a client who has not decided whether to charge it should not
    find it recognised as revenue and sitting in the aging. Draft invoices are
    excluded from the open balance, so the fee stays out of the aging, out of
    the statement and out of the receivable until a person posts it. A suspense
    account would recognise the receivable while pretending not to.

74. **How a rerun avoids charging the same month twice.** Options: a flag on the
    parent invoice, a last charged date, one fee invoice per period keyed by
    period, or summing `feeMonths` across the existing fee invoices for the
    parent and charging only the difference. Chosen: sum and charge the delta.
    A flag cannot express two months owed, a date makes the answer depend on
    when the run happened rather than on how late the invoice is, and keying by
    period breaks when a period is reopened. Summing means the ledger of fees
    charged is the fee invoices themselves, so a fee invoice a person voids is
    correctly chargeable again, and no bookkeeping of the bookkeeping is needed.

75. **AP-APPLY-DISCOUNTS writes the ledger, which doc 02 does not say.** The
    doc lists the run without an entry. Options: follow the doc and only mark
    the bill, post the whole settlement, post only the discount and leave the
    payment to another run, or propose an entry and require approval. Chosen:
    post the whole settlement, debiting the payable, crediting the payment
    clearing account for the net and crediting purchase discounts for the rest.
    The task says the discount has to actually reduce the bill balance, and a
    bill balance that falls without an entry puts the subledger out of tie with
    the payable control on the same day, which run 5 in the same module then
    reports as a defect. Posting the discount alone leaves a payable that is
    short by two percent and no cash movement to explain it.

76. **Where the discount lands is the vendor's decision.** Options: always
    purchase discount income, always a vendor credit, a policy level switch, or
    a rule on the vendor. Chosen: `earlyDiscountRule` on the vendor, defaulting
    to the income line, and a `vendor_credits` row plus a credit to the vendor
    credit account when it says `vendor_credit`. Which one is right depends on
    what the vendor actually does with the two percent, and that is a fact about
    the vendor, not about the client. The base excludes freight and tax by
    default, which a policy flag can reverse, because a vendor who allows the
    discount on the whole invoice is common enough to configure and rare enough
    not to assume.

77. **A write off needs a standing authority and age is never one.** Options:
    write off anything past the threshold, write off past the threshold when
    collection attempts exceed a count, require `do_not_pursue` on the customer
    or `writeoffApproved` on the invoice, or propose everything and post
    nothing. Chosen: require one of the two authorities, and when neither is
    present write a `writeoff_proposals` row with `authority` null and skip with
    the detail `no_writeoff_authority`. Age and attempt counts are evidence that
    a person should look, not a decision that the money is gone, and a run that
    writes off a receivable because a date passed is a run that quietly reduces
    revenue. The proposal row means the work of finding the candidates is not
    thrown away.

78. **The write off entry splits sales tax back out.** Options: charge the whole
    balance to bad debt, charge the net and leave the tax, reverse the tax
    proportionally, or refuse when tax is present. Chosen: reverse the tax
    proportionally to the balance being written off and charge only the net to
    bad debt or to the allowance, with the receivable credited for the whole
    open amount so the subledger and the control move together. Charging tax to
    bad debt overstates the expense by the tax and leaves a liability for tax on
    revenue that was never collected. This is a bookkeeping reclass between two
    accounts the client already has and nothing here computes what is owed to
    any authority or files anything.

79. **Nothing in this module sends anything.** Doc 02 mentions notifying a
    client. Options: send an email, queue a message for another service, write
    an audit entry, or do nothing. Chosen: the audit entry, through the ordinary
    execution log the framework already writes, and no external call anywhere.
    AR-BUILD-STATEMENTS builds the document and stops, and the statement tables
    carry no sent, delivered, emailed or recipient column, which the pipeline
    test asserts by inspecting the column names so the constraint survives a
    later change to the schema.

80. **`sumCents` was already taken.** `arap-shared.ts` needed a bigint sum and
    `db.ts` already exported one under that name. Options: import the existing
    one, shadow it, rename the new one, or drop the helper. Chosen: rename to
    `sumArapCents`. The two do different things and the barrel file re exports
    both, so a shared name would be a collision at the export boundary rather
    than a convenience.

81. **`dayGap` returns an absolute value, which is a real defect.** A bill not
    yet due aged to plus four days instead of minus four, which put it in the
    thirty one to sixty bucket instead of current. Options: change `dayGap` in
    `dates.ts`, wrap it at each call site, add a signed variant, or compare date
    strings in the run. Chosen: a signed variant, `signedDayGap`, in
    `arap-shared.ts`, used by `ageDaysFor` and by `withinDiscountWindow`.
    Changing `dayGap` would alter behaviour under every existing caller in a
    module this task was not asked to touch, and every one of those callers is
    already passing its dates in order. The variant is three lines and the
    aging test that found the bug now pins it.

## Module 6, substantiation and close

82. **Run type ids do not match the file names.** The brief names the files
    `sub-tie-balances.ts` through `cls-post-yearend.ts` and doc 02 names the runs
    SUB-TIE-BALANCES through CLS-POST-YEAREND, while the registry in this repo
    already uses a verb style prefix per module (`TXN-`, `REC-`, `PER-`, `ARAP-`).
    Options: use the doc names verbatim as run types, rename the files to match
    the types, use the doc names for types and the brief names for files, or
    invent a third naming scheme. Chosen: keep the brief file names and register
    the types in this repo's own style, `SUB-TIEOUT-ACCOUNTS`,
    `SUB-RAISE-REQUESTS`, `CLOSE-CHECK-GATES`, `CLOSE-LOCK-PERIOD`,
    `CLOSE-ROLL-FORWARD`, `CLOSE-POST-YEAREND`. A run type is an idempotency key
    ingredient and a log value that people read across modules, so consistency
    inside the registry matters more than matching a file name, and the file names
    stay exactly where the brief said to put them.

83. **The task gate list and doc 00 Part 5 disagree.** Doc 00 carries an older
    table with a shorter gate set and slightly different wording. Options: follow
    doc 00, follow the task list, merge both into a longer set, or implement doc
    00 and add the task gates as warnings. Chosen: the task list of nineteen
    gates G01 through G19 exactly as written. It is the newer statement, it is the
    thing the tests are specified against, and doc 00 is read only for this task
    so the two cannot be reconciled in one place anyway.

84. **G01 and the 1900 account.** Doc 00 lists the clearing block as 1910 through
    1990 in one place and the brief names 1900, 1910, 1920, 1930 and 1990.
    Options: use the brief's five, use doc 00's four, sweep the whole 1900 to 1999
    block, or make the set a policy column. Chosen: the brief's five, stated once
    as `CLEARING_ACCOUNTS` in `close-shared.ts`. Sweeping the whole block would
    catch an account a firm deliberately uses as a real asset, and a policy column
    is a schema decision doc 04 has not made.

85. **Cents inside a jsonb snapshot cannot be bigint.** The Postgres parameter
    encoder runs `JSON.stringify`, which throws on a bigint, and the gate payloads
    and the trial balance snapshot both carry money. Options: store numbers and
    accept the precision loss above 2^53, store decimal strings, store cents in a
    side table, or keep bigint and write a custom encoder. Chosen: decimal
    strings, produced by `centsText`. The strings round trip exactly, they sort
    the way a person expects for a fixed width figure, and nothing in the codebase
    does arithmetic on a snapshot: it is evidence, not an input.

86. **One substantiation table or one per source.** The tie out run needs an
    inventory count, a payroll register, and room for whatever a later source
    turns out to be. Options: a table per source kind, one
    `substantiation_records` table with a kind discriminator, columns on
    `sub_tieouts` itself, or reading each source from wherever it already lives.
    Chosen: one `substantiation_records` table with a kind, plus reading the
    sources that already exist elsewhere in the schema, which is the aging
    snapshots, the loan and deferral schedules, the fixed asset rows and the
    reconciliation batches. A table per kind would be six migrations for one
    concept, and columns on the tie out row would mean rewriting evidence every
    time a variance is recomputed.

87. **Where the W-9 facts live.** SUB-RAISE-REQUESTS asks for a W-9 that is
    absent or expired. Options: a new `vendor_documents` table, two columns on
    `subledger.vendors`, a row in `substantiation_records`, or infer it from the
    document vault. Chosen: `w9_on_file` and `w9_expires_on` on the vendor.
    Whether a vendor's paperwork is current is a fact about the vendor, the
    request run only ever needs the answer rather than the history, and a table
    for two booleans would be answered by a join on every close.

88. **Proving the gate set is newer than the last ledger write.** A journal row in
    this schema carries no created at column, so there is no timestamp to compare
    a gate evaluation against. Options: add a created at column to the journal
    tables, compare the gate evaluation time to the newest run log row that wrote
    the ledger, store a fingerprint of the ledger on each gate result and compare
    it, or trust the operator to rerun the gates. Chosen: the fingerprint. It is a
    hash over every journal line in the period and it is exact: any posting,
    reversal or redating moves it, and CLOSE-LOCK-PERIOD refuses with
    `CLOSE_GATE_SET_STALE` when the gates were judged against a different ledger.
    Adding a column would touch a module this task may not change, and a run log
    comparison would miss a hand correction that did not go through a run.

89. **The escalation ladder is not in the specs.** Doc 02 says a request escalates
    by age and does not say when. Options: seven, fourteen and thirty days, a
    single thirty day threshold, a policy column per client, or escalate on every
    refresh. Chosen: seven, fourteen and thirty, stated once as
    `ESCALATION_DAYS`. Seven matches the fastest close cadence the practice runs
    support, thirty is the same threshold G17 uses for an orphan request so the
    two never disagree, and a policy column can wrap this constant later without
    changing any run.

90. **What CLOSE-POST-YEAREND closes.** Doc 00 Part 1 puts income tax expense in
    the 9000 memo block and says that block never reaches a published statement.
    Options: close the whole 4000 through 9999 range, close 4000 through 8999 and
    leave the memo block, close only 4000 through 7999, or make the range a
    policy. Chosen: 4000 through 8999, which is revenue, cost of goods, operating
    expense and other income and expense, and the 9000 block is left where it is.
    Closing a memo tax figure to equity would be taking a tax position, and we are
    not CPAs. Nothing in this run computes a tax, prepares a return, or files
    anything.

91. **G18 and the gate run's own log row.** The preparer versus approver gate
    reads the run log, and the gate evaluation run writes a row to that log. Its
    own apply row exists while the gate reads the log during apply and does not
    exist during preview, so including it made the run refuse itself with
    STALE_PREVIEW every time. Options: read the log as of the preview time,
    exclude the gate run's own type, exclude the current execution id, or move G18
    to a reporting run outside the gate set. Chosen: exclude
    `CLOSE-CHECK-GATES` rows by type. Evaluating gates writes nothing anybody acts
    on, so it is a measurement rather than a preparer and approver event, and
    excluding by execution id would still leave a previous evaluation of the same
    period flagging itself.

92. **The lock has to record who locked it.** `locked_by` is the person and the
    preview and the apply of a two person close are two different people, which is
    the entire point of D4. Stamping `ctx.actor.userId` into the proposal made
    apply refuse itself. Options: record the preview actor, record the apply actor
    through a placeholder the writer resolves, drop the column, or exclude the
    field from the preview comparison. Chosen: a third placeholder,
    `ACTOR_PLACEHOLDER`, alongside `RUN_ID_PLACEHOLDER` and `NOW_PLACEHOLDER` in
    `apply-writer.ts`, resolved at the moment of the write. It is the same problem
    those two solve and the same solution, and the row ends up naming the person
    who actually locked the period.

93. **The gate run's scope hash was the same in every execution.** Its candidate
    set is the same nineteen derived ids for a period and the gate versions never
    move, so a second evaluation after a posting or after a blocker was fixed
    deduplicated to the first one and handed back stale answers. Options: add the
    ledger fingerprint to the discriminator, add the versions of every row every
    gate reads, hash the answers the gates give and use that, or make the run non
    idempotent. Chosen: hash the answers. The fingerprint alone misses a change
    outside the ledger, such as somebody picking up a stale document request, and
    enumerating the versions of every input means listing a dozen tables that will
    grow. The gates are pure functions of the loaded data, so evaluating them
    twice per execution is cheap and the hash moves exactly when an answer moves.
    CLOSE-LOCK-PERIOD carries the ledger fingerprint in its own discriminator for
    the same reason.

94. **G14 read literally.** The gate says no journal line is dated in a locked
    period, and the framework deliberately posts corrections into locked periods
    with `redated_from_locked_period` set. Options: fail on every line inside a
    lock, fail only on lines with no redating marker, fail only on lines whose
    entry date and redating marker disagree, or scope the gate to the period being
    closed. Chosen: fail on any line inside an active lock that carries no
    redating marker. That is the literal reading with the one exception the
    framework itself creates, and a redated entry is by construction a line the
    lock already knows about.

95. **G15 judges the lines it can judge.** Not every posted line comes from a
    transaction. A depreciation line, an accrual reversal and a year end closing
    line have a cascade level of null by construction. Options: fail every line
    with no cascade level, judge only lines whose source is the transactions
    table, judge every line and treat a run written line as level zero, or drop
    the gate. Chosen: judge only lines whose `source_table` is `transactions`,
    where a cascade level and a rule id or a written override reason is the thing
    doc 00 actually promises. A manual override with a reason passes, which is the
    exception the gate text names.

96. **Sign conventions for a supported balance.** A schedule states a remaining
    balance as a positive figure and the ledger states a liability as a credit.
    Options: compare absolute values, negate the schedule for liability accounts,
    store a sign on the substantiation row, or compare in the natural side of each
    account. Chosen: every supported balance is stated debit positive, so a
    liability schedule is negated before the comparison, and the variance is
    always ledger minus supported. Comparing absolute values would hide a balance
    sitting on the wrong side, which is a condition the tie out row reports
    separately as `wrong_side_no_reason`.

97. **G19 without a second set of books.** D3 says cash basis is derived, so
    there is no cash basis ledger to compare against. Options: build a full cash
    basis trial balance in the gate, compare the in period movement of the income
    statement against the movement of the two control accounts, compare only
    against cash touching entries, or mark the gate not applicable for an accrual
    client. Chosen: the movement comparison. Accrual net less the change in
    receivables less the change in payables is the derived cash figure D3
    describes, and the gate fails when an income statement line moved through
    neither cash nor a control account, which is the state that makes the
    derivation wrong.

98. **`close.periods` already had a claim on the name.** The close needs a period
    row with a status a person opens and closes, and `ledger.period_locks` already
    records the lock. Options: put the status on `period_locks`, add a
    `close.periods` table, infer the status from the presence of a lock, or add a
    status column to a client level table. Chosen: `close.periods` for the period
    and its status, and `period_locks` keeps the lock event with its snapshots. A
    lock is something that happened at a moment and a period is a thing with a
    current state, and inferring the state from a lock row leaves no way to say a
    period is open, reopened, or being worked.

99. **The variance threshold was stated twice with two different numbers.** Doc
    02 says a floor of fifty thousand cents and five hundred basis points. The
    brief says ten percent by default. Options: take the doc figure, take the
    brief figure, take the stricter of the two, take the looser of the two, or
    keep both conditions with the brief setting the percentage. Chosen: keep both
    conditions, default the percentage to one thousand basis points per the brief
    and the floor to fifty thousand cents per doc 02, and let a per account row
    override either. Precedent is entry 84: when the brief and a doc disagree on
    a number, the brief wins. Keeping both conditions is the real point. A
    percentage alone shouts about a rounding difference on a small account and a
    floor alone shouts about a large account that moved a fraction of a percent,
    and each row states the threshold and the floor it was measured against so a
    flag read six months later still explains itself.

100. **There was no budget table.** Variances compare actual to budget and no
    migration through 0015 had anywhere to keep a budget. Options: read budgets
    from an external system, store a budget as a journal entry in a memo account,
    put a budget column on the chart of accounts, keep budgets in a jsonb blob on
    the client, or add a table. Chosen: `report.budgets`, one row per account per
    period, with class, location, and program columns so a budget can be as
    dimensioned as the ledger it is compared to. A memo account budget would sit
    inside the ledger and would then have to be excluded from every statement by
    hand, and a column on the chart cannot hold a figure that changes by period.

101. **Vault attachment when the run has no bytes to attach.** D7 wants the
    package in the vault under Object Lock, but `vault.documents` requires a scan
    status of clean and a verified magic number, and a run assembling a package
    has structured rows rather than a rendered file. Options: write a vault
    document row with a fake scan status, render a PDF inside the run, defer the
    attachment to a later delivery run, put the retention terms on the package
    row, or skip the attachment. Chosen: retention terms on the package row, plus
    a report audit event. The row records the object key, the lock mode, the
    retention start, and the retention end, so the vault contract is stated and
    checkable without a run ever pretending it scanned a file it never had.

102. **The audit event action list had no room for a report.** Doc 07 fixes the
    `vault.audit_events.action` check list, and neither `report_available` nor
    `narrative_available` is on it. Options: widen the vault check constraint,
    reuse a nearby action such as `document_downloaded`, write no audit row,
    write to the run log only, or add a reporting audit table. Chosen: a separate
    `report.report_audit_events` table with its own two value check list.
    Widening a check constraint in another module's schema to hold a word that
    module has no concept of is how a check list stops meaning anything, and
    reusing `document_downloaded` would put a false statement in the audit trail.

103. **There was no payroll table either.** The forecast needs approved payroll
    and nothing in the schema held it. Options: infer payroll from recurring
    templates, infer it from historical journal entries, read it from an external
    provider, treat it as an ordinary bill, or add a table. Chosen:
    `report.payroll_approvals`, holding a pay date, a positive magnitude, a
    funding account, and a status. Only an approved row is forecast. Inferring
    payroll from history is a fitted estimate, which the no artificial
    intelligence constraint rules out, and a draft payroll is not a commitment.

104. **The ledger fingerprint in the reporting scope hash.** A reporting run is
    a reader, so its candidate rows can be identical across two calls while the
    ledger underneath has changed. Options: leave the fingerprint out and accept
    stale packages, add the fingerprint, add a build timestamp, add a monotonic
    counter, or disable deduplication for the whole module. Chosen: the
    fingerprint, exactly as CLOSE-LOCK-PERIOD does it in entry 93. A timestamp
    would defeat deduplication entirely, so a rebuild that changed nothing would
    still write, and a counter is a timestamp with extra steps.

105. **Sections as structured lines rather than rendered bytes.** Options: store
    a rendered PDF, store HTML, store markdown, store a line array, or store only
    the totals. Chosen: a jsonb array of lines, each with a label, an optional
    account number, a cents string, an optional comparison, and a note. A
    rendered file cannot be diffed, cannot be checksummed field by field, and
    puts presentation inside a run whose job is figures. Cents are text in jsonb
    because jsonb has no bigint, and every one of them is a whole number of cents.

106. **A comparison column with no prior period behind it.** The first period a
    client is on the system has nothing to compare against. Options: compare
    against zero, omit the comparison column, leave it null and say why, refuse
    to build the package, or compare against the budget instead. Chosen: null
    comparison figures plus a stated note on the header saying no prior period
    figures exist. Comparing against zero would report every account as an
    infinite increase, and silently omitting the column leaves a reader to guess
    whether the prior period was zero or absent.

107. **Where the forecast starts.** Options: the run date, the period end, the
    day after the period end, the following Monday, or the first day of the next
    period. Chosen: the day after the period end. A forecast starting inside the
    period double counts cash that already moved, and one starting on the run
    date gives two different answers for the same closed period on two different
    days, which breaks preview equals apply. The day after the close is also the
    first day whose cash is genuinely unknown.

108. **When a payable actually leaves.** Options: always the due date, always the
    discount day, the earlier of the two, the discount day only when the discount
    is worth more than the cost of paying early, or the later of the two. Chosen:
    the discount day when it falls before the due date, otherwise the due date,
    and a payment day already in the past is clamped forward to the first week of
    the horizon. A bill overdue at close is not a bill that never gets paid, and
    dropping it would understate the outflow. Judging whether a discount is worth
    taking is a decision about the client's money and is not a run's to make.

109. **The collection curve, and the line the constraint draws.** Options: fit a
    curve to the client's own collection history, fit one to a peer set, use a
    stated table of weights by aging bucket, use a single flat percentage, or
    assume every invoice pays on its due date. Chosen: a stated table, written in
    `rpt-rebuild-forecast.ts` where a person can read it and argue with it, with
    `useHistory` recorded false on every header. A fitted curve is a learned
    parameter, which the no artificial intelligence constraint forbids, and it
    would also make two rebuilds over one ledger disagree. The rows deliberately
    do not sum to ten thousand basis points for the late buckets, because an
    invoice ninety days past due is mostly not arriving inside thirteen weeks and
    placing it all would put money in the forecast that is not coming.

110. **The change log described the run that built it.** The first version listed
    every run log row for the period, which meant the preview saw one row and the
    apply saw two, and the framework refused the apply as a stale preview.
    Options: exclude the current execution by id, exclude all previews, exclude
    the reporting module, freeze the change log at preview time, or drop the
    section. Chosen: applied runs only, completed only, and no run whose type
    starts with `RPT-`. A change log is a list of what changed the books, and a
    reporting run changes no book. Excluding one execution by id would still let
    a second reporting run appear between two calls, so the filter is on the
    module rather than on the execution.

111. **How much a narrative section may say.** Options: no cap, a fixed cap that
    drops overflow silently, a cap that drops the lowest priority sentences and
    counts the drops, a cap per narrative rather than per section, or a character
    limit. Chosen: a per section cap, default five, dropping the lowest priority
    droppable sentences and recording the count on the row, with the cap widened
    to fit any sentence marked not droppable. That last part matters: the brief
    requires the narrative to name every failed gate and every variance over
    threshold, and a narrative that named four of seven failures while looking
    complete would be worse than one that named none.

112. **The 1099 threshold is configuration and not a constant.** The reportable
    floor moved from six hundred dollars to two thousand, and the old floor still
    governs older years. Options: hard code two thousand, hard code both with a
    year comparison in the run, read the floor from a `tax.thresholds` table with
    an effective date range, put it on the client policy row, or take it from the
    caller's scope. Chosen: the table. A statutory number with a date range is
    data, not code, and the next change to it should be a seed row rather than a
    deploy. The run reads the row whose range covers the tax year end and records
    the value and the range it used on the data set, so a compiled set can be
    read back years later and still explain which floor produced it. A caller
    supplied floor was rejected outright: a threshold somebody typed is exactly
    the kind of figure D4 says this firm does not accept.

113. **W-9 tracking reuses the existing request machinery.** `w9-track` needs to
    raise a document request when a form is missing, and `sub-raise-requests`
    already raises document requests. Options: a second request table just for
    tax forms, a separate row in the same table with its own id scheme, reuse of
    `requestId(clientId, subjectKey)` so both runs land on one row, a flag column
    on the vendor, or no request at all and only a state row. Chosen: reuse
    `requestId` with a W-9 subject key. Two runs that both chase the same missing
    piece of paper have to write the same row or the client gets asked twice and
    the two chases age separately. Sharing the id also means the close side of
    the system already knows how to age, escalate, and close the request, and
    none of that had to be written a second time.

114. **A `practice_states` table, because tenancy carries none of it.** The
    practice runs need to know whether a client is live, what its service tier
    is, who leads the engagement, and what the period cadence is. Options: add
    the columns to `tenancy.clients`, read them from the engagement letter row,
    infer liveness from recent activity, add a `practice_states` table keyed by
    client, or take them from the run's scope. Chosen: the new table. The tenancy
    row is a tenancy row and the migration for it is not this module's to change,
    inference from activity would make a quiet month look like an offboarded
    client, and a scope supplied tier is a figure somebody typed. The table also
    gives the workload runs somewhere to record the last generation date, which
    is what makes the generation idempotent per client and period.

115. **One client per practice execution.** Doc 02 asks for the workload across
    every live client, and `FrozenScope` requires a `clientId`. Options: relax
    the frozen scope to allow a null client, add a firm level scope kind, run the
    firm loop inside one execution and write rows for many clients, keep one
    execution per client and let the orchestrator loop, or add a second run type
    that fans out. Chosen: one execution per client, with the orchestrator
    looping the live list. The tenancy filter on every query is the reason the
    two tenant negative test can fail for a real reason, and an execution that
    wrote rows for eleven clients would have to hold that filter open. It also
    keeps a single client's failure from taking the whole firm's generation with
    it, and the run log stays readable, one row per client per period.

116. **No holiday calendar, so business days skip weekends only.** Task due
    dates, escalation windows, and the fifteen day production window all need to
    count business days. Options: a full federal holiday table, a per firm
    calendar, weekends only, weekends plus a hard coded federal list, or calendar
    days throughout. Chosen: weekends only, in `shiftToBusinessDay` and
    `addBusinessDays`. A holiday table is real work with a real maintenance
    burden and nothing in doc 02 or doc 05 asks for one, a hard coded federal
    list goes stale silently, and calendar days would put deadlines on Sundays.
    The choice is written down here because it is the kind of thing that looks
    like a bug later: a due date that lands on a holiday is deliberate.

117. **New tables for payroll, handoffs, and exports rather than reuse.** All
    three attach an artifact to the vault, and migration 0010 already has vault
    dependent tables. Options: reuse `statement_documents`, reuse
    `report_packages` with a new kind, add a generic `artifacts` table for all
    three, add three purpose built tables, or store them as document links.
    Chosen: three purpose built tables in 0017. A pay run carries a disbursement
    check constraint, an export carries a fifteen day production check, and a
    handoff carries a scope statement, and none of those constraints can live on
    a generic row. The generic table was the tempting one, and it was rejected
    for exactly that reason: the constraints are the point, and a shared table
    would have pushed all three into application code where nothing enforces
    them.

118. **Gross wages come off the vault register, never off the scope.** The
    approval needs a gross figure. Options: take gross from the scope, take it
    from the provider approval row, read it from the substantiation record linked
    to the register in the vault, sum it from a prior ledger entry, or require
    all of them to agree. Chosen: read gross from the substantiation record,
    derive net as gross less withholding, and refuse when the provider's own net
    disagrees with the derived one. D5 and G11 both point the same way: a payroll
    total this firm typed is a payroll total this firm calculated, and this firm
    does not calculate payroll. Withholding and employer tax still arrive on the
    scope because the register is a document and not a parsed feed, but they are
    checked against the provider row before anything is written.

119. **Entity exclusion is decided before counting, not after.** The first
    version counted a payee into the header and then dropped its lines when the
    entity type excluded it, so the reportable count and the lines under it
    described different sets. Options: count after exclusion, count before and
    accept the mismatch, emit zero amount lines for excluded payees, drop the
    header counts, or split the header into gross and net counts. Chosen: compute
    the eligible box classes first, and a payee with no eligible class increments
    the excluded count and produces one skip naming the entity type. A payee that
    is excluded for one box and reportable for another still emits a skip per
    class. A header that disagrees with its own detail is the sort of defect a
    CPA finds in February, and it costs nothing to decide the exclusion first.

120. **Escalation and nudging do not gate on a locked period.** The task brief
    says write runs skip a locked target period. Options: apply that to all five
    practice runs, apply it to none, apply it to generation only, gate on the
    client's own lock rather than the period lock, or make it configurable.
    Chosen: `prc-generate-work` skips a locked period per catalog code, while
    `prc-escalate-overdue` and `prc-nudge-requests` do not. A period lock is a
    statement about the ledger, and neither of those two writes a ledger row.
    Worse, gating them would mean an overdue task inside a month somebody closed
    early stops escalating, which is the exact case where escalation matters. The
    reasoning is in each file header so the difference reads as a decision.

121. **The disbursement constraint is mirrored in the memory database.** The
    check lives in `db/migrations/0017_compliance_practice.sql`, and the test
    suite never touches Postgres. Options: assert the constraint by reading the
    SQL text, assert it only through the row type, mirror the check in
    `db-memory.ts` alongside the override and period lock guards, skip the
    assertion, or stand up a real database for the suite. Chosen: mirror it, and
    assert it both ways. `db-memory.ts` already reproduces
    `ledger.guard_manual_override` and `ledger.enforce_period_lock` for the same
    reason, that a suite running against a store which cannot refuse a write
    proves nothing. The new `CheckViolation` carries the constraint name as a
    field rather than only in its message, so the compliance test asserts the
    name and not a substring that any other constraint could satisfy. The
    fifteen day production check is mirrored the same way.

122. **The export leaves its own run log rows out of the manifest.** The
    offboarding catalog counts rows per file, and the run log file counted every
    row including the one the preview had just written, so every apply refused as
    a stale preview. Options: exclude the current execution by id, freeze the
    count at preview time, drop the run log from the export, count applied rows
    only, or exclude every row whose type is the export itself. Chosen: exclude
    the export's own run type. Excluding one execution by id leaves the same
    defect open for a second export request, and freezing the count would put a
    number in the manifest that the file does not have. The log of the run that
    built the archive is not part of the client's history in any case, and this
    is the same reasoning entry 110 reached for the reporting change log.

123. **A wizard checkbox could strike the mandatory clearing block.** Step 3 of
    the intake wizard lets the firm exclude template rows before seeding, and
    `planFor` in `intake-build-chart.ts` kept a struck row only when its
    `forcedMandatory` flag was set. That flag is raised by `assembleAccounts`
    when the clearing block rule pulls a row in past a scope key it did not
    answer, and all five clearing accounts carry the scope key `always`, so the
    flag is never raised for any of them and `excludeAccountNumbers: ["1990"]`
    produced a chart with no suspense account. Options: leave it and treat the
    exclusion as the firm's decision, test the membership of
    `MANDATORY_CLEARING_ACCOUNTS` in the filter alongside the flag, raise
    `forcedMandatory` on every mandatory row whatever its scope key, refuse the
    scope at validation time when it strikes a clearing account, or drop the
    exclusion feature. Chosen: test the membership in the filter, which is one
    added condition and no change to any other run. Leaving it would break the
    suspense sweep, the transfer pairing, the processor split, and the payroll
    clearing path on a client whose only mistake was unticking a box, and doc 00
    Part 1 says those five accounts exist on every chart. Redefining
    `forcedMandatory` to mean two different things was the alternative, and that
    flag is read as a reason string elsewhere, so widening it would make the
    reason wrong. Refusing the scope would be honest but turns a harmless
    checkbox into a dead end for the person finishing the wizard.

124. **Five industry words against four published templates.** The wizard offers
    services, product, restaurant, real estate and nonprofit, and doc 01 as
    written publishes fewer template ids than that. Options: offer only the
    published four and drop a word, map two words onto one template, publish new
    template ids for the missing industries, ask the person to pick a template id
    directly, or let the wizard build a template from scope keys on the fly.
    Chosen: publish the missing ids and keep a single word to id map in
    `INDUSTRY_TEMPLATE_ID`, so services resolves to TPL-SERVICE-STUDIO, product
    to TPL-RETAIL-WHOLESALE, restaurant to TPL-RESTAURANT, real estate to
    TPL-REAL-ESTATE and nonprofit to TPL-NONPROFIT. Mapping two words onto one
    template would put a restaurant on a retail chart and the food cost lines
    would land nowhere sensible. Building from scope keys at run time would make
    the seeded chart depend on the order the keys arrive in, which is exactly
    what a published template id exists to prevent. TPL-CONTRACTOR stays in the
    table and is not offered in the dropdown, because nothing in module 1 seeds
    from it yet and an option nobody can explain is worse than an absent one.

125. **Two catalog categories are behaviours and not rows.**
    `CAT-REFUND-FROM-VENDOR` and `CAT-FIXED-ASSET-ADDITION` read like categories
    and are not. A refund from a vendor is a negative amount posted against
    whatever the original expense was, and a fixed asset addition is a
    capitalization decision taken against the threshold. Options: seed them as
    rows, seed them as rows marked non postable, leave them out, or replace them
    with a note on the accounts they touch. Chosen: leave them out. Seeding them
    invites someone to code straight to them, which puts every vendor refund in
    one bucket regardless of what was bought and hides asset additions from the
    fixed asset schedule. Marking them non postable is the same row with a flag
    that only one screen would honour.

126. **The client app has one shared chart, so the Northgate fixture records the
    template choice rather than a seeded chart.** The brief asks for Northgate to
    carry a chart seeded from the services template, and `client/src/data/coa.ts`
    holds a single `ACCOUNTS` list every fixture client reads. Options: give the
    fixture a per client chart, seed Northgate's chart into the shared list,
    record the template choice on the client record only, rewrite the client data
    layer to be per client, or leave the fixture alone. Chosen: record the choice
    on the client record, as `industryTemplate` and `cutoverDate`. A per client
    chart in the mock is a data layer rewrite that touches every derived
    statement and every gate in `check-books.ts`, for no visible gain, and
    Northgate's posted ledger already references accounts by number. Rewriting
    that ledger to sit on a freshly seeded chart would change every figure the
    self checking script ties out, and the brief says Bramble stays untouched
    precisely so that tie out keeps working.

127. **A category id is the published slug, an account id is derived.** Accounts
    get a derived id from `derivedId` the way every other run makes ids, and
    categories keep the published `CAT-` slug as their primary key. Options: make
    both derived, make both slugs, derive the account and keep the category slug,
    keep both and carry the slug as a second column, or key categories on client
    plus slug. Chosen: derive the account and keep the category slug. The slug is
    the thing rules, reports and the taxonomy doc all name, so replacing it with
    an opaque id would mean every reference needs a lookup. Known limit written
    down rather than hidden: `MemoryRunDb` keys every row by id across the whole
    store, so two clients sharing a category slug inside one memory database
    raise a unique violation. The production schema keys on client and slug
    together, the tests use one client per database, and the day the memory
    database needs two it needs a composite key, not a different id scheme.

128. **The offset foots or the run refuses, and it never plugs.** Account 3900
    is derived as the negation of every other line, so any readable trial balance
    can be posted. What can still go wrong is a supplied 3900 that disagrees with
    the rest of the sheet. Options: trust the supplied figure and plug the
    difference to suspense, trust the derived figure and drop the supplied one,
    post both and let the entry fail to foot, refuse with an error naming both
    numbers, or split the difference into a rounding line. Chosen: refuse, with
    `OPENING_EQUITY_DISAGREES` naming the supplied figure and the derived one.
    Plugging to suspense is the failure mode this whole system exists to prevent,
    dropping the supplied figure silently discards the only evidence that the
    prior books and the new ones disagree, and a rounding line hides a difference
    that is almost never rounding.

129. **The wizard controller lives in the client and mirrors the runs.** The four
    setup runs are `Run<S,P>` implementations on the server, and nothing under
    `client/src` imports from `server/runs`. Options: import the runs into the
    client, run them through an HTTP endpoint, duplicate the logic by hand,
    generate a client mirror from the server source, or move the shared parts to
    a third package. Chosen: generate `client/src/lib/intake-templates.ts` from
    `server/runs/runs/intake-shared.ts` and keep the ordering and the reporting
    in `client/src/lib/wizard-controller.ts` by hand. Generating the chart
    templates means the account numbers, the names and the category counts cannot
    drift from what the run will actually seed, which is the part where a
    divergence would be invisible and expensive. The ordering and the wording are
    short enough to keep honest by reading. A third package is the right answer
    the day there is a server to call, and there is not one tonight.

130. **The strict amount reader, because a display parser answers zero.**
    `parseAmountToCents` in `client/src/lib/money.ts` strips everything that is
    not a digit and answers zero when nothing is left, which is right for a
    display field and wrong for a trial balance. Options: reuse it as is, change
    it and accept the blast radius across every screen that calls it, write a
    strict reader in the wizard controller, validate the string before calling
    it, or refuse anything that is not already normalized. Chosen: a strict
    reader named `centsOf` in the controller, which accepts a sign, commas, a
    dollar sign, up to two decimals and a parenthesised negative, and answers
    null for anything else. It uses integer parts and BigInt and never touches a
    float, which the CI guard on `parseFloat` requires anyway. Changing the
    shared parser would alter what every existing screen shows for a malformed
    figure, and a line reading "about four hundred" has to be reported as
    unreadable rather than posted as zero.

131. **Three screens under /portal that belong to the firm.** The brief fixes the
    wizard at `/portal/intake`, and the shell picks its navigation from the path
    prefix, so the wizard came up wearing client portal chrome while being a
    screen the client must never see. Options: move the routes out of /portal and
    break the brief, leave the portal chrome up, add an explicit firm side list
    of /portal paths, carry a flag on each route, or split the plane decision out
    of the shell entirely. Chosen: an explicit list of three prefixes,
    `/portal/intake`, `/portal/mapping-profiles` and `/portal/clients`, checked
    before the prefix rule. It is three lines, it is readable, and it puts the
    exception where somebody looking at the navigation will find it. A per route
    flag spreads the same decision across forty route declarations.

132. **The fixture bank account needed a source the union did not have.**
    Northgate's operating account imports a CSV through a saved mapping profile,
    and `statementSource` offered bank feed, portal and PDF upload only. Options:
    call it a bank feed and lie, call it a portal download, add a CSV mapping
    value to the union, drop the field and read the profile instead, or leave the
    account on PDF upload. Chosen: add CSV mapping to the union and to
    `STATEMENT_SOURCES`. Calling it a feed would put it in the wrong bucket on the
    reconciliation screen, which reads the source in its subtitle, and dropping
    the field would make every screen that shows a source do a profile lookup for
    the three accounts that have one. PDF upload keeps its meaning, which is that
    the statement is filed as a document and reconciled by hand, because there is
    no PDF parser and doc 05 D2 says there will not be one.

133. **The draft survives a step change and not a refresh, and the wizard says
    so.** State is memory and URL query only, no storage of any kind, which the
    CI grep guard enforces. Options: put the whole draft in the query string, put
    it in the URL fragment, keep a server side wizard session row, keep it in
    memory and say so, or block the refresh with a confirm dialog. Chosen: the
    step number in the query and the draft in memory, with a line on the review
    step telling the person a refresh before Finish loses the draft. A whole
    draft in the query string breaks at a few kilobytes and puts an EIN in the
    browser history and in any proxy log along the way. The `intake.wizard_sessions`
    table added in migration 0018 is where a resumable draft belongs the day
    there is a server to write it to.

134. **Three of the eleven unresolved row map keys were a map problem and not a
    missing table.** `mapping_profile_columns` and `wizard_sessions` exist,
    created by migration 0018 in the `import` and `intake` schemas, and
    `PHYSICAL_TABLES` had no entry for either, so the port qualified them as
    `ledger.` and addressed nothing. `run_sequence` is singular in `RowMap` and
    the table migration 0003 created is `ledger.run_sequences`. Options: move
    the two tables into `ledger` so the default prefix works, rename the table
    to match the key, rename the key to match the table, or add the three
    entries to the physical table map. Chosen: three entries in the map. Moving
    tables would undo the schema split doc 03 asks for, and renaming the key
    touches every row interface, every query catalog entry and every test that
    names it. The map exists for exactly this mismatch and it keeps the
    mismatch in one readable place.

135. **`chart_accounts` is a view over `ledger.accounts` with an instead of
    insert trigger, and the 8000 and 9000 blocks refuse.** `ChartAccountRow` is
    five fields, the real chart is keyed by `(client_id, account_number)` with
    no id column, and it requires `account_type` and `normal_side`. Options: a
    second physical chart table, rewrite INTAKE-BUILD-CHART to emit full
    account rows, add nullable type columns to `ledger.accounts`, or a view
    with a trigger that derives the type from the account number. Chosen: the
    view. Two chart tables drift and there is no tiebreak between them when
    they do, rewriting the intake run puts a schema change and a run change in
    one commit, and nullable type columns would let an account with no normal
    side reach the trial balance. The derivation is the doc 00 block map
    migration 0002 already enforces as `acct_block_matches_type`, so the
    trigger is not inventing a rule, it is applying the one that is already
    there. The 8000 block is other income or other expense and the 9000 block
    is tax or memo, and nothing in five fields chooses between them, so the
    trigger raises and names the account and tells the caller to insert into
    `ledger.accounts` with an explicit type. A guessed account type is a
    misstatement that survives into every statement built on top of it.

    Two consequences worth knowing. The view's id is derived,
    `client_id` and `account_number` joined by a hyphen, and
    `intake-build-chart.ts` mints a different derived ULID for the same row.
    Idempotency still holds because the run skips by account number before it
    ever looks at an id. And the grant is select and insert only, with no
    instead of update trigger, because no field write path for a chart account
    exists in the port. A rename goes to `ledger.accounts`, which is where the
    row lives.

136. **Array valued columns on the new tables are jsonb, not `char(26)[]`.**
    `encodeParam` in the Postgres port JSON stringifies every array before it
    reaches the driver, so `'["A","B"]'` arrives at a `char(26)[]` column and
    Postgres answers `22P02 malformed array literal`. Confirmed against the
    real database. Options: change `encodeParam` to emit a Postgres array
    literal, pass arrays through the driver's own array binding, declare the
    columns jsonb, or store a delimited string. Chosen: jsonb for
    `suspense_items.related_ids` and for `run_sequences.child_run_ids`.
    Changing the encoder is a change to every insert the port makes and would
    need a per column type map to know which arrays are text and which are not,
    and a delimited string gives up any ability to index or count the contents.
    This does diverge from the `char(26)[]` spelling migration 0003 used for
    `run_log.candidate_ids`, which has the same defect and is written up in the
    report rather than changed here.

137. **`ledger.run_sequences` could not accept the row `sequence.ts` writes, in
    three separate ways.** `id` was `char(26)` and a sequence id is `RUNSEQ-`
    and a ULID, which is 33. `actorId` is on the row and there was no
    `actor_id` column. `status` was not null with no default and is not on the
    row at all. Options for status: give the column a default of `completed`,
    drop the column, add a `status` field to `RunSequenceRow` and to every
    caller, make it nullable and let reads cope, or derive it. Chosen: derive
    it in a before insert trigger from `stopped_at_step`, null meaning
    completed and a step number meaning stopped. A default of completed would
    label a stopped sequence completed, which is the one wrong answer that
    nobody notices. Dropping the column loses the only field a practice screen
    filters on. Adding the field to the row type spreads a value that is
    already implied across every call site, and two sources for one fact
    eventually disagree.

138. **No check constraint that gross plus fee equals net on
    `settlement_rows`.** The invariant is real, doc 02 TXN-SPLIT-SETTLEMENTS
    step 2, and fees are stored negative so the relation is a sum and not a
    difference. Options: a check constraint, a trigger that repairs net, a
    trigger that warns, or no constraint. Chosen: no constraint, with
    `fee_cents <= 0` kept because that one is a storage convention rather than
    a claim about the processor. A processor report that does not add up is a
    thing that actually arrives, and the run already detects it and reports the
    payout by name. A constraint would refuse to store the row, which means the
    firm cannot see the report it needs to argue with the processor about, and
    the run's mismatch branch would become unreachable code.

139. **All seven new tables carry the version column, the three override
    columns and both triggers, including the ones no run updates.** None of the
    seven row interfaces carry `manualOverride`, and two of the seven are read
    only to runs today. Options: add the columns only where a run writes them,
    add them only where a row interface names them, add them everywhere, or add
    them later when a screen needs them. Chosen: everywhere, matching how
    migration 0015 treated its tables. A firm maintained bank code mapping and
    a document link a person filed by hand are both things somebody will edit,
    the guard costs nothing on a table nothing updates, and adding a column to
    a table with rows in it later is a migration plus a backfill plus a window
    where half the tables answer the override question differently.

140. **The run id width split is real across eighty odd columns and only the
    two 0018 tables are widened here.** A run execution id is 31 characters.
    Migrations 0003 through 0014 declared run id columns `char(26)`, which is
    the ULID width without the `RUNX-` prefix, and 0015 through 0017 use
    `char(31)`. Options: widen every column now, widen nothing and report,
    change ids to fit 26, or widen only the columns this migration's own work
    touches. Chosen: widen the five columns on `intake.wizard_sessions` and the
    one on `import.mapping_profile_columns`, because those two tables are
    targets of this migration and would fail on the first run write, and leave
    the rest to a dedicated migration. Same reasoning that kept the intake run
    rewrite out of this commit. A width change across the run log partitions
    is its own piece of work with its own way of going wrong, and bundling it
    here means a failure in either half rolls back both.

141. **`script/check-schema.ts` imports the physical table map instead of
    copying it, and talks to the database through the Supabase connector.**
    The gate has to resolve a row map key the same way the port resolves it, or
    it proves nothing. Options: duplicate the map in the script, read the map
    out of the source with a regex, export the map and the resolver from
    `db-postgres.ts` and import them, or generate a schema snapshot file and
    diff against it. Chosen: export and import. A duplicated map drifts, and a
    drifted copy of that map is the exact bug this gate exists to find. The key
    list itself is parsed from the `export interface RowMap` block, because a
    type cannot be enumerated at runtime and a hand kept list would drift for
    the same reason. Credentials never enter the script: the connector holds
    its own, and the script spawns it and strips the untrusted data envelope
    off the rows.

142. **`open_portal_requests_for_client` returned a row that was missing a
    field its own type promises.** The query selected ten of the eleven columns
    of `PortalRequestRow` and left out `requested_at`, so the same call gave a
    `requestedAt` under the memory port and `undefined` under Postgres.
    Options: drop the field from the row type, make it optional, have the
    memory port stop returning it, or add the column to the select. Chosen: add
    it to the select. The field is written on every insert and the aging the
    practice runs report needs it, so the type was right and the query was
    short.

143. **A run id is thirty one characters, and a sequence id is thirty three, and
    both numbers come from the minting code rather than from a count of what the
    columns hold.** `ids.ts` builds a run execution id as `RUNX-` in front of a
    twenty six character Crockford base32 ULID, and `sequence.ts` builds its own
    as `RUNSEQ-` in front of the same ULID. Options for what to call the true
    width: twenty six, on the theory that the prefix is display only, thirty one
    for every run id column with sequences folded in, thirty three everywhere so
    one number covers both, thirty one and thirty three kept apart, or a round
    forty with headroom. Chosen: thirty one and thirty three kept apart, taken
    from exported constants. The prefix is not decoration, it is stored, the
    probe below reads it back at full length, and two honest numbers describe
    two different ids better than one number that is wrong about both. The
    round number was tempting and was refused because nothing would then say
    where the limit came from.

144. **The columns became `text` with a named length check instead of a wider
    `char`.** Options: `char(31)`, `varchar(31)`, `text` bare, or `text` with a
    named check constraint. Chosen: the last one. `char` blank pads, and a
    padded id compares unequal to the id the run holds in memory unless every
    read trims, which is a promise no single query can keep. Bare `text` throws
    away the only statement the schema makes about the shape of the value.
    The check names itself, so a refusal arrives as `run_id_width` rather than
    as a value too long for type character(26), and widening later is a
    constraint swap on an unchanged column type.

145. **The forty columns that were already wide enough converted too.** Options:
    touch only the twenty seven narrow ones, touch every run id column, or
    split the file into a defect section and a tidy section. Chosen: every
    column. A schema where the same value is `char(26)` in some tables,
    `char(31)` in others and `text` in the rest invites the next author to pick
    whichever they saw last, and the gate added in 150 can only state one rule.
    The tables are all empty, so the rewrite costs nothing beyond the lock.

146. **The affected column list was derived from the row interfaces and the live
    catalog, not from the name of the column.** Options: match every column
    ending in `run_id`, grep the migrations, read the row interface field types,
    or take the previous report's list as given. Chosen: the field types, then
    reconciled against `information_schema`. A field typed `string` on a row
    interface is a framework minted run id and a field typed `Ulid` is an
    entity id that happens to sit in a column named for a run.
    `close_gate_results.close_run_id`, `cash_forecast_weeks.forecast_run_id`
    and `pay_register_entries.pay_run_id` are the second kind, each a foreign
    key into the table that mints the ULID, so widening them would break the
    reference and say something untrue. Nine more columns are the opposite case,
    real run ids the row map cannot reach, and they were read out of the
    migration text that created them. The previous report counted seventy seven
    columns across forty seven tables and this pass counts sixty seven across
    fifty two, and the divergence is explained in the report rather than split
    down the middle.

147. **Partitioned parents were altered once and the partitions followed.**
    Options: alter the parent, alter each of the twelve monthly partitions of
    `run_log` and `run_log_items`, detach and reattach around the change, or
    build new partitions and copy. Chosen: the parent alone. A type change on a
    partitioned table recurses to every partition by definition, and the
    verification count of a hundred and twenty eight run id columns includes
    the partitions, which is the proof the recursion happened. Naming the
    partitions in the file would have added a hundred and fifty lines that go
    stale the first month a new partition is created.

148. **`apply_migration` refused the first version of the `candidate_ids`
    conversion with 0A000, cannot use subquery in transform expression.** The
    using clause had an `unnest` inside an `array(select ...)` to trim the
    blank padding bpchar leaves behind. Options: drop the trim and accept
    padded ids in the json, cast the array to `text[]` first and let the
    documented cast rule do the trimming, create a helper function and drop it
    at the end of the migration, move the trim into a later data migration, or
    trim on read in the port. Chosen: the cast. A `char(n)[]` to `text[]` cast
    removes trailing blanks, which a probe confirmed before the rewrite went
    in, so `to_jsonb(candidate_ids::text[])` is both shorter than the subquery
    and legal where a subquery is not. Trimming on read was refused because it
    puts the padding problem in every caller.

149. **`subledger.vendors.aliases` moved to jsonb before anything wrote to it.**
    It was the last array column any mapped table had, a `text[]` with a gin
    index from migration 0005. Options: leave it, since no write path exists
    today, convert it now, fix `encodeParam` in the port to send a Postgres
    array literal, or keep a per column list of which arrays to stringify.
    Chosen: convert it. `VendorRow.aliases` is a `string[]`, so the first
    vendor insert through the port would have refused with the same 22P02 that
    `run_sequences.child_run_ids` did in migration 0019, and a defect that is
    only waiting for a caller is still a defect. The gin index was dropped and
    recreated on the jsonb column so an alias containment lookup still has an
    index, and the probe confirms `aliases @> '["PROBEVENDOR"]'` finds the row.
    Changing `encodeParam` was refused because the port already round trips
    jsonb correctly everywhere else and one encoding for arrays is easier to
    reason about than two.

150. **`script/check-schema.ts` grew two checks, and neither one carries a copy
    of the width.** Options: hard code thirty one and thirty three, import the
    constants from `server/runs/ids.ts`, derive the width by minting an id at
    gate time, or read the numbers out of the migration file. Chosen: import
    the constants, which is why `ids.ts` now exports `RUN_EXECUTION_ID_WIDTH`
    and `SEQUENCE_ID_WIDTH` and why `sequence.ts` mints through a shared
    `sequenceRunId`. A gate with its own copy of a number stops testing
    anything the day the prefix changes. The width check fails on any run id
    column that is a fixed width character type at all, not only a short one,
    because `char(31)` pads and is therefore the wrong type even at the right
    length. The array check is scoped to the tables the row map addresses,
    since an array column on a table no run can reach is not a defect the port
    can hit, and the same scoping is why a probe table with a `text[]` did not
    trip it while its `char(26)` run id did.

151. **The named queries in the port disagree with the column names in the
    database in fifty five places, and this migration deliberately did not
    touch them.** `run_log_items_by_execution` and
    `run_log_events_by_execution` select `run_execution_id` from tables that
    migration 0003 created with a `run_id` column, `journal_entries` is queried
    on `reversal_of` and has no such column, and thirteen queries pass an array
    parameter as `any($n::char(26)[])` or `any($n::uuid[])`, which `encodeParam`
    stringifies into a json literal that Postgres rejects with 22P02. All three
    were confirmed live. Options: fix the names and the casts here, fix only the
    thirteen casts, fix nothing and report, or fix the casts and add a gate that
    checks every named query against the catalog. Chosen: report, and recommend
    the gate. The rewrite is fifty five renames spread across a dozen features
    and it cannot be verified by running a query, because the queries fail for
    two independent reasons at once, so folding it into a width migration would
    produce a change nobody could review. The width fix is complete and
    provable on its own, and the drift is now written down with the evidence
    that found it.

152. **The migration README file table now runs to 0020.** It had stopped at
    0011 while nine files were added. Options: extend the table, replace it with
    a generated listing, delete it as a thing that will always rot, or add a
    note that it is partial. Chosen: extend it. Someone reading the directory
    for the first time wants one line per file in order, the table is nine rows
    behind and not wrong, and a generated listing needs a build step to keep a
    document honest that a person can keep honest in a minute.

153. **The mismatch list was derived from the queries rather than taken from
    the previous count of fifty five.** Options: trust the fifty five and fix
    that list, re derive from the row interfaces the way the previous pass did,
    derive from the named queries themselves, or derive from both and
    reconcile. Chosen: derive from the named queries and then reconcile against
    the fifty five. The fifty five was a comparison of row interface fields
    against columns, which is the write path. The thing that fails first is a
    named query, and a query names columns the row interface does not, so the
    two lists are different questions. Resolving all 98 queries against
    `information_schema.columns` gives 49 table and column pairs over 102
    identifier occurrences in 26 queries. The two reconcile exactly: 34 of the
    fifty five are columns no table had and migration 0021 adds them, 20 are
    columns that exist under another name, and one is `posted`. The six that
    are in the fifty five and not in the 49 are the fields whose select list
    already carried the right column and whose only broken path was the write.

154. **Array parameters are passed as json and unnested, and `encodeParam` is
    left alone.** Options: make `encodeParam` emit a Postgres array literal so
    the existing casts work, keep the encoder and rewrite the thirteen queries
    to unnest json, pass each element as its own numbered parameter, or build a
    typed array in SQL with `unnest`. Chosen: unnest the json. The encoder is
    not free to change. Migration 0019 and 0020 moved `candidate_ids`,
    `child_run_ids`, `related_ids` and `vendors.aliases` to jsonb precisely
    because the encoder sends an array as json text, and those columns are
    written through the same `encodeParam` on the insert path. An encoder that
    emitted an array literal would fix thirteen reads and break four writes,
    which is a worse trade than editing thirteen queries. Expanding the
    placeholder list means the SQL text varies with the length of the input,
    which defeats the plan cache and makes the catalog unparseable by a gate
    that reads static text. A typed array constructed in SQL is the same array
    literal problem one layer in. The form used is
    `= any(select jsonb_array_elements_text($n::jsonb))`, which takes exactly
    what the encoder already produces.

155. **A rename is fixed in the query, not in the database, and the write path
    reads the same map.** Options: rename the columns in the database, alias in
    the query and leave the write path alone, alias in the query and give the
    port one map both paths use, or rename the TypeScript fields to match the
    columns. Chosen: one map. The schema is applied, verified and described in
    the README, so a rename there is a migration, a lock and a second thing to
    keep in step. Renaming the fields would touch every run and every test for
    no gain in truth. Aliasing only the select list fixes the read and leaves
    `insert` writing `trigger_source` as `source`, which is the same defect
    facing the other way and invisible for the same reason, so
    `COLUMN_OVERRIDES` is used by `insert`, `update` and the gate.

156. **`journal_entries.posted` is read from `status` and written into it, not
    given a column.** Options: add a boolean column, read it as
    `status = 'posted'` and give the override a write conversion, change
    `JournalEntryRow` to carry the status string, or drop the field. Chosen:
    the expression and the conversion. `status` already distinguishes draft,
    posted, reversed and void, and the `je_posted_complete` constraint is
    written against it. A boolean beside it is two places saying one thing, and
    the first row where they disagree has no answer.

157. **`reversalOf` is `reverses_entry_id` and not `reverses_on`.** Options:
    take the Postgres near miss suggestion, read migration 0002 and use what it
    created, add a `reversal_of` column, or rename the field. Chosen: read the
    migration. `reverses_on` is the date an auto reversing accrual undoes
    itself, added by 0013, and `JournalEntryRow` already has it as `reversesOn`
    next to `reversalOf`. Following the suggestion would have compared an entry
    id to a date and would have type checked and failed live, which is the
    exact shape of failure this whole task exists to remove.

158. **The run log event counts became columns rather than keys in `detail`.**
    Options: add the ten columns, read and write them through the existing
    `detail` jsonb, move the consumers to read the counts off `run_log`, or
    drop them from the event row. Chosen: the columns. Doc 04 Part 8 put the
    counts on `run_log`, which holds the final state of a run and loses the
    state at each event, and a retried run emits two terminal events whose
    counts differ. Packing them into `detail` puts the same class of defect one
    layer down, where a catalog check cannot see it, and makes every reader
    parse json for values the framework already holds as scalars.

159. **`journal_lines.entry_date` is a copy of the parent entry date.**
    Options: add the column, join to `journal_entries` in the four queries that
    need it, derive it in the port after the read, or drop it from the line
    row. Chosen: add the column. The line is the grain the port writes and the
    grain every period report groups by, the balanced entry trigger already
    holds lines and their entry together so the copy cannot drift unnoticed,
    and a join would leave the write path with nowhere to put the value the
    row shape carries.

160. **The rule ceiling column is `auto_post_ceiling_cents`.** Options: name it
    `auto_post_ceiling` as the query did, name it `auto_post_ceiling_cents` as
    the field and the insert path do, or keep both. Chosen: the cents suffix.
    The field is `autoPostCeilingCents`, it is in `CENTS_FIELDS`, and every
    other money column in the database ends in `_cents`. The query had already
    disagreed with its own write path, which is how the name was noticed.

161. **`script/check-queries.ts` also fails on a parameter cast and on a stale
    column override.** Options: check identifiers only, check identifiers and
    casts, check identifiers and the write path map, or check all three.
    Chosen: all three. A cast to an array type is unreachable from the encoder,
    fails live with 22P02 and type checks cleanly, which is the same class of
    defect as a missing column. A stale override fails a write rather than a
    read, and a gate that only reads would never see it. It was tested by
    breaking one query each way: restoring `run_execution_id` in
    `run_log_items_by_execution` gave
    `run_log_items_by_execution: ledger.run_log_items has no column
    run_execution_id`, and restoring `any($3::char(26)[])` in
    `journal_lines_for_entries` gave the cast message with the 22P02
    explanation. Both were restored.

162. **Every corrected query was proved by preparing and executing it against
    the live database inside a transaction that was rolled back.** Options:
    trust the gate, prepare each query, prepare and execute each query with
    values of the inferred parameter types, or write fixtures and assert on
    rows. Chosen: prepare and execute. Preparing resolves the identifiers,
    which the gate already does, and only executing tests the value the encoder
    sends. It earned its place immediately: the surviving `uuid` cast on
    `transactions_in_window` was still wrong after the identifiers were fixed,
    because `ledger.transactions.bank_account_id` is `char(26)` and not
    `uuid`, and the query failed with `operator does not exist: character =
    uuid`. Nothing that only type checks would have found it. Fixtures would
    prove more and would need rows in a database with foreign keys into four
    other schemas, which is a separate piece of work.

163. **`QUERIES` is exported from the port so the gate reads the catalog rather
    than a copy of it.** Options: export the catalog, parse the source text of
    `db-postgres.ts` in the gate, keep a list of query names in the gate, or
    move the catalog to its own module. Chosen: export it, for the reason
    `check-schema.ts` imports `PHYSICAL_TABLES`. A parser over source text is a
    second grammar to maintain, and a copied list is the drift the gate exists
    to find.

164. **`import.batches` and `import.staged_rows` gained the `version` column
    every other run table has.** Options: add the column, drop `version` from
    the two row shapes, treat the import pipeline as single writer, or add an
    updated at timestamp instead. Chosen: add the column. The port's `update`
    path and every other table a run writes use `version` for optimistic
    concurrency, and leaving these two out makes the import pipeline the one
    place where two runs overwrite each other silently.

165. **The connector call moved into `script/connector-sql.ts` and retries a
    transport failure.** Options: leave the call copied in both gates, retry
    inside each copy, extract one module both import, or have the gates read a
    catalog snapshot committed to the repo. Chosen: extract and retry. A full
    gate run failed once on a 504 from the connector while the database was
    healthy and the same command passed on the next attempt, and a gate that
    fails at random trains people to rerun it until it goes green, which is
    worse than having no gate. Three attempts with a short backoff covers the
    gateway, and a SQL error is still returned immediately because that one is
    the answer. A committed snapshot removes the network and with it the whole
    point, since the question the gate asks is what the database looks like
    now.

166. **The push to main went through the platform credential preset rather
    than a token written into git config.** Options: put the agent proxy token
    in a credential helper, send it as an Authorization header, write it to
    `~/.git-credentials`, push the tree through the GitHub connector instead,
    or run the push under the platform credential preset. Chosen: the preset.
    A plain `git push` failed with no username, the token in a helper and the
    same token as a bearer header both returned 403, and the token as the
    username returned 500, so the proxy clearly wants credentials it supplies
    itself. Writing a token into the repo config or into a dotfile leaves a
    secret on disk for the next agent to find, which is the same rule that
    keeps the database password out of this work.

167. **`pg` and `@types/pg` installed, and the structural declarations needed no
    change at all.** `PgPoolLike` and `PgClientLike` were written by hand because
    the driver was deliberately absent, so the first question was how far the
    real types differ. Options: import the driver types into the port and delete
    the declarations, keep the declarations and adjust them to fit, keep them and
    assert compatibility somewhere that the type checker sees, or leave the
    driver out and keep the port unexercised. Chosen: keep the declarations, and
    assert compatibility with two assignments in `server/db/pool.ts` that
    `npx tsc --noEmit` checks. `pg.Pool` satisfies `PgPoolLike` and
    `pg.PoolClient` satisfies `PgClientLike` unmodified, including
    `rowCount: number | null` and the unconstrained row generic, so nothing was
    adjusted and nothing differed. Importing the driver types into the port would
    tie 2400 lines of query catalog to one driver's type surface for no
    correctness gain, and the port needs four methods.

168. **The port was setting four session variables the database does not read,
    and neither of the two it does.** `tenancy.current_actor()` in migration 0001
    reads `app.user_id`, and the override guard in migration 0003 arms on
    `app.run_id` being present. The port sent `app.firm_id`, `app.client_id`,
    `app.actor_id` and `app.actor_kind`, which nothing in the schema reads. The
    consequence is not cosmetic: every row level security policy calls
    `has_client_access`, which resolves the actor through `current_actor()`, so
    under the app roles every policy saw null and denied everything, and the
    override guard never fired, which means a run could have written over a row a
    person had protected. Options: change the two SQL functions to read the names
    the port sends, send the names the schema reads, send both sets, or rename
    the port's four to match and accept a change at every call site. Chosen: send
    both sets, with `app.user_id` and `app.run_id` added and the original four
    kept. Changing the functions is a migration against the one contract doc 04
    Part 0 states, and `app.user_id` is the name the doc uses. Renaming inside
    the port loses the four settings, which cost one round trip that was already
    happening and are what somebody reads out of `pg_stat_activity` when working
    out which tenant a stuck transaction belongs to. Every one of the six is
    transaction local, the third argument to `set_config`, so a pooled connection
    handed back with leftover state cannot leak a tenant into the next
    transaction. That is the answer to whether the pool defeats the context: it
    cannot, because there is no session level state to leave behind.

169. **`runId` is a new optional field on `TxSession` rather than a value the
    port invents.** The override guard needs a run id present to fire, and the
    port had no way to know one. Options: set `app.run_id` to the actor id, set
    it to a fixed placeholder whenever the actor kind is not human, add the run
    execution id to `TxSession` and thread it through `execute`, or derive it
    inside the port from the actor kind alone. Chosen: the field, threaded from
    `execute` and from `runSequence`. A placeholder would arm the guard, which is
    the important half, but the value ends up in nothing today and would end up
    in a log line tomorrow naming an execution that never existed. The field is
    optional so the in memory port and the tests are untouched, and it is set on
    the read only transactions too, because a read taken under a different
    identity than the write it justifies is not evidence of anything.

170. **Pool size ten, statement timeout thirty seconds, acquisition timeout ten
    seconds, idle timeout thirty seconds.** Options considered for the size: the
    driver default of ten, one per expected concurrent run, a large number on the
    theory that the pooler absorbs it, or a computed fraction of the project's
    connection allowance. Chosen: ten, which happens to match the default and is
    kept for a stated reason rather than by accident. A run holds a connection
    for one transaction, runs are triggered by people pressing buttons rather
    than by request volume, and Supabase shares a few hundred client connections
    across the whole project including the dashboard. Ten leaves room for several
    processes without one of them exhausting the project. Thirty seconds for a
    statement, because the slowest thing a run does is a bounded date window read
    on an indexed tenant pair, so anything reaching thirty seconds is stuck
    rather than slow and failing loudly beats a request that never returns. The
    idle timeout matters more on a pooler than it looks: an idle connection this
    process holds is one the project cannot give anybody else.

171. **TLS is set in code, not through `sslmode` in the connection string.**
    Options: require the operator to append `sslmode=require`, set `ssl` in code
    with certificate verification off, set it in code with a pinned Supabase
    root certificate committed to the repository, or read a certificate from an
    optional environment variable and verify when it is present. Chosen: set in
    code, verification off by default, with `PGSSLROOTCERT_PEM` honoured when the
    operator supplies it. A parameter in the URL is a thing that gets dropped
    when a string is copied between environments, and a silent fallback to
    plaintext sends every ledger row and the password itself across the network
    in the clear. A committed certificate expires and becomes a support ticket
    somebody resolves by turning verification off. This encrypts, which defeats a
    passive listener, and `docs/RUNNING.md` says plainly that it does not by
    itself defeat an active man in the middle and what to set when that matters.

172. **Port selection defaults to memory outside production and to Postgres
    inside it, and refuses rather than falling back.** Options: default to
    Postgres everywhere and let developers set `RUN_DB=memory`, default to memory
    everywhere and let production set `RUN_DB=postgres`, key it on `NODE_ENV`, or
    key it on whether `DATABASE_URL` happens to be present. Chosen: key it on
    `NODE_ENV`, with `RUN_DB` as an explicit override in both directions.
    Keying on the presence of `DATABASE_URL` is the dangerous one, because a
    typo in the secret's name silently becomes a month of bookkeeping into a
    store that vanishes on restart. Defaulting to Postgres everywhere breaks
    every developer machine and the test suite. The refusal lives in
    `server/index.ts` before any route is registered, so a misconfigured deploy
    fails to start and the platform reports it, rather than starting and failing
    on the first run somebody tries.

173. **`db:verify` runs the run through a savepoint harness inside a transaction
    it rolls back, rather than relying on preview writing nothing.** Preview
    posts no journal entries, but it does commit run log evidence in a short
    follow up transaction, by design, and the brief's description of preview as
    writing nothing is therefore not quite right. Options: run preview and accept
    the log rows, run preview and delete the log rows afterwards, wrap the port
    in an outer transaction and map each inner transaction to a savepoint, or
    skip the run step and verify only the reads. Chosen: the savepoint harness,
    `PostgresSavepointRunDb`. Accepting the log rows means a verification command
    the operator is told to run whenever something looks wrong writes to the
    audit trail every time, and an audit trail with test rows in it is weaker
    evidence. Deleting them afterwards is worse, because the log is insert only
    by trigger and a delete path would have to defeat that. Verifying only reads
    leaves the thing the whole task exists to prove unproven. Two honest
    limitations are written next to the class: a savepoint cannot change
    isolation level and cannot make a writable transaction read only, so the
    harness runs everything at the outer serializable level. Nothing survives the
    rollback, so neither limitation can affect anything but the verification.

174. **`db:verify` picks its firm, client and user out of `tenancy.memberships`
    instead of taking them from the environment.** Options: three more
    environment variables, hard coded ids, the first row of `tenancy.clients`, or
    a join that reproduces the body of `has_client_access`. Chosen: the join. The
    first client row is not necessarily one any user can see, so the run would
    fail on a policy denial that looks exactly like a broken wire, which is the
    ambiguity this command exists to remove. More environment variables mean more
    for the operator to get wrong on the one command they have to get right, and
    hard coded ids belong to whichever database they were copied from. When the
    join returns nothing the step is a skip and not a failure, because an empty
    database is a correct database that nobody has onboarded a client into yet.

175. **Three verdict words and three exit codes, with `INCOMPLETE` in the
    middle.** Options: pass or fail only, with a skip counting as a pass; pass or
    fail only, with a skip counting as a fail; a third verdict with its own exit
    code; or per step exit codes. Chosen: the third verdict, exit code 2. A skip
    counted as a pass tells the operator the run path works when it was never
    executed, and a skip counted as a failure sends somebody looking for a
    connection fault on a perfectly good connection to a database that simply has
    no clients in it yet. The one command has to give one unambiguous answer, and
    the honest answer here is a third one.

176. **The `RowMap` key parser moved to `script/row-map-keys.ts`.** `db:verify`
    asks the same relation existence question of the live connection that
    `check-schema.ts` asks through the connector, and it has to resolve keys the
    same way or it proves something weaker than it claims. Options: import the
    function from `check-schema.ts`, which runs its checks at import time and
    would run them twice; copy the parser; have `db:verify` shell out to
    `check-schema.ts`; or extract the parser. Chosen: extract. A copied parser is
    the drift the gate exists to find, and shelling out would make `db:verify`
    depend on the Supabase connector being reachable, which is a second failure
    mode in a command whose whole purpose is to isolate one.

177. **A throwaway local Postgres to prove the harness end to end was attempted
    and abandoned.** The savepoint harness and the pool are the two pieces no
    gate in this repository can exercise, so the idea was a local Postgres 17,
    the migrations applied, a seeded tenant, and `db:verify` run against it.
    Options: an embedded Postgres binary with password authentication disabled so
    that no password exists anywhere, an embedded Postgres with a password
    invented locally, a Postgres emulator in JavaScript, or no local proof and a
    report that says exactly what is unproven. Chosen: no local proof. Disabling
    authentication on a database server is a thing that gets left behind and
    copied, and it was refused by the sandbox for exactly that reason, which was
    the right call. Inventing a password, even a throwaway one for a listener on
    localhost, is the habit this task exists to avoid, and an emulator does not
    implement savepoints and isolation levels faithfully enough for the proof to
    mean anything. The failure modes of the harness are instead narrowed by type
    checking, by the structural assertion in `pool.ts`, and by the two schema
    gates, and what remains unproven is stated plainly in the report.

178. **The driver is external to the server bundle and absent from the client
    bundle, checked rather than assumed.** `script/build.ts` externalises every
    dependency that is not on its allowlist, so `pg` needed no build change, but
    a native driver quietly bundled into browser code would be the defect the
    brief warned about. Options: add `pg` to the esbuild allowlist, leave it
    external, mark it external explicitly in `vite.config.ts` as well, or add a
    gate that greps the built assets. Chosen: leave it external and verify by
    inspection of the output. `dist/index.cjs` contains one `require("pg")` and
    the client bundle contains no trace of the driver, its connection string
    parser, or its authentication code. A grep gate was considered and left out
    because the build already fails loudly if a browser bundle reaches for
    `node:net`, and a gate that only greps for one package name would not catch
    the next one.

179. **Migrations stay on the Supabase connector, and the direct connection is
    documented rather than used.** Doc 04 Part 13 requires schema changes over a
    direct connection and never over a transaction mode pooler, because a
    migration depends on session state a pooler may hand to somebody else between
    statements. Options: add a migration runner to this repository that uses
    `DATABASE_URL`, add one that requires a separate `MIGRATION_DATABASE_URL`,
    keep applying migrations through the connector and document both forms, or
    say nothing about it. Chosen: keep the connector and document both forms in
    `docs/RUNNING.md`, with the port numbers, the user name difference, and the
    reason the pooler is wrong for the job. A migration runner in this repository
    would need the credential the whole task is built around not having, and
    every migration so far has been applied through the connector without one.

180. **The in process ticker is withdrawn.** Earlier work planned a scheduler
    inside this Express process: a `setInterval` waking once a minute, reading a
    cadence table, and starting runs in the same memory the web requests live
    in. That plan is cancelled. The operator has installed the Trigger.dev
    GitHub app and created a project, and building a second scheduler beside it
    would mean two things that both believe they own the clock. Options: keep
    the in process ticker and ignore Trigger.dev, keep it as a fallback for when
    Trigger.dev is unreachable, keep it for local development only, or withdraw
    it entirely and let one thing own the clock. Chosen: withdraw it entirely.
    A fallback ticker is the worst of the four, because the failure it covers is
    exactly the failure where it cannot tell whether the other scheduler also
    ran. Local development gets `npm run sched:status` and a directly callable
    `tick()`, which is enough to see what a tick would do without a second
    daemon existing. The cost of the withdrawal is real and is stated in the
    report: this process no longer runs anything on its own, so a firm with no
    Trigger.dev deployment has no automation at all.

181. **Tasks that connect straight to Postgres, over three other shapes.** The
    question is what a Trigger.dev task actually does when it wakes. Options:
    (a) the task calls an HTTP endpoint on this server and the server does the
    work, (b) the task connects to Postgres directly and runs the work in the
    task process, (c) the task enqueues a message and a worker in this process
    drains the queue, (d) one Trigger.dev schedule per client per run, created
    through their API, with the payload carrying everything. Chosen: (b).
    Option (a) needs an authenticated endpoint that starts privileged work,
    which is a new attack surface protecting the least protected thing in the
    system, and it means a slow run holds an HTTP connection open for minutes.
    Option (c) reinvents the queue that was just adopted. Option (d) puts the
    firm's client list inside somebody else's dashboard and makes signing a
    client a two system operation that can half fail. Option (b) keeps every
    decision in code this repository tests, needs no new endpoint, and the only
    thing that crosses the boundary is a `DATABASE_URL` set in their dashboard,
    which the deploying operator sets once and this repository never sees.

182. **Four declared schedules, not one per client.** Following from 181,
    Trigger.dev holds four cron declarations and nothing about any client.
    Options: one schedule per client per run type through their imperative API,
    one schedule per run type, one schedule per cadence, or a single schedule
    that ticks every minute. Chosen: one per cadence, plus a sweep. A single
    minute ticker means 1,440 task runs a day to discover that nothing is due,
    which is somebody's bill. A schedule per client grows their dashboard every
    time the firm signs one and adds an API call that can fail independently of
    the database row. Four coarse wake up calls, with the real cadence in
    `sched.schedules` where a person can read and change it, means the clock is
    theirs and the meaning is ours.

183. **`sched.run_policies` is global reference data with no tenancy columns.**
    Every other table added since migration 0001 carries `firm_id` and
    `client_id` and a `client_isolation` policy. This one does not, and the
    departure is deliberate. Options: tenant scoped like everything else, global
    with row level security disabled, global with row level security enabled and
    a read only policy, or no table at all with the tiers living only in
    TypeScript. Chosen: global, row level security enabled and forced, a policy
    that permits `select` and nothing else. A tier is a property of the
    software, not of a tenant: a per client tier would mean one client's
    configuration could make `CLOSE-LOCK-PERIOD` unattended, which is precisely
    the thing the tier exists to prevent. Granting only `select` to `app_web`
    and `app_worker` means nothing the application runs can reclassify a run.
    Changing a tier is a migration, which is the point. Keeping the tiers only
    in TypeScript was rejected because the caller is now outside this process,
    and a boundary a database does not know about is a boundary a database
    cannot enforce.

184. **The compliance boundary is three constraints and two guards, not one
    check.** Options: check the tier in the Trigger.dev task, check it in the
    executor, check it in the database, or all of them. Chosen: all of them,
    because each catches something the others cannot. `sched_tier_never_manual`
    means a manual run cannot be written into `sched.schedules` at all.
    `sched_mode_matches_tier`, anchored by the composite foreign key
    `(run_type, tier)` into `sched.run_policies`, means a propose run cannot be
    scheduled in apply mode even by an insert written by hand. `guardScheduledRun`
    in `server/runs/policy.ts` runs inside `execute()` when the caller sets
    `unattended`, before the scope is frozen and before a log row exists, so a
    caller that reached the executor another way is still refused with
    `TIER_REFUSED`. And `runWindow` checks the tier before it claims anything,
    so a window that could never succeed fails immediately with a readable
    reason rather than deep inside a run. The duplication is the design: the
    caller now lives outside this process and cannot be assumed to have read
    anything.

185. **Cadences are four named shapes, not cron strings.** Options: store a cron
    expression per schedule, store a cron expression plus a timezone, store a
    small enumerated cadence with its own columns, or store an arbitrary rule
    expression. Chosen: four named cadences with a `cadence_shape` check
    constraint that permits exactly the columns each one needs. A close calendar
    is written in business days, and "the third business day of the month" has
    no cron expression at all, so a cron column would have needed an escape
    hatch on the day it shipped. A named cadence is also readable in
    `npm run sched:status` without a person parsing five asterisks, and the
    check constraint means a weekly schedule carrying a day of month is a row
    the database refuses rather than a row two readers disagree about.

186. **Window boundaries are computed in the named zone here, not delegated to
    the platform's cron timezone.** Trigger.dev's cron does accept a timezone
    and the declared ticks use it, so they fire at six in the morning in Denver
    through the year. That is a wake up call, not a record. Options: trust their
    timezone handling and take the fire time as the window, store windows in UTC
    and accept the hour of drift twice a year, use a date library, or compute
    the boundaries here with `Intl.DateTimeFormat`. Chosen: compute here, with a
    two pass offset resolution in `server/runs/dates.ts`. The interval between
    two consecutive six am fires in Denver is 23 hours once a year and 25 hours
    once a year, and both are covered by tests dated 2026-03-08 and 2026-11-01.
    A date library was rejected because Node already carries the full IANA rule
    set in its ICU data and a second copy of the daylight saving rules is a
    second thing to keep current. The two edge cases are answered rather than
    hidden: the hour that does not exist resolves adjacent, the hour that
    happens twice resolves to the first, and both are written into the function
    comment and the tests.

187. **Two firm wide named queries, against the client scoped habit of the
    catalog.** Every other query in `QueryCatalog` takes a `clientId`. A tick has
    to ask what is due anywhere in the firm before it knows which clients it is
    about to touch. Options: iterate clients and run the client scoped query per
    client, add a firm wide query, have the Trigger.dev payload carry the client
    list, or keep a separate list of active clients in the scheduler. Chosen: two
    firm wide queries, `sched_due_schedules_for_firm` and
    `sched_outstanding_windows_for_firm`. Row level security still answers them
    correctly, because `tenancy.has_client_access` keys on the actor's
    memberships rather than on a session variable, so a firm scope service actor
    sees its firm and nothing else. Iterating clients would mean a query per
    client per tick to discover that most of them have nothing due, and putting
    the client list in the payload would put it in somebody else's dashboard,
    which 182 already refused.

188. **The catch up bound is seven days and seven windows, whichever binds
    first.** Options: no bound and replay everything, one window and treat a gap
    as lost, ninety days, or a small bound with the overflow recorded rather
    than discarded. Chosen: seven and seven, with every window outside the bound
    written to `sched.windows` as `skipped` with its reason, so a gap is visible
    in `npm run sched:status` instead of absent from it. Seven days because a
    nightly derived refresh lands on the same answer when it is replayed, so
    seven catch ups cost seven runs and produce one correct state, while ninety
    re derives history whose inputs have since changed and may now be in a
    locked period. Seven windows because the same bound covers a daily, a
    weekly, and two monthly cadences, and the count is the one that binds for
    anything firing more often than daily. And a gap longer than a week is an
    outage somebody should look at, not something a sweep absorbs at 3am.

189. **A unique constraint, not an advisory lock, is what makes a retry safe.**
    The run framework already has `tryAdvisoryXactLock`, and the obvious move was
    to lock a schedule for the duration of a tick. Options: an advisory lock per
    schedule, a `for update skip locked` claim, a status column transition, or a
    unique constraint on the window row. Chosen:
    `unique (schedule_id, window_start)` on `sched.windows`. A lock is held by a
    connection, and a Trigger.dev retry is a different connection minutes later,
    so a lock says nothing about whether the work already happened. The
    constraint says exactly that, permanently, and it says it to any caller from
    any process in any deployment. The memory port carries the same guard in
    `guardScheduledWindow`, so the suite refuses what Postgres refuses and a test
    cannot pass on behaviour the real store would reject.

190. **An unattended schedule previews before it applies.** Doc 03 Part 2 says
    apply re derives from a preview and never trusts a caller's plan, and the
    question was whether that survives contact with a clock. Options: let a
    scheduled apply skip the preview by setting `requirePreviewForApply: false`,
    add a scheduler specific apply path, run preview then apply, or make every
    schedule propose tier and never apply anything unattended. Chosen: preview
    then apply, naming the preview, which is exactly the sequence a person
    pressing the button produces and leaves the same two log rows. Skipping the
    preview would have made the scheduled path the only one in the system that
    posts without a re derivation, and the one place that shortcut would first
    be noticed is a client's books.

191. **The Trigger.dev deploy variable is `TRIGGER_ACCESS_TOKEN`, and the brief's
    `TRIGGER_SECRET_KEY` is a different thing.** Their current documentation is
    clear: `TRIGGER_ACCESS_TOKEN` is a personal access token that authenticates
    the CLI for `deploy` in CI, and `TRIGGER_SECRET_KEY` is the environment
    specific key the backend SDK uses to trigger and read runs from outside a
    task. Nothing in this design triggers a task from this server, so
    `TRIGGER_SECRET_KEY` is never needed here at all. Options: follow the brief
    and read `TRIGGER_SECRET_KEY` in the config, read both, read neither and
    document the divergence, or invent a wrapper variable. Chosen: read neither.
    `trigger.config.ts` reads `TRIGGER_PROJECT_REF`, which is an identifier out
    of the dashboard URL and not a credential, and throws a message naming the
    variable when it is missing. Authentication is left to the CLI, by
    `npx trigger.dev@latest login` on a laptop or `TRIGGER_ACCESS_TOKEN` in CI,
    so no credential is read, stored, or referenced by anything committed here.

192. **The registry holds forty nine runs, not the forty seven the brief names.**
    Counted rather than assumed: `server/runs/registry.ts` exports forty nine
    entries and the stale header comment above it still says forty one. All
    forty nine are classified, and a test asserts that every registry entry has
    a policy entry, that the reverse holds against `sched.run_policies`, and
    that no run with `writesLedger: true` is classified unattended. A run added
    later with no policy is refused by `guardScheduledRun` rather than assumed
    safe, and `script/check-schema.ts` fails when the database and
    `server/runs/policy.ts` disagree about any tier, reason, or ledger flag.

## Login, actors, and the row level security that was not live

193. **Supabase Auth over WorkOS, Clerk, or a home grown table.** Migration
    0001 wrote `auth_subject` as "sub from WorkOS or Clerk". Options: WorkOS,
    Clerk, Supabase Auth, or passwords in a table of our own. Chosen: Supabase
    Auth. The project is already there, the admin API sends the invitation and
    recovery emails without a mail provider of our own, and the tokens verify
    locally against a published key set so the auth server is not on the
    request path. A table of our own was refused because hashing passwords
    and running a recovery flow is not this product's job. WorkOS and Clerk
    add a vendor for a problem the existing vendor already solves. The column
    comment in 0001 is now out of date by two names; the column itself fits.

194. **Two verification paths, chosen from the token header.** Supabase
    projects on JWT signing keys issue ES256 or RS256 tokens with a `kid`
    that resolves against `/auth/v1/.well-known/jwks.json`; older projects
    issue HS256 with a shared secret this server does not hold. Options:
    require signing keys and refuse HS256, hold the shared secret in an env
    variable, or ask the auth server to validate HS256 tokens. Chosen: JWKS
    first, and for an HS256 header call `/auth/v1/user` with the anon key.
    Holding the secret was refused because a leaked secret mints tokens for
    anyone; the anon key cannot. The path is decided per token so a project
    that migrates to signing keys needs no code change.

195. **The postgres role bypasses row level security, so the policies were
    decorative.** Found while writing the test for `withActor`: on Supabase
    `postgres` carries `BYPASSRLS`, confirmed on this project
    (`rolbypassrls = true`). Every connection string the dashboard offers is
    that role, so a server connecting with it is exempt from every policy
    written since 0001. Options: a dedicated login role in the connection
    string, `set local role app_web` inside each actor transaction, or accept
    it and rely on the API's own membership checks. Chosen: `set local role`
    inside `withActor`, governed by `APP_DB_ROLE`, with the grants `app_web`
    needs in migration 0023. A login role in the connection string was
    refused because credentials are managed outside migrations and the
    operator would have had to mint and rotate a second password. Relying on
    the API alone was refused because it is exactly the quiet failure the
    policies exist to prevent. The suite proves both sides on real Postgres:
    with the switch a client scoped actor reads one client's engagements,
    without it the same actor reads all three.

196. **`APP_DB_ROLE` is an env variable, not a hard default.** Options: always
    switch to `app_web`, switch only when configured, or switch and fall back
    silently on error. Chosen: switch only when configured, log once at
    startup when not. Always switching was refused because a grant the
    migration missed would turn every route into a 500 on deploy day with no
    way back short of a code change; the variable is the way back. Silent
    fallback was refused outright. `.env.example` sets `app_web`.

197. **PGlite for the database tests.** Entry 177 chose a scripted pool over
    a throwaway local Postgres because the sandbox cannot run a listener.
    PGlite is Postgres compiled to WebAssembly and runs in process with no
    listener, no password, and no port. Options: scripted pool only, PGlite,
    or a live connection gated on `DATABASE_URL`. Chosen: PGlite as a dev
    dependency, and every file in `db/migrations` is applied to a fresh
    instance at the start of the auth tests. Twenty three migrations apply in
    about five seconds. A gated live test was refused because a test that
    only runs on one machine is a test nobody runs. The scripted pool stays
    for the statement sequence assertions, where it is the right tool.

198. **A client user could read the firm's other clients.** 0001 protected
    `tenancy.clients` with `firm_isolation`, which is `has_firm_access`, which
    any membership in the firm satisfies, including a client scoped one. So a
    client user could list every other client's name and entity type.
    Options: leave it, tighten `has_firm_access` to firm scope only, or give
    the clients table its own policies. Chosen: own policies in 0023, select
    through `has_client_access(id)`, insert and update through a new
    `is_firm_staff(firm_id)`. Tightening `has_firm_access` was refused because
    other tables lean on its current meaning and a change there is a change
    everywhere. The PGlite test asserts the client user sees one row.

199. **Invitations are a users row and a memberships row, not a table.**
    Options: an `invitations` table with a token and state machine, or the
    rows 0001 already has. Chosen: the existing rows. Supabase holds the
    token and the acceptance state (the person has set a password or
    followed the link), and the first authenticated request stamps
    `users.last_seen_at`, which is what the Access page shows as accepted.
    `invited_by` on users records who sent it, `granted_by` on memberships
    already recorded who granted the access. A table of our own would have
    duplicated the state Supabase keeps and drifted from it.

200. **Revocation disables the login only when nothing active remains.**
    A person can hold a firm membership and a client membership at once.
    Options: disable the auth user on any revocation, on the last one, or
    never. Chosen: on the last one, with a ban through the admin API so the
    refresh token dies. The actor middleware reads `revoked_at` and
    `disabled_at` on every request, so an access token still in a browser
    stops working at its next request regardless. A firm keeps at least one
    owner, and nobody revokes themselves; both are 409s with their own codes.

201. **An existing login gets no email.** Inviting an address that already
    has a Supabase user cannot send an invitation (the API refuses with
    `email_exists`). Options: send a magic link from the server, send a
    password reset, or send nothing and say so. Chosen: nothing, with
    `emailSent: false` in the response and a sentence on the Access page
    pointing them at the sign in page's "Email me a link". The lookup uses
    `generateLink` because it is the only admin call that returns a user by
    email without paging through every user; the link it makes is discarded.

202. **Sign in follows the database.** Options: require the Supabase variables
    always, require them only with Postgres, or make sign in optional
    everywhere. Chosen: required with Postgres, off in memory mode with a
    startup line saying so. There is no tenancy schema to resolve a login
    against in memory, and the developer loop (no database, demo data in the
    browser) is worth keeping. The browser asks `/api/auth/config`, which
    says `configured: false`, and renders without a login screen. A
    production process missing any of the four variables refuses to start
    and names them, the same way `DATABASE_URL` does.

203. **The anon key is served by the API, not baked in at build.** Options:
    `VITE_` variables at build time or a public config route. Chosen: the
    route. The key is public by design, the build then has no environment of
    its own, and the pipeline that builds the bundle does not need to know
    which project it will talk to. The route is rate limited with the public
    limiter.

204. **The hash router and the Supabase redirect share the hash.** Invitation
    and recovery links put the token in the URL fragment, and this client
    routes on the fragment. Options: switch to path routing, or capture the
    link type before the Supabase client consumes the fragment and then hand
    the hash back to the router. Chosen: capture and hand back. Path routing
    would have changed every link in the app for one page.

205. **Firm selection lives in memory.** The CI guard forbids web storage in
    the client, and the Access page needs a firm for a user in several firms.
    Options: break the rule for one key, put the firm in the URL, or keep it
    in memory and default to the first firm after a reload. Chosen: memory.
    The multi firm user is rare, picking again after a reload costs one
    click, and the rule stays whole. The Supabase client persists its own
    session in storage when storage exists and falls back to memory when it
    does not; that is inside the library and not this code.

206. **The CI credential guard gets one carve out.** The guard fails on
    `type="password"` anywhere in the client, written when the only password
    anyone could imagine was a bank password. A sign in screen needs one.
    Options: drop the guard, dodge it with `type={"password"}`, go magic link
    only, or exclude the sign in directory. Chosen: exclude
    `client/src/pages/auth` and say why in the workflow. Dodging a guard is
    lying to it. Magic link only was tempting and would have kept the guard
    whole, but the brief asks for the Supabase reset flow, which implies a
    password, and a bookkeeper at 7am wants one.

207. **Request bodies are not logged any more.** The old request logger
    captured every JSON response under `/api` into the log line. With auth
    routes that is memberships and email addresses on every line, forever.
    Options: keep it with redaction, keep it for non auth routes, or drop
    bodies entirely. Chosen: drop them; method, path, status and time remain.
    Redaction lists are a promise nobody keeps.

208. **The scheduler status route takes the firm from the actor.** It used
    to read `SCHEDULER_FIRM_ID` because the server had no idea who was
    asking. It now sits behind `requireFirm` and uses `req.firm.firmId` and
    `req.actor.userId`. The env pair stays for the Trigger.dev tasks, which
    run with no human on the request.

209. **Removed the scaffold the brief named, and nothing else.** passport,
    passport-local, express-session, memorystore, drizzle-orm, drizzle-zod,
    drizzle-kit, better-sqlite3 and their types are gone, with
    `server/storage.ts`, `shared/schema.ts`, `drizzle.config.ts` and the
    `db:push` script. The `@shared` path alias stays in tsconfig and vite
    because other work uses it. The audit before and after is in the brief
    report; the eight remaining advisories are all transitive through
    `@trigger.dev/sdk` and `vite`, and none is reachable from a request.

210. **Statement sequence in `withActor`.** `begin`, then `set local role`
    when configured, then one `select set_config(...)` for both keys, then the
    work, then `commit`. `app.run_id` is set to the empty string rather than
    left alone because a pooled connection may have carried a run id from the
    runs path; transaction local or not, a blank is a statement of fact and
    an absent key is a hope. A throw after `begin` rolls back; a throw from
    `begin` itself does not try to, since nothing started. The connection is
    released in every path, and the scripted pool test counts the release.
