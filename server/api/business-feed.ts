/**
 * GET /api/business-feed -- the one read-only endpoint the separate virtual
 * office widget project reads. Full contract:
 * C:\Users\treyh\OneDrive\Desktop\virtual office\ledger-legends-office\docs\BUSINESS_FEED.md
 * (a different repository this one does not own and does not edit).
 *
 * Not an actor-scoped route -- there is no signed in person on the other
 * end, only a shared secret (BUSINESS_FEED_TOKEN), checked here with a
 * constant time compare. No token configured means the route refuses every
 * request, never falls open. The doc is explicit that nothing beyond
 * {id, name, status} may ever reach the response, so the shaping step is
 * its own small function (feedClientOf) rather than trusting whatever a
 * query happens to return.
 *
 * Status is decided by statusFor(), a pure function over five booleans,
 * deliberately separated from the Postgres queries that gather them
 * (gatherSignals) so the precedence rule itself is unit testable without a
 * database. The five signals, and the schema fact each one reads:
 *
 *   closed           -- close.periods.status = 'locked' for the client's
 *                        most recent period.
 *   reviewerPending   -- "review" in the doc means ready for a reviewer.
 *                        This app's own closest fact is the task catalog's
 *                        role column: a reviewer role task still open for
 *                        the current period, with every preparer role task
 *                        for that same period already complete -- prep
 *                        work done, sitting with the reviewer. (The doc
 *                        and the task that asked for this endpoint did not
 *                        specify an exact signal for "review"; this is the
 *                        nearest honest equivalent in the current schema.)
 *   latestImportFailed -- the single most recent apply mode run of
 *                        IMPORT-PARSE-FEED, IMPORT-COMMIT-BATCH, or
 *                        REC-IMPORT-STATEMENT (bank feed intake, the
 *                        "import, sync or statement" language in the doc)
 *                        ended failed or abandoned. refused/rejected_locked
 *                        are an intentional business rule stopping the run,
 *                        not a malfunction, so neither counts as broken.
 *   clientOwesDocuments -- close.document_requests has an open row with
 *                        owner = 'client' -- blocked on the client, which
 *                        is exactly what "waiting" means in the doc.
 *   recentActivity     -- any apply mode ledger.run_log row for the client
 *                        in the last 24 hours. Only read when none of the
 *                        four above apply, to pick working over idle.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { PgPoolLike } from "../runs/db-postgres";

export type FeedStatus = "working" | "idle" | "waiting" | "broken" | "review" | "closed";

export interface ClientStatusSignals {
  closed: boolean;
  reviewerPending: boolean;
  latestImportFailed: boolean;
  clientOwesDocuments: boolean;
  recentActivity: boolean;
}

/** Precedence per the task's own spec: broken > waiting > review > closed > working > idle. */
export function statusFor(signals: ClientStatusSignals): FeedStatus {
  if (signals.latestImportFailed) return "broken";
  if (signals.clientOwesDocuments) return "waiting";
  if (signals.reviewerPending) return "review";
  if (signals.closed) return "closed";
  if (signals.recentActivity) return "working";
  return "idle";
}

export interface FeedClient {
  id: string;
  name: string;
  status: FeedStatus;
}

/**
 * Opaque and stable per client, per the doc's own field table. An HMAC of
 * the real id keyed on the shared token: the office and this app are the
 * only two parties that ever hold that token, so this needs no second
 * secret of its own, and it is stable for as long as the token does not
 * rotate.
 */
export function opaqueClientId(token: string, clientId: string): string {
  return `c_${createHmac("sha256", token).update(clientId).digest("hex").slice(0, 10)}`;
}

/** Exactly the three fields the doc allows, nothing a query happened to also return. */
export function feedClientOf(token: string, row: { clientId: string; name: string; signals: ClientStatusSignals }): FeedClient {
  return { id: opaqueClientId(token, row.clientId), name: row.name, status: statusFor(row.signals) };
}

const IMPORT_RUN_TYPES = ["IMPORT-PARSE-FEED", "IMPORT-COMMIT-BATCH", "REC-IMPORT-STATEMENT"];

async function gatherSignals(pool: PgPoolLike, clientId: string, now: Date): Promise<ClientStatusSignals> {
  const client = await pool.connect();
  try {
    const period = await client.query<{ status: string; periodStart: string }>(
      `select status, period_start::text as "periodStart" from close.periods
        where client_id = $1 order by period_start desc limit 1`,
      [clientId],
    );
    const current = period.rows[0] ?? null;
    const closed = current?.status === "locked";

    let reviewerPending = false;
    if (current) {
      const tasks = await client.query<{ role: string; state: string }>(
        `select role, state from practice.tasks where client_id = $1 and period_start = $2::date`,
        [clientId, current.periodStart],
      );
      const reviewerOpen = tasks.rows.some((t) => t.role === "reviewer" && t.state !== "complete");
      const preparerDone = tasks.rows.every((t) => t.role !== "preparer" || t.state === "complete");
      reviewerPending = reviewerOpen && preparerDone;
    }

    const latestImport = await client.query<{ status: string }>(
      `select status from ledger.run_log
        where client_id = $1 and mode = 'apply' and run_type = any($2::text[])
        order by started_at desc limit 1`,
      [clientId, IMPORT_RUN_TYPES],
    );
    const latestImportFailed = latestImport.rows[0]?.status === "failed" || latestImport.rows[0]?.status === "abandoned";

    const owed = await client.query<{ n: string }>(
      `select count(*)::text as n from close.document_requests
        where client_id = $1 and status = 'open' and owner = 'client'`,
      [clientId],
    );
    const clientOwesDocuments = Number(owed.rows[0]?.n ?? "0") > 0;

    const recent = await client.query<{ n: string }>(
      `select count(*)::text as n from ledger.run_log
        where client_id = $1 and mode = 'apply' and started_at >= $2`,
      [clientId, new Date(now.getTime() - 24 * 60 * 60 * 1000)],
    );
    const recentActivity = Number(recent.rows[0]?.n ?? "0") > 0;

    return { closed, reviewerPending, latestImportFailed, clientOwesDocuments, recentActivity };
  } finally {
    client.release();
  }
}

async function gatherFeed(pool: PgPoolLike, now: Date): Promise<Array<{ clientId: string; name: string; signals: ClientStatusSignals }>> {
  const client = await pool.connect();
  let rows: Array<{ id: string; name: string }>;
  try {
    const r = await client.query<{ id: string; name: string }>(`select id, name from tenancy.clients where archived_at is null order by name asc`);
    rows = r.rows;
  } finally {
    client.release();
  }
  return Promise.all(rows.map(async (c) => ({ clientId: c.id, name: c.name, signals: await gatherSignals(pool, c.id, now) })));
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  // timingSafeEqual throws on a length mismatch rather than reporting false,
  // so the lengths are compared first via a hash of each -- never the raw
  // strings themselves, so no early-exit on the real value's length either.
  const givenHash = createHash("sha256").update(given).digest();
  const wantHash = createHash("sha256").update(want).digest();
  return timingSafeEqual(givenHash, wantHash) && timingSafeEqual(given, want);
}

/**
 * pool is null in memory mode (no real tenancy.* tables to query): a
 * correctly authorized request still gets a real, honest response, just
 * with zero clients, which the doc's own "What the office does with it"
 * section states is a valid state (demo mode).
 */
export function createBusinessFeedRouter(pool: PgPoolLike | null, token: string | null): Router {
  const router = Router();
  router.get("/business-feed", async (req, res, next) => {
    try {
      if (!token || !authorized(req.header("authorization"), token)) {
        res.status(401).json({ error: { code: "unauthorized", message: "A valid Authorization: Bearer token is required." } });
        return;
      }
      if (!pool) {
        res.json({ version: 1, clients: [] });
        return;
      }
      const rows = await gatherFeed(pool, new Date());
      res.json({ version: 1, clients: rows.map((r) => feedClientOf(token, r)) });
    } catch (err) {
      next(err);
    }
  });
  return router;
}
