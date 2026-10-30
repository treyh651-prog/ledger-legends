import { query } from "./connector-sql";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name === ".git") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Word-boundary-safe containment check, built from regex literals only. */
function containsWord(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
  const pattern = new RegExp("(?:^|[^A-Za-z0-9_])" + escaped + "(?:$|[^A-Za-z0-9_])");
  return pattern.test(haystack);
}

async function main() {
  const cols = await query(`
    select table_schema as s, table_name as t, column_name as c
    from information_schema.columns
    where table_schema in ('ledger','subledger','close','docvault','deliverable','entitlement','import','intake','practice','report','sched','tax','tenancy')
    order by 1,2,3
  `);

  const files = walk("server");
  let combined = "";
  for (const f of files) combined += readFileSync(f, "utf8") + "\n";

  const skip = new Set(["id", "firm_id", "client_id", "version", "created_at"]);
  const orphans: { s: string; t: string; c: string }[] = [];
  for (const row of cols as any[]) {
    const snake = String(row.c);
    if (skip.has(snake)) continue;
    const camel = snakeToCamel(snake);
    if (!containsWord(combined, snake) && !containsWord(combined, camel)) {
      orphans.push({ s: row.s, t: row.t, c: snake });
    }
  }
  console.log(`checked ${cols.length} columns (excluding the five universal ones), ${orphans.length} appear nowhere in server/ by either name form`);
  console.log(JSON.stringify(orphans, null, 2));
}
void main();
