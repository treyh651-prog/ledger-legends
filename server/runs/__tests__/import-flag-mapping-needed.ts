/**
 * IMPORT-FLAG-MAPPING-NEEDED tests. Same hand rolled harness.
 *
 * Three things, each a rule from the run's own header:
 *   1. The first failure opens one row.
 *   2. A second failure on the same account, still open, reopens the same
 *      row rather than inserting a second one.
 *   3. A resolve closes the open row, and a resolve with nothing open to
 *      close is a no op, not an error.
 */

import type { Proposal } from "../contract";
import { execute } from "../execute";
import { MemoryRunDb } from "../db-memory";
import {
  importFlagMappingNeeded,
  mappingExceptionIdFor,
  type FlagMappingNeededScope,
} from "../runs/import-flag-mapping-needed";
import { baseDb, CLIENT_A1, FIRM_A, opts } from "./fixtures";
import { assert, assertEqual, test } from "./harness";
import type { MappingExceptionRow } from "../tables";

function scope(extra: Partial<FlagMappingNeededScope> = {}): FlagMappingNeededScope {
  return {
    clientId: CLIENT_A1,
    bankAccountId: "BA-A1-OP",
    sourceDocumentId: "DOC-0001",
    institutionName: "First Bank",
    sourceFormat: "csv",
    errorCode: "MISSING_MAPPING_PROFILE",
    errorMessage: "no active csv mapping profile for institution First Bank",
    resolved: false,
    ...extra,
  };
}

async function run(
  db: MemoryRunDb,
  mode: "preview" | "apply",
  s: FlagMappingNeededScope,
  extra: Parameters<typeof opts>[1] = {},
) {
  return execute<FlagMappingNeededScope, Proposal>(db, importFlagMappingNeeded, s, opts(mode, extra));
}

async function applyScope(
  db: MemoryRunDb,
  s: FlagMappingNeededScope,
  extra: Parameters<typeof opts>[1] = {},
) {
  const preview = await run(db, "preview", s, extra);
  const applied = await run(db, "apply", s, { ...extra, previewRunId: preview.executionId });
  return { preview, applied };
}

function rowOf(db: MemoryRunDb): MappingExceptionRow {
  const rows = db.all("mapping_exceptions") as MappingExceptionRow[];
  if (rows.length !== 1) throw new Error(`expected one row, found ${String(rows.length)}`);
  return rows[0];
}

test("import flag mapping needed: the first failure opens one row", async () => {
  const db = baseDb();
  const { applied } = await applyScope(db, scope());
  assertEqual(applied.status, "completed", "applied clean");
  assertEqual((db.all("mapping_exceptions") as MappingExceptionRow[]).length, 1, "one row");
  const row = rowOf(db);
  assertEqual(row.id, mappingExceptionIdFor(CLIENT_A1, "BA-A1-OP"), "stable derived id");
  assertEqual(row.status, "open", "open");
  assertEqual(row.errorCode, "MISSING_MAPPING_PROFILE", "error code carried through");
  assertEqual(row.sourceDocumentId, "DOC-0001", "linked to the document");
  assertEqual(row.firmId, FIRM_A, "tenant carried through");
});

test("import flag mapping needed: a second failure reopens the same row rather than a new one", async () => {
  const db = baseDb();
  await applyScope(db, scope());
  const firstId = rowOf(db).id;

  // Same error again: already open with the same content, so this is a no op.
  const repeat = await run(db, "preview", scope());
  assertEqual(repeat.status, "no_op", "already open with the same error");
  assertEqual((db.all("mapping_exceptions") as MappingExceptionRow[]).length, 1, "still one row");

  // A different document, a different error: the same row reopens with it.
  await applyScope(
    db,
    scope({
      sourceDocumentId: "DOC-0002",
      errorCode: "HEADER_FINGERPRINT_MISMATCH",
      errorMessage: "header row does not match mapping profile",
    }),
  );
  assertEqual((db.all("mapping_exceptions") as MappingExceptionRow[]).length, 1, "still one row, not two");
  const row = rowOf(db);
  assertEqual(row.id, firstId, "the same row, reused");
  assertEqual(row.status, "open", "still open");
  assertEqual(row.errorCode, "HEADER_FINGERPRINT_MISMATCH", "the newer error");
  assertEqual(row.sourceDocumentId, "DOC-0002", "the newer document");
});

test("import flag mapping needed: resolve closes it, and a resolve with nothing open is a no op", async () => {
  const db = baseDb();
  await applyScope(db, scope());

  const { applied } = await applyScope(db, scope({ resolved: true }));
  assertEqual(applied.status, "completed", "resolved");
  const row = rowOf(db);
  assertEqual(row.status, "resolved", "closed");
  assert(row.resolvedAt !== null, "resolved at is stamped");
  assert(row.resolvedByRunId !== null, "resolved by is stamped");

  // Resolving again, nothing open, is a no op rather than an error.
  const again = await run(db, "preview", scope({ resolved: true }));
  assertEqual(again.status, "no_op", "nothing open to resolve");
  assertEqual(again.result.errors.length, 0, "not an error");

  // And a fresh failure reopens the now resolved row.
  await applyScope(db, scope({ sourceDocumentId: "DOC-0003" }));
  assertEqual(rowOf(db).status, "open", "reopened");
  assertEqual((db.all("mapping_exceptions") as MappingExceptionRow[]).length, 1, "still the one row");
});

test("import flag mapping needed: two tenant negative, each firm's row stands alone", async () => {
  const db = baseDb();
  await applyScope(db, scope());
  await applyScope(db, scope({ clientId: "CLI-B1", bankAccountId: "BA-B1-OP" }), {
    firmId: "FIRM-B",
    clientId: "CLI-B1",
  });

  const rows = (db.all("mapping_exceptions") as MappingExceptionRow[]).sort((a, b) => (a.firmId < b.firmId ? -1 : 1));
  assertEqual(rows.length, 2, "one row per firm");
  assertEqual(rows[0].firmId, FIRM_A, "firm A's row");
  assertEqual(rows[0].clientId, CLIENT_A1, "under firm A's client");
  assertEqual(rows[1].firmId, "FIRM-B", "firm B's row");
  assertEqual(rows[1].clientId, "CLI-B1", "under firm B's client");

  // Resolving firm A's account never touches firm B's open row.
  await applyScope(db, scope({ resolved: true }));
  const after = (db.all("mapping_exceptions") as MappingExceptionRow[]).sort((a, b) => (a.firmId < b.firmId ? -1 : 1));
  assertEqual(after[0].status, "resolved", "firm A's closed");
  assertEqual(after[1].status, "open", "firm B's untouched");
});
