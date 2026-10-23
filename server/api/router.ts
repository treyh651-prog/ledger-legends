/**
 * The API routes. Doc 11 is the prose version of this file.
 *
 * Two mounts. /api/firm requires firm scope. /api/portal requires client
 * scope or firm scope, and a firm member sees the portal read only, as the
 * client would. Every route validates its params, query, and body with the
 * schema from shared/api, opens its reads under a human session so RLS is
 * live, and lets the one error translator shape every failure.
 */

import { Router, type Request, type RequestHandler } from "express";
import type { ZodType } from "zod";
import { clientParamsSchema, periodQuerySchema } from "../../shared/api/common";
import { createClientBodySchema } from "../../shared/api/clients";
import {
  applyBodySchema,
  logParamsSchema,
  runHistoryQuerySchema,
  runParamsSchema,
  triggerRunBodySchema,
  undoBodySchema,
} from "../../shared/api/runs";
import { transactionQuerySchema } from "../../shared/api/transactions";
import type { ActorMiddleware } from "../auth/middleware";
import {
  featuresForTier,
  isTierId,
  tierRank,
  type FeatureKey,
} from "../../shared/tiers";
import {
  assertFeature,
  loadEntitlement,
  type Entitlement,
  type EntitlementRow,
  type EntitlementSource,
} from "../entitlement";
import type { RunDb } from "../runs/db";
import { ApiFailure, notConfigured, notFound, withOneRetry } from "./errors";
import {
  firmOverview,
  getClient,
  listClients,
  portalHome,
  portalStatements,
  runHistory,
  transactionPage,
} from "./reads";
import { applyPreview, createClient, runCatalog, triggerRun, undoApplied } from "./runs";
import { readSession } from "./session";
import { createFirmMessagesRouter, createPortalScreensRouter } from "./portal-router";

export interface ApiDeps {
  db: RunDb;
  guards: Pick<ActorMiddleware, "requireFirm" | "requireClient">;
  entitlements: EntitlementSource;
  /** Today, for tests. */
  today?: () => string;
  now?: () => Date;
}

/**
 * An entitlement source over the run port, for the memory server and the
 * tests. The Postgres server uses PostgresEntitlementSource, whose view
 * applies the same rule: one active engagement, dated to cover today, grants
 * the features of its tier and nothing else.
 */
export class RunDbEntitlementSource implements EntitlementSource {
  constructor(
    private readonly db: RunDb,
    private readonly actorId: string,
    private readonly firmId: string,
    private readonly today: () => string = () => new Date().toISOString().slice(0, 10),
  ) {}

  async rowsForClient(clientId: string): Promise<EntitlementRow[]> {
    const rows = await this.db.tx(readSession({ userId: this.actorId }, this.firmId, clientId), (tx) =>
      tx.query("engagements_for_client", { firmId: this.firmId, clientId }),
    );
    const today = this.today();
    const active = rows.filter(
      (e) => e.status === "active" && e.startDate <= today && (e.endDate === null || e.endDate >= today),
    );
    const e = active[0];
    if (!e || !isTierId(e.serviceLevel)) return [];
    const tier = e.serviceLevel;
    return featuresForTier(tier)
      .map((f) => ({ clientId, tierId: tier, rank: tierRank(tier), featureKey: f.id }))
      .sort((a, b) => (a.featureKey < b.featureKey ? -1 : 1));
  }
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

/** Wrap an async handler so a throw reaches the error translator. */
function route(fn: (req: Request) => Promise<{ status?: number; body: unknown }>): RequestHandler {
  return (req, res, next) => {
    fn(req)
      .then((out) => {
        res.status(out.status ?? 200).json(out.body);
      })
      .catch(next);
  };
}

function todayOf(deps: ApiDeps): string {
  return deps.today ? deps.today() : new Date().toISOString().slice(0, 10);
}

export function createApiRouter(deps: ApiDeps): Router {
  const api = Router();
  const { requireFirm, requireClient } = deps.guards;
  const now = deps.now ?? (() => new Date());

  const entitlementFor = async (req: Request): Promise<Entitlement> => {
    const client = req.client;
    if (!client) throw new ApiFailure(400, "client_required", "A client is required.");
    return loadEntitlement(deps.entitlements, client.clientId);
  };

  /* ---------------- Firm ---------------- */

  const firm = Router();
  firm.use(requireFirm);

  firm.get(
    "/overview",
    route(async (req) => {
      const actor = req.actor!;
      const firmId = req.firm!.firmId;
      const body = await withOneRetry(() =>
        deps.db.tx(readSession(actor, firmId, ""), (tx) => firmOverview(tx, firmId, todayOf(deps))),
      );
      return { body };
    }),
  );

  firm.get(
    "/clients",
    route(async (req) => {
      const actor = req.actor!;
      const firmId = req.firm!.firmId;
      const items = await withOneRetry(() => deps.db.tx(readSession(actor, firmId, ""), (tx) => listClients(tx, firmId)));
      return { body: { items } };
    }),
  );

  firm.post(
    "/clients",
    route(async (req) => {
      const actor = req.actor!;
      const firmId = req.firm!.firmId;
      const body = parse(createClientBodySchema, req.body);
      const result = await createClient(deps.db, actor, firmId, body, now());
      const client = await deps.db.tx(readSession(actor, firmId, result.clientId), (tx) => getClient(tx, firmId, result.clientId));
      return { status: result.complete ? 201 : 207, body: { client, runs: result.runs, complete: result.complete } };
    }),
  );

  firm.get(
    "/runs/catalog",
    route(async () => ({ body: { items: runCatalog() } })),
  );

  firm.post(
    "/runs/:logId/apply",
    route(async (req) => {
      const { logId } = parse(logParamsSchema, req.params);
      parse(applyBodySchema, req.body ?? {});
      const outcome = await applyPreview(deps.db, req.actor!, req.firm!.firmId, logId, now());
      return { body: outcome };
    }),
  );

  firm.post(
    "/runs/:logId/undo",
    route(async (req) => {
      const { logId } = parse(logParamsSchema, req.params);
      parse(undoBodySchema, req.body ?? {});
      const outcome = await undoApplied(deps.db, req.actor!, req.firm!.firmId, logId, now());
      return { body: outcome };
    }),
  );

  // Client scoped firm routes. requireClient resolves the client within the
  // actor's firm and answers 404 for anything else, so a client id from
  // another firm is indistinguishable from a missing one.
  const firmClient = Router({ mergeParams: true });
  firmClient.use(requireClient("clientId"));

  firmClient.get(
    "/",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const firmId = req.firm!.firmId;
      const client = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => getClient(tx, firmId, clientId));
      if (!client) throw notFound("client");
      return { body: client };
    }),
  );

  firmClient.get(
    "/transactions",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const q = parse(transactionQuerySchema, req.query);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => transactionPage(tx, firmId, clientId, q));
      return { body };
    }),
  );

  firmClient.get(
    "/runs",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const q = parse(runHistoryQuerySchema, req.query);
      const firmId = req.firm!.firmId;
      const page = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => runHistory(tx, firmId, clientId, q));
      return { body: { ...page, limit: q.limit, offset: q.offset } };
    }),
  );

  firmClient.post(
    "/runs/:runCode",
    route(async (req) => {
      const { clientId, runCode } = parse(runParamsSchema, req.params);
      const body = parse(triggerRunBodySchema, req.body ?? {});
      const outcome = await triggerRun({
        db: deps.db,
        actor: req.actor!,
        firmId: req.firm!.firmId,
        clientId,
        via: req.client!.via,
        runCode,
        mode: body.mode,
        previewRunId: body.previewRunId,
        scope: body.scope,
        now: now(),
      });
      return { status: outcome.status === "refused" || outcome.status === "rejected_locked" ? 409 : 200, body: outcome };
    }),
  );

  firm.use("/clients/:clientId", createFirmMessagesRouter({ deps, entitlementFor }));
  firm.use("/clients/:clientId", firmClient);
  api.use("/firm", firm);

  /* ---------------- Portal ---------------- */

  /**
   * The tiers brief's requireFeature answers in its own shape. Routing the
   * same check through the translator keeps every error in the one envelope
   * (docs/11-api.md), so the screens show one message format.
   */
  const requireFeature = (key: FeatureKey, resolve: (req: Request) => Promise<Entitlement>): RequestHandler => (req, res, next) => {
    resolve(req)
      .then((ent) => {
        assertFeature(ent, key);
        res.locals.entitlement = ent;
        next();
      })
      .catch(next);
  };

  const portal = Router({ mergeParams: true });
  portal.use(requireClient("clientId"));

  portal.get(
    "/home",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const firmId = req.client!.firmId;
      const ent = await entitlementFor(req);
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => portalHome(tx, firmId, clientId, ent));
      if (!body) throw notFound("client");
      return { body };
    }),
  );

  portal.get(
    "/statements",
    requireFeature("statements", entitlementFor),
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const { period } = parse(periodQuerySchema, req.query);
      const firmId = req.client!.firmId;
      const ent = await entitlementFor(req);
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), async (tx) => {
        const chosen = period ?? (await latestVisiblePeriod(tx, firmId, clientId, ent, todayOf(deps)));
        return portalStatements(tx, firmId, clientId, chosen, ent);
      });
      return { body };
    }),
  );

  portal.get(
    "/transactions",
    requireFeature("transactions", entitlementFor),
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const q = parse(transactionQuerySchema, req.query);
      const firmId = req.client!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => transactionPage(tx, firmId, clientId, q));
      return { body };
    }),
  );

  // Uploads wait on object storage. 501 with a message a screen can show.
  const needsStorage: RequestHandler = (_req, _res, next) => {
    next(notConfigured("Document storage is not set up yet. Uploads will open once it is."));
  };
  portal.post("/upload", requireFeature("documents", entitlementFor), needsStorage);

  // Requests, messages, documents, signing and the Legend screens live in
  // portal-router.ts, docs/11-api.md and NOTES 240 onward.
  api.use("/portal/:clientId", createPortalScreensRouter({ deps, entitlementFor }));
  api.use("/portal/:clientId", portal);

  return api;
}

/**
 * The period the statements screen opens on: the latest the tier lets the
 * client see, or the current month when nothing has been closed yet so the
 * screen can say so for a real period rather than for nothing.
 */
async function latestVisiblePeriod(
  tx: Parameters<Parameters<RunDb["tx"]>[1]>[0],
  firmId: string,
  clientId: string,
  ent: Entitlement,
  today: string,
): Promise<string> {
  const periods = await tx.query("close_periods_for_client", { firmId, clientId });
  const locked = periods.filter((p) => p.status === "locked").map((p) => p.periodStart).sort();
  if (locked.length > 0) return locked[locked.length - 1];
  if (ent.features.has("open_period")) {
    const open = periods.filter((p) => p.status === "open").map((p) => p.periodStart).sort();
    if (open.length > 0) return open[0];
  }
  return `${today.slice(0, 7)}-01`;
}
