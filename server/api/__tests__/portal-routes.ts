/**
 * Portal screen routes, docs/11-api.md and NOTES 240 onward. Its own world
 * over the memory port, started after routes.ts has stopped its own, so the
 * two files do not share a server or a client.
 *
 * Order matters inside this file. The engagement is signed while it is still
 * a draft, then activated by hand so the tier gates open, then the requests,
 * messages, documents and Legend reads are exercised.
 */
import { test, assert, assertEqual } from "../../runs/__tests__/harness";
import { DEV_ACTOR, DEV_FIRM_ID } from "../dev-actor";
import { readSession } from "../session";
import { startWorld, call, NEW_CLIENT, type World } from "./routes";
import { ERR_NO_LETTER } from "../../runs/runs/eng-sign-letter";
import { ERR_REQUEST_NOT_OPEN } from "../../runs/runs/portal-answer-request";
import type { DocumentRow } from "../../runs/tables";

let world: World;
let clientId = "";
let engagementId = "";

const LETTER_ID = "01JPORTALLETTER0000000000A";

async function withClient<T>(fn: (tx: Parameters<Parameters<World["db"]["tx"]>[1]>[0]) => Promise<T>): Promise<T> {
  return world.db.tx({ ...readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), readOnly: false }, fn);
}

test("portal api: the world starts and a client exists", async () => {
  world = await startWorld();
  const r = await call(world, "POST", "/api/firm/clients", { body: NEW_CLIENT });
  assertEqual(r.status, 201, "created");
  clientId = r.body.client.id;
  world.setClientFor(clientId);
  const engagements = await withClient((tx) => tx.query("engagements_for_client", { firmId: DEV_FIRM_ID, clientId }));
  engagementId = engagements[0]!.id;
});

test("portal api: sign reports no_letter on a draft engagement without a letter on file", async () => {
  const r = await call(world, "GET", `/api/portal/${clientId}/sign`, { token: "client" });
  assertEqual(r.status, 200, "status");
  assertEqual(r.body.state, "no_letter", "state");
  assertEqual(r.body.engagement.status, "draft", "draft");
  assertEqual(r.body.letter, null, "no letter");
  assertEqual(r.body.signatures.length, 0, "no signatures");
  assertEqual(r.body.signer.email, "client@business.local", "signer prefilled from the actor");
});

test("portal api: signing without a letter is refused by the run with ENG-NO-LETTER", async () => {
  const consent = (await call(world, "GET", `/api/portal/${clientId}/sign`, { token: "client" })).body.consentText;
  const r = await call(world, "POST", `/api/portal/${clientId}/sign`, {
    token: "client",
    body: { signerName: "Client Person", consentText: consent },
  });
  assertEqual(r.status, 200, "status");
  assertEqual(r.body.done, false, "not done");
  assertEqual(r.body.preview.errors[0].code, ERR_NO_LETTER, "error code");
  assertEqual(r.body.applied, null, "nothing applied");
});

test("portal api: the consent text must be the one shown", async () => {
  const r = await call(world, "POST", `/api/portal/${clientId}/sign`, {
    token: "client",
    body: { signerName: "Client Person", consentText: "I agree to whatever" },
  });
  assertEqual(r.status, 400, "status");
  assertEqual(r.body.error.code, "validation_failed", "code");
});

test("portal api: with a letter on file the client signs and the engagement moves to signed", async () => {
  const letter: DocumentRow = {
    id: LETTER_ID,
    firmId: DEV_FIRM_ID,
    clientId,
    docType: "engagement_letter",
    title: "Engagement letter, Acme Studio LLC",
    periodStart: null,
    periodEnd: null,
    status: "uploaded",
    byteSize: 48213,
    contentType: "application/pdf",
    sha256Hex: "a".repeat(64),
    requestId: null,
    uploadedAt: "2026-10-20T15:00:00.000Z",
    createdAt: "2026-10-20T15:00:00.000Z",
  };
  await withClient(async (tx) => {
    await tx.insert("documents", [letter]);
    await tx.update("engagements", engagementId, { status: "sent", letterDocumentId: LETTER_ID } as any);
  });
  const before = await call(world, "GET", `/api/portal/${clientId}/sign`, { token: "client" });
  assertEqual(before.body.state, "ready", "ready to sign");
  assertEqual(before.body.letter.id, LETTER_ID, "letter listed");

  const r = await call(world, "POST", `/api/portal/${clientId}/sign`, {
    token: "client",
    body: { signerName: "Client Person", signerTitle: "Owner", consentText: before.body.consentText },
  });
  assertEqual(r.status, 200, "status");
  assertEqual(r.body.done, true, "done");
  assertEqual(r.body.preview.runType, "ENG-SIGN-LETTER", "run type");
  assertEqual(r.body.applied.status, "completed", "applied");

  const after = await call(world, "GET", `/api/portal/${clientId}/sign`, { token: "client" });
  assertEqual(after.body.state, "signed", "signed");
  assertEqual(after.body.engagement.status, "signed", "engagement status");
  assert(after.body.engagement.signedAt !== null, "signedAt set");
  assertEqual(after.body.signatures.length, 1, "one signature record");
  assertEqual(after.body.signatures[0].signerName, "Client Person", "signer name");
  assertEqual(after.body.signatures[0].documentSha256Hex, "a".repeat(64), "letter hash copied");

  const evidence = await withClient((tx) =>
    tx.query("signature_evidence_for_engagement", { firmId: DEV_FIRM_ID, clientId, engagementId }),
  );
  assertEqual(evidence.length, 1, "evidence row");
  assertEqual(evidence[0]!.signerUserId, "00000000-0000-4000-8000-0000000000c1", "signer user id from the actor");
  assert(evidence[0]!.signerIp.length > 0, "ip recorded");
  assert(evidence[0]!.userAgent.length > 0, "user agent recorded");

  // Migration 0008's sig_signed_needs_consent check refuses a signed row on
  // live Postgres unless consent_event_id points at a real event; the memory
  // store used by this test does not enforce that constraint, so it is
  // asserted here directly rather than relying on a database error to catch it.
  assert(evidence[0]!.consentEventId !== null, "consentEventId is set, not left null");
  const events = world.db.all("signature_events").filter((e) => e.evidenceId === evidence[0]!.id);
  assertEqual(events.length, 1, "one signature event recorded");
  assertEqual(events[0]!.id, evidence[0]!.consentEventId, "evidence points at the event it names");
  assertEqual(events[0]!.eventType, "consent_given", "the event this run can attest to");
  assertEqual(events[0]!.sequenceNumber, 1, "first event in the sequence");
});

test("portal api: signing twice is refused, the engagement is already signed", async () => {
  const consent = (await call(world, "GET", `/api/portal/${clientId}/sign`, { token: "client" })).body.consentText;
  const r = await call(world, "POST", `/api/portal/${clientId}/sign`, {
    token: "client",
    body: { signerName: "Client Person", consentText: consent },
  });
  assertEqual(r.status, 200, "status");
  assertEqual(r.body.done, false, "not done");
  assertEqual(r.body.preview.errors[0].code, "ENG-NOT-SIGNABLE", "code");
});

test("portal api: before activation the gated screens are 403 and signing stays reachable", async () => {
  const r = await call(world, "GET", `/api/portal/${clientId}/requests`, { token: "client" });
  assertEqual(r.status, 403, "requests gated");
  const s = await call(world, "GET", `/api/portal/${clientId}/sign`, { token: "client" });
  assertEqual(s.status, 200, "sign open");
});

test("portal api: once active, requests list open rows with canAnswer and the answer run satisfies one", async () => {
  await withClient((tx) => tx.update("engagements", engagementId, { status: "active" } as any));
  const list = await call(world, "GET", `/api/portal/${clientId}/requests`, { token: "client" });
  assertEqual(list.status, 200, "status");
  assertEqual(list.body.uploadsConfigured, false, "uploads not configured, stated");
  assert(list.body.openCount > 0, "intake opened requests");
  const docRows = list.body.items.filter((i: any) => i.kind === "document");
  assert(docRows.every((i: any) => i.canAnswer === false), "document rows are not answered in words");

  // Intake opens document requests only, so seed one portal request the way
  // the suspense sweep would, and answer it.
  const REQ = "01JPORTALREQUEST000000000A";
  await withClient((tx) =>
    tx.insert("portal_requests", [
      {
        id: REQ,
        firmId: DEV_FIRM_ID,
        clientId,
        transactionId: null,
        reasonCode: "SUS-01",
        detail: "What was the 2026-10-03 charge of 184.20 at Northwind Supply for?",
        status: "open",
        openedOn: "2026-10-05",
        dueOn: "2026-10-12",
        createdByRunId: "RUNX-SEED",
        requestedAt: "2026-10-05T12:00:00.000Z",
        answer: null,
        answeredAt: null,
        answeredBy: null,
      },
    ]),
  );
  const again = await call(world, "GET", `/api/portal/${clientId}/requests`, { token: "client" });
  const row = again.body.items.find((i: any) => i.id === REQ);
  assertEqual(row.canAnswer, true, "portal row is answerable");

  const bad = await call(world, "POST", `/api/portal/${clientId}/requests/answer`, {
    token: "client",
    body: { requestId: REQ, answer: "   " },
  });
  assertEqual(bad.status, 400, "blank answer is 400");

  const r = await call(world, "POST", `/api/portal/${clientId}/requests/answer`, {
    token: "client",
    body: { requestId: REQ, answer: "Printer toner for the studio, split between two jobs." },
  });
  assertEqual(r.status, 200, "status");
  assertEqual(r.body.done, true, "done");
  assertEqual(r.body.preview.runType, "PORTAL-ANSWER-REQUEST", "run type");

  const after = await call(world, "GET", `/api/portal/${clientId}/requests`, { token: "client" });
  const answered = after.body.items.find((i: any) => i.id === REQ);
  assertEqual(answered.status, "satisfied", "satisfied");
  assertEqual(answered.answer, "Printer toner for the studio, split between two jobs.", "answer kept");
  assert(answered.answeredAt !== null, "answeredAt set");
  assertEqual(answered.canAnswer, false, "no longer answerable");

  const twice = await call(world, "POST", `/api/portal/${clientId}/requests/answer`, {
    token: "client",
    body: { requestId: REQ, answer: "Something else" },
  });
  assertEqual(twice.status, 200, "second answer answered");
  assertEqual(twice.body.done, false, "and refused by the run");
  assertEqual(twice.body.preview.errors[0].code, ERR_REQUEST_NOT_OPEN, "code");

  const firmView = await call(world, "GET", `/api/firm/clients/${clientId}/requests`);
  assertEqual(firmView.status, 200, "firm reads the same list");
  assertEqual(firmView.body.items.find((i: any) => i.id === REQ).answer, answered.answer, "firm sees the answer");
});

test("portal api: messages go both directions through one run and email is stated as not configured", async () => {
  const empty = await call(world, "GET", `/api/portal/${clientId}/messages`, { token: "client" });
  assertEqual(empty.status, 200, "status");
  assertEqual(empty.body.items.length, 0, "empty thread");
  assertEqual(empty.body.emailConfigured, false, "email not configured, stated");

  const post = await call(world, "POST", `/api/portal/${clientId}/messages`, {
    token: "client",
    body: { body: "Can you confirm the October close date?" },
  });
  assertEqual(post.status, 200, "client post");
  assertEqual(post.body.preview.runType, "PORTAL-POST-MESSAGE", "run type");

  const reply = await call(world, "POST", `/api/firm/clients/${clientId}/messages`, {
    body: { body: "October closes on the 10th once your two open requests are in." },
  });
  assertEqual(reply.status, 200, "firm reply");

  const client = await call(world, "GET", `/api/portal/${clientId}/messages`, { token: "client" });
  assertEqual(client.body.items.length, 2, "two messages");
  assertEqual(client.body.items[0].authorScope, "client", "first from the client");
  assertEqual(client.body.items[0].mine, true, "mine for the client");
  assertEqual(client.body.items[1].authorScope, "firm", "second from the firm");
  assertEqual(client.body.items[1].mine, false, "not mine for the client");

  const firm = await call(world, "GET", `/api/firm/clients/${clientId}/messages`);
  assertEqual(firm.body.items.length, 2, "firm sees both");
  assertEqual(firm.body.items[1].mine, true, "the reply is the firm owner's");

  // The same words inside the same minute are one message, not two.
  const dup = await call(world, "POST", `/api/portal/${clientId}/messages`, {
    token: "client",
    body: { body: "Can you confirm the October close date?" },
  });
  assertEqual(dup.status, 200, "duplicate post is accepted");
  assertEqual(dup.body.applied.status, "deduplicated", "and deduplicated by the engine");
  const after = await call(world, "GET", `/api/portal/${clientId}/messages`, { token: "client" });
  assertEqual(after.body.items.length, 2, "still two messages");

  // The body may not choose the author side. A client post is a client post.
  const spoof = await call(world, "POST", `/api/portal/${clientId}/messages`, {
    token: "client",
    body: { body: "Posing as the firm", authorScope: "firm" },
  });
  assertEqual(spoof.status, 200, "posted");
  const last = (await call(world, "GET", `/api/portal/${clientId}/messages`, { token: "client" })).body.items.at(-1);
  assertEqual(last.authorScope, "client", "author scope came from the plane");
});

test("portal api: documents list the vault rows and say whether storage is configured", async () => {
  const r = await call(world, "GET", `/api/portal/${clientId}/documents`, { token: "client" });
  assertEqual(r.status, 200, "status");
  assertEqual(r.body.storageConfigured, false, "this world has no store, stated");
  assertEqual(r.body.storageProvider, null, "no provider");
  assertEqual(r.body.items.length, 1, "the engagement letter is the one document");
  assertEqual(r.body.items[0].docType, "engagement_letter", "doc type");
  assert(r.body.openRequests.length > 0, "open document requests are listed");
  assert(r.body.openRequests.every((i: any) => i.kind === "document"), "only document rows");
});

test("portal api: a ledger client is refused the Legend screens with the feature code", async () => {
  for (const p of ["aging", "budget", "forecast", "scenarios", "narrative", "reports", "periods"]) {
    const r = await call(world, "GET", `/api/portal/${clientId}/${p}`, { token: "client" });
    assertEqual(r.status, 403, `${p} is gated`);
  }
});

test("portal api: a legend client reads empty states, never placeholder numbers", async () => {
  await withClient((tx) => tx.update("engagements", engagementId, { serviceLevel: "legend" } as any));
  const aging = await call(world, "GET", `/api/portal/${clientId}/aging`, { token: "client" });
  assertEqual(aging.status, 200, "aging");
  assertEqual(aging.body.asOfDate, null, "no snapshot date");
  assertEqual(aging.body.items.length, 0, "no rows");
  const budget = await call(world, "GET", `/api/portal/${clientId}/budget`, { token: "client" });
  assertEqual(budget.status, 200, "budget");
  assertEqual(budget.body.items.length, 0, "no variances");
  assertEqual(budget.body.budgetLineCount, 0, "no budget lines");
  const forecast = await call(world, "GET", `/api/portal/${clientId}/forecast`, { token: "client" });
  assertEqual(forecast.status, 200, "forecast");
  assertEqual(forecast.body.run, null, "no run");
  assertEqual(forecast.body.weeks.length, 0, "no weeks");
  const narrative = await call(world, "GET", `/api/portal/${clientId}/narrative`, { token: "client" });
  assertEqual(narrative.body.items.length, 0, "no narrative");
  const reports = await call(world, "GET", `/api/portal/${clientId}/reports`, { token: "client" });
  assertEqual(reports.body.items.length, 0, "no packages");
  assertEqual(reports.body.storageConfigured, false, "storage stated");
  const periods = await call(world, "GET", `/api/portal/${clientId}/periods`, { token: "client" });
  assertEqual(periods.status, 200, "periods");
  assertEqual(periods.body.items.length, 0, "no period exists yet, an empty list rather than an invented month");
});

test("portal api: a client still cannot start a firm side run", async () => {
  const r = await call(world, "POST", `/api/firm/clients/${clientId}/runs/TXN-SWEEP-SUSPENSE`, {
    token: "client",
    body: { mode: "preview", scope: {} },
  });
  assert(r.status === 403 || r.status === 404, `refused, got ${r.status}`);
});

test("portal api: the world stops", async () => {
  await world.close();
});
