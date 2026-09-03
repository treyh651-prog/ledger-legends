/**
 * Import pipeline tests. Same hand rolled harness, no test runner installed.
 *
 * These are loaded by index.ts, so they run under
 * `npx tsx server/runs/__tests__/index.ts` with everything else.
 *
 * Five things are covered, and each one is a rule from docs/05-decisions.md
 * Part 3 rather than a property of the code:
 *
 *   1. A header row that does not match the stored mapping profile stops the
 *      import. It never guesses a shifted column.
 *   2. A bank supplied unique id that is already in the register is rejected
 *      outright, at parse time and again at commit time, and the store refuses
 *      it a third time even if both runs were wrong.
 *   3. A row with no bank supplied id that matches a posted row on account,
 *      date, amount and normalized description is held for review, not
 *      committed.
 *   4. A committed batch reverses as a unit, and a single reconciled row
 *      blocks the whole reversal.
 *   5. Nothing crosses a tenant boundary in either direction.
 */

import { canonicalJson, toJsonValue } from "../ids";
import { isRowInsert, type Proposal } from "../contract";
import { UniqueViolation } from "../db";
import { MemoryRunDb } from "../db-memory";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import {
  headerFingerprintOf,
  importParseFeed,
  normalizeDescriptor,
  parseOfx,
  PARSE_ERROR_CODES,
  type ParseFeedScope,
} from "../runs/import-parse-feed";
import {
  COMMIT_ERROR_CODES,
  importCommitBatch,
  planBatchReversal,
  registerIdFor,
  type CommitBatchScope,
} from "../runs/import-commit-batch";
import type { ImportBatchRow, StagedRowRow, TransactionRow } from "../tables";
import {
  baseDb,
  CLIENT_A1,
  CLIENT_B1,
  FIRM_A,
  FIRM_B,
  importBatch,
  mappingProfile,
  opts,
  stagedRow,
  txn,
} from "./fixtures";
import { assert, assertEqual, test } from "./harness";

const CSV_HEADER = ["Date", "Description", "Amount"];

const CSV_BODY = [
  "01/12/2026,COFFEE HOUSE #22,-14.75",
  "01/13/2026,ACME SUPPLY CO,-1250.00",
  "01/14/2026,CLIENT DEPOSIT,3000.00",
].join("\n");

function csv(header: readonly string[], body = CSV_BODY): string {
  return `${header.join(",")}\n${body}\n`;
}

const OFX_FEED = `
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260112120000<TRNAMT>-14.75
<FITID>FB-0001<NAME>COFFEE HOUSE #22</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260113<TRNAMT>-1250.00
<FITID>FB-0002<NAME>ACME SUPPLY CO<MEMO>INVOICE 4471</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260114<TRNAMT>3000.00
<FITID>FB-0003<NAME>CLIENT DEPOSIT</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
`;

function parseScope(extra: Partial<ParseFeedScope> = {}): ParseFeedScope {
  return {
    clientId: CLIENT_A1,
    bankAccountId: "BA-A1-OP",
    batchName: "January operating feed",
    institutionName: "First Bank",
    sourceFormat: "csv",
    fileText: csv(CSV_HEADER),
    grid: null,
    sourceDocumentId: null,
    ...extra,
  };
}

function runParse(
  db: MemoryRunDb,
  mode: "preview" | "apply",
  scope: ParseFeedScope,
  extra: Parameters<typeof opts>[1] = {},
) {
  return execute<ParseFeedScope, Proposal>(
    db,
    importParseFeed,
    scope,
    opts(mode, extra),
  );
}

function runCommit(
  db: MemoryRunDb,
  mode: "preview" | "apply",
  scope: CommitBatchScope,
  extra: Parameters<typeof opts>[1] = {},
) {
  return execute<CommitBatchScope, Proposal>(
    db,
    importCommitBatch,
    scope,
    opts(mode, extra),
  );
}

async function parseAndApply(
  db: MemoryRunDb,
  scope: ParseFeedScope,
  extra: Parameters<typeof opts>[1] = {},
) {
  const preview = await runParse(db, "preview", scope, extra);
  const applied = await runParse(db, "apply", scope, {
    ...extra,
    previewRunId: preview.executionId,
  });
  return { preview, applied };
}

async function commitAndApply(
  db: MemoryRunDb,
  scope: CommitBatchScope,
  extra: Parameters<typeof opts>[1] = {},
) {
  const preview = await runCommit(db, "preview", scope, extra);
  const applied = await runCommit(db, "apply", scope, {
    ...extra,
    previewRunId: preview.executionId,
  });
  return { preview, applied };
}

function stagedOf(db: MemoryRunDb): StagedRowRow[] {
  return (db.all("staged_rows") as StagedRowRow[])
    .slice()
    .sort((a, b) => a.rowNumber - b.rowNumber);
}

function batchOf(db: MemoryRunDb): ImportBatchRow {
  const rows = db.all("import_batches") as ImportBatchRow[];
  if (rows.length !== 1) throw new Error(`expected one batch, found ${String(rows.length)}`);
  return rows[0];
}

function seedCsvProfile(db: MemoryRunDb, header: readonly string[]): void {
  db.seed("mapping_profiles", [
    mappingProfile("MP-A1-FIRST", FIRM_A, CLIENT_A1, header),
  ]);
}

// Rule 1. The header fingerprint stops the import instead of guessing.
test("import parse feed refuses a shifted header instead of guessing", async () => {
  const db = baseDb();
  seedCsvProfile(db, CSV_HEADER);

  // Amount and Description swapped. Every value would still parse, which is
  // exactly why this has to be caught on the header and not on the values.
  const shifted = ["Date", "Amount", "Description"];
  const preview = await runParse(
    db,
    "preview",
    parseScope({ fileText: csv(shifted, "01/12/2026,-14.75,COFFEE HOUSE #22") }),
  );

  assertEqual(preview.status, "refused", "the run refused");
  assertEqual(preview.result.proposals.length, 0, "nothing was proposed");
  assertEqual(preview.result.errors.length, 1, "one run level error");
  assertEqual(
    preview.result.errors[0].code,
    PARSE_ERROR_CODES.headerMismatch,
    "the error names the header fingerprint",
  );
  assert(
    preview.result.errors[0].message.includes(
      headerFingerprintOf(shifted),
    ),
    "the error reports the fingerprint that was actually read",
  );
  assert(
    preview.result.errors[0].message.includes("did not guess a shifted column"),
    "the message says what it refused to do",
  );

  // A renamed column is the same refusal, so a bank that relabels one heading
  // does not silently start writing to the wrong field.
  const renamed = await runParse(
    db,
    "preview",
    parseScope({ fileText: csv(["Date", "Memo", "Amount"]) }),
  );
  assertEqual(
    renamed.result.errors[0].code,
    PARSE_ERROR_CODES.headerMismatch,
    "a renamed column is refused too",
  );

  // The control. The stored header parses, and preview equals apply.
  const { preview: good, applied } = await parseAndApply(db, parseScope());
  assertEqual(good.status, "completed", "the matching header parsed");
  assertEqual(
    canonicalJson(toJsonValue(good.result.proposals)),
    canonicalJson(toJsonValue(applied.result.proposals)),
    "preview and apply proposed byte identical sets",
  );
  assertEqual(stagedOf(db).length, 3, "three rows were staged");
  assertEqual(batchOf(db).status, "parsed", "the batch is parsed and ready");
  assertEqual(batchOf(db).netCents, BigInt(173525), "net of the three rows");
  assertEqual(db.all("journal_entries").length, 0, "parsing posted nothing");
});

// There is no PDF path, ever.
test("import parse feed refuses a PDF payload whatever it is named", async () => {
  const db = baseDb();
  seedCsvProfile(db, CSV_HEADER);
  const preview = await runParse(
    db,
    "preview",
    parseScope({ fileText: "%PDF-1.7\n1 0 obj\n" }),
  );
  assertEqual(preview.status, "refused", "the run refused");
  assertEqual(
    preview.result.errors[0].code,
    PARSE_ERROR_CODES.pdfNotSupported,
    "the refusal names PDF",
  );
});

// Rule 2. Dedup on the bank supplied id, in all three places.
test("import dedup rejects a repeated bank supplied id outright", async () => {
  const db = baseDb();
  // FB-0002 is already in the register from an earlier feed.
  db.seed("transactions", [
    txn("TX-EXISTING", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-13", BigInt(-125000), {
      bankTransactionId: "FB-0002",
      description: "ACME SUPPLY CO INVOICE 4471",
      normalizedVendor: "ACME SUPPLY CO INVOICE 4471",
    }),
  ]);

  const parsed = parseOfx(OFX_FEED);
  assertEqual(parsed.length, 3, "the OFX reader found three transactions");
  assertEqual(parsed[1].bankTransactionId, "FB-0002", "FITID became the bank id");
  assertEqual(parsed[1].amountCents, BigInt(-125000), "TRNAMT became signed cents");
  assertEqual(parsed[0].postedOn, "2026-01-12", "DTPOSTED became an ISO date");

  await parseAndApply(
    db,
    parseScope({ sourceFormat: "ofx", fileText: OFX_FEED }),
  );

  const staged = stagedOf(db);
  assertEqual(staged.length, 3, "all three rows were staged for the audit trail");
  assertEqual(
    staged[1].dedupState,
    "rejected_duplicate",
    "the repeated bank id was rejected at parse time",
  );
  assertEqual(
    staged[1].duplicateOfTransactionId,
    "TX-EXISTING",
    "the rejection points at the row it repeats",
  );
  assertEqual(batchOf(db).rejectedCount, 1, "the batch counted one rejection");
  assertEqual(batchOf(db).acceptedCount, 2, "and two acceptable rows");

  // Commit skips it a second time, on its own recheck of the register.
  const { applied } = await commitAndApply(db, {
    clientId: CLIENT_A1,
    batchId: batchOf(db).id,
  });
  const register = db.all("transactions") as TransactionRow[];
  assertEqual(register.length, 3, "two new rows joined the one that existed");
  assert(
    register.filter((r) => r.bankTransactionId === "FB-0002").length === 1,
    "FB-0002 exists exactly once in the register",
  );
  assert(
    applied.result.skips.some(
      (s) =>
        s.reason === "already_applied" &&
        s.detail.includes("rejected at parse time"),
    ),
    "commit skipped the row that parse had already rejected",
  );

  // The commit time recheck, on its own. A staged row that looked clean at
  // parse time is skipped when the same bank id reached the register in
  // between, which is the case a single check at parse time would miss.
  const late = baseDb();
  late.seed("transactions", [
    txn("TX-LATE", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-20", BigInt(-5000), {
      bankTransactionId: "FB-9001",
    }),
  ]);
  late.seed("import_batches", [
    importBatch("IB-LATE", FIRM_A, CLIENT_A1, "BA-A1-OP"),
  ]);
  late.seed("staged_rows", [
    stagedRow("SR-LATE", "IB-LATE", FIRM_A, CLIENT_A1, "BA-A1-OP", 1, "2026-01-20", BigInt(-5000), {
      bankTransactionId: "FB-9001",
    }),
  ]);
  const lateCommit = await commitAndApply(late, {
    clientId: CLIENT_A1,
    batchId: "IB-LATE",
  });
  assertEqual(
    (late.all("transactions") as TransactionRow[]).length,
    1,
    "the late repeat did not reach the register",
  );
  assert(
    lateCommit.applied.result.skips.some(
      (s) => s.reason === "already_applied" && s.detail.includes("FB-9001"),
    ),
    "the commit time recheck named the bank supplied id",
  );

  // And the store refuses it a third time, so a future run cannot get it wrong.
  let threw: unknown = null;
  try {
    await db.tx(
      {
        isolation: "serializable",
        readOnly: false,
        firmId: FIRM_A,
        clientId: CLIENT_A1,
        actorId: "USR-OPERATOR",
        actorKind: "human",
      },
      async (tx) => {
        await tx.insert("transactions", [
          txn("TX-SNEAK", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-13", BigInt(-125000), {
            bankTransactionId: "FB-0002",
          }),
        ]);
      },
    );
  } catch (err) {
    threw = err;
  }
  assert(
    threw instanceof UniqueViolation,
    "the register itself refuses a second row with the same bank id",
  );
});

// Rule 3. No bank supplied id means hold for review, not commit.
test("a probable repeat with no bank id is held for review, not committed", async () => {
  const db = baseDb();
  // The same amount, date, account and normalized descriptor as CSV row two.
  db.seed("transactions", [
    txn("TX-POSTED", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-13", BigInt(-125000), {
      accountNumber: "1010",
      description: "ACME SUPPLY CO",
      normalizedVendor: normalizeDescriptor("ACME SUPPLY CO"),
    }),
  ]);
  seedCsvProfile(db, CSV_HEADER);

  await parseAndApply(db, parseScope());
  const staged = stagedOf(db);
  assertEqual(staged[1].dedupState, "held_for_review", "the probable repeat is held");
  assertEqual(staged[1].reviewState, "pending", "it is waiting on a person");
  assertEqual(
    staged[1].duplicateOfTransactionId,
    "TX-POSTED",
    "the hold names the row it may repeat",
  );
  assertEqual(staged[0].dedupState, "unique", "the other rows are unaffected");
  assertEqual(batchOf(db).heldCount, 1, "the batch counted one hold");
  assertEqual(batchOf(db).status, "in_review", "a held row puts the batch in review");

  const { applied } = await commitAndApply(db, {
    clientId: CLIENT_A1,
    batchId: batchOf(db).id,
  });
  const held = applied.result.skips.filter((s) => s.reason === "ambiguous_candidate");
  assertEqual(held.length, 1, "exactly one row was skipped as ambiguous");
  assertEqual(held[0].rowId, staged[1].id, "and it is the held row");
  const register = db.all("transactions") as TransactionRow[];
  assertEqual(register.length, 3, "one posted row plus the two clean rows");
  assert(
    register.every((r) => r.id !== registerIdFor(batchOf(db).id, 2)),
    "the held row never reached the register",
  );
  const after = stagedOf(db);
  assertEqual(
    after[1].dedupState,
    "held_for_review",
    "the held row is still held after the commit",
  );
  assertEqual(after[0].dedupState, "committed", "the clean rows committed");

  // A reviewer accepts it. Now the same batch commits the one row it held.
  db.seed("mapping_profiles", []);
  await db.tx(
    {
      isolation: "serializable",
      readOnly: false,
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      actorId: "USR-OPERATOR",
      actorKind: "human",
    },
    async (tx) => {
      await tx.update("staged_rows", after[1].id, { reviewState: "accepted" });
      await tx.update("import_batches", batchOf(db).id, { status: "in_review" });
    },
  );
  const second = await commitAndApply(db, {
    clientId: CLIENT_A1,
    batchId: batchOf(db).id,
  });
  assertEqual(
    (db.all("transactions") as TransactionRow[]).length,
    4,
    "the accepted repeat committed on the second pass",
  );
  assert(
    second.applied.result.skips.some((s) => s.reason === "already_applied"),
    "the rows committed on the first pass were skipped as already applied",
  );
});

// Rule 4. Reversal as a unit, blocked by a single reconciled row.
test("a committed batch reverses as a unit and a reconciled row blocks it", async () => {
  const db = baseDb();
  seedCsvProfile(db, CSV_HEADER);
  await parseAndApply(db, parseScope());
  const batchId = batchOf(db).id;
  const { applied } = await commitAndApply(db, { clientId: CLIENT_A1, batchId });

  const inserted = applied.result.proposals
    .filter(isRowInsert)
    .filter((p) => p.table === "transactions");
  assertEqual(inserted.length, 3, "three register rows were proposed");
  assertEqual(batchOf(db).status, "committed", "the batch is committed");
  assertEqual(
    (db.all("transactions") as TransactionRow[]).every(
      (r) => r.importBatchId === batchId && r.source === "import",
    ),
    true,
    "every register row carries the batch and the import source",
  );

  // The plan on its own. Nothing is deleted, every row moves to reversed, and
  // the staged rows and the batch go back to their before values.
  const register = db.all("transactions") as TransactionRow[];
  const planned = planBatchReversal(applied.result.proposals, register);
  assertEqual(planned.blockedBy.length, 0, "nothing blocks the reversal yet");
  const statusWrites = planned.plan.filter(
    (p) => p.kind === "field_write" && p.table === "transactions",
  );
  assertEqual(statusWrites.length, 3, "one status write per register row");
  assert(
    statusWrites.every(
      (p) => p.kind === "field_write" && p.after.status === "reversed",
    ),
    "each register row moves to reversed rather than being deleted",
  );
  assert(
    planned.plan.some(
      (p) =>
        p.kind === "field_write" &&
        p.table === "import_batches" &&
        p.after.status === "parsed",
    ),
    "the batch goes back to parsed",
  );

  // The whole reversal through the undo runner.
  const undone = await executeUndo(
    db,
    importCommitBatch,
    applied.executionId,
    opts("apply"),
  );
  assertEqual(undone.status, "completed", "the undo completed");
  const afterUndo = db.all("transactions") as TransactionRow[];
  assertEqual(afterUndo.length, 3, "no register row was deleted");
  assert(
    afterUndo.every((r) => r.status === "reversed"),
    "every row in the batch is reversed",
  );
  assertEqual(batchOf(db).status, "parsed", "the batch is back to parsed");

  // Now the blocked case. One reconciled row stops the whole reversal, because
  // partial reversal does not exist.
  const reconciled = register.map((r, i) =>
    i === 1 ? { ...r, cleared: true, clearedDate: r.postedDate } : r,
  );
  const blocked = planBatchReversal(applied.result.proposals, reconciled);
  assertEqual(
    blocked.blockedBy,
    [register[1].id],
    "the reconciled row is named as the blocker",
  );

  const db2 = baseDb();
  seedCsvProfile(db2, CSV_HEADER);
  await parseAndApply(db2, parseScope());
  const batch2 = batchOf(db2).id;
  const applied2 = await commitAndApply(db2, {
    clientId: CLIENT_A1,
    batchId: batch2,
  });
  await db2.tx(
    {
      isolation: "serializable",
      readOnly: false,
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      actorId: "USR-OPERATOR",
      actorKind: "human",
    },
    async (tx) => {
      await tx.update("transactions", registerIdFor(batch2, 1), {
        cleared: true,
        clearedDate: "2026-01-12",
      });
    },
  );
  const refused = await executeUndo(
    db2,
    importCommitBatch,
    applied2.applied.executionId,
    opts("apply"),
  );
  assertEqual(refused.status, "failed", "the undo did not complete");
  assert(
    refused.result.errors.some(
      (e) => e.code === COMMIT_ERROR_CODES.reversalBlocked,
    ),
    "and it failed on the reversal block",
  );
  assert(
    refused.result.errors.some((e) => e.message.includes(registerIdFor(batch2, 1))),
    "the failure names the reconciled row",
  );
  assert(
    (db2.all("transactions") as TransactionRow[]).every((r) => r.status === "active"),
    "no row was reversed on the blocked attempt",
  );
});

// Rule 5. Two tenants, nothing crosses.
test("two tenant negative, no import row or batch crosses a boundary", async () => {
  const db = baseDb();
  // Firm B has its own posted row with the same bank supplied id, and its own
  // active profile under the same institution name.
  db.seed("transactions", [
    txn("TX-B1", FIRM_B, CLIENT_B1, "BA-B1-OP", "2026-01-13", BigInt(-125000), {
      bankTransactionId: "FB-0002",
    }),
  ]);
  db.seed("mapping_profiles", [
    mappingProfile("MP-A1-FIRST", FIRM_A, CLIENT_A1, CSV_HEADER),
    mappingProfile("MP-B1-FIRST", FIRM_B, CLIENT_B1, ["Posted", "Detail", "Value"]),
  ]);

  // Firm A parses with firm A's profile. Firm B's profile is invisible, so the
  // firm A header matches and the firm B one is never consulted.
  await parseAndApply(db, parseScope());
  assertEqual(stagedOf(db).length, 3, "firm A staged its own rows");
  assert(
    stagedOf(db).every((r) => r.firmId === FIRM_A && r.clientId === CLIENT_A1),
    "every staged row carries firm A and client A1",
  );
  assert(
    stagedOf(db).every((r) => r.duplicateOfTransactionId === null),
    "firm B's identical bank id did not dedup firm A's rows",
  );

  const batchId = batchOf(db).id;

  // A bank account belonging to another client is refused outright.
  const wrongAccount = await runParse(
    db,
    "preview",
    parseScope({ bankAccountId: "BA-B1-OP", batchName: "cross tenant attempt" }),
  );
  assertEqual(wrongAccount.status, "refused", "the cross tenant account refused");
  assertEqual(
    wrongAccount.result.errors[0].code,
    PARSE_ERROR_CODES.unknownBankAccount,
    "and it refused on the account, before reading a single row",
  );

  // Firm B cannot commit firm A's batch. It does not exist for firm B.
  const foreign = await runCommit(
    db,
    "preview",
    { clientId: CLIENT_B1, batchId },
    { firmId: FIRM_B, clientId: CLIENT_B1 },
  );
  assertEqual(foreign.status, "refused", "the foreign commit refused");
  assertEqual(
    foreign.result.errors[0].code,
    COMMIT_ERROR_CODES.unknownBatch,
    "firm B cannot see firm A's batch at all",
  );

  // Firm A commits its own batch, and firm B's register is untouched.
  await commitAndApply(db, { clientId: CLIENT_A1, batchId });
  const firmB = (db.all("transactions") as TransactionRow[]).filter(
    (r) => r.firmId === FIRM_B,
  );
  assertEqual(firmB.length, 1, "firm B still has exactly its one row");
  assertEqual(firmB[0].id, "TX-B1", "and it is the row it started with");
  assert(
    (db.all("staged_rows") as StagedRowRow[]).every((r) => r.firmId === FIRM_A),
    "no staged row was created for firm B",
  );
  const seeded = importBatch("IB-UNUSED", FIRM_B, CLIENT_B1, "BA-B1-OP");
  assertEqual(seeded.firmId, FIRM_B, "the batch fixture carries its own tenant");
  const seededRow = stagedRow(
    "SR-UNUSED",
    "IB-UNUSED",
    FIRM_B,
    CLIENT_B1,
    "BA-B1-OP",
    1,
    "2026-01-13",
    BigInt(-125000),
  );
  assertEqual(seededRow.clientId, CLIENT_B1, "so does the staged row fixture");
});
