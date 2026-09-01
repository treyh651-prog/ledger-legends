# Ledger Legends specifications

Read in order. `00` is the authority. When two documents disagree, `00` wins and the other is a defect.

| Document | What it settles |
|---|---|
| `00-conventions.md` | Money and sign conventions, account numbering blocks, the clearing and suspense block, identifier formats, versioning, the category layer versus the chart of accounts, the nine level coding cascade, the twenty suspense reason codes, the seventeen close gates, verified external tax and GAAP facts with sources, and manual authority. |
| `01-categories-and-charts.md` | The category to account model, a 64 account shared core chart, and four full templates for retail and wholesale, contractor, service studio, and nonprofit, each with a complete category table. Plus the coverage tables that make "no uncategorized" true per template, and the equity and owner activity differences across sole proprietor, LLC, S Corp, and nonprofit. |
| `02-run-specifications.md` | All 43 automation runs. Each carries inputs, the deterministic rule with every threshold and tie break, what it skips and the recorded reason, what it writes and whether it proposes or posts, what it logs, how it reverses, blocking preconditions, and the CI assertions. Plus the coding pipeline order and the auto post versus propose only split. |
| `03-run-framework.md` | The contract every run plugs into, built once. Lifecycle, the TypeScript interface, preview and apply sharing one code path, concurrency and advisory locks, the override flag contract, reversal semantics, locked period enforcement at the database level, the run log as audit evidence, triggering, failure handling, and the testing strategy. |
| `04-data-structures.md` | Annotated Postgres DDL for everything the runs need and the app does not have yet, with row level security enabled and forced on every tenant table, and a migration order. |

## The three ideas that carry the design

**No AI, and that is the stronger choice here.** Every automation is a rule you can read aloud in a review meeting. Same inputs, same output, every time. There are no confidence scores because a confidence score is not something you can defend to a client whose books were wrong.

**Uncategorized cannot exist.** Not by diligence, by construction. The cascade always terminates, and its last level posts to a real suspense account at 1990 with a mandatory reason code. An uncoded transaction is therefore a balance on the balance sheet, and gate G01 will not let you close while it is nonzero.

**Manual has authority automation does not.** Anything a person sets carries an override flag, and no run may write over it. Turn every automation off and the software is still fully usable, only slower.

## Open questions each document declares

Every document ends with what it deliberately left unresolved. Those lists are the real backlog, not a disclaimer. Notable ones: multi member LLC and partnership equity, inventory costing method, the percentage of completion computation for the contractor template, endowment spending, and whether gate results may be cached for the UI.
