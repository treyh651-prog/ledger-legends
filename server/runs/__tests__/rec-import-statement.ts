/**
 * REC-IMPORT-STATEMENT tests. The insert, the no-op repeat on the same
 * statement id, an unknown bank account, and the proof that matters most:
 * once this run has written the bank's lines, REC-MATCH-TIERED can actually
 * reconcile them against the register, which was impossible before this run
 * existed because nothing put a statement line on the books at all.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, opts, txn } from "./fixtures";
import { ACCOUNT, matchScope, recDb } from "./rec-fixtures";
import {
  recImportStatement,
  statementLineIdFor,
  type ImportStatementScope,
} from "../runs/rec-import-statement";
import { recMatchTiered } from "../runs/rec-match-tiered";
import { TIER } from "../runs/rec-shared";
import type { StatementLineRow } from "../tables";

const STATEMENT_ID = "STMT-FEB";

function scopeFor(extra: Partial<ImportStatementScope> = {}): ImportStatementScope {
  return {
    clientId: CLIENT_A1,
    bankAccountId: ACCOUNT,
    statementId: STATEMENT_ID,
    sourceFormat: "ofx",
    lines: [
      { statementDate: "2026-01-10", amountCents: "-25000", description: "Card payment", normalizedVendor: null, checkNumber: null },
      { statementDate: "2026-01-12", amountCents: "75000", description: "Deposit", normalizedVendor: null, checkNumber: null },
    ],
    ...extra,
  };
}

test("rec-import-statement: inserts one row per line", async () => {
  const db = recDb();
  const scope = scopeFor();
  const preview = await execute(db, recImportStatement, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, recImportStatement, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const rows = db.all("statement_lines") as StatementLineRow[];
  assertEqual(rows.length, 2, "both lines landed");
  const first = rows.find((l) => l.id === statementLineIdFor(STATEMENT_ID, 0));
  assert(first !== undefined, "the first line exists at its derived id");
  assertEqual(first?.amountCents, BigInt(-25000), "amount carried through");
  assertEqual(first?.matchTier, null, "unmatched on arrival");
});

test("rec-import-statement: the same statement id twice is a no op the second time", async () => {
  const db = recDb();
  const scope = scopeFor();
  const first = await execute(db, recImportStatement, scope, opts("preview"));
  await execute(db, recImportStatement, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, recImportStatement, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(
    second.result.skips.some((s) => s.reason === "already_applied"),
    "reported as already applied",
  );
  assertEqual((db.all("statement_lines") as StatementLineRow[]).length, 2, "nothing duplicated");
});

test("rec-import-statement: an unknown bank account is refused", async () => {
  const db = recDb();
  const scope = scopeFor({ bankAccountId: "BA-DOES-NOT-EXIST" });
  const preview = await execute(db, recImportStatement, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "UNKNOWN_BANK_ACCOUNT"),
    "named error code",
  );
});

test("rec-import-statement: once imported, REC-MATCH-TIERED can reconcile the lines it wrote", async () => {
  const db = recDb();
  // The book's side: one register row matching the first statement line
  // exactly, same account, same day, same cents.
  db.seed("transactions", [
    txn("TX-1", FIRM_A, CLIENT_A1, ACCOUNT, "2026-01-10", BigInt(-25000)),
  ]);

  const scope = scopeFor();
  const importPreview = await execute(db, recImportStatement, scope, opts("preview"));
  await execute(db, recImportStatement, scope, opts("apply", { previewRunId: importPreview.executionId }));

  const matchPreview = await execute(db, recMatchTiered, matchScope(BigInt(50000), { statementId: STATEMENT_ID }), opts("preview"));
  assert(
    matchPreview.status === "completed" || matchPreview.status === "completed_with_skips",
    `status ${matchPreview.status}`,
  );
  await execute(db, recMatchTiered, matchScope(BigInt(50000), { statementId: STATEMENT_ID }), opts("apply", { previewRunId: matchPreview.executionId }));

  const matchedLine = (db.all("statement_lines") as StatementLineRow[]).find(
    (l) => l.id === statementLineIdFor(STATEMENT_ID, 0),
  );
  assertEqual(matchedLine?.matchTier, TIER.exactDate, "tier 1 matched the exact same day amount");
  assertEqual(matchedLine?.matchedTransactionId, "TX-1", "matched to the register row this run never could have reached before");
  assertEqual((db.all("rec_batches")).length, 1, "a batch opened for the statement");
});
