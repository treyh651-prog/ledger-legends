/**
 * CFG-EDIT-CATEGORY tests. The edit itself, the no-op when nothing named
 * actually differs, the version-1 backfill on a category's first edit, a
 * second edit that finds history already there, the not-found refusal, and
 * undo reverting the live row (never the history, which is insert only).
 */

import { assert, assertEqual, test } from "./harness";
import { MemoryRunDb } from "../db-memory";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, opts } from "./fixtures";
import {
  BACKFILL_CHANGE_NOTE,
  ERR_CATEGORY_NOT_FOUND,
  cfgEditCategory,
  type EditCategoryScope,
} from "../runs/cfg-edit-category";
import type { CategoryRow, CategoryVersionRow } from "../tables";

const CATEGORY_ID = "CAT-OFFICE-SUPPLIES";

function seedCategory(db: MemoryRunDb, extra: Partial<CategoryRow> = {}): void {
  const row: CategoryRow = {
    id: CATEGORY_ID,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    name: "Office supplies",
    accountNumber: "6410",
    normalSide: "debit",
    taxTreatment: "deductible",
    class1099: "none",
    requiresReceiptOverCents: null,
    requiresClass: false,
    capitalizeOverCents: null,
    restrictionRelevant: false,
    isActive: true,
    ...extra,
  };
  db.seed("categories", [row]);
}

function scopeFor(fields: EditCategoryScope["fields"], changeNote = "renamed per the partner"): EditCategoryScope {
  return { clientId: CLIENT_A1, categoryId: CATEGORY_ID, changeNote, fields };
}

async function editAndApply(db: MemoryRunDb, scope: EditCategoryScope) {
  const preview = await execute(db, cfgEditCategory, scope, opts("preview"));
  const applied = await execute(db, cfgEditCategory, scope, opts("apply", { previewRunId: preview.executionId }));
  return { preview, applied };
}

function categoryOf(db: MemoryRunDb): CategoryRow {
  return db.all("categories").find((c) => c.id === CATEGORY_ID) as unknown as CategoryRow;
}

function versionsOf(db: MemoryRunDb): CategoryVersionRow[] {
  return (db.all("category_versions") as unknown as CategoryVersionRow[])
    .filter((v) => v.categoryId === CATEGORY_ID)
    .sort((a, b) => a.version - b.version);
}

test("cfg-edit-category: a renamed category is updated and its version bumps", async () => {
  const db = new MemoryRunDb();
  seedCategory(db);
  const { applied } = await editAndApply(db, scopeFor({ name: "Office supplies and software" }));
  assertEqual(applied.status, "completed", "apply completed");
  const row = categoryOf(db);
  assertEqual(row.name, "Office supplies and software", "the name changed");
  assertEqual(row.version, 2, "the version bumped by one");
});

test("cfg-edit-category: the first edit backfills a version 1 snapshot of the row before it", async () => {
  const db = new MemoryRunDb();
  seedCategory(db);
  await editAndApply(db, scopeFor({ taxTreatment: "nondeductible" }));
  const versions = versionsOf(db);
  assertEqual(versions.length, 2, "version 1 backfilled plus the real edit's version 2");
  assertEqual(versions[0].version, 1, "the backfill is version 1");
  assertEqual(versions[0].changeNote, BACKFILL_CHANGE_NOTE, "the backfill names itself as a backfill");
  assertEqual(
    (versions[0].snapshot as unknown as CategoryRow).taxTreatment,
    "deductible",
    "the backfill snapshots the row as it stood before this edit, not after",
  );
  assertEqual(versions[1].version, 2, "the real edit is version 2");
  assertEqual(
    (versions[1].snapshot as unknown as CategoryRow).taxTreatment,
    "nondeductible",
    "the real edit's snapshot carries the new value",
  );
  assertEqual(versions[1].changeNote, "renamed per the partner", "the real edit carries the caller's note");
});

test("cfg-edit-category: a second edit does not redo the backfill", async () => {
  const db = new MemoryRunDb();
  seedCategory(db);
  await editAndApply(db, scopeFor({ taxTreatment: "nondeductible" }));
  await editAndApply(db, scopeFor({ taxTreatment: "personal" }, "corrected again"));
  const versions = versionsOf(db);
  assertEqual(versions.length, 3, "one backfill plus two real edits, never a second backfill");
  assertEqual(versions.filter((v) => v.changeNote === BACKFILL_CHANGE_NOTE).length, 1, "exactly one backfill ever");
});

test("cfg-edit-category: naming the value a category already has is a no op", async () => {
  const db = new MemoryRunDb();
  seedCategory(db);
  const preview = await execute(db, cfgEditCategory, scopeFor({ name: "Office supplies" }), opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(preview.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("cfg-edit-category: a category that is not this client's own is refused", async () => {
  const db = new MemoryRunDb();
  seedCategory(db);
  const preview = await execute(
    db,
    cfgEditCategory,
    { clientId: CLIENT_A1, categoryId: "CAT-DOES-NOT-EXIST", changeNote: "x", fields: { name: "y" } },
    opts("preview"),
  );
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_CATEGORY_NOT_FOUND), "named error code");
});

test("cfg-edit-category: undo restores the prior name and version, history stays", async () => {
  const db = new MemoryRunDb();
  seedCategory(db);
  const { applied } = await editAndApply(db, scopeFor({ name: "Renamed" }));
  const undone = await executeUndo(db, cfgEditCategory, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");
  const row = categoryOf(db);
  assertEqual(row.name, "Office supplies", "the name reverted");
  assertEqual(row.version, 1, "the version reverted too");
  assertEqual(versionsOf(db).length, 2, "the history rows from the edit are not undone");
});
