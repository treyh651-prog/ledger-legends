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
import { z } from "zod";

const runSucceeded = (status: string) => status === "completed" || status === "completed_with_skips" || status === "deduplicated";
const taskParamsSchema = clientParamsSchema.extend({ taskId: z.string().min(1) });
const setBillingStatusBodySchema = z.object({ billingStatus: z.enum(["current", "past_due"]) });
import { aging, budget, clientSetup, closeChecklist, firmRequests, firmTasks, forecast, journal, narratives, reconcile, reportPackages, rules, substantiation, taxForms, trialBalance } from "./reads-screens";
import { updateTaskBodySchema, type FirmMember, type FirmTeam } from "../../shared/api/screens";
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
import type { DocumentStorage } from "../storage/document-storage";
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

/** Where the firm's member list comes from. Memory mode has one development owner. */
export type MembersSource = (firmId: string) => Promise<FirmMember[]>;

export interface ApiDeps {
  /** Firm scoped memberships for the team and board screens. */
  members?: MembersSource;
  db: RunDb;
  guards: Pick<ActorMiddleware, "requireFirm" | "requireClient">;
  entitlements: EntitlementSource;
  /** Today, for tests. */
  today?: () => string;
  now?: () => Date;
  /** Where document bytes live. Null means uploads answer 501 and the screens say so. */
  storage?: DocumentStorage | null;
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
    "/team",
    route(async (req) => {
      const items = deps.members ? await deps.members(req.firm!.firmId) : [];
      return { body: { items } satisfies FirmTeam };
    }),
  );

  firm.get(
    "/tasks",
    route(async (req) => {
      const actor = req.actor!;
      const firmId = req.firm!.firmId;
      const period = screenPeriod(req);
      const body = await withOneRetry(() => deps.db.tx(readSession(actor, firmId, ""), (tx) => firmTasks(tx, firmId, period)));
      return { body };
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

  // Screen read models. Each answers for the client in the path and the
  // period in the query, or the current month when the query names none.
  const screenPeriod = (req: Request) => parse(periodQuerySchema, req.query).period ?? `${todayOf(deps).slice(0, 7)}-01`;

  firmClient.get(
    "/setup",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => clientSetup(tx, firmId, clientId));
      return { body };
    }),
  );

  /**
   * One task moved by hand. PRAC-UPDATE-TASK is a manual run, so the route
   * previews and applies in one request the way the portal's answer route
   * does, and the outcome is the payload either way.
   */
  firmClient.post(
    "/tasks/:taskId",
    route(async (req) => {
      const { clientId, taskId } = parse(taskParamsSchema, req.params);
      const body = parse(updateTaskBodySchema, req.body ?? {});
      const common = {
        db: deps.db,
        actor: req.actor!,
        firmId: req.firm!.firmId,
        clientId,
        runCode: "PRAC-UPDATE-TASK",
        via: "firm" as const,
        scope: { clientId, taskId, ...body },
        now: now(),
      };
      const preview = await triggerRun({ ...common, mode: "preview" });
      if (preview.status === "no_op") return { body: { preview, applied: null, done: true } };
      if (!runSucceeded(preview.status)) return { body: { preview, applied: null, done: false } };
      const applied = await triggerRun({ ...common, mode: "apply", previewRunId: preview.executionId });
      return { body: { preview, applied, done: runSucceeded(applied.status) } };
    }),
  );

  /**
   * Marks the client's engagement current or past due, firm staff only.
   * ENG-SET-BILLING-STATUS is a manual run; same preview then apply in one
   * request as the task route above. The engagement is the client's own, so
   * the route resolves it rather than trusting an id from the caller.
   */
  firmClient.post(
    "/billing-status",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const body = parse(setBillingStatusBodySchema, req.body ?? {});
      const firmId = req.firm!.firmId;
      const engagements = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) =>
        tx.query("engagements_for_client", { firmId, clientId }),
      );
      const engagement = engagements[0];
      if (!engagement) throw notFound("engagement");
      const common = {
        db: deps.db,
        actor: req.actor!,
        firmId,
        clientId,
        runCode: "ENG-SET-BILLING-STATUS",
        via: "firm" as const,
        scope: { clientId, engagementId: engagement.id, billingStatus: body.billingStatus },
        now: now(),
      };
      const preview = await triggerRun({ ...common, mode: "preview" });
      if (preview.status === "no_op") return { body: { preview, applied: null, done: true } };
      if (!runSucceeded(preview.status)) return { body: { preview, applied: null, done: false } };
      const applied = await triggerRun({ ...common, mode: "apply", previewRunId: preview.executionId });
      return { body: { preview, applied, done: runSucceeded(applied.status) } };
    }),
  );

  firmClient.get(
    "/close",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const period = screenPeriod(req);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => closeChecklist(tx, firmId, clientId, period));
      return { body };
    }),
  );

  firmClient.get(
    "/reconcile",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const period = screenPeriod(req);
      const { batchId } = parse(z.object({ batchId: z.string().uuid().optional() }), req.query);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) =>
        reconcile(tx, firmId, clientId, period, batchId ?? null),
      );
      return { body };
    }),
  );

  firmClient.get(
    "/requests",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => firmRequests(tx, firmId, clientId, todayOf(deps)));
      return { body };
    }),
  );

  firmClient.get(
    "/statements",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const period = screenPeriod(req);
      const firmId = req.firm!.firmId;
      // The firm sees every period, so the entitlement passed here grants open_period.
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) =>
        portalStatements(tx, firmId, clientId, period, { clientId, tier: null, rank: 0, features: new Set(["open_period"]) }),
      );
      return { body };
    }),
  );

  firmClient.get(
    "/trial-balance",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const period = screenPeriod(req);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => trialBalance(tx, firmId, clientId, period));
      return { body };
    }),
  );

  firmClient.get(
    "/aging",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => aging(tx, firmId, clientId, todayOf(deps)));
      return { body };
    }),
  );

  firmClient.get(
    "/budget",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const period = screenPeriod(req);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => budget(tx, firmId, clientId, period));
      return { body };
    }),
  );

  firmClient.get(
    "/forecast",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const { runId } = parse(z.object({ runId: z.string().uuid().optional() }), req.query);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => forecast(tx, firmId, clientId, runId ?? null));
      return { body };
    }),
  );

  firmClient.get(
    "/journal",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const period = screenPeriod(req);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => journal(tx, firmId, clientId, period));
      return { body };
    }),
  );

  firmClient.get(
    "/rules",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => rules(tx, firmId, clientId));
      return { body };
    }),
  );

  firmClient.get(
    "/tax-forms",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const { dataSetId } = parse(z.object({ dataSetId: z.string().uuid().optional() }), req.query);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => taxForms(tx, firmId, clientId, todayOf(deps), dataSetId ?? null));
      return { body };
    }),
  );

  firmClient.get(
    "/substantiation",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const period = screenPeriod(req);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => substantiation(tx, firmId, clientId, period));
      return { body };
    }),
  );

  firmClient.get(
    "/report-packages",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const period = screenPeriod(req);
      const { packageId } = parse(z.object({ packageId: z.string().uuid().optional() }), req.query);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => reportPackages(tx, firmId, clientId, period, packageId ?? null));
      return { body };
    }),
  );

  firmClient.get(
    "/narratives",
    route(async (req) => {
      const { clientId } = parse(clientParamsSchema, req.params);
      const period = screenPeriod(req);
      const firmId = req.firm!.firmId;
      const body = await deps.db.tx(readSession(req.actor!, firmId, clientId), (tx) => narratives(tx, firmId, clientId, period));
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
