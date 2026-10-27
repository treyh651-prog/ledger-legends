/**
 * ENG-SET-BILLING-STATUS. A firm set flag, not a billing subsystem: no
 * amounts, no invoice rows, no payment history. Covered: the flip, the no-op
 * when the state already matches, an unknown engagement, and undo reverting
 * the flip, same as any other field write.
 */

import { assert, assertEqual, test } from "./harness";
import { MemoryRunDb } from "../db-memory";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { ACTOR, FIRM_A, CLIENT_A1, NOW, opts } from "./fixtures";
import { ERR_ENGAGEMENT_NOT_FOUND, engSetBillingStatus, type SetBillingStatusScope } from "../runs/eng-set-billing-status";
import type { EngagementRow } from "../tables";

const ENGAGEMENT_ID = "ENG-A1";

function seedEngagement(db: MemoryRunDb, billingStatus: "current" | "past_due" = "current"): void {
  const row: EngagementRow = {
    id: ENGAGEMENT_ID,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    name: "Test engagement",
    status: "active",
    serviceLevel: "ledger",
    reportingBasis: "accrual",
    scope: { keys: [] },
    startDate: "2026-01-01",
    endDate: null,
    letterDocumentId: "DOC-LETTER",
    signedAt: "2026-01-01T00:00:00.000Z",
    terminatedAt: null,
    terminationReason: null,
    offboardingExportDays: 15,
    billingStatus,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: ACTOR,
  };
  db.seed("engagements", [row]);
}

function scopeFor(billingStatus: "current" | "past_due"): SetBillingStatusScope {
  return { clientId: CLIENT_A1, engagementId: ENGAGEMENT_ID, billingStatus };
}

test("eng-set-billing-status: a firm staff member flips the flag and the row reflects it", async () => {
  const db = new MemoryRunDb();
  seedEngagement(db, "current");
  const preview = await execute(db, engSetBillingStatus, scopeFor("past_due"), opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, engSetBillingStatus, scopeFor("past_due"), opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");
  const row = db.all("engagements").find((e) => e.id === ENGAGEMENT_ID) as unknown as EngagementRow;
  assertEqual(row.billingStatus, "past_due", "flag flipped");
});

test("eng-set-billing-status: setting the state it already has is a no op", async () => {
  const db = new MemoryRunDb();
  seedEngagement(db, "current");
  const preview = await execute(db, engSetBillingStatus, scopeFor("current"), opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(
    preview.result.skips.some((s) => s.reason === "already_applied"),
    "reported as already applied",
  );
});

test("eng-set-billing-status: an engagement that is not this client's own is refused", async () => {
  const db = new MemoryRunDb();
  seedEngagement(db, "current");
  const preview = await execute(
    db,
    engSetBillingStatus,
    { clientId: CLIENT_A1, engagementId: "ENG-DOES-NOT-EXIST", billingStatus: "past_due" },
    opts("preview"),
  );
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === ERR_ENGAGEMENT_NOT_FOUND),
    "named error code",
  );
});

test("eng-set-billing-status: undo restores the prior state", async () => {
  const db = new MemoryRunDb();
  seedEngagement(db, "current");
  const preview = await execute(db, engSetBillingStatus, scopeFor("past_due"), opts("preview"));
  const applied = await execute(db, engSetBillingStatus, scopeFor("past_due"), opts("apply", { previewRunId: preview.executionId }));
  const undone = await executeUndo(db, engSetBillingStatus, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");
  const row = db.all("engagements").find((e) => e.id === ENGAGEMENT_ID) as unknown as EngagementRow;
  assertEqual(row.billingStatus, "current", "flag reverted to its prior value");
});
