# Running the application against the real database

Who this is for: the person who owns the firm, or whoever they ask to press the
buttons. It assumes you can open the Supabase dashboard and set an environment
variable in whatever hosts the application. It does not assume you administer
databases.

There is exactly one secret in all of this, the database connection string, and
it lives in the hosting environment and nowhere else. It is not in this
repository, it was never in this repository, and nobody who wrote this code has
ever held it.

---

## 1. What the application needs

One environment variable for the database, four for sign in.

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | Yes in production | The connection string. Contains the password. |
| `RUN_DB` | No | `postgres` or `memory`. Overrides the default choice. |
| `PGSSLROOTCERT_PEM` | No | The project certificate, as text, for strict certificate checking. |
| `SUPABASE_URL` | Yes with Postgres | The project URL, `https://<ref>.supabase.co`. Tokens are verified against its `/auth/v1` issuer. |
| `SUPABASE_ANON_KEY` | Yes with Postgres | The public key. Handed to the browser through `/api/auth/config`, and used as the `apikey` header when the server has to ask Supabase Auth about a legacy HS256 token. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes with Postgres | The admin key. Used for invitations (create the auth user, send the email) and revocations (ban the auth user). Server only. Never reaches the browser or a log. |
| `APP_ORIGIN` | Yes with Postgres | Where the browser loads the app from, for example `https://app.example.com`. Pins CORS and is the redirect target in invitation and reset emails. Must also be in the Supabase project's redirect allow list. |
| `UPLOAD_MAX_BYTES` | Optional | Ceiling for one uploaded document, bytes. Default 26214400 (25 MiB). The bucket's own limit is 100 MiB. |
| `DOCUMENT_BUCKET` | Optional | Supabase Storage bucket for documents. Default `documents`, created private by migration 0031. Document storage itself needs only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. |
| `APP_DB_ROLE` | Recommended | Role for `set local role` inside every actor transaction. Set it to `app_web` once migration 0023 is applied. Section 7 says why. |

Sign in follows the database. With Postgres, all four Supabase variables are
required and the server refuses to start naming the missing ones. In memory
mode there is no tenancy schema to resolve a login against, so the server runs
with sign in off and says so on startup; the browser then shows the app without
a login screen, which is the developer loop.

The rule the application follows, in one place, `server/db/run-db.ts`:

- `RUN_DB=postgres`, it uses Postgres and refuses to start with no `DATABASE_URL`.
- `RUN_DB=memory`, it uses the in memory store and says so on startup. Nothing
  written survives a restart. This is for demonstrations.
- `RUN_DB` unset, it uses Postgres when `NODE_ENV=production` and the in memory
  store otherwise.

So a developer laptop with nothing set keeps working with no database, and a
production deployment with a forgotten `DATABASE_URL` refuses to start rather
than quietly doing a month of bookkeeping into memory. If startup fails, the log
line tells you which variable is missing.

---

## 2. Getting the connection string

1. Open the project in the Supabase dashboard.
2. Click **Connect** at the top of the page.
3. Pick a connection method, described below, and copy the string it shows.
4. Where the string has `[YOUR-PASSWORD]`, put the database password in. If you
   do not have it, use **Reset database password** on the same page. Resetting
   is safe as long as you then update `DATABASE_URL` everywhere it is set.
5. If the password contains any of `& # ? / @ :` or a space, it has to be
   percent encoded, or the string will be misread. The simplest way to avoid the
   problem is to reset to a password made only of letters and digits.

Supabase offers three forms, and they differ by host, port, and user name
([Supabase, connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)).

| Form | Host and port | Use it for |
|---|---|---|
| Direct connection | `db.<project-ref>.supabase.co:5432` | Migrations, backups, restores, anything that changes the schema. |
| Session pooler | `<pooler-host>:5432` | The application, when your host has no IPv6. |
| Transaction pooler | `<pooler-host>:6543` | The application, normally. |

Two details that cost an afternoon if you miss them. The pooler user name is
`postgres.<project-ref>` and not plain `postgres`, and the pooler host has an
index in it that you cannot guess from the region, so copy the whole string
rather than typing it. Copy it, do not compose it.

### Which one for which purpose

**Application queries: the transaction pooler, port 6543.** The application
opens a connection, runs one transaction, and gives the connection back. That is
exactly the shape the transaction pooler is built for, and it is what lets
several application processes share a small connection allowance. Use the
session pooler on port 5432 instead if your hosting platform is IPv4 only and
the transaction pooler refuses to resolve.

**Migrations: the direct connection, port 5432.** This is not a preference, it
is doc 04 Part 13. A migration is a long sequence of statements that depend on
each other's session state, and a transaction mode pooler is free to hand your
connection to somebody else between two of them. Half applied schema changes are
the worst failure in this entire system to recover from.

In practice you should not need the direct connection at all. Every migration in
`db/migrations/` has been applied through the Supabase connector, which holds its
own credentials, and that is how the next one will be applied too. The direct
form is documented here so that when somebody eventually needs it, they do not
reach for the pooler.

---

## 3. Setting it as a secret

Set `DATABASE_URL` in the hosting platform's secret or environment settings, the
place whose values are hidden after you save them. Not in a file, and above all
not in a file inside this repository.

- Do not put it in `.env` and commit it. `.env` is ignored by git, which stops
  the accident, but a password sitting on a laptop is still a password sitting on
  a laptop.
- Do not paste it into a chat, an issue, or a commit message. If you already did,
  reset the database password. A leaked connection string is not recoverable by
  deleting the message.
- Nothing in this code prints `DATABASE_URL`, and `npm run db:verify` prints only
  the host and the port. Keep it that way.

Rotating the password later is a dashboard reset plus updating the secret. No
code change, no deploy of this repository, and nothing in `db/migrations/` cares.

---

## 4. Verifying it works

```
npm run db:verify
```

Run it on a machine or in a shell where `DATABASE_URL` is set, from the project
root, after `npm install`. It writes nothing. It reads, and it executes one real
run in preview inside a transaction it then rolls back, so no journal entry, no
proposal, and not even a run log row survives it.

A pass looks like this, with your own values in place of the italics:

```
db:verify against db.your-project-ref.supabase.co:5432
step 1 of 5  PASS  connected to database postgres as role postgres, PostgreSQL 17.4
step 2 of 5  PASS  all 81 addressable relations present
step 3 of 5  PASS  named query open_period_locks returned 0 rows
step 4 of 5  PASS  client 0f1e... in firm 8c2a..., acting as user 41bd...
step 5 of 5  PASS  TXN-DETECT-DUPLICATES preview status no_op, 0 proposals, 0 skips, 0 errors

db:verify PASSED. All 5 steps green, and nothing was written.
```

Three verdicts, three exit codes, and no fourth possibility.

| Last line | Exit code | What it means |
|---|---|---|
| `PASSED` | 0 | The application can reach the database and execute runs against it. |
| `INCOMPLETE` | 2 | The connection and the schema are fine, but a step was skipped, so the run path is not proven. Read the `SKIP` line. |
| `FAILED` | 1 | Something is wrong. Read the `FAIL` line. |

A `no_op` status on step 5 is a pass. It means the run found no candidate
transactions in the window it looked at, which is the normal answer on a quiet
or empty client, and it proves the whole path regardless.

---

## 5. What each failure means

### Before step 1

`DATABASE_URL is not set.` The variable is missing from the shell or from the
deployment. Note that setting it in your hosting dashboard does not set it in
your own terminal.

### Step 1, connecting

| Message contains | Cause | Fix |
|---|---|---|
| `ENOTFOUND` | The host name is wrong, usually a hand typed pooler host. | Copy the string from **Connect** again. |
| `ECONNREFUSED` or a timeout | Right host, wrong port, or your network cannot reach it. Direct connections are IPv6 by default. | Try the session pooler on port 5432. |
| `password authentication failed` | Wrong password, or the pooler user name is missing the project reference. | Check the user name is `postgres.<project-ref>` for a pooler string. Reset the password if unsure. |
| `Tenant or user not found` | A pooler string with plain `postgres` as the user. | Use `postgres.<project-ref>`. |
| `self signed certificate` or another certificate error | Only possible if you set `PGSSLROOTCERT_PEM`, and the value is wrong or truncated. | Unset it and run again. The connection is still encrypted without it. |

### Step 2, relations present

`N of 81 relations missing`, with names. Migrations have not all been applied to
this project. Apply the missing ones from `db/migrations/` in numerical order and
run the command again. If a name looks unfamiliar, `npx tsx script/check-schema.ts`
is the same check run through the Supabase connector, and it will say the same
thing without needing `DATABASE_URL`.

### Step 3, the named query

`permission denied for schema ledger` or `for table period_locks`. The role in
your connection string is not the role the migrations granted access to. The
`postgres` role from the dashboard has access to everything. A custom role needs
the grants at the end of each migration.

### Step 4, choosing a tenant

`SKIP no client with an active membership exists yet`. This is not a fault. The
database is real and correct and has no firm, client, or user in it yet. Onboard
one client, then run the command again to prove the run path.

`FAIL could not read tenancy.memberships`. Either migration `0001_tenancy.sql`
was not applied, or the role cannot see the tenancy schema. Step 2 will usually
have failed too.

### Step 5, the run

| Symptom | Cause | Fix |
|---|---|---|
| `new row violates row-level security policy` | The user chosen in step 4 has no membership that covers that client, or the policies are reading a different session setting than the application sets. | Check that the user in step 4 has an unrevoked membership row for that firm or client. |
| `status refused` with an error code | The run itself objected, which means the wire works and the data has a problem. | Read the error code against docs/03-run-framework.md Part 11. |
| `could not serialize access` | Something else was writing to the same client at the same moment. | Run it again. One retry is expected on a busy database. |
| `canceling statement due to statement timeout` | A statement took more than thirty seconds, which on this workload means a missing index or a lock held elsewhere. | Look for a long running transaction in the dashboard, then ask for help. This one is not a configuration mistake. |

---

## 6. Sign in: first owner, then invitations

Nobody can invite until somebody is an owner, so the first owner is made from
the command line, in the environment that holds the variables above:

```
npm run auth:bootstrap -- --firm "Your Firm" --slug your-firm --email owner@example.com --name "Owner Name"
```

It creates the auth user through the admin API (which sends the invitation
email), the `tenancy.firms` row, the `tenancy.users` row, and an owner
membership. Run it twice and the second run reports that everything exists.
The owner follows the link in the email, lands on the set password screen,
and from then on invites everyone else from the Access page in the firm plane.

Supabase side, once per project, in Authentication, URL Configuration: set the
Site URL to `APP_ORIGIN` and add `APP_ORIGIN/auth/callback` to the redirect
allow list. Without that the links in the emails bounce back to the Supabase
default and the browser never sees the session.

How a request is checked, in `server/auth/`:

1. `jwt.ts` verifies the bearer token. Asymmetric tokens (ES256, RS256) are
   checked locally against the project's JWKS, cached, no network call per
   request. Legacy HS256 tokens are checked by asking `/auth/v1/user`, because
   the server does not hold the shared secret. The path is chosen from the
   token header, so moving a project to signing keys needs no change here.
2. `actor-store.ts` looks the subject up in `tenancy.users` and reads the
   active memberships. A disabled user or a subject with no row is refused.
3. `middleware.ts` provides `requireUser`, `requireFirm` and `requireClient`.
   A user in more than one firm sends `X-Firm` with the firm id or slug.
4. Every database read or write for the request runs inside
   `withActor(pool, actor, fn)` from `server/db/with-actor.ts`, which opens a
   transaction, optionally switches role, sets `app.user_id`, and clears
   `app.run_id`, all transaction local so the pooler sees a clean connection.

## 7. Why `APP_DB_ROLE` matters

On Supabase the `postgres` role, which is the role in every connection string
the dashboard offers, carries `BYPASSRLS`. A server that connects as `postgres`
is exempt from every row level security policy, so the policies written since
migration 0001 are decorative for its traffic. `withActor` therefore runs
`set local role app_web` when `APP_DB_ROLE=app_web`, and `app_web` does not
bypass anything. Migration 0023 granted `app_web` what it needs on every table
and made `postgres` a member of it so the switch is allowed.

With `APP_DB_ROLE` unset the server logs, once at startup, that actor
transactions run as the connection role and that the API's own membership
checks are the only enforcement. That is not a configuration to ship. The test
suite proves both behaviours against a real Postgres: with the switch a client
scoped actor sees one client's rows, without it the same actor sees every row.

The runs path (`server/runs/db-postgres.ts`) switches roles too, the identical
`set local role` on its own `PostgresRunDbOptions.dbRole`, read from the same
`APP_DB_ROLE` by `resolveDbRole` in `server/db/run-db.ts`. One environment
variable, both paths. Verified directly against production on 2026-10-28:
`APP_DB_ROLE=app_web` is set, a transaction's `current_user` genuinely moves
from `postgres` to `app_web` on `set local role`, and `pg_roles` shows
`app_web.rolbypassrls = false` against `postgres.rolbypassrls = true`. This
section used to say the runs path was the next thing to close; it was already
closed by the time that line was checked against the running system.

## 8. Notes for whoever maintains this

- The transaction pooler does not support server side prepared statements. The
  Postgres port does not use them, and it should stay that way, or the
  application will work on a direct connection and fail on the pooler.
- TLS is required in `server/db/pool.ts` rather than through an `sslmode`
  parameter in the URL, so that a copied string with the parameter dropped
  cannot silently downgrade to plaintext.
- Pool size, statement timeout, and both connection timeouts are constants at the
  top of `server/db/pool.ts`, each with the reasoning for its value written
  beside it.
- `npm run db:verify` and `npm run auth:bootstrap` are the only things in this
  repository that open a connection with a password in it, and both take that
  password from the environment. If you find a third place, that is a defect.
- The service role key is read in exactly one place, `server/auth/auth-admin.ts`.
  Keep it that way.

## 9. The gates

Run every one before a commit. Each is quick except the harness and the
build.

```
npx tsc --noEmit
npx tsx server/runs/__tests__/index.ts      # includes the API route tests
npx tsx script/check-style.ts
npx tsx script/check-schema.ts              # needs the Supabase connector or DATABASE_URL
npx tsx script/check-queries.ts             # same
npm run build
```

The API route tests (`server/api/__tests__/routes.ts`) start a real express
app on a loopback port over the memory run db. They need no database and no
secret. `RUN_DB=memory PORT=5000 npm run dev` starts the same server with
the development actor (docs/11-api.md section 5) for exercising screens by
hand.
