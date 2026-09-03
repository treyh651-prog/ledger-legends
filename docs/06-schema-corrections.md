# 06. Schema corrections found during implementation

Status: authoritative for the items listed. Where this document conflicts with document 04, this document wins.

Writing the migrations against document 04 exposed nine defects. Every one of them would have been a production problem rather than a review comment, which is the argument for building the schema before building runs on top of it. Each is recorded here with what was wrong, what the migrations do instead, and whether anything is still open.

---

## C1. The journal entry and line DDL was missing

Document 04 Part 14 listed journal entries and lines as required and never defined them. This is the center of the ledger, so nothing could be written without it.

**Resolved.** Authored in `0002_ledger_core.sql`. Amounts are `bigint` cents with a signed line convention. Balance is enforced by a deferred constraint trigger evaluated at commit rather than per statement, because a balanced entry cannot exist halfway through its own insert. Draft entries are exempt from the balance requirement, since a draft is by definition incomplete, and gate G02 already refuses to close a period holding one.

## C2. The contra offset of exactly 100 collides with the block map

Document 00 pairs accumulated depreciation to cost at an offset of plus 100. Applied literally that rule sends allowance for doubtful accounts from 1100 into the inventory block, and document 00 keeps intangibles and their amortization both inside 1700 to 1799 while the pairing constraint pushes the accumulated side to 1800.

**Resolved.** The plus 100 offset is retained as the default for fixed asset cost and accumulated depreciation pairs, which is the case it was written for. It is no longer a global constraint. Contra pairing is now an explicit declared relationship on the account row, validated to be a contra account on the opposite normal side within the same statement section. The default still produces plus 100 for every fixed asset pair.

**Still open.** Whether intangible amortization should move to the 1800 block for consistency, or stay inside 1700 to 1799 as document 00 has it. The migrations follow document 00 and keep it in 1700 to 1799.

## C3. The long term loan block overlaps related parties

`loan_lt_block` allowed 2700 through 2999 while document 00 reserves 2900 through 2999 for related party balances. A related party loan would have landed in a block gate G14 reads for a different purpose.

**Resolved.** The loan block is narrowed to 2700 through 2899. Related party notes stay in 2900 through 2999 and are reached through the related party dimension, not the loan register. Document 00's block map is the authority and the constraint now matches it.

## C4. `accounts_one_contra_per_cost` enforced the reverse of its comment

The comment said one contra account per cost account. The constraint as written enforced one cost account per contra account, which permits a single cost account to accumulate several contra accounts. That is exactly the state that makes a fixed asset register stop tying to the balance sheet.

**Resolved.** Rewritten as a unique index on the cost account, matching the stated intent.

## C5. The run log idempotency index cannot exist on a partitioned table

`run_log_idem` was specified as a unique index on a partitioned table without including the partition key. Postgres rejects that. Rules are also unsupported on partitioned tables, which the insert only enforcement depended on.

**Resolved.** The idempotency uniqueness is created per partition, and the insert only enforcement is a trigger rather than a rule. The guarantee is unchanged. Doc 03's idempotency key semantics are untouched.

**Consequence worth knowing.** Uniqueness is now per partition rather than global. Because the partition key is the run's own timestamp and an idempotency key includes the period scope, a duplicate landing in a different month is possible in theory. The framework's advisory lock closes it in practice, and the run log is evidence rather than a constraint surface.

## C6. `ledger.categories` lacked the unique target its foreign keys need

Several composite foreign keys referenced a category by a column pair that had no matching unique constraint, so the references could not be created.

**Resolved.** The unique target was added on the versioned category identity. No semantic change.

## C7. Grants were made to roles that were never created

Document 04 granted privileges to application roles it never defines. Applied as written the migrations fail on a clean database.

**Resolved.** Role creation added ahead of the grants, guarded so a rerun on a database where the role exists does not fail.

## C8. `doc_key_shape` breaks on a file name containing a slash

The vault key constraint binds the S3 key to both discriminators by pattern. A file name containing a slash satisfies the pattern while placing the object outside its own tenant prefix. That is a tenant isolation defect, not a formatting one.

**Resolved.** The key is now built from a generated identifier rather than the supplied file name, and the original name is stored separately as metadata. A client can upload a file named anything at all and it cannot escape its prefix. This is also why the intake rules verify content type against magic bytes rather than trusting the extension.

## C9. The transaction register does not exist

Document 04 defines subledgers, schedules, and the journal, but never the bank transaction register that the coding cascade operates on. Several id columns therefore have no foreign key to point at, and the import pipeline has nothing to import into.

**Not resolved. This is the next blocker.** The register is what `IMPORT-COMMIT-BATCH` writes to, what all nine coding runs in module 2 read, and what reconciliation matches against. It needs to be specified and added as migration `0011` before the import pipeline is built. It is now the first item of build step three.

---

## What this says about the process

Eight of nine were caught by attempting the implementation rather than by reading. The specifications were reviewed for internal consistency and passed, because a constraint whose comment contradicts its own logic reads correctly to anyone not executing it.

Two of the nine were tenant isolation or data integrity defects, C4 and C8, rather than mechanical failures. Those are the ones that would not have announced themselves. C8 in particular would have worked correctly for every well behaved file and failed only for a file deliberately named to escape.

The practical rule is that a schema is not reviewable as prose, only as something a database accepts or rejects.
