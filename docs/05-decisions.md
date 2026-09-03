# 05. Binding decisions and amendments

Status: authoritative. Where this document conflicts with documents 00 through 04, this document wins and the older text is a defect to be corrected.

Decided by Trey Hernandez, September 3, 2026.

---

## Part 1. Decision register

| ID | Decision | Effect |
|---|---|---|
| D1 | Portal tier is bundled into the service level. Payments are handled outside the software. | The subscription model in document 04 is removed. Entitlement derives from the engagement. |
| D2 | Intake accepts the file formats this business actually receives. Any document can be uploaded. | New import module. Structured files become transactions. Everything else becomes a vault document. |
| D3 | The ledger is accrual native. Cash basis is a derived report, never a second set of books. | One posting model. Two report views. |
| D4 | The firm is two people, Jose Hernandez and Rosario Rosales. Neither is a CPA. | No tax preparation, no filing, no tax advice. The software compiles and hands off. |
| D5 | Payroll may be reviewed and approved. The firm never moves money. | Approval and posting runs only. No calculation, no disbursement. |
| D6 | Inventory is periodic with weighted average cost. | Closes the open question in document 01. |
| D7 | Vault retention is seven years with Object Lock in governance mode. | Matches the run log retention already specified. |
| D8 | The engagement letter signature carries a full evidentiary audit trail. | A typed name alone is not sufficient. |
| D9 | A departing client receives a complete export in open formats within fifteen business days. | Belongs in the engagement letter and in the software. |

---

## Part 2. D1. Bundled entitlement

The commercial model is one sale. Bookkeeping at a service level, and the portal depth follows that level. There is no card on file, no plan, and no processor inside this product. Fees are invoiced and collected outside the software.

### What changes in document 04

The `billing` schema is renamed `entitlement`, because nothing in it touches money any longer and the old name invites someone to add a charge later. Inside it:

- `billing.subscriptions` is deleted in full. Every column on it existed to track a payment lifecycle that no longer exists here: `status`, `current_period_end`, `external_ref`, and the `trialing`, `active`, `past_due`, `canceled`, `paused` constraint.
- `entitlement.grants` replaces it. Entitlement is effective dated and sourced from the engagement.

```sql
create table entitlement.grants (
  id             uuid primary key default gen_random_uuid(),
  firm_id        uuid not null references tenancy.firms(id),
  client_id      uuid not null references tenancy.clients(id),
  engagement_id  uuid not null references tenancy.engagements(id),
  tier_id        text not null references entitlement.tiers(id),
  effective_from date not null,
  effective_to   date,                          -- null means current
  set_by         uuid not null,
  reason         text not null,
  created_at     timestamptz not null default now(),
  constraint grant_dates check (effective_to is null or effective_to > effective_from)
);

create unique index grant_one_current_per_client
  on entitlement.grants (client_id) where effective_to is null;

create index on entitlement.grants (client_id, effective_from desc);
```

`entitlement.tiers`, `entitlement.features`, `entitlement.tier_features`, and `entitlement.entitlement_overrides` survive unchanged apart from the schema rename. `has_feature` keeps its signature and reads `grants` rather than `subscriptions`, resolving the row where `effective_to is null`.

Effective dating is the whole reason this stays its own table rather than a column on the engagement. Six months from now the answerable question is what a given client could see on a given date, and a column overwritten in place cannot answer it.

### Rules that survive from the old model

- No table in `ledger`, `subledger`, `tenancy`, or `vault` references anything in `entitlement`.
- `tenancy.has_client_access` never calls `entitlement.has_feature`. CI greps for that.
- Entitlement is never a row visibility predicate. It is checked in the API layer and the UI, where a 402 or a disabled control is the correct outcome.
- A client's own records, document upload, and messaging are never gated by anything. The lowest tier always sees its own books.

### Migration order

`0007_billing.sql` becomes `0007_entitlement.sql`. The CI assertion that no tenant table references the billing schema is retained against the new name.

---

## Part 3. D2. Intake and imports

Two separate pipelines, deliberately. Confusing them is how bad data enters a ledger.

### Pipeline one, transaction sources

A file becomes transactions only when the file is structured and the parse is deterministic. Accepted:

| Format | Notes |
|---|---|
| OFX and QFX | Preferred. Carries a bank supplied unique id per transaction, which makes duplicate detection reliable. |
| QBO | Same structure as OFX. Accepted on the same path. |
| CAMT.053 | Accepted where a bank offers it. |
| CSV and XLSX | Accepted through a saved column mapping profile. |

There is no statement parser for PDF, and there will not be one. Reading a PDF statement into transactions requires inference, and inference is the thing this product refuses to do. A PDF statement is filed as a document and reconciled against, which is its correct role.

**Column mapping profiles.** A CSV layout is configured once per institution by a person, stored as `import.mapping_profiles`, and reused. The profile names the date column and its format, the description column, the amount column or the separate debit and credit columns, the sign convention, the currency, and any rows to skip. The profile is versioned. If an incoming file's header row does not match the stored profile exactly, the import stops and asks. It never guesses a shifted column, because a silent column shift is the worst failure this pipeline can have.

**Deduplication on import.** Where the file carries a bank supplied id, that id is the key and a repeat is rejected outright. Where it does not, a staged row matching an existing posted row on account, date, amount, and normalized description is held for review rather than committed. Import dedup runs before the coding cascade, so `TXN-DETECT-DUPLICATES` is a second net rather than the only one.

**Staging.** Imports land in a staging table and are committed as a named batch. A batch is reversible as a unit until any row in it is reconciled. This means a bad import is one undo rather than an afternoon.

### Pipeline two, documents

Everything else uploads to the vault as a document with a type and a link to a client, a period, an account, a transaction, or a vendor. Accepted: PDF, PNG, JPG, HEIC, TIFF, DOCX, XLSX, CSV, TXT, EML, and MSG. Email formats are included because a large share of what a small business sends is a forwarded email with the real document attached.

A document is never read by the software to produce accounting data. A person links it. The document types already declared in document 04 are extended with `invoice_ap`, `invoice_ar`, `receipt`, `bank_statement`, `card_statement`, `processor_statement`, `insurance_policy`, `lease`, `formation_document`, `w9`, `payroll_register`, and `correspondence`.

**Size and safety.** One hundred megabyte ceiling per file. Content type is verified against file magic bytes rather than the extension. Uploads are scanned before they are linkable. Original bytes are never modified, and a rendered preview is a derived object stored beside the original.

### New runs

| Run | Purpose | Posts |
|---|---|---|
| `IMPORT-PARSE-FEED` | Parse an uploaded structured file into staged rows using the institution's mapping profile. Reject on header mismatch. | No |
| `IMPORT-COMMIT-BATCH` | Commit a reviewed staging batch into the transaction register as a named, reversible batch. | Yes |

---

## Part 4. D3. Cash basis and accrual basis

**Decision: the ledger posts on the accrual basis, and cash basis is a report view computed from the same entries. There is never a second ledger.**

This is the one item on the open list that cannot be retrofitted, which is why it is being answered now rather than later.

### Why not cash native

A cash native ledger has no receivable and no payable, so accrual reporting has to be reconstructed later from documents that were never captured. Every client who eventually needs a bank package, a real gross margin, or a buyer's due diligence forces a rebuild. Going the other direction is cheap, because an accrual ledger already contains everything a cash basis report needs.

### Why not two ledgers

Two posting streams means two trial balances that will disagree, and reconciling them becomes permanent monthly work for a two person firm. It also doubles the surface area of every run in document 02.

### How the derived view works

Every journal entry line carries the fields needed to answer the cash question without a second posting:

```sql
alter table ledger.journal_lines
  add column cash_effect       text not null default 'none',
  add column cash_event_date   date,
  add column cash_source_line  char(26);

alter table ledger.journal_lines
  add constraint jl_cash_effect check (cash_effect in ('none','cash','accrual_only')),
  add constraint jl_cash_dated  check (cash_effect <> 'cash' or cash_event_date is not null);
```

- `cash` marks a line where money actually moved, dated by the day it moved.
- `accrual_only` marks a line that exists purely for timing, meaning receivables, payables, prepaids, accruals, and depreciation.
- `none` is the default for lines where the distinction does not apply.

The cash basis income statement is the accrual statement with `accrual_only` lines excluded and revenue and expense recognized on `cash_event_date` rather than entry date. The cash basis balance sheet drops AR, AP, prepaid, and accrued liability balances. Depreciation stays on both, because tax basis cash reporting still depreciates and dropping it would produce a number no CPA would accept.

### Rules

- The engagement records a `reporting_basis` of `accrual`, `cash`, or `both`. It sets the default report view. It never changes how anything posts.
- Every report header states its basis in words. A statement that does not say which basis it is on is a defect.
- The close gates in document 00 are evaluated on the accrual ledger. There is no cash basis close.
- The CPA handoff package carries both views, because the return is usually cash and the management reporting is usually accrual.
- New gate **G19**: for any client on `cash` or `both`, every line marked `cash` has a `cash_event_date` inside a period that is not locked ahead of it. This catches a backdated cash date silently changing a filed year.

---

## Part 5. D4. Firm scope, and the line the software must not cross

The firm is Jose Hernandez and Rosario Rosales. Neither is a CPA. The software must make it structurally hard to drift across that line, because drift is how an unlicensed practice complaint starts.

### What the software does not do

- It does not prepare a tax return, and there is no return module.
- It does not file anything with the IRS or a state. There is no IRIS enrollment, no transmitter control code, and no e-file path.
- It does not give tax advice, and no run produces a recommendation phrased as tax guidance.
- It does not sign anything as a preparer.

### What the tax module actually is

`TAX-BUILD-1099` and `TAX-TRACK-W9` keep their run ids for consistency with document 02, but their scope is restated here and that restatement governs.

`TAX-BUILD-1099` produces the reportable payee data set. It computes who crossed the threshold, using the dated threshold configuration and the 2026 change to two thousand dollars already recorded in document 00, and it flags missing and expired W-9s. Its output is a data set and an exception list handed to the client's CPA. **It does not generate a filable form and it does not transmit.** Its output file is labeled as compiled data prepared for the client's tax preparer.

`TAX-TRACK-W9` collects and tracks W-9 status. Collection is a bookkeeping function and stays in scope.

### New run, CPA-BUILD-HANDOFF

The year end package assembled once and handed off. Contents:

- Trial balance on both bases, with the basis stated on each.
- General ledger detail for the year.
- Balance sheet and income statement, both bases.
- Fixed asset register with the year's additions, disposals, and depreciation.
- Loan amortization detail with the year's principal and interest split.
- The 1099 reportable payee data set and the W-9 exception list.
- Accrual and prepaid schedules with balances.
- Substantiation tie out results by balance sheet account.
- The suspense account history for the year, which should be an empty balance and a non empty history.
- A statement of what the firm did and did not do, generated from the engagement scope.

That last item is the point of the run. It is the artifact that says in writing that this is compiled bookkeeping, not an audit, not a review, not a compilation report under professional standards, and not tax advice.

### Roles for a two person firm

Roles are real, not decorative, and two people is exactly enough to run the one control that matters.

| Role | Holder | Can |
|---|---|---|
| Owner | Jose Hernandez | Everything, including tier grants, engagement changes, and period unlock |
| Preparer | Either | Run runs, post entries, resolve suspense, respond to clients |
| Reviewer | Either, per period | Approve gate exceptions and approve the close |

**New gate G18: the person approving a close is not the person who prepared it.** With two staff this is achievable on every engagement, and it is the single control an outside party will ask about. Period unlock is Owner only and always writes a reason.

---

## Part 6. D5. Payroll

The firm may review and approve a payroll before the provider processes it. The firm never initiates a payment, never holds client funds, and never has disbursement authority. That distinction is the difference between a bookkeeping service and a money transmission problem.

### What the software supports

| Run | Purpose | Posts |
|---|---|---|
| `PAY-APPROVE-RUN` | Record a reviewed and approved payroll run against the provider's register, with approver, timestamp, gross, employer taxes, and net, plus an explicit statement that approval does not authorize disbursement. | No |
| `PAY-POST-REGISTER` | Post the payroll journal entry from the provider register: gross wages by department or job, employer taxes, withholdings to liability, and net to the bank or to 1930 payroll clearing where the debit timing differs from the pay date. | Yes |

`PAY-POST-REGISTER` posts only from a register document that is already in the vault and linked. It refuses to run against a manually keyed total, because the register is the evidence that makes gate G11 meaningful.

The software calculates no tax, computes no withholding, and produces no filing. Gate G11 is unchanged and now has a defined source, the linked register.

---

## Part 7. D6 through D9, the remaining open items

### D6. Inventory, closing the document 01 open question

Periodic, with weighted average cost. Committed for the roaster template.

Perpetual inventory needs a point of sale integration and unit level movement the firm does not receive, and a perpetual system fed by guesses is worse than an honest periodic one. The month end count is a client document request with an escalation age, the adjustment is a proposed entry a person approves, and gate G09 compares the subledger to the control account after it posts. Weighted average is chosen over FIFO because it survives a client who counts in pounds and buys in bags without needing layer tracking the firm cannot observe.

If a client later brings real unit level data, the costing method is recorded per client and this becomes a per client setting rather than a rewrite.

### D7. Vault retention

Seven years, matching the run log retention already in document 03. Object Lock in governance mode rather than compliance mode.

Governance mode is the right call because compliance mode cannot be shortened by anyone, including you, for any reason, and a seven year immutable hold on a client document you were asked to delete is a problem with no exit. Governance mode still blocks ordinary deletion and still produces the audit story, and a privileged override is logged.

Retention starts at the document's period end, not its upload date, so a document uploaded late for an old period does not outlive its cohort.

### D8. Engagement letter signature

The current typed signature is not sufficient evidence if a client later disputes scope.

Captured at signing and stored immutably beside the executed document:

- SHA-256 hash of the exact document bytes presented, so the signed version can be proven later.
- Signer name, email, and the authenticated account if there is one.
- Timestamp from the server, never the client.
- IP address and user agent.
- Explicit consent to electronic signature, recorded as its own event.
- The full sequence of view, scroll to end, and sign events with timestamps.

That set is what ESIGN and UETA practice expects, and it is cheap to capture at the moment of signing and impossible to reconstruct afterward.

### D9. Client offboarding

A departing client receives a complete export within fifteen business days, in open formats, with no fee. The same language belongs in the engagement letter.

New run `OFFBOARD-BUILD-EXPORT` produces one archive:

- Chart of accounts, categories, and the mapping between them, as CSV.
- All journal entries and lines, as CSV, with full provenance columns.
- All registers: AR, AP, fixed assets, loans, deferrals, inventory.
- Trial balance and financial statements per period, both bases.
- Every vault document, in original bytes, in a folder tree by year and type.
- A manifest with a row count and a checksum per file.

Open formats only. The point is that the client's next bookkeeper can actually use it, which is both the ethical position and the one that gets you referred.

---

## Part 8. What this changes in the earlier documents

| Document | Change |
|---|---|
| 00 | Gates G18 and G19 added. G11 gains a defined source, the linked payroll register. |
| 01 | Inventory open question closed by D6. Periodic, weighted average. |
| 02 | Run count moves from 43 to 49. `TAX-BUILD-1099` scope restated as compilation only. |
| 03 | Unchanged. The framework contract carries all new runs without modification. |
| 04 | `billing` schema renamed `entitlement`. `subscriptions` deleted, `grants` added. Three cash basis columns added to `ledger.journal_lines`. Import staging and mapping profile tables added. Vault document types extended. Signature evidence table added. |

### The six new runs

`IMPORT-PARSE-FEED`, `IMPORT-COMMIT-BATCH`, `PAY-APPROVE-RUN`, `PAY-POST-REGISTER`, `CPA-BUILD-HANDOFF`, `OFFBOARD-BUILD-EXPORT`.

Total is 49. Document 02 Part G remains the authoritative index once these are appended to it.

---

## Part 9. Revised build order

1. **Run framework**, exactly as document 03 specifies. Unchanged by these decisions, which is the evidence the contract was drawn correctly.
2. **Schema**, in the document 04 migration order with these amendments folded in before anything is written rather than after. The cash basis columns on `journal_lines` go in at `0002`, not as a later alter, because every run reads that table.
3. **Import pipeline**, moved earlier than originally planned. Nothing downstream can be tested against real data until transactions can get in, and the mapping profile design is best proven against a real bank export now rather than after 49 runs depend on it.
4. **Seed the four chart templates and the category tables** from document 01, with the inventory decision applied.
5. **First two runs, transfer pairing then rules**, in that order.
6. **Close gates as live computations**, all nineteen.
7. **Entitlement layer**, tiers and grants, once there is something worth gating.
8. **Remaining runs** in the order client work demands.
9. **CPA handoff and offboarding export**, both of which can wait until there is a full year of data to package.

Payroll runs enter at step 8 and only for clients where payroll is in scope.

---

## Part 10. Still open

- Multi member LLC and partnership equity, carried from document 01.
- Percentage of completion computation for the contractor template, carried from document 01.
- Endowment spending policy and underwater disclosure for the nonprofit template, carried from document 01.
- Stored functional allocation bases for the nonprofit template, carried from document 01.
- Whether an aggregator is ever added as a transaction source. Deferred rather than rejected. The import pipeline's staging design keeps the door open, because an aggregator would land in the same staging table.
- Multi currency. Assumed out of scope. Every client named so far is domestic.
