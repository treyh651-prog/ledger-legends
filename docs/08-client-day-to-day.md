# Client Day To Day

The client portal is a plain window into your own books. It shows the numbers Jose and Rosario see, filtered to the things you can act on. Nothing you do on this side posts a journal entry. Everything you do is either a question answered, a document uploaded, or a decision recorded.

There are three tiers. You can see which one you are on in the sidebar. Higher tiers unlock more screens, and locked screens on a lower tier show a real fact from your books rather than a blurred fake preview, so upgrade decisions get made on real information.

Story is where you start. Journey adds monthly review, budgets, and aging. Legend adds cash forecast, scenarios, entities, and narrative.

## Portal home

Opens on your current period. Cash on hand, net income for the period, revenue, and any open items owed by you. If Jose or Rosario needs an answer to close the books, it shows up in the "Needs a person" list on this page, with what they need and when they need it by.

The Statements card links to the last three months of financials once close is finished. If the current period is still open, you see a note saying so.

## Documents

Everything Jose has raised as a request lives here. Each one has:

The subject in plain English. What it is for. Who owns it, you or the firm. How overdue it is. The audit trail of everything that happened to it.

You resolve a request one of three ways:

Upload the document, if that is what was asked. The file goes to the vault (SHA-256 stamp, IP, user agent, and full event sequence for audit). Extensions we accept are PDF, JPG, PNG, XLSX, CSV, DOCX, TXT. We do not accept parseable PDF as a bank statement. If it is a bank statement, use OFX, QFX, QBO, CAMT.053, or CSV via a saved mapping profile.

Answer the question in a message, if the request is about business purpose (SUS-03 style) or vendor identity (SUS-01 style) or a coding choice you need to make. Your answer becomes part of the audit trail and Jose sees it immediately.

Escalate, if you cannot get to it in the window. The request moves to the next check date with your reason, and Jose sees the escalation on his workload board.

Nothing gets sent by email tonight. The software records the intent to notify and Jose or Rosario checks the workload board.

## Transactions

The full bank register, everything the bank fed to the software, coded by the software's cascade, plus anything the firm has posted directly. Each row shows the date, description, amount, account, and how the coding was decided.

Coding sources you will see:

Manual override, meaning Jose or Rosario coded it by hand. Sticky, no run will retouch it.

Rule, with the rule name and priority. The rule id and version are on the row, so six months from now the software can tell you why this row was coded this way even if the rule has changed since.

Vendor default, meaning the vendor has a preferred account and no rule fired above it.

Bank code map, meaning nothing above matched and the bank's own category was used.

Suspense with a reason code, meaning the coding cascade could not decide. Every suspense row has an owner and an escalation date. You will see the code and its plain English meaning on the row.

You can propose a coding change on any row: click Propose, pick the account, add a note. The change enters Jose's queue. It does not post directly, because coding is a firm decision even when you are certain. Once Jose accepts, the row becomes an override and stays put.

## Statements

Balance sheet, income statement, cash flow, statement of equity. Snapshots at close date. Downloadable. AR aging and AP aging are their own tabs. Everything ties to the reports Jose sees, byte for byte.

If you are on Story, statements is quarterly. Journey and Legend are monthly.

## Compare (Journey and Legend)

Two periods side by side, by account. Variance and variance percent. Click any row to drill to the transactions behind the movement.

## Budget versus actual (Journey and Legend)

Budget rows Jose entered per account per month, actuals from the ledger, variance and variance percent. Rows that crossed the threshold (default 10 percent, but Jose can override per account) are highlighted.

## Aging (Journey and Legend)

AR aging. Every open invoice per customer, by bucket (current, 1 to 30, 31 to 60, 61 to 90, 91 plus). Statements you can send to your customers are here, one click. Sending is not wired tonight, so you download and email.

AP aging. Every open bill per vendor by the same buckets. Not editable from the portal, this is a view.

## Open period (Journey and Legend)

Where you are in the current close. Which gates have passed, which are still red, and which rows are blocking each red gate. If a row you own is blocking (typical case: a suspense item waiting on your reply, or an uploaded document), the button on the row takes you straight to it.

The current close percent on the top of every screen is the same computation.

## Forecast (Legend)

Thirteen week cash forecast. Rebuilds any time you or Jose posts. Deterministic curves: open AR is paid on its historic collection curve, open AP on due date unless a discount rule kicks in, recurring templates fire on their dates, loan schedule fires on its dates, payroll approvals fire on their pay dates.

No ML. No prediction. You get the same answer twice from the same inputs.

## Scenarios (Legend)

What if I hire one person at this salary. What if I move to this bigger space. What if collections slip by two weeks. Each scenario is a saved delta against the forecast, and you can toggle them on and off to see combined effect. Nothing about scenarios touches the actual ledger.

## Narrative (Legend)

The prose version of what the numbers changed this period, filled from thresholds. If a variance crossed the flag, if a gate failed, if a suspense item is older than thirty days, the narrative names it. No opinions and no advice, and a test in our build refuses any template that tries to sneak that in.

## Entities (Legend)

If your business is set up as a group of related entities (holding company plus operating LLC plus a real estate LLC, say), this page shows each entity's summary and combined roll ups. Legend tier only because most single entity clients do not need it.

## Tiers

The Tiers page lays out all three tiers in plain English, what each includes, what upgrading gets you, and if you are on Story or Journey, a locked feature preview. The locked preview always uses a real fact from your books, so you know exactly what the upgrade would show, not a fake.

## Compliance, on your side

We do not file your tax returns. We compile the numbers your CPA files from and hand them off. If you do not have a CPA, we can recommend the shape of one to look for, but we do not become one.

We do not touch your money. Payroll approval means we mark a run as approved so it can be filed with your payroll processor. We never move money.

We do not act as your registered agent or your legal representative. Legal filings are your law firm's job, entity setup is your law firm's job, contracts are your law firm's job.

Every document you upload is retained for seven years in an object locked vault. You can request an export in an open format (CSV, JSON, PDF) at any time. If you leave, per our engagement letter, we produce that export within fifteen business days.

## Practical answers

I got an email about a transaction I do not recognize. Post the question in Documents against the transaction. Include a screenshot if you have one.

I want to change how a vendor is coded going forward. Go to the transaction, click Propose, pick the account you want. Say in the note "code all future for this vendor to this account." Jose or Rosario will turn that into a rule so the coding fires automatically next time.

I need last quarter's financials. Go to Statements. If they are not there yet, that quarter has not closed.

I want to add a bank account. Message Jose or Rosario. New accounts get set up by the firm so the coding rules and bank mapping are configured before the first import.

I want a report the portal does not have. Message the firm. Custom reports are Legend tier as a standard, and are available as one offs on other tiers at the hourly rate in your engagement.
