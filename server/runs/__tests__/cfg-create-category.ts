/**
 * CFG-CREATE-CATEGORY tests. Creating a brand new category, a repeat create
 * for the same name treated as already applied, an account that is not on
 * the client's chart refused, and undo doing nothing since every proposal
 * here is an insert.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, opts } from "./fixtures";
import { codingDb } from "./coding-fixtures";
import {
  ERR_CATEGORY_UNKNOWN_ACCOUNT,
  cfgCreateCategory,
  categoryIdFor,
  type CreateCategoryScope,
} from "../runs/cfg-create-category";
import type { CategoryRow, CategoryVersionRow } from "../tables";

function scopeFor(fields: Partial<CreateCategoryScope["fields"]> = {}, changeNote = "added for job costing"): CreateCategoryScope {
  return {
    clientId: CLIENT_A1,
    changeNote,
    fields: {
      name: "Equipment rental",
      accountNumber: "6100",
      normalSide: "debit",
      taxTreatment: "deductible",
      class1099: "none",
      requiresReceiptOverCents: null,
      requiresClass: false,
      capitalizeOverCents: null,
      restrictionRelevant: false,
      isActive: true,
      ...fields,
    },
  };
}

async function createAndApply(db: ReturnType<typeof codingDb>, scope: CreateCategoryScope) {
  const preview = await execute(db, cfgCreateCategory, scope, opts("preview"));
  const applied = await execute(db, cfgCreateCategory, scope, opts("apply", { previewRunId: preview.executionId }));
  return { preview, applied };
}

test("cfg-create-category: a brand new category is created", async () => {
  const db = codingDb();
  const { applied } = await createAndApply(db, scopeFor());
  assertEqual(applied.status, "completed", "apply completed");

  const id = categoryIdFor(CLIENT_A1, "Equipment rental");
  const row = (db.all("categories") as unknown as CategoryRow[]).find((c) => c.id === id);
  assertEqual(row?.name, "Equipment rental", "the category was inserted");
  assertEqual(row?.accountNumber, "6100", "with the named account");
  assertEqual(row?.version, 1, "a fresh category starts at version 1");

  const versions = (db.all("category_versions") as unknown as CategoryVersionRow[]).filter((v) => v.categoryId === id);
  assertEqual(versions.length, 1, "one history row for the creation itself");
  assertEqual(versions[0].changeNote, "added for job costing", "carries the caller's note");
});

test("cfg-create-category: creating the same name twice is a no op the second time", async () => {
  const db = codingDb();
  await createAndApply(db, scopeFor());
  const preview = await execute(db, cfgCreateCategory, scopeFor(), opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(preview.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("cfg-create-category: an account not on the client's chart is refused", async () => {
  const db = codingDb();
  const preview = await execute(db, cfgCreateCategory, scopeFor({ accountNumber: "9999" }), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_CATEGORY_UNKNOWN_ACCOUNT), "named error code");
  const id = categoryIdFor(CLIENT_A1, "Equipment rental");
  assertEqual((db.all("categories") as unknown as CategoryRow[]).find((c) => c.id === id), undefined, "nothing was created");
});

test("cfg-create-category: undo does nothing, every proposal here is an insert", async () => {
  const db = codingDb();
  const { applied } = await createAndApply(db, scopeFor());
  const undone = await executeUndo(db, cfgCreateCategory, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "no_op", "nothing to revert");
  const id = categoryIdFor(CLIENT_A1, "Equipment rental");
  assert(
    (db.all("categories") as unknown as CategoryRow[]).some((c) => c.id === id),
    "the category created by the insert is still there",
  );
});
