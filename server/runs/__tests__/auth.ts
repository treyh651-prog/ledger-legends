/**
 * Login, actors, and row level security.
 *
 * Three layers, tested from the bottom up:
 *
 * 1. withActor against a scripted pool: the exact statement sequence, the
 *    rollback on throw, the release in every path.
 *
 * 2. The actor middleware against a scripted verifier and store: which
 *    refusal each failure produces, how X-Firm selects a firm, how a client
 *    route admits firm staff and the client's own members and nobody else.
 *
 * 3. The database itself. PGlite is Postgres compiled to WebAssembly and runs
 *    in process, so the suite applies every migration in db/migrations to a
 *    fresh database, seeds two firms, and proves through withActor that a
 *    client scoped actor cannot read another client's rows, that firm staff
 *    can, and that the same query with no role switch (the way a BYPASSRLS
 *    connection role behaves) sees everything, which is why APP_DB_ROLE
 *    exists. The invitation and revocation paths run against the same
 *    database with a scripted auth admin.
 */

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PgClientLike, PgPoolLike, PgQueryResultLike } from "../db-postgres";
import { resolveDbRole, withActor, type Actor, type ActorMembership, type WithActorOptions } from "../../db/with-actor";
import { buildAuthRuntime } from "../../auth/setup";
import { createPgActorStore, DisabledUserError, type ActorStore } from "../../auth/actor-store";
import { createActorMiddleware, type ActorMiddleware } from "../../auth/middleware";
import { bearerToken, TokenError, type TokenVerifier, type VerifiedToken } from "../../auth/jwt";
import type { AuthAdmin } from "../../auth/auth-admin";
import {
  InvitationError,
  assertCanInvite,
  changeMembershipRole,
  createInvitation,
  listInvitations,
  revokeInvitation,
  validateInvitation,
  validateRoleChange,
  type InvitationDeps,
} from "../../auth/invitations";
import {
  AccessRequestError,
  approveAccessRequest,
  listAccessRequests,
  lookupFirmBySlug,
  myAccessRequests,
  rejectAccessRequest,
  submitAccessRequest,
  validateAccessRequestInput,
  type AccessRequestDeps,
} from "../../auth/access-requests";
import { buildCsp } from "../../http-hardening";
import { assert, assertEqual, assertRejects, assertThrows, test } from "./harness";

// ---------------------------------------------------------------------------
// 1. withActor statement sequence
// ---------------------------------------------------------------------------

interface Scripted {
  log: string[];
  released: number;
  pool: PgPoolLike;
}

function scriptedPool(onQuery?: (sql: string) => void): Scripted {
  const s: Scripted = { log: [], released: 0, pool: null as unknown as PgPoolLike };
  const client: PgClientLike = {
    async query<R>(sql: string, params?: unknown[]): Promise<PgQueryResultLike<R>> {
      s.log.push(params && params.length ? `${sql} -- ${JSON.stringify(params)}` : sql);
      onQuery?.(sql);
      return { rows: [] as R[], rowCount: 0 };
    },
    release() {
      s.released += 1;
    },
  };
  s.pool = { connect: async () => client };
  return s;
}

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

test("withActor: begin, set_config, work, commit, release", async () => {
  const s = scriptedPool();
  const out = await withActor(s.pool, { userId: ACTOR_ID }, async (tx) => {
    await tx.query("select 1");
    return 42;
  });
  assertEqual(out, 42, "returns the function's value");
  assertEqual(
    s.log,
    [
      "begin",
      `select set_config('app.user_id', $1, true), set_config('app.run_id', '', true) -- ["${ACTOR_ID}"]`,
      "select 1",
      "commit",
    ],
    "statement sequence",
  );
  assertEqual(s.released, 1, "released once");
});

test("withActor: set local role precedes set_config when a role is configured", async () => {
  const s = scriptedPool();
  await withActor(s.pool, { userId: ACTOR_ID }, async () => undefined, { dbRole: "app_web" });
  assertEqual(s.log[1], "set local role app_web", "role switch is the first thing inside the transaction");
  assert(s.log[2].startsWith("select set_config"), "then the actor");
});

test("withActor: a throw rolls back and still releases", async () => {
  const s = scriptedPool();
  await assertRejects(
    () =>
      withActor(s.pool, { userId: ACTOR_ID }, async () => {
        throw new Error("boom");
      }),
    "boom",
    "the error propagates",
  );
  assertEqual(s.log[s.log.length - 1], "rollback", "rolled back");
  assert(!s.log.includes("commit"), "never committed");
  assertEqual(s.released, 1, "released once");
});

test("withActor: a failing begin releases without a rollback", async () => {
  const s = scriptedPool((sql) => {
    if (sql === "begin") throw new Error("no connection");
  });
  await assertRejects(() => withActor(s.pool, { userId: ACTOR_ID }, async () => undefined), "no connection", "propagates");
  assert(!s.log.includes("rollback"), "no rollback for a transaction that never started");
  assertEqual(s.released, 1, "released");
});

test("resolveDbRole accepts identifiers and refuses anything else", () => {
  assertEqual(resolveDbRole({}), null, "unset is null");
  assertEqual(resolveDbRole({ APP_DB_ROLE: "  " }), null, "blank is null");
  assertEqual(resolveDbRole({ APP_DB_ROLE: "app_web" }), "app_web", "plain identifier");
  assertThrows(() => resolveDbRole({ APP_DB_ROLE: "app_web; drop table x" }), "plain lowercase identifier", "injection shaped");
  assertThrows(() => resolveDbRole({ APP_DB_ROLE: "App" }), "plain lowercase identifier", "uppercase");
});

/**
 * Earlier security audit: an unset APP_DB_ROLE means the connection runs as
 * Supabase's own postgres role, which carries BYPASSRLS -- every isolation
 * policy on every tenant table becomes a no op, and this used to only log a
 * line at startup rather than refuse. buildAuthRuntime now refuses outright
 * in production, the same "refusing is loud" rule resolveRunDb already
 * applies to a missing DATABASE_URL. A dummy DATABASE_URL is enough here:
 * getPool only builds a lazy Pool object, it never opens a connection.
 */
function validAuthEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    APP_ORIGIN: "https://app.example.com",
    DATABASE_URL: "postgres://user:pass@localhost:5432/unused",
    ...extra,
  };
}

test("buildAuthRuntime: production with no APP_DB_ROLE refuses to start, the audit fix", () => {
  assertThrows(
    () => buildAuthRuntime(validAuthEnv({ NODE_ENV: "production" })),
    "APP_DB_ROLE is not set in production",
    "a BYPASSRLS production deploy must not start silently",
  );
});

test("buildAuthRuntime: production with APP_DB_ROLE set starts and confirms row level security applies", () => {
  const runtime = buildAuthRuntime(validAuthEnv({ NODE_ENV: "production", APP_DB_ROLE: "app_web" }));
  assert(
    runtime.notes.some((n) => n.includes("row level security applies")),
    "the startup note confirms the role switch is in effect",
  );
});

test("buildAuthRuntime: outside production, no APP_DB_ROLE is still allowed but still visible", () => {
  const runtime = buildAuthRuntime(validAuthEnv({ NODE_ENV: "development" }));
  assert(
    runtime.notes.some((n) => n.includes("APP_DB_ROLE is not set")),
    "a developer's relaxed isolation choice is logged, not silent, even though it is not refused",
  );
});

// ---------------------------------------------------------------------------
// 2. Middleware against scripted collaborators
// ---------------------------------------------------------------------------

const FIRM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FIRM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENT_1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const CLIENT_2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const CLIENT_B = "cbcbcbcb-cbcb-4cbc-8cbc-cbcbcbcbcbcb";

function membership(p: Partial<ActorMembership> & Pick<ActorMembership, "firmId" | "scope" | "role">): ActorMembership {
  return { firmSlug: p.firmId === FIRM_A ? "firm-a" : "firm-b", firmName: "Firm", clientId: null, ...p };
}

const STAFF: Actor = {
  userId: "u-staff",
  authSubject: "sub-staff",
  email: "staff@a.test",
  displayName: "Staff",
  memberships: [membership({ firmId: FIRM_A, scope: "firm", role: "manager" })],
};
const TWO_FIRMS: Actor = {
  ...STAFF,
  userId: "u-two",
  authSubject: "sub-two",
  memberships: [membership({ firmId: FIRM_A, scope: "firm", role: "owner" }), membership({ firmId: FIRM_B, scope: "firm", role: "preparer" })],
};
const CLIENT_USER: Actor = {
  userId: "u-client",
  authSubject: "sub-client",
  email: "client@c1.test",
  displayName: null,
  memberships: [membership({ firmId: FIRM_A, scope: "client", role: "client_user", clientId: CLIENT_1 })],
};
const NOBODY: Actor = { ...CLIENT_USER, userId: "u-nobody", authSubject: "sub-nobody", memberships: [] };

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}

function fakeReq(opts: { auth?: string; firm?: string; params?: Record<string, string> }) {
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.firm) headers["x-firm"] = opts.firm;
  return {
    params: opts.params ?? {},
    header: (n: string) => headers[n.toLowerCase()],
    actor: undefined as Actor | undefined,
    firm: undefined as ActorMembership | undefined,
    client: undefined as unknown,
    tokenSubject: undefined as { subject: string; email: string | null } | undefined,
  };
}

function fakeRes(): FakeRes & { status: (n: number) => FakeRes & { json: (b: unknown) => void }; setHeader: (k: string, v: string) => void } {
  const r = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      r.headers[k] = v;
    },
    status(n: number) {
      r.statusCode = n;
      return { ...r, json: (b: unknown) => void (r.body = b) };
    },
  };
  return r;
}

type LooseHandler = (req: unknown, res: unknown, next: (e?: unknown) => void) => void;

function run(handler: unknown, req: unknown, res: unknown): Promise<"next" | "ended" | unknown> {
  return new Promise((resolve) => {
    let settled = false;
    (handler as LooseHandler)(req, res, (e?: unknown) => {
      settled = true;
      resolve(e === undefined ? "next" : e);
    });
    // Handlers are promise based; give them a tick, then a few more.
    const poll = (n: number) => {
      if (settled) return;
      const r = res as FakeRes;
      if (r.body !== undefined) {
        resolve("ended");
        return;
      }
      if (n > 50) {
        resolve("timeout");
        return;
      }
      setTimeout(() => poll(n + 1), 2);
    };
    setTimeout(() => poll(0), 0);
  });
}

function scriptedVerifier(map: Record<string, VerifiedToken | TokenError>): TokenVerifier {
  return {
    async verify(token) {
      const v = map[token];
      if (!v) throw new TokenError("invalid", "unknown token");
      if (v instanceof TokenError) throw v;
      return v;
    },
  };
}

function scriptedStore(actors: Actor[], disabled: string[] = []): ActorStore & { touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    async findByAuthSubject(sub) {
      if (disabled.includes(sub)) throw new DisabledUserError(sub);
      return actors.find((a) => a.authSubject === sub) ?? null;
    },
    async touchLastSeen(userId) {
      touched.push(userId);
    },
  };
}

function buildMiddleware(opts: { now?: () => number } = {}): { mw: ActorMiddleware; store: ReturnType<typeof scriptedStore> } {
  const verified = (a: Actor): VerifiedToken => ({ subject: a.authSubject, email: a.email, expiresAt: null, via: "jwks" });
  const store = scriptedStore([STAFF, TWO_FIRMS, CLIENT_USER, NOBODY], ["sub-disabled"]);
  const mw = createActorMiddleware({
    verifier: scriptedVerifier({
      "t-staff": verified(STAFF),
      "t-two": verified(TWO_FIRMS),
      "t-client": verified(CLIENT_USER),
      "t-nobody": verified(NOBODY),
      "t-unknown": { subject: "sub-unknown", email: null, expiresAt: null, via: "jwks" },
      "t-disabled": { subject: "sub-disabled", email: null, expiresAt: null, via: "jwks" },
      "t-expired": new TokenError("expired", "expired"),
      "t-down": new TokenError("unavailable", "down"),
      "t-garbage": new TokenError("malformed", "garbage"),
    }),
    store,
    now: opts.now,
    clientFirm: async (clientId) => (clientId === CLIENT_1 || clientId === CLIENT_2 ? FIRM_A : clientId === CLIENT_B ? FIRM_B : null),
  });
  return { mw, store };
}

function errorCode(res: FakeRes): string | undefined {
  return (res.body as { error?: { code?: string } } | undefined)?.error?.code;
}

test("bearerToken reads the header and nothing else", () => {
  assertEqual(bearerToken(undefined), null, "no header");
  assertEqual(bearerToken("Basic abc"), null, "wrong scheme");
  assertEqual(bearerToken("Bearer abc.def.ghi"), "abc.def.ghi", "token");
  assertEqual(bearerToken("bearer   x "), "x", "case and spacing");
});

test("requireToken: passes for any verified token, even one with no tenancy row, which is the entire point of access-requests.ts", async () => {
  const { mw } = buildMiddleware();
  const req = fakeReq({ auth: "Bearer t-unknown" });
  const out = await run(mw.requireToken, req, fakeRes());
  assertEqual(out, "next", "passes, unlike requireUser, which refuses this same token with auth.no_user");
  assertEqual(req.tokenSubject, { subject: "sub-unknown", email: null }, "subject and email carried from the token, nothing looked up");
});

test("requireUser: each failure has its own code and status", async () => {
  const { mw } = buildMiddleware();
  const cases: [string | undefined, number, string][] = [
    [undefined, 401, "auth.missing_token"],
    ["Bearer t-garbage", 401, "auth.malformed_token"],
    ["Bearer t-expired", 401, "auth.expired_token"],
    ["Bearer nope", 401, "auth.invalid_token"],
    ["Bearer t-down", 503, "auth.unavailable"],
    ["Bearer t-unknown", 401, "auth.no_user"],
    ["Bearer t-disabled", 403, "auth.disabled"],
  ];
  for (const [auth, status, code] of cases) {
    const req = fakeReq({ auth });
    const res = fakeRes();
    const out = await run(mw.requireUser, req, res);
    assertEqual(out, "ended", `${code}: response ended`);
    assertEqual(res.statusCode, status, `${code}: status`);
    assertEqual(errorCode(res), code, `${code}: code`);
    if (status === 401) assert(!!res.headers["WWW-Authenticate"], `${code}: challenge header`);
    assertEqual(req.actor, undefined, `${code}: no actor set`);
  }
});

test("requireUser: a good token sets the actor and touches last_seen once a minute", async () => {
  let t = 1_000_000;
  const { mw, store } = buildMiddleware({ now: () => t });
  for (let i = 0; i < 3; i++) {
    const req = fakeReq({ auth: "Bearer t-staff" });
    const out = await run(mw.requireUser, req, fakeRes());
    assertEqual(out, "next", "passes");
    assertEqual(req.actor?.userId, "u-staff", "actor attached");
  }
  assertEqual(store.touched, ["u-staff"], "one touch inside the window");
  t += 61_000;
  await run(mw.requireUser, fakeReq({ auth: "Bearer t-staff" }), fakeRes());
  assertEqual(store.touched, ["u-staff", "u-staff"], "touched again after the window");
});

test("requireFirm: one firm needs no header, two firms need X-Firm, a client user is refused", async () => {
  const { mw } = buildMiddleware();
  const one = fakeReq({ auth: "Bearer t-staff" });
  assertEqual(await run(mw.requireFirm, one, fakeRes()), "next", "one firm passes");
  assertEqual(one.firm?.firmId, FIRM_A, "firm selected");

  const two = fakeReq({ auth: "Bearer t-two" });
  const twoRes = fakeRes();
  assertEqual(await run(mw.requireFirm, two, twoRes), "ended", "two firms without header refused");
  assertEqual(errorCode(twoRes), "auth.ambiguous_firm", "ambiguous");

  const bySlug = fakeReq({ auth: "Bearer t-two", firm: "firm-b" });
  assertEqual(await run(mw.requireFirm, bySlug, fakeRes()), "next", "slug selects");
  assertEqual(bySlug.firm?.firmId, FIRM_B, "firm b");

  const byId = fakeReq({ auth: "Bearer t-two", firm: FIRM_A });
  assertEqual(await run(mw.requireFirm, byId, fakeRes()), "next", "id selects");
  assertEqual(byId.firm?.role, "owner", "firm a membership");

  const wrong = fakeReq({ auth: "Bearer t-staff", firm: FIRM_B });
  const wrongRes = fakeRes();
  assertEqual(await run(mw.requireFirm, wrong, wrongRes), "ended", "a firm you are not in is refused");
  assertEqual(wrongRes.statusCode, 403, "403");
  assertEqual(errorCode(wrongRes), "auth.forbidden", "forbidden");

  const client = fakeReq({ auth: "Bearer t-client" });
  const clientRes = fakeRes();
  assertEqual(await run(mw.requireFirm, client, clientRes), "ended", "client user refused");
  assertEqual(errorCode(clientRes), "auth.no_firm", "no firm");

  const nobody = fakeReq({ auth: "Bearer t-nobody" });
  const nobodyRes = fakeRes();
  assertEqual(await run(mw.requireFirm, nobody, nobodyRes), "ended", "no memberships refused");
  assertEqual(errorCode(nobodyRes), "auth.no_firm", "no firm either");
});

test("requireClient: own client, firm's client, someone else's client, nonsense", async () => {
  const { mw } = buildMiddleware();
  const guard = mw.requireClient("clientId");

  const own = fakeReq({ auth: "Bearer t-client", params: { clientId: CLIENT_1 } });
  assertEqual(await run(guard, own, fakeRes()), "next", "client user reaches own client");
  assertEqual((own.client as { via: string }).via, "client", "via client membership");

  const other = fakeReq({ auth: "Bearer t-client", params: { clientId: CLIENT_2 } });
  const otherRes = fakeRes();
  assertEqual(await run(guard, other, otherRes), "ended", "client user cannot reach a sibling client");
  assertEqual(otherRes.statusCode, 404, "looks like not found");

  const staff = fakeReq({ auth: "Bearer t-staff", params: { clientId: CLIENT_2 } });
  assertEqual(await run(guard, staff, fakeRes()), "next", "firm staff reach the firm's clients");
  assertEqual((staff.client as { via: string }).via, "firm", "via firm membership");

  const foreign = fakeReq({ auth: "Bearer t-staff", params: { clientId: CLIENT_B } });
  const foreignRes = fakeRes();
  assertEqual(await run(guard, foreign, foreignRes), "ended", "another firm's client is refused");
  assertEqual(foreignRes.statusCode, 404, "same 404");

  const junk = fakeReq({ auth: "Bearer t-staff", params: { clientId: "'; drop table--" } });
  const junkRes = fakeRes();
  assertEqual(await run(guard, junk, junkRes), "ended", "non uuid refused before any lookup");
  assertEqual(junkRes.statusCode, 404, "404");
});

test("content security policy: strict in production, loosened for the dev client only", () => {
  const prod = buildCsp({ appOrigin: "https://app.test", supabaseUrl: "https://x.supabase.co", production: true });
  assertEqual(prod["script-src"], ["'self'"], "no inline script in production");
  assert(prod["connect-src"].includes("https://x.supabase.co"), "supabase reachable");
  assert(prod["connect-src"].includes("wss://x.supabase.co"), "supabase realtime socket reachable");
  assert(!prod["connect-src"].includes("ws:"), "no blanket websocket");
  assertEqual(prod["frame-ancestors"], ["'none'"], "not frameable");
  const dev = buildCsp({ appOrigin: null, supabaseUrl: null, production: false });
  assert(dev["script-src"].includes("'unsafe-inline'"), "vite refresh preamble allowed in dev");
  assert(dev["connect-src"].includes("ws:"), "hmr socket allowed in dev");
});

// ---------------------------------------------------------------------------
// 3. Real Postgres, in process
// ---------------------------------------------------------------------------

function pgliteAsPool(db: PGlite): PgPoolLike {
  const client: PgClientLike = {
    async query<R>(sql: string, params?: unknown[]): Promise<PgQueryResultLike<R>> {
      const r = await db.query<R>(sql, params ?? []);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    release() {
      // One connection, nothing to give back.
    },
  };
  return { connect: async () => client };
}

interface Seed {
  db: PGlite;
  pool: PgPoolLike;
  firmA: string;
  firmB: string;
  client1: string;
  client2: string;
  clientB: string;
  owner: Actor;
  manager: Actor;
  preparer: Actor;
  clientUser: Actor;
  outsider: Actor;
}

let seedPromise: Promise<Seed> | null = null;

async function seeded(): Promise<Seed> {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    const db = new PGlite({ extensions: { pgcrypto } });
    const dir = path.resolve(process.cwd(), "db/migrations");
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}[a-z]?_.*\.sql$/.test(f))
      .sort();
    for (const f of files) await db.exec(readFileSync(path.join(dir, f), "utf8"));

    const one = async <R extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R> =>
      (await db.query<R>(sql, params)).rows[0];
    const firmA = (await one<{ id: string }>("insert into tenancy.firms (name, slug) values ('Firm A', 'firm-a') returning id")).id;
    const firmB = (await one<{ id: string }>("insert into tenancy.firms (name, slug) values ('Firm B', 'firm-b') returning id")).id;
    const client1 = (await one<{ id: string }>("insert into tenancy.clients (firm_id, name, entity_type) values ($1, 'Client One', 'llc') returning id", [firmA])).id;
    const client2 = (await one<{ id: string }>("insert into tenancy.clients (firm_id, name, entity_type) values ($1, 'Client Two', 'llc') returning id", [firmA])).id;
    const clientB = (await one<{ id: string }>("insert into tenancy.clients (firm_id, name, entity_type) values ($1, 'Client Bee', 'llc') returning id", [firmB])).id;

    const mkUser = async (sub: string, email: string) =>
      (await one<{ id: string }>("insert into tenancy.users (auth_subject, email) values ($1, $2) returning id", [sub, email])).id;
    const ownerId = await mkUser("sub-owner", "owner@a.test");
    const managerId = await mkUser("sub-manager", "manager@a.test");
    const preparerId = await mkUser("sub-preparer", "preparer@a.test");
    const clientUserId = await mkUser("sub-client", "client@one.test");
    const outsiderId = await mkUser("sub-outsider", "owner@b.test");

    const grant = (userId: string, firmId: string, scope: string, role: string, clientId: string | null) =>
      db.query(
        "insert into tenancy.memberships (user_id, firm_id, client_id, scope, role, granted_by) values ($1, $2, $3, $4, $5, $1)",
        [userId, firmId, clientId, scope, role],
      );
    await grant(ownerId, firmA, "firm", "owner", null);
    await grant(managerId, firmA, "firm", "manager", null);
    await grant(preparerId, firmA, "firm", "preparer", null);
    await grant(clientUserId, firmA, "client", "client_user", client1);
    await grant(outsiderId, firmB, "firm", "owner", null);

    for (const [firm, client, label] of [
      [firmA, client1, "one"],
      [firmA, client2, "two"],
      [firmB, clientB, "bee"],
    ] as const) {
      await db.query(
        "insert into tenancy.engagements (firm_id, client_id, name, status, service_level, start_date, created_by) values ($1, $2, $3, 'draft', 'ledger', '2026-01-01', $4)",
        [firm, client, `Engagement ${label}`, ownerId],
      );
    }

    const store = createPgActorStore(pgliteAsPool(db));
    const actor = async (sub: string): Promise<Actor> => {
      const a = await store.findByAuthSubject(sub);
      if (!a) throw new Error(`seed actor ${sub} missing`);
      return a;
    };
    return {
      db,
      pool: pgliteAsPool(db),
      firmA,
      firmB,
      client1,
      client2,
      clientB,
      owner: await actor("sub-owner"),
      manager: await actor("sub-manager"),
      preparer: await actor("sub-preparer"),
      clientUser: await actor("sub-client"),
      outsider: await actor("sub-outsider"),
    };
  })();
  return seedPromise;
}

const AS_APP_WEB = { dbRole: "app_web" };

async function engagementClients(s: Seed, actor: Actor, opts: WithActorOptions = AS_APP_WEB): Promise<string[]> {
  const rows = await withActor(
    s.pool,
    actor,
    (tx) => tx.query<{ client_id: string }>("select client_id from tenancy.engagements order by client_id"),
    opts,
  );
  return rows.map((r) => r.client_id).sort();
}

test("migrations: every file in db/migrations applies to a fresh Postgres", async () => {
  const s = await seeded();
  const roles = await s.db.query<{ rolname: string; rolbypassrls: boolean }>(
    "select rolname, rolbypassrls from pg_roles where rolname in ('app_web', 'app_worker') order by rolname",
  );
  assertEqual(
    roles.rows.map((r) => `${r.rolname}:${r.rolbypassrls}`),
    ["app_web:false", "app_worker:false"],
    "the application roles do not bypass row level security",
  );
  const cols = await s.db.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema = 'tenancy' and table_name = 'users' and column_name in ('last_seen_at', 'invited_by') order by 1",
  );
  assertEqual(cols.rows.map((r) => r.column_name), ["invited_by", "last_seen_at"], "0023 columns present");
});

test("actor store: resolves memberships, refuses disabled users, unknown subjects are null", async () => {
  const s = await seeded();
  const store = createPgActorStore(s.pool);
  assertEqual(s.owner.memberships.length, 1, "owner has one membership");
  assertEqual(s.owner.memberships[0].scope, "firm", "firm scope");
  assertEqual(s.owner.memberships[0].firmSlug, "firm-a", "slug joined in");
  assertEqual(s.clientUser.memberships[0].clientId, s.client1, "client scope carries the client");
  assertEqual(await store.findByAuthSubject("sub-missing"), null, "unknown subject");

  const id = (await s.db.query<{ id: string }>("insert into tenancy.users (auth_subject, email, disabled_at) values ('sub-off', 'off@a.test', now()) returning id")).rows[0].id;
  await assertRejects(() => store.findByAuthSubject("sub-off"), "disabled", "disabled user throws");
  await s.db.query("delete from tenancy.users where id = $1", [id]);
});

test("rls: a client scoped actor sees only its own client's rows through the pool", async () => {
  const s = await seeded();
  assertEqual(await engagementClients(s, s.clientUser), [s.client1], "client user sees one engagement");
  assertEqual(await engagementClients(s, s.owner), [s.client1, s.client2].sort(), "firm owner sees the firm's two");
  assertEqual(await engagementClients(s, s.preparer), [s.client1, s.client2].sort(), "preparer sees the same two");
  assertEqual(await engagementClients(s, s.outsider), [s.clientB], "the other firm sees only its own");
});

test("rls: without the role switch a bypassing connection role sees everything, which is why APP_DB_ROLE exists", async () => {
  const s = await seeded();
  const everything = await engagementClients(s, s.clientUser, {});
  assertEqual(everything, [s.client1, s.client2, s.clientB].sort(), "no role switch, no isolation");
});

test("rls: 0023 stops a client user from listing the firm's other clients", async () => {
  const s = await seeded();
  const names = async (a: Actor) =>
    (await withActor(s.pool, a, (tx) => tx.query<{ name: string }>("select name from tenancy.clients order by name"), AS_APP_WEB)).map((r) => r.name);
  assertEqual(await names(s.clientUser), ["Client One"], "client user sees only their own client row");
  assertEqual(await names(s.owner), ["Client One", "Client Two"], "owner sees the firm's clients");
  assertEqual(await names(s.outsider), ["Client Bee"], "and not the other firm's");
});

test("rls: a client scoped actor cannot write into another client", async () => {
  const s = await seeded();
  await assertRejects(
    () =>
      withActor(
        s.pool,
        s.clientUser,
        (tx) =>
          tx.query(
            "insert into tenancy.engagements (firm_id, client_id, name, status, service_level, start_date, created_by) values ($1, $2, 'Sneaky', 'draft', 'ledger', '2026-02-01', $3)",
            [s.firmA, s.client2, s.clientUser.userId],
          ),
        AS_APP_WEB,
      ),
    "row-level security",
    "insert refused by policy",
  );
  await assertRejects(
    () =>
      withActor(
        s.pool,
        s.clientUser,
        (tx) => tx.query("insert into tenancy.clients (firm_id, name, entity_type) values ($1, 'Sneaky', 'llc')", [s.firmA]),
        AS_APP_WEB,
      ),
    "row-level security",
    "a client user cannot create clients",
  );
  const count = await s.db.query<{ n: string }>("select count(*)::text as n from tenancy.engagements");
  assertEqual(count.rows[0].n, "3", "nothing was written");
});

// ---------------------------------------------------------------------------
// Invitations on the same database
// ---------------------------------------------------------------------------

function scriptedAuthAdmin(): AuthAdmin & { invited: string[]; banned: string[]; existing: Set<string> } {
  const existing = new Set<string>();
  const invited: string[] = [];
  const banned: string[] = [];
  return {
    invited,
    banned,
    existing,
    async inviteByEmail(email) {
      const existed = existing.has(email);
      if (!existed) invited.push(email);
      return { authSubject: `auth-${email}`, existed };
    },
    async ban(sub) {
      banned.push(sub);
    },
  };
}

test("invitations: validation refuses bad shapes with 400s", () => {
  const bad = (body: unknown, code: string) => {
    try {
      validateInvitation(body);
      assert(false, `${code}: accepted`);
    } catch (e) {
      assert(e instanceof InvitationError && e.status === 400 && e.code === code, `${code}: got ${(e as Error).message}`);
    }
  };
  bad(null, "invitations.bad_request");
  bad({ email: "nope", scope: "firm", role: "owner" }, "invitations.bad_email");
  bad({ email: "a@b.co", scope: "global", role: "owner" }, "invitations.bad_scope");
  bad({ email: "a@b.co", scope: "firm", role: "client_user" }, "invitations.bad_role");
  bad({ email: "a@b.co", scope: "client", role: "owner" }, "invitations.bad_role");
  bad({ email: "a@b.co", scope: "client", role: "client_user" }, "invitations.bad_client");
  bad({ email: "a@b.co", scope: "firm", role: "preparer", clientId: CLIENT_1 }, "invitations.bad_client");
  const ok = validateInvitation({ email: " Someone@Example.COM ", scope: "client", role: "client_user", clientId: CLIENT_1, displayName: " S " });
  assertEqual(ok.email, "someone@example.com", "email lowercased and trimmed");
  assertEqual(ok.displayName, "S", "display name trimmed");
});

test("invitations: only owners and managers may invite", () => {
  assertThrows(() => assertCanInvite(membership({ firmId: FIRM_A, scope: "firm", role: "preparer" })), "invitations.forbidden", "preparer");
  assertThrows(() => assertCanInvite(membership({ firmId: FIRM_A, scope: "firm", role: "reviewer" })), "invitations.forbidden", "reviewer");
  assertCanInvite(membership({ firmId: FIRM_A, scope: "firm", role: "manager" }));
  assertCanInvite(membership({ firmId: FIRM_A, scope: "firm", role: "owner" }));
});

test("invitations: create, list, duplicate, client scope checks, and the other firm's client", async () => {
  const s = await seeded();
  const admin = scriptedAuthAdmin();
  const deps: InvitationDeps = { pool: s.pool, authAdmin: admin, appOrigin: "https://app.test", actorOpts: AS_APP_WEB };
  const firm = s.manager.memberships[0];

  const made = await createInvitation(deps, s.manager, firm, { email: "new@one.test", displayName: "New Person", scope: "client", role: "client_user", clientId: s.client1 });
  assert(made.emailSent, "an email went out for a new login");
  assertEqual(admin.invited, ["new@one.test"], "admin invited once");

  const user = await s.db.query<{ invited_by: string; display_name: string }>("select invited_by, display_name from tenancy.users where id = $1", [made.userId]);
  assertEqual(user.rows[0].invited_by, s.manager.userId, "invited_by recorded");
  assertEqual(user.rows[0].display_name, "New Person", "display name stored");
  const mem = await s.db.query<{ granted_by: string; scope: string }>("select granted_by, scope from tenancy.memberships where id = $1", [made.membershipId]);
  assertEqual(mem.rows[0].granted_by, s.manager.userId, "granted_by is the inviter");

  await assertRejects(
    () => createInvitation(deps, s.manager, firm, { email: "new@one.test", scope: "client", role: "client_user", clientId: s.client1 }),
    "invitations.already_member",
    "same access twice is a 409",
  );
  assertEqual(admin.invited.length, 1, "no second email");

  await assertRejects(
    () => createInvitation(deps, s.manager, firm, { email: "x@one.test", scope: "client", role: "client_user", clientId: s.clientB }),
    "invitations.no_client",
    "another firm's client is not found",
  );
  assertEqual(admin.invited.length, 1, "and no auth user was created for it");

  admin.existing.add("has-login@one.test");
  const existing = await createInvitation(deps, s.owner, s.owner.memberships[0], { email: "has-login@one.test", scope: "firm", role: "reviewer" });
  assert(!existing.emailSent, "an existing login gets no email");

  const list = await listInvitations(deps, s.manager, firm);
  const emails = list.map((r) => r.email).sort();
  assert(emails.includes("new@one.test") && emails.includes("has-login@one.test"), "both appear in the list");
  assert(list.every((r) => r.scope === "firm" || r.clientName !== null), "client memberships carry the client name");
  const seenByOutsider = await listInvitations(deps, s.outsider, s.outsider.memberships[0]);
  assert(!seenByOutsider.some((r) => r.email === "new@one.test"), "the other firm does not see it");
});

test("invitations: revoke sets revoked_at, disables the login when it was the last membership, keeps the last owner", async () => {
  const s = await seeded();
  const admin = scriptedAuthAdmin();
  const deps: InvitationDeps = { pool: s.pool, authAdmin: admin, appOrigin: "https://app.test", actorOpts: AS_APP_WEB };
  const firm = s.owner.memberships[0];

  const a = await createInvitation(deps, s.owner, firm, { email: "two-hats@a.test", scope: "firm", role: "preparer" });
  const b = await createInvitation(deps, s.owner, firm, { email: "two-hats@a.test", scope: "client", role: "client_user", clientId: s.client2 });
  assertEqual(a.userId, b.userId, "same person, two memberships");

  const first = await revokeInvitation(deps, s.owner, firm, a.membershipId);
  assert(!first.loginDisabled, "one membership left, login stays");
  assertEqual(admin.banned, [], "not banned yet");
  const second = await revokeInvitation(deps, s.owner, firm, b.membershipId);
  assert(second.loginDisabled, "last membership gone, login disabled");
  assertEqual(admin.banned, [a.authSubject], "auth user banned");
  const u = await s.db.query<{ disabled_at: string | null }>("select disabled_at from tenancy.users where id = $1", [a.userId]);
  assert(u.rows[0].disabled_at !== null, "disabled_at set");
  const store = createPgActorStore(s.pool);
  await assertRejects(() => store.findByAuthSubject(a.authSubject), "disabled", "the next request refuses them");

  await assertRejects(() => revokeInvitation(deps, s.owner, firm, b.membershipId), "invitations.already_revoked", "twice is a 409");

  const ownerMembership = await s.db.query<{ id: string }>("select id from tenancy.memberships where user_id = $1 and role = 'owner'", [s.owner.userId]);
  await assertRejects(() => revokeInvitation(deps, s.owner, firm, ownerMembership.rows[0].id), "invitations.self", "cannot revoke yourself");
  await assertRejects(
    () => revokeInvitation(deps, s.manager, s.manager.memberships[0], ownerMembership.rows[0].id),
    "invitations.last_owner",
    "a manager cannot remove the only owner",
  );
  await assertRejects(() => revokeInvitation(deps, s.preparer, s.preparer.memberships[0], b.membershipId), "invitations.forbidden", "a preparer cannot revoke");

  const outsiderView = await s.db.query<{ id: string }>("select id from tenancy.memberships where user_id = $1 limit 1", [s.manager.userId]);
  await assertRejects(
    () => revokeInvitation(deps, s.outsider, s.outsider.memberships[0], outsiderView.rows[0].id),
    "invitations.not_found",
    "another firm's membership is not found",
  );
});

test("validateRoleChange: refuses a bad body shape or an unknown role", () => {
  assertThrows(() => validateRoleChange(null), "invitations.bad_request", "not an object");
  assertThrows(() => validateRoleChange({}), "invitations.bad_role", "missing role");
  assertThrows(() => validateRoleChange({ role: "superuser" }), "invitations.bad_role", "unknown role");
  assertEqual(validateRoleChange({ role: "manager" }), "manager", "a real role passes through");
});

test("changeMembershipRole: a manager fixes a wrong role, keeps at least one owner, and cannot touch themselves", async () => {
  const s = await seeded();
  const admin = scriptedAuthAdmin();
  const deps: InvitationDeps = { pool: s.pool, authAdmin: admin, appOrigin: "https://app.test", actorOpts: AS_APP_WEB };
  const firm = s.owner.memberships[0];

  const invited = await createInvitation(deps, s.owner, firm, { email: "wrong-role@a.test", scope: "firm", role: "preparer" });
  const out = await changeMembershipRole(deps, s.owner, firm, invited.membershipId, "manager");
  assertEqual(out.role, "manager", "the role is now manager");
  const row = await s.db.query<{ role: string }>("select role from tenancy.memberships where id = $1", [invited.membershipId]);
  assertEqual(row.rows[0].role, "manager", "and it is on record");

  const sameAgain = await changeMembershipRole(deps, s.owner, firm, invited.membershipId, "manager");
  assertEqual(sameAgain.role, "manager", "setting it to what it already is is a no op, not an error");

  await assertRejects(
    () => changeMembershipRole(deps, s.owner, firm, invited.membershipId, "client_user"),
    "invitations.bad_role",
    "a client only role is refused for a firm membership",
  );

  const clientInvited = await createInvitation(deps, s.owner, firm, { email: "client-role@one.test", scope: "client", role: "client_user", clientId: s.client2 });
  await assertRejects(
    () => changeMembershipRole(deps, s.owner, firm, clientInvited.membershipId, "manager"),
    "invitations.bad_role",
    "a firm only role is refused for a client membership",
  );

  const ownerMembership = await s.db.query<{ id: string }>("select id from tenancy.memberships where user_id = $1 and role = 'owner'", [s.owner.userId]);
  await assertRejects(
    () => changeMembershipRole(deps, s.owner, firm, ownerMembership.rows[0].id, "manager"),
    "invitations.self",
    "cannot change your own role",
  );
  await assertRejects(
    () => changeMembershipRole(deps, s.manager, s.manager.memberships[0], ownerMembership.rows[0].id, "manager"),
    "invitations.last_owner",
    "a manager cannot demote the only owner",
  );
  await assertRejects(
    () => changeMembershipRole(deps, s.preparer, s.preparer.memberships[0], invited.membershipId, "owner"),
    "invitations.forbidden",
    "a preparer cannot change anyone's role",
  );

  const revoked = await revokeInvitation(deps, s.owner, firm, invited.membershipId);
  assert(revoked.loginDisabled, "that was this person's only membership, so revoking it disables the login");
  await assertRejects(
    () => changeMembershipRole(deps, s.owner, firm, invited.membershipId, "owner"),
    "invitations.already_revoked",
    "a revoked membership cannot have its role changed",
  );

  const outsiderView = await s.db.query<{ id: string }>("select id from tenancy.memberships where user_id = $1 limit 1", [s.manager.userId]);
  await assertRejects(
    () => changeMembershipRole(deps, s.outsider, s.outsider.memberships[0], outsiderView.rows[0].id, "owner"),
    "invitations.not_found",
    "another firm's membership is not found",
  );
});

// ---------------------------------------------------------------------------
// The routes, over HTTP, with the real middleware and the PGlite database
// ---------------------------------------------------------------------------

import express from "express";
import { createServer } from "node:http";
import { registerRoutes } from "../../routes";
import { applyHardening, finalErrorHandler } from "../../http-hardening";
import { MemoryRunDb } from "../db-memory";
import type { AuthRuntime } from "../../auth/setup";

async function listen(): Promise<{ base: string; close: () => Promise<void>; admin: ReturnType<typeof scriptedAuthAdmin> }> {
  const s = await seeded();
  const admin = scriptedAuthAdmin();
  const verified = (sub: string, email: string): VerifiedToken => ({ subject: sub, email, expiresAt: null, via: "jwks" });
  const verifier = scriptedVerifier({
    "t-owner": verified("sub-owner", "owner@a.test"),
    "t-preparer": verified("sub-preparer", "preparer@a.test"),
    "t-client": verified("sub-client", "client@one.test"),
    "t-outsider": verified("sub-outsider", "owner@b.test"),
    "t-expired": new TokenError("expired", "expired"),
    "t-newclient": verified("sub-newclient", "newclient@one.test"),
  });
  const store = createPgActorStore(s.pool);
  const middleware = createActorMiddleware({
    verifier,
    store,
    clientFirm: async (clientId) => {
      const r = await s.db.query<{ firm_id: string }>("select firm_id from tenancy.clients where id = $1", [clientId]);
      return r.rows[0]?.firm_id ?? null;
    },
  });
  const auth: AuthRuntime = {
    pool: s.pool,
    verifier,
    store,
    authAdmin: admin,
    middleware,
    actorOpts: AS_APP_WEB,
    appOrigin: "https://app.test",
    browserConfig: { supabaseUrl: "https://x.supabase.co", anonKey: "anon-public" },
    notes: [],
  };
  const app = express();
  applyHardening(app, { appOrigin: "https://app.test", supabaseUrl: "https://x.supabase.co", production: true });
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app, { runDb: { kind: "memory", db: new MemoryRunDb(), description: "test" }, auth });
  app.use(finalErrorHandler);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    admin,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

async function call(base: string, path: string, init: RequestInit & { token?: string; firm?: string } = {}) {
  const headers = new Headers(init.headers ?? {});
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.firm) headers.set("x-firm", init.firm);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } & Record<string, unknown>;
  return { status: res.status, body, headers: res.headers };
}

test("http: public config, then every guarded route refuses without a token", async () => {
  const srv = await listen();
  try {
    const cfg = await call(srv.base, "/api/auth/config");
    assertEqual(cfg.status, 200, "config is public");
    assertEqual(cfg.body.configured, true, "configured");
    assertEqual(cfg.body.anonKey, "anon-public", "anon key is the public value");
    assert(!JSON.stringify(cfg.body).includes("service"), "nothing resembling a service key");
    assert((cfg.headers.get("content-security-policy") ?? "").includes("https://x.supabase.co"), "csp names the project");
    assertEqual(cfg.headers.get("x-frame-options"), "DENY", "frame denied");
    assertEqual(cfg.headers.get("x-powered-by"), null, "no server fingerprint");

    for (const [method, path] of [
      ["GET", "/api/auth/me"],
      ["GET", "/api/sched/status"],
      ["GET", "/api/invitations"],
      ["POST", "/api/invitations"],
      ["DELETE", `/api/invitations/${ACTOR_ID}`],
      ["PATCH", `/api/invitations/${ACTOR_ID}`],
    ] as const) {
      const r = await call(srv.base, path, { method });
      assertEqual(r.status, 401, `${method} ${path} without a token`);
      assertEqual(r.body.error?.code, "auth.missing_token", `${method} ${path} code`);
    }
    const expired = await call(srv.base, "/api/auth/me", { token: "t-expired" });
    assertEqual(expired.body.error?.code, "auth.expired_token", "expired token named as such");
    const missing = await call(srv.base, "/api/nothing", { token: "t-owner" });
    assertEqual(missing.status, 404, "unknown api route is a json 404");
  } finally {
    await srv.close();
  }
});

test("http: /api/auth/me and /api/sched/status by actor kind", async () => {
  const srv = await listen();
  try {
    const me = await call(srv.base, "/api/auth/me", { token: "t-client" });
    assertEqual(me.status, 200, "client user can ask who they are");
    assertEqual((me.body.memberships as unknown[]).length, 1, "one membership");

    const sched = await call(srv.base, "/api/sched/status", { token: "t-owner" });
    assertEqual(sched.status, 200, "firm owner reads scheduler status");
    assertEqual(sched.body.configured, true, "configured flag");

    const clientSched = await call(srv.base, "/api/sched/status", { token: "t-client" });
    assertEqual(clientSched.status, 403, "client user has no firm plane");
    assertEqual(clientSched.body.error?.code, "auth.no_firm", "no firm");
  } finally {
    await srv.close();
  }
});

test("http: invitations end to end, with the roles the routes enforce", async () => {
  const srv = await listen();
  const s = await seeded();
  try {
    const bad = await call(srv.base, "/api/invitations", { method: "POST", token: "t-owner", body: JSON.stringify({ email: "nope" }) });
    assertEqual(bad.status, 400, "validation 400");
    assertEqual(bad.body.error?.code, "invitations.bad_email", "bad email");

    const preparer = await call(srv.base, "/api/invitations", {
      method: "POST",
      token: "t-preparer",
      body: JSON.stringify({ email: "http-new@a.test", scope: "firm", role: "reviewer" }),
    });
    assertEqual(preparer.status, 403, "preparer may not invite");

    const made = await call(srv.base, "/api/invitations", {
      method: "POST",
      token: "t-owner",
      body: JSON.stringify({ email: "http-new@a.test", scope: "client", role: "client_user", clientId: s.client2 }),
    });
    assertEqual(made.status, 201, "owner invites");
    assertEqual(made.body.emailSent, true, "email went out");
    assertEqual(srv.admin.invited, ["http-new@a.test"], "admin was called once");

    const list = await call(srv.base, "/api/invitations", { token: "t-owner" });
    assertEqual(list.status, 200, "list");
    const rows = list.body.invitations as { email: string; clientName: string | null }[];
    const row = rows.find((r) => r.email === "http-new@a.test");
    assertEqual(row?.clientName, "Client Two", "client name joined through the actor transaction");

    const outsiderList = await call(srv.base, "/api/invitations", { token: "t-outsider" });
    assert(!(outsiderList.body.invitations as { email: string }[]).some((r) => r.email === "http-new@a.test"), "other firm does not see it");

    const membershipId = made.body.membershipId as string;
    const preparerPatch = await call(srv.base, `/api/invitations/${membershipId}`, { method: "PATCH", token: "t-preparer", body: JSON.stringify({ role: "read_only" }) });
    assertEqual(preparerPatch.status, 403, "a preparer may not change a role either");

    const outsiderPatch = await call(srv.base, `/api/invitations/${membershipId}`, { method: "PATCH", token: "t-outsider", body: JSON.stringify({ role: "read_only" }) });
    assertEqual(outsiderPatch.status, 404, "other firm cannot patch it");

    const badRolePatch = await call(srv.base, `/api/invitations/${membershipId}`, { method: "PATCH", token: "t-owner", body: JSON.stringify({ role: "manager" }) });
    assertEqual(badRolePatch.status, 400, "a firm only role is refused for this client membership");
    assertEqual(badRolePatch.body.error?.code, "invitations.bad_role", "named");

    const patched = await call(srv.base, `/api/invitations/${membershipId}`, { method: "PATCH", token: "t-owner", body: JSON.stringify({ role: "read_only" }) });
    assertEqual(patched.status, 200, "owner changes the role");
    assertEqual(patched.body.role, "read_only", "to read_only");
    const listAfterPatch = await call(srv.base, "/api/invitations", { token: "t-owner" });
    const rowAfterPatch = (listAfterPatch.body.invitations as { membershipId: string; role: string }[]).find((r) => r.membershipId === membershipId);
    assertEqual(rowAfterPatch?.role, "read_only", "and it is on the list");

    const outsiderRevoke = await call(srv.base, `/api/invitations/${made.body.membershipId as string}`, { method: "DELETE", token: "t-outsider" });
    assertEqual(outsiderRevoke.status, 404, "other firm cannot revoke it");

    const revoked = await call(srv.base, `/api/invitations/${made.body.membershipId as string}`, { method: "DELETE", token: "t-owner" });
    assertEqual(revoked.status, 200, "owner revokes");
    assertEqual(revoked.body.loginDisabled, true, "only membership, login disabled");
    assertEqual(srv.admin.banned, ["auth-http-new@a.test"], "banned through the admin api");

    const big = await call(srv.base, "/api/invitations", { method: "POST", token: "t-owner", body: JSON.stringify({ email: "x".repeat(70_000) }) });
    assertEqual(big.status, 413, "oversized body refused by the limit");
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Access requests: a self signed up login, with no tenancy row at all yet,
// asking a specific firm for access -- on the same database as the tests
// above.
// ---------------------------------------------------------------------------

test("access requests: validation refuses bad shapes with 400s", () => {
  const bad = (body: unknown, code: string) => {
    try {
      validateAccessRequestInput(body);
      assert(false, `${code}: accepted`);
    } catch (e) {
      assert(e instanceof AccessRequestError && e.status === 400 && e.code === code, `${code}: got ${(e as Error).message}`);
    }
  };
  bad(null, "access_requests.bad_request");
  bad({ firmSlug: "Not A Slug!", requestedClientName: "Acme" }, "access_requests.bad_slug");
  bad({ firmSlug: "firm-a", requestedClientName: "" }, "access_requests.bad_client_name");
  const ok = validateAccessRequestInput({ firmSlug: " Firm-A ", requestedClientName: "  Acme LLC  ", message: "  hi  " });
  assertEqual(ok.firmSlug, "firm-a", "slug trimmed and lowercased");
  assertEqual(ok.requestedClientName, "Acme LLC", "client name trimmed");
  assertEqual(ok.message, "hi", "message trimmed");
  const okNoMessage = validateAccessRequestInput({ firmSlug: "firm-a", requestedClientName: "Acme" });
  assertEqual(okNoMessage.message, null, "message defaults to null");
});

test("access requests: lookupFirmBySlug finds an active firm by slug, nothing otherwise", async () => {
  const s = await seeded();
  const firm = await lookupFirmBySlug(s.pool, "firm-a");
  assertEqual(firm?.name, "Firm A", "found by slug");
  assertEqual(await lookupFirmBySlug(s.pool, "no-such-firm"), null, "unknown slug");
});

test("access requests: submit, duplicate pending, unknown firm, and only the requester's own rows come back", async () => {
  const s = await seeded();
  const deps: AccessRequestDeps = { pool: s.pool, actorOpts: AS_APP_WEB };
  const verified = { subject: "sub-new-1", email: "new1@client.test" };

  await assertRejects(
    () => submitAccessRequest(deps, verified, { firmSlug: "no-such-firm", requestedClientName: "Acme", message: null }),
    "access_requests.no_firm",
    "unknown slug refused",
  );

  const made = await submitAccessRequest(deps, verified, { firmSlug: "firm-a", requestedClientName: "Acme LLC", message: "I bank with you already" });
  assertEqual(made.status, "pending", "starts pending");
  assertEqual(made.firmName, "Firm A", "firm name carried");

  await assertRejects(
    () => submitAccessRequest(deps, verified, { firmSlug: "firm-a", requestedClientName: "Acme LLC", message: null }),
    "access_requests.already_pending",
    "a second request to the same firm while one is pending is refused",
  );

  // A different firm is fine even while one request is still pending.
  const second = await submitAccessRequest(deps, verified, { firmSlug: "firm-b", requestedClientName: "Acme LLC", message: null });
  assertEqual(second.firmName, "Firm B", "second firm accepted");

  const mine = await myAccessRequests(deps, verified);
  assertEqual(mine.map((r) => r.firmName).sort(), ["Firm A", "Firm B"], "both of this subject's requests come back");

  const someoneElse = await myAccessRequests(deps, { subject: "sub-nobody-else" });
  assertEqual(someoneElse, [], "a different subject sees none of it, even through the same connection");
});

async function asRequester<T>(s: Seed, subject: string, fn: (query: <R>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
  const client = await s.pool.connect();
  await client.query("begin");
  try {
    await client.query("set local role app_web");
    await client.query("select set_config('app.requesting_subject', $1, true)", [subject]);
    const out = await fn(async <R>(sql: string, params: unknown[] = []) => (await client.query<R>(sql, params)).rows);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  }
}

test("rls: access_requests insert and self read are scoped to the verified subject, a real policy and not application code's word alone", async () => {
  const s = await seeded();
  const deps: AccessRequestDeps = { pool: s.pool, actorOpts: AS_APP_WEB };
  await submitAccessRequest(deps, { subject: "sub-honest", email: "honest@client.test" }, { firmSlug: "firm-a", requestedClientName: "Honest Co", message: null });

  await assertRejects(
    () =>
      asRequester(s, "sub-attacker", (query) =>
        query(`insert into tenancy.access_requests (auth_subject, email, firm_id, requested_client_name) values ($1, $2, $3, $4)`, [
          "sub-victim",
          "victim@client.test",
          s.firmA,
          "Not mine",
        ]),
      ),
    "row-level security",
    "a session cannot insert a request naming a different subject than the one its own token verified",
  );

  const seenByAttacker = await asRequester(s, "sub-attacker", (query) => query<{ id: string }>("select id from tenancy.access_requests"));
  assertEqual(seenByAttacker, [], "and cannot read the honest row either, the same policy");

  const seenByHonest = await asRequester(s, "sub-honest", (query) => query<{ email: string }>("select email from tenancy.access_requests"));
  assertEqual(seenByHonest.map((r) => r.email), ["honest@client.test"], "the actual requester sees their own row");
});

test("access requests: the firm queue shows its own pending requests, not another firm's", async () => {
  const s = await seeded();
  const deps: AccessRequestDeps = { pool: s.pool, actorOpts: AS_APP_WEB };
  await submitAccessRequest(deps, { subject: "sub-queue-1", email: "q1@client.test" }, { firmSlug: "firm-a", requestedClientName: "Queue One", message: null });
  await submitAccessRequest(deps, { subject: "sub-queue-2", email: "q2@client.test" }, { firmSlug: "firm-b", requestedClientName: "Queue Two", message: null });

  const firmAQueue = await listAccessRequests(deps, s.owner, s.owner.memberships[0]);
  assert(firmAQueue.some((r) => r.email === "q1@client.test"), "firm a sees its own");
  assert(!firmAQueue.some((r) => r.email === "q2@client.test"), "not firm b's");

  const firmBQueue = await listAccessRequests(deps, s.outsider, s.outsider.memberships[0]);
  assert(firmBQueue.some((r) => r.email === "q2@client.test"), "firm b sees its own");
});

test("access requests: approve creates the user and membership, resolves the row, and refuses a second approval", async () => {
  const s = await seeded();
  const deps: AccessRequestDeps = { pool: s.pool, actorOpts: AS_APP_WEB };
  const firm = s.owner.memberships[0];
  const made = await submitAccessRequest(
    deps,
    { subject: "sub-approve-1", email: "approve1@client.test" },
    { firmSlug: "firm-a", requestedClientName: "Approve One", message: null },
  );

  await assertRejects(
    () => approveAccessRequest(deps, s.preparer, s.preparer.memberships[0], made.id, { clientId: s.client1 }),
    "invitations.forbidden",
    "a preparer cannot approve",
  );
  await assertRejects(
    () => approveAccessRequest(deps, s.owner, firm, made.id, { clientId: s.clientB }),
    "access_requests.no_client",
    "a client belonging to another firm is refused",
  );
  await assertRejects(
    () => approveAccessRequest(deps, s.owner, firm, made.id, { clientId: s.client1, role: "owner" }),
    "access_requests.bad_role",
    "a firm role is not a valid grant for a client request",
  );

  const out = await approveAccessRequest(deps, s.owner, firm, made.id, { clientId: s.client1 });
  assert(!!out.membershipId, "membership created");

  const row = await s.db.query<{ status: string }>(`select status from tenancy.access_requests where id = $1`, [made.id]);
  assertEqual(row.rows[0].status, "approved", "request marked approved");
  const user = await s.db.query<{ invited_by: string | null }>(`select invited_by from tenancy.users where id = $1`, [out.userId]);
  assertEqual(user.rows[0].invited_by, null, "nobody invited this person, they asked first");

  await assertRejects(
    () => approveAccessRequest(deps, s.owner, firm, made.id, { clientId: s.client1 }),
    "access_requests.already_resolved",
    "a resolved request cannot be approved twice",
  );

  const again = await submitAccessRequest(
    deps,
    { subject: "sub-approve-1", email: "approve1@client.test" },
    { firmSlug: "firm-a", requestedClientName: "Approve One, again", message: null },
  );
  await assertRejects(
    () => approveAccessRequest(deps, s.owner, firm, again.id, { clientId: s.client1 }),
    "access_requests.already_member",
    "the same access twice is a 409, the same as an invitation would refuse it",
  );
});

test("access requests: reject requires a reason, is firm staff only, and never creates a membership", async () => {
  const s = await seeded();
  const deps: AccessRequestDeps = { pool: s.pool, actorOpts: AS_APP_WEB };
  const firm = s.owner.memberships[0];
  const made = await submitAccessRequest(
    deps,
    { subject: "sub-reject-1", email: "reject1@client.test" },
    { firmSlug: "firm-a", requestedClientName: "Reject One", message: null },
  );

  await assertRejects(() => rejectAccessRequest(deps, s.owner, firm, made.id, "   "), "access_requests.bad_reason", "blank reason refused");
  await assertRejects(
    () => rejectAccessRequest(deps, s.preparer, s.preparer.memberships[0], made.id, "no thanks"),
    "invitations.forbidden",
    "a preparer cannot reject",
  );

  const out = await rejectAccessRequest(deps, s.owner, firm, made.id, "We could not verify this business.");
  assertEqual(out.id, made.id, "resolved");

  const mine = await myAccessRequests(deps, { subject: "sub-reject-1" });
  assertEqual(mine[0].status, "rejected", "the requester can see why");
  assertEqual(mine[0].rejectionReason, "We could not verify this business.", "reason carried");

  await assertRejects(() => rejectAccessRequest(deps, s.owner, firm, made.id, "again"), "access_requests.already_resolved", "cannot reject twice");
});

test("http: access requests end to end -- sign up with no tenancy row, ask a real firm, get approved, then sign in for real", async () => {
  const srv = await listen();
  const s = await seeded();
  try {
    const me = await call(srv.base, "/api/auth/me", { token: "t-newclient" });
    assertEqual(me.status, 401, "requireUser refuses an unknown subject");
    assertEqual(me.body.error?.code, "auth.no_user", "no_user");

    const found = await call(srv.base, "/api/public/firms/firm-a");
    assertEqual(found.status, 200, "public firm lookup needs no token at all");
    assertEqual(found.body.name, "Firm A", "firm a");
    const notFound = await call(srv.base, "/api/public/firms/no-such-firm");
    assertEqual(notFound.status, 404, "unknown code");

    const badFirm = await call(srv.base, "/api/access-requests", {
      method: "POST",
      token: "t-newclient",
      body: JSON.stringify({ firmSlug: "no-such-firm", requestedClientName: "New Co" }),
    });
    assertEqual(badFirm.status, 404, "an unknown sign up code is refused before anything is written");

    const submitted = await call(srv.base, "/api/access-requests", {
      method: "POST",
      token: "t-newclient",
      body: JSON.stringify({ firmSlug: "firm-a", requestedClientName: "New Co" }),
    });
    assertEqual(submitted.status, 201, "requireToken lets this same unknown subject through for this one route");
    assertEqual(submitted.body.status, "pending", "pending");

    const mine = await call(srv.base, "/api/access-requests/mine", { token: "t-newclient" });
    assertEqual((mine.body.requests as { firmName: string }[])[0]?.firmName, "Firm A", "the requester can see their own pending request");

    const preparerSees = await call(srv.base, "/api/access-requests", { token: "t-preparer" });
    assert((preparerSees.body.requests as { email: string }[]).some((r) => r.email === "newclient@one.test"), "firm staff see the pending request");

    const preparerApprove = await call(srv.base, `/api/access-requests/${submitted.body.id as string}/approve`, {
      method: "POST",
      token: "t-preparer",
      body: JSON.stringify({ clientId: s.client1 }),
    });
    assertEqual(preparerApprove.status, 403, "a preparer cannot approve");

    const approved = await call(srv.base, `/api/access-requests/${submitted.body.id as string}/approve`, {
      method: "POST",
      token: "t-owner",
      body: JSON.stringify({ clientId: s.client1 }),
    });
    assertEqual(approved.status, 200, "owner approves");

    const after = await call(srv.base, "/api/auth/me", { token: "t-newclient" });
    assertEqual(after.status, 200, "the exact same token that could not sign in before now can");
    assertEqual((after.body.memberships as { clientId: string | null }[])[0]?.clientId, s.client1, "scoped to the client the firm chose, nothing it asked for on its own");
  } finally {
    await srv.close();
  }
});
