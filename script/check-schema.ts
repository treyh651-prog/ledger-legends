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
 *   anybody remembering to add it twice.
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
 * Run it with: npx tsx script/check-schema.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PHYSICAL_TABLES, physical } from "../server/runs/db-postgres";
import { RUN_EXECUTION_ID_WIDTH, SEQUENCE_ID_WIDTH } from "../server/runs/ids";
import type { TableName } from "../server/runs/tables";

// The Supabase project reference, which is the host part of the project's API
// URL and not a secret. Override it for a different environment.
const PROJECT_ID = process.env.SUPABASE_PROJECT_ID ?? "jtqxklqbwsrjewasjfyf";

/** The `RowMap` keys, read from the source so the two lists cannot diverge. */
function rowMapKeys(): string[] {
  const src = readFileSync("server/runs/tables.ts", "utf8");
  const start = src.indexOf("export interface RowMap {");
  if (start < 0) throw new Error("RowMap interface not found in server/runs/tables.ts");
  const end = src.indexOf("\n}", start);
  if (end < 0) throw new Error("RowMap interface has no closing brace");
  const body = src.slice(start, end);
  const keys: string[] = [];
  for (const line of body.split("\n").slice(1)) {
    const m = /^\s*([a-z0-9_]+)\s*:/.exec(line);
    if (m) keys.push(m[1]);
  }
  if (keys.length === 0) throw new Error("RowMap parsed to zero keys");
  return keys;
}

/**
 * The connector returns the rows inside an untrusted data envelope, because
 * query output is data and not instruction. Strip the envelope, parse the JSON.
 */
function query(sql: string): Array<Record<string, unknown>> {
  const input = JSON.stringify({ project_id: PROJECT_ID, query: sql });
  const raw = execFileSync("pplx", ["connector", "call", "supabase", "execute_sql", "--input", input], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const outer = JSON.parse(raw) as { is_error?: boolean; error?: unknown; result?: unknown };
  if (outer.is_error) throw new Error(`connector error ${JSON.stringify(outer.error)}`);
  // The connector nests the payload twice: a JSON string holding an object
  // whose `result` is the enveloped text.
  let body = typeof outer.result === "string" ? outer.result : JSON.stringify(outer.result);
  if (body.trimStart().startsWith("{")) {
    const inner = JSON.parse(body) as { result?: unknown };
    if (typeof inner.result === "string") body = inner.result;
  }
  const m = /<untrusted-data-[^>]*>\n([\s\S]*)\n<\/untrusted-data/.exec(body);
  const payload = m ? m[1] : body;
  return JSON.parse(payload) as Array<Record<string, unknown>>;
}

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

console.log(`Checked ${keys.length} row map keys against ${present.size} relations in ${PROJECT_ID}.`);

// ---------------------------------------------------------------------------
// Run id widths, migration 0020.
// ---------------------------------------------------------------------------

/** The schemas this project owns. Supabase owns the rest of the database. */
const OWNED_SCHEMAS = [
  "close", "deliverable", "docvault", "entitlement", "import", "intake",
  "ledger", "practice", "report", "subledger", "tax", "tenancy",
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
  `Checked ${runIdChecked} run id columns against ${RUN_EXECUTION_ID_WIDTH} and ${SEQUENCE_ID_WIDTH} characters, and ${mapped.size} mapped tables for array columns.`,
);

const failures = [
  ...missing.sort().map((m) => `MISSING ${m}`),
  ...tooNarrow.sort().map((m) => `NARROW ${m}`),
  ...arrays.sort().map((m) => `ARRAY ${m}`),
];
if (failures.length > 0) {
  for (const f of failures) console.log(f);
  console.log(`SCHEMA CHECK FAILED, ${failures.length} problems`);
  process.exit(1);
}
console.log("ALL ROW MAP KEYS RESOLVE");
