import "dotenv/config";
import express, { type Express } from "express";
import { registerRoutes } from "./routes";
import { resolveRunDb } from "./db/run-db";
import { applyHardening, finalErrorHandler } from "./http-hardening";
import { buildAuthRuntime, readAppOrigin, type AuthRuntime } from "./auth/setup";
import { readSupabaseEnv } from "./auth/jwt";
import { buildDevActor, devActorEnabled, type DevActorRuntime } from "./api/dev-actor";

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

/**
 * Builds and returns the Express app with every route registered, and
 * nothing else: no `listen`, no static file serving, no Vite middleware.
 *
 * This is the one place both run paths share. `server/index.ts` calls this
 * and then listens, for a developer machine or a traditional always running
 * process. `netlify/functions/api.ts` calls this and wraps the result with
 * serverless-http, for a request scoped function invocation. A function
 * runtime that imported the old `server/index.ts` would have opened a port
 * nothing was listening on and, worse, would have tried to serve the built
 * client out of the function's own filesystem rather than letting the CDN do
 * it; neither belongs here, which is the reason this file exists apart from
 * `server/index.ts` rather than the function reusing it with a flag.
 *
 * Startup refusals are unchanged: a production process with no DATABASE_URL,
 * or with Postgres selected and a Supabase variable missing, throws here, on
 * the first call, same as it always has. A function runtime surfaces that as
 * a failed invocation with the refusal message, not a silently broken one.
 */
export async function createApp(): Promise<Express> {
  const app = express();
  const production = process.env.NODE_ENV === "production";

  const runDb = resolveRunDb();
  log(runDb.description, "db");

  let auth: AuthRuntime | null = null;
  let devActor: DevActorRuntime | null = null;
  if (runDb.kind === "postgres") {
    auth = buildAuthRuntime();
    for (const n of auth.notes) log(n, "auth");
  } else {
    log("sign in is off: runs execute in memory and there is no tenancy schema to resolve actors against", "auth");
  }
  if (devActorEnabled(process.env, runDb.kind)) {
    devActor = buildDevActor(runDb.db);
    log("development actor is on: every request is answered as the firm owner of the development firm. Never set DEV_ACTOR in production.", "auth");
  }

  applyHardening(app, {
    appOrigin: auth?.appOrigin ?? readAppOrigin(),
    supabaseUrl: auth?.browserConfig.supabaseUrl ?? readSupabaseEnv()?.supabaseUrl ?? null,
    production,
  });

  // Request log. Method, path, status, time. No bodies.
  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    res.on("finish", () => {
      if (path.startsWith("/api")) {
        log(`${req.method} ${path} ${res.statusCode} in ${Date.now() - start}ms`);
      }
    });
    next();
  });

  // registerRoutes wants an http.Server to hand back; nothing in this app
  // attaches anything to it (no WebSocket upgrade handler exists anywhere in
  // this codebase), so a function runtime that never creates one passes null
  // and registerRoutes's own use of it is limited to returning it unchanged.
  await registerRoutes(null as unknown as import("node:http").Server, app, { runDb, auth, devActor });

  app.use(finalErrorHandler);

  return app;
}
