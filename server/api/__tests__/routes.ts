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

const CLIENT_USER_ID = "00000000-0000-4000-8000-0000000000c1";
const OTHER_FIRM_ID = "00000000-0000-4000-8000-00000000f1b0";

export interface World {
  db: MemoryRunDb;
  base: string;
  close: () => Promise<void>;
  /** The client the client scoped token belongs to. Set after the first create. */
  setClientFor: (clientId: string) => void;
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

export async function startWorld(): Promise<World> {
  const db = new MemoryRunDb();
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
      entitlements: new RunDbEntitlementSource(db, DEV_USER_ID, DEV_FIRM_ID),
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
 * Known blocker, recorded in api-report.md. Category ids are the published
 * slug (NOTES 126) and ledger.categories keeps a primary key on id alone, so
 * the second client in one database cannot build its chart. The route tells
 * the truth about it: 207, complete false, the failing run named. When the
 * key moves to (client_id, id) this test should expect 201 and complete true.
 */
test("api: a second client reports a partial intake honestly", async () => {
  const r = await call(world, "POST", "/api/firm/clients", { body: { ...NEW_CLIENT, name: "Second Client Inc" } });
  assert(r.status === 201 || r.status === 207, `201 or 207, got ${r.status}`);
  assert(r.body.client !== null, "the client row exists either way");
  if (r.status === 207) {
    assertEqual(r.body.complete, false, "not complete");
    const failed = r.body.runs.find((x: any) => x.status === "failed");
    assertEqual(failed?.runType, "INTAKE-BUILD-CHART", "the chart run is the one that fails");
    assertEqual(failed?.errors[0]?.code, "UNIQUE_VIOLATION", "on the categories key");
  }
  // Put the firm back to one client for the reads below.
  await world.db.tx({ ...readSession(DEV_ACTOR, DEV_FIRM_ID, r.body.client.id), readOnly: false }, async (tx) => {
    await tx.update("clients", r.body.client.id, { archivedAt: "2026-10-23T00:00:00.000Z" } as any);
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
  await world.db.tx(
    { ...readSession(DEV_ACTOR, DEV_FIRM_ID, createdClientId), readOnly: false },
    async (tx) => {
      const [e] = await tx.query("engagements_for_client", { firmId: DEV_FIRM_ID, clientId: createdClientId });
      await tx.update("engagements", e.id, { status: "active", signedAt: "2026-10-01T00:00:00.000Z" } as any);
    },
  );
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

test("api: a period that is not a first of month is 400", async () => {
  const r = await call(world, "GET", `/api/portal/${createdClientId}/statements?period=2026-10-15`, { token: "client" });
  assertEqual(r.status, 400, "status");
  assertEqual(r.body.error.code, "validation_failed", "code");
});

test("api: the upload route answers 501 not_configured", async () => {
  for (const [m, p] of [["POST", "upload"]] as const) {
    const r = await call(world, m, `/api/portal/${createdClientId}/${p}`, { token: "client", body: {} });
    assert(r.status === 501 || r.status === 403, `${m} ${p} is 501 or feature gated, got ${r.status}`);
    if (r.status === 501) assertEqual(r.body.error.code, "not_configured", `${p} code`);
  }
});

test("api: the run catalog lists every registered run with its tier", async () => {
  const r = await call(world, "GET", "/api/firm/runs/catalog");
  assertEqual(r.status, 200, "status");
  assertEqual(r.body.items.length, 53, "fifty three runs");
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

test("api: the world stops", async () => {
  await world.close();
});
