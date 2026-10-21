import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { Server } from "node:http";
import rateLimit from "express-rate-limit";
import { resolveRunDb, type ResolvedRunDb } from "./db/run-db";
import { schedulerStatus } from "./sched/status";
import type { AuthRuntime } from "./auth/setup";
import { authErrorHandler, refuse } from "./auth/middleware";
import {
  InvitationError,
  createInvitation,
  listInvitations,
  revokeInvitation,
  validateInvitation,
  type InvitationDeps,
} from "./auth/invitations";
import { AuthAdminError } from "./auth/auth-admin";

/**
 * Routes.
 *
 * Two kinds. Public routes, which carry no actor and say only things that
 * are already public (is auth configured, and with which project URL and
 * anon key). Guarded routes, which sit behind the actor middleware and reach
 * the database only inside withActor.
 *
 * The scheduler status route used to read SCHEDULER_FIRM_ID from the
 * environment because the server had no notion of who was asking. It now has
 * one: the firm is the actor's firm, selected by membership, and the actor
 * is the signed in user. The environment pair is still what the Trigger.dev
 * tasks run as, and is no longer consulted here.
 */

export interface RouteDeps {
  runDb: ResolvedRunDb;
  /** Null when the server runs without auth (memory mode on a developer machine). */
  auth: AuthRuntime | null;
}

/** Tight limit for routes that do work on behalf of an unauthenticated caller. */
export const publicLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Too many requests. Slow down." } },
});

/** Looser limit for the authenticated API. Per address, which is what we have before the token is read. */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Too many requests. Slow down." } },
});

const noAuth: RequestHandler = (_req, res) => {
  refuse(res, 503, "auth.unavailable", "This server is running without sign in. Set the Supabase variables to enable it.");
};

export async function registerRoutes(httpServer: Server, app: Express, deps?: RouteDeps): Promise<Server> {
  const runDb = deps?.runDb ?? resolveRunDb();
  const auth = deps?.auth ?? null;

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // What the browser needs to start a session. Public by design: the anon key
  // is the key Supabase expects browsers to hold, and row level security on
  // the Supabase side is what protects data from it. This server does not use
  // PostgREST, so the anon key reaches no table here.
  app.get("/api/auth/config", publicLimiter, (_req, res) => {
    if (!auth) {
      res.json({ configured: false, reason: "sign in is off, this server runs without Supabase auth" });
      return;
    }
    res.json({ configured: true, supabaseUrl: auth.browserConfig.supabaseUrl, anonKey: auth.browserConfig.anonKey });
  });

  app.use("/api", apiLimiter);

  if (!auth) {
    app.use("/api", (req, res, next) => {
      if (req.path === "/auth/config") return next();
      noAuth(req, res, next);
    });
    return httpServer;
  }

  const { requireUser, requireFirm } = auth.middleware;
  const inv: InvitationDeps = { pool: auth.pool, authAdmin: auth.authAdmin, appOrigin: auth.appOrigin, actorOpts: auth.actorOpts };

  app.get("/api/auth/me", requireUser, (req, res) => {
    const a = req.actor!;
    res.json({
      userId: a.userId,
      email: a.email,
      displayName: a.displayName,
      memberships: a.memberships,
    });
  });

  app.get("/api/sched/status", requireFirm, async (req, res, next) => {
    try {
      const status = await schedulerStatus(runDb.db, { firmId: req.firm!.firmId, userId: req.actor!.userId }, new Date());
      res.json({ configured: true, status });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/invitations", requireFirm, async (req, res, next) => {
    try {
      res.json({ invitations: await listInvitations(inv, req.actor!, req.firm!) });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/invitations", requireFirm, async (req, res, next) => {
    try {
      const input = validateInvitation(req.body);
      const out = await createInvitation(inv, req.actor!, req.firm!, input);
      res.status(201).json(out);
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/invitations/:membershipId", requireFirm, async (req, res, next) => {
    try {
      res.json(await revokeInvitation(inv, req.actor!, req.firm!, String(req.params.membershipId)));
    } catch (err) {
      next(err);
    }
  });

  // Anything else under /api that reached here is not a route. Say so in the
  // same shape as everything else, after the guards have had their say.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "No such route." } });
  });

  app.use(authErrorHandler);
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof InvitationError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err instanceof AuthAdminError) {
      res.status(502).json({ error: { code: `auth_admin.${err.code}`, message: "The sign in service refused the request." } });
      return;
    }
    next(err);
  });

  return httpServer;
}
