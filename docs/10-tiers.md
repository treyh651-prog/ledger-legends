# Service Tiers

Three service levels, one vocabulary, decided by the public pricing page at
ledgerlegends.pro. The page is the truth. When code, a document, or a database
row disagrees with the page, the page wins and the other thing changes.

The names are Ledger, Ledger+, and Legend. The ids are `ledger`, `ledger_plus`,
`legend`. Story and Journey were earlier names for the first two levels and
are gone from the product and the docs.

## The rule about pricing

Pricing is never in the product. Not on the tiers screen, not in a table, not in
a feature summary, not in a refusal message. Tiers are bundled with the
engagement (decision D1 in docs/05-decisions.md). There is no checkout, no plan
picker, no upgrade button, and no payment surface. The price a client pays is a
line in the engagement letter and nowhere else. A test in
`server/runs/__tests__/entitlement.ts` fails if a tier or feature carries a
dollar amount.

## The three tiers

| Tier | Rank | Revenue band on the page | What the page promises |
| --- | --- | --- | --- |
| Ledger | 0 | up to $100,000 | monthly bank and card reconciliation, expense categorization with bank rules, monthly financial statements |
| Ledger+ | 1 | $100,000 to $250,000 | everything in Ledger, light AR and AP tracking, quarterly performance summary, priority support |
| Legend | 2 | $250,000 and up | everything in Ledger+, custom reports and KPI dashboards, accrual and loan tracking, monthly review, CPA ready books for tax time |

The revenue band is a guide for placing a client. It is stored for reference
and nothing enforces it. Monthly financial statements are part of every tier.

## The feature map

Each feature is listed once, at the lowest tier that includes it. A higher tier
includes it because its rank is higher, and for no other reason. Nothing is
stored twice. A feature with a route is a portal screen. A feature without one
is a deliverable the firm produces, recorded so the portal can say it is part
of the level.

| Feature key | Lowest tier | Label | Portal route |
| --- | --- | --- | --- |
| `statements` | Ledger | Monthly financial statements | /portal/statements |
| `transactions` | Ledger | Your transactions | /portal/transactions |
| `documents` | Ledger | Documents and upload | /portal/upload |
| `requests` | Ledger | Open requests | /portal/requests |
| `messages` | Ledger | Messages | /portal/messages |
| `reconciliation_status` | Ledger | Monthly reconciliation | none |
| `bank_rules` | Ledger | Categorization with bank rules | none |
| `aging` | Ledger+ | AR and AP tracking | /portal/aging |
| `compare` | Ledger+ | Month over month | /portal/compare |
| `quarterly_summary` | Ledger+ | Quarterly performance summary | none |
| `priority_support` | Ledger+ | Priority support | none |
| `custom_reports` | Legend | Custom reports and KPI dashboards | none |
| `budget` | Legend | Budget versus actual | /portal/budget |
| `forecast` | Legend | Thirteen week cash forecast | /portal/forecast |
| `narrative` | Legend | Period narrative | /portal/narrative |
| `scenarios` | Legend | Scenario comparison | /portal/scenarios |
| `consolidation` | Legend | Group consolidation | /portal/entities |
| `open_period` | Legend | Accrual tracking | /portal/open-period |
| `loans` | Legend | Loan tracking | none |
| `monthly_review` | Legend | Monthly review | none |
| `cpa_packet` | Legend | CPA ready books | none |

Statements, transactions, documents, requests, and messages are a client's own
records. They are at Ledger and are never held back at any level.

Two placements were decided rather than copied, and NOTES entry 213 carries the
full reasoning. Budget versus actual is at Legend because the page's Ledger+
text names AR and AP tracking, a quarterly summary, and support, and says
nothing about budgets; the page puts custom reports and KPI dashboards at
Legend, and a budget against actuals is one of those. The month over month
screen stays at Ledger+ under its own key, and `quarterly_summary` is a
separate Ledger+ key for the written summary the page promises, because the
screen compares months and the promise is a quarterly document.

`cpa_packet` is the packet compiled for the client's CPA. The firm compiles
books. It does not prepare tax forms and is not a CPA firm.

## Add ons

Payroll and cleanup are add ons on the public page. They attach to an
engagement at any tier. They are not tiers, they have no rank, and they grant
no feature. `hasFeature` never reads them and the entitlements view never
joins them.

| Add on | Meaning |
| --- | --- |
| `payroll` | Payroll support through the client's payroll provider. The firm approves a run; it never disburses and does not touch tax documents. |
| `cleanup` | Catch up and cleanup of prior periods, quoted separately before work starts. |

## Where each thing lives

| Thing | Place |
| --- | --- |
| The `TierId` type, `TIER_ORDER`, the feature keys, `hasFeature` | `shared/tiers.ts`, imported by server and client |
| The client's re export plus dataset helpers | `client/src/data/entitlement.ts` |
| Tiers as rows | `tenancy.service_tiers` (id, name, rank, tagline, revenue band) |
| Features as rows, once each at the lowest tier | `tenancy.tier_features` (tier_id, feature_key, label, summary) |
| Which tier an engagement has | `tenancy.engagements.service_level`, a foreign key to `service_tiers` |
| Add ons | `tenancy.engagement_addons` (engagement_id, addon, started_at, ended_at, terms) |
| What a client is entitled to today | view `tenancy.client_entitlements` (client_id, tier_id, rank, feature_key), derived from the active engagement |
| Server side loading and route middleware | `server/entitlement/` |
| The tiers screen | `client/src/pages/portal-tiers.tsx` |
| The migration | `db/migrations/0024_tiers.sql` |

`script/check-schema.ts` reads the two tier tables back and fails when they
disagree with `shared/tiers.ts`. Moving a feature between tiers is therefore a
change to the shared file and a migration, together.

The view runs as the caller (`security_invoker`), so the row level security
policy on `tenancy.engagements` decides what it returns. A client scoped actor
sees only its own client's rows. A client with no active engagement has no
rows and is entitled to nothing.

`entitlement.*` from migration 0007 is an earlier design with tiers named
solo, practice, and firm. No code reads it. It is left in place and retiring
it is a separate decision.
