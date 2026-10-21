# Scheduling

Trigger.dev owns the clock. This database owns what the clock means.

Four cron declarations live on their platform. They carry no client list, no
run names, and no cadence detail. They wake, and this code reads
`sched.schedules` to find out what was due. Everything a person would want to
change lives in the database where it can be read, changed, and audited.

---

## The short version

| Thing | Where it lives |
| --- | --- |
| When a task wakes | `trigger/scheduler.ts`, four `schedules.task` declarations |
| Which project it deploys to | `TRIGGER_PROJECT_REF` at deploy time, read by `trigger.config.ts` |
| What is actually scheduled | `sched.schedules`, one row per client per thing |
| What was due and what happened | `sched.windows`, one row per schedule per window |
| Whether a clock may start a run | `sched.run_policies`, plus `server/runs/policy.ts` |
| What did not run | `npm run sched:status`, and the card on the firm overview page |

---

## Compliance tiers

Every one of the forty nine registered runs is classified. The classification
is not advisory. It is a column, two check constraints, a composite foreign
key, and two guards in code.

**unattended.** Writes nothing to the general ledger and reaches no outside
party. Every effect is derived from rows a person can already see, and running
it again lands on the same answer. A clock may run these to completion. There
are nineteen.

**propose.** Prepares and must not commit. Either it posts to the general
ledger, or its output is addressed to somebody outside the firm. The schedule
runs it in preview mode, which leaves a proposal set and a log row for Jose
Hernandez or Rosario Rosales to approve, and commits nothing. There are twenty
two.

**manual.** Never scheduled at all. A person starts it, because the act itself
is the decision: locking a period, approving a payroll, closing a year,
finishing the intake wizard, exporting a departing client. There are eight.

The rule that decides between them, stated once: a run that posts to the
general ledger or reaches a client, a vendor, or a tax authority is at most
propose. A run whose whole act is a decision is manual. Everything else is
unattended.

### How it is enforced

1. `sched_tier_never_manual` on `sched.schedules`. A manual run cannot be
   written into the schedule table at all.
2. `sched_mode_matches_tier` on `sched.schedules`, anchored by the composite
   foreign key `(run_type, tier)` into `sched.run_policies`. An unattended run
   schedules in apply mode, a propose run schedules in preview mode, and a
   schedule cannot claim a tier the policy table does not give that run.
3. `run_policy_ledger_not_unattended` on `sched.run_policies`. A run flagged as
   writing to the general ledger cannot be classified unattended, in SQL, not
   just in review.
4. `guardScheduledRun` in `server/runs/policy.ts`, called from `execute()`
   whenever the caller passes `unattended: true`. It runs before the scope is
   frozen and before a log row exists, and it returns a refused outcome with
   code `TIER_REFUSED`.
5. `runWindow` in `server/sched/runner.ts` checks the tier before it runs
   anything, so a window that could never succeed fails immediately with a
   readable reason.
6. `script/check-schema.ts` reads `sched.run_policies` back and fails when the
   database and `server/runs/policy.ts` disagree about any tier, reason, or
   ledger flag.

A run added to the registry with no policy entry is refused, not assumed safe.

---

## Cadences

Four shapes, and each one stores only the columns it needs. A
`cadence_shape` check constraint refuses the others.

| Cadence | Columns | Behaviour |
| --- | --- | --- |
| `daily` | none | every day at the local time |
| `weekly` | `weekday` | that weekday, every week |
| `monthly_day` | `day_of_month` | that day, clamped to the last day of short months |
| `monthly_business_day` | `business_day` | the nth weekday of the month |

Clamping is deliberate. A schedule set to the 31st means the end of the month,
so in April it fires on the 30th and in February on the 28th. Rolling forward
into the next month would move a close deadline into the period it is closing.

**There is no holiday calendar.** `nthBusinessDayIn` counts Monday to Friday
and nothing else, so business day three in a week containing a public holiday
is a day earlier than a person following the firm's own calendar would expect.
A holiday list is a per firm, per year, per jurisdiction fact that nothing in
this database holds, and a guessed list is worse than a stated omission. Move
the affected schedule by hand in the years where it matters.

---

## Time zones

`timezone` on the schedule is an IANA name and defaults to `America/Denver`.
The wall clock time is stored as `local_hour` and `local_minute`. The UTC
instant is computed when a window is resolved, never stored on the schedule,
because the offset that turns 06:00 in Denver into an instant is different in
January and in July.

The interval between two consecutive 06:00 Denver fires is 23 hours on the
second Sunday in March and 25 hours on the first Sunday in November. Both are
covered by tests. Two edge cases are answered rather than hidden:

- **The hour that does not exist.** 02:30 never happens on the spring forward
  day. A schedule set to it fires at 03:30 rather than skipping the day.
- **The hour that happens twice.** 01:30 happens twice on the fall back day. A
  schedule set to it fires on the first one.

---

## Windows, and why a retry cannot double post

`sched.windows` carries one constraint that the entire design rests on:

```sql
constraint window_one_per_schedule_start unique (schedule_id, window_start)
```

A tick claims a window by inserting the row, and only ever runs what it
claimed. A Trigger.dev retry that reaches the insert a second time is refused
by Postgres, treats the collision as an ordinary outcome, and does nothing.

That is a property of the database, not a property of careful code. It holds
for a retry, for two overlapping ticks, for two deployments both live during a
promotion, and for a task invoked by hand from their dashboard.

An advisory lock would not do this. A lock is held by a connection, and a retry
minutes later is a different connection, so a lock says nothing about whether
the work already happened.

---

## The catch up bound

**Seven days, and at most seven windows per schedule per sweep, whichever binds
first.**

Windows older than the bound are written to `sched.windows` with status
`skipped` and a reason, so a gap is visible rather than absent. When more
windows are inside the bound than one sweep will run, the newest run first,
because a stale nightly refresh is worth less than tonight's.

Seven days because a nightly derived refresh lands on the same answer when it
is replayed, so seven catch ups cost seven runs and produce one correct state.
Ninety days does not have that property: a run that far back re derives history
whose inputs have since changed, in a period that may now be locked.

And a gap longer than a week is an outage somebody should look at, not
something a sweep quietly absorbs at 3am.

---

## The four declared schedules

| Task id | Cron | Zone | Covers |
| --- | --- | --- | --- |
| `sched-nightly` | `0 6 * * *` | America/Denver | daily cadences |
| `sched-weekly` | `15 6 * * 1` | America/Denver | weekly cadences |
| `sched-monthly` | `30 6 * * *` | America/Denver | both monthly cadences |
| `sched-sweep` | `0 */6 * * *` | UTC | everything, in sweep mode |

Six in the morning rather than midnight, because the bank feeds the derived
runs read land overnight. The monthly task fires every morning and finds
nothing due on most of them, because business day three cannot be written as a
cron expression at all.

The sweep is the safety net. It takes back windows claimed and never finished
after twenty minutes, re drives windows recorded and never run, and records
everything outside the catch up bound as skipped.

---

## Deploying, in order

Nothing below asks you to put a password or a secret key into this repository,
and nothing here reads one.

**1. Apply the migration.** Already applied to `jtqxklqbwsrjewasjfyf` through
the Supabase connector. For a fresh database, apply
`db/migrations/0022_scheduler.sql` the same way as every other migration, over
a direct connection and never over the transaction mode pooler. See
`docs/RUNNING.md`.

**2. Create the service actor.** The scheduler runs as a firm scope membership
in `tenancy.memberships`, not as a person. Create the user row and the
membership with `scope = 'firm'`, and note the two ids. Neither is a secret.

**3. Insert schedules.** One row per client per thing that should happen. The
constraints will refuse a manual run, a mismatched mode, and a cadence carrying
the wrong columns, so a wrong row fails at insert rather than at 6am.

```sql
insert into sched.schedules (
  id, client_id, firm_id, name, run_type, tier, execution_mode,
  cadence, local_hour, effective_from
) values (
  '01JBQ8Z5K3P0000000000000AA',
  '<client uuid>', '<firm uuid>',
  'nightly coding refresh', 'TXN-APPLY-RULES', 'unattended', 'apply',
  'daily', 6, current_date
);
```

**4. Log in to the Trigger.dev CLI.**

```bash
npx trigger.dev@latest login
```

In CI, set `TRIGGER_ACCESS_TOKEN` instead. That is their personal access token
and it is the variable their deploy command reads. It is not
`TRIGGER_SECRET_KEY`, which authenticates the backend SDK for triggering runs
from outside a task and is not used anywhere in this repository.

**5. Set the task environment variables in their dashboard.** Open the project,
go to Environment Variables in the sidebar, and add three for the production
environment:

| Name | Value | Secret |
| --- | --- | --- |
| `DATABASE_URL` | the direct connection string | yes |
| `SCHEDULER_FIRM_ID` | the `tenancy.firms` id | no |
| `SCHEDULER_ACTOR_ID` | the service membership user id | no |

Also set `RUN_DB=postgres`, or the tasks resolve to the memory port and report
every window as succeeded while writing nothing. The task prints which port it
resolved on every run, so this is visible in their logs rather than silent.

A variable marked Secret cannot be read back afterwards. `.env.production` is
not uploaded by the deploy.

**6. Deploy.**

```bash
TRIGGER_PROJECT_REF=proj_your_reference npx trigger.dev@latest deploy
```

The project reference is the segment after `/projects/` in the dashboard URL.
It is an identifier, not a credential. `trigger.config.ts` throws a message
naming the variable when it is missing, because a deploy pointed at no project
is a deploy that looks fine and schedules nothing.

Declarative schedules are registered during the deploy, and only the tasks in
the current deployment fire. A deploy that fails leaves the previous one
running.

### Or let CI do it

`.github/workflows/deploy-scheduler.yml` runs the same command on a GitHub
runner. It fires on a push to `main` that touches `trigger/`, `trigger.config.ts`,
`server/sched/`, the policy table, the database port, or the lockfile, and it can
also be started by hand from the Actions tab.

It needs one repository secret, under Settings, Secrets and variables, Actions:

| Name | Value |
| --- | --- |
| `TRIGGER_ACCESS_TOKEN` | the personal access token from step 4 |

The project reference is not a secret and is set in the workflow's `env`. A
repository variable named `TRIGGER_PROJECT_REF` overrides it, which is how a
second project would be targeted without editing the workflow. The dashboard
variables from step 5 are still set in the dashboard: this job never reads
`DATABASE_URL` and no `.env` file is uploaded by the deploy.

The workflow pins the CLI to the `trigger.dev` version in `devDependencies`
rather than `@latest`, so the CLI and the SDK move together and a published CLI
change cannot alter a deploy nobody touched. Two deploys cannot overlap: the
concurrency group cancels the one in flight.

This exists because a schedule change that is committed and never deployed reads
as done and schedules nothing.

**7. Check it.**

```bash
RUN_DB=postgres DATABASE_URL=... SCHEDULER_FIRM_ID=... SCHEDULER_ACTOR_ID=... \
  npm run sched:status
```

The same picture is on the firm overview page, from `GET /api/sched/status`.

---

## Reading the status

The output leads with what needs a person:

- **Failing.** Two or more consecutive failures on one schedule. One failure is
  a bad night, two is a broken thing.
- **Missed.** Windows recorded and not run, each carrying its reason.
- **Outstanding.** Claimed and not finished, which the next sweep takes back
  after twenty minutes.
- **Waiting for a decision.** Propose tier windows that succeeded, which means
  a proposal set is sitting there with nobody's approval on it.

There is no stored next run time to go stale. The next fire is computed from
the cadence every time it is asked for.

---

## Turning something off

Set `enabled = false` on the schedule row. To stop a clock touching a schedule
without changing what it says, set `manual_override = true`: the tick skips it
entirely, and the override guard in the database refuses automated writes to
that row. Both are visible in `npm run sched:status`.

To stop everything, remove the deployment in the Trigger.dev dashboard. This
process runs nothing on its own, by design, so nothing keeps ticking.
