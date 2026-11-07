/**
 * RPT-RELEASE-PACKAGE tests. Audit fix, problem 9: a package reached the
 * client portal the instant it was built, with no firm review gate. These
 * tests chain the real build run into the real release run, the same
 * "prove the writer and the reader agree" idiom close-override-gate.ts's
 * own tests use.
 */

import { assert, assertEqual, test } from "./harness";
import { applyReport, packagesOf, reportDb, reportScope } from "./rpt-fixtures";
import { seedEntry } from "./close-fixtures";
import { packageIdOf, rptBuildPackage } from "../runs/rpt-build-package";
import { ERR_PACKAGE_NOT_FOUND, rptReleasePackage } from "../runs/rpt-release-package";
import { executeUndo } from "../undo";
import { ACTOR, CLIENT_A1, FIRM_A, NOW } from "./fixtures";

const buildScope = { ...reportScope(), comparisonBasis: "prior_period" as const, reportBasis: "accrual" as const };

test("rpt-release-package: a built package starts draft and release flips it to released", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, buildScope);
  const packageId = packageIdOf(CLIENT_A1, buildScope.period, buildScope.comparisonBasis, buildScope.reportBasis);
  assertEqual(packagesOf(db)[0].state, "draft", "builds as draft");

  const { applied } = await applyReport(db, rptReleasePackage, { clientId: CLIENT_A1, packageId });
  assertEqual(applied.status, "completed", "apply completed");
  assertEqual(packagesOf(db)[0].state, "released", "now released");
});

test("rpt-release-package: releasing an already released package is a no op", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, buildScope);
  const packageId = packageIdOf(CLIENT_A1, buildScope.period, buildScope.comparisonBasis, buildScope.reportBasis);
  await applyReport(db, rptReleasePackage, { clientId: CLIENT_A1, packageId });
  const { preview } = await applyReport(db, rptReleasePackage, { clientId: CLIENT_A1, packageId });
  assertEqual(preview.status, "no_op", "no_op");
  assert(preview.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("rpt-release-package: an unknown package id is refused", async () => {
  const db = reportDb();
  const { preview } = await applyReport(db, rptReleasePackage, { clientId: CLIENT_A1, packageId: "RUNX-NOPE" });
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_PACKAGE_NOT_FOUND), "named error code");
});

test("rpt-release-package: rebuilding a released package pulls it back to draft", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, buildScope);
  const packageId = packageIdOf(CLIENT_A1, buildScope.period, buildScope.comparisonBasis, buildScope.reportBasis);
  await applyReport(db, rptReleasePackage, { clientId: CLIENT_A1, packageId });
  assertEqual(packagesOf(db)[0].state, "released", "released");

  // A real posting changes the ledger fingerprint, which rpt-build-package.ts's
  // own resolveScope() folds into the scope hash specifically so a rebuild
  // after a posting is never deduplicated as the identical request. Without
  // a real content change, a second apply with the same scope would just
  // deduplicate against the first -- not what this test is proving.
  seedEntry(db, "JE-LATE", "2026-01-25", [
    ["6100", BigInt(5000)],
    ["1010", BigInt(-5000)],
  ]);
  const { applied } = await applyReport(db, rptBuildPackage, buildScope);
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    `the rebuild is a real write, not a no op or a deduplication: got ${applied.status}`,
  );
  assertEqual(packagesOf(db)[0].state, "draft", "a rebuild pulls it back to draft until released again");
});

test("rpt-release-package: undo reverts the release", async () => {
  const db = reportDb();
  await applyReport(db, rptBuildPackage, buildScope);
  const packageId = packageIdOf(CLIENT_A1, buildScope.period, buildScope.comparisonBasis, buildScope.reportBasis);
  const { applied } = await applyReport(db, rptReleasePackage, { clientId: CLIENT_A1, packageId });

  const undone = await executeUndo(db, rptReleasePackage, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");
  assertEqual(packagesOf(db)[0].state, "draft", "back to draft");
});
