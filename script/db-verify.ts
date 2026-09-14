/**
 * `npm run db:verify`. The one command that proves the application can reach
 * the real database and execute a real run through it.
 *
 * It is written to be run by the operator, on a machine where DATABASE_URL is
 * set, because nobody who wrote this code may hold that value. Five steps, in
 * order, each printing PASS, FAIL or SKIP, and one verdict line at the end:
 *
 *   1. Connect, and report the server version.
 *   2. Every relation the run port can address exists.
 *   3. One read through a named query in the catalog.
 *   4. Pick a firm, client and user the row level security policies will accept.
 *   5. One complete run through execute() in preview, inside an outer
 *      transaction that is then rolled back.
 *
 * Step 5 is the one that matters. Preview posts no journal entries by design, so
 * it cannot touch the books, and the outer rollback also discards the run log
 * evidence a preview would normally commit. What survives the command is
 * nothing at all, and what it proves is the whole path: pool, TLS, session
 * settings, isolation, advisory lock, the named queries a scope freeze reads,
 * the proposal writer, and the log writer.
 *
 * Nothing here prints the connection string, the password, or the user name.
 * The host and port are printed, because a person running this needs to know
 * which database answered and neither is a secret.
 */

import { getPool, closePool } from "../server/db/pool";
import {
  PostgresRunDb,
  PostgresSavepointRunDb,
  physical,
} from "../server/runs/db-postgres";
import { execute } from "../server/runs/execute";
import { txnDetectDuplicates } from "../server/runs/runs/txn-detect-duplicates";
import type { TableName } from "../server/runs/tables";
import { rowMapKeys } from "./row-map-keys";

const TOTAL_STEPS = 5;
let failed = false;
let skipped = false;

function pass(step: number, what: string): void {
  console.log(`step ${step} of ${TOTAL_STEPS}  PASS  ${what}`);
}

function fail(step: number, what: string): void {
  console.log(`step ${step} of ${TOTAL_STEPS}  FAIL  ${what}`);
  failed = true;
}

function skip(step: number, what: string): void {
  console.log(`step ${step} of ${TOTAL_STEPS}  SKIP  ${what}`);
  skipped = true;
}

/** Host and port only, and only when they parse. Never the credentials. */
function whereAmI(): string {
  const raw = process.env.DATABASE_URL ?? "";
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port === "" ? "5432" : u.port}`;
  } catch {
    return "an unparseable DATABASE_URL";
  }
}

/** The first day of the month before last, so the window covers real rows. */
function windowStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  if ((process.env.DATABASE_URL ?? "").trim() === "") {
    console.error(
      "DATABASE_URL is not set. This command talks to the real database and " +
        "cannot invent a connection. docs/RUNNING.md says where the value " +
        "comes from and how to set it.",
    );
    process.exit(1);
  }

  console.log(`db:verify against ${whereAmI()}`);
  const pool = getPool();

  // -----------------------------------------------------------------------
  // Step 1. Connect and report the version.
  // -----------------------------------------------------------------------
  let version = "";
  try {
    const res = await pool.query<{ v: string; db: string; who: string }>(
      "select version() as v, current_database() as db, current_user as who",
    );
    version = res.rows[0].v.split(" ").slice(0, 2).join(" ");
    pass(
      1,
      `connected to database ${res.rows[0].db} as role ${res.rows[0].who}, ${version}`,
    );
  } catch (err) {
    fail(1, `could not connect: ${message(err)}`);
    await finish();
    return;
  }

  // -----------------------------------------------------------------------
  // Step 2. Every relation the port can address is present.
  //
  // The same resolution the port uses, through physical(), and the same key
  // list script/check-schema.ts uses. Views count, because ledger.chart_accounts
  // is a view and a legitimate write target.
  // -----------------------------------------------------------------------
  const keys = rowMapKeys();
  const wanted = new Map<string, string>();
  for (const key of keys) wanted.set(key, physical(key as TableName));
  try {
    const res = await pool.query<{ name: string }>(
      `select n.nspname || '.' || c.relname as name
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v')
          and n.nspname not in ('pg_catalog', 'information_schema')`,
    );
    const present = new Set(res.rows.map((r) => r.name));
    const missing = [...wanted]
      .filter(([, table]) => !present.has(table))
      .map(([key, table]) => `${key} -> ${table}`);
    if (missing.length === 0) {
      pass(2, `all ${wanted.size} addressable relations present`);
    } else {
      fail(
        2,
        `${missing.length} of ${wanted.size} relations missing: ${missing.slice(0, 8).join(", ")}`,
      );
    }
  } catch (err) {
    fail(2, `catalog read failed: ${message(err)}`);
  }

  // -----------------------------------------------------------------------
  // Step 3. One read through a named query, through the port itself.
  //
  // open_period_locks rather than a candidate read, because it is the shortest
  // query in the catalog that still exercises the whole path: a read only
  // transaction at an explicit isolation level, the session settings, the
  // parameter encoder, and the row decoder. An empty result is a pass. The
  // question is whether the query resolves and returns, not whether this
  // database happens to have locked periods in it.
  // -----------------------------------------------------------------------
  const runDb = new PostgresRunDb(pool);
  const zeroUuid = "00000000-0000-0000-0000-000000000000";
  try {
    const rows = await runDb.tx(
      {
        isolation: "repeatable read",
        readOnly: true,
        firmId: zeroUuid,
        clientId: zeroUuid,
        actorId: zeroUuid,
        actorKind: "human",
      },
      async (tx) => tx.query("open_period_locks", { firmId: zeroUuid, clientId: zeroUuid }),
    );
    pass(3, `named query open_period_locks returned ${rows.length} rows`);
  } catch (err) {
    fail(3, `named query open_period_locks failed: ${message(err)}`);
  }

  // -----------------------------------------------------------------------
  // Step 4. A firm, client and user the policies will accept.
  //
  // This predicate is the body of tenancy.has_client_access spelled out, so a
  // triple it returns is a triple the policies allow. Choosing at random would
  // produce a step 5 failure that looks like a broken wire and is actually an
  // empty database, which is the ambiguity this command exists to avoid.
  // -----------------------------------------------------------------------
  let triple: { firmId: string; clientId: string; userId: string } | null = null;
  try {
    const res = await pool.query<{ firm_id: string; client_id: string; user_id: string }>(
      `select c.firm_id, c.id as client_id, m.user_id
         from tenancy.memberships m
         join tenancy.clients c on c.firm_id = m.firm_id
        where m.revoked_at is null
          and c.archived_at is null
          and (m.scope = 'firm' or m.client_id = c.id)
        order by c.id
        limit 1`,
    );
    if (res.rows.length === 0) {
      skip(
        4,
        "no client with an active membership exists yet, so there is nothing " +
          "a run could legitimately be executed against",
      );
    } else {
      const r = res.rows[0];
      triple = { firmId: r.firm_id, clientId: r.client_id, userId: r.user_id };
      pass(4, `client ${r.client_id} in firm ${r.firm_id}, acting as user ${r.user_id}`);
    }
  } catch (err) {
    fail(4, `could not read tenancy.memberships: ${message(err)}`);
  }

  // -----------------------------------------------------------------------
  // Step 5. One complete run, preview, inside a transaction that is rolled back.
  // -----------------------------------------------------------------------
  if (triple === null) {
    skip(5, "no tenant to run against, see step 4");
  } else {
    const client = await pool.connect();
    try {
      // Serializable on the outer transaction, because a savepoint cannot
      // change isolation level and this is the level the run would have asked
      // for if it were writing.
      await client.query("begin isolation level serializable");
      const now = new Date();
      const outcome = await execute(
        new PostgresSavepointRunDb(client),
        txnDetectDuplicates,
        {
          clientId: triple.clientId,
          from: windowStart(now),
          to: now.toISOString().slice(0, 10),
          bankAccountIds: null,
        },
        {
          mode: "preview",
          firmId: triple.firmId,
          clientId: triple.clientId,
          actor: { userId: triple.userId, kind: "human" },
          now,
          source: "button",
        },
      );
      const ok =
        outcome.status === "completed" ||
        outcome.status === "completed_with_skips" ||
        outcome.status === "no_op";
      const detail =
        `TXN-DETECT-DUPLICATES preview status ${outcome.status}, ` +
        `${outcome.result.proposals.length} proposals, ` +
        `${outcome.result.skips.length} skips, ` +
        `${outcome.result.errors.length} errors`;
      if (ok) pass(5, detail);
      else fail(5, `${detail}. First error: ${firstError(outcome.result.errors)}`);
    } catch (err) {
      fail(5, `preview run threw: ${message(err)}`);
    } finally {
      // The point of the harness. Nothing the run did survives this line, not
      // the proposals and not the run log rows.
      try {
        await client.query("rollback");
      } catch {
        // Already unwound, which is the state we wanted anyway.
      }
      client.release();
    }
  }

  await finish();
}

function firstError(errors: readonly { code: string; message: string }[]): string {
  if (errors.length === 0) return "none reported";
  return `${errors[0].code} ${errors[0].message}`;
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** One verdict line, three possible words, three distinct exit codes. */
async function finish(): Promise<void> {
  await closePool();
  console.log("");
  if (failed) {
    console.log(`db:verify FAILED. Fix the FAIL line above and run it again.`);
    process.exit(1);
  }
  if (skipped) {
    console.log(
      `db:verify INCOMPLETE. The connection works and the schema is right, ` +
        `but a step was skipped, so the run path is not proven. See the SKIP line.`,
    );
    process.exit(2);
  }
  console.log(
    `db:verify PASSED. All ${TOTAL_STEPS} steps green, and nothing was written.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`db:verify crashed before it could report: ${message(err)}`);
  process.exit(1);
});
