/**
 * INTAKE-OPEN-REQUESTS tests.
 *
 * The framework invariants, then the four things the opener has to get right:
 * which asks it raises, that the row id is the one SUB-RAISE-REQUESTS derives so
 * an intake ask and a close ask about the same subject are one row rather than
 * two, that an ask already answered is not raised again, and that nothing is
 * ever sent to anybody.
 */

import { assert, assertEqual, test } from "./harness";
import { isFieldWrite, isRowInsert } from "../contract";
import {
  CUTOVER,
  FIRM_A,
  INTAKE_CLIENT,
  NOW,
  PERIOD,
  STANDARD_SUBJECT_KEYS,
  applyIntake,
  intakeDb,
  previewIntake,
  requestsOf,
  requestsScope,
  shapeOf,
} from "./intake-fixtures";
import {
  INTAKE_ESCALATION_DAYS,
  intakeOpenRequests,
  wantedRequests,
} from "../runs/intake-open-requests";
import { requestId } from "../runs/sub-raise-requests";
import { STANDARD_REQUESTS } from "../runs/intake-shared";

test("open requests, preview and apply propose the identical set", async () => {
  const db = intakeDb();
  const { preview, applied } = await applyIntake(db, intakeOpenRequests, requestsScope());
  assertEqual(
    shapeOf(applied.result.proposals),
    shapeOf(preview.result.proposals),
    "apply proposed exactly what preview showed",
  );
});

test("open requests, the six opening asks are raised", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeOpenRequests, requestsScope());
  const subjects = requestsOf(db).map((r) => r.subjectKey);
  for (const expected of STANDARD_SUBJECT_KEYS) {
    assert(subjects.includes(expected), `${expected} was raised`);
  }
  assertEqual(
    subjects.length,
    wantedRequests(requestsScope()).length,
    "and nothing else was",
  );
});

test("open requests, the row id is the one the close machinery would derive", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeOpenRequests, requestsScope());
  for (const row of requestsOf(db)) {
    assertEqual(
      row.id,
      requestId(INTAKE_CLIENT, row.subjectKey),
      `${row.subjectKey} shares its id with SUB-RAISE-REQUESTS`,
    );
  }
});

test("open requests, every ask opens on the supplied day and ages from it", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeOpenRequests, requestsScope());
  assert(INTAKE_ESCALATION_DAYS > 0, "the first rung window is a real number of days");
  for (const row of requestsOf(db)) {
    assertEqual(row.openedOn, CUTOVER, `${row.subjectKey} opened on the cutover`);
    assertEqual(row.asOfDate, CUTOVER, "and is as of that day");
    assertEqual(row.agingDays, 0, "and starts at zero days old");
    assertEqual(row.escalation, "none", "and on the bottom rung");
    assert(row.escalatesOn > CUTOVER, "with a first rung date in the future");
  }
});

test("open requests, every ask is open, owned, and explained", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeOpenRequests, requestsScope());
  for (const row of requestsOf(db)) {
    assertEqual(row.status, "open", `${row.subjectKey} is open`);
    assertEqual(row.periodStart, PERIOD, "against the first period");
    assert(row.owner.length > 0, `${row.subjectKey} has an owner`);
    assert(row.detail.length > 20, `${row.subjectKey} says what is wanted in words`);
    assertEqual(row.refreshCount, 0, "and has never been chased");
    assertEqual(row.clientId, INTAKE_CLIENT, "and belongs to the new client");
    assertEqual(row.firmId, FIRM_A, "at the firm that ran the wizard");
  }
});

test("open requests, nothing is sent and no address is recorded", async () => {
  const db = intakeDb();
  const outcome = await previewIntake(db, intakeOpenRequests, requestsScope());
  assert(outcome.result.proposals.length > 0, "there is something to check");
  for (const p of outcome.result.proposals) {
    assert(isRowInsert(p), "every proposal is a row insert");
    if (!isRowInsert(p)) continue;
    assertEqual(p.table, "document_requests", "into the request table and nowhere else");
    const keys = Object.keys(p.row).map((k) => k.toLowerCase());
    for (const forbidden of ["email", "address", "recipient", "body", "sentat", "queuedat"]) {
      assert(!keys.includes(forbidden), `no ${forbidden} column is written`);
    }
  }
});

test("open requests, the second press is a no operation", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeOpenRequests, requestsScope());
  const count = requestsOf(db).length;
  const again = await previewIntake(db, intakeOpenRequests, requestsScope());
  assertEqual(again.result.proposals.length, 0, "nothing left to raise");
  assertEqual(again.result.skips.length, count, "one skip per subject");
  assert(
    again.result.skips.every((s) => s.reason === "already_applied"),
    "and the reason is that the ask already exists",
  );
  assertEqual(requestsOf(db).length, count, "and no second copy landed");
});

test("open requests, an ask already answered is not reopened", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeOpenRequests, requestsScope());
  const target = requestsOf(db)[0];
  assert(target !== undefined, "there is an ask to satisfy");
  if (target === undefined) return;
  db.seed("document_requests", [
    ...db.all("document_requests").filter((r) => r.id !== target.id),
    { ...target, status: "satisfied" },
  ]);
  const again = await previewIntake(db, intakeOpenRequests, requestsScope());
  assertEqual(again.result.proposals.length, 0, "the satisfied ask was not reopened");
  assertEqual(
    requestsOf(db).find((r) => r.subjectKey === target.subjectKey)?.status,
    "satisfied",
    "and it is still recorded as answered",
  );
});

test("open requests, an overridden request is never touched", async () => {
  const db = intakeDb();
  const subject = STANDARD_REQUESTS[0]?.subjectKey ?? "";
  db.seed("document_requests", [
    {
      id: requestId(INTAKE_CLIENT, subject),
      firmId: FIRM_A,
      clientId: INTAKE_CLIENT,
      version: 1,
      subjectKey: subject,
      catalogCode: "REQ-CUSTOM",
      owner: "firm",
      accountNumber: null,
      periodStart: PERIOD,
      linkedItemId: null,
      detail: "The firm is chasing this one itself.",
      status: "open",
      openedOn: "2026-06-01",
      asOfDate: "2026-06-01",
      agingDays: 0,
      escalatesOn: "2026-06-08",
      escalation: "none",
      ownerChangedOn: null,
      lastRefreshedOn: null,
      refreshCount: 0,
      createdByRunId: null,
      createdAt: NOW.toISOString(),
      manualOverride: true,
    },
  ]);
  const outcome = await previewIntake(db, intakeOpenRequests, requestsScope());
  assert(
    outcome.result.skips.some((s) => s.reason === "manual_override"),
    "the override was reported",
  );
  await applyIntake(db, intakeOpenRequests, requestsScope());
  const row = requestsOf(db).find((r) => r.subjectKey === subject);
  assertEqual(row?.catalogCode, "REQ-CUSTOM", "the code a person set survived");
  assertEqual(row?.openedOn, "2026-06-01", "and so did the day they opened it");
});

test("open requests, a struck subject is not raised", async () => {
  const db = intakeDb();
  await applyIntake(db, intakeOpenRequests, requestsScope({ excludeSubjectKeys: ["w9-owner"] }));
  assert(
    !requestsOf(db).some((r) => r.subjectKey === "w9-owner"),
    "the struck ask was not opened",
  );
  assertEqual(requestsOf(db).length, STANDARD_SUBJECT_KEYS.length - 1, "and the rest were");
});

test("open requests, the run only ever inserts", async () => {
  const db = intakeDb();
  const outcome = await previewIntake(db, intakeOpenRequests, requestsScope());
  assert(
    !outcome.result.proposals.some((p) => isFieldWrite(p)),
    "no existing request is amended by the opener",
  );
});

test("open requests, no detail line tells the client what to file or elect", () => {
  for (const ask of STANDARD_REQUESTS) {
    const lower = ask.detail.toLowerCase();
    for (const forbidden of [
      "you should",
      "you must file",
      "we recommend",
      "we advise",
      "elect to be taxed",
      "tax advice",
    ]) {
      assert(!lower.includes(forbidden), `${ask.subjectKey} gives no advice: ${forbidden}`);
    }
  }
});
