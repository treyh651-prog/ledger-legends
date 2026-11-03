/**
 * Backfill account 1420 "Due from related parties" and category
 * CAT-DUE-FROM-RELATED onto every client whose chart was already built.
 *
 * INTAKE-BUILD-CHART's propose() is already per-row idempotent: it inserts
 * only the rows a client does not already have, by derived id, and skips
 * everything else as already_applied (server/runs/runs/intake-build-chart.ts).
 * 1420's scopeKey is "always", so simply re-triggering the run for a client
 * that was onboarded before this migration inserts exactly the one new
 * account and the one new category, with normal run provenance -- unlike a
 * raw migration `insert`, which would leave the row with no created_by_run_id.
 * Nothing else on an existing chart is touched: the run has no field write
 * path and no delete path, only insert-if-missing.
 *
 *   npx tsx script/backfill-due-from-related.ts
 *
 * Reads DATABASE_URL, RUN_DB, APP_DB_ROLE from the environment, same as the
 * server. Prints which clients inserted the two new rows, which already had
 * them, and which had no chart template on file to re-run against.
 */

import "dotenv/config";
import { closePool, getPool } from "../server/db/pool";
import { resolveRunDb } from "../server/db/run-db";
import { execute } from "../server/runs/execute";
import { intakeBuildChart } from "../server/runs/runs/intake-build-chart";

const SETUP_ACTOR = { userId: "SETUP-SCRIPT", kind: "sequence" as const };

async function main(): Promise<void> {
  const resolved = resolveRunDb();
  if (resolved.kind !== "postgres") {
    throw new Error("RUN_DB resolved to memory; set DATABASE_URL and RUN_DB=postgres (or NODE_ENV=production) to backfill a real firm's clients");
  }
  const pool = getPool();
  const client = await pool.connect();
  let rows: { id: string; firm_id: string; chart_template_id: string | null }[];
  try {
    // onboarded_at is never written by this app at all (confirmed by
    // reading intake-create-client.ts: it is set to null at creation and
    // nothing else touches it), so it cannot be the signal for "has a
    // chart already." chart_template_id is: INTAKE-BUILD-CHART's own
    // caller sets it once a template is picked, which is the real
    // precondition for safely re-triggering that run.
    const result = await client.query<{ id: string; firm_id: string; chart_template_id: string | null }>(
      `select id, firm_id, chart_template_id
         from tenancy.clients
        where chart_template_id is not null and archived_at is null
        order by firm_id, id`,
    );
    rows = result.rows;
  } finally {
    client.release();
  }

  console.log(`${String(rows.length)} clients with a chart template on file`);
  const today = new Date();
  const period = today.toISOString().slice(0, 10);

  for (const row of rows) {
    if (!row.chart_template_id) {
      console.log(`  skip    ${row.id}  no chart_template_id on file`);
      continue;
    }
    const scope = {
      clientId: row.id,
      period,
      industry: row.chart_template_id,
      scopeKeys: [],
      excludeAccountNumbers: [],
      addAccounts: [],
    };
    const preview = await execute(resolved.db, intakeBuildChart, scope, {
      mode: "preview",
      firmId: row.firm_id,
      clientId: row.id,
      actor: SETUP_ACTOR,
      now: today,
      source: "button",
    });
    if (preview.status === "refused") {
      console.log(`  refused ${row.id}  ${preview.result.errors.map((e) => e.message).join("; ")}`);
      continue;
    }
    if (preview.result.proposals.length === 0) {
      console.log(`  done    ${row.id}  already has 1420 and CAT-DUE-FROM-RELATED`);
      continue;
    }
    const applied = await execute(resolved.db, intakeBuildChart, scope, {
      mode: "apply",
      firmId: row.firm_id,
      clientId: row.id,
      actor: SETUP_ACTOR,
      now: today,
      source: "button",
      previewRunId: preview.executionId,
    });
    console.log(
      `  ${applied.status === "completed" ? "inserted" : applied.status} ${row.id}  ${String(applied.result.proposals.length)} row(s), ${String(applied.result.skips.length)} already_applied`,
    );
  }
  await closePool();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
