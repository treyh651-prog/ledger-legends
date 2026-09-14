/**
 * The one place a Postgres connection is opened.
 *
 * The connection string is read from the environment and never from a file in
 * this repository. Nothing here logs it, echoes it, or writes it anywhere,
 * because a connection string carries a password and a password in a log line
 * is a password in a log aggregator forever. Errors below quote the variable
 * name and never its value.
 *
 * Read docs/RUNNING.md for where the operator gets that value and which of the
 * two Supabase forms belongs to which job. The short version, because it
 * decides whether this module is even the right caller: doc 04 Part 13 requires
 * schema migrations to run over a direct connection, never over a transaction
 * mode pooler, because a migration depends on session state that a pooler is
 * free to hand to somebody else between statements. Application queries are the
 * opposite case and are what the pooler exists for. This module is the
 * application path, so a pooled URL is the expected input and a direct URL also
 * works.
 */

import { Pool } from "pg";
import type { PoolClient } from "pg";
import type { PgClientLike, PgPoolLike } from "../runs/db-postgres";

/**
 * The structural declarations in the port are satisfied by the real driver.
 * These two lines are the whole reconciliation, checked by `npx tsc --noEmit`,
 * and they are why nothing in the port imports `pg`.
 */
const _poolSatisfiesPort: (p: Pool) => PgPoolLike = (p) => p;
const _clientSatisfiesPort: (c: PoolClient) => PgClientLike = (c) => c;
void _poolSatisfiesPort;
void _clientSatisfiesPort;

/**
 * Ten connections per application process.
 *
 * Supabase's transaction mode pooler on the free and small paid tiers hands out
 * a few hundred client connections in total, shared with the dashboard, the SQL
 * editor, and anything else pointed at the project. A run holds one connection
 * for the length of one transaction and the runs are triggered by people
 * pressing buttons rather than by request volume, so the queue depth this has
 * to absorb is small. Ten leaves room for several processes without any one of
 * them being able to exhaust the project, and a run that has to wait a moment
 * for a connection is invisible next to the work it then does.
 */
const POOL_MAX = 10;

/**
 * Thirty seconds for one statement.
 *
 * The slowest thing a run does is the candidate read at the top of a scope
 * freeze, which is a bounded date window on an indexed pair of tenant columns.
 * Thirty seconds is far past that and far short of a person's patience, so a
 * statement that hits it is not slow, it is stuck: a missing index, a lock held
 * by another transaction, or a predicate that lost its tenant term. Failing
 * loudly at that point is more useful than a request that never returns, and
 * the run framework treats the failure as one attempt and logs it.
 */
const STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Ten seconds to get a connection, and thirty seconds idle before it is closed.
 *
 * The acquisition timeout turns pool exhaustion into a named error instead of a
 * hang. The idle timeout matters more than it looks on a pooler: a connection
 * this process is not using is a connection the project cannot give to anybody
 * else, so holding an idle one costs the whole project rather than this process.
 */
const CONNECTION_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;

export class MissingDatabaseUrlError extends Error {
  readonly code = "MISSING_DATABASE_URL";
  constructor(message: string) {
    super(message);
  }
}

/**
 * The connection string, or a refusal naming what to do about it.
 *
 * The refusal is deliberately long. The person who sees it is the person who
 * owns the business, at the moment a deployment failed to start, and a message
 * that says only that a variable is unset costs them a search through the docs.
 */
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DATABASE_URL;
  if (raw === undefined || raw.trim() === "") {
    throw new MissingDatabaseUrlError(
      [
        "DATABASE_URL is not set, so there is no database to connect to.",
        "Set it as a secret in the hosting environment, not in a file in this",
        "repository. docs/RUNNING.md has the two Supabase forms and says which",
        "one to use. To run without a database on a developer machine, leave",
        "RUN_DB unset and NODE_ENV unset, which selects the in memory port.",
      ].join(" "),
    );
  }
  return raw.trim();
}

/**
 * TLS is required, and it is required here rather than left to the URL.
 *
 * A `sslmode` parameter in the connection string is a value the operator can
 * drop by accident when copying between environments, and a connection that
 * silently falls back to plaintext carries every ledger row and the password
 * itself across the network in the clear. Setting it in code means the only way
 * to turn it off is a commit.
 *
 * rejectUnauthorized is false because Supabase serves a certificate chain that
 * needs their bundled root, which is not in the Node trust store, and shipping
 * a pinned certificate file is a maintenance burden that expires. This still
 * encrypts the connection and still defeats a passive listener. It does not by
 * itself defeat an active man in the middle, which is why docs/RUNNING.md tells
 * the operator to download the project certificate and set PGSSLROOTCERT when
 * the deployment runs anywhere less trusted than a managed host on the same
 * provider.
 */
function tlsOptions(env: NodeJS.ProcessEnv): { rejectUnauthorized: boolean; ca?: string } {
  const ca = env.PGSSLROOTCERT_PEM;
  if (ca !== undefined && ca.trim() !== "") {
    return { rejectUnauthorized: true, ca };
  }
  return { rejectUnauthorized: false };
}

let shared: Pool | null = null;

/** Build a pool. Callers that want the process wide one call getPool. */
export function createPool(env: NodeJS.ProcessEnv = process.env): Pool {
  const pool = new Pool({
    connectionString: databaseUrl(env),
    ssl: tlsOptions(env),
    max: POOL_MAX,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    // Applied by the server at connection time, so every transaction on every
    // connection carries it whether or not the caller remembered to ask.
    statement_timeout: STATEMENT_TIMEOUT_MS,
    // Named so a person reading pg_stat_activity can tell the application's
    // connections apart from a migration or a dashboard query.
    application_name: "ledger-legends",
  });

  // A dead connection sitting idle in the pool raises an error event with
  // nothing awaiting it, and an unhandled error event on a pool ends the
  // process. The pool discards the connection on its own, so the only thing
  // left to do is say that it happened.
  pool.on("error", (err) => {
    console.error("[db] idle client error, connection discarded:", err.message);
  });

  return pool;
}

/**
 * The process wide pool, built on first use.
 *
 * Lazy rather than built at import time, because importing this module must not
 * be what opens a socket. The test suite and the in memory port both import
 * things that transitively reach here.
 */
export function getPool(env: NodeJS.ProcessEnv = process.env): Pool {
  if (shared === null) shared = createPool(env);
  return shared;
}

/** Close the process wide pool. Shutdown paths and scripts call this. */
export async function closePool(): Promise<void> {
  if (shared === null) return;
  const pool = shared;
  shared = null;
  await pool.end();
}
