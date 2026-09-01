# Ledger Legends: the run framework

Status: contract document. Keys off `00-conventions.md`, which is the authority on money, identifiers, versioning, the override flag, suspense reason codes, and close gates. If this document and the conventions document ever disagree, the conventions document wins and this one gets fixed.

Backend assumption throughout: Neon Postgres on the Scale plan, WorkOS AuthKit or Clerk for identity only, and a private S3 bucket for the document vault, as decided in `alt-data-platform.md` sections 5 and 8. Every guarantee below that can be pushed into Postgres is pushed into Postgres, because the recommendation there is explicit that isolation and audit invariants live in the database and not in the application layer.

---

## Part 1. What a run is

A run is one named, versioned, replayable unit of accounting automation. Depreciation for a period is a run. Transfer pairing is a run. Generating 1099 candidates is a run. Applying a rule set to a date range is a run.

Run types are named `<MODULE>-<VERB>-<OBJECT>` per the conventions doc, for example `TXN-PAIR-TRANSFERS`, `PER-POST-DEPRECIATION`, `PER-AMORTIZE-PREPAID`, `TAX-BUILD-1099`. A single execution of a run type carries an id of `RUNX-` plus a ULID, so executions sort in creation order without a secondary sort key.

Three properties are non negotiable.

1. A run never has authority a person does not have. Part 7 of the conventions doc governs. A row carrying the manual override flag is invisible to every run except as a skip.
2. A run either applies fully or applies nothing. There is no partially applied run.
3. A run is evidence. Its log is written for a reader six months later who has to defend the books.

### Runs currently in scope

This table is the illustrative subset used throughout this document. The authoritative list is the 43 specifications in `02-run-specifications.md`, and every one of them implements the interface below without exception.

| Run type | Module | What it proposes |
|---|---|---|
| `TXN-APPLY-RULES` | Transactions | Category and account for uncoded transactions using the coding cascade |
| `TXN-PAIR-TRANSFERS` | Transactions | Transfer pairs booked through 1920 |
| `TXN-DETECT-DUPLICATES` | Transactions | Duplicate flags and `SUS-05` routing |
| `TXN-SPLIT-SETTLEMENTS` | Transactions | Gross, fee, and net splits through 1910 |
| `PER-POST-DEPRECIATION` | Fixed assets and intangibles | Period depreciation into the paired 16xx account, and period amortization into the paired 17xx account |
| `PER-AMORTIZE-PREPAID` | Prepaids | Period release from 13xx to the expense account |
| `PER-POST-ACCRUALS` | Accruals | Period accrual and reversal pairs through 22xx |
| `PER-SPLIT-LOANPAYMENT` | Debt | Principal and interest split from the amortization schedule |
| `PER-POST-RECURRING` | Recurring | Recurring entries, including fixed splits |
| `TAX-BUILD-1099` | Payables | 1099 candidate set for a calendar year at that year's threshold |
| `CLOSE-CHECK-GATES` | Close | Gate results G01 through G17, read only, proposes nothing |
| `PRAC-ESCALATE-OVERDUE` | Suspense | Portal requests and escalations for aged suspense items |

`CLOSE-CHECK-GATES` is deliberately a run even though it writes no accounting entries, because gate evaluation needs the same logging, the same locked period awareness, and the same replay story as everything else.

---

## Part 2. The lifecycle

Five phases, always in this order, always logged.

**1. Scope.** The caller supplies a client, a date range or period, and optional filters. The framework resolves the scope into a concrete, ordered set of candidate row ids and freezes it. Scope resolution reads the period lock table, the entitlement tier, and the run type version. If the scope is empty the run still executes, still logs, and reports zero proposals. An empty run is a real result and it belongs in the log.

**2. Preview.** The run computes proposed changes over the frozen scope inside a transaction that is rolled back. Nothing persists except the run log and its items. Preview output is the exact set of writes apply would perform, with each write attributed to the level, rule version, or schedule row that produced it.

**3. Apply.** The run computes the same proposed changes and commits them. Apply may only be invoked with a `previewRunId`, and it re-derives the proposals rather than trusting the stored preview. If the re-derived proposal set differs from the previewed set, apply aborts with `STALE_PREVIEW` and writes no accounting rows. The operator sees a fresh preview instead of a surprise.

**4. Log.** The run log row and its item rows are written in the same transaction as the accounting effect. Committing the effect without the evidence is impossible by construction.

**5. Undo.** Every applied run is reversible by its own recorded plan. Semantics are in Part 7.

### One code path

Preview and apply are the same function with one flag, and that flag only controls whether the outer transaction commits.

```ts
async function execute<S, P>(
  run: Run<S, P>,
  scope: S,
  ctx: RunContext,
  mode: "preview" | "apply",
): Promise<RunResult<P>> {
  return ctx.db.tx(async (tx) => {
    const frozen = await run.resolveScope(scope, { ...ctx, tx });
    const result = await run.propose(frozen, { ...ctx, tx });
    if (mode === "apply") {
      await run.apply(result.proposals, { ...ctx, tx });
    }
    await writeRunLog(tx, run, ctx, mode, frozen, result);
    if (mode === "preview") throw new RollbackSignal(result);
    return result;
  });
}
```

Two consequences worth stating plainly. Preview cannot drift from apply, because there is no second implementation to drift. And preview must be safe to run against production data at any time, because it is literally apply with the commit removed.

The run log for a preview is committed in a separate short transaction after the rollback, using the same writer function. Previews are logged with `mode = 'preview'` and are retained, because "we previewed it and chose not to apply" is itself audit evidence.

Guardrail in CI: any run whose `propose` function reads a table that `apply` also writes without going through the proposal set fails a static check. Proposals are the only channel between the two phases.

---

## Part 3. The interface

Real code, in `shared/runs/contract.ts`. Money is `bigint` cents everywhere per the conventions doc. There are no floats and no `number` money fields.

```ts
export type Cents = bigint;
export type Ulid = string;

export type RunTypeId =
  | "TXN-APPLY-RULES"
  | "TXN-PAIR-TRANSFERS"
  | "TXN-DETECT-DUPLICATES"
  | "TXN-SPLIT-SETTLEMENTS"
  | "PER-POST-DEPRECIATION"
  | "PER-AMORTIZE-PREPAID"
  | "PER-POST-ACCRUALS"
  | "PER-SPLIT-LOANPAYMENT"
  | "PER-POST-RECURRING"
  | "TAX-BUILD-1099"
  | "CLOSE-CHECK-GATES"
  | "PRAC-ESCALATE-OVERDUE";

export type SkipReason =
  | "manual_override"
  | "locked_period"
  | "already_applied"
  | "out_of_scope_engagement"
  | "missing_prerequisite"
  | "ambiguous_candidate"
  | "entitlement_not_included"
  | "superseded_version";

/** A single journal line. Debit positive, credit negative, integer cents. */
export interface ProposedLine {
  accountNumber: string;      // four digit string, e.g. "6420"
  categoryId: string | null;  // "CAT-" slug, null only for pure clearing moves
  amountCents: Cents;         // signed; lines of an entry sum to exactly 0n
  memo: string;
  dimensions: {
    classId?: Ulid;
    locationId?: Ulid;
    programId?: Ulid;
    restriction?: "with_donor_restrictions" | "without_donor_restrictions";
  };
}

export interface ProposedJournalEntry {
  kind: "journal_entry";
  targetId: Ulid | null;      // null when the run creates a new entry
  entryDate: string;          // ISO date, must fall in an open period
  lines: ProposedLine[];
  reversalOf?: Ulid;
  sourceRef: { table: string; rowId: Ulid; version: number };
}

export interface ProposedFieldWrite {
  kind: "field_write";
  table: string;
  rowId: Ulid;
  before: Record<string, unknown>;   // captured for the undo plan
  after: Record<string, unknown>;
  provenance: {
    cascadeLevel: number;            // 0 through 9, per the conventions doc
    ruleId?: string;                 // "RULE-" plus ULID
    ruleVersion?: number;
    templateId?: Ulid;
    templateVersion?: number;
  };
}

export interface ProposedSuspenseRouting {
  kind: "suspense";
  transactionId: Ulid;
  reasonCode: `SUS-${string}`;       // e.g. "SUS-04"
  account: "1990";
  detail: string;
  relatedIds?: Ulid[];               // both rule ids for SUS-19, for instance
}

export type Proposal =
  | ProposedJournalEntry
  | ProposedFieldWrite
  | ProposedSuspenseRouting;

export interface Skip {
  rowId: Ulid;
  reason: SkipReason;
  detail: string;
}

export interface RunError {
  rowId: Ulid | null;                // null for run level errors
  code: string;                      // stable, machine readable
  message: string;
  retryable: boolean;
}

export interface FrozenScope<S> {
  input: S;
  clientId: Ulid;
  firmId: Ulid;
  periodStart: string;
  periodEnd: string;
  candidateIds: Ulid[];              // ordered, deterministic
  scopeHash: string;                 // sha256 over candidateIds plus versions
}

export interface RunContext {
  db: Db;                            // transaction aware handle
  tx?: Tx;
  actor: { userId: Ulid; kind: "human" | "schedule" | "sequence" };
  runExecutionId: Ulid;              // the ULID inside "RUNX-"
  idempotencyKey: string;
  now: Date;                         // injected, never Date.now() inside a run
  logger: RunLogger;
}

export interface RunResult<P = Proposal> {
  proposals: P[];
  skips: Skip[];
  errors: RunError[];
  totals: {
    candidates: number;
    proposed: number;
    skipped: number;
    failed: number;
    netCents: Cents;                 // must be 0n for any balanced posting run
  };
}

export interface Run<S, P = Proposal> {
  readonly type: RunTypeId;
  readonly version: number;          // bump on any behavior change
  readonly writesLedger: boolean;
  readonly requiresOpenPeriod: boolean;
  readonly concurrencyKey: (scope: S) => string;

  scopeSchema: ZodType<S>;

  resolveScope(scope: S, ctx: RunContext): Promise<FrozenScope<S>>;
  propose(scope: FrozenScope<S>, ctx: RunContext): Promise<RunResult<P>>;
  apply(proposals: P[], ctx: RunContext): Promise<void>;
  undoPlan(proposals: P[], ctx: RunContext): Promise<Proposal[]>;
}
```

Notes on the shape.

`now` is injected. A run that calls the clock itself is not replayable, and depreciation and escalation aging both depend on the clock.

`version` is on the interface, not in a config table, so a code change and a version bump land in the same commit. The applied version is stamped on every row the run writes, which is what the conventions doc requires for a defensible log.

`undoPlan` is derived from the same proposal objects that apply consumed, so the reversal is not a second guess at what happened.

---

## Part 4. Reporting proposals, skips, and errors

A run returns three parallel lists and never mixes them. Every candidate id in the frozen scope appears in exactly one of proposals, skips, or errors. CI asserts that partition on every golden fixture, so a silently dropped row is a test failure rather than a mystery.

Skips are first class output, not absence of output. `manual_override` and `locked_period` are the two skips an operator sees most, and both are expected in healthy books. The run summary always shows skip counts by reason next to the proposal count, because a run that skipped 400 rows and proposed 3 is a very different event from a run that proposed 403.

Errors do not stop the phase. `propose` collects errors per row and continues, so one malformed vendor string does not hide the other 900 rows. What errors do stop is apply: if `errors.length > 0`, apply refuses to start and returns `PROPOSAL_SET_NOT_CLEAN`. The operator fixes the data or narrows the scope and previews again. This is the mechanism that makes "no partial application" true rather than aspirational.

### Transaction boundaries

One database transaction per run execution, on a direct Neon connection rather than the pooler for any run expected to exceed a few seconds, following Neon's own guidance that session state sensitive work should not go over PgBouncer in transaction mode ([Neon connection pooling](https://neon.com/docs/connect/connection-pooling)).

Inside the transaction, in order: set the tenant context, take the advisory lock, freeze the scope, propose, apply, write the log, commit. Isolation level is `repeatable read` for read heavy runs and `serializable` for any run that both reads and writes the same ledger rows, which covers every posting run. A serialization failure is retryable and is retried by the framework, not by the run.

Runs never open a nested transaction and never use savepoints to salvage a failed row. A row that cannot be proposed becomes an error and the operator decides.

Large scopes are chunked at the scope level, not the transaction level. A depreciation run over 5,000 assets for one client stays one transaction. A backfill across 300 clients is 300 separate run executions with 300 separate log rows, dispatched by a sequence, per Part 9.

### Idempotency keys

Every execution carries an idempotency key computed before any work:

```
sha256(run_type + ":" + run_version + ":" + firm_id + ":" + client_id + ":" + scope_hash + ":" + mode)
```

The key is a unique column on `run_log` for `mode = 'apply'`. A second apply with the same key does not execute. It returns the original run execution id and its result, marked `deduplicated`. This is what makes a retrying scheduler, a double clicked button, and a replayed webhook all safe.

`scope_hash` includes the resolved candidate ids and the versions of every rule, template, and schedule that participated. Change a rule and the key changes, so the same period can legitimately be rerun after a rule fix, and the log shows two executions with two versions rather than one overwritten one.

---

## Part 5. Concurrency

The rule: one run of a given type per client at a time. Different run types may execute concurrently for the same client. The same run type may execute concurrently for different clients.

Enforcement is a Postgres advisory lock taken inside the run transaction, so it releases on commit or rollback with no cleanup process and no stale lock rows.

```sql
-- Two key form: run type in the high slot, client in the low slot.
select pg_try_advisory_xact_lock(
  hashtext($1::text),   -- run type, e.g. 'PER-POST-DEPRECIATION'
  hashtext($2::text)    -- client_id
);
```

`pg_try_advisory_xact_lock` and not the blocking `pg_advisory_xact_lock`, because a queued run holding a connection is worse than a rejected run. On a `false` return the framework writes a run log row with status `rejected_locked`, naming the holding execution id, and returns `409 RUN_ALREADY_RUNNING` to the caller.

What the second trigger sees:

| Trigger source | Behavior on lock contention |
|---|---|
| Manual button | Immediate `409` with the running execution id, and the UI switches to showing that execution's progress instead of starting a new one |
| Scheduled job | Logged as `rejected_locked` and not retried inside the same window, because the next window will pick up whatever remains |
| Convenience sequence | The sequence stops at the contended step, marks that step `rejected_locked`, and does not attempt later steps that depend on it |
| Same idempotency key | Never reaches the lock. Deduplicated at the key check and returns the original result |

Preview also takes the lock. A preview computed while an apply of the same type is committing would describe a world that no longer exists.

Cross client runs that touch group level data, notably `G14` related party netting, take a firm level lock with the client slot set to the firm id, which blocks per client runs of that type across the group for the duration. That is intentional and the run is short.

---

## Part 6. The override flag contract

Part 7 of the conventions doc is the source of authority. This is how a run honors it mechanically.

Every table a run can write carries three columns: `manual_override boolean not null default false`, `manual_override_by uuid`, and `manual_override_at timestamptz`.

Obligations on every run.

1. Scope resolution excludes overridden rows by predicate, not by filtering later. `where manual_override = false` is part of the candidate query. This means an overridden row is never loaded, never proposed, and never near a write path.
2. Any row that entered scope and is discovered to be overridden at apply time, because a human edited it between preview and apply, is a `manual_override` skip and forces `STALE_PREVIEW` on the apply. The human's edit wins and the operator gets a fresh preview.
3. No run may set, clear, or read past the override flag to write the underlying field. Clearing an override is a separate, logged human action, per rule 3 of the conventions doc.
4. Overridden rows are reported, not hidden. Every run summary lists overridden rows in scope with a count, so an operator can see that automation is being held off 40 transactions rather than wondering why nothing changed.

Database level backstop, so the contract does not depend on every run remembering:

```sql
create or replace function ledger.guard_manual_override()
returns trigger language plpgsql as $$
begin
  if old.manual_override
     and current_setting('app.actor_kind', true) in ('run', 'schedule')
     and (new.category_id, new.account_number, new.amount_cents)
         is distinct from (old.category_id, old.account_number, old.amount_cents)
  then
    raise exception 'override_protected_row: % %', tg_table_name, old.id
      using errcode = 'check_violation';
  end if;
  if old.manual_override and not new.manual_override
     and current_setting('app.actor_kind', true) <> 'human'
  then
    raise exception 'override_clear_requires_human: %', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
```

A run that violates the contract fails its whole transaction. That is the desired outcome: a loud rollback rather than a quiet overwrite of somebody's decision.

---

## Part 7. Reversal semantics

Two different worlds, and the difference is whether the change was posted to the ledger.

**Unposted changes revert.** Field writes on transactions, category assignments, vendor resolutions, duplicate flags, pairing links, and draft entries are reverted to the `before` snapshot captured in the proposal. The revert is itself a logged run of type `<ORIGINAL>-UNDO`, with its own execution id, referencing the original. Reverting is not erasing: the original run log stays, the undo run log is added.

**Posted entries reverse and never delete.** A posted journal entry is never deleted, never edited, and its lines are never amended. Undo posts a reversing entry: same lines, sign flipped, `reversal_of` pointing at the original entry id, dated per the rule below. Both entries remain visible, and both appear in the account activity. Net effect zero, history intact.

Reversal dating:

| Original entry date | Reversal date |
|---|---|
| In an open period | Same date as the original, so the period presents clean |
| In a locked period | First day of the earliest open period, and the item is routed with `SUS-20` so a human confirms the correcting treatment |

Undo is refused, not forced, in three cases: the original run has already been undone, the reversal would land in a locked period with no open period after it, or a later posted entry depends on the original in a way the undo plan cannot express, for example a disposal that consumed accumulated depreciation posted by the run being undone. In all three cases the operator gets a named reason and a manual path, since manual is always available per the conventions doc.

Partial undo is not offered. Runs are the unit of reversal. If an operator wants three of forty proposals reversed, the answer is undo the run and reapply with a narrower scope, or make three manual entries that carry the override flag.

---

## Part 8. Locked period enforcement

Application checks are the second line of defense. The first line is the database, so a bug in a run, a script, an ad hoc `psql` session, or a future integration cannot write into a closed period.

```sql
create table ledger.period_locks (
  id            uuid primary key default gen_random_uuid(),
  firm_id       uuid not null,
  client_id     uuid not null,
  period_start  date not null,
  period_end    date not null,
  locked_at     timestamptz not null default now(),
  locked_by     uuid not null,
  closed_with_exceptions boolean not null default false,
  exception_note text,
  unlocked_at   timestamptz,          -- non null means this lock is historical
  unlocked_by   uuid,
  unlock_reason text,
  constraint period_sane check (period_end >= period_start),
  constraint exception_needs_note check (
    not closed_with_exceptions or exception_note is not null
  )
);

create index on ledger.period_locks (client_id, period_start, period_end);

-- Trigger on every ledger write table, including deletes.
create or replace function ledger.enforce_period_lock()
returns trigger language plpgsql as $$
declare
  d date := coalesce(new.entry_date, old.entry_date);
  c uuid := coalesce(new.client_id, old.client_id);
begin
  if exists (
    select 1 from ledger.period_locks pl
    where pl.client_id = c
      and pl.unlocked_at is null
      and d between pl.period_start and pl.period_end
  ) then
    raise exception 'locked_period: % is inside a locked period for client %', d, c
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

create constraint trigger trg_period_lock_je
  after insert or update or delete on ledger.journal_entries
  deferrable initially immediate
  for each row execute function ledger.enforce_period_lock();
```

Design points.

The trigger fires on delete as well as insert and update, because "no transaction may be created, modified, or coded with a date inside it" includes removal.

Reversing entries are allowed because they are dated into an open period, not because they get an exemption. There is no bypass flag on the trigger. Unlocking a period is an explicit administrative action that writes `unlocked_at`, `unlocked_by`, and `unlock_reason`, and the row stays in the table forever as evidence that the period was reopened.

No application role carries `BYPASSRLS` or superuser, per the least privilege design in `alt-data-platform.md` section 5, so no role can disable the trigger at runtime. `migrator` can, and `migrator` is only used by CI over a direct connection.

Runs still check the lock in `resolveScope`, so an operator sees `locked_period` skips in a preview instead of a database exception at apply time. The check is for ergonomics. The trigger is for correctness.

---

## Part 9. The run log as audit evidence

Two tables. `run_log` is one row per execution. `run_log_items` is one row per candidate touched. Full DDL lives in `04-data-structures.md`; this section states what the log must mean.

### Captured on every execution

| Field group | Contents |
|---|---|
| Identity | Execution id as `RUNX-` plus ULID, run type, run version, mode, idempotency key, scope hash |
| Tenancy | `firm_id`, `client_id` |
| Actor | User id, actor kind of human or schedule or sequence, source of button or cron or sequence, parent sequence id when applicable |
| Scope | Period start and end, candidate count, the frozen candidate id list or its hash for large scopes, the filter input as submitted |
| Versions | Every rule, template, schedule, category, and chart template version that participated, as an array of id and version pairs |
| Outcome | Status, proposal count, skip count by reason, error count, net cents, entries created, entries reversed |
| Timing | Started at, finished at, duration in milliseconds, database time |
| Linkage | Preview execution id for an apply, original execution id for an undo, undone by execution id when reversed |
| Environment | Git commit sha, deployed release id |

### Captured per item

Row table and id, decision of proposed or skipped or errored, before and after values as JSONB for field writes, the cascade level that produced the answer, the rule id and version or template id and version, the suspense reason code when routed, the created journal entry id when posted, and the error code and message when failed.

Before and after snapshots are the reason undo is mechanical rather than reconstructive.

### Immutability

`run_log` and `run_log_items` are insert only. Enforced, not requested:

```sql
revoke update, delete, truncate on ledger.run_log       from app_web, app_worker;
revoke update, delete, truncate on ledger.run_log_items from app_web, app_worker;

create rule run_log_no_update as on update to ledger.run_log do instead nothing;
create rule run_log_no_delete as on delete to ledger.run_log do instead nothing;
```

Status transitions that must be recorded after insert, such as an undo linkage, are appended as a new row in `run_log_events` rather than mutating the original row. The log is a ledger of what runs did, and a ledger that can be edited is not evidence.

### Retention

Seven years for `run_log`, matching the Object Lock retention on the `engagement-letters/` and `statements/` prefixes in the S3 vault. Seven years for `run_log_items` on any run that posted to the ledger. Eighteen months for items belonging to preview only executions, since the parent preview row is what matters after that point and item level detail on a discarded preview stops being useful. Aged item rows move to a cold partition rather than being deleted, and the parent `run_log` row records that the detail was archived and where.

Partitioned monthly by `started_at` so aging is a partition detach and not a mass delete, which also keeps the delete revoke honest.

---

## Part 10. Triggering

Three entry points, one framework, one log shape.

**Manual button.** Every run is reachable from the UI for a client in scope. The button always previews first. Apply is a second, separate click on the preview screen showing the counts. There is no one click apply for any run that writes the ledger. Preview results carry a five minute freshness window, after which the apply button re-previews rather than trusting stale numbers.

**Scheduled via Trigger.dev.** Scheduled runs are Trigger.dev tasks that call the same `execute` function with `actor.kind = "schedule"`. The schedule owns cadence, retries, and observability. It owns nothing about accounting logic. Rules for scheduled runs:

- Idempotency key includes the scheduled window, so a retried task cannot double post.
- A scheduled run that would apply into a locked period logs `locked_period` skips and finishes successfully. It never fails on lock contention with a period.
- Schedules are per client, not global, so one client's slow run does not delay another's, and one client's failure does not mark another's window failed.
- Scheduled apply is limited to runs that are safe unattended, currently `PER-POST-DEPRECIATION`, `PER-AMORTIZE-PREPAID`, `PER-SPLIT-LOANPAYMENT`, `PER-POST-RECURRING`, `TXN-SPLIT-SETTLEMENTS`, and `PRAC-ESCALATE-OVERDUE`. Everything else is scheduled in preview mode and produces a review queue item.

**Convenience sequences.** "Run month end prep" is a named ordered list of run types, nothing more. The hard rule: a sequence logs each run separately, with its own execution id, its own idempotency key, its own transaction, and its own undo plan. The sequence row itself is a thin `run_sequence` record listing child execution ids and their order. There is no combined transaction and no combined log entry, because an auditor asking "when was depreciation posted and by whom" must get one answer about depreciation and not a composite about a button.

Sequence behavior on trouble: stop at the first child with errors or lock contention, leave completed children applied, and report which step stopped it. Completed children stay applied because each was individually complete and individually reversible. The operator undoes specific children if needed.

Typical month end sequence, matching the pipeline order in `02-run-specifications.md`: `TXN-NORMALIZE-VENDORS`, `TXN-DETECT-DUPLICATES`, `TXN-PAIR-TRANSFERS`, `TXN-SPLIT-SETTLEMENTS`, `TXN-APPLY-RECURRING`, `TXN-APPLY-RULES`, `TXN-APPLY-VENDORDEFAULTS`, `TXN-MAP-BANKCODES`, `TXN-SWEEP-SUSPENSE`, then `PER-POST-RECURRING`, `PER-POST-DEPRECIATION`, `PER-AMORTIZE-PREPAID`, `PER-SPLIT-LOANPAYMENT`, `PER-POST-ACCRUALS`, and finally `CLOSE-CHECK-GATES`. Order matters and mirrors the coding cascade: pairing before rules, always.

---

## Part 11. Failure handling and retries

### Classification

| Class | Examples | Framework response |
|---|---|---|
| Transient | Serialization failure, connection reset, Neon compute cold start, S3 timeout | Retry up to 3 times with jittered backoff at 1s, 4s, 16s, same idempotency key |
| Contention | Advisory lock held | No retry inside the window. Log `rejected_locked` |
| Data | Missing schedule, unbalanced proposed entry, ambiguous pair, rule conflict | No retry. Reported as row errors, apply refused |
| Contract | Locked period trigger fired, override guard fired, tenant context missing | No retry. Full rollback, alert raised, treated as a bug |
| Fatal | Out of memory, deploy mid execution | Transaction rolls back with the connection. Log row reconciled by the sweeper |

Retries reuse the same execution id and the same idempotency key, and each attempt appends a `run_log_events` row. The retry counter lives on the log, so "this run needed three attempts" is visible.

### What a partially failed run leaves behind

Nothing partially applied, ever. Since the accounting effect and the log commit together, a failure before commit leaves the ledger exactly as it was and no log row visible.

That creates one gap worth naming: a run that dies after `begin` and before `commit` leaves no evidence it was attempted. Handled by a pre transaction intent row written in its own autocommit statement before the main transaction opens:

```sql
insert into ledger.run_log (id, run_type, run_version, mode, status, firm_id, client_id,
                            idempotency_key, actor_id, actor_kind, started_at)
values ($1, $2, $3, $4, 'started', $5, $6, $7, $8, $9, now());
```

The main transaction then writes a `run_log_events` row of `completed` or `failed`, plus the items. A sweeper task marks any `started` row with no terminal event and no active backend as `abandoned` after ten minutes. So the possible terminal states are exactly:

- `completed`: applied and logged, ledger changed.
- `completed_with_skips`: applied, some candidates skipped, ledger changed.
- `no_op`: executed, zero proposals, ledger unchanged.
- `refused`: errors present, apply declined before writing anything.
- `rejected_locked`: another run of this type held the client lock.
- `deduplicated`: idempotency key already applied, original result returned.
- `failed`: transaction rolled back, ledger unchanged, error recorded.
- `abandoned`: process died, ledger unchanged, reconciled by the sweeper.

There is no `partially_applied` status because there is no such state to name.

### Poison protection

Three consecutive `failed` executions of the same run type for the same client with the same scope hash disables scheduled execution of that pair and raises a review item. Manual preview stays available, because a human investigating needs to see the failure, and preview writes nothing.

---

## Part 12. Testing strategy

Three layers, all required in CI before a run ships.

### Golden fixture per run

Every run type owns a fixture directory:

```
tests/runs/PER-POST-DEPRECIATION/
  seed.sql            chart, categories, assets, prior depreciation, period locks
  scope.json          the input the run receives
  expected.preview.json
  expected.apply.json
  expected.undo.json
  expected.log.json   status, counts, skip reasons, versions stamped
```

The harness loads the seed into a fresh Neon branch, runs preview, asserts against `expected.preview.json`, applies, asserts the ledger snapshot and the log, undoes, and asserts the ledger returns to the seed state while the log grows by one execution. Fixtures are byte compared after normalizing ULIDs and timestamps, so an unintended behavior change shows up as a diff a reviewer reads rather than a number a reviewer trusts.

Every fixture set must include at least one overridden row, one row in a locked period, one row that routes to suspense, and one row that errors. A fixture with only happy path rows is rejected in review.

Preview and apply parity has its own assertion: the writes recorded in the apply log must equal the proposals in the preview output, one to one. This is the test that would catch a drift the shared code path is designed to prevent.

### The two tenant negative test

Directly from `alt-data-platform.md` sections 5 and 8, extended to runs. Two firms, two clients each, overlapping vendor names, identical amounts, identical dates. Then, through the same connection string and the same non superuser role the application uses:

1. Run every run type as firm A and assert that no `run_log`, `run_log_items`, journal entry, or field write references any firm B row.
2. Assert firm A's session cannot read firm B's `run_log` at all, so even the existence of firm B's runs is invisible.
3. Assert transfer pairing never pairs across clients, and never across firms, even when amounts, dates, and normalized vendor strings match exactly. This is the highest value single assertion in the suite, because the pairing predicate is the one place a missing `client_id` term produces a plausible looking wrong answer.
4. Assert duplicate detection is likewise client scoped.
5. Deliberately drop one RLS policy and assert the suite fails loudly. A negative test that cannot fail is not a test.

Run against a restored branch as well as a fresh one, per the quarterly restore drill, so isolation is proven on recovered data and not only on seeded data.

### Property test: the books still foot

For any run, any seed, any scope, applied or undone, these invariants hold. Implemented with fast check over generated charts, transactions, assets, and schedules.

| Invariant | Assertion |
|---|---|
| Entries balance | Every journal entry's lines sum to exactly `0n` |
| Trial balance foots | Sum of all posted lines for a client is exactly `0n`, matching gate G05 |
| Net zero posting | Any run's reported `netCents` is `0n` when `writesLedger` is true |
| No orphan lines | Every line belongs to an entry, every entry has at least two lines |
| Undo restores | Apply then undo returns every balance to its pre run value |
| Idempotent apply | Apply twice with the same key changes balances exactly once |
| Locked periods untouched | No balance in any locked period changes, for any run, any input |
| Overrides untouched | No overridden row's watched fields change, for any run, any input |
| Total partition | Proposals plus skips plus errors equals the candidate count |
| Contra pairing | Depreciation credits exactly the cost account number plus 100, per the conventions doc |
| Suspense terminates | No transaction in scope ends with a null category; unresolved ones sit in 1990 with a reason code |
| Cents only | No float appears anywhere in a proposal or a written row, checked by type and by a runtime scan |

Shrinking is what makes this layer worth the cost. When the property fails, fast check hands back the smallest chart and the smallest transaction set that breaks it, which is usually a two line reproduction.

### Two more checks that live in CI

A migration test asserting the period lock trigger, the override guard, and the run log insert only rules exist and fire, run after every migration, because these are the guarantees the whole framework leans on.

A determinism test running each run's `propose` twice against an unchanged database and asserting identical output, including ordering. Non deterministic ordering breaks scope hashing, which breaks idempotency.

---

## Part 13. Open items

1. Whether `TAX-BUILD-1099` should be one run per calendar year or one run per payee batch. Leaning per year with a payee filter, since the threshold is measured per payee per year.
2. Whether `CLOSE-CHECK-GATES` should cache gate results for the UI. The conventions doc says gates are computed live and never stored as a checkbox, so any cache must be request scoped and clearly not a stored state.
3. Sequence level undo. Currently undo is per child run only. Revisit after operators have used month end prep for a quarter.
