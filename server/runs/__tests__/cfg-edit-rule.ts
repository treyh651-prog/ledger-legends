/**
 * CFG-EDIT-RULE tests. The edit itself, conditionCount recomputed rather than
 * trusted, the doc 02 Part D promotion reset on any real change, the no-op,
 * the version 1 backfill, the not-found refusal, and undo.
 */

import { assert, assertEqual, test } from "./harness";
import { MemoryRunDb } from "../db-memory";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, opts } from "./fixtures";
import {
  BACKFILL_CHANGE_NOTE,
  ERR_RULE_NOT_FOUND,
  cfgEditRule,
  type EditRuleScope,
} from "../runs/cfg-edit-rule";
import type { RuleRow, RuleVersionRow } from "../tables";

const RULE_ID = "RULE-COFFEE";

function seedRule(db: MemoryRunDb, extra: Partial<RuleRow> = {}): void {
  const row: RuleRow = {
    id: RULE_ID,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    version: 1,
    name: "Coffee house is meals",
    priority: 100,
    conditionCount: 1,
    conditions: [{ type: "vendor_equals", value: "COFFEE HOUSE" }],
    targetCategoryId: "CAT-MEALS",
    targetClassId: null,
    scopeKind: "client",
    effectiveFrom: null,
    effectiveTo: null,
    isActive: true,
    hitCount: 0,
    lastHitAt: null,
    acceptedCount: 30,
    rejectedCount: 0,
    autoPostEnabled: true,
    autoPostEnabledBy: "USR-PARTNER",
    autoPostCeilingCents: BigInt(250000),
    ...extra,
  };
  db.seed("rules", [row]);
}

function scopeFor(fields: EditRuleScope["fields"], changeNote = "tightened the match"): EditRuleScope {
  return { clientId: CLIENT_A1, ruleId: RULE_ID, changeNote, fields };
}

async function editAndApply(db: MemoryRunDb, scope: EditRuleScope) {
  const preview = await execute(db, cfgEditRule, scope, opts("preview"));
  const applied = await execute(db, cfgEditRule, scope, opts("apply", { previewRunId: preview.executionId }));
  return { preview, applied };
}

function ruleOf(db: MemoryRunDb): RuleRow {
  return db.all("rules").find((r) => r.id === RULE_ID) as unknown as RuleRow;
}

function versionsOf(db: MemoryRunDb): RuleVersionRow[] {
  return (db.all("rule_versions") as unknown as RuleVersionRow[])
    .filter((v) => v.ruleId === RULE_ID)
    .sort((a, b) => a.version - b.version);
}

test("cfg-edit-rule: priority changes and the version bumps", async () => {
  const db = new MemoryRunDb();
  seedRule(db);
  const { applied } = await editAndApply(db, scopeFor({ priority: 50 }));
  assertEqual(applied.status, "completed", "apply completed");
  const row = ruleOf(db);
  assertEqual(row.priority, 50, "priority changed");
  assertEqual(row.version, 2, "the version bumped by one");
});

test("cfg-edit-rule: editing conditions recomputes conditionCount rather than trusting the scope", async () => {
  const db = new MemoryRunDb();
  seedRule(db);
  const { applied } = await editAndApply(
    db,
    scopeFor({
      conditions: [
        { type: "vendor_equals", value: "COFFEE HOUSE" },
        { type: "sign", value: "debit" },
      ],
    }),
  );
  assertEqual(applied.status, "completed", "apply completed");
  const row = ruleOf(db);
  assertEqual(row.conditionCount, 2, "conditionCount matches conditions.length, migration 0004's own check");
});

test("cfg-edit-rule: any real change resets the promotion state, doc 02 Part D condition 2", async () => {
  const db = new MemoryRunDb();
  seedRule(db);
  const { applied } = await editAndApply(db, scopeFor({ priority: 50 }));
  assertEqual(applied.status, "completed", "apply completed");
  const row = ruleOf(db);
  assertEqual(row.acceptedCount, 0, "accepted count reset");
  assertEqual(row.rejectedCount, 0, "rejected count reset");
  assertEqual(row.autoPostEnabled, false, "auto post cleared");
  assertEqual(row.autoPostEnabledBy, null, "the stale approver id is cleared too");
});

test("cfg-edit-rule: resubmitting the same conditions array is a no op, not a false change", async () => {
  const db = new MemoryRunDb();
  seedRule(db);
  const preview = await execute(
    db,
    cfgEditRule,
    scopeFor({ conditions: [{ type: "vendor_equals", value: "COFFEE HOUSE" }] }),
    opts("preview"),
  );
  assertEqual(preview.status, "no_op", "no_op, since the array is structurally identical");
  assert(preview.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("cfg-edit-rule: naming the value a rule already has is a no op and the promotion state survives", async () => {
  const db = new MemoryRunDb();
  seedRule(db);
  const preview = await execute(db, cfgEditRule, scopeFor({ priority: 100 }), opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assertEqual(ruleOf(db).acceptedCount, 30, "a no op never touches the promotion counters");
});

test("cfg-edit-rule: the first edit backfills a version 1 snapshot of the row before it", async () => {
  const db = new MemoryRunDb();
  seedRule(db);
  await editAndApply(db, scopeFor({ priority: 50 }));
  const versions = versionsOf(db);
  assertEqual(versions.length, 2, "version 1 backfilled plus the real edit's version 2");
  assertEqual(versions[0].changeNote, BACKFILL_CHANGE_NOTE, "the backfill names itself as a backfill");
  assertEqual(
    (versions[0].snapshot as unknown as RuleRow).priority,
    100,
    "the backfill snapshots the row as it stood before this edit",
  );
});

test("cfg-edit-rule: a rule that is not this client's own is refused", async () => {
  const db = new MemoryRunDb();
  seedRule(db);
  const preview = await execute(
    db,
    cfgEditRule,
    { clientId: CLIENT_A1, ruleId: "RULE-DOES-NOT-EXIST", changeNote: "x", fields: { priority: 1 } },
    opts("preview"),
  );
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_RULE_NOT_FOUND), "named error code");
});

test("cfg-edit-rule: undo restores the prior priority, version, and promotion state", async () => {
  const db = new MemoryRunDb();
  seedRule(db);
  const { applied } = await editAndApply(db, scopeFor({ priority: 50 }));
  const undone = await executeUndo(db, cfgEditRule, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");
  const row = ruleOf(db);
  assertEqual(row.priority, 100, "priority reverted");
  assertEqual(row.version, 1, "version reverted");
  assertEqual(row.acceptedCount, 30, "the promotion state the edit reset is restored too");
  assertEqual(row.autoPostEnabled, true, "auto post is back on");
});
