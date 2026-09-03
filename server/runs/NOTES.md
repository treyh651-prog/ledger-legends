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
