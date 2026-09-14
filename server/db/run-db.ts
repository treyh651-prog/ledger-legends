/**
 * The one place that decides whether runs execute against Postgres or memory.
 *
 * The rule, stated once so nothing else has to guess:
 *
 *   RUN_DB=postgres  Postgres, and refuse to start without DATABASE_URL.
 *   RUN_DB=memory    In memory, whatever else is set. Data is lost on exit.
 *   RUN_DB unset     Postgres when NODE_ENV is production, memory otherwise.
 *
 * The default is chosen so that neither mistake is silent. A developer machine
 * with nothing set keeps working exactly as it does today, on memory, and cannot
 * accidentally reach a real client's books. A production process with no
 * DATABASE_URL refuses to start, because the alternative is a firm doing a
 * month's bookkeeping into a store that disappears when the process restarts,
 * and discovering it later. Refusing is loud, wrong data is quiet.
 *
 * RUN_DB=memory in production is allowed, because a demonstration environment
 * is a real need, but it is a deliberate act that appears in the deployment
 * configuration where somebody can see it, and it says so on startup.
 */

import { MemoryRunDb } from "../runs/db-memory";
import { PostgresRunDb } from "../runs/db-postgres";
import type { RunDb } from "../runs/db";
import { databaseUrl, getPool } from "./pool";

export type RunDbKind = "memory" | "postgres";

export class RunDbConfigError extends Error {
  readonly code = "RUN_DB_CONFIG";
}

/** Which port the environment asks for, with no side effects. */
export function selectRunDbKind(env: NodeJS.ProcessEnv = process.env): RunDbKind {
  const requested = (env.RUN_DB ?? "").trim().toLowerCase();
  if (requested === "postgres") return "postgres";
  if (requested === "memory") return "memory";
  if (requested !== "") {
    throw new RunDbConfigError(
      `RUN_DB is ${JSON.stringify(requested)}, which is neither "postgres" nor "memory".`,
    );
  }
  return env.NODE_ENV === "production" ? "postgres" : "memory";
}

export interface ResolvedRunDb {
  kind: RunDbKind;
  db: RunDb;
  /** One line for the startup log. Never contains the connection string. */
  description: string;
}

/**
 * Build the port the environment asks for.
 *
 * Postgres is resolved through getPool, so the process holds one pool no matter
 * how many callers ask for a port. databaseUrl throws its own named error when
 * the variable is missing, which is the production refusal.
 */
export function resolveRunDb(env: NodeJS.ProcessEnv = process.env): ResolvedRunDb {
  const kind = selectRunDbKind(env);
  if (kind === "postgres") {
    // Read first, so a missing variable fails before a socket is opened and the
    // message the operator sees is the one about DATABASE_URL.
    databaseUrl(env);
    return {
      kind,
      db: new PostgresRunDb(getPool(env)),
      description: "runs execute against Postgres",
    };
  }
  const inProduction = env.NODE_ENV === "production";
  return {
    kind,
    db: new MemoryRunDb(),
    description: inProduction
      ? "runs execute in memory because RUN_DB=memory, and nothing written survives a restart"
      : "runs execute in memory, the default outside production",
  };
}
