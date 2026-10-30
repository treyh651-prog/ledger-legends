/**
 * CFG-CREATE-RULE tests. Creating a brand new rule, every promotion field
 * starting at its zero state, an unknown target category refused, and
 * undo doing nothing since every proposal here is an insert.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, opts } from "./fixtures";
import { codingDb, standardCategories } from "./coding-fixtures";
import { ERR_RULE_UNKNOWN_CATEGORY, cfgCreateRule, type CreateRuleScope } from "../runs/cfg-create-rule";
import type { RuleRow, RuleVersionRow } from "../tables";

function scopeFor(fields: Partial<CreateRuleScope["fields"]> = {}, changeNote = "added for recurring vendor"): CreateRuleScope {
  return {
    clientId: CLIENT_A1,
    changeNote,
    fields: {
      name: "Office supply vendor",
      priority: 500,
      conditions: [{ type: "vendor_equals", value: "STAPLES" }],
      targetCategoryId: "CAT-software",
      targetClassId: null,
      scopeKind: "client",
      effectiveFrom: null,
      effectiveTo: null,
      isActive: true,
      autoPostCeilingCents: BigInt(250000),
      ...fields,
    },
  };
}

function ruleDb() {
  const db = codingDb();
  db.seed("categories", standardCategories());
  return db;
}

async function createAndApply(db: ReturnType<typeof ruleDb>, scope: CreateRuleScope) {
  const preview = await execute(db, cfgCreateRule, scope, opts("preview"));
  const applied = await execute(db, cfgCreateRule, scope, opts("apply", { previewRunId: preview.executionId }));
  return { preview, applied };
}

test("cfg-create-rule: a brand new rule is created with every promotion field at zero", async () => {
  const db = ruleDb();
  const { applied } = await createAndApply(db, scopeFor());
  assertEqual(applied.status, "completed", "apply completed");

  const rows = db.all("rules") as unknown as RuleRow[];
  assertEqual(rows.length, 1, "one rule inserted");
  const row = rows[0];
  assertEqual(row.name, "Office supply vendor", "the named fields landed");
  assertEqual(row.conditionCount, 1, "condition count derived from the conditions array");
  assertEqual(row.version, 1, "a fresh rule starts at version 1");
  assertEqual(row.hitCount, 0, "no hits yet");
  assertEqual(row.acceptedCount, 0, "no acceptances yet");
  assertEqual(row.rejectedCount, 0, "no rejections yet");
  assertEqual(row.autoPostEnabled, false, "auto post is never on at creation");
  assertEqual(row.autoPostEnabledBy, null, "nobody enabled it");

  const versions = (db.all("rule_versions") as unknown as RuleVersionRow[]).filter((v) => v.ruleId === row.id);
  assertEqual(versions.length, 1, "one history row for the creation itself");
  assertEqual(versions[0].changeNote, "added for recurring vendor", "carries the caller's note");
});

test("cfg-create-rule: scopeKind defaults to client when not named", async () => {
  const db = ruleDb();
  const { applied } = await createAndApply(db, scopeFor());
  assertEqual(applied.status, "completed", "apply completed");
  const row = (db.all("rules") as unknown as RuleRow[])[0];
  assertEqual(row.scopeKind, "client", "defaulted to client");
});

test("cfg-create-rule: an unknown target category is refused", async () => {
  const db = ruleDb();
  const preview = await execute(db, cfgCreateRule, scopeFor({ targetCategoryId: "CAT-DOES-NOT-EXIST" }), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_RULE_UNKNOWN_CATEGORY), "named error code");
  assertEqual((db.all("rules") as unknown as RuleRow[]).length, 0, "nothing was created");
});

test("cfg-create-rule: undo does nothing, every proposal here is an insert", async () => {
  const db = ruleDb();
  const { applied } = await createAndApply(db, scopeFor());
  const undone = await executeUndo(db, cfgCreateRule, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "no_op", "nothing to revert");
  assertEqual((db.all("rules") as unknown as RuleRow[]).length, 1, "the rule created by the insert is still there");
});
