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
 * Run it with: npx tsx script/check-schema.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PHYSICAL_TABLES, physical } from "../server/runs/db-postgres";
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
if (missing.length > 0) {
  for (const m of missing.sort()) console.log(`MISSING ${m}`);
  console.log(`SCHEMA CHECK FAILED, ${missing.length} unresolved`);
  process.exit(1);
}
console.log("ALL ROW MAP KEYS RESOLVE");
