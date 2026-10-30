/**
 * Route tests against the memory port. A real express app on an ephemeral
 * port, the same guards production uses (createActorMiddleware) fed by a
 * verifier that knows three tokens: a firm owner, a client scoped person,
 * and a person with no membership. No database, no secrets, no network
 * beyond the loopback interface.
 */
import express from "express";
import type { AddressInfo } from "net";
import { MemoryRunDb } from "../../runs/db-memory";
import { createApiRouter, RunDbEntitlementSource } from "../router";
import { apiErrorHandler, translate, ApiFailure } from "../errors";
import { createActorMiddleware, authErrorHandler } from "../../auth/middleware";
import type { Actor } from "../../db/with-actor";
import type { ActorStore } from "../../auth/actor-store";
import { TokenError, type TokenVerifier, type VerifiedToken } from "../../auth/jwt";
import { DEV_ACTOR, DEV_FIRM_ID, DEV_USER_ID, devActorEnabled, DevActorRefused } from "../dev-actor";
import { readSession } from "../session";
import { FeatureNotInTierError } from "../../entitlement";
import { LockedPeriodError } from "../../runs/db";
import { ZodError, z } from "zod";
import { assert, assertEqual, test } from "../../runs/__tests__/harness";
import type { createMemoryStorage } from "../../storage/document-storage";
import { headerFingerprintOf } from "../../runs/runs/import-parse-feed";

export type MemoryStorage = ReturnType<typeof createMemoryStorage>;

const CLIENT_USER_ID = "00000000-0000-4000-8000-0000000000c1";
const OTHER_FIRM_ID = "00000000-0000-4000-8000-00000000f1b0";

export interface World {
  db: MemoryRunDb;
  base: string;
  close: () => Promise<void>;
  /** The client the client scoped token belongs to. Set after the first create. */
  setClientFor: (clientId: string) => void;
  /** The memory document store, when the world was started with one. */
  storage: MemoryStorage | null;
}

function buildActors(): { actors: Map<string, Actor>; setClientFor: (id: string) => void } {
  const actors = new Map<string, Actor>();
  actors.set("owner", DEV_ACTOR);
  actors.set("nobody", {
    userId: "00000000-0000-4000-8000-0000000000e1",
    authSubject: "dev|nobody",
    email: "nobody@firm.local",
    displayName: "No Membership",
    memberships: [],
  });
  actors.set("other-firm", {
    userId: "00000000-0000-4000-8000-0000000000d1",
    authSubject: "dev|other",
    email: "other@firm.local",
    displayName: "Other Firm Owner",
    memberships: [{ firmId: OTHER_FIRM_ID, firmSlug: "other", firmName: "Other Firm", clientId: null, scope: "firm", role: "owner" }],
  });
  const setClientFor = (clientId: string) => {
    actors.set("client", {
      userId: CLIENT_USER_ID,
      authSubject: "dev|client",
      email: "client@business.local",
      displayName: "Client Person",
      memberships: [{ firmId: DEV_FIRM_ID, firmSlug: "dev-firm", firmName: "Development Firm", clientId, scope: "client", role: "client_user" }],
    });
  };
  return { actors, setClientFor };
}

export async function startWorld(opts: { storage?: MemoryStorage } = {}): Promise<World> {
  const db = new MemoryRunDb();
  const storage = opts.storage ?? null;
  const { actors, setClientFor } = buildActors();
  const verifier: TokenVerifier = {
    async verify(token: string): Promise<VerifiedToken> {
      const a = actors.get(token);
      if (!a) throw new TokenError("invalid", "unknown test token");
      return { subject: a.authSubject, email: a.email, expiresAt: null, via: "auth-server" };
    },
  };
  const store: ActorStore = {
    async findByAuthSubject(subject) {
      for (const a of actors.values()) if (a.authSubject === subject) return a;
      return null;
    },
    async touchLastSeen() {
      return;
    },
  };
  const middleware = createActorMiddleware({
    verifier,
    store,
    clientFirm: async (clientId) => {
      const rows = await db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, clientId), (tx) => tx.query("client_by_id", { firmId: DEV_FIRM_ID, clientId }));
      return rows[0]?.firmId ?? null;
    },
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createApiRouter({
      db,
      guards: middleware,
      storage,
      entitlements: new RunDbEntitlementSource(db, DEV_USER_ID, DEV_FIRM_ID),
      members: async () => [{ userId: DEV_USER_ID, displayName: "Development Owner", email: "owner@firm.local", role: "owner" }],
    }),
  );
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "No such route." } });
  });
  app.use(authErrorHandler);
  app.use(apiErrorHandler);
  const server = await new Promise<import("http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    db,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    setClientFor,
    storage,
  };
}

export async function call(
  w: World,
  method: "GET" | "POST",
  path: string,
  opts: { token?: string | null; body?: unknown; firm?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? "owner"}`;
  if (opts.firm) headers["x-firm"] = opts.firm;
  const res = await fetch(w.base + path, { method, headers, body: method === "GET" || opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

export const NEW_CLIENT = {
  name: "Acme Studio LLC",
  entityType: "LLC",
  industry: "services",
  startDate: "2026-10-01",
  serviceLevel: "ledger",
};

/* ---------------------------------------------------------------- */

let world: World;
let createdClientId = "";

test("api: the world starts", async () => {
  world = await startWorld();
  assert(world.base.startsWith("http://127.0.0.1:"), "listening on loopback");
});

test("api: auth is required, a missing token is 401 with the one envelope", async () => {
  const r = await call(world, "GET", "/api/firm/overview", { token: null });
  assertEqual(r.status, 401, "status");
  assertEqual(r.body?.error?.code, "auth.missing_token", "code");
  assert(typeof r.body?.error?.message === "string", "message is a string");
});

test("api: an unknown token is 401", async () => {
  const r = await call(world, "GET", "/api/firm/overview", { token: "stranger" });
  assertEqual(r.status, 401, "status");
});

test("api: a person with no membership is refused the firm plane", async () => {
  const r = await call(world, "GET", "/api/firm/overview", { token: "nobody" });
  assertEqual(r.status, 403, "status");
  assert(String(r.body?.error?.code).startsWith("auth."), "an auth code");
});

test("api: firm overview on an empty firm is zero everywhere", async () => {
  const r = await call(world, "GET", "/api/firm/overview");
  assertEqual(r.status, 200, "status");
  assertEqual(r.body.totals.clients, 0, "clients");
  assertEqual(r.body.clients.length, 0, "rows");
  assertEqual(r.body.recentRuns.length, 0, "runs");
});

test("api: client list on an empty firm is an empty page", async () => {
  const r = await call(world, "GET", "/api/firm/clients");
  assertEqual(r.status, 200, "status");
  assertEqual(r.body.items.length, 0, "items");
});

test("api: a bad create body is 400 validation_failed with field details", async () => {
  const r = await call(world, "POST", "/api/firm/clients", { body: { name: "", entityType: "Trust" } });
  assertEqual(r.status, 400, "status");
  assertEqual(r.body.error.code, "validation_failed", "code");
  assert(Array.isArray(r.body.error.details), "details is a list of issues");
});

test("api: create client runs the four intake runs and answers 201", async () => {
  const r = await call(world, "POST", "/api/firm/clients", { body: NEW_CLIENT });
  assertEqual(r.status, 201, "status");
  assertEqual(r.body.complete, true, "complete");
  assertEqual(
    r.body.runs.map((x: any) => `${x.runType}:${x.mode}:${x.status}`).join(" "),
    [
      "INTAKE-CREATE-CLIENT:preview:completed",
      "INTAKE-CREATE-CLIENT:apply:completed",
      "INTAKE-BUILD-CHART:preview:completed",
      "INTAKE-BUILD-CHART:apply:completed",
      "INTAKE-SEED-TASKS:preview:completed_with_skips",
      "INTAKE-SEED-TASKS:apply:completed_with_skips",
      "INTAKE-OPEN-REQUESTS:preview:completed",
      "INTAKE-OPEN-REQUESTS:apply:completed",
    ].join(" "),
    "run outcomes in order",
  );
  assert(r.body.client !== null, "the client row came back");
  assertEqual(r.body.client.name, "Acme Studio LLC", "name");
  assertEqual(r.body.client.status, "onboarding", "a new client is onboarding");
  assertEqual(r.body.client.engagement?.status, "draft", "the engagement is a draft");
  assert(r.body.client.chartAccounts > 0, "the chart was built");
  assert(r.body.client.openRequests > 0, "requests were opened");
  createdClientId = r.body.client.id;
  world.setClientFor(createdClientId);
});

test("api: the overview and list now show the one client", async () => {
  const ov = await call(world, "GET", "/api/firm/overview");
  assertEqual(ov.body.totals.clients, 1, "overview clients");
  assertEqual(ov.body.totals.onboarding, 1, "onboarding");
  assert(ov.body.recentRuns.length >= 8, "recent runs include intake");
  const list = await call(world, "GET", "/api/firm/clients");
  assertEqual(list.body.items.length, 1, "list items");
  assertEqual(list.body.items[0].id, createdClientId, "the id matches");
});

/**
 * Two clients in one database, both charts built. Category ids are the
 * published slug (NOTES 126); migration 0026 keys ledger.categories by
 * (client_id, id) and the memory port keys the table the same way, so the
 * second INTAKE-BUILD-CHART no longer collides with the first.
 */
test("api: a second client builds its own chart alongside the first", async () => {
  const r = await call(world, "POST", "/api/firm/clients", { body: { ...NEW_CLIENT, name: "Second Client Inc" } });
  assertEqual(r.status, 201, "second client created in full");
  assertEqual(r.body.complete, true, "every intake run completed");
  const chart = r.body.runs.find((x: any) => x.runType === "INTAKE-BUILD-CHART" && x.mode === "apply");
  assert(chart && chart.status !== "failed", "the chart run applied");
  const secondId: string = r.body.client.id;
  const categories = world.db.all("categories");
  const first = categories.filter((c) => c.clientId === createdClientId);
  const second = categories.filter((c) => c.clientId === secondId);
  assert(first.length > 0 && second.length > 0, "both clients hold categories");
  assertEqual(first.length, second.length, "the same standard chart for both");
  assert(first.some((c) => second.some((d) => d.id === c.id)), "the same slug ids exist under both clients");
  assertEqual(r.body.client.chartAccounts > 0, true, "the summary counts the second chart");
  // Put the firm back to one client for the reads below.
  await world.db.tx({ ...readSession(DEV_ACTOR, DEV_FIRM_ID, secondId), readOnly: false }, async (tx) => {
    await tx.update("clients", secondId, { archivedAt: "2026-10-23T00:00:00.000Z" } as any);
  });
});

test("api: client detail, transactions, and run log read for the owner", async () => {
  const d = await call(world, "GET", `/api/firm/clients/${createdClientId}`);
  assertEqual(d.status, 200, "detail status");
  assertEqual(d.body.id, createdClientId, "detail id");
  const t = await call(world, "GET", `/api/firm/clients/${createdClientId}/transactions?limit=10`);
  assertEqual(t.status, 200, "transactions status");
  assertEqual(t.body.items.length, 0, "no transactions yet");
  const runs = await call(world, "GET", `/api/firm/clients/${createdClientId}/runs?runType=INTAKE-BUILD-CHART`);
  assertEqual(runs.status, 200, "runs status");
  assertEqual(runs.body.items.length, 2, "one preview and one apply of the chart run");
});

test("api: team, board, and setup read for the owner, and a task moves through PRAC-UPDATE-TASK", async () => {
  const team = await call(world, "GET", "/api/firm/team");
  assertEqual(team.status, 200, "team status");
  assertEqual(team.body.items.length, 1, "one member");
  const board = await call(world, "GET", "/api/firm/tasks?period=2026-10-01");
  assertEqual(board.status, 200, "board status");
  assert(board.body.items.length > 0, "INTAKE-SEED-TASKS left tasks on the board");
  assert(board.body.items.some((t: { clientName: string }) => t.clientName === NEW_CLIENT.name), "the rows name their client");
  const setup = await call(world, "GET", `/api/firm/clients/${createdClientId}/setup`);
  assertEqual(setup.status, 200, "setup status");
  assertEqual(setup.body.bankAccounts.length, 0, "no bank accounts yet");
  assertEqual(setup.body.mappingProfiles.length, 0, "no mapping profiles yet");
  assertEqual(setup.body.uploadsConfigured, false, "uploads are not configured");
  const open = setup.body.tasks.find((t: { state: string }) => t.state === "open");
  assert(open, "the client has an open task");
  const moved = await call(world, "POST", `/api/firm/clients/${createdClientId}/tasks/${open.id}`, { body: { state: "complete" } });
  assertEqual(moved.status, 200, "move status");
  assertEqual(moved.body.done, true, "preview and apply both succeeded");
  const after = await call(world, "GET", "/api/firm/tasks?period=2026-10-01");
  const row = after.body.items.find((t: { id: string }) => t.id === open.id);
  assertEqual(row.state, "complete", "the board reads the move back");
  assertEqual(row.manualOverride, true, "and the row is marked hand touched");
  const bad = await call(world, "POST", `/api/firm/clients/${createdClientId}/tasks/${open.id}`, { body: {} });
  assertEqual(bad.status, 400, "an empty body is a validation failure");
});

test("api: an unknown client is 404 and a non uuid id is 400", async () => {
  const r = await call(world, "GET", "/api/firm/clients/00000000-0000-4000-8000-00000000dead");
  assertEqual(r.status, 404, "unknown uuid");
  const b = await call(world, "GET", "/api/firm/clients/bramble-cafe");
  assert(b.status === 400 || b.status === 404, `mock style id is refused, got ${b.status}`);
});

test("api: scope is enforced, another firm's owner cannot see this client", async () => {
  const r = await call(world, "GET", `/api/firm/clients/${createdClientId}`, { token: "other-firm" });
  assert(r.status === 403 || r.status === 404, `refused, got ${r.status}`);
  const list = await call(world, "GET", "/api/firm/clients", { token: "other-firm" });
  assertEqual(list.status, 200, "their own list answers");
  assertEqual(list.body.items.length, 0, "and it is empty");
});

test("api: scope is enforced, a client scoped person has no firm plane", async () => {
  const r = await call(world, "GET", "/api/firm/overview", { token: "client" });
  assertEqual(r.status, 403, "overview");
  const runs = await call(world, "POST", `/api/firm/clients/${createdClientId}/runs/INTAKE-BUILD-CHART`, { token: "client", body: { mode: "preview" } });
  assertEqual(runs.status, 403, "runs are not a client action");
});

test("api: a client scoped person reads their own portal home", async () => {
  const r = await call(world, "GET", `/api/portal/${createdClientId}/home`, { token: "client" });
  assertEqual(r.status, 200, "status");
  assertEqual(r.body.client.id, createdClientId, "the client");
  assertEqual(r.body.engagementStatus, "draft", "draft engagement");
  assertEqual(r.body.features.length, 0, "a draft grants nothing");
  assert(r.body.openRequests.length > 0, "requests are visible");
});

test("api: feature is enforced, a draft engagement gets 403 feature_not_included on statements", async () => {
  const r = await call(world, "GET", `/api/portal/${createdClientId}/statements`, { token: "client" });
  assertEqual(r.status, 403, "status");
  assertEqual(r.body.error.code, "feature_not_included", "code");
  const t = await call(world, "GET", `/api/portal/${createdClientId}/transactions`);
  assertEqual(t.status, 403, "the owner is held to the same rule in the portal");
});

test("api: once the engagement is active, statements answer and the portal lists features", async () => {
  // Activation goes through INTAKE-ACTIVATE-ENGAGEMENT, the same route the
  // client book's button calls: preview, then apply the preview.
  const [e] = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, createdClientId), (tx) =>
    tx.query("engagements_for_client", { firmId: DEV_FIRM_ID, clientId: createdClientId }),
  );
  const path = `/api/firm/clients/${createdClientId}/runs/INTAKE-ACTIVATE-ENGAGEMENT`;
  const refused = await call(world, "POST", path, { body: { mode: "preview", scope: { engagementId: e.id } } });
  assertEqual(refused.body.status, "refused", "no letter signed anywhere is refused");
  assertEqual(refused.body.errors[0].code, "INTAKE-LETTER-NOT-SIGNED", "named plainly");
  const scope = { engagementId: e.id, signedOutside: { signerName: "Dana Owner", signedOn: "2026-10-01" } };
  const preview = await call(world, "POST", path, { body: { mode: "preview", scope } });
  assertEqual(preview.body.status, "completed", "preview completed");
  const applied = await call(world, "POST", path, { body: { mode: "apply", scope, previewRunId: preview.body.executionId } });
  assertEqual(applied.status, 200, "apply status");
  assertEqual(applied.body.status, "completed", "apply completed");
  const detail = await call(world, "GET", `/api/firm/clients/${createdClientId}`);
  assertEqual(detail.body.engagement.status, "active", "the detail shows it active");
  assertEqual(detail.body.engagement.signedAt, "2026-10-01T00:00:00.000Z", "signed on the paper's day");
  const home = await call(world, "GET", `/api/portal/${createdClientId}/home`, { token: "client" });
  assertEqual(home.status, 200, "home");
  assert(home.body.features.includes("statements"), "ledger includes statements");
  const st = await call(world, "GET", `/api/portal/${createdClientId}/statements`, { token: "client" });
  assertEqual(st.status, 200, "statements status");
  assertEqual(st.body.periodStatus, "none", "no period on a new client");
  assertEqual(st.body.entryCount, 0, "no entries");
  const req = await call(world, "GET", `/api/portal/${createdClientId}/requests`, { token: "client" });
  assertEqual(req.status, 200, "requests");
});

test("api: the screen read models answer for a new client with honest zeros", async () => {
  const base = `/api/firm/clients/${createdClientId}`;
  const close = await call(world, "GET", `${base}/close?period=2026-10-01`);
  assertEqual(close.status, 200, "close");
  assertEqual(close.body.periodStatus, "none", "no period opened");
  assert(Array.isArray(close.body.tasks) && close.body.tasks.length > 0, "the seeded checklist tasks for a period");
  assertEqual(close.body.gates.length, 0, "no gates evaluated yet");
  const rec = await call(world, "GET", `${base}/reconcile?period=2026-10-01`);
  assertEqual(rec.status, 200, "reconcile");
  assertEqual(rec.body.batches.length, 0, "no statements yet");
  assertEqual(rec.body.selectedBatchId, null, "nothing selected");
  const req = await call(world, "GET", `${base}/requests`);
  assertEqual(req.status, 200, "requests");
  assertEqual(req.body.openCount, req.body.items.filter((i: any) => i.status === "open").length, "open count is a filter");
  const st = await call(world, "GET", `${base}/statements?period=2026-10-01`);
  assertEqual(st.status, 200, "firm statements are not tier gated");
  assertEqual(st.body.entryCount, 0, "no entries");
  const tb = await call(world, "GET", `${base}/trial-balance?period=2026-10-01`);
  assertEqual(tb.status, 200, "trial balance");
  assertEqual(tb.body.foots, true, "zero foots");
  assertEqual(tb.body.lines.length, 0, "no balances");
  const ag = await call(world, "GET", `${base}/aging`);
  assertEqual(ag.status, 200, "aging");
  assertEqual(ag.body.receivableTotals.totalCents, 0, "nothing open");
  assertEqual(ag.body.lastSnapshotDate, null, "no snapshot said plainly");
  const bu = await call(world, "GET", `${base}/budget?period=2026-10-01`);
  assertEqual(bu.status, 200, "budget");
  assertEqual(bu.body.budgetedAccounts, 0, "no budget");
  assertEqual(bu.body.lines.length, 0, "no variances");
  const fc = await call(world, "GET", `${base}/forecast`);
  assertEqual(fc.status, 200, "forecast");
  assertEqual(fc.body.selectedRunId, null, "no forecast run");
  const jn = await call(world, "GET", `${base}/journal?period=2026-10-01`);
  assertEqual(jn.status, 200, "journal");
  assertEqual(jn.body.entries.length, 0, "no entries");
  const ru = await call(world, "GET", `${base}/rules`);
  assertEqual(ru.status, 200, "rules");
  assertEqual(ru.body.autoPostCount, ru.body.items.filter((r: any) => r.autoPostEnabled).length, "auto post count is a filter");
  const tx = await call(world, "GET", `${base}/tax-forms`);
  assertEqual(tx.status, 200, "tax forms");
  assertEqual(tx.body.selectedDataSetId, null, "no compilation");
  const su = await call(world, "GET", `${base}/substantiation?period=2026-10-01`);
  assertEqual(su.status, 200, "substantiation");
  assertEqual(su.body.openExceptions, 0, "no exceptions");
  const rp = await call(world, "GET", `${base}/report-packages?period=2026-10-01`);
  assertEqual(rp.status, 200, "report packages");
  assertEqual(rp.body.packages.length, 0, "no package");
  const na = await call(world, "GET", `${base}/narratives?period=2026-10-01`);
  assertEqual(na.status, 200, "narratives");
  assertEqual(na.body.items.length, 0, "no narrative");
  const msg = await call(world, "GET", `${base}/messages`);
  assertEqual(msg.status, 200, "messages answer for a new client");
  assertEqual(msg.body.items.length, 0, "no messages yet");
  const bad = await call(world, "GET", `${base}/close?period=2026-10-15`);
  assertEqual(bad.status, 400, "a mid month period is refused");
});

test("api: a period that is not a first of month is 400", async () => {
  const r = await call(world, "GET", `/api/portal/${createdClientId}/statements?period=2026-10-15`, { token: "client" });
  assertEqual(r.status, 400, "status");
  assertEqual(r.body.error.code, "validation_failed", "code");
});

test("api: without a document store the upload route answers 501 not_configured", async () => {
  // The world in this file has no store. The full upload path is in uploads.ts.
  const r = await call(world, "POST", `/api/portal/${createdClientId}/documents`, { token: "client", body: {} });
  assert(r.status === 501 || r.status === 403, `POST documents is 501 or feature gated, got ${r.status}`);
  if (r.status === 501) assertEqual(r.body.error.code, "not_configured", "code");
});

test("api: the run catalog lists every registered run with its tier", async () => {
  const r = await call(world, "GET", "/api/firm/runs/catalog");
  assertEqual(r.status, 200, "status");
  assertEqual(r.body.items.length, 74, "seventy four runs");
  const create = r.body.items.find((x: any) => x.runType === "INTAKE-CREATE-CLIENT");
  assertEqual(create?.tier, "manual", "the intake run is manual");
});

test("api: triggering a run previews by default and the preview can be applied", async () => {
  const missing = await call(world, "POST", `/api/firm/clients/${createdClientId}/runs/INTAKE-BUILD-CHART`, { body: {} });
  assertEqual(missing.status, 400, "the run's own scope is validated");
  const r = await call(world, "POST", `/api/firm/clients/${createdClientId}/runs/INTAKE-BUILD-CHART`, {
    body: { scope: { period: "2026-10-01", industry: "services" } },
  });
  assertEqual(r.status, 200, "status");
  assertEqual(r.body.mode, "preview", "preview");
  assert(["no_op", "completed", "completed_with_skips"].includes(r.body.status), `status ${r.body.status}`);
  if (r.body.status !== "no_op") {
    const a = await call(world, "POST", `/api/firm/runs/${r.body.executionId}/apply`, { body: {} });
    assertEqual(a.status, 200, "apply status");
    assertEqual(a.body.mode, "apply", "apply");
  }
});

test("api: an unknown run code is 404", async () => {
  const r = await call(world, "POST", `/api/firm/clients/${createdClientId}/runs/NO-SUCH-RUN`, { body: {} });
  assertEqual(r.status, 404, "status");
});

test("api: an unknown route under /api is 404 in the envelope", async () => {
  const r = await call(world, "GET", "/api/firm/nothing");
  assertEqual(r.status, 404, "status");
  assertEqual(r.body.error.code, "not_found", "code");
});

test("api: the error translator maps each engine error to its status and code", () => {
  const zod = (() => {
    try {
      z.object({ a: z.string() }).parse({});
    } catch (e) {
      return e;
    }
  })();
  assert(zod instanceof ZodError, "a zod error was produced");
  assertEqual(translate(zod).status, 400, "zod status");
  assertEqual(translate(zod).code, "validation_failed", "zod code");
  const feat = translate(new FeatureNotInTierError("x", "statements", "ledger"));
  assertEqual(feat.status, 403, "feature status");
  assertEqual(feat.code, "feature_not_included", "feature code");
  const locked = translate(new LockedPeriodError("2026-01-01", "x"));
  assertEqual(locked.status, 409, "locked status");
  assertEqual(locked.code, "locked_period", "locked code");
  const api = translate(new ApiFailure(410, "not_found", "gone"));
  assertEqual(api.status, 410, "passthrough status");
  const unknown = translate(new Error("boom"));
  assertEqual(unknown.status, 500, "default status");
  assertEqual(unknown.code, "internal", "default code");
  assert(!unknown.message.includes("boom"), "the raw message of an unknown error is not shown");
});

test("api: the development actor refuses production and refuses postgres", () => {
  assertEqual(devActorEnabled({ NODE_ENV: "development" }, "memory"), true, "on by default in memory");
  assertEqual(devActorEnabled({ NODE_ENV: "production" }, "memory"), false, "off in production when unset");
  assertEqual(devActorEnabled({ NODE_ENV: "development", DEV_ACTOR: "off" }, "memory"), false, "DEV_ACTOR=off disables");
  assertEqual(devActorEnabled({ NODE_ENV: "development" }, "postgres"), false, "off with postgres");
  let threw: unknown = null;
  try {
    devActorEnabled({ NODE_ENV: "production", DEV_ACTOR: "1" }, "memory");
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof DevActorRefused, "set in production throws");
  threw = null;
  try {
    devActorEnabled({ NODE_ENV: "development", DEV_ACTOR: "1" }, "postgres");
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof DevActorRefused, "set with postgres throws");
});

/* ---------------- Staged statements: approve and reject ---------------- */

test("api: approve commits a staged batch, runs the coding cascade, and the books still foot", async () => {
  const bankAccountId = "BA-ROUTE-0001";
  await world.db.tx({ ...readSession(DEV_ACTOR, DEV_FIRM_ID, createdClientId), readOnly: false }, async (tx) => {
    await tx.insert("bank_accounts", [
      {
        id: bankAccountId,
        firmId: DEV_FIRM_ID,
        clientId: createdClientId,
        accountNumber: "1010",
        nickname: "Operating checking",
        kind: "bank",
        isProcessorDestination: false,
        institutionName: "First Bank",
      } as any,
    ]);
    await tx.insert("mapping_profiles", [
      {
        id: "MP-ROUTE-0001",
        firmId: DEV_FIRM_ID,
        clientId: createdClientId,
        version: 1,
        institutionName: "First Bank",
        accountNumber: "1010",
        fileFormat: "csv",
        headerFingerprint: headerFingerprintOf(["Date", "Description", "Amount"]),
        headerRowNumber: 1,
        skipRows: 0,
        dateColumn: "Date",
        dateFormat: "MM/DD/YYYY",
        descriptionColumn: "Description",
        amountColumn: "Amount",
        debitColumn: null,
        creditColumn: null,
        signConvention: "credit_positive",
        currency: "USD",
        bankIdColumn: null,
        checkNumberColumn: null,
        bankCodeColumn: null,
        isActive: true,
      } as any,
    ]);
  });

  const parseScope = {
    clientId: createdClientId,
    bankAccountId,
    batchName: "approve route test feed",
    institutionName: "First Bank",
    sourceFormat: "csv",
    fileText: "Date,Description,Amount\n01/12/2026,COFFEE HOUSE,-14.75\n01/13/2026,CLIENT DEPOSIT,3000.00\n",
    grid: null,
    sourceDocumentId: null,
  };
  const parsePath = `/api/firm/clients/${createdClientId}/runs/IMPORT-PARSE-FEED`;
  const parsePreview = await call(world, "POST", parsePath, { body: { mode: "preview", scope: parseScope } });
  assertEqual(parsePreview.body.status, "completed", `parse preview: ${JSON.stringify(parsePreview.body)}`);
  const parseApplied = await call(world, "POST", parsePath, { body: { mode: "apply", scope: parseScope, previewRunId: parsePreview.body.executionId } });
  assertEqual(parseApplied.body.status, "completed", "parse applied");
  const batchId = parseApplied.body.proposals.find((p: any) => p.table === "import_batches")?.rowId;
  assert(typeof batchId === "string" && batchId.length > 0, "the batch id is in the parse proposals");

  const staged = await call(world, "GET", `/api/firm/clients/${createdClientId}/staged-batches`);
  assert(staged.body.items.some((b: any) => b.id === batchId), "the batch is listed as waiting on a decision");

  const approved = await call(world, "POST", `/api/firm/clients/${createdClientId}/staged-batches/${batchId}/approve`, { body: {} });
  assertEqual(approved.status, 200, `approve status: ${JSON.stringify(approved.body)}`);
  assertEqual(approved.body.done, true, "approved");
  assertEqual(approved.body.applied.status, "completed", "the commit itself completed");
  assert(approved.body.cascade !== null, "the coding cascade ran");
  assertEqual(approved.body.cascade.stoppedAtStep, null, "the cascade ran to the end without stopping");

  const batches = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, createdClientId), (tx) =>
    tx.query("import_batch_by_id", { firmId: DEV_FIRM_ID, clientId: createdClientId, batchId }),
  );
  assertEqual((batches[0] as any).status, "committed", "the batch is committed");

  const register = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, createdClientId), (tx) =>
    tx.query("transactions_by_bank_ids", { firmId: DEV_FIRM_ID, clientId: createdClientId, bankAccountId, bankTransactionIds: [] }),
  );
  // bankTransactionIds empty on purpose; the two lines carry no bank id, so a
  // direct count from the batch's own staged rows is the honest check instead.
  const stagedRows = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, createdClientId), (tx) =>
    tx.query("staged_rows_by_batch", { firmId: DEV_FIRM_ID, clientId: createdClientId, batchId }),
  );
  assertEqual(stagedRows.length, 2, "two staged rows");
  assert(stagedRows.every((r: any) => r.committedTransactionId !== null), "both committed into the register");
  assert(register.length === 0, "the empty bank id lookup is itself empty, confirming these rows carry none");

  // The books still foot: whatever the cascade posted, debits and credits
  // net to zero, the same invariant every posting run in this codebase holds.
  const lines = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, createdClientId), (tx) =>
    tx.query("journal_lines_for_client", { firmId: DEV_FIRM_ID, clientId: createdClientId }),
  );
  const net = lines.reduce((sum: bigint, l: any) => sum + (l.amountCents as bigint), BigInt(0));
  assertEqual(net, BigInt(0), "every journal line in the client's books nets to zero");
});

test("api: reject throws out a staged batch and never touches the register", async () => {
  const bankAccountId = "BA-ROUTE-0001"; // seeded by the approve test above, same client
  const parseScope = {
    clientId: createdClientId,
    bankAccountId,
    batchName: "reject route test feed",
    institutionName: "First Bank",
    sourceFormat: "csv",
    fileText: "Date,Description,Amount\n02/01/2026,WRONG STATEMENT,-99.00\n",
    grid: null,
    sourceDocumentId: null,
  };
  const parsePath = `/api/firm/clients/${createdClientId}/runs/IMPORT-PARSE-FEED`;
  const preview = await call(world, "POST", parsePath, { body: { mode: "preview", scope: parseScope } });
  const applied = await call(world, "POST", parsePath, { body: { mode: "apply", scope: parseScope, previewRunId: preview.body.executionId } });
  const batchId = applied.body.proposals.find((p: any) => p.table === "import_batches")?.rowId;
  assert(typeof batchId === "string", "staged");

  const rejected = await call(world, "POST", `/api/firm/clients/${createdClientId}/staged-batches/${batchId}/reject`, {
    body: { reason: "this is the card statement, not the bank statement" },
  });
  assertEqual(rejected.status, 200, `reject status: ${JSON.stringify(rejected.body)}`);
  assertEqual(rejected.body.done, true, "rejected");

  const batches = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, createdClientId), (tx) =>
    tx.query("import_batch_by_id", { firmId: DEV_FIRM_ID, clientId: createdClientId, batchId }),
  );
  assertEqual((batches[0] as any).status, "rejected", "rejected");
  assertEqual((batches[0] as any).rejectReason, "this is the card statement, not the bank statement", "reason on record");

  const stagedRows = await world.db.tx(readSession(DEV_ACTOR, DEV_FIRM_ID, createdClientId), (tx) =>
    tx.query("staged_rows_by_batch", { firmId: DEV_FIRM_ID, clientId: createdClientId, batchId }),
  );
  assert(stagedRows.every((r: any) => r.committedTransactionId === null), "nothing from this batch ever committed");
  assertEqual(rejected.body.applied.entriesCreated, 0, "nothing posted");
});

test("api: a client scoped actor cannot reach the staged statements routes at all", async () => {
  const list = await call(world, "GET", `/api/firm/clients/${createdClientId}/staged-batches`, { token: "client" });
  assert(list.status === 403 || list.status === 404, `list refused: ${list.status}`);
  const approve = await call(world, "POST", `/api/firm/clients/${createdClientId}/staged-batches/anything/approve`, { token: "client", body: {} });
  assert(approve.status === 403 || approve.status === 404, `approve refused: ${approve.status}`);
  const reject = await call(world, "POST", `/api/firm/clients/${createdClientId}/staged-batches/anything/reject`, { token: "client", body: { reason: "x" } });
  assert(reject.status === 403 || reject.status === 404, `reject refused: ${reject.status}`);
  // Nor can a client reach IMPORT-PARSE-FEED or IMPORT-COMMIT-BATCH through
  // the one generic run route either, the same firm scoped gate.
  const parse = await call(world, "POST", `/api/firm/clients/${createdClientId}/runs/IMPORT-PARSE-FEED`, { token: "client", body: { mode: "preview", scope: {} } });
  assert(parse.status === 403 || parse.status === 404, `parse refused: ${parse.status}`);
});

test("api: the world stops", async () => {
  await world.close();
});
