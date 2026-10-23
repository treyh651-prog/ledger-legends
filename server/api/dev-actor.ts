/**
 * The development actor. NOTES 221.
 *
 * In memory mode there is no tenancy schema and so no way to resolve a bearer
 * token to a person, and before this file every guarded route answered 503
 * (NOTES 202). That made the screens untestable in the sandbox. This module
 * supplies one firm owner actor, through the same createActorMiddleware the
 * real server uses, so requireFirm and requireClient keep their exact logic
 * and only the token verifier and the actor store are stand ins.
 *
 * It is enabled only when NODE_ENV is not production and RUN_DB is memory. A
 * production process that finds DEV_ACTOR set refuses to start, because an
 * actor that any request can claim is not a thing a production server can
 * carry.
 */

import type { RequestHandler } from "express";
import type { Actor } from "../db/with-actor";
import { createActorMiddleware, type ActorMiddleware } from "../auth/middleware";
import type { ActorStore } from "../auth/actor-store";
import { TokenError, type TokenVerifier, type VerifiedToken } from "../auth/jwt";
import type { RunDb } from "../runs/db";
import { readSession } from "./session";

export const DEV_ACTOR_TOKEN = "development";

/** Fixed ids, so a restart of the memory server keeps the same firm. */
export const DEV_FIRM_ID = "00000000-0000-4000-8000-00000000f1a0";
export const DEV_USER_ID = "00000000-0000-4000-8000-0000000000a1";

export const DEV_ACTOR: Actor = {
  userId: DEV_USER_ID,
  authSubject: "dev|owner",
  email: "owner@firm.local",
  displayName: "Development Owner",
  memberships: [
    {
      firmId: DEV_FIRM_ID,
      firmSlug: "dev-firm",
      firmName: "Development Firm",
      clientId: null,
      scope: "firm",
      role: "owner",
    },
  ],
};

export class DevActorRefused extends Error {
  readonly code = "DEV_ACTOR_IN_PRODUCTION";
}

/**
 * DEV_ACTOR unset means "on when the memory port runs outside production",
 * which is what a developer wants from npm run dev. DEV_ACTOR=off turns it
 * off so the 503 behaviour of NOTES 202 can still be exercised. Any other
 * value is an explicit on.
 */
export function devActorWanted(env: NodeJS.ProcessEnv = process.env): "default" | "on" | "off" {
  const flag = (env.DEV_ACTOR ?? "").trim().toLowerCase();
  if (flag === "") return "default";
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return "off";
  return "on";
}

/**
 * Decide, and refuse loudly when the answer must be no. Called at startup.
 */
export function devActorEnabled(env: NodeJS.ProcessEnv = process.env, runDbKind: "memory" | "postgres" = "memory"): boolean {
  const wanted = devActorWanted(env);
  if (wanted === "off") return false;
  const production = env.NODE_ENV === "production";
  if (wanted === "on" && production) {
    throw new DevActorRefused("DEV_ACTOR is set and NODE_ENV is production. Unset it. The development actor never runs in production.");
  }
  if (wanted === "on" && runDbKind !== "memory") {
    throw new DevActorRefused("DEV_ACTOR is set but RUN_DB is not memory. The development actor only pairs with the memory port.");
  }
  return !production && runDbKind === "memory";
}

class DevVerifier implements TokenVerifier {
  async verify(token: string): Promise<VerifiedToken> {
    if (token !== DEV_ACTOR_TOKEN) {
      throw new TokenError("invalid", "not the development token");
    }
    return { subject: DEV_ACTOR.authSubject, email: DEV_ACTOR.email, expiresAt: null, via: "auth-server" };
  }
}

class DevStore implements ActorStore {
  constructor(private readonly actor: Actor) {}
  async findByAuthSubject(authSubject: string): Promise<Actor | null> {
    return authSubject === this.actor.authSubject ? this.actor : null;
  }
  async touchLastSeen(): Promise<void> {
    return;
  }
}

export interface DevActorRuntime {
  actor: Actor;
  middleware: ActorMiddleware;
  /** Puts the development token on a request that carries none. */
  assumeToken: RequestHandler;
}

export function buildDevActor(runDb: RunDb, actor: Actor = DEV_ACTOR): DevActorRuntime {
  const firmId = actor.memberships[0]?.firmId ?? DEV_FIRM_ID;
  const middleware = createActorMiddleware({
    verifier: new DevVerifier(),
    store: new DevStore(actor),
    clientFirm: async (clientId) => {
      const rows = await runDb.tx(readSession(actor, firmId, clientId), (tx) =>
        tx.query("client_by_id", { firmId, clientId }),
      );
      return rows[0]?.firmId ?? null;
    },
  });
  const assumeToken: RequestHandler = (req, _res, next) => {
    if (!req.headers.authorization) req.headers.authorization = `Bearer ${DEV_ACTOR_TOKEN}`;
    next();
  };
  return { actor, middleware, assumeToken };
}
