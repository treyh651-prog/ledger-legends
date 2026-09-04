# Bookkeeper Day To Day

For Jose and Rosario. This is what a normal week and a normal month look like inside Ledger Legends, screen by screen, decision by decision. Read it once, then keep it open until it becomes muscle memory.

The firm is you two. The scope is bookkeeping. You are not a CPA firm, you never file, you never submit, you never issue a return to a payee. When a task looks like it is asking you to cross that line, stop and see the compliance section at the end.

## The dashboard

Firm overview is the first screen. Five things live at the top: clients on the books, revenue tracked, close progress, transactions waiting in suspense, and tie out exceptions. Every number is a real computation from the underlying ledger, so if you move a suspense item it changes on the dashboard immediately.

The client book below lists every client with their stage, lead, revenue, net income, cash balance, close percent, and the exceptions blocking their close (suspense items, tie out breaks, reconciliation breaks, open requests). Click a row and the whole workspace switches to that client.

The switch at the top right chooses between the Firm view (what you see) and the Client portal view (what the client sees, on their own site). The DATA switch lets you flip between Demo, Test, and Empty. Use Test on Bramble & Bean to check math against a known good set of books. Use Empty to feel what a brand new client looks like before anything is set up.

## Starting a new client

Click Start a client intake on the firm overview, or go to New client intake in the sidebar. Ten short steps: business profile, owners, engagement scope, systems inventory, accounts inventory, prior records, engagement letter, signature, access and roles, review and finish. Every step is a form. Nothing is inferred. Nothing gets sent.

At Finish the wizard creates the client record, the bank accounts, the standard tasks for the scope you picked, and the signed engagement audit row. Behind the scenes, four setup runs seed the chart of accounts from the industry template, seed the practice tasks, raise the opening document requests, and post the opening balances if you loaded a trial balance. If the trial balance does not foot, the fourth run refuses and asks you to fix the numbers rather than plug it.

Northgate Mechanical is a working example of a wizard set up client, cutover 2026-07-01, industry template services. Bramble & Bean is your self checking company, set up before the wizard existed, and stays that way so we always have a fixed reference.

## The weekly rhythm

Monday morning. Open Firm overview, look at the Workload board (34 tasks open, 34 past due in the current demo). Sort by client, work top to bottom.

Every client's transactions page is where coding happens. The nine coding runs already fired overnight: they normalized vendors, detected duplicates, paired transfers, split settlements, applied recurring templates, applied rules, applied vendor defaults, mapped bank codes, and swept the remainder into 1990 with a reason code. What is left for you is the rows in the exceptions band, that is:

Transactions in suspense (parked in 1990). Each carries a reason code like SUS-01 unknown vendor money out, or SUS-03 business purpose not determinable, plus an owner (firm or client) and an escalation window. Firm owned codes are yours to research. Client owned codes need a message to the client, which goes out via the communication log, not email.

Rules conflicts (SUS-19). Two rules matched the same row at the same priority. The row is in suspense with the two rule ids on it. Either raise one rule's priority (rules page), narrow one condition, or code the row by hand and it becomes an override.

Foreign currency in suspense (SUS-11). We never code a foreign currency row automatically, per doc 00. Look at the exchange rate you actually got from the bank, post the entry with that rate against the correct expense.

The manual override rule. Once you code a row by hand, that row is stuck to your decision. No later run touches it. This is on purpose. If you change your mind later you clear the override from the row, and the coding cascade will run against it fresh.

## Reconciliation

Import a bank statement (OFX, QFX, QBO, CAMT.053, or a saved mapping profile for CSV or XLSX). We do not parse PDF statements ever. It is a database constraint. The reason is your reputation, not our budget.

Three runs happen: tiered matching against the register, clearing the matched items, and flagging outstanding items over the age threshold. The Reconciliation page shows you the batch with statement balance, cleared ledger balance, and the difference. If the difference is not zero, that page tells you which items are outstanding and which are unmatched.

The difference is a postable number: sum of tier 3 match diffs plus every unmatched line. When it is zero, the reconciliation is done and you close it.

## Period end

Six runs fire on the first day of the new period, plus one that reverses last period's accruals. They post recurring templates, amortize prepaids, split cleared loan payments into interest and principal, post accruals, post depreciation, and reverse last period's accruals unless a real invoice or bill superseded them.

Reversal skip logic is worth knowing. If a bill for an accrued expense arrived and got linked to the accrual, the reversal skips that accrual because reversing it would double the expense. If no bill arrived, the reversal fires and the expense sits back at zero until the bill lands.

Depreciation runs monthly using the method stored on each asset (straight line, DDB, or MACRS). MACRS is a bookkeeping mechanic here, not a tax position. If your CPA wants tax depreciation differently, they compute it and you record the adjusting entry.

## Close checklist

Substantiation is where you or Rosario compares each balance sheet account to its source: cash to statement, AR to aging, AP to aging, loans to schedule, prepaids to schedule, fixed assets to schedule, inventory to physical count. The Substantiation page has a tie out row for every account, either tied or with a variance shown.

Then the nineteen gates. G01 through G19 evaluate live from the ledger, no manual answers. You cannot lock the period while any gate fails. Each failed gate lists the exact rows blocking it, and each row has a link back to where you fix it.

Notably: G17 requires no orphan document requests older than 30 days without owner change. G18 requires preparer is not the approver on any run. G19 requires the derived cash basis reconciles to accrual minus AR change minus AP change. All three are software enforced, not a checklist you tick.

Lock the period when every gate passes. The lock stamps the actor and the ledger fingerprint at the moment of locking, and no later run can post to that period.

## Reports

Report package builds after close: balance sheet, income statement, cash flow, statement of equity, AR aging, AP aging, notes, and a change log. Snapshot at close date. Attached to the vault at seven year retention.

Variances flag actuals against budget past a threshold (default 10 percent, per account overrides allowed). Only real posted numbers, no forecast in the flag.

Cash forecast rebuilds a thirteen week outlook from open AR, open AP, recurring templates, loan schedule, and payroll approvals. Deterministic, no ML.

Narrative composes prose from threshold triggers, filling fixed sentence templates with real ledger figures. A test asserts the templates contain no advice vocabulary, so a future template that offered an opinion would fail the suite and never ship.

## Compliance, hard lines

You are not a CPA. Anywhere the software would let you cross that line, it refuses at the database level.

Payroll: PAY-APPROVE-RUN attaches a payroll register PDF from the vault and stamps status approved. The row has a database constraint named pay_run_no_disbursement_authority that refuses any attempt to set authorizes_disbursement true. PAY-POST-REGISTER records the entry to the ledger. Neither run disburses money. That is the payroll provider's job.

Tax: TAX-BUILD-1099 compiles the reportable payee data set at the current year threshold (2000 for 2026 and after, 600 before). Excludes corporations and payees on hold. The output is a data set the CPA files from. It never files. It never issues to the payee. Every tax file carries the banner in exact words, and a test reads the banner off disk and fails the build if it drifts.

CPA handoff: CPA-BUILD-HANDOFF assembles the trial balance, general ledger, subledgers, schedules, closing entries, tax data set if fiscal year end, and every open item log, into an archive attached to the vault. Never issues, never files, never emails.

Offboarding: OFFBOARD-BUILD-EXPORT produces an open format archive of the full client history within fifteen business days per D9. Constraint enforced by name at the database.

Everywhere else: no external sends anywhere in the software tonight. Every notify side effect writes to the audit log. When we wire external email later, it will be a separate opt in per client per notification type.

## When the software refuses you

Preview equals apply. Every run previews first. If preview and apply diverge, the framework refuses the apply. This has caught several defects during construction. If you see a "stale preview" refusal in the run log, click Rerun and it will preview and apply cleanly.

Locked periods. Every run skips a locked period with reason locked_period. If you need to backpost, unlock the period (which is audited), post, then re lock.

Override respect. No run touches a row with manual_override set. If a rule stops firing on rows you thought it should, check whether those rows carry an override. Clear it and the rule takes over again.

Books must foot. Every posted entry must balance to zero. Every derived balance must tie back to its source. The books check runs on every commit and blocks the build if it fails.

## The three options rule

Any defect you find, any place where the specs are unclear, any place where the software is asking you to make a call, you write three options, pick the best, say why. That log is in server/runs/NOTES.md. It is 128 decisions long as of today, all with reasoning. When you find a new one, add it. Never fix silently.
