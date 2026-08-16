# Ledger Legends

Multi tenant bookkeeping practice platform. This repository currently holds the front end only, running on a generated in memory mock dataset. No backend, no real authentication, no client records.

Live demo: https://ledgerlegends.pplx.app

## What is in here

27 routes across five modules.

**Client intake and onboarding**
Ten step intake wizard, client book, stage tracking from lead through cleanup to live.

**Core accounting engine**
44 account chart of accounts, transaction feed with a categorization rules engine, reconciliation workspace, AR and AP aging, journal entries with a post button gated on balance, reversal only corrections, balance sheet substantiation with linked support objects, financial statements with comparison periods.

**Practice management**
Close checklist with live gates, workload board, team capacity, communication log, open items.

**Reporting and client communication**
Report package builder, budget versus actual, thirteen week cash forecast, narrative generator, 1099 and W-9 tracker.

**Client portal**
Home, send documents with drag and drop plus mobile capture, document library, what we need, signatures and W-9, my reports, messages. Every document touch writes an append only audit row.

The plane switcher in the header toggles between the firm workspace and the client portal, and it also follows the route.

## Running it

```
npm install
npm run dev
```

Build a static bundle:

```
npm run build
```

Output lands in `dist/public`.

Verify the books foot:

```
npx tsx script/check-books.ts
```

## Rules this codebase follows

These are not style preferences, they are correctness rules. Do not relax them.

1. **Money is stored as integer cents.** Never a float. Format only at the render boundary.
2. **Debits must equal credits.** The post action stays disabled until an entry balances. `script/check-books.ts` asserts the trial balance and the balance sheet.
3. **Corrections are reversals.** Posted entries are never edited or deleted in place.
4. **The document audit trail is append only.** No row is ever updated or removed.
5. **No credential storage fields anywhere in the product.** Bank connections are represented, never secrets.
6. **No em dashes in UI copy, and no hyphens used as sentence connectors.** Plain, direct language.
7. **No localStorage.** State is in memory only, because the preview iframe blocks it.

## Known gaps

- State resets on refresh. Nothing is persisted, by design at this stage.
- The JS bundle is a single chunk of roughly 1 MB with no code splitting.
- The mock dataset carries 625 transactions, heavier than needed for a demo.
- `server/` is an unused Express scaffold from the template. It registers no endpoints.

## Planned backend

Not built yet. The evaluated direction is Neon Postgres on the Scale plan, WorkOS AuthKit or Clerk for auth, a private S3 bucket with versioning and Object Lock for the document vault, Vercel for the web app, and Trigger.dev for durable background jobs. The two structural reasons for that split: Supabase Storage objects are excluded from database backups, which is disqualifying for a product whose core artifact is a document vault, and Vercel Cron is best effort with no retry and possible overlap, which is unacceptable as the sole trigger for bank feed syncs.

Tenant isolation design, to be built before anything else touches real data: immutable `firm_id` and `client_id` columns, row level security enabled and forced on every tenant table, a security definer membership function wrapped in a select so it caches per statement, indexes on the discriminator columns, and a two tenant negative test in CI.

## Stack

React 18, TypeScript, Vite, Wouter for routing, Tailwind, Radix primitives, Recharts, TanStack Query.
