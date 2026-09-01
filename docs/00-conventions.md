# Ledger Legends: conventions, coding cascade, and close gates

Status: foundation document. Every other spec in `docs/` keys off this file. Change this file first, then the others.

---

## Part 1. Naming and numbering conventions

### Money

Integer cents everywhere, in the database, in the API, and in application state. Format only at the render boundary. No float parsing anywhere in the codebase, enforced by CI.

Signed convention: a debit is positive, a credit is negative, on every journal line. A journal entry is balanced when its lines sum to exactly zero. There is no separate debit column and credit column in storage. Presentation splits the sign into two columns.

Foreign currency is out of scope for now. Any transaction in a currency other than the client's functional currency goes to suspense with reason `SUS-11`.

### Account numbering

Four digit blocks, with room left inside each block. A client's chart may use a subset, never a different scheme.

| Range | Contents |
|---|---|
| 1000 to 1099 | Cash and cash equivalents |
| 1100 to 1199 | Accounts receivable and allowance for doubtful accounts |
| 1200 to 1299 | Inventory |
| 1300 to 1399 | Prepaid expenses and other current assets |
| 1400 to 1499 | Employee advances, due from related parties, other receivables |
| 1500 to 1599 | Fixed assets at cost |
| 1600 to 1699 | Accumulated depreciation, always contra to the matching 15xx account |
| 1700 to 1799 | Intangibles and accumulated amortization |
| 1800 to 1899 | Deposits and other long term assets |
| 1900 to 1999 | Clearing and suspense. See below. |
| 2000 to 2099 | Accounts payable |
| 2100 to 2199 | Credit cards and lines of credit |
| 2200 to 2299 | Accrued liabilities |
| 2300 to 2399 | Payroll liabilities |
| 2400 to 2499 | Sales, use, and excise tax payable |
| 2500 to 2599 | Deferred and unearned revenue, customer deposits |
| 2600 to 2699 | Current portion of long term debt |
| 2700 to 2899 | Long term debt |
| 2900 to 2999 | Due to related parties and other long term liabilities |
| 3000 to 3999 | Equity, or net assets for a nonprofit |
| 4000 to 4999 | Revenue |
| 5000 to 5999 | Cost of goods sold and direct job costs |
| 6000 to 7999 | Operating expenses |
| 8000 to 8999 | Other income and other expense, including interest and gain or loss on disposal |
| 9000 to 9999 | Income tax expense, and memo accounts that never appear on a published statement |

Accumulated depreciation pairs with its cost account by offset of 100. Asset at 1520 depreciates into 1620. This is a hard convention because the depreciation run relies on it.

### The clearing and suspense block

These five accounts exist on every chart regardless of template.

| Account | Name | Must be zero at close |
|---|---|---|
| 1900 | Undeposited funds | No. Must be supported by a deposits in transit list. |
| 1910 | Payment processor clearing | Yes |
| 1920 | Transfer clearing | Yes |
| 1930 | Payroll clearing | Yes |
| 1990 | Suspense | Yes |

Suspense is a real account with a real balance, not a UI state. That is the whole point. An uncoded transaction is not invisible, it is sitting in 1990 with a reason code, and it stops the close.

### Identifier conventions

| Thing | Format | Example |
|---|---|---|
| Account | four digit string | `6420` |
| Category | `CAT-` plus slug | `CAT-MEALS-CLIENT` |
| Chart template | `TPL-` plus slug | `TPL-NONPROFIT` |
| Rule | `RULE-` plus ULID | |
| Run type | `<MODULE>-<VERB>-<OBJECT>` | `TXN-PAIR-TRANSFERS` |
| Run execution | `RUNX-` plus ULID | |
| Suspense reason | `SUS-nn` | `SUS-04` |
| Close gate | `Gnn` | `G03` |

ULIDs rather than UUIDs for anything sorted by creation, because run logs and audit trails are read in time order constantly.

### Versioning

Rules, categories, chart templates, and run specifications are all versioned. An applied change records the version it was applied under and never rewrites history. If rule 7 is edited, transactions coded under version 2 keep saying version 2. This is what makes a run log defensible six months later.

---

## Part 2. Category layer versus chart of accounts

Two separate tables. This is the single most important structural decision in this document.

**Account** drives the financial statements. Few of them. Changing one changes what a lender sees.

**Category** is the coding target a human or a run picks. Many of them. Each category maps to exactly one account. Many categories map to the same account.

A coffee roaster can have `CAT-COFFEE-GREEN`, `CAT-PACKAGING`, `CAT-ROASTING-FUEL`, and `CAT-FREIGHT-IN` all rolling into account 5000 Cost of goods sold. The statement stays four lines. The coding stays specific. Management reporting can group by category without a chart change.

### Category attributes

Every category carries these, so the question gets answered once instead of on every transaction.

| Attribute | Values | Why |
|---|---|---|
| `account` | one account number | The GL destination |
| `normal_side` | debit or credit | Sanity check against the transaction sign |
| `tax_treatment` | `deductible`, `meals_50`, `nondeductible`, `owner_draw`, `owner_contribution`, `personal`, `capital`, `transfer`, `not_applicable` | Drives the tax package and stops the meals question recurring |
| `1099_class` | `none`, `nec`, `misc_rent`, `misc_other`, `attorney` | Drives the 1099 run |
| `requires_receipt_over` | integer cents, nullable | Substantiation threshold |
| `requires_class` | boolean | Forces a job, program, or department |
| `capitalize_over` | integer cents, nullable | Routes to the fixed asset register instead of expense |
| `is_active` | boolean | Retire, never delete |
| `restriction_relevant` | boolean | Nonprofit only. Forces a donor restriction answer. |

`tax_treatment` of `capital` combined with `capitalize_over` is how the capital versus expense decision becomes deterministic. The de minimis safe harbor under Treasury Regulation section 1.263(a) to 1(f) is 2,500 dollars per invoice or item for a taxpayer without applicable financial statements, and 5,000 dollars with them ([IRS tangible property final regulations](https://www.irs.gov/businesses/small-businesses-self-employed/tangible-property-final-regulations)). Default `capitalize_over` to 250000 cents and make it a per client setting, since the election is annual and the client's own policy governs.

### Dimensions, not accounts

Class or job, location, and program are dimensions on the transaction line, never new accounts. A contractor with forty jobs does not get forty revenue accounts.

---

## Part 3. The coding cascade

Evaluated in order. First level that resolves wins and evaluation stops. Every level records which level produced the answer, so the transaction row can show provenance.

| Level | Test | Outcome if it hits |
|---|---|---|
| 0 | Manual override flag is set | Keep as is. No run may modify it. Stop. |
| 1 | Transaction date falls in a locked period | Skip entirely. Report as skipped with reason `locked_period`. |
| 2 | Duplicate test passes | Do not code. Flag and route to suspense with `SUS-05`. |
| 3 | Transfer pairing test passes | Book both sides through 1920 transfer clearing, then clear. Category `CAT-TRANSFER`. |
| 4 | Processor settlement match | Split gross, fee, and net through 1910. |
| 5 | Recurring template match | Apply the template, including any fixed split. |
| 6 | Rule match | Apply the winning rule's category. |
| 7 | Vendor default exists for the resolved vendor | Apply the vendor default category. |
| 8 | Bank or card code mapping exists | Apply the mapped category. |
| 9 | Nothing resolved | Post to 1990 suspense with a reason code. Never leave blank. |

There is no level that guesses. Level 9 always terminates the cascade, which is what makes "nothing uncategorized" true by construction rather than by diligence.

### Deterministic tie breaking

**Rule conflict.** Rules are selected by explicit integer priority descending, then by condition count descending as a specificity proxy, then by rule id ascending. If two rules survive all three tests and target different categories, that is a genuine conflict: do not pick one. Route to suspense with `SUS-19` and surface both rule ids so a human fixes the rule set rather than the transaction.

**Duplicate test.** Same client, same account, same absolute amount, same normalized vendor string, and dates within 3 calendar days, where the other transaction is not already linked as a legitimate repeat. Flag only. Never delete, never merge.

**Transfer pairing test.** Same client, two different accounts both belonging to that client, equal absolute amounts, opposite signs, dates within 3 calendar days, and neither side already paired. If more than one candidate pair exists for a given transaction, pair none of them and route to suspense with `SUS-04`. Ambiguity is a human decision.

Transfer pairing runs before rules deliberately. An unpaired internal transfer that gets coded by a rule inflates both revenue and expense, and it is the most common defect in small business books.

### Normalized vendor string

Uppercase, strip punctuation, collapse whitespace, strip a trailing store or terminal number, strip common processor prefixes. The normalization function is versioned like everything else, because changing it changes which rules match.

---

## Part 4. Suspense reason codes

Every code carries an owner, a resolution path, and an escalation age. All of them block the close, because gate G01 requires suspense at zero. The owner determines who gets the work.

| Code | Meaning | Owner | Resolution path | Escalate after |
|---|---|---|---|---|
| SUS-01 | Unknown vendor, money out | Firm | Create rule or vendor default | 5 days |
| SUS-02 | Unknown source, money in | Firm | Identify deposit, create rule | 5 days |
| SUS-03 | Business purpose not determinable | Client | Portal request with the transaction attached | 7 days |
| SUS-04 | Possible transfer, no single pair | Firm | Confirm or reject the pairing | 3 days |
| SUS-05 | Possible duplicate | Firm | Confirm duplicate and void, or mark legitimate repeat | 3 days |
| SUS-06 | Coding known, receipt missing over threshold | Client | Portal request for the document | 10 days |
| SUS-07 | Mixed business and personal | Client | Confirm the split percentage | 7 days |
| SUS-08 | Owner activity unclear, draw or reimbursement or loan | Client | Confirm treatment | 7 days |
| SUS-09 | Over the capitalization threshold | Firm | Route to fixed asset register or expense with reason | 5 days |
| SUS-10 | Sales tax treatment unclear | Firm | Confirm taxability | 5 days |
| SUS-11 | Foreign currency, out of scope | Firm | Manual entry with a stated rate | 5 days |
| SUS-12 | Processor gross and fee not yet settled | System | Clears automatically when the settlement report arrives | 10 days |
| SUS-13 | Chargeback or reversal pending | Firm | Link to the original transaction | 10 days |
| SUS-14 | Loan proceeds or repayment unclear | Client | Confirm the instrument and provide the schedule | 7 days |
| SUS-15 | Grant or contribution restriction unknown | Client | Confirm donor restriction | 7 days |
| SUS-16 | Intercompany, other side unconfirmed | Firm | Confirm against the related entity's books | 7 days |
| SUS-17 | Amount does not agree to the supporting document | Firm | Investigate the variance | 5 days |
| SUS-18 | Stale uncleared item | Firm | Void, write off, or confirm still outstanding | 30 days |
| SUS-19 | Rule conflict | Firm | Fix rule priority, then rerun | 2 days |
| SUS-20 | Dated in a locked period | Firm | Post a correcting entry in an open period | 5 days |

Client owned codes generate portal requests. That is the bridge between the accounting engine and the portal, and it means suspense volume drives client communication automatically instead of by memory.

`SUS-12` is the only code with a system owner, meaning it is expected to resolve without a human when the next settlement file lands.

---

## Part 5. Close gates

The current build has six gates. This is the full set. Gates marked conditional only apply when the named item is in the client's engagement scope, which the intake wizard already captures.

| Gate | Assertion | Conditional on |
|---|---|---|
| G01 | Accounts 1910, 1920, 1930, and 1990 all have a zero balance | Always |
| G02 | No unposted or draft journal entries dated in the period | Always |
| G03 | Every bank and card account is reconciled through period end with a zero difference | Always |
| G04 | AR subledger total equals the AR control account, and AP subledger total equals the AP control account | Always |
| G05 | Trial balance nets to zero | Always |
| G06 | Every transaction dated in the period has a category | Always |
| G07 | Every balance sheet account has a tie out state of tied, or an approved variance carrying a reason and a reviewer | Always |
| G08 | 1900 undeposited funds agrees to the deposits in transit list | If undeposited funds is used |
| G09 | Inventory subledger equals the inventory control account | Inventory in scope |
| G10 | Sales tax payable agrees to the filed or computed return | Sales tax in scope |
| G11 | Payroll liabilities agree to the payroll provider report | Payroll in scope |
| G12 | Depreciation and amortization have been run for the period | Fixed asset register in scope |
| G13 | Prepaid releases and accruals for the period are posted | Prepaid or accrual schedules exist |
| G14 | Due to and due from related parties net to zero across the group | Related entities in scope |
| G15 | No account has a balance on the wrong side of its normal side without a stated reason | Always |
| G16 | Net assets with donor restrictions reconciles, and functional expense allocation is applied | Nonprofit only |
| G17 | Every client document request older than its escalation age is satisfied or explicitly waived | Always |

### Gate behavior

A gate is computed live against the ledger, never stored as a checkbox. Every gate returns pass, fail with a drill down list, or not applicable with the scope reason.

**Closing with exceptions.** A gate can be overridden, because real practice requires it, but the cost is visible. An override needs a named person, a written reason, and it flags the period as closed with exceptions. That flag appears on the statement header, in the close history, and to the client in the portal. It cannot be cleared retroactively, only resolved by a later corrected close.

**Locking.** A passed close locks the period. Locked means no transaction may be created, modified, or coded with a date inside it, and no run may touch it. Corrections happen as a reversing entry in the earliest open period, which is why `SUS-20` exists.

---

## Part 6. Verified external facts

These are the outside rules the software encodes. Each carries a source, because they change and the code should point at why it does what it does.

**1099 reporting threshold is 2,000 dollars, not 600.** Section 70433 of the One Big Beautiful Bill Act raised the Form 1099-NEC and Form 1099-MISC reporting threshold from 600 dollars to 2,000 dollars, effective for payments made on or after January 1, 2026, with inflation indexing beginning in 2027 ([Littler](https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds)). The threshold is measured per payee per calendar year and requires aggregating all payments to that payee during the year ([Anchin](https://www.anchin.com/articles/faqs-new-1099-nec-and-1099-misc-rules-beginning-in-2026/)). The forms filed in January 2027 are the first governed by the new rule.

The threshold must be a dated configuration value, not a constant. The 1099 run reads the threshold effective for the calendar year being reported, so a prior year rerun still produces 600 dollar behavior.

**Backup withholding moved with it.** The backup withholding trigger is also 2,000 dollars, indexed for inflation from 2027, and applies where a payee has not furnished a valid Form W-9 with a correct taxpayer identification number ([Littler](https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds)). This is why the W-9 tracker matters beyond tidiness.

**Attorneys are reportable even when incorporated.** Legal fees for services are generally reported on Form 1099-NEC even where the law firm is a corporation ([Anchin](https://www.anchin.com/articles/faqs-new-1099-nec-and-1099-misc-rules-beginning-in-2026/)). The corporation exclusion in the 1099 run must therefore carry an attorney exception, which is what the `attorney` value on `1099_class` is for.

**Form 1099-K reverted.** Section 70432 reinstates the 20,000 dollar and 200 transaction thresholds for third party network reporting ([Littler](https://www.littler.com/news-analysis/asap/tax-bill-changes-1099-reporting-thresholds)). Relevant to any client taking card or marketplace payments, since it changes what documents they will and will not receive.

**Nonprofits use two net asset classes.** FASB Accounting Standards Update 2016-14 replaced three classes with two, net assets with donor restrictions and net assets without donor restrictions, presented on the face of the statement of financial position ([FASB ASU 2016-14](https://storage.fasb.org/Update-2016-14.pdf)). It also requires an analysis of expenses by both natural and functional classification, plus disclosure of the allocation method. This is why the nonprofit template needs a functional dimension and cannot reuse the for profit chart.

**Capitalization safe harbor.** 2,500 dollars per invoice or item without applicable financial statements, 5,000 dollars with them ([IRS tangible property final regulations](https://www.irs.gov/businesses/small-businesses-self-employed/tangible-property-final-regulations)).

---

## Part 7. Manual authority

Automation never has authority a person does not. Three rules make that concrete.

1. **Manual wins.** Any value set by a person carries an override flag. No run may modify a flagged value. The flag is visible in the UI on the row.
2. **Manual is always available.** Every field a run writes is directly editable, and the manual path does not require the run to have executed first. If every automation were switched off the software would still be fully usable, only slower.
3. **Clearing an override is deliberate.** Removing the flag is its own action, logged, and it exposes the value to future runs again.
