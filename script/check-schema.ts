/**
 * Every table name the run port can address has to exist in real Postgres.
 *
 * The runs were built against the in memory port, where a table exists the
 * moment something writes to it. Migrations 0001 through 0018 applied cleanly
 * and still left eleven `RowMap` keys pointing at nothing, which no test could
 * catch because no test touched a database. This is the gate that would have
 * caught them, and it is the gate that catches the next one.
 *
 * How it works:
 *   The key list is parsed out of the `export interface RowMap` block in
 *   `server/runs/tables.ts`, so a key added there is checked here without
 *   anybody remembering to add it twice. The parser lives in
 *   `script/row-map-keys.ts` because `script/db-verify.ts` asks the same
 *   question of the live connection and two parsers would drift.
 *   Resolution imports `PHYSICAL_TABLES` and `physical` from the Postgres port
 *   itself. A second copy of the map would drift, and a drifted copy of the
 *   map is the bug this gate exists to find.
 *   The database is read through the Supabase connector, which holds its own
 *   credentials. Nothing here reads, asks for, or stores a password.
 *
 * Views count. `ledger.chart_accounts` is a view over `ledger.accounts` and is
 * a legitimate target for a run write, so the existence query unions
 * pg_catalog relation kinds r, p and v.
 *
 * Two more checks were added with migration 0020, because a gate that only
 * asks whether a table exists cannot see either of the defects that migration
 * repaired.
 *
 *   Run id width. A run id is a prefix plus a 26 character ULID, and the widths
 *   are imported from `server/runs/ids.ts` rather than written down again here.
 *   Migrations 0003 through 0014 sized these columns char(26), so the first run
 *   to write to Postgres would have refused part way through. Any run id column
 *   that is a fixed width character type, or narrower than the id it holds,
 *   fails the gate.
 *
 *   Array columns. The port JSON stringifies every array before it reaches the
 *   driver, so a text[] or char(26)[] column refuses the literal with 22P02. No
 *   column of a table the row map addresses may be an array type.
 *
 * A fourth check came with migration 0024. tenancy.service_tiers and
 * tenancy.tier_features are seeded from shared/tiers.ts, and a feature moved
 * between tiers in TypeScript without a migration would let the portal show
 * a screen the database says the client is not entitled to. Both tables are
 * read back and compared field by field.
 *
 * Run it with: npx tsx script/check-schema.ts
 */

import { PHYSICAL_TABLES, physical } from "../server/runs/db-postgres";
import { RUN_EXECUTION_ID_WIDTH, SEQUENCE_ID_WIDTH } from "../server/runs/ids";
import type { TableName } from "../server/runs/tables";
import { RUN_POLICIES } from "../server/runs/policy";
import { registry } from "../server/runs/registry";
import { FEATURES, TIER_ORDER, TIERS } from "../shared/tiers";
import { PROJECT_ID, query } from "./connector-sql";
import { rowMapKeys } from "./row-map-keys";

const keys = rowMapKeys();
const wanted = new Map<string, string>();
for (const key of keys) wanted.set(key, physical(key as TableName));

const present = new Set<string>();
for (const row of query(
  `select n.nspname || '.' || c.relname as name
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v')
      and n.nspname not in ('pg_catalog', 'information_schema')`,
)) {
  present.add(String(row.name));
}

const missing: string[] = [];
for (const [key, table] of wanted) {
  if (!present.has(table)) missing.push(`${key} -> ${table}`);
}

// A physical name that is mapped but absent from RowMap is not an error, it is
// a table some other part of the system owns. A mapped name that points at
// nothing is an error either way, so check the whole map and not only the keys.
for (const [key, table] of Object.entries(PHYSICAL_TABLES)) {
  if (table && !present.has(table) && !missing.some((m) => m.endsWith(`-> ${table}`))) {
    missing.push(`${key} -> ${table} (mapped, unused by RowMap)`);
  }
}

// ---------------------------------------------------------------------------
// The compliance tiers, migration 0022.
//
// sched.run_policies is seeded from RUN_POLICIES in server/runs/policy.ts and
// nothing stops the two from drifting except this. A run reclassified in
// TypeScript without a migration is the failure mode that matters: the
// executor guard would refuse a run the database still thinks is unattended,
// or worse, allow one the database thinks is not. Read the table back and
// compare all three fields.
// ---------------------------------------------------------------------------

const tierProblems: string[] = [];
const liveTiers = new Map<string, { tier: string; reason: string; writes: boolean }>();
for (const row of query(
  "select run_type, tier, reason, writes_ledger from sched.run_policies",
)) {
  liveTiers.set(String(row.run_type), {
    tier: String(row.tier),
    reason: String(row.reason),
    writes: row.writes_ledger === true || row.writes_ledger === "true",
  });
}
for (const entry of registry) {
  const want = RUN_POLICIES[entry.type];
  const live = liveTiers.get(entry.type);
  if (!want) {
    tierProblems.push(`${entry.type} has no entry in RUN_POLICIES`);
    continue;
  }
  if (!live) {
    tierProblems.push(`${entry.type} is missing from sched.run_policies`);
    continue;
  }
  if (live.tier !== want.tier) {
    tierProblems.push(
      `${entry.type} is ${live.tier} in the database and ${want.tier} in policy.ts`,
    );
  }
  if (live.reason !== want.reason) {
    tierProblems.push(`${entry.type} carries a different reason in the database`);
  }
  if (live.writes !== entry.writesLedger) {
    tierProblems.push(
      `${entry.type} writes_ledger is ${String(live.writes)} in the database and ${String(entry.writesLedger)} in the registry`,
    );
  }
  if (entry.writesLedger && want.tier === "unattended") {
    tierProblems.push(`${entry.type} posts to the ledger and is classified unattended`);
  }
}
for (const type of liveTiers.keys()) {
  if (!registry.some((e) => e.type === type)) {
    tierProblems.push(`${type} is in sched.run_policies and not in the registry`);
  }
}

console.log(`Checked ${keys.length} row map keys against ${present.size} relations in ${PROJECT_ID}.`);

// ---------------------------------------------------------------------------
// Run id widths, migration 0020.
// ---------------------------------------------------------------------------

/** The schemas this project owns. Supabase owns the rest of the database. */
const OWNED_SCHEMAS = [
  "close", "deliverable", "docvault", "entitlement", "import", "intake",
  "ledger", "practice", "report", "sched", "subledger", "tax", "tenancy",
];

/**
 * Columns whose name ends in run_id but whose row field is typed `Ulid`, so the
 * value is an entity id and not a run execution id. Each one is a foreign key
 * into the table that mints it, and widening them would both say something
 * untrue and break the reference.
 */
const ENTITY_ID_COLUMNS = new Set([
  "ledger.close_gate_results.close_run_id",
  "report.cash_forecast_weeks.forecast_run_id",
  "subledger.pay_register_entries.pay_run_id",
]);

/**
 * Columns named `id` on a run log table that hold a plain ULID rather than a
 * run id. A log item and a log event each get their own ULID, and only the
 * run_log row is keyed by the run execution id.
 */
const PLAIN_ULID_IDS = /^ledger\.run_log_(items|events)(_\d{4}_\d{2})?\.id$/;

/** Sequence ids carry the longer prefix, so they need the larger width. */
function requiredWidth(column: string): number {
  return column === "sequence_id" ? SEQUENCE_ID_WIDTH : RUN_EXECUTION_ID_WIDTH;
}

const schemaList = OWNED_SCHEMAS.map((s) => `'${s}'`).join(", ");

const runIdRows = query(
  `select c.table_schema || '.' || c.table_name as tbl, c.column_name as col,
          c.data_type as kind, c.character_maximum_length as len
     from information_schema.columns c
     join pg_class cl on cl.relname = c.table_name
     join pg_namespace ns on ns.oid = cl.relnamespace and ns.nspname = c.table_schema
    where c.table_schema in (${schemaList})
      and cl.relkind in ('r', 'p')
      and (c.column_name ~ '(^|_)run_id$' or c.column_name ~ '(^|_)run_ids$'
           or c.column_name in ('run_execution_id', 'sequence_id')
           or (c.table_name like 'run_log%' and c.column_name = 'id')
           or (c.table_name = 'run_sequences' and c.column_name = 'id'))`,
);

const tooNarrow: string[] = [];
let runIdChecked = 0;
for (const row of runIdRows) {
  const name = `${String(row.tbl)}.${String(row.col)}`;
  if (ENTITY_ID_COLUMNS.has(name) || PLAIN_ULID_IDS.test(name)) continue;
  const kind = String(row.kind);
  if (kind === "jsonb" || kind === "text") {
    runIdChecked += 1;
    continue;
  }
  runIdChecked += 1;
  const width = requiredWidth(String(row.col));
  const len = row.len === null ? 0 : Number(row.len);
  if (kind === "character") {
    // Blank padded as well as usually short. Either way it is not the type the
    // rest of the run id columns are.
    tooNarrow.push(`${name} is char(${len}), wanted text holding ${width}`);
  } else if (len < width) {
    tooNarrow.push(`${name} is ${kind}(${len}), wanted at least ${width}`);
  }
}

// ---------------------------------------------------------------------------
// Array columns, migration 0020 sections 2 and 3.
// ---------------------------------------------------------------------------

const mapped = new Set(Array.from(wanted.values()));
// ---------------------------------------------------------------------------
// tenancy.service_tiers and tenancy.tier_features are seeded from
// shared/tiers.ts. Each feature is stored once, at its lowest tier, so the
// comparison is one row per feature key in both directions.
// ---------------------------------------------------------------------------

const serviceTierProblems: string[] = [];
const tierTablesPresent =
  present.has("tenancy.service_tiers") && present.has("tenancy.tier_features");
if (!tierTablesPresent) {
  serviceTierProblems.push(
    "tenancy.service_tiers or tenancy.tier_features is missing, migration 0024 is not applied",
  );
} else {
  const liveServiceTiers = new Map<
    string,
    { name: string; rank: number; tagline: string; floor: number; ceiling: number | null }
  >();
  for (const row of query(
    "select id, name, rank, tagline, revenue_floor_cents, revenue_ceiling_cents from tenancy.service_tiers",
  )) {
    liveServiceTiers.set(String(row.id), {
      name: String(row.name),
      rank: Number(row.rank),
      tagline: String(row.tagline),
      floor: Number(row.revenue_floor_cents),
      ceiling: row.revenue_ceiling_cents === null ? null : Number(row.revenue_ceiling_cents),
    });
  }
  for (const id of TIER_ORDER) {
    const want = TIERS[id];
    const live = liveServiceTiers.get(id);
    if (!live) {
      serviceTierProblems.push(`${id} is missing from tenancy.service_tiers`);
      continue;
    }
    if (live.name !== want.name) serviceTierProblems.push(`${id} is named ${live.name} in the database`);
    if (live.rank !== want.rank) {
      serviceTierProblems.push(`${id} is rank ${String(live.rank)} in the database and ${String(want.rank)} in tiers.ts`);
    }
    if (live.tagline !== want.tagline) serviceTierProblems.push(`${id} carries a different tagline in the database`);
    if (live.floor !== want.revenueFloorCents || live.ceiling !== want.revenueCeilingCents) {
      serviceTierProblems.push(`${id} carries a different revenue band in the database`);
    }
  }
  for (const id of liveServiceTiers.keys()) {
    if (!(TIER_ORDER as readonly string[]).includes(id)) {
      serviceTierProblems.push(`${id} is in tenancy.service_tiers and not in tiers.ts`);
    }
  }

  const liveFeatures = new Map<string, { tier: string; label: string; summary: string }>();
  for (const row of query(
    "select tier_id, feature_key, label, summary from tenancy.tier_features",
  )) {
    liveFeatures.set(String(row.feature_key), {
      tier: String(row.tier_id),
      label: String(row.label),
      summary: String(row.summary),
    });
  }
  for (const f of FEATURES) {
    const live = liveFeatures.get(f.id);
    if (!live) {
      serviceTierProblems.push(`${f.id} is missing from tenancy.tier_features`);
      continue;
    }
    if (live.tier !== f.minTier) {
      serviceTierProblems.push(`${f.id} is at ${live.tier} in the database and ${f.minTier} in tiers.ts`);
    }
    if (live.label !== f.label) serviceTierProblems.push(`${f.id} carries a different label in the database`);
    if (live.summary !== f.summary) serviceTierProblems.push(`${f.id} carries a different summary in the database`);
  }
  for (const key of liveFeatures.keys()) {
    if (!FEATURES.some((f) => f.id === key)) {
      serviceTierProblems.push(`${key} is in tenancy.tier_features and not in tiers.ts`);
    }
  }
}

const arrays: string[] = [];
for (const row of query(
  `select c.table_schema || '.' || c.table_name as tbl, c.column_name as col,
          c.udt_name as udt
     from information_schema.columns c
     join pg_class cl on cl.relname = c.table_name
     join pg_namespace ns on ns.oid = cl.relnamespace and ns.nspname = c.table_schema
    where c.table_schema in (${schemaList})
      and cl.relkind in ('r', 'p', 'v')
      and c.data_type = 'ARRAY'`,
)) {
  const tbl = String(row.tbl);
  if (!mapped.has(tbl)) continue;
  arrays.push(`${tbl}.${String(row.col)} is ${String(row.udt)}, the port sends json`);
}

console.log(
  `Checked ${runIdChecked} run id columns against ${RUN_EXECUTION_ID_WIDTH} and ${SEQUENCE_ID_WIDTH} characters, and ${mapped.size} mapped tables for array columns. ` +
    `Checked ${registry.length} compliance tiers against sched.run_policies. ` +
    `Checked ${TIER_ORDER.length} service tiers and ${FEATURES.length} features against tenancy.service_tiers and tenancy.tier_features.`,
);

const failures = [
  ...missing.sort().map((m) => `MISSING ${m}`),
  ...tooNarrow.sort().map((m) => `NARROW ${m}`),
  ...arrays.sort().map((m) => `ARRAY ${m}`),
  ...tierProblems.sort().map((m) => `TIER ${m}`),
  ...serviceTierProblems.sort().map((m) => `SERVICE_TIER ${m}`),
];
if (failures.length > 0) {
  for (const f of failures) console.log(f);
  console.log(`SCHEMA CHECK FAILED, ${failures.length} problems`);
  process.exit(1);
}
console.log("ALL ROW MAP KEYS RESOLVE");
