/**
 * PRAC-NUDGE-REQUESTS tests.
 *
 * The run schedules the next look at an open document request and writes an
 * audit row. It sends nothing, and the test that proves it sends nothing lives
 * in compliance-tests.ts. What is asserted here is the schedule: which requests
 * are in play, which check number a given age has reached, when the next one
 * falls, and what happens once the written schedule runs out.
 */

import { assert, assertEqual, test } from "./harness";
import { isFieldWrite, isRowInsert } from "../contract";
import {
  CLIENT_A1,
  PERIOD,
  applyPractice,
  clientRequest,
  lockJanuary,
  nudgeRow,
  nudgesOf,
  practiceDb,
  practiceScope,
  practiceState,
  previewPractice,
  shapeOf,
} from "./prc-fixtures";
import {
  escalationWindowFor,
  nudgeIdOf,
  prcNudgeRequests,
} from "../runs/prc-nudge-requests";
import { nudgeDaysFor } from "../runs/prc-shared";

const AS_OF = "2026-02-20";
const REQ = "REQ-BANK-STMT";

function nudgeScope(extra: Partial<{ asOfDate: string; period: string }> = {}) {
  return { clientId: CLIENT_A1, period: PERIOD, asOfDate: AS_OF, ...extra };
}

/** Seed one client owned request opened on a chosen day. */
function seedRequest(
  db: ReturnType<typeof practiceDb>,
  openedOn: string,
  extra: Parameters<typeof clientRequest>[3] = {},
) {
  db.seed("document_requests", [clientRequest(REQ, "bank:1010", openedOn, extra)]);
  return db;
}

function requestRow(db: ReturnType<typeof practiceDb>) {
  return db.all("document_requests").find((r) => r.id === REQ);
}

test("preview and apply propose the same rows", async () => {
  const db = seedRequest(practiceDb(), "2026-02-16");
  const { preview, applied } = await applyPractice(db, prcNudgeRequests, nudgeScope());
  assertEqual(
    shapeOf(preview.result?.proposals ?? []),
    shapeOf(applied.result?.proposals ?? []),
    "the schedule is the same on both passes",
  );
  assertEqual(nudgesOf(db).length, 1, "one check was recorded");
});

test("ids are derived, so a rerun is a no operation", async () => {
  const db = seedRequest(practiceDb(), "2026-02-16");
  await applyPractice(db, prcNudgeRequests, nudgeScope());
  const again = await previewPractice(db, prcNudgeRequests, nudgeScope());
  assertEqual((again.result?.proposals ?? []).length, 0, "nothing was scheduled twice");
  assert(
    (again.result?.skips ?? []).some((s) => s.detail.includes("already recorded")),
    "the run says the check is already on the record",
  );
  assertEqual(nudgesOf(db).length, 1, "and no duplicate row appeared");
});

test("the nudge id is derived from the client, the request, and the number", async () => {
  const db = seedRequest(practiceDb(), "2026-02-16");
  await applyPractice(db, prcNudgeRequests, nudgeScope());
  assertEqual(
    nudgesOf(db)[0].id,
    nudgeIdOf(CLIENT_A1, REQ, 1),
    "the row sits at the derived id",
  );
  assert(
    nudgeIdOf(CLIENT_A1, REQ, 1) !== nudgeIdOf(CLIENT_A1, REQ, 2),
    "and the second check is a different row rather than a rewrite of the first",
  );
});

test("two periods do not collide because the period is in the scope hash", async () => {
  const db = seedRequest(practiceDb(), "2026-02-16");
  const a = await previewPractice(db, prcNudgeRequests, nudgeScope());
  const b = await previewPractice(db, prcNudgeRequests, nudgeScope({ period: "2026-02-01" }));
  assert(a.scopeHash !== b.scopeHash, "January and February are different scopes");
});

test("an overridden request is never touched", async () => {
  const db = seedRequest(practiceDb(), "2026-02-16", { manualOverride: true });
  const out = await previewPractice(db, prcNudgeRequests, nudgeScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was proposed");
  assert(
    (out.result?.skips ?? []).some((s) => s.reason === "manual_override"),
    "the run reports the override",
  );
});

test("a locked period does not stop a check on an open request", async () => {
  const db = seedRequest(practiceDb(), "2026-02-16");
  lockJanuary(db);
  const { applied } = await applyPractice(db, prcNudgeRequests, nudgeScope());
  assertEqual(nudgesOf(db).length, 1, "the check was scheduled anyway");
  assert(
    (applied.result?.skips ?? []).every((s) => s.reason !== "locked_period"),
    "and no skip blamed the lock, because no ledger row was written",
  );
});

test("a paused client is not chased", async () => {
  const db = seedRequest(practiceDb(), "2026-02-16");
  db.seed("practice_states", [practiceState({ nudgesPaused: true })]);
  const out = await previewPractice(db, prcNudgeRequests, nudgeScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was scheduled");
  assertEqual(
    (out.result?.skips ?? [])[0].detail,
    "nudges_paused for this client, so nothing was checked",
    "and the skip names the pause",
  );
  const paused = seedRequest(practiceDb(), "2026-02-16");
  paused.seed("practice_states", [practiceState({ engagementPaused: true })]);
  const second = await previewPractice(paused, prcNudgeRequests, nudgeScope());
  assertEqual(
    (second.result?.proposals ?? []).length,
    0,
    "and a paused engagement is not chased either",
  );
});

test("a request too new for the first check is left alone", async () => {
  const db = seedRequest(practiceDb(), "2026-02-19");
  const out = await previewPractice(db, prcNudgeRequests, nudgeScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was scheduled");
  assert(
    (out.result?.skips ?? []).some((s) => s.detail.includes("is not due until day 3")),
    "and the skip says which day the first check falls on",
  );
});

test("the check number follows the age against the escalation window", async () => {
  const first = seedRequest(practiceDb(), "2026-02-16");
  await applyPractice(first, prcNudgeRequests, nudgeScope());
  assertEqual(nudgesOf(first)[0].nudgeNumber, 1, "four days in is the first check");

  const second = seedRequest(practiceDb(), "2026-02-12");
  await applyPractice(second, prcNudgeRequests, nudgeScope());
  assertEqual(nudgesOf(second)[0].nudgeNumber, 2, "eight days in is the second");

  const third = seedRequest(practiceDb(), "2026-02-01");
  await applyPractice(third, prcNudgeRequests, nudgeScope());
  assertEqual(nudgesOf(third)[0].nudgeNumber, 3, "nineteen days in is the third");
});

test("the next check date is the next scheduled day, shifted off a weekend", async () => {
  const db = seedRequest(practiceDb(), "2026-02-16");
  await applyPractice(db, prcNudgeRequests, nudgeScope());
  // Opened Monday 2026-02-16 plus the seven day window is Monday 2026-02-23.
  assertEqual(nudgesOf(db)[0].nextCheckOn, "2026-02-23", "the second check is dated");
  assertEqual(
    JSON.stringify(nudgeDaysFor(escalationWindowFor(clientRequest(REQ, "k", "2026-02-16")))),
    JSON.stringify([3, 7, 14]),
    "and the schedule behind it is half the window, the window, then a tail",
  );
});

test("once the written schedule is exhausted the action becomes a call task", async () => {
  const db = seedRequest(practiceDb(), "2026-02-01");
  await applyPractice(db, prcNudgeRequests, nudgeScope());
  const row = nudgesOf(db)[0];
  assertEqual(row.action, "call_task", "the run stops writing and asks for a call");
  assert(
    row.detail.includes("engagement lead"),
    "and the row says who the call task goes to",
  );
});

test("an escalated request measures against its own window", async () => {
  const db = seedRequest(practiceDb(), "2026-02-12", { escalation: "final" });
  const out = await previewPractice(db, prcNudgeRequests, nudgeScope());
  const inserted = (out.result?.proposals ?? []).filter(isRowInsert);
  assertEqual(inserted.length, 0, "eight days is below the first check of a thirty day window");
  assertEqual(
    escalationWindowFor(clientRequest(REQ, "k", "2026-02-12", { escalation: "final" })),
    30,
    "the final rung carries the thirty day window",
  );
});

test("a firm owned request is the firm's own homework", async () => {
  const db = seedRequest(practiceDb(), "2026-02-01", { owner: "firm" });
  const out = await previewPractice(db, prcNudgeRequests, nudgeScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "the client is not asked");
  assert(
    (out.result?.skips ?? []).some((s) => s.detail.includes("firm_owned")),
    "and the skip says whose item it is",
  );
});

test("a system owned request clears itself", async () => {
  const db = seedRequest(practiceDb(), "2026-02-01", { owner: "system" });
  const out = await previewPractice(db, prcNudgeRequests, nudgeScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was scheduled");
  assert(
    (out.result?.skips ?? []).some((s) => s.detail.includes("system_owned")),
    "and the skip says why",
  );
});

test("a satisfied or waived request is not chased", async () => {
  const satisfied = seedRequest(practiceDb(), "2026-02-01", { status: "satisfied" });
  const a = await previewPractice(satisfied, prcNudgeRequests, nudgeScope());
  assert(
    (a.result?.skips ?? []).some((s) => s.detail.includes("request_satisfied")),
    "a satisfied request is done",
  );
  const waived = seedRequest(practiceDb(), "2026-02-01", { status: "waived" });
  const b = await previewPractice(waived, prcNudgeRequests, nudgeScope());
  assert(
    (b.result?.skips ?? []).some((s) => s.detail.includes("explicitly_waived")),
    "and a waived one was decided against on purpose",
  );
});

test("a client who just replied is not chased on top of the reply", async () => {
  const db = seedRequest(practiceDb(), "2026-02-01", {
    lastRefreshedOn: "2026-02-19",
    ownerChangedOn: "2026-02-19",
  });
  const out = await previewPractice(db, prcNudgeRequests, nudgeScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was scheduled");
  assert(
    (out.result?.skips ?? []).some((s) => s.detail.includes("recent_client_reply")),
    "and the skip names the reply",
  );
});

test("the audit row lands on the request itself", async () => {
  const db = seedRequest(practiceDb(), "2026-02-16");
  const out = await previewPractice(db, prcNudgeRequests, nudgeScope());
  const moves = (out.result?.proposals ?? []).filter(isFieldWrite);
  assertEqual(moves.length, 1, "one field move, onto the request");
  assertEqual(moves[0].table, "document_requests", "which is the request table");
  await applyPractice(db, prcNudgeRequests, nudgeScope());
  const row = requestRow(db);
  assertEqual(row?.refreshCount, 1, "the request carries its own refresh count");
  assertEqual(row?.lastRefreshedOn, AS_OF, "dated to the day it was looked at");
  assertEqual(row?.agingDays, 4, "with the age recorded alongside it");
});

test("a check already on the record is not written a second time", async () => {
  const db = seedRequest(practiceDb(), "2026-02-16");
  db.seed("request_nudges", [
    nudgeRow(nudgeIdOf(CLIENT_A1, REQ, 1), REQ, 1, { asOfDate: AS_OF }),
  ]);
  const out = await previewPractice(db, prcNudgeRequests, nudgeScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was proposed");
  assertEqual(nudgesOf(db).length, 1, "and the record still holds one check");
});

test("requests are checked oldest first, so the order says something", async () => {
  const db = practiceDb();
  db.seed("document_requests", [
    clientRequest("REQ-NEW", "bank:1010", "2026-02-16"),
    clientRequest("REQ-OLD", "vendor:w9", "2026-02-01"),
  ]);
  const out = await previewPractice(db, prcNudgeRequests, nudgeScope());
  const ids = (out.result?.proposals ?? [])
    .filter(isRowInsert)
    .map((p) => String(p.row.requestId));
  assertEqual(ids[0], "REQ-OLD", "the oldest open item is looked at first");
  assertEqual(ids[1], "REQ-NEW", "and the newer one after it");
});
