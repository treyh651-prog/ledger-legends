/**
 * RPT-RELEASE-NARRATIVE tests. Audit fix, problem 9: a composed narrative
 * reached the client portal with no firm review gate. Chains the real
 * compose run into the real release run.
 */

import { assert, assertEqual, test } from "./harness";
import { applyReport, narrativesOf, reportDb, reportScope } from "./rpt-fixtures";
import { narrativeIdOf, rptComposeNarrative } from "../runs/rpt-compose-narrative";
import { ERR_NARRATIVE_NOT_FOUND, rptReleaseNarrative } from "../runs/rpt-release-narrative";
import { executeUndo } from "../undo";
import { ACTOR, CLIENT_A1, FIRM_A, NOW } from "./fixtures";

const composeScope = { ...reportScope(), audience: "owner" as const, maxSentencesPerSection: 5 };

test("rpt-release-narrative: a composed narrative starts draft and release flips it to released", async () => {
  const db = reportDb();
  await applyReport(db, rptComposeNarrative, composeScope);
  const narrativeId = narrativeIdOf(CLIENT_A1, composeScope.period, composeScope.audience);
  assertEqual(narrativesOf(db)[0].state, "draft", "composes as draft");

  const { applied } = await applyReport(db, rptReleaseNarrative, { clientId: CLIENT_A1, narrativeId });
  assertEqual(applied.status, "completed", "apply completed");
  assertEqual(narrativesOf(db)[0].state, "released", "now released");
});

test("rpt-release-narrative: releasing an already released narrative is a no op", async () => {
  const db = reportDb();
  await applyReport(db, rptComposeNarrative, composeScope);
  const narrativeId = narrativeIdOf(CLIENT_A1, composeScope.period, composeScope.audience);
  await applyReport(db, rptReleaseNarrative, { clientId: CLIENT_A1, narrativeId });
  const { preview } = await applyReport(db, rptReleaseNarrative, { clientId: CLIENT_A1, narrativeId });
  assertEqual(preview.status, "no_op", "no_op");
  assert(preview.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("rpt-release-narrative: an unknown narrative id is refused", async () => {
  const db = reportDb();
  const { preview } = await applyReport(db, rptReleaseNarrative, { clientId: CLIENT_A1, narrativeId: "RUNX-NOPE" });
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_NARRATIVE_NOT_FOUND), "named error code");
});

test("rpt-release-narrative: undo reverts the release", async () => {
  const db = reportDb();
  await applyReport(db, rptComposeNarrative, composeScope);
  const narrativeId = narrativeIdOf(CLIENT_A1, composeScope.period, composeScope.audience);
  const { applied } = await applyReport(db, rptReleaseNarrative, { clientId: CLIENT_A1, narrativeId });

  const undone = await executeUndo(db, rptReleaseNarrative, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");
  assertEqual(narrativesOf(db)[0].state, "draft", "back to draft");
});
