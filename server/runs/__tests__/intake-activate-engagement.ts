/**
 * INTAKE-ACTIVATE-ENGAGEMENT. A draft engagement goes active only with a
 * signed letter behind it, in the system or recorded as signed outside it.
 */

import { assert, assertEqual, test } from "./harness";
import { isFieldWrite, isRowInsert } from "../contract";
import { FIRM_A } from "./fixtures";
import { applyIntake, intakeDb, previewIntake, shapeOf } from "./intake-fixtures";
import { engagementIdOf, uuidFrom } from "../runs/intake-create-client";
import {
  ERR_ENGAGEMENT_NOT_DRAFT,
  ERR_LETTER_NOT_SIGNED,
  NOT_CONFIGURED,
  intakeActivateEngagement,
  letterDocumentIdOf,
} from "../runs/intake-activate-engagement";
import type { EngagementRow } from "../tables";

const CLIENT = uuidFrom("activate/client");
const ENGAGEMENT = engagementIdOf(CLIENT);

function draftEngagement(over: Partial<EngagementRow> = {}): EngagementRow {
  return {
    id: ENGAGEMENT,
    firmId: FIRM_A,
    clientId: CLIENT,
    name: "Test engagement",
    status: "draft",
    serviceLevel: "essentials",
    reportingBasis: "accrual",
    scope: { keys: [] },
    startDate: "2026-07-01",
    endDate: null,
    letterDocumentId: null,
    signedAt: null,
    terminatedAt: null,
    terminationReason: null,
    offboardingExportDays: 15,
    createdAt: "2026-07-01T00:00:00.000Z",
    createdBy: "USR-OPERATOR",
    ...over,
  };
}

test("activate engagement, refuses when no letter was signed anywhere", async () => {
  const db = intakeDb();
  db.seed("engagements", [draftEngagement()]);
  const out = await previewIntake(db, intakeActivateEngagement, { clientId: CLIENT, engagementId: ENGAGEMENT }, { clientId: CLIENT });
  assertEqual(out.status, "refused", "the run refused");
  assert(out.result.errors.some((e) => e.code === ERR_LETTER_NOT_SIGNED), "named the missing letter");
  assertEqual(db.all("engagements")[0].status, "draft", "nothing written");
});

test("activate engagement, a letter signed in the system flips status only", async () => {
  const db = intakeDb();
  db.seed("engagements", [draftEngagement({ status: "signed", letterDocumentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", signedAt: "2026-07-02T10:00:00.000Z" })]);
  const { preview, applied } = await applyIntake(db, intakeActivateEngagement, { clientId: CLIENT, engagementId: ENGAGEMENT }, { clientId: CLIENT });
  assertEqual(shapeOf(applied.result.proposals), shapeOf(preview.result.proposals), "apply proposed what preview showed");
  assertEqual(applied.status, "completed", "applied");
  assertEqual(applied.result.proposals.filter(isRowInsert).length, 0, "no vault row needed");
  const row = db.all("engagements")[0];
  assertEqual(row.status, "active", "active");
  assertEqual(row.letterDocumentId, "01ARZ3NDEKTSV4RRFFQ69G5FAV", "the existing letter kept");
  assertEqual(db.all("vault_documents").length, 0, "no document written");
});

test("activate engagement, signed outside the system records a pending letter document", async () => {
  const db = intakeDb();
  db.seed("engagements", [draftEngagement()]);
  const scope = { clientId: CLIENT, engagementId: ENGAGEMENT, signedOutside: { signerName: "Dana Owner", signedOn: "2026-07-03" } };
  const { preview, applied } = await applyIntake(db, intakeActivateEngagement, scope, { clientId: CLIENT });
  assertEqual(shapeOf(applied.result.proposals), shapeOf(preview.result.proposals), "deterministic across preview and apply");
  assertEqual(applied.status, "completed", "applied");
  assertEqual(applied.result.proposals.filter(isRowInsert).length, 1, "one vault document");
  assertEqual(applied.result.proposals.filter(isFieldWrite).length, 1, "one engagement write");
  const row = db.all("engagements")[0];
  assertEqual(row.status, "active", "active");
  assertEqual(row.letterDocumentId, letterDocumentIdOf(ENGAGEMENT), "points at the recorded letter");
  assertEqual(row.signedAt, "2026-07-03T00:00:00.000Z", "signed on the paper's day");
  const doc = db.all("vault_documents")[0];
  assertEqual(doc.id.length, 26, "a 26 character vault id");
  assertEqual(doc.docType, "engagement_letter", "an engagement letter");
  assertEqual(doc.status, "pending", "no object stored yet");
  assertEqual(doc.objectLockMode, "GOVERNANCE", "retention mode set, as doc_retention_for_sensitive asks");
  assertEqual(doc.bucket, NOT_CONFIGURED, "storage not configured is said plainly");
  assert(doc.title.includes("Dana Owner"), "the signer is on the record");
});

test("activate engagement, an active engagement is refused rather than rewritten", async () => {
  const db = intakeDb();
  db.seed("engagements", [draftEngagement({ status: "active", letterDocumentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", signedAt: "2026-07-02T10:00:00.000Z" })]);
  const out = await previewIntake(db, intakeActivateEngagement, { clientId: CLIENT, engagementId: ENGAGEMENT }, { clientId: CLIENT });
  assertEqual(out.status, "refused", "refused");
  assert(out.result.errors.some((e) => e.code === ERR_ENGAGEMENT_NOT_DRAFT), "named the status");
});
