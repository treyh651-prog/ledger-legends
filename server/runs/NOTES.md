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
