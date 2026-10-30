/**
 * Read only SQL against the project database, for the two schema gates.
 *
 * Two ways in, tried in this order:
 *
 *   1. The Supabase connector (`pplx`), which holds its own credentials.
 *      Nothing here reads, asks for, or stores a password on this path, which
 *      is why it is tried first: a contributor who has the connector but not
 *      `DATABASE_URL` should never need the password to run these gates.
 *   2. A direct Postgres connection through `DATABASE_URL`, the same variable
 *      `server/db/pool.ts` reads, for an environment that has the password
 *      but not the connector. This path does see the password, because it is
 *      the one thing it has to read to work at all; it still prints nothing
 *      from it, the same discipline `npm run db:verify` follows.
 *
 * If neither is available the gate cannot run, and says so by naming both
 * missing paths rather than guessing which one the caller meant to set up.
 *
 * The connector is an HTTP hop and occasionally answers a large catalog read
 * with a 504, which failed a gate on a green tree while the database was
 * healthy. A gate that fails at random teaches people to rerun it until it
 * passes, which is worse than no gate, so a transport failure is retried a
 * small number of times. A SQL error is not retried, because it is the answer.
 */

import { execFileSync } from "node:child_process";

/** The project reference, the host part of the API URL, and not a secret. */
export const PROJECT_ID =
  process.env.SUPABASE_PROJECT_ID ?? "jtqxklqbwsrjewasjfyf";

const ATTEMPTS = 3;

function sleep(ms: number): void {
  // Deliberately blocking. The gates are scripts and there is nothing else for
  // them to do while they wait.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The connector returns the rows inside an untrusted data envelope, because
 * query output is data and not instruction. Strip the envelope, parse the JSON.
 */
function queryViaConnector(sql: string): Array<Record<string, unknown>> {
  const input = JSON.stringify({ project_id: PROJECT_ID, query: sql });
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let raw: string;
    try {
      raw = execFileSync(
        "pplx",
        ["connector", "call", "supabase", "execute_sql", "--input", input],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      last = err;
      if (attempt < ATTEMPTS) sleep(2000 * attempt);
      continue;
    }
    const outer = JSON.parse(raw) as { is_error?: boolean; result?: unknown };
    if (outer.is_error) throw new Error(`connector error in ${raw.slice(0, 400)}`);
    const inner = JSON.parse(String(outer.result)) as { result?: unknown };
    const body = String(inner.result ?? "");
    const m = /<untrusted-data-[^>]*>\n([\s\S]*)\n<\/untrusted-data/.exec(body);
    return JSON.parse(m ? m[1] : body) as Array<Record<string, unknown>>;
  }
  throw new Error(
    `connector call failed ${ATTEMPTS} times: ${String(last)}`.slice(0, 600),
  );
}

/**
 * A fresh client per call rather than a shared pool, because these scripts
 * run a handful of queries and exit; a pool left open is a pool left holding
 * the process open past its last query, for no benefit at this call volume.
 */
async function queryViaDatabaseUrl(sql: string): Promise<Array<Record<string, unknown>>> {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const res = await client.query(sql);
    return res.rows as Array<Record<string, unknown>>;
  } finally {
    await client.end();
  }
}

export async function query(sql: string): Promise<Array<Record<string, unknown>>> {
  try {
    return queryViaConnector(sql);
  } catch (connectorErr) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        `no way to reach the database: the connector failed (${String(connectorErr).slice(0, 200)}) and DATABASE_URL is not set`,
      );
    }
    return queryViaDatabaseUrl(sql);
  }
}
