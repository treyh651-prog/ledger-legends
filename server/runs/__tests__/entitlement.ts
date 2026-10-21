/**
 * Service tiers: inclusion by rank, denial below rank, add ons granting
 * nothing, and the database refusing a level that is not a tier.
 *
 * Everything but the last test runs against the memory source. The last one
 * needs Postgres, because the thing under test is a foreign key, and it is
 * skipped with a printed note when DATABASE_URL is not set.
 */

import {
  FEATURES,
  TIER_ORDER,
  TIERS,
  featuresAtTier,
  featuresForTier,
  hasFeature,
  tierRank,
  type FeatureKey,
  type TierId,
} from "../../../shared/tiers";
import {
  FeatureNotInTierError,
  MemoryEntitlementSource,
  assertFeature,
  entitles,
  loadEntitlement,
  requireFeature,
  type Entitlement,
  type MemoryEngagement,
} from "../../entitlement";
import { assert, assertEqual, assertRejects, assertThrows, test } from "./harness";

const TODAY = "2026-10-20";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function engagement(level: string, overrides: Partial<MemoryEngagement> = {}): MemoryEngagement {
  return {
    clientId: CLIENT,
    serviceLevel: level,
    status: "active",
    startDate: "2026-01-01",
    endDate: null,
    ...overrides,
  };
}

/* ---------------- The shared map itself ---------------- */

test("the three tiers are ranked in order and every feature names one of them", () => {
  assertEqual(TIER_ORDER, ["ledger", "ledger_plus", "legend"], "tier order");
  TIER_ORDER.forEach((id, i) => assertEqual(tierRank(id), i, `rank of ${id}`));
  for (const f of FEATURES) {
    assert((TIER_ORDER as readonly string[]).includes(f.minTier), `${f.id} names a tier`);
  }
});

test("each feature appears once, at its lowest tier, and higher tiers derive it by rank", () => {
  const seen = new Set<string>();
  for (const f of FEATURES) {
    assert(!seen.has(f.id), `${f.id} listed twice`);
    seen.add(f.id);
  }
  const counted = TIER_ORDER.reduce((n, t) => n + featuresAtTier(t).length, 0);
  assertEqual(counted, FEATURES.length, "featuresAtTier partitions the map");
  assertEqual(featuresForTier("legend").length, FEATURES.length, "the top tier includes everything");
  assert(
    featuresForTier("ledger").length < featuresForTier("ledger_plus").length &&
      featuresForTier("ledger_plus").length < featuresForTier("legend").length,
    "each tier includes more than the one below",
  );
});

test("the pricing page's placements hold", () => {
  const expectLowest: Record<FeatureKey, TierId> = {
    statements: "ledger",
    transactions: "ledger",
    documents: "ledger",
    requests: "ledger",
    messages: "ledger",
    reconciliation_status: "ledger",
    bank_rules: "ledger",
    aging: "ledger_plus",
    compare: "ledger_plus",
    quarterly_summary: "ledger_plus",
    priority_support: "ledger_plus",
    custom_reports: "legend",
    budget: "legend",
    forecast: "legend",
    narrative: "legend",
    scenarios: "legend",
    consolidation: "legend",
    open_period: "legend",
    loans: "legend",
    monthly_review: "legend",
    cpa_packet: "legend",
  };
  for (const f of FEATURES) {
    assertEqual(f.minTier, expectLowest[f.id], `lowest tier for ${f.id}`);
  }
  assertEqual(Object.keys(expectLowest).length, FEATURES.length, "every key is accounted for");
});

test("hasFeature is inclusion by rank", () => {
  assert(hasFeature("ledger", "statements"), "ledger has statements");
  assert(hasFeature("ledger_plus", "statements"), "ledger_plus inherits statements");
  assert(hasFeature("legend", "statements"), "legend inherits statements");
  assert(hasFeature("ledger_plus", "aging"), "ledger_plus has aging");
  assert(hasFeature("legend", "aging"), "legend inherits aging");
  assert(hasFeature("legend", "cpa_packet"), "legend has the CPA packet");
});

test("hasFeature denies below rank", () => {
  assert(!hasFeature("ledger", "aging"), "ledger has no aging");
  assert(!hasFeature("ledger", "compare"), "ledger has no compare");
  assert(!hasFeature("ledger", "budget"), "ledger has no budget");
  assert(!hasFeature("ledger_plus", "budget"), "budget is Legend, the page says nothing about budgets at Ledger+");
  assert(!hasFeature("ledger_plus", "open_period"), "accrual tracking is Legend");
  assert(!hasFeature("ledger_plus", "forecast"), "forecast is Legend");
  assert(!hasFeature("ledger_plus", "cpa_packet"), "the CPA packet is Legend");
});

test("no tier carries a price", () => {
  for (const id of TIER_ORDER) {
    const meta = TIERS[id] as unknown as Record<string, unknown>;
    for (const key of Object.keys(meta)) {
      assert(!/price|amount|usd|dollar|checkout|plan/i.test(key), `${id}.${key} looks like a price`);
    }
    assert(!/\$\s*\d/.test(TIERS[id].tagline), `${id} tagline carries a dollar amount`);
  }
  for (const f of FEATURES) {
    assert(!/\$\s*\d/.test(f.summary) && !/\$\s*\d/.test(f.label), `${f.id} copy carries a dollar amount`);
  }
});

/* ---------------- The memory source and the loader ---------------- */

test("loadEntitlement returns the view's shape and matches hasFeature at every tier", async () => {
  for (const tier of TIER_ORDER) {
    const src = new MemoryEntitlementSource([engagement(tier)], [], TODAY);
    const ent = await loadEntitlement(src, CLIENT);
    assertEqual(ent.tier, tier, `tier for ${tier}`);
    assertEqual(ent.rank, tierRank(tier), `rank for ${tier}`);
    for (const f of FEATURES) {
      assertEqual(entitles(ent, f.id), hasFeature(tier, f.id), `${tier} ${f.id}`);
    }
  }
});

test("a client with no active engagement is entitled to nothing", async () => {
  const src = new MemoryEntitlementSource(
    [
      engagement("legend", { status: "draft" }),
      engagement("legend", { status: "terminated", endDate: "2026-06-30" }),
      engagement("legend", { startDate: "2027-01-01" }),
      engagement("legend", { clientId: OTHER }),
    ],
    [],
    TODAY,
  );
  const ent = await loadEntitlement(src, CLIENT);
  assertEqual(ent.tier, null, "no tier");
  assertEqual(ent.features.size, 0, "no features");
  assertThrows(() => assertFeature(ent, "statements"), "FEATURE_NOT_IN_TIER", "even own records need an engagement");
});

test("add ons grant no feature", async () => {
  const withAddons = new MemoryEntitlementSource(
    [engagement("ledger")],
    [
      { clientId: CLIENT, addon: "payroll", startedAt: "2026-01-01", endedAt: null },
      { clientId: CLIENT, addon: "cleanup", startedAt: "2026-01-01", endedAt: null },
    ],
    TODAY,
  );
  const without = new MemoryEntitlementSource([engagement("ledger")], [], TODAY);
  assertEqual(withAddons.addonCount(CLIENT), 2, "both add ons are on file");
  const a = await loadEntitlement(withAddons, CLIENT);
  const b = await loadEntitlement(without, CLIENT);
  assertEqual([...a.features].sort(), [...b.features].sort(), "same features with and without add ons");
  assert(!entitles(a, "aging"), "payroll does not unlock Ledger+");
  assert(!entitles(a, "cpa_packet"), "cleanup does not unlock Legend");
});

test("the memory source refuses a level the database would refuse", () => {
  assertThrows(
    () => new MemoryEntitlementSource([engagement("story")], [], TODAY),
    "UNKNOWN_SERVICE_LEVEL",
    "story is not a tier",
  );
  assertThrows(
    () => new MemoryEntitlementSource([engagement("journey")], [], TODAY),
    "UNKNOWN_SERVICE_LEVEL",
    "journey is not a tier",
  );
});

test("two active engagements for one client is an error, as the unique index says", async () => {
  const src = new MemoryEntitlementSource([engagement("ledger"), engagement("legend")], [], TODAY);
  await assertRejects(() => loadEntitlement(src, CLIENT), "active engagements", "the memory source refuses");
});

/* ---------------- The middleware ---------------- */

function fakeResponse() {
  const out: { status: number | null; body: unknown; locals: Record<string, unknown> } = {
    status: null,
    body: null,
    locals: {},
  };
  const res = {
    locals: out.locals,
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  return { res, out };
}

async function runMiddleware(key: FeatureKey, ent: Entitlement) {
  const mw = requireFeature(key, async () => ent);
  const { res, out } = fakeResponse();
  let nextCalledWith: unknown = "not called";
  await new Promise<void>((resolve) => {
    mw(
      {} as never,
      res as never,
      ((err?: unknown) => {
        nextCalledWith = err;
        resolve();
      }) as never,
    );
    // The refusal path never calls next, so give the promise chain a tick.
    setTimeout(resolve, 5);
  });
  return { out, nextCalledWith };
}

test("requireFeature lets an entitled request through and leaves the entitlement on res.locals", async () => {
  const ent = await loadEntitlement(new MemoryEntitlementSource([engagement("legend")], [], TODAY), CLIENT);
  const { out, nextCalledWith } = await runMiddleware("forecast", ent);
  assertEqual(nextCalledWith, undefined, "next called with no error");
  assertEqual(out.status, null, "no status written");
  assert(out.locals.entitlement === ent, "entitlement left for the handler");
});

test("requireFeature refuses below rank with a 403 and a code, and no upgrade link", async () => {
  const ent = await loadEntitlement(new MemoryEntitlementSource([engagement("ledger")], [], TODAY), CLIENT);
  const { out, nextCalledWith } = await runMiddleware("aging", ent);
  assertEqual(nextCalledWith, "not called", "next not called");
  assertEqual(out.status, 403, "forbidden");
  const body = out.body as { code: string; message: string };
  assertEqual(body.code, "FEATURE_NOT_IN_TIER", "code");
  assert(body.message.includes("Ledger+"), "names the tier that includes it");
  assert(!/upgrade|buy|checkout|\$/i.test(body.message), "no sales copy in a refusal");
  assert(new FeatureNotInTierError(CLIENT, "aging", "ledger").status === 403, "error carries 403");
});

/* ---------------- Postgres ---------------- */

const DATABASE_URL = process.env.DATABASE_URL;

if (DATABASE_URL === undefined || DATABASE_URL.trim() === "") {
  console.log(
    "  note  DATABASE_URL is not set, so the Postgres test for the service_level foreign key is skipped",
  );
} else {
  test("Postgres refuses an engagement whose service_level is not a tier", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const firm = await client.query<{ id: string }>(
        "insert into tenancy.firms (name, slug) values ('tier test firm', 'tier-test-' || gen_random_uuid()::text) returning id",
      );
      const firmId = firm.rows[0].id;
      const cl = await client.query<{ id: string }>(
        "insert into tenancy.clients (firm_id, name, entity_type) values ($1, 'tier test client', 'llc') returning id",
        [firmId],
      );
      const clientId = cl.rows[0].id;
      let code = "";
      try {
        await client.query(
          `insert into tenancy.engagements (firm_id, client_id, name, status, service_level, start_date, created_by)
           values ($1, $2, 'bad level', 'draft', 'story', current_date, $3)`,
          [firmId, clientId, "00000000-0000-4000-8000-000000000000"],
        );
      } catch (err) {
        code = String((err as { code?: string }).code ?? "");
      }
      assertEqual(code, "23503", "foreign key violation on service_level");
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  });
}
