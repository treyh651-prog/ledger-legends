/**
 * IMPORT-REJECT-BATCH tests. Same hand rolled harness.
 *
 * Covered: a parsed batch rejects with its reason recorded, a batch not
 * waiting on a decision is reported rather than rewritten, undo puts it
 * back, and rejecting never touches the register.
 */

import type { Proposal } from "../contract";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { MemoryRunDb } from "../db-memory";
import {
  importRejectBatch,
  REJECT_ERROR_CODES,
  type RejectBatchScope,
} from "../runs/import-reject-batch";
import type { ImportBatchRow, TransactionRow } from "../tables";
import { baseDb, CLIENT_A1, FIRM_A, importBatch, opts } from "./fixtures";
import { assert, assertEqual, test } from "./harness";

function scope(batchId: string, reason = "wrong account, this is the savings statement"): RejectBatchScope {
  return { clientId: CLIENT_A1, batchId, reason };
}

async function reject(db: MemoryRunDb, s: RejectBatchScope) {
  const preview = await execute<RejectBatchScope, Proposal>(db, importRejectBatch, s, opts("preview"));
  const applied = await execute<RejectBatchScope, Proposal>(db, importRejectBatch, s, opts("apply", { previewRunId: preview.executionId }));
  return { preview, applied };
}

function batchOf(db: MemoryRunDb, id: string): ImportBatchRow {
  const row = (db.all("import_batches") as ImportBatchRow[]).find((b) => b.id === id);
  if (!row) throw new Error(`batch ${id} not found`);
  return row;
}

test("import reject batch: a parsed batch rejects with its reason on record", async () => {
  const db = baseDb();
  db.seed("import_batches", [importBatch("IB-REJECT-1", FIRM_A, CLIENT_A1, "BA-A1-OP", { status: "parsed" })]);

  const { applied } = await reject(db, scope("IB-REJECT-1"));
  assertEqual(applied.status, "completed", "applied clean");
  const batch = batchOf(db, "IB-REJECT-1");
  assertEqual(batch.status, "rejected", "rejected");
  assertEqual(batch.rejectReason, "wrong account, this is the savings statement", "reason on record");
});

test("import reject batch: a batch in review rejects the same way", async () => {
  const db = baseDb();
  db.seed("import_batches", [importBatch("IB-REJECT-2", FIRM_A, CLIENT_A1, "BA-A1-OP", { status: "in_review" })]);
  const { applied } = await reject(db, scope("IB-REJECT-2", "a duplicate upload, already staged under a different name"));
  assertEqual(applied.status, "completed", "applied clean");
  assertEqual(batchOf(db, "IB-REJECT-2").status, "rejected", "rejected");
});

test("import reject batch: an unknown batch is refused", async () => {
  const db = baseDb();
  const preview = await execute<RejectBatchScope, Proposal>(db, importRejectBatch, scope("IB-NOWHERE"), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assertEqual(preview.result.errors[0].code, REJECT_ERROR_CODES.unknownBatch, "names the code");
});

test("import reject batch: a batch no longer waiting on a decision is reported, not rewritten", async () => {
  const db = baseDb();
  db.seed("import_batches", [importBatch("IB-REJECT-3", FIRM_A, CLIENT_A1, "BA-A1-OP", { status: "committed" })]);
  const preview = await execute<RejectBatchScope, Proposal>(db, importRejectBatch, scope("IB-REJECT-3"), opts("preview"));
  assertEqual(preview.status, "no_op", "already decided");
  assert(
    preview.result.skips.some((s) => s.reason === "already_applied"),
    "reported as already applied",
  );
  assertEqual(batchOf(db, "IB-REJECT-3").status, "committed", "left exactly as it was");
});

test("import reject batch: undo puts the batch back, and nothing in the register ever moved", async () => {
  const db = baseDb();
  db.seed("import_batches", [importBatch("IB-REJECT-4", FIRM_A, CLIENT_A1, "BA-A1-OP", { status: "parsed" })]);
  const { applied } = await reject(db, scope("IB-REJECT-4"));
  assertEqual(batchOf(db, "IB-REJECT-4").status, "rejected", "rejected");

  const undone = await executeUndo(db, importRejectBatch, applied.executionId, opts("apply"));
  assertEqual(undone.status, "completed", "undo completed");
  assertEqual(batchOf(db, "IB-REJECT-4").status, "parsed", "back to parsed");
  assertEqual(batchOf(db, "IB-REJECT-4").rejectReason, null, "reason cleared with it");
  assertEqual((db.all("transactions") as TransactionRow[]).length, 0, "the register was never touched, there was nothing to undo there");
});

test("import reject batch: two tenant negative, firm B cannot reject firm A's batch", async () => {
  const db = baseDb();
  db.seed("import_batches", [importBatch("IB-REJECT-5", FIRM_A, CLIENT_A1, "BA-A1-OP", { status: "parsed" })]);
  const foreign = await execute<RejectBatchScope, Proposal>(
    db,
    importRejectBatch,
    { clientId: "CLI-B1", batchId: "IB-REJECT-5", reason: "an attempt from the wrong firm" },
    opts("preview", { firmId: "FIRM-B", clientId: "CLI-B1" }),
  );
  assertEqual(foreign.status, "refused", "refused");
  assertEqual(foreign.result.errors[0].code, REJECT_ERROR_CODES.unknownBatch, "firm B cannot see firm A's batch at all");
  assertEqual(batchOf(db, "IB-REJECT-5").status, "parsed", "untouched");
});
