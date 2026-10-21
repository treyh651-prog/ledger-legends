import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { registerRoutes } from "./routes";
import { resolveRunDb } from "./db/run-db";
import { serveStatic } from "./static";
import { applyHardening, finalErrorHandler } from "./http-hardening";
import { buildAuthRuntime, readAppOrigin, type AuthRuntime } from "./auth/setup";
import { readSupabaseEnv } from "./auth/jwt";

const app = express();
const httpServer = createServer(app);
const production = process.env.NODE_ENV === "production";

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

(async () => {
  // Before anything serves a request. A production process with no DATABASE_URL
  // throws here, on purpose, because starting and then failing on the first run
  // hides the configuration mistake behind a broken feature.
  const runDb = resolveRunDb();
  log(runDb.description, "db");

  // Auth follows the database. With Postgres there is a tenancy schema to
  // resolve actors against and the Supabase variables are required; a missing
  // one is a startup refusal, same as DATABASE_URL. In memory mode there is
  // nothing to resolve against, so the server runs with sign in off and says so.
  let auth: AuthRuntime | null = null;
  if (runDb.kind === "postgres") {
    auth = buildAuthRuntime();
    for (const n of auth.notes) log(n, "auth");
  } else {
    log("sign in is off: runs execute in memory and there is no tenancy schema to resolve actors against", "auth");
  }

  applyHardening(app, {
    appOrigin: auth?.appOrigin ?? readAppOrigin(),
    supabaseUrl: auth?.browserConfig.supabaseUrl ?? readSupabaseEnv()?.supabaseUrl ?? null,
    production,
  });

  // Request log. Method, path, status, time. No bodies: the bodies on this
  // API are memberships and email addresses, and a log line is forever.
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

  await registerRoutes(httpServer, app, { runDb, auth });

  app.use(finalErrorHandler);

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes. The comparison is written out
  // here rather than through the `production` constant so esbuild can fold it
  // and leave the Vite dev server out of the production bundle.
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})().catch((err: unknown) => {
  // A startup refusal, most often DATABASE_URL missing in production. Print the
  // message and nothing else, then exit non zero so the platform reports a
  // failed deploy rather than a running process that cannot work.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
