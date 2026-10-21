/**
 * Actor middleware.
 *
 * Three guards, each one adding a requirement:
 *
 *   requireUser    a verified token that resolves to an active tenancy.users
 *                  row. Sets req.actor. 401 otherwise.
 *   requireFirm    requireUser, plus at least one firm scoped membership.
 *                  Sets req.firm to the selected one. 403 otherwise.
 *   requireClient  requireUser, plus access to the client named in the
 *                  route. Firm staff of the client's firm pass, and so does a
 *                  client scoped member of that client. Sets req.client.
 *                  403 otherwise, and 404 when the client does not exist for
 *                  this actor, which to the caller looks the same as a client
 *                  they may not see.
 *
 * Firm selection: a user with memberships in more than one firm names the
 * one they mean with an X-Firm header carrying the firm id or slug. With one
 * firm the header is optional. The header is never trusted on its own; it
 * only chooses among memberships the actor already has.
 *
 * Response shape for every refusal is { error: { code, message } }. Codes
 * are stable strings the client switches on; messages are for people.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Actor, ActorMembership } from "../db/with-actor";
import { DisabledUserError, type ActorStore } from "./actor-store";
import { TokenError, bearerToken, type TokenVerifier } from "./jwt";

export interface ClientScope {
  clientId: string;
  firmId: string;
  /** How the actor reaches this client. */
  via: "firm" | "client";
  role: ActorMembership["role"];
}

declare module "express-serve-static-core" {
  interface Request {
    actor?: Actor;
    firm?: ActorMembership;
    client?: ClientScope;
  }
}

export type AuthErrorCode =
  | "auth.missing_token"
  | "auth.malformed_token"
  | "auth.expired_token"
  | "auth.invalid_token"
  | "auth.unavailable"
  | "auth.no_user"
  | "auth.disabled"
  | "auth.no_firm"
  | "auth.ambiguous_firm"
  | "auth.forbidden"
  | "auth.not_found";

export function refuse(res: Response, status: number, code: AuthErrorCode, message: string): void {
  if (status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="ledger-legends"');
  res.status(status).json({ error: { code, message } });
}

export interface ActorMiddlewareDeps {
  verifier: TokenVerifier;
  store: ActorStore;
  /** For tests. */
  now?: () => number;
  /** Minimum gap between last_seen_at writes per user. */
  touchIntervalMs?: number;
  /** Looks up which firm a client belongs to. Returns null when unknown. */
  clientFirm: (clientId: string) => Promise<string | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActorMiddleware {
  requireUser: RequestHandler;
  requireFirm: RequestHandler;
  requireClient: (param?: string) => RequestHandler;
  /** Which firm membership an X-Firm header selects for an actor. */
  selectFirm: (actor: Actor, header: string | undefined) => { ok: true; firm: ActorMembership } | { ok: false; code: AuthErrorCode; message: string };
}

export function createActorMiddleware(deps: ActorMiddlewareDeps): ActorMiddleware {
  const now = deps.now ?? (() => Date.now());
  const touchInterval = deps.touchIntervalMs ?? 60_000;
  const lastTouched = new Map<string, number>();

  async function resolve(req: Request, res: Response): Promise<Actor | null> {
    if (req.actor) return req.actor;
    const token = bearerToken(req.header("authorization"));
    if (!token) {
      refuse(res, 401, "auth.missing_token", "Sign in to continue.");
      return null;
    }
    let subject: string;
    try {
      ({ subject } = await deps.verifier.verify(token));
    } catch (err) {
      if (err instanceof TokenError) {
        switch (err.reason) {
          case "expired":
            refuse(res, 401, "auth.expired_token", "Your session has expired. Sign in again.");
            return null;
          case "unavailable":
            refuse(res, 503, "auth.unavailable", "Sign in is temporarily unavailable. Try again shortly.");
            return null;
          case "malformed":
            refuse(res, 401, "auth.malformed_token", "The access token is not well formed.");
            return null;
          default:
            refuse(res, 401, "auth.invalid_token", "The access token did not verify.");
            return null;
        }
      }
      throw err;
    }
    let actor: Actor | null;
    try {
      actor = await deps.store.findByAuthSubject(subject);
    } catch (err) {
      if (err instanceof DisabledUserError) {
        refuse(res, 403, "auth.disabled", "This account has been disabled.");
        return null;
      }
      throw err;
    }
    if (!actor) {
      // A valid Supabase user with no tenancy row. This happens when someone
      // signs up outside the invitation flow, or after a revoked invitation
      // is cleaned up. They are not an actor here.
      refuse(res, 401, "auth.no_user", "This login is not a member of any firm.");
      return null;
    }
    req.actor = actor;
    const last = lastTouched.get(actor.userId) ?? 0;
    const t = now();
    if (t - last >= touchInterval) {
      lastTouched.set(actor.userId, t);
      deps.store.touchLastSeen(actor.userId).catch(() => undefined);
    }
    return actor;
  }

  function selectFirm(actor: Actor, header: string | undefined): ReturnType<ActorMiddleware["selectFirm"]> {
    const firms = actor.memberships.filter((m) => m.scope === "firm");
    if (firms.length === 0) {
      return { ok: false, code: "auth.no_firm", message: "This account is not a member of a firm." };
    }
    const want = header?.trim();
    if (!want) {
      if (firms.length === 1) return { ok: true, firm: firms[0] };
      return {
        ok: false,
        code: "auth.ambiguous_firm",
        message: "This account belongs to more than one firm. Send X-Firm with the firm id or slug.",
      };
    }
    const match = firms.find((f) => f.firmId === want || f.firmSlug === want);
    if (!match) return { ok: false, code: "auth.forbidden", message: "You are not a member of that firm." };
    return { ok: true, firm: match };
  }

  const requireUser: RequestHandler = (req, res, next) => {
    resolve(req, res)
      .then((actor) => {
        if (actor) next();
      })
      .catch(next);
  };

  const requireFirm: RequestHandler = (req, res, next) => {
    resolve(req, res)
      .then((actor) => {
        if (!actor) return;
        const sel = selectFirm(actor, req.header("x-firm"));
        if (!sel.ok) {
          refuse(res, 403, sel.code, sel.message);
          return;
        }
        req.firm = sel.firm;
        next();
      })
      .catch(next);
  };

  const requireClient =
    (param = "clientId"): RequestHandler =>
    (req, res, next) => {
      resolve(req, res)
        .then(async (actor) => {
          if (!actor) return;
          const clientId = String(req.params[param] ?? "").trim();
          if (!UUID.test(clientId)) {
            refuse(res, 404, "auth.not_found", "No such client.");
            return;
          }
          const direct = actor.memberships.find((m) => m.scope === "client" && m.clientId === clientId);
          if (direct) {
            req.client = { clientId, firmId: direct.firmId, via: "client", role: direct.role };
            next();
            return;
          }
          const firmId = await deps.clientFirm(clientId);
          if (firmId) {
            const staff = actor.memberships.find((m) => m.scope === "firm" && m.firmId === firmId);
            if (staff) {
              req.client = { clientId, firmId, via: "firm", role: staff.role };
              next();
              return;
            }
          }
          // Same answer whether the client is missing or belongs to someone
          // else. Confirming existence would be a small leak.
          refuse(res, 404, "auth.not_found", "No such client.");
        })
        .catch(next);
    };

  return { requireUser, requireFirm, requireClient, selectFirm };
}

/** Express error handler that turns stray TokenErrors into 401s. */
export function authErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof TokenError && !res.headersSent) {
    refuse(res, 401, "auth.invalid_token", "The access token did not verify.");
    return;
  }
  next(err);
}
