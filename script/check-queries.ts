/**
 * Every identifier in every named query has to be a column that exists.
 *
 * `script/check-schema.ts` asks whether the table a run addresses is there.
 * That is the coarse question, and it passed while all 98 named queries in
 * `server/runs/db-postgres.ts` were unrunnable, because 49 table and column
 * pairs across 26 of them named columns the database does not have. Nothing
 * caught it: the tests run against the in memory port, which matches on the
 * TypeScript field name and never parses the SQL, and `tsc` sees a template
 * string. The first run to touch Postgres would have failed on its own log
 * write, before doing any work.
 *
 * What this gate checks, in the order it checks it:
 *
 *   The declared table. Each catalog entry names a row map key, and the cents
 *   decode is keyed off it, so a query whose `table` does not match the table
 *   its SQL reads decodes the wrong columns and is reported here.
 *
 *   Every identifier. The SQL is stripped of literals, aliases, casts and
 *   function names, and what is left is resolved against
 *   `information_schema.columns` for the physical table. The first failure
 *   names the query, the table and the identifier.
 *
 *   Every parameter cast. `encodeParam` turns a JavaScript array into a json
 *   text literal, which no array cast accepts, so `= any($3::char(26)[])`
 *   fails live with 22P02 and type checks perfectly. A cast to an array type
 *   is therefore a defect of the same class as a missing column, and the
 *   thirteen that were in the catalog are why the check is here.
 *
 *   Every column override. `COLUMN_OVERRIDES` is what the insert and update
 *   paths write through, and a stale entry there fails a write rather than a
 *   read, which no read side check would ever see.
 *
 * Resolution imports `QUERIES`, `PHYSICAL_TABLES`, `physical` and
 * `COLUMN_OVERRIDES` from the port itself, for the reason `check-schema.ts`
 * imports the table map: a second copy of the thing being checked drifts, and
 * drift is the defect.
 *
 * The database is read through `script/connector-sql.ts`, which tries the
 * Supabase connector first (its own credentials, no password seen here) and
 * falls back to a direct connection on DATABASE_URL when the connector is
 * not available.
 *
 * Run it with: npx tsx script/check-queries.ts
 */

import {
  COLUMN_OVERRIDES,
  PHYSICAL_TABLES,
  QUERIES,
  physical,
} from "../server/runs/db-postgres";
import type { TableName } from "../server/runs/tables";
import { PROJECT_ID, query } from "./connector-sql";

/**
 * Words that are SQL and not columns. Function names are not in this list and
 * do not need to be, because an identifier followed by an open bracket is a
 * call and is skipped. Keeping the list to grammar keeps a new function from
 * needing a new entry here.
 */
const KEYWORDS = new Set(
  `select from where and or not in is null as order by asc desc limit offset
   between any all on join left right inner outer full cross union case when
   then else end insert into values update set delete returning distinct group
   having exists with recursive true false interval cast for share nowait skip
   locked only using over partition`.split(/\s+/),
);

/** Literals, quoted aliases and comments are not identifiers. */
function withoutLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'[^']*'/g, " ? ")
    .replace(/"[^"]*"/g, " ? ");
}

/** Every `::type` in the query, in the order it appears. */
function castsIn(sql: string): string[] {
  const out: string[] = [];
  const re = /::\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\(\d+\))?(?:\s*\[\])?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out.push(m[1].replace(/\s+/g, ""));
  return out;
}

/** The parameter and cast pairs, so a failure can name the placeholder. */
function paramCasts(sql: string): Array<{ param: string; cast: string }> {
  const out: Array<{ param: string; cast: string }> = [];
  const re = /\$(\d+)\s*::\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\(\d+\))?(?:\s*\[\])?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out.push({ param: `$${m[1]}`, cast: m[2].replace(/\s+/g, "") });
  }
  return out;
}

const failures: string[] = [];

// ---------------------------------------------------------------------------
// The live catalog. Views count, for the reason check-schema.ts gives: a view
// is a legitimate target for a run read.
// ---------------------------------------------------------------------------

const live = new Map<string, Set<string>>();
for (const row of await query(
  `select c.table_schema || '.' || c.table_name as tbl, c.column_name as col
     from information_schema.columns c
     join pg_class cl on cl.relname = c.table_name
     join pg_namespace ns
       on ns.oid = cl.relnamespace and ns.nspname = c.table_schema
    where c.table_schema not in ('pg_catalog', 'information_schema')
      and cl.relkind in ('r', 'p', 'v')`,
)) {
  const tbl = String(row.tbl);
  if (!live.has(tbl)) live.set(tbl, new Set());
  live.get(tbl)!.add(String(row.col));
}

// ---------------------------------------------------------------------------
// The queries.
// ---------------------------------------------------------------------------

const names = Object.keys(QUERIES) as Array<keyof typeof QUERIES>;
let identifiersChecked = 0;
let castsChecked = 0;

for (const name of names) {
  const spec = QUERIES[name];
  const sql = spec.sql;
  const stripped = withoutLiterals(sql);

  const fromMatch = /\bfrom\s+([a-z_][a-z0-9_]*\.[a-z0-9_]+)/i.exec(stripped);
  if (!fromMatch) {
    failures.push(`${String(name)}: no schema qualified table in the sql`);
    continue;
  }
  const table = fromMatch[1];

  // The declared row map key has to be the table the sql actually reads,
  // because the cents decode is keyed off the declared name.
  const declared = physical(spec.table as TableName);
  if (declared !== table) {
    failures.push(
      `${String(name)}: declared table ${spec.table} maps to ${declared}, sql reads ${table}`,
    );
  }

  const columns = live.get(table);
  if (!columns) {
    failures.push(`${String(name)}: table ${table} does not exist`);
    continue;
  }

  // A subquery or a join against a second table is legitimate sql (see
  // applied_run_by_idempotency_key), and an identifier that belongs to that
  // second table is not a defect. Every schema qualified table this query
  // actually references, not only the declared primary one, so an
  // identifier is checked against whichever table it could plausibly
  // belong to.
  const allTables = new Set<string>([table]);
  const tableRefRe = /\b(?:from|join)\s+([a-z_][a-z0-9_]*\.[a-z0-9_]+)/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tableRefRe.exec(stripped)) !== null) allTables.add(tm[1]);
  const allColumns = new Set<string>();
  for (const t of allTables) {
    const cols = live.get(t);
    if (cols) for (const c of cols) allColumns.add(c);
  }

  // What is left after the literals, the casts, the parameters and every
  // referenced table name have gone is either a keyword, a function call or
  // a column. Table names are removed longest first and at a word boundary,
  // so removing ledger.run_log cannot eat the front of ledger.run_log_events
  // and leave a dangling _events behind.
  let body = stripped
    .replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*(\(\d+\))?(\s*\[\])?/g, " ")
    .replace(/\$\d+/g, " ");
  for (const t of [...allTables].sort((a, b) => b.length - a.length)) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    body = body.replace(new RegExp(`${escaped}(?![a-zA-Z0-9_])`, "g"), " ");
  }
  const seen = new Set<string>();
  const re = /(?<![\w.])([a-z_][a-z0-9_]*)\s*(\()?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const ident = m[1];
    if (m[2]) continue;
    if (KEYWORDS.has(ident.toLowerCase())) continue;
    if (seen.has(ident)) continue;
    seen.add(ident);
    identifiersChecked += 1;
    if (!allColumns.has(ident)) {
      failures.push(`${String(name)}: ${table} has no column ${ident}`);
    }
  }

  // A cast to an array type is unreachable from the encoder, which sends an
  // array as json text. It is a live 22P02 and a clean type check.
  for (const { param, cast } of paramCasts(sql)) {
    castsChecked += 1;
    if (cast.endsWith("[]")) {
      failures.push(
        `${String(name)}: ${param}::${cast} is an array cast, and encodeParam ` +
          `sends an array as json text, so this fails live with 22P02. ` +
          `Read it with jsonb_array_elements_text instead.`,
      );
    }
  }
  for (const cast of castsIn(sql)) {
    if (cast.endsWith("[]") && !paramCasts(sql).some((p) => p.cast === cast)) {
      failures.push(`${String(name)}: array cast ::${cast} outside a parameter`);
    }
  }
}

// ---------------------------------------------------------------------------
// The write path. Every override has to name a column that is there.
// ---------------------------------------------------------------------------

let overridesChecked = 0;
for (const [key, fields] of Object.entries(COLUMN_OVERRIDES)) {
  if (!fields) continue;
  const table = physical(key as TableName);
  const columns = live.get(table);
  if (!columns) {
    failures.push(`COLUMN_OVERRIDES ${key}: table ${table} does not exist`);
    continue;
  }
  for (const [field, override] of Object.entries(fields)) {
    overridesChecked += 1;
    if (!columns.has(override.column)) {
      failures.push(
        `COLUMN_OVERRIDES ${key}.${field}: ${table} has no column ${override.column}`,
      );
    }
  }
}

// A mapped physical name that no longer exists is a failure wherever it is.
for (const [key, table] of Object.entries(PHYSICAL_TABLES)) {
  if (table && !live.has(table)) {
    failures.push(`PHYSICAL_TABLES ${key}: ${table} does not exist`);
  }
}

console.log(
  `Checked ${names.length} named queries, ${identifiersChecked} identifiers, ` +
    `${castsChecked} parameter casts and ${overridesChecked} column overrides ` +
    `against ${live.size} relations in ${PROJECT_ID}.`,
);

if (failures.length > 0) {
  console.log(`FIRST FAILURE: ${failures[0]}`);
  for (const f of failures.slice(1)) console.log(f);
  console.log(`QUERY CHECK FAILED, ${failures.length} problems`);
  process.exit(1);
}
console.log("ALL NAMED QUERIES RESOLVE");
