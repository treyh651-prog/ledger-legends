/**
 * CFG-DISABLE-RULE-AUTOPOST tests. Turns a promoted rule's privilege off
 * with no threshold check, is a no op the second time, refuses an unknown
 * rule, and undo turns it back on.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, opts } from "./fixtures";
import { codingDb, rule } from "./coding-fixtures";
import { cfgDisableRuleAutopost } from "../runs/cfg-disable-rule-autopost";
import type { RuleRow } from "../tables";

function disableScope(ruleId: string) {
  return { clientId: CLIENT_A1, ruleId };
}

function ruleRow(db: ReturnType<typeof codingDb>, id: string): RuleRow | undefined {
  return (db.all("rules") as RuleRow[]).find((r) => r.id === id);
}

test("cfg-disable-rule-autopost: turns a promoted rule's auto post off", async () => {
  const db = codingDb();
  db.seed("rules", [rule("RULE-1", { autoPostEnabled: true, autoPostEnabledBy: ACTOR })]);

  const preview = await execute(db, cfgDisableRuleAutopost, disableScope("RULE-1"), opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, cfgDisableRuleAutopost, disableScope("RULE-1"), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const r = ruleRow(db, "RULE-1");
  assertEqual(r?.autoPostEnabled, false, "disabled");
  assertEqual(r?.autoPostEnabledBy, null, "approver cleared");
});

test("cfg-disable-rule-autopost: already off is a no op", async () => {
  const db = codingDb();
  db.seed("rules", [rule("RULE-1", { autoPostEnabled: false })]);

  const preview = await execute(db, cfgDisableRuleAutopost, disableScope("RULE-1"), opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(preview.result.skips.some((s) => s.detail === "auto post is already off"), "reported as already off");
});

test("cfg-disable-rule-autopost: an unknown rule is refused", async () => {
  const db = codingDb();

  const preview = await execute(db, cfgDisableRuleAutopost, disableScope("RULE-GHOST"), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === "CFG_DISABLE_AUTOPOST_UNKNOWN_RULE"), "named error code");
});

test("cfg-disable-rule-autopost: undo turns it back on", async () => {
  const db = codingDb();
  db.seed("rules", [rule("RULE-1", { autoPostEnabled: true, autoPostEnabledBy: ACTOR })]);

  const preview = await execute(db, cfgDisableRuleAutopost, disableScope("RULE-1"), opts("preview"));
  const applied = await execute(db, cfgDisableRuleAutopost, disableScope("RULE-1"), opts("apply", { previewRunId: preview.executionId }));

  const undone = await executeUndo(db, cfgDisableRuleAutopost, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");

  const r = ruleRow(db, "RULE-1");
  assertEqual(r?.autoPostEnabled, true, "reverted on");
  assertEqual(r?.autoPostEnabledBy, ACTOR, "approver restored");
});
