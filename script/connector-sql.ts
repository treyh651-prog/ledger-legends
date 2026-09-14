/**
 * Read only SQL against the project database, through the Supabase connector.
 *
 * Both schema gates need the live catalog and neither may see a password. The
 * connector holds its own credentials, so the gates shell out to it and parse
 * what comes back. This module exists because the parsing is fiddly and having
 * it written twice is the drift the gates are there to catch.
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
export function query(sql: string): Array<Record<string, unknown>> {
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
