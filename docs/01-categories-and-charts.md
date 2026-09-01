# Ledger Legends: category taxonomy and chart templates

Status: implementation spec. This file is subordinate to `docs/00-conventions.md`. Where this file and the conventions file disagree, the conventions file wins and this file is the defect.

Scope: the category layer, the shared core chart every client receives, and the four seeded chart templates `TPL-RETAIL-WHOLESALE`, `TPL-CONTRACTOR`, `TPL-SERVICE-STUDIO`, and `TPL-NONPROFIT`. The four seeded clients that consume them are Bramble & Bean (coffee roaster and wholesaler, LLC), Northgate Mechanical (commercial HVAC contractor, S Corp), Marisol Ceramics Studio (ceramics studio and online retail, sole proprietor), and Riverbend Youth Arts (arts education nonprofit).

Everything below obeys the four digit account blocks in Part 1 of the conventions, the category attribute list in Part 2, the clearing and suspense block, the coding cascade in Part 3, and the close gates in Part 5.

---

## Part 1. The category taxonomy

### 1.1 How a category relates to an account

The relationship is many to one and it is enforced in the schema, not by convention.

| Property | Rule |
|---|---|
| Cardinality | One category maps to exactly one account. One account is the target of zero or many categories. |
| Direction of authority | The account owns the financial statement line. The category owns the coding vocabulary and the policy answers. |
| Who picks what | A person or a run picks a category, never an account. Journal entry lines are the only place an account is selected directly, and only by a person with the journal entry role. |
| Sign check | `normal_side` on the category is compared to the sign of the resolved transaction line. A mismatch does not block the posting, it raises the row for review, because a credit to an expense category is legitimate for a vendor refund and illegitimate for a vendor invoice. |
| Statement stability | Adding, renaming, or retiring a category never changes a statement line. Only an account change does that. This is the reason the two tables are separate. |
| Dimensions | Job, class, program, location, and functional class are dimensions on the transaction line. A category may require one through `requires_class`, but a category never becomes a dimension and a dimension never becomes an account. |

Consequence for the cascade: rules, vendor defaults, recurring templates, and bank code mappings all target categories. Nothing in levels 3 through 8 of the cascade in Part 3 of the conventions can name an account. Only level 9, the suspense terminator, names an account directly, and the account it names is always 1990.

### 1.2 Grouping for reporting

Grouping is a separate concern from mapping, and it is deliberately not a new category attribute, because Part 2 of the conventions fixes the attribute list. Grouping lives in a `category_group` table with ids of the form `CGRP-` plus slug, versioned like everything else. A group holds categories, and a group may hold other groups, forming a tree per grouping scheme.

Four grouping schemes exist. Each answers a different reader's question.

| Scheme | Built from | Reader | Example line |
|---|---|---|---|
| `STATEMENT` | The category's `account`, then the account's block and type | Lender, tax preparer, board | Cost of goods sold, one line |
| `MANAGEMENT` | `CGRP-` tree, independent of the account | Owner and firm | Green coffee, packaging, roasting fuel, freight in, each its own line inside a gross margin block |
| `TAX` | `tax_treatment` crossed with the account | Tax preparer | Meals subject to the 50 percent limit, nondeductible penalties, owner draws excluded from the return |
| `FUNCTIONAL` | The functional dimension on the line, not the category | Nonprofit board, Form 990 preparer, auditor | Program, management and general, fundraising |

Rules for the schemes:

1. `STATEMENT` is derived, never hand maintained. A category cannot be excluded from it and cannot appear twice in it.
2. `MANAGEMENT` is hand maintained and is allowed to disagree with the statement grouping in ordering and in depth, but not in totals. The sum of every management group at the top level must equal the sum of the statement grouping for the same period, and a CI test asserts it.
3. A category belongs to exactly one management group. Multi parent grouping is refused, because it makes totals ambiguous and it is the fastest route to a management report that does not tie to the trial balance.
4. Every category must belong to a management group. A category created without one lands in `CGRP-UNGROUPED`, which is reported on the chart health screen as a defect rather than tolerated silently.
5. `TAX` and `FUNCTIONAL` are derived and cannot be hand edited on a category.

### 1.3 Retirement versus deletion

Retirement is the normal operation. Deletion is a narrow exception that exists only so a mistake made during intake, before any activity, can be cleaned up.

**Retire.** Set `is_active` to false. Effects:

- The category disappears from every coding picker for new work.
- Historical transactions coded to it keep their coding, their category version stamp, and their provenance level. Nothing is restated.
- Reports covering a historical period still show the category, marked retired in the chart health view only, never on a client facing statement.
- Any rule, vendor default, recurring template, or bank code mapping that targets it is flagged as pointing at a retired target. The retirement action lists them and requires either a replacement target or explicit acknowledgement that the rule is being retired with it. A rule pointing at a retired category is a level 6 hit that resolves to a dead target, which would otherwise silently push transactions to suspense.
- Retirement is versioned. The category row gains a new version with `is_active` false, and the prior version remains readable.

**Delete.** Permitted only when all of the following hold, checked in one transaction:

1. Zero transaction lines have ever referenced the category, in any version, in any period, including voided and reversed lines.
2. Zero rules, vendor defaults, recurring templates, and bank code mappings reference it.
3. It is not a member of the universal spine in Part 6 below.
4. No closed period exists for the client, or the category was created after the latest closed period and has no activity.

Anything else retires. The `INTAKE-BUILD-CHART` reversal already encodes the same test at the record level, retaining anything in use and reporting `retained_in_use`.

**Merging two categories.** Not a delete and not a rename. It is three actions with an audit trail: retire the losing category, add a successor mapping from the loser to the winner so historical management grouping stays coherent, and, if the two mapped to different accounts, post a reclassifying journal entry in the earliest open period. Historical periods are never reopened to make a merge look tidy. That is what `SUS-20` and the reversing entry model are for.

**Changing a category's account.** Allowed, versioned, and never retroactive. The new version carries the new account and applies to transactions coded from the effective date forward. Prior transactions keep the old account. If the client or a lender needs the prior periods moved, that is a reclassifying journal entry with a stated reason, not a silent remap. A remap that rewrote history would break gate G05 reproducibility and would make the run log indefensible.

**Deactivating an account.** An account may only be deactivated when its balance is zero and every category pointing at it is retired or repointed. The five clearing and suspense accounts can never be deactivated on any chart.

### 1.4 Worked example: many categories, one account

Bramble & Bean, `TPL-RETAIL-WHOLESALE`. Account 5000 Cost of goods sold is one line on the profit and loss statement. Thirteen categories roll into it. The gross margin conversation happens at category level, the lender sees one number, and no chart change is required to change the conversation.

| Category | Management group | `tax_treatment` | `1099_class` | Notes |
|---|---|---|---|---|
| `CAT-COFFEE-GREEN` | `CGRP-COGS-PRODUCT` | `deductible` | `none` | Green coffee purchases, importer invoices |
| `CAT-COFFEE-DECAF` | `CGRP-COGS-PRODUCT` | `deductible` | `none` | Tracked apart because margin differs |
| `CAT-FREIGHT-IN` | `CGRP-COGS-PRODUCT` | `deductible` | `none` | Inbound freight and duty, a cost of the goods |
| `CAT-PACKAGING` | `CGRP-COGS-PACKAGING` | `deductible` | `none` | Bags, valves, tins |
| `CAT-LABELS` | `CGRP-COGS-PACKAGING` | `deductible` | `none` | Printed labels and stickers |
| `CAT-ROASTING-FUEL` | `CGRP-COGS-CONVERSION` | `deductible` | `none` | Propane and metered production power |
| `CAT-ROASTING-LABOR` | `CGRP-COGS-CONVERSION` | `deductible` | `none` | Direct production wages moved from 6300 by the labor allocation entry |
| `CAT-COGS-MERCH` | `CGRP-COGS-RESALE` | `deductible` | `none` | Brewers, mugs, and gear bought for resale |
| `CAT-COGS-TOLL-ROAST` | `CGRP-COGS-CONVERSION` | `deductible` | `nec` | Third party roasting done for the company |
| `CAT-CUPPING-SAMPLES` | `CGRP-COGS-PRODUCT` | `deductible` | `none` | Green samples consumed in quality control |
| `CAT-COGS-CLEARING-ADJ` | `CGRP-COGS-PRODUCT` | `not_applicable` | `none` | Standard cost to actual true up, journal entry only |
| `CAT-COFFEE-SPOT` | `CGRP-COGS-PRODUCT` | `deductible` | `none` | Spot market purchases outside contract |
| `CAT-COGS-BROKER-FEE` | `CGRP-COGS-PRODUCT` | `deductible` | `nec` | Green buying commissions, part of product cost |

What this buys:

- The statement stays at three cost of sales lines for the whole template, 5000, 5010, and 5020.
- The owner can be told that packaging is eleven percent of revenue without anyone touching the chart.
- If the client later wants freight in on its own statement line, that is a one account addition plus repointing a single category version, and it does not disturb the other twelve.
- The 1099 run reads `1099_class` from the category, so a broker commission inside cost of goods sold is still captured for Form 1099-NEC even though it sits in the same account as green coffee. The reporting threshold is 2,000 dollars per payee per calendar year for payments made on or after January 1, 2026 ([Littler](https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds)).

---

## Part 2. The shared core chart of accounts

Every client gets every account in this part, on every template, regardless of entity type. Payroll, sales tax, and debt accounts stay dormant with zero balances where the engagement scope excludes them, and the matching close gates report not applicable with the scope reason rather than failing. The one exception is stated in Part 5: `TPL-NONPROFIT` does not use 3900 and carries net assets in 3000 and 3100 instead.

There is no "ask my accountant" account and no "uncategorized expense" account on any chart. Account 1990 does that job with a reason code, and it blocks the close through gate G01. An expense account for unknown items would let unresolved coding pass silently into the profit and loss statement, which is exactly the defect the suspense design removes.

### 2.1 Assets

| Account | Name | Type | Normal side |
|---|---|---|---|
| 1000 | Operating checking | Asset | Debit |
| 1010 | Payroll checking | Asset | Debit |
| 1020 | Savings and reserve | Asset | Debit |
| 1030 | Petty cash | Asset | Debit |
| 1100 | Accounts receivable, trade | Asset | Debit |
| 1190 | Allowance for doubtful accounts | Contra asset | Credit |
| 1300 | Prepaid insurance | Asset | Debit |
| 1310 | Prepaid software and subscriptions | Asset | Debit |
| 1390 | Other prepaid and current assets | Asset | Debit |
| 1400 | Employee advances | Asset | Debit |
| 1410 | Other receivables | Asset | Debit |
| 1500 | Furniture and fixtures | Asset | Debit |
| 1510 | Computer and office equipment | Asset | Debit |
| 1520 | Leasehold improvements | Asset | Debit |
| 1600 | Accumulated depreciation, furniture and fixtures | Contra asset | Credit |
| 1610 | Accumulated depreciation, computer and office equipment | Contra asset | Credit |
| 1620 | Accumulated amortization, leasehold improvements | Contra asset | Credit |
| 1800 | Security deposits | Asset | Debit |

Each 15xx cost account pairs with the 16xx contra at cost plus 100, as Part 1 of the conventions requires and as `INTAKE-BUILD-CHART` enforces.

### 2.2 The clearing and suspense block

Reproduced verbatim from Part 1 of the conventions.

> These five accounts exist on every chart regardless of template.
>
> | Account | Name | Must be zero at close |
> |---|---|---|
> | 1900 | Undeposited funds | No. Must be supported by a deposits in transit list. |
> | 1910 | Payment processor clearing | Yes |
> | 1920 | Transfer clearing | Yes |
> | 1930 | Payroll clearing | Yes |
> | 1990 | Suspense | Yes |
>
> Suspense is a real account with a real balance, not a UI state. That is the whole point. An uncoded transaction is not invisible, it is sitting in 1990 with a reason code, and it stops the close.

Type and normal side for the same five, since the table above states the close obligation rather than the accounting attributes:

| Account | Name | Type | Normal side |
|---|---|---|---|
| 1900 | Undeposited funds | Asset | Debit |
| 1910 | Payment processor clearing | Asset, clearing | Debit |
| 1920 | Transfer clearing | Asset, clearing | Debit |
| 1930 | Payroll clearing | Asset, clearing | Debit |
| 1990 | Suspense | Asset, clearing | Debit |

Normal side debit for all five is a presentation default, not an assertion. A clearing account legitimately sits on either side inside a period, so each of the five carries a standing stated reason of `clearing_account_two_sided` for gate G15 purposes. The real control on these accounts is gate G01, which requires 1910, 1920, 1930, and 1990 to be zero at close, and gate G08, which requires 1900 to agree to the deposits in transit list.

### 2.3 Liabilities

| Account | Name | Type | Normal side |
|---|---|---|---|
| 2000 | Accounts payable, trade | Liability | Credit |
| 2100 | Credit card payable | Liability | Credit |
| 2110 | Line of credit | Liability | Credit |
| 2200 | Accrued expenses | Liability | Credit |
| 2210 | Accrued interest payable | Liability | Credit |
| 2300 | Wages and salaries payable | Liability | Credit |
| 2310 | Payroll taxes payable | Liability | Credit |
| 2320 | Employee withholdings and benefit deductions payable | Liability | Credit |
| 2400 | Sales and use tax payable | Liability | Credit |
| 2500 | Deferred revenue and customer deposits | Liability | Credit |
| 2600 | Current portion of long term debt | Liability | Credit |
| 2700 | Notes payable, long term | Liability | Credit |
| 2900 | Due to related parties | Liability | Credit |

### 2.4 Equity

| Account | Name | Type | Normal side |
|---|---|---|---|
| 3900 | Accumulated earnings, prior years | Equity | Credit |

The rest of the 3000 block is template specific, because equity is where entity type actually changes the accounting. See Part 8.

### 2.5 Revenue, contra revenue

| Account | Name | Type | Normal side |
|---|---|---|---|
| 4900 | Sales discounts and allowances | Contra revenue | Debit |
| 4910 | Returns and refunds | Contra revenue | Debit |

Accounts 4000 through 4899 are template specific. The core deliberately owns no gross revenue account, because a generic "sales" account that every template renames produces charts that look identical and report nothing.

### 2.6 Operating expenses

| Account | Name | Type | Normal side |
|---|---|---|---|
| 6000 | Advertising and marketing | Expense | Debit |
| 6010 | Bank service charges | Expense | Debit |
| 6020 | Merchant and payment processing fees | Expense | Debit |
| 6030 | Licenses, registrations, and filing fees | Expense | Debit |
| 6040 | Software and cloud subscriptions | Expense | Debit |
| 6050 | Dues and memberships | Expense | Debit |
| 6060 | Insurance, general business | Expense | Debit |
| 6070 | Meals, subject to the 50 percent limit | Expense | Debit |
| 6080 | Office supplies | Expense | Debit |
| 6090 | Postage and courier | Expense | Debit |
| 6100 | Accounting and bookkeeping fees | Expense | Debit |
| 6110 | Legal fees | Expense | Debit |
| 6120 | Consulting and other professional fees | Expense | Debit |
| 6130 | Rent, facility | Expense | Debit |
| 6140 | Repairs and maintenance | Expense | Debit |
| 6150 | Tools and equipment below the capitalization threshold | Expense | Debit |
| 6160 | Telephone and internet | Expense | Debit |
| 6170 | Travel | Expense | Debit |
| 6180 | Utilities | Expense | Debit |
| 6190 | Training and continuing education | Expense | Debit |
| 6300 | Wages and salaries | Expense | Debit |
| 6310 | Payroll taxes, employer | Expense | Debit |
| 6320 | Employee benefits | Expense | Debit |
| 6330 | Workers compensation insurance | Expense | Debit |
| 6340 | Contract labor and outside services | Expense | Debit |
| 6800 | Depreciation expense | Expense | Debit |
| 6810 | Amortization expense | Expense | Debit |
| 6900 | Bad debt expense | Expense | Debit |
| 7900 | Penalties and fines, nondeductible | Expense | Debit |
| 7910 | Other nondeductible expense | Expense | Debit |

Account 6070 exists as its own account rather than as a category attribute alone because the 50 percent limit on business meals is a statutory computation the tax package has to make from a clean number, and a preparer should be able to read it off the trial balance ([IRS Publication 463](https://www.irs.gov/pub/irs-pdf/p463.pdf)). The category still carries `tax_treatment = meals_50`, so the two agree and either one can be audited against the other.

Account 6150 is the expense side of the capitalization decision. Its categories carry `capitalize_over`, defaulted to 250000 cents per Part 2 of the conventions and settable per client, because the de minimis safe harbor is 2,500 dollars per invoice or item without applicable financial statements and 5,000 dollars with them ([IRS tangible property final regulations](https://www.irs.gov/businesses/small-businesses-self-employed/tangible-property-final-regulations)). An item over the threshold does not silently expense and does not silently capitalize. It routes to `SUS-09` for a firm decision.

### 2.7 Other income and expense, tax, memo

| Account | Name | Type | Normal side |
|---|---|---|---|
| 8000 | Interest income | Other income | Credit |
| 8100 | Interest expense | Other expense | Debit |
| 8200 | Gain or loss on disposal of assets | Other income or expense | Credit |
| 8900 | Other income | Other income | Credit |
| 9000 | State income and franchise tax expense | Tax expense | Debit |
| 9900 | Memo, book to tax differences | Memo | Debit |
| 9910 | Memo, owner or shareholder basis tracking | Memo | Debit |

Accounts 9900 and 9910 never appear on a published statement, per the 9000 block definition in the conventions. They exist so basis and book to tax work has a home inside the ledger instead of in a spreadsheet nobody versions. Both are excluded from gate G05 presentation but included in the trial balance, so they must still net to zero against their own contra postings.

Shared core total: 64 accounts, of which 5 are the mandatory clearing block.

---

## Part 3. `TPL-RETAIL-WHOLESALE`

Bramble & Bean. Coffee roaster and wholesaler, LLC taxed as a partnership or as a disregarded entity depending on member count. The accounting problems are inventory in three states, inbound freight as product cost, two revenue channels with different margins, and packaging that is sometimes product cost and sometimes marketing.

### 3.1 Accounts added to the shared core

| Account | Name | Type | Normal side | Scope key |
|---|---|---|---|---|
| 1200 | Inventory, green coffee | Asset | Debit | `inventory` |
| 1210 | Inventory, finished goods, roasted coffee | Asset | Debit | `inventory` |
| 1220 | Inventory, packaging and shipping supplies | Asset | Debit | `inventory` |
| 1230 | Inventory, merchandise for resale | Asset | Debit | `inventory` |
| 1290 | Inventory valuation reserve, shrink and obsolescence | Contra asset | Credit | `inventory` |
| 1530 | Roasting and production equipment | Asset | Debit | `fixed_assets` |
| 1540 | Delivery vehicles | Asset | Debit | `fixed_assets` |
| 1630 | Accumulated depreciation, roasting and production equipment | Contra asset | Credit | `fixed_assets` |
| 1640 | Accumulated depreciation, delivery vehicles | Contra asset | Credit | `fixed_assets` |
| 2510 | Gift card and stored value liability | Liability | Credit | always |
| 2520 | Wholesale customer deposits and prepayments | Liability | Credit | always |
| 3000 | Member contributions | Equity | Credit | always |
| 3100 | Member distributions and draws | Equity, contra | Debit | always |
| 4000 | Wholesale revenue, coffee | Revenue | Credit | always |
| 4010 | Wholesale revenue, private label and toll roasting | Revenue | Credit | always |
| 4100 | Retail revenue, cafe and direct | Revenue | Credit | always |
| 4110 | Retail revenue, online | Revenue | Credit | always |
| 4120 | Retail revenue, subscription | Revenue | Credit | always |
| 4200 | Merchandise and equipment revenue | Revenue | Credit | always |
| 4300 | Shipping and handling billed to customers | Revenue | Credit | always |
| 5000 | Cost of goods sold | Cost of goods sold | Debit | always |
| 5010 | Inventory shrink, spoilage, and adjustments | Cost of goods sold | Debit | `inventory` |
| 5020 | Outbound shipping and fulfillment cost | Cost of goods sold | Debit | always |
| 6400 | Wholesale commissions and broker fees | Expense | Debit | always |
| 6410 | Trade shows, markets, and sampling | Expense | Debit | always |
| 6420 | Online sales channel and marketplace fees | Expense | Debit | always |
| 6500 | Vehicle fuel | Expense | Debit | `vehicles` |
| 6510 | Vehicle repairs and maintenance | Expense | Debit | `vehicles` |
| 6520 | Vehicle insurance and registration | Expense | Debit | `vehicles` |
| 6530 | Cafe and retail supplies, not for resale | Expense | Debit | always |

Design notes:

- Inbound freight rolls into 5000 through `CAT-FREIGHT-IN`, not into a separate account, because freight to bring goods in is a cost of the goods. Outbound shipping to a customer sits in 5020 and the amount billed to that customer sits in 4300, so the fulfillment margin is readable without polluting product margin.
- Whether the client must maintain inventory for tax purposes at all is a gross receipts question. A small business taxpayer can be exempt from the section 471 inventory rules under the Tax Cuts and Jobs Act small taxpayer provisions, with the threshold indexed for inflation ([The Tax Adviser](https://www.thetaxadviser.com/issues/2021/may/highlights-small-business-taxpayer-regulations/)). The template still carries the inventory accounts, because the client needs a book inventory to price wholesale accounts and to reconcile subledger to control under gate G09 whatever the tax method is. Any tax method election is recorded as a book to tax difference in 9900, not by degrading the books.
- 1290 is a reserve, not a plug. The shrink entry goes through 5010 with a stated count sheet.
- Packaging is a two answer question and the categories answer it once. Packaging that leaves with the product is product cost. A branded tote given away at a market is 6410.

### 3.2 Categories

`requires_receipt_over` is integer cents, null means no threshold. `capitalize_over` is integer cents, null means the category never routes to the fixed asset register.

| Category | `account` | `normal_side` | `tax_treatment` | `1099_class` | `requires_receipt_over` | `requires_class` | `capitalize_over` | `restriction_relevant` |
|---|---|---|---|---|---|---|---|---|
| `CAT-REV-WHOLESALE-COFFEE` | 4000 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-WHOLESALE-PRIVATE-LABEL` | 4010 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-RETAIL-CAFE` | 4100 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-RETAIL-ONLINE` | 4110 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-SUBSCRIPTION` | 4120 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-MERCH` | 4200 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-SHIPPING-BILLED` | 4300 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-DISCOUNT-WHOLESALE` | 4900 | debit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REFUND-CUSTOMER` | 4910 | debit | `not_applicable` | `none` | null | false | null | false |
| `CAT-COFFEE-GREEN` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-COFFEE-DECAF` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-COFFEE-SPOT` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-FREIGHT-IN` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-PACKAGING` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-LABELS` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-ROASTING-FUEL` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-ROASTING-LABOR` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-COGS-MERCH` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-COGS-TOLL-ROAST` | 5000 | debit | `deductible` | `nec` | null | false | null | false |
| `CAT-COGS-BROKER-FEE` | 5000 | debit | `deductible` | `nec` | null | false | null | false |
| `CAT-CUPPING-SAMPLES` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-COGS-CLEARING-ADJ` | 5000 | debit | `not_applicable` | `none` | null | false | null | false |
| `CAT-INVENTORY-SHRINK` | 5010 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-SHIPPING-OUT` | 5020 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-INVENTORY-PURCHASE-GREEN` | 1200 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-INVENTORY-PURCHASE-PACKAGING` | 1220 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-BROKER-COMMISSION` | 6400 | debit | `deductible` | `nec` | null | false | null | false |
| `CAT-TRADE-SHOW` | 6410 | debit | `deductible` | `none` | 7500 | false | null | false |
| `CAT-PLATFORM-FEES` | 6420 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-CAFE-SUPPLIES` | 6530 | debit | `deductible` | `none` | 7500 | false | null | false |
| `CAT-VEHICLE-FUEL` | 6500 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-VEHICLE-REPAIR` | 6510 | debit | `deductible` | `none` | 7500 | false | 250000 | false |
| `CAT-VEHICLE-INSURANCE` | 6520 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-ROASTER-EQUIPMENT` | 1530 | debit | `capital` | `none` | 0 | false | 250000 | false |
| `CAT-DELIVERY-VEHICLE` | 1540 | debit | `capital` | `none` | 0 | false | 0 | false |
| `CAT-MEALS-CLIENT` | 6070 | debit | `meals_50` | `none` | 2500 | false | null | false |
| `CAT-RENT-ROASTERY` | 6130 | debit | `deductible` | `misc_rent` | null | false | null | false |
| `CAT-LEGAL-FEES` | 6110 | debit | `deductible` | `attorney` | null | false | null | false |
| `CAT-MEMBER-DRAW` | 3100 | debit | `owner_draw` | `none` | null | false | null | false |
| `CAT-MEMBER-CONTRIBUTION` | 3000 | credit | `owner_contribution` | `none` | null | false | null | false |
| `CAT-GIFT-CARD-SOLD` | 2510 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-WHOLESALE-DEPOSIT` | 2520 | credit | `not_applicable` | `none` | null | false | null | false |

`CAT-DELIVERY-VEHICLE` carries `capitalize_over` of 0 because a vehicle is capitalized regardless of cost and the safe harbor does not apply to it. `CAT-ROASTER-EQUIPMENT` and `CAT-DELIVERY-VEHICLE` carry `requires_receipt_over` of 0 because a fixed asset addition always needs the invoice for the register.

---

## Part 4. `TPL-CONTRACTOR`

Northgate Mechanical. Commercial HVAC contractor, S Corp, seeded as a cleanup client. The accounting problems are job costing with a required job dimension, revenue recognized over time so billings and earned revenue diverge, retainage held both ways, subcontractor 1099 exposure, and shareholder compensation.

### 4.1 Accounts added to the shared core

| Account | Name | Type | Normal side | Scope key |
|---|---|---|---|---|
| 1120 | Retainage receivable | Asset | Debit | always |
| 1130 | Contract assets, costs and estimated earnings in excess of billings | Asset | Debit | always |
| 1140 | Uninstalled materials at job sites | Asset | Debit | always |
| 1200 | Inventory, materials and parts | Asset | Debit | `inventory` |
| 1530 | Service vehicles | Asset | Debit | `fixed_assets` |
| 1540 | Field equipment and tools | Asset | Debit | `fixed_assets` |
| 1550 | Shop and yard equipment | Asset | Debit | `fixed_assets` |
| 1630 | Accumulated depreciation, service vehicles | Contra asset | Credit | `fixed_assets` |
| 1640 | Accumulated depreciation, field equipment and tools | Contra asset | Credit | `fixed_assets` |
| 1650 | Accumulated depreciation, shop and yard equipment | Contra asset | Credit | `fixed_assets` |
| 2010 | Retainage payable, subcontractors | Liability | Credit | always |
| 2230 | Accrued job costs | Liability | Credit | always |
| 2340 | Accrued paid time off | Liability | Credit | `payroll` |
| 2350 | Union and prevailing wage fringe payable | Liability | Credit | `payroll` |
| 2510 | Contract liabilities, billings in excess of costs and earnings | Liability | Credit | always |
| 3000 | Common stock | Equity | Credit | always |
| 3010 | Additional paid in capital | Equity | Credit | always |
| 3100 | Shareholder distributions | Equity, contra | Debit | always |
| 4000 | Contract revenue, new construction | Revenue | Credit | always |
| 4010 | Contract revenue, retrofit and tenant improvement | Revenue | Credit | always |
| 4020 | Contract revenue, change orders | Revenue | Credit | always |
| 4100 | Service and repair revenue | Revenue | Credit | always |
| 4110 | Maintenance agreement revenue | Revenue | Credit | always |
| 4200 | Equipment and parts sales revenue | Revenue | Credit | always |
| 4990 | Contract revenue adjustment, over and under billings | Revenue | Credit | always |
| 5000 | Job cost, direct labor | Direct job cost | Debit | always |
| 5010 | Job cost, labor burden | Direct job cost | Debit | always |
| 5020 | Job cost, materials and equipment | Direct job cost | Debit | always |
| 5030 | Job cost, subcontractors | Direct job cost | Debit | always |
| 5040 | Job cost, permits and inspections | Direct job cost | Debit | always |
| 5050 | Job cost, equipment and crane rental | Direct job cost | Debit | always |
| 5060 | Job cost, freight and delivery | Direct job cost | Debit | always |
| 5070 | Job cost, travel, lodging, and per diem | Direct job cost | Debit | always |
| 5080 | Job cost, warranty and rework | Direct job cost | Debit | always |
| 5090 | Job cost, other direct | Direct job cost | Debit | always |
| 5100 | Job cost, small tools and consumables | Direct job cost | Debit | always |
| 6350 | Officer compensation, shareholder employee | Expense | Debit | `payroll` |
| 6360 | Shareholder health insurance included in W-2 wages | Expense | Debit | `payroll` |
| 6500 | Vehicle fuel | Expense | Debit | `vehicles` |
| 6510 | Vehicle repairs and maintenance | Expense | Debit | `vehicles` |
| 6520 | Vehicle insurance and registration | Expense | Debit | `vehicles` |
| 6540 | Equipment repairs and maintenance | Expense | Debit | always |
| 6600 | Bonding, licensing, and company permits | Expense | Debit | always |
| 6610 | Builders risk and installation floater insurance | Expense | Debit | always |
| 6620 | Safety, protective equipment, and field training | Expense | Debit | always |

Design notes:

- **Over and under billings.** Under billings, the amount of costs and estimated earnings in excess of billings, are a contract asset. Over billings, billings in excess of costs and earnings, are a contract liability ([EisnerAmper](https://www.eisneramper.com/insights/real-estate/contract-assets-liabilities-within-asc-topic-606-construction-industry-0622/)). The work in progress entry runs monthly, debits or credits 4990, and posts the balancing side to 1130 or 2510. The entry is computed per contract and the resulting asset and liability are not offset against each other across contracts, which matches the requirement to net at the individual contract level and then present the totals ([PwC](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/financial_statement_/financial_statement___18_US/Chapter-33--Revenue-and-contract-costs/33-3-Presenting-contract-related-assets-and-liabilities-ASC-606.html)).
- **Retainage.** Retainage receivable sits in 1120 rather than inside trade receivables at 1100, because a receivable under the revenue standard is an unconditional right to consideration where only the passage of time is required, and retainage is usually conditioned on future performance such as final acceptance ([EisnerAmper](https://www.eisneramper.com/insights/real-estate/contract-assets-liabilities-within-asc-topic-606-construction-industry-0622/)). Where the contract makes retainage unconditional, the client policy can reclassify it to 1100. Because 1120 is not part of the AR control account, gate G04 tests 1100 against the AR subledger and tests 1120 against the retainage schedule separately.
- **Placement of 1130 and 1140.** Both sit in the 1100 block rather than the 1400 block because a contract asset is an unbilled receivable arising from performance already delivered, and reading it next to trade receivables is how a lender and a surety expect to see it. Neither is part of the AR control account, so both are excluded from the AR side of gate G04 and are tied out separately under gate G07.
- **Subcontractor retainage withheld** is a credit to 2010, not a reduction of 5030. Job cost is the full committed amount, so job profitability is not distorted by cash timing.
- **The job dimension is mandatory.** Every 5xxx category carries `requires_class = true`. A direct job cost without a job cannot be coded, it goes to `SUS-03`. Forty jobs do not produce forty accounts, per the dimensions rule in the conventions.
- **Labor burden.** Payroll posts gross to 6300, 6310, 6320, and 6330 at first, then the burden allocation entry moves direct crew cost to 5000 and burden to 5010 with the job dimension attached. Overhead labor stays in 6300. This keeps the payroll provider report reconcilable under gate G11 while still producing a real job cost.
- **Officer compensation is its own account.** 6350 is separate from 6300 so that officer compensation is readable directly for the Form 1120-S officer compensation line and for the reasonable compensation analysis. See Part 8.

### 4.2 Categories

| Category | `account` | `normal_side` | `tax_treatment` | `1099_class` | `requires_receipt_over` | `requires_class` | `capitalize_over` | `restriction_relevant` |
|---|---|---|---|---|---|---|---|---|
| `CAT-REV-CONTRACT-NEW` | 4000 | credit | `not_applicable` | `none` | null | true | null | false |
| `CAT-REV-CONTRACT-RETROFIT` | 4010 | credit | `not_applicable` | `none` | null | true | null | false |
| `CAT-REV-CHANGE-ORDER` | 4020 | credit | `not_applicable` | `none` | null | true | null | false |
| `CAT-REV-SERVICE` | 4100 | credit | `not_applicable` | `none` | null | true | null | false |
| `CAT-REV-MAINTENANCE-AGREEMENT` | 4110 | credit | `not_applicable` | `none` | null | true | null | false |
| `CAT-REV-EQUIPMENT-SALE` | 4200 | credit | `not_applicable` | `none` | null | true | null | false |
| `CAT-WIP-REVENUE-ADJ` | 4990 | credit | `not_applicable` | `none` | null | true | null | false |
| `CAT-JOB-LABOR` | 5000 | debit | `deductible` | `none` | null | true | null | false |
| `CAT-JOB-LABOR-BURDEN` | 5010 | debit | `deductible` | `none` | null | true | null | false |
| `CAT-JOB-MATERIALS` | 5020 | debit | `deductible` | `none` | 7500 | true | 250000 | false |
| `CAT-JOB-EQUIPMENT-PURCHASE` | 5020 | debit | `deductible` | `none` | 0 | true | 250000 | false |
| `CAT-JOB-SUBCONTRACTOR` | 5030 | debit | `deductible` | `nec` | 0 | true | null | false |
| `CAT-JOB-PERMITS` | 5040 | debit | `deductible` | `none` | 0 | true | null | false |
| `CAT-JOB-EQUIPMENT-RENTAL` | 5050 | debit | `deductible` | `misc_rent` | 7500 | true | null | false |
| `CAT-JOB-FREIGHT` | 5060 | debit | `deductible` | `none` | null | true | null | false |
| `CAT-JOB-TRAVEL` | 5070 | debit | `deductible` | `none` | 7500 | true | null | false |
| `CAT-JOB-PERDIEM` | 5070 | debit | `deductible` | `none` | null | true | null | false |
| `CAT-JOB-WARRANTY` | 5080 | debit | `deductible` | `none` | null | true | null | false |
| `CAT-JOB-OTHER-DIRECT` | 5090 | debit | `deductible` | `none` | 7500 | true | null | false |
| `CAT-JOB-SMALL-TOOLS` | 5100 | debit | `deductible` | `none` | 7500 | true | 250000 | false |
| `CAT-RETAINAGE-BILLED` | 1120 | debit | `not_applicable` | `none` | null | true | null | false |
| `CAT-RETAINAGE-SUB-WITHHELD` | 2010 | credit | `not_applicable` | `none` | null | true | null | false |
| `CAT-UNINSTALLED-MATERIALS` | 1140 | debit | `not_applicable` | `none` | 0 | true | null | false |
| `CAT-PARTS-INVENTORY-PURCHASE` | 1200 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-OFFICER-COMP` | 6350 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-SHAREHOLDER-HEALTH-W2` | 6360 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-SHAREHOLDER-DISTRIBUTION` | 3100 | debit | `owner_draw` | `none` | null | false | null | false |
| `CAT-SHAREHOLDER-CAPITAL` | 3010 | credit | `owner_contribution` | `none` | null | false | null | false |
| `CAT-VEHICLE-FUEL` | 6500 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-VEHICLE-REPAIR` | 6510 | debit | `deductible` | `none` | 7500 | false | 250000 | false |
| `CAT-VEHICLE-INSURANCE` | 6520 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-EQUIPMENT-REPAIR` | 6540 | debit | `deductible` | `none` | 7500 | false | 250000 | false |
| `CAT-BONDING` | 6600 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-COMPANY-LICENSE` | 6600 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-BUILDERS-RISK` | 6610 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-SAFETY-PPE` | 6620 | debit | `deductible` | `none` | 7500 | false | null | false |
| `CAT-SERVICE-VEHICLE-PURCHASE` | 1530 | debit | `capital` | `none` | 0 | false | 0 | false |
| `CAT-FIELD-EQUIPMENT-PURCHASE` | 1540 | debit | `capital` | `none` | 0 | false | 250000 | false |
| `CAT-SHOP-EQUIPMENT-PURCHASE` | 1550 | debit | `capital` | `none` | 0 | false | 250000 | false |
| `CAT-MEALS-CREW` | 6070 | debit | `meals_50` | `none` | 2500 | true | null | false |
| `CAT-LEGAL-FEES` | 6110 | debit | `deductible` | `attorney` | null | false | null | false |
| `CAT-SHOP-RENT` | 6130 | debit | `deductible` | `misc_rent` | null | false | null | false |
| `CAT-UNION-FRINGE` | 2350 | credit | `not_applicable` | `none` | null | false | null | false |

`CAT-JOB-SUBCONTRACTOR` and `CAT-JOB-PERMITS` carry `requires_receipt_over` of 0 because a subcontractor invoice and a permit document are both required for the job file and for the lien and 1099 trail regardless of amount. Subcontractor payments are `nec` class, and the corporation exclusion in the 1099 run does not save an unincorporated sub. Legal fees carry `attorney` because legal fees for services are generally reportable on Form 1099-NEC even where the firm is a corporation ([Anchin](https://www.anchin.com/articles/faqs-new-1099-nec-and-1099-misc-rules-beginning-in-2026/)).

---

## Part 5. `TPL-SERVICE-STUDIO`

Marisol Ceramics Studio. Ceramics studio and online retail, sole proprietor. The accounting problems are materials that are partly inventory and partly consumed immediately, kiln energy as a production cost, several small revenue channels with platform fees netted out of deposits, and constant mixing of business and personal money.

### 5.1 Accounts added to the shared core

| Account | Name | Type | Normal side | Scope key |
|---|---|---|---|---|
| 1200 | Inventory, finished ware | Asset | Debit | `inventory` |
| 1210 | Inventory, clay, glaze, and raw materials | Asset | Debit | `inventory` |
| 1230 | Inventory, resale goods from other makers | Asset | Debit | `inventory` |
| 1530 | Kilns and studio equipment | Asset | Debit | `fixed_assets` |
| 1540 | Wheels, tools, and small machinery | Asset | Debit | `fixed_assets` |
| 1630 | Accumulated depreciation, kilns and studio equipment | Contra asset | Credit | `fixed_assets` |
| 1640 | Accumulated depreciation, wheels, tools, and small machinery | Contra asset | Credit | `fixed_assets` |
| 2510 | Gift certificates outstanding | Liability | Credit | always |
| 2520 | Unearned class and workshop tuition | Liability | Credit | always |
| 3000 | Owner capital | Equity | Credit | always |
| 3100 | Owner contributions | Equity | Credit | always |
| 3200 | Owner draws | Equity, contra | Debit | always |
| 4000 | Retail sales, studio and markets | Revenue | Credit | always |
| 4010 | Retail sales, online marketplace | Revenue | Credit | always |
| 4020 | Retail sales, own website | Revenue | Credit | always |
| 4100 | Wholesale and consignment sales to galleries | Revenue | Credit | always |
| 4200 | Class and workshop tuition | Revenue | Credit | always |
| 4300 | Commission and custom work | Revenue | Credit | always |
| 4400 | Studio membership, shelf rental, and firing fees | Revenue | Credit | always |
| 4500 | Teaching, residency, and guest artist fees | Revenue | Credit | always |
| 5000 | Cost of goods sold, materials | Cost of goods sold | Debit | always |
| 5010 | Kiln firing energy and production utilities | Cost of goods sold | Debit | always |
| 5020 | Packaging and shipping materials | Cost of goods sold | Debit | always |
| 5030 | Production loss, breakage and seconds | Cost of goods sold | Debit | `inventory` |
| 5040 | Outbound shipping cost | Cost of goods sold | Debit | always |
| 6420 | Online platform and marketplace fees | Expense | Debit | always |
| 6430 | Product photography and listing services | Expense | Debit | always |
| 6440 | Shared studio and kiln access fees paid to others | Expense | Debit | always |
| 6450 | Market, fair, and booth fees | Expense | Debit | always |
| 6460 | Consignment and gallery commissions | Expense | Debit | always |

Design notes:

- **Kiln energy is a production cost, not a utility.** 5010 exists because a ceramics business that reports kiln power inside 6180 cannot price a firing. Where the studio has one meter, the split is a stated percentage in a recurring template, documented once, applied every month, and disclosed in the notes to the client rather than being reinvented monthly.
- **Materials.** Clay bought in pallet quantity is inventory in 1210 and relieved to 5000 as consumed. Small glaze and tool purchases below a stated policy amount go straight to 5000. The policy amount lives on the client record, not in a person's memory.
- **Platform settlements.** Marketplace deposits arrive net. The processor settlement level of the cascade splits gross to 4010, fee to 6420, and net to 1910, so revenue is gross and fees are visible. A net deposit coded straight to revenue understates both revenue and expense and destroys the platform fee percentage the owner needs.
- **Consignment.** A consignment sale is recognized when the gallery sells the piece, not when it ships to the gallery. Goods at a gallery stay in 1200 with a consignment location dimension until sold. The gallery commission is 6460 and the gross is 4100.
- **Owner draws.** Handled at 3200, never as an expense. See Part 8.

### 5.2 Categories

| Category | `account` | `normal_side` | `tax_treatment` | `1099_class` | `requires_receipt_over` | `requires_class` | `capitalize_over` | `restriction_relevant` |
|---|---|---|---|---|---|---|---|---|
| `CAT-REV-STUDIO-RETAIL` | 4000 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-MARKETPLACE` | 4010 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-WEBSITE` | 4020 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-WHOLESALE-GALLERY` | 4100 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-TUITION` | 4200 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-COMMISSION-WORK` | 4300 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-STUDIO-MEMBERSHIP` | 4400 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-FIRING-FEES` | 4400 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-TEACHING-OUTSIDE` | 4500 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REFUND-CUSTOMER` | 4910 | debit | `not_applicable` | `none` | null | false | null | false |
| `CAT-CLAY` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-GLAZE-CHEMICALS` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-KILN-FURNITURE-CONSUMABLE` | 5000 | debit | `deductible` | `none` | null | false | 250000 | false |
| `CAT-FREIGHT-IN` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-RESALE-GOODS` | 5000 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-KILN-ENERGY` | 5010 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-PACKAGING-SHIP-SUPPLIES` | 5020 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-BREAKAGE-SECONDS` | 5030 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-SHIPPING-OUT` | 5040 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-MATERIALS-INVENTORY-PURCHASE` | 1210 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-PLATFORM-FEES` | 6420 | debit | `deductible` | `none` | null | false | null | false |
| `CAT-PRODUCT-PHOTOGRAPHY` | 6430 | debit | `deductible` | `nec` | null | false | null | false |
| `CAT-STUDIO-ACCESS-PAID` | 6440 | debit | `deductible` | `misc_rent` | null | false | null | false |
| `CAT-MARKET-BOOTH-FEES` | 6450 | debit | `deductible` | `none` | 7500 | false | null | false |
| `CAT-GALLERY-COMMISSION` | 6460 | debit | `deductible` | `misc_other` | null | false | null | false |
| `CAT-STUDIO-RENT` | 6130 | debit | `deductible` | `misc_rent` | null | false | null | false |
| `CAT-KILN-PURCHASE` | 1530 | debit | `capital` | `none` | 0 | false | 250000 | false |
| `CAT-WHEEL-TOOL-PURCHASE` | 1540 | debit | `capital` | `none` | 0 | false | 250000 | false |
| `CAT-SMALL-TOOLS` | 6150 | debit | `deductible` | `none` | 7500 | false | 250000 | false |
| `CAT-MEALS-CLIENT` | 6070 | debit | `meals_50` | `none` | 2500 | false | null | false |
| `CAT-CONTRACT-ASSISTANT` | 6340 | debit | `deductible` | `nec` | 0 | false | null | false |
| `CAT-OWNER-DRAW` | 3200 | debit | `owner_draw` | `none` | null | false | null | false |
| `CAT-OWNER-CONTRIBUTION` | 3100 | credit | `owner_contribution` | `none` | null | false | null | false |
| `CAT-OWNER-HEALTH-INSURANCE` | 3200 | debit | `owner_draw` | `none` | null | false | null | false |
| `CAT-OWNER-RETIREMENT` | 3200 | debit | `owner_draw` | `none` | null | false | null | false |
| `CAT-OWNER-SE-TAX-PAYMENT` | 3200 | debit | `owner_draw` | `none` | null | false | null | false |
| `CAT-PERSONAL-EXPENSE` | 3200 | debit | `personal` | `none` | null | false | null | false |
| `CAT-INVENTORY-OWNER-USE` | 3200 | debit | `owner_draw` | `none` | null | false | null | false |
| `CAT-GIFT-CERT-SOLD` | 2510 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-TUITION-PREPAID` | 2520 | credit | `not_applicable` | `none` | null | false | null | false |

Four of those need justification:

- `CAT-OWNER-HEALTH-INSURANCE` and `CAT-OWNER-RETIREMENT` map to draws, not to 6320 employee benefits. A sole proprietor is not an employee of the business and cannot deduct a salary paid to self ([IRS Publication 334](https://www.irs.gov/publications/p334)). Self employed health insurance and self employed retirement contributions are deductions taken on the owner's Form 1040, not business expenses on Schedule C. Coding them to a business expense account overstates the Schedule C loss and creates a double deduction if the preparer also claims them at the 1040 level. The tax package carries them as memo detail off 9900 so the preparer sees the amounts.
- `CAT-OWNER-SE-TAX-PAYMENT` maps to draws. Self employment tax is the owner's personal liability, filed on Schedule SE, and estimated tax payments made from the business account are withdrawals ([IRS Publication 334](https://www.irs.gov/publications/p334)).
- `CAT-INVENTORY-OWNER-USE` exists because merchandise withdrawn for personal or family use has to come out of purchases and be charged to the drawing account ([IRS Publication 334](https://www.irs.gov/publications/p334)). The category makes that a one click answer instead of an omission.

---

## Part 6. `TPL-NONPROFIT`

Riverbend Youth Arts. Arts education nonprofit. The accounting problems are two net asset classes, restriction tracking that is a dimension rather than a set of accounts, contributions versus exchange transactions, conditional grants, and a functional expense presentation.

### 6.1 What the for profit templates get wrong for a nonprofit

Handing a nonprofit `TPL-SERVICE-STUDIO` produces books that are wrong in eight specific ways, not merely mislabeled.

1. **One accumulated equity account.** A for profit chart carries a single retained earnings line. FASB Accounting Standards Update 2016-14 replaced three net asset classes with two, net assets with donor restrictions and net assets without donor restrictions, presented on the face of the statement of financial position ([FASB ASU 2016-14](https://storage.fasb.org/Update-2016-14.pdf)). A single equity line cannot present that, so the statement is not GAAP.
2. **No restriction answer anywhere.** Nothing on a for profit category forces the question of whether a gift is restricted. The `restriction_relevant` attribute exists for exactly this, and `SUS-15` exists so an unanswered restriction blocks the close instead of being guessed.
3. **No releases from restriction.** Spending restricted money requires a reclassification between the two classes in the period the restriction is satisfied. A for profit chart has no mechanism, so restricted cash gets spent and the restricted balance never comes down, which is the most common nonprofit bookkeeping defect.
4. **Every inflow is treated as an exchange.** A for profit revenue block assumes a customer receiving commensurate value. A transaction is a contribution when commensurate value is not reciprocated and an exchange when it is, and the two follow different guidance, Subtopic 958-605 for contributions and ASC 606 for exchanges ([Crowe](https://www.crowe.com/insights/grants-and-contracts-implementing-asu-2018-08)). Tuition is an exchange, a gala ticket is both, and a foundation grant is usually a contribution. One revenue account cannot carry all three.
5. **Conditional grants get recognized too early.** A conditional contribution, one with a barrier and a right of return or release, is not revenue until the condition is met, and cash received in advance is a refundable advance liability ([Crowe](https://www.crowe.com/insights/grants-and-contracts-implementing-asu-2018-08)). A for profit chart books it as revenue or as generic deferred revenue and both misstate the statement of activities.
6. **No functional dimension.** ASU 2016-14 requires an analysis of expenses by both natural and functional classification plus disclosure of the allocation method ([FASB ASU 2016-14](https://storage.fasb.org/Update-2016-14.pdf)). A for profit chart can produce the natural view only. Form 990 Part IX asks for the same three column split of program service, management and general, and fundraising ([IRS Form 990 instructions](https://www.irs.gov/instructions/i990)).
7. **Owner equity and draws are meaningless and dangerous.** There is no owner, there are no distributions, and a chart offering a draw category invites a coding that would describe private benefit. Every owner category is absent from this template by construction.
8. **Departments substituted for functions.** Naming a class after a department does not satisfy the functional requirement. A single position can be part program and part management and general, so allocation is by a documented, consistently applied basis rather than by whose department the person sits in ([AICPA](https://www.aicpa-cima.com/resources/download/functional-expense-classification-nfp-overview)).

Gate G16 is the enforcement point. It asserts that net assets with donor restrictions reconciles and that the functional expense allocation is applied.

### 6.2 The net asset block, exactly two accounts

`TPL-NONPROFIT` does not use core account 3900. The 3000 block contains exactly two accounts and no more, which is also the `INTAKE-BUILD-CHART` test assertion.

| Account | Name | Type | Normal side |
|---|---|---|---|
| 3000 | Net assets without donor restrictions | Net assets | Credit |
| 3100 | Net assets with donor restrictions | Net assets | Credit |

Board designations, purpose restrictions, time restrictions, and perpetual endowment are **dimensions**, not accounts, exactly as Part 2 of the conventions requires. The dimension is `restriction`, with values `NONE`, `BOARD-DESIGNATED-RESERVE`, `BOARD-DESIGNATED-CAPITAL`, `PURPOSE`, `TIME`, and `PERPETUAL`. Board designated amounts are within net assets without donor restrictions, and the disaggregation is a note disclosure produced from the dimension, not from the chart. Adding board designated accounts would break the two account rule and would wrongly imply that a board designation is a donor restriction.

### 6.3 Accounts added to the shared core

| Account | Name | Type | Normal side | Scope key |
|---|---|---|---|---|
| 1040 | Cash, restricted for donor restricted purposes | Asset | Debit | always |
| 1050 | Cash, board designated reserve | Asset | Debit | always |
| 1110 | Pledges receivable | Asset | Debit | always |
| 1120 | Discount and allowance on pledges receivable | Contra asset | Credit | always |
| 1130 | Grants and contracts receivable | Asset | Debit | always |
| 1230 | Inventory, gift shop and program merchandise | Asset | Debit | `inventory` |
| 1530 | Studio, classroom, and program equipment | Asset | Debit | `fixed_assets` |
| 1540 | Instruments, kilns, and program technology | Asset | Debit | `fixed_assets` |
| 1630 | Accumulated depreciation, studio, classroom, and program equipment | Contra asset | Credit | `fixed_assets` |
| 1640 | Accumulated depreciation, instruments, kilns, and program technology | Contra asset | Credit | `fixed_assets` |
| 1820 | Investments, donor restricted endowment | Asset | Debit | always |
| 2340 | Accrued paid time off | Liability | Credit | `payroll` |
| 2530 | Refundable advances, conditional grants and contributions | Liability | Credit | always |
| 2540 | Deferred revenue, exchange transactions | Liability | Credit | always |
| 3000 | Net assets without donor restrictions | Net assets | Credit | always |
| 3100 | Net assets with donor restrictions | Net assets | Credit | always |
| 4000 | Contributions, individual | Revenue | Credit | always |
| 4010 | Contributions, corporate and business | Revenue | Credit | always |
| 4020 | Contributions in kind, goods | Revenue | Credit | always |
| 4030 | Contributions in kind, services and use of facilities | Revenue | Credit | always |
| 4100 | Foundation and private grants | Revenue | Credit | always |
| 4110 | Government grants and contracts | Revenue | Credit | always |
| 4200 | Program service revenue, tuition and class fees | Revenue | Credit | always |
| 4210 | Program service revenue, tickets and performances | Revenue | Credit | always |
| 4220 | Program service revenue, school and agency contracts | Revenue | Credit | always |
| 4300 | Special event revenue, contribution portion | Revenue | Credit | always |
| 4310 | Special event revenue, exchange portion | Revenue | Credit | always |
| 4320 | Direct benefit to donors | Contra revenue | Debit | always |
| 4400 | Membership dues | Revenue | Credit | always |
| 4500 | Gift shop and merchandise sales | Revenue | Credit | `inventory` |
| 4700 | Net assets released from restrictions, without donor restrictions | Revenue | Credit | always |
| 4710 | Net assets released from restrictions, with donor restrictions | Contra revenue | Debit | always |
| 7000 | Grants, scholarships, and awards to others | Expense | Debit | always |
| 7010 | Program supplies and materials | Expense | Debit | always |
| 7020 | Teaching artist and instructor fees | Expense | Debit | always |
| 7030 | Student transportation | Expense | Debit | always |
| 7040 | Venue, rehearsal, and exhibition space rental | Expense | Debit | always |
| 7050 | Special event production costs | Expense | Debit | always |
| 7060 | Donor and constituent management software | Expense | Debit | always |
| 7070 | Board and volunteer expense | Expense | Debit | always |
| 7080 | Audit and Form 990 preparation | Expense | Debit | always |
| 7090 | Insurance, directors and officers | Expense | Debit | always |
| 8010 | Realized and unrealized gain and loss on investments | Other income | Credit | always |
| 9200 | Unrelated business income tax expense | Tax expense | Debit | always |

Design notes:

- **Restriction is a dimension, revenue accounts are not split by class.** 4000 is one contributions account. Whether a given gift is restricted is answered by the `restriction` dimension on the line, and every contribution category carries `restriction_relevant = true` so the answer cannot be skipped. This is why the template has one contributions account per source rather than a restricted and an unrestricted copy of each, which would double the revenue block and still fail the moment a donor imposed a second condition.
- **4700 and 4710 are a matched pair.** Every release posts a credit to 4700 with restriction `NONE` and an equal debit to 4710 with the originating restriction value. A CI test and gate G16 both assert that 4700 plus 4710 equals zero for any period, because a release moves net assets between classes and never changes total net assets.
- **2530 versus 2540.** 2530 holds cash received on a conditional contribution where a barrier remains, a refundable advance ([Crowe](https://www.crowe.com/insights/grants-and-contracts-implementing-asu-2018-08)). 2540 holds unearned exchange revenue such as tuition for a class that has not run. Two different standards, two different accounts, and a client answer captured through `SUS-15` when the grant agreement is unclear.
- **4320 direct benefit to donors** is contra revenue so gala results can be presented net where appropriate, while the gross exchange and contribution portions of ticket price stay separately visible.
- **In kind services** are recognized only where the recognition criteria are met, which in practice means specialized skills that the organization would otherwise have purchased. 4030 exists so the client can be told what is recognizable and what is not, rather than the topic being avoided. Contributed volunteer hours that fail the criteria are tracked as a statistical memo, not as revenue.
- **7000 through 7090 are natural classifications.** None of them is a function. The functional split comes from the dimension in 6.4.

### 6.4 The functional dimension

Dimension name `functional`. Required on every expense line by `requires_class = true` on every expense category in this template.

| Value | Meaning |
|---|---|
| `FN-PROG-CLASSES` | Program, youth classes and workshops |
| `FN-PROG-PERFORMANCE` | Program, performances and exhibitions |
| `FN-PROG-OUTREACH` | Program, school and community residencies |
| `FN-MG` | Management and general |
| `FN-FUNDRAISING` | Fundraising and development |

Rules:

1. The three program values roll into one Program column for the statement of functional expenses and for Form 990 Part IX, while remaining separable for grant reporting.
2. Direct identification comes first. Only costs that genuinely serve more than one function are allocated.
3. Allocation bases are stated per cost pool on the client record, applied consistently, and disclosed. Common bases are payroll time records for personnel and square footage or headcount for occupancy ([AICPA](https://www.aicpa-cima.com/resources/download/functional-expense-classification-nfp-overview)).
4. Management and general is not a leftover bucket. Oversight, business management, recordkeeping, budgeting, and financing are management and general in their own right, and the cost of directly conducting or directly supervising program work is program even when performed by an executive ([FASB ASU 2016-14](https://storage.fasb.org/Update-2016-14.pdf)).
5. A period with any expense line missing a functional value fails gate G16.

### 6.5 Categories

| Category | `account` | `normal_side` | `tax_treatment` | `1099_class` | `requires_receipt_over` | `requires_class` | `capitalize_over` | `restriction_relevant` |
|---|---|---|---|---|---|---|---|---|
| `CAT-CONTRIB-INDIVIDUAL` | 4000 | credit | `not_applicable` | `none` | null | false | null | true |
| `CAT-CONTRIB-MAJOR-GIFT` | 4000 | credit | `not_applicable` | `none` | null | false | null | true |
| `CAT-CONTRIB-CORPORATE` | 4010 | credit | `not_applicable` | `none` | null | false | null | true |
| `CAT-CONTRIB-INKIND-GOODS` | 4020 | credit | `not_applicable` | `none` | 0 | false | null | true |
| `CAT-CONTRIB-INKIND-SERVICES` | 4030 | credit | `not_applicable` | `none` | 0 | false | null | true |
| `CAT-GRANT-FOUNDATION` | 4100 | credit | `not_applicable` | `none` | 0 | false | null | true |
| `CAT-GRANT-GOVERNMENT` | 4110 | credit | `not_applicable` | `none` | 0 | false | null | true |
| `CAT-REV-TUITION` | 4200 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-TICKETS` | 4210 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-REV-SCHOOL-CONTRACT` | 4220 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-EVENT-CONTRIBUTION` | 4300 | credit | `not_applicable` | `none` | null | false | null | true |
| `CAT-EVENT-EXCHANGE` | 4310 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-EVENT-DONOR-BENEFIT` | 4320 | debit | `not_applicable` | `none` | 7500 | true | null | false |
| `CAT-MEMBERSHIP-DUES` | 4400 | credit | `not_applicable` | `none` | null | false | null | true |
| `CAT-REV-GIFT-SHOP` | 4500 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-RELEASE-UNRESTRICTED-SIDE` | 4700 | credit | `not_applicable` | `none` | null | false | null | true |
| `CAT-RELEASE-RESTRICTED-SIDE` | 4710 | debit | `not_applicable` | `none` | null | false | null | true |
| `CAT-REFUNDABLE-ADVANCE` | 2530 | credit | `not_applicable` | `none` | 0 | false | null | true |
| `CAT-DEFERRED-EXCHANGE` | 2540 | credit | `not_applicable` | `none` | null | false | null | false |
| `CAT-PLEDGE-RECEIVABLE` | 1110 | debit | `not_applicable` | `none` | 0 | false | null | true |
| `CAT-GRANT-RECEIVABLE` | 1130 | debit | `not_applicable` | `none` | 0 | false | null | true |
| `CAT-SCHOLARSHIP-AWARDED` | 7000 | debit | `not_applicable` | `none` | 0 | true | null | false |
| `CAT-PROGRAM-SUPPLIES` | 7010 | debit | `not_applicable` | `none` | 7500 | true | 250000 | false |
| `CAT-TEACHING-ARTIST-FEES` | 7020 | debit | `not_applicable` | `nec` | 0 | true | null | false |
| `CAT-STUDENT-TRANSPORT` | 7030 | debit | `not_applicable` | `none` | 7500 | true | null | false |
| `CAT-VENUE-RENTAL` | 7040 | debit | `not_applicable` | `misc_rent` | null | true | null | false |
| `CAT-EVENT-PRODUCTION` | 7050 | debit | `not_applicable` | `none` | 7500 | true | null | false |
| `CAT-DONOR-SOFTWARE` | 7060 | debit | `not_applicable` | `none` | null | true | null | false |
| `CAT-BOARD-VOLUNTEER` | 7070 | debit | `not_applicable` | `none` | 7500 | true | null | false |
| `CAT-AUDIT-990` | 7080 | debit | `not_applicable` | `none` | null | true | null | false |
| `CAT-INSURANCE-DO` | 7090 | debit | `not_applicable` | `none` | null | true | null | false |
| `CAT-STAFF-WAGES` | 6300 | debit | `not_applicable` | `none` | null | true | null | false |
| `CAT-PAYROLL-TAX-EMPLOYER` | 6310 | debit | `not_applicable` | `none` | null | true | null | false |
| `CAT-EMPLOYEE-BENEFITS` | 6320 | debit | `not_applicable` | `none` | null | true | null | false |
| `CAT-OCCUPANCY-RENT` | 6130 | debit | `not_applicable` | `misc_rent` | null | true | null | false |
| `CAT-MEALS-STAFF-MEETING` | 6070 | debit | `not_applicable` | `none` | 2500 | true | null | false |
| `CAT-PROGRAM-EQUIPMENT-PURCHASE` | 1530 | debit | `capital` | `none` | 0 | true | 250000 | true |
| `CAT-INSTRUMENT-PURCHASE` | 1540 | debit | `capital` | `none` | 0 | true | 250000 | true |
| `CAT-ENDOWMENT-INVESTMENT` | 1820 | debit | `not_applicable` | `none` | 0 | false | null | true |
| `CAT-INVESTMENT-GAIN-LOSS` | 8010 | credit | `not_applicable` | `none` | null | false | null | true |
| `CAT-UBIT-EXPENSE` | 9200 | debit | `not_applicable` | `none` | null | true | null | false |
| `CAT-LEGAL-FEES` | 6110 | debit | `not_applicable` | `attorney` | null | true | null | false |

Notes on the attribute values:

- `tax_treatment` is `not_applicable` across the template because a tax exempt organization has no deduction to compute. The attribute still exists and still drives the tax package, which for this client produces Form 990 inputs rather than a deduction schedule. `capital` remains meaningful, because the capitalization decision is a book decision, not only a tax one.
- `1099_class` remains fully live. Exempt status does not exempt an organization from information reporting, so teaching artist fees are `nec` and venue rent is `misc_rent`. The 2,000 dollar threshold and the backup withholding trigger apply the same way ([Littler](https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds)).
- `restriction_relevant` is true on the two fixed asset purchase categories because equipment is frequently bought with restricted capital gifts, and the release entry has to accompany the purchase.
- `requires_class` is true on every expense category, without exception, which is what makes the functional statement possible.

---

## Part 7. No uncategorized by construction

Level 9 of the cascade guarantees that nothing is blank, because anything unresolved lands in 1990 with a reason code. That is a guarantee about visibility, not about coverage. Coverage is a separate promise, and it is kept by making sure a correct category exists for every plausible transaction so that suspense is a genuine exception and not a daily dumping ground.

Two design rules make coverage real:

1. **No catch all expense account.** There is no miscellaneous expense account and no "ask my accountant" account on any template. A transaction with no home goes to suspense where somebody owns it, with an escalation age, rather than into a profit and loss line nobody reads.
2. **The universal spine ships on every template.** These categories cover the non revenue, non expense money movement that makes up most of a bank feed and most of the coding errors in small business books.

### 7.1 Universal spine, every template

| Category | `account` | `normal_side` | `tax_treatment` | Covers |
|---|---|---|---|---|
| `CAT-TRANSFER` | 1920 | debit | `transfer` | Both sides of an internal transfer, level 3 of the cascade |
| `CAT-CC-PAYMENT` | 2100 | debit | `transfer` | Card payment from the bank, which is not an expense |
| `CAT-LOC-DRAW` | 2110 | credit | `not_applicable` | Line of credit advance |
| `CAT-LOC-REPAYMENT` | 2110 | debit | `not_applicable` | Line of credit repayment |
| `CAT-LOAN-PROCEEDS` | 2700 | credit | `not_applicable` | New borrowing |
| `CAT-LOAN-PRINCIPAL` | 2600 | debit | `not_applicable` | Principal portion of a debt payment |
| `CAT-LOAN-INTEREST` | 8100 | debit | `deductible` | Interest portion of a debt payment |
| `CAT-PROCESSOR-GROSS` | 1910 | debit | `not_applicable` | Gross settlement, level 4 |
| `CAT-PROCESSOR-FEE` | 6020 | debit | `deductible` | Processor fee split out of a net deposit |
| `CAT-PROCESSOR-NET-DEPOSIT` | 1910 | credit | `not_applicable` | Net cash landing in the bank |
| `CAT-UNDEPOSITED` | 1900 | debit | `not_applicable` | Cash and checks in hand, supported by the deposits in transit list under gate G08 |
| `CAT-PAYROLL-NET-PAY` | 1930 | debit | `not_applicable` | Net pay debit, level of the payroll clearing |
| `CAT-PAYROLL-TAX-REMIT` | 2310 | debit | `not_applicable` | Tax deposit clearing the payroll liability |
| `CAT-SALES-TAX-REMIT` | 2400 | debit | `not_applicable` | Sales tax remittance, never an expense |
| `CAT-AR-COLLECTION` | 1100 | credit | `not_applicable` | Customer payment against an invoice |
| `CAT-AP-PAYMENT` | 2000 | debit | `not_applicable` | Vendor payment against a bill |
| `CAT-CUSTOMER-DEPOSIT` | 2500 | credit | `not_applicable` | Money received before delivery |
| `CAT-BANK-FEE` | 6010 | debit | `deductible` | Bank charges and returned item fees |
| `CAT-INTEREST-INCOME` | 8000 | credit | `not_applicable` | Interest earned |
| `CAT-CHARGEBACK` | 1910 | debit | `not_applicable` | Reversal pending research, paired with `SUS-13` |
| `CAT-REFUND-FROM-VENDOR` | mirrors the original expense category | credit | mirrors the original | Vendor credit, coded against the original category, never to income |
| `CAT-PENALTY-FINE` | 7900 | debit | `nondeductible` | Late filing and other penalties |
| `CAT-FIXED-ASSET-ADDITION` | template asset account | debit | `capital` | Anything over the capitalization threshold, paired with `SUS-09` |
| `CAT-ASSET-DISPOSAL` | 8200 | credit | `not_applicable` | Proceeds and the gain or loss on retirement |
| `CAT-DUE-TO-RELATED` | 2900 | credit | `not_applicable` | Intercompany, paired with `SUS-16` and gate G14 |
| `CAT-STATE-TAX-PAYMENT` | 9000 | debit | `nondeductible` | Entity level state income and franchise tax |

### 7.2 `TPL-RETAIL-WHOLESALE`, closing the remaining gaps

| Gap | Category |
|---|---|
| Product bought for resale | `CAT-COFFEE-GREEN`, `CAT-COFFEE-DECAF`, `CAT-COFFEE-SPOT`, `CAT-COGS-MERCH` |
| Cost of getting product in | `CAT-FREIGHT-IN` |
| Cost of getting product out | `CAT-SHIPPING-OUT` against `CAT-REV-SHIPPING-BILLED` |
| Packaging in two directions | `CAT-PACKAGING` and `CAT-LABELS` for product, `CAT-TRADE-SHOW` for giveaway |
| Channel revenue, all four channels | `CAT-REV-WHOLESALE-COFFEE`, `CAT-REV-WHOLESALE-PRIVATE-LABEL`, `CAT-REV-RETAIL-CAFE`, `CAT-REV-RETAIL-ONLINE`, `CAT-REV-SUBSCRIPTION`, `CAT-REV-MERCH` |
| Money received now for coffee later | `CAT-GIFT-CARD-SOLD`, `CAT-WHOLESALE-DEPOSIT` |
| Inventory that walked away | `CAT-INVENTORY-SHRINK` |
| Owner money in and out | `CAT-MEMBER-CONTRIBUTION`, `CAT-MEMBER-DRAW` |
| Marketplace fee withheld from a deposit | `CAT-PLATFORM-FEES` |
| Vehicle running costs | `CAT-VEHICLE-FUEL`, `CAT-VEHICLE-REPAIR`, `CAT-VEHICLE-INSURANCE` |

### 7.3 `TPL-CONTRACTOR`, closing the remaining gaps

| Gap | Category |
|---|---|
| Every kind of direct job cost | `CAT-JOB-LABOR`, `CAT-JOB-LABOR-BURDEN`, `CAT-JOB-MATERIALS`, `CAT-JOB-SUBCONTRACTOR`, `CAT-JOB-PERMITS`, `CAT-JOB-EQUIPMENT-RENTAL`, `CAT-JOB-FREIGHT`, `CAT-JOB-TRAVEL`, `CAT-JOB-PERDIEM`, `CAT-JOB-WARRANTY`, `CAT-JOB-SMALL-TOOLS`, and `CAT-JOB-OTHER-DIRECT` as the named residual that still requires a job |
| Revenue that is not yet billed or is billed ahead | `CAT-WIP-REVENUE-ADJ` |
| Money held back by the customer | `CAT-RETAINAGE-BILLED` |
| Money held back from a sub | `CAT-RETAINAGE-SUB-WITHHELD` |
| Material on site but not installed | `CAT-UNINSTALLED-MATERIALS` |
| Shareholder pay versus shareholder distribution | `CAT-OFFICER-COMP`, `CAT-SHAREHOLDER-HEALTH-W2`, `CAT-SHAREHOLDER-DISTRIBUTION`, `CAT-SHAREHOLDER-CAPITAL` |
| Company level compliance cost distinct from job permits | `CAT-BONDING`, `CAT-COMPANY-LICENSE` |
| Fleet | `CAT-VEHICLE-FUEL`, `CAT-VEHICLE-REPAIR`, `CAT-VEHICLE-INSURANCE`, `CAT-EQUIPMENT-REPAIR` |
| Union and prevailing wage obligations | `CAT-UNION-FRINGE` |

`CAT-JOB-OTHER-DIRECT` is the only residual on any template, and it is not a catch all. It maps to a real account, it requires a job, and it carries a receipt threshold. Its balance is reviewed monthly, and a recurring vendor inside it is a signal that a category is missing, which is a chart defect rather than a coding defect.

### 7.4 `TPL-SERVICE-STUDIO`, closing the remaining gaps

| Gap | Category |
|---|---|
| Materials in every form | `CAT-CLAY`, `CAT-GLAZE-CHEMICALS`, `CAT-KILN-FURNITURE-CONSUMABLE`, `CAT-MATERIALS-INVENTORY-PURCHASE` |
| Firing cost | `CAT-KILN-ENERGY` |
| Five revenue channels | `CAT-REV-STUDIO-RETAIL`, `CAT-REV-MARKETPLACE`, `CAT-REV-WEBSITE`, `CAT-REV-WHOLESALE-GALLERY`, `CAT-REV-COMMISSION-WORK` |
| Teaching and studio access, both directions | `CAT-REV-TUITION`, `CAT-REV-STUDIO-MEMBERSHIP`, `CAT-REV-FIRING-FEES`, `CAT-REV-TEACHING-OUTSIDE`, `CAT-STUDIO-ACCESS-PAID` |
| Fees taken out of a net deposit | `CAT-PLATFORM-FEES`, `CAT-GALLERY-COMMISSION` |
| Money received before delivery | `CAT-GIFT-CERT-SOLD`, `CAT-TUITION-PREPAID` |
| Owner money out, in all five shapes it actually takes | `CAT-OWNER-DRAW`, `CAT-OWNER-HEALTH-INSURANCE`, `CAT-OWNER-RETIREMENT`, `CAT-OWNER-SE-TAX-PAYMENT`, `CAT-INVENTORY-OWNER-USE` |
| Personal spending on the business card | `CAT-PERSONAL-EXPENSE`, with `SUS-07` for a mixed charge |
| Breakage | `CAT-BREAKAGE-SECONDS` |

The five owner categories exist because a sole proprietor bank account is the hardest coverage problem on the platform. Every one of them lands in equity, none of them touches an expense account, and each of them answers a question a preparer would otherwise ask in March.

### 7.5 `TPL-NONPROFIT`, closing the remaining gaps

| Gap | Category |
|---|---|
| Every inflow shape a nonprofit sees | `CAT-CONTRIB-INDIVIDUAL`, `CAT-CONTRIB-MAJOR-GIFT`, `CAT-CONTRIB-CORPORATE`, `CAT-GRANT-FOUNDATION`, `CAT-GRANT-GOVERNMENT`, `CAT-REV-TUITION`, `CAT-REV-TICKETS`, `CAT-REV-SCHOOL-CONTRACT`, `CAT-MEMBERSHIP-DUES`, `CAT-REV-GIFT-SHOP` |
| Gala, split correctly | `CAT-EVENT-CONTRIBUTION`, `CAT-EVENT-EXCHANGE`, `CAT-EVENT-DONOR-BENEFIT`, `CAT-EVENT-PRODUCTION` |
| Non cash gifts | `CAT-CONTRIB-INKIND-GOODS`, `CAT-CONTRIB-INKIND-SERVICES` |
| Grant money received before the condition is met | `CAT-REFUNDABLE-ADVANCE` |
| Exchange money received before delivery | `CAT-DEFERRED-EXCHANGE` |
| Promises to give | `CAT-PLEDGE-RECEIVABLE`, `CAT-GRANT-RECEIVABLE` |
| Spending restricted money | `CAT-RELEASE-UNRESTRICTED-SIDE` and `CAT-RELEASE-RESTRICTED-SIDE`, always as a pair |
| Program delivery cost | `CAT-TEACHING-ARTIST-FEES`, `CAT-PROGRAM-SUPPLIES`, `CAT-STUDENT-TRANSPORT`, `CAT-VENUE-RENTAL`, `CAT-SCHOLARSHIP-AWARDED` |
| Governance and compliance cost | `CAT-AUDIT-990`, `CAT-BOARD-VOLUNTEER`, `CAT-INSURANCE-DO` |
| Endowment | `CAT-ENDOWMENT-INVESTMENT`, `CAT-INVESTMENT-GAIN-LOSS` |
| Taxable side business | `CAT-UBIT-EXPENSE` |

No owner category exists on this template, and none can be created on it, because the template forbids `tax_treatment` values `owner_draw`, `owner_contribution`, and `personal`. An owner style withdrawal from a nonprofit has no correct coding, so the platform refuses to offer one and routes the transaction to `SUS-03` for a written explanation.

---

## Part 8. Equity and owner activity by entity type

The equity section is the one place where entity type genuinely changes the accounting rather than the labels. This part states what differs and what the software does about it.

### 8.1 The comparison

| Topic | Sole proprietor, `TPL-SERVICE-STUDIO` | Single member LLC, `TPL-RETAIL-WHOLESALE` | S Corp, `TPL-CONTRACTOR` | Nonprofit, `TPL-NONPROFIT` |
|---|---|---|---|---|
| Equity accounts | 3000 Owner capital, 3100 Owner contributions, 3200 Owner draws, 3900 Accumulated earnings | 3000 Member contributions, 3100 Member distributions and draws, 3900 Accumulated earnings | 3000 Common stock, 3010 Additional paid in capital, 3100 Shareholder distributions, 3900 Accumulated earnings | 3000 and 3100 only, the two net asset classes |
| Owner pay mechanism | Draw only. No payroll for the owner | Draw only where the LLC is a disregarded entity. Guaranteed payments where it is a multi member partnership | W-2 wages first, then distributions | Not applicable. Staff are employees, including the executive director |
| Payroll for the owner | Never | Never while disregarded | Required where the officer performs more than minor services | Standard employment |
| Federal filing | Schedule C with Form 1040, Schedule SE for self employment tax | Disregarded, reported on the owner's return, so it looks like Schedule C | Form 1120-S with Schedule K-1 | Form 990 |
| Self employment tax | On net earnings from self employment | Same as a sole proprietorship for a single individual owner | Not on the distribution portion. FICA on wages | Not applicable |
| What a draw is | Not an expense, not deductible, reduces capital | Same | A distribution, not deductible, reduces equity, and limited by basis | No equivalent exists |
| Basis tracking | Capital account | Capital account | Stock and debt basis, tracked in memo 9910 | Not applicable |
| Restriction tracking | None | None | None | Required, dimension driven |
| Closing entry | Net income closes to 3900 then rolls into 3000 annually | Net income closes to 3900 | Net income closes to 3900, distributions stay visible in 3100 for the year | Change in net assets closes to 3000 and 3100 by class |

### 8.2 Sole proprietor

The business and the owner are the same taxpayer. The owner is not an employee of the business, cannot deduct a salary paid to self, and cannot deduct personal withdrawals ([IRS Publication 334](https://www.irs.gov/publications/p334)). Every withdrawal is equity activity.

What the software does:

- All five owner outflow categories map to 3200 and carry `tax_treatment` of `owner_draw` or `personal`, so none of them can reach an expense account.
- A drawing account is the correct home for withdrawals of merchandise for personal use as well as cash, with the cost removed from purchases ([IRS Publication 334](https://www.irs.gov/publications/p334)). That is `CAT-INVENTORY-OWNER-USE`.
- Estimated tax payments made from the business account are draws, not tax expense. Account 9000 is for entity level state tax, not for the owner's personal liability.
- An ambiguous owner transaction is `SUS-08`, owned by the client with a seven day escalation, because only the owner knows whether a transfer was a draw, a reimbursement, or a loan.
- At year end, 3900 and 3200 are closed into 3000 so the capital account carries forward as a single figure and the following year's draws start clean.

### 8.3 Single member LLC

Legally distinct, and for income tax purposes an LLC with one member is treated as an entity disregarded as separate from its owner unless it files Form 8832 to elect corporate treatment ([IRS single member LLC guidance](https://www.irs.gov/businesses/small-businesses-self-employed/single-member-limited-liability-companies)). An individual owner of a single member LLC operating a trade or business is subject to self employment tax in the same manner as a sole proprietorship ([IRS single member LLC guidance](https://www.irs.gov/businesses/small-businesses-self-employed/single-member-limited-liability-companies)).

So the tax picture matches a sole proprietorship while the books should not. What the software does:

- The chart keeps member contributions and member distributions separate from accumulated earnings, and the bookkeeping never commingles owner and entity money, because the legal separation is the whole reason the entity exists and a lender or a plaintiff will read the books.
- The LLC is still a separate entity for employment tax and certain excise taxes, and must use its own name and employer identification number for reporting and paying employment taxes ([IRS single member LLC guidance](https://www.irs.gov/businesses/small-businesses-self-employed/single-member-limited-liability-companies)). So payroll accounts 2300 through 2320 and the payroll clearing account 1930 belong to the LLC even though income tax flows to the owner.
- If the LLC has more than one member, it is a partnership by default and the template changes in two ways. Member draws split into distributions and guaranteed payments, and the equity block splits by member. That is an open item, see Part 9.
- If the LLC elects S Corp treatment, the client moves to the S Corp equity treatment in 8.4, including reasonable compensation. The template is a starting chart, not a permanent classification.

### 8.4 S Corp, and reasonable compensation

This is the section that causes the most damage when it is done casually.

The definition of an employee for FICA, FUTA, and federal income tax withholding includes corporate officers, and when corporate officers perform a service for the corporation and receive or are entitled to payments, those payments are wages. The fact that an officer is also a shareholder does not change this ([IRS S corporation employees, shareholders and corporate officers](https://www.irs.gov/businesses/small-businesses-self-employed/s-corporation-employees-shareholders-and-corporate-officers)). Courts have consistently held that officers and shareholders who provide more than minor services and receive or are entitled to receive compensation are subject to federal employment taxes ([IRS S corporation employees, shareholders and corporate officers](https://www.irs.gov/businesses/small-businesses-self-employed/s-corporation-employees-shareholders-and-corporate-officers)).

S corporations must pay reasonable compensation to a shareholder employee for services provided before non wage distributions may be made to that shareholder employee, and the IRS has the authority to reclassify non wage distributions as wages ([IRS S corporation compensation and medical insurance issues](https://www.irs.gov/businesses/small-businesses-self-employed/s-corporation-compensation-and-medical-insurance-issues)). The analysis looks to the source of the corporation's gross receipts. To the extent receipts are generated by the shareholder's personal services, payments to the shareholder should be wages. To the extent they are generated by non shareholder employees or by capital and equipment, payments can properly be non wage distributions ([IRS S corporation compensation and medical insurance issues](https://www.irs.gov/businesses/small-businesses-self-employed/s-corporation-compensation-and-medical-insurance-issues)).

What the software does:

- Officer compensation has its own account, 6350, separate from 6300, so the wage figure is readable without a payroll report and matches the officer compensation line on the return.
- Shareholder distributions sit in 3100 with `tax_treatment` of `owner_draw`. A distribution never reaches an expense account, and 3100 is never netted into 3900 during the year, so the annual distribution total is visible on the face of the equity section.
- The platform reports the ratio of distributions in 3100 to officer compensation in 6350 on the client dashboard, as a fact rather than as advice. A year with distributions and zero officer compensation is surfaced as an exception for the firm to discuss, because that is the exact pattern the cited cases address.
- Shareholder health insurance is 6360 and is included in W-2 wages rather than being treated as a fringe benefit outside payroll, which keeps the payroll provider report and the general ledger reconcilable under gate G11.
- Stock and debt basis are tracked in memo account 9910, because distributions in excess of basis change the shareholder's personal return and nobody notices until it is too late if basis lives only in a spreadsheet.
- Loans between the shareholder and the corporation go to 2900 or a matching asset, never to 3100, and an unclear owner transfer is `SUS-08` or `SUS-14`, not a guess.

### 8.5 Nonprofit

There is no owner, no equity in the ownership sense, and no distribution. Net assets replace equity, and the two classes are net assets with donor restrictions and net assets without donor restrictions, presented on the face of the statement of financial position ([FASB ASU 2016-14](https://storage.fasb.org/Update-2016-14.pdf)).

What the software does:

- The 3000 block holds exactly two accounts. Board designations and restriction types are dimensions.
- The change in net assets closes by class, not into a single retained earnings line, and gate G16 asserts the restricted class reconciles to the restriction schedule.
- Compensation of the executive director is ordinary payroll subject to the functional dimension, split between program and management and general on a documented basis, not booked wholly to management and general by default.
- The template refuses the owner `tax_treatment` values entirely, as stated in 7.5.

---

## Part 9. Open items

1. **Multi member LLC and partnership equity.** Guaranteed payments, per member capital accounts, and section 704(b) allocations are not modeled. The current LLC template assumes one member or a partnership where the equity split is handled outside the platform.
2. **Percentage of completion inputs.** The contractor template provides the accounts and the 4990 mechanism, but the estimate at completion, cost to complete, and the resulting revenue computation are a run specification, not a chart concern, and the WIP run belongs in `docs/02-run-specifications.md`.
3. **Inventory costing method.** The retail and studio templates carry inventory accounts but no stated costing method. First in first out, weighted average, and specific identification each change the subledger to control reconciliation under gate G09. A per client setting is needed.
4. **Endowment spending policy.** 1820 and the perpetual restriction value exist, but underwater endowment disclosure and the appropriation of endowment return for spending are not specified.
5. **Sales tax on shipping.** Account 4300 and the 2400 liability exist, but taxability of shipping and handling varies by state and the template takes no position. `SUS-10` carries these until a jurisdiction matrix exists.
6. **In kind measurement.** 4020 and 4030 exist and the recognition test is described in prose, but no measurement guidance or disclosure template is specified.
7. **Functional allocation bases.** The dimension and the requirement are specified. The stored allocation basis records, the period allocation entry, and the disclosure text generator are not.
8. **Cost of goods sold labor for the studio.** The ceramics template expenses owner labor at zero, which is correct for a sole proprietor, but it means gross margin on a handmade piece excludes the maker's time. A statistical time dimension would make unit economics honest without touching the ledger. Not modeled.
