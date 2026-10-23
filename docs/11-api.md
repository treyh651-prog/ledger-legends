# 11. The API layer

How the browser reads the books and how it asks for work. This document is
the contract between `server/api`, `shared/api`, and `client/src/api`. If a
screen and this document disagree, the document wins and the screen is wrong.

## 1. Conventions

**Every write is a run.** The browser never posts a row. It posts a request
for a registered run, and the server previews and applies that run through
the same engine the scheduler uses (docs/03). The run log is the audit trail
of every change the interface ever made. `POST /api/firm/clients` is the
first example: the body becomes `INTAKE-CREATE-CLIENT`, then the three
intake runs that need a client to exist (`CLIENT_INTAKE_ORDER`).

**Every read is a named query.** Route handlers call `QueryCatalog` entries
inside a read only, repeatable read transaction (`readSession` in
`server/api/session.ts`). On Postgres the transaction carries `set local
role` to the application role and the actor settings, so row level security
applies to the API exactly as it does to a run. No route holds SQL.

**One envelope for errors.** Every error is
`{ "error": { "code", "message", "details"? } }`. Codes are lower snake
case and stable. The message is safe to show to a person. The auth
middleware's own refusals use the same envelope with `auth.` prefixed codes.

**Identifiers are UUIDs.** A client id that is not a UUID is refused before
any read. Periods are named by their first day, `YYYY-MM-01`. Money is
integer cents in fields ending `Cents`.

**Contracts live once.** `shared/api/*.ts` holds the Zod schemas. The server
parses requests with them; the client imports the inferred types. A field the
browser needs is added there first.

**Tenancy is in the path.** Firm routes take the firm from the actor's
membership (or the `X-Firm` header when there are several). Portal routes
carry `:clientId`, and `requireClient` proves the actor may see it before
the handler runs. A client scoped person never reaches `/api/firm/*`.

## 2. Route table

Every route is behind `requireUser`. Firm routes add `requireFirm`. Portal
routes add `requireClient` and, where marked, `requireFeature`.

| Method | Path | Guard | Answer | Notes |
|---|---|---|---|---|
| GET | `/api/auth/config` | none | `{ configured, developmentActor?, ... }` | Auth brief. `developmentActor: true` only on the memory port outside production. |
| GET | `/api/auth/me` | user | `Me` | Auth brief. The development actor answers as the firm owner. |
| GET | `/api/firm/overview` | firm | `FirmOverview` | Totals, one row per client, the last twenty runs. |
| GET | `/api/firm/clients` | firm | `ClientList` | Archived clients included, status says so. |
| POST | `/api/firm/clients` | firm | `201` or `207 { client, runs, complete }` | Runs `CLIENT_INTAKE_ORDER`. `207` when a run did not complete; `runs` says which. |
| GET | `/api/firm/clients/:clientId` | firm, client | `ClientSummary` | 404 when the client is not in this firm. |
| GET | `/api/firm/clients/:clientId/transactions` | firm, client | `TransactionPage` | `from`, `to`, `bankAccountId`, `search`, `uncategorized`, `limit`, `offset`. |
| GET | `/api/firm/clients/:clientId/runs` | firm, client | `RunHistory` | `runType`, `limit`, `offset`. Newest first. |
| POST | `/api/firm/clients/:clientId/runs/:runCode` | firm, client | `RunOutcomeDto` | Body `{ mode?, previewRunId?, scope? }`. Preview by default. The run's own scope schema is validated, so a missing `period` is a 400. 404 for an unknown run code. 409 when the engine refused. |
| GET | `/api/firm/runs/catalog` | firm | `{ items: RunCatalogItem[] }` | Every registered run with its tier and whether a client may trigger it. |
| POST | `/api/firm/runs/:logId/apply` | firm | `RunOutcomeDto` | Applies a preview by its log id. The engine checks the preview is fresh. |
| POST | `/api/firm/runs/:logId/undo` | firm | `RunOutcomeDto` | Body `{ reason }`. |
| GET | `/api/portal/:clientId/home` | client | `PortalHome` | Tier, features, closed periods, open requests. Never 403 on feature: the home page is how a person learns what they have. |
| GET | `/api/portal/:clientId/statements` | client, feature `statements` | `PortalStatements` | `period=YYYY-MM-01`, else the latest visible period. |
| GET | `/api/portal/:clientId/transactions` | client, feature `transactions` | `TransactionPage` | Same query as the firm route. |
| GET | `/api/portal/:clientId/requests` | client, feature `requests` | `{ items: PortalRequest[] }` | Open document requests. |
| POST | `/api/portal/:clientId/upload` | client, feature `documents` | `501 not_configured` | Needs document storage. |
| GET | `/api/portal/:clientId/documents` | client, feature `documents` | `501 not_configured` | Needs document storage. |
| GET | `/api/portal/:clientId/messages` | client, feature `messages` | `501 not_configured` | Needs mail. |
| POST | `/api/portal/:clientId/messages` | client, feature `messages` | `501 not_configured` | Needs mail. |

Anything else under `/api` is `404 not_found` in the envelope.

## 3. Read model choice

Three options were open: (a) extend `QueryCatalog` with API shaped queries,
(b) a separate SQL layer for the API, (c) views in the database. The API
uses (a).

Why. The catalog already has the discipline the API needs: every query is
named, has a memory and a Postgres implementation, and is checked against
the live schema by `script/check-queries.ts`. A second SQL layer would need
all of that again. Views would move logic into migrations that the memory
port cannot run, and the whole test suite runs on the memory port. Six
queries were added: `clients_for_firm`, `client_by_id`,
`engagements_for_client`, `run_log_for_client`, `run_log_recent_for_firm`,
and `transactions_page`. Counts for the overview come from existing queries
over the owning tables, composed in `server/api/reads.ts`, so a number on
the screen is always the count of rows a person could open.

The cost is that the overview does several queries per client. At a few
dozen clients that is fine. If it is not fine at a few hundred, the fix is
one aggregate query in the catalog, not a change in the route.

Statements are computed in `reads.ts` from `period_lines` by account range:
4000s revenue, 5000s cost of goods sold, 6000 to 7999 operating expenses,
8000s other, balance sheet cumulative with retained earnings presented on
3900. `foots` is false when assets do not equal liabilities plus equity.

## 4. Error map

`server/api/errors.ts`, `translate(err)`:

| Thrown | Status | Code |
|---|---|---|
| `ZodError` | 400 | `validation_failed`, `details` is a list of `{ path, message }` |
| `ApiFailure` | its own | its own |
| `FeatureNotInTierError` | 403 | `feature_not_included` |
| `LockedPeriodError` | 409 | `locked_period` |
| `OverrideProtectedError` | 409 | `override_protected` |
| `ImmutableLogError` | 409 | `check_violation` |
| `UniqueViolation` | 409 | `unique_violation` |
| `CheckViolation` | 422 | `check_violation` |
| `SerializationFailure` after one retry | 503 | `serialization_failure` |
| missing dependency | 501 | `not_configured` |
| anything else | 500 | `internal`, the raw message is logged, not shown |

Reads that fail with a serialization error are retried once
(`withOneRetry`). Writes are not: the engine's idempotency key makes a
repeat safe, so the browser retries by asking again.

The tiers brief's `requireFeature` answers in its own shape. The router
wraps it so the feature check throws into the translator and the envelope
stays the same. The client fetch (`client/src/api/http.ts`) also reads the
flat `{ code, message }` shape the auth middleware emits in one place, so no
screen depends on which middleware refused.

## 5. The development actor

On the memory port outside production the server has no tenancy schema to
resolve a person against, so `server/api/dev-actor.ts` supplies one: the
owner of a fixed development firm. `createActorMiddleware` is reused with a
verifier that accepts one token, and `assumeToken` puts that token on a
request that carries none. `/api/auth/config` says `developmentActor: true`
and the browser's `AuthProvider` fetches `/api/auth/me` so the header shows
a real firm.

Rules: on by default when `RUN_DB=memory` and `NODE_ENV` is not production.
`DEV_ACTOR=off` turns it off. Setting `DEV_ACTOR` in production, or with the
Postgres port, makes the server refuse to start. NOTES 221.

## 6. The client side

`client/src/api/` has one module per resource: `me`, `clients`, `overview`,
`runs`, `portal`, `transactions`, and `http` underneath. Each hook wraps
TanStack Query over `apiRequest` from `lib/queryClient.ts`, which already
adds the bearer and `X-Firm` headers. Query keys include the client id, so a
client switch never shows another client's cache. Mutations invalidate the
keys their run can change.

`usePortalClient` decides which client a portal screen reads: the header's
active client when the API knows it, else the first client the actor may
see. A client scoped person's memberships are the whole list.

## 7. How to add a screen

1. Find the rows the screen shows. If a query does not exist, add it to
   `QueryCatalog` in `server/runs/db.ts`, implement it in `db-memory.ts`
   and `db-postgres.ts`, and run `npx tsx script/check-queries.ts`.
2. Add or extend the contract in `shared/api/`. Zod schema plus inferred
   type. Money in cents, dates as `YYYY-MM-DD`, ids as UUID.
3. Add the read model function in `server/api/reads.ts` and the route in
   `server/api/router.ts` with `route(async (req) => ...)`. Parse params
   with the shared schema. Throw, do not `res.status`.
4. If the screen changes data, find the run. If there is no run, write one
   under `server/runs/runs/`, register it, give it a tier, and add it to
   `RUN_POLICIES`. The route is then `POST .../runs/:runCode`, or a named
   route that calls `runOnce` the way `createClient` does.
5. Add the hook in `client/src/api/<resource>.ts`. Key includes the client
   id.
6. Convert the screen: loading state, empty state with the copy from
   `client/src/data/labels.ts` voice, error state showing
   `errorMessage(error)` and a retry. Do not import the mock dataset.
7. Add a route test in `server/api/__tests__/routes.ts`: auth required,
   scope enforced, the happy path.
8. Run the gates in `docs/RUNNING.md` section 9: `npx tsc --noEmit`, the test harness, `check-style`, `check-books`, `check-schema`, `check-queries`, `npm run build`.

## 8. Known limits

- A client's draft engagement grants no features. Statements and
  transactions answer `403 feature_not_included` until a person activates
  the engagement. Intake does not activate it, by design (docs/10).
- Category ids are slugs and `ledger.categories` keeps a primary key on
  `id` alone, so the second client in one database fails
  `INTAKE-BUILD-CHART` with `categories_pkey`. The create route answers
  `207` and names the run. The fix is a migration that moves the key to
  `(client_id, id)`, which every referencing foreign key already uses, plus
  the matching change in the memory port. Recorded in api-report.md.
- Document storage and mail are not configured, so four portal routes
  answer `501`.
