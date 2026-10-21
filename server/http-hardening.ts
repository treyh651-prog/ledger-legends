/**
 * HTTP hardening, in one place so the choices are visible together.
 *
 * Security headers (helmet), a content security policy, CORS pinned to the
 * application origin, and request body limits. Rate limiting is applied by
 * route in routes.ts because the right limit differs between the public and
 * guarded surfaces.
 *
 * The content security policy is strict in production and loosened only
 * where development needs it: Vite's dev client injects an inline script for
 * React refresh and talks to its HMR websocket, neither of which exists in a
 * production build.
 *
 * connect-src names the Supabase project URL because the browser talks to
 * Supabase Auth directly to sign in; everything else the browser calls is
 * same origin. Fonts come from Google Fonts, which client/index.html loads.
 */

import cors from "cors";
import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import helmet from "helmet";

export interface HardeningOptions {
  /** Origin the browser loads the app from. Null means same origin only. */
  appOrigin: string | null;
  /** Supabase project URL, allowed as a connect-src. Null when auth is off. */
  supabaseUrl: string | null;
  production: boolean;
  /** JSON body limit. Invitations are tiny; nothing here uploads. */
  jsonLimit?: string;
}

export function buildCsp(opts: HardeningOptions): Record<string, string[]> {
  const connect = ["'self'"];
  if (opts.supabaseUrl) {
    connect.push(opts.supabaseUrl, opts.supabaseUrl.replace(/^http/, "ws"));
  }
  if (!opts.production) connect.push("ws:", "wss:");
  const script = ["'self'"];
  if (!opts.production) script.push("'unsafe-inline'");
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
    "script-src": script,
    // Tailwind and Radix set style attributes at runtime; 'unsafe-inline' on
    // styles is the accepted cost of that and does not permit script.
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
    "img-src": ["'self'", "data:", "blob:"],
    "connect-src": connect,
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
  };
  if (opts.production) directives["upgrade-insecure-requests"] = [];
  return directives;
}

export function applyHardening(app: Express, opts: HardeningOptions): void {
  // Behind one proxy hop (the hosting platform). Rate limiting and secure
  // cookie logic read the client address from X-Forwarded-For; trusting more
  // hops than exist would let a caller choose their own address.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: buildCsp(opts) },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "same-origin" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      hsts: opts.production ? { maxAge: 15_552_000, includeSubDomains: true } : false,
      frameguard: { action: "deny" },
      noSniff: true,
      originAgentCluster: true,
      dnsPrefetchControl: { allow: false },
      permittedCrossDomainPolicies: { permittedPolicies: "none" },
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    next();
  });

  // The app is served from the same origin as the API, so cross origin
  // requests are not expected. CORS is pinned to APP_ORIGIN for the case
  // where the operator fronts the API from a different host; with no
  // APP_ORIGIN, no cross origin request is allowed.
  app.use(
    cors({
      origin: opts.appOrigin ? [opts.appOrigin] : false,
      methods: ["GET", "POST", "DELETE"],
      allowedHeaders: ["Authorization", "Content-Type", "X-Firm"],
      credentials: false,
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: opts.jsonLimit ?? "64kb", strict: true }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
}

/**
 * The last error handler. Anything that reaches here is either a client
 * error from the body parser (too large, bad JSON) which carries a safe
 * status and message, or a server error, which does not: stack traces and
 * driver messages name tables and columns, so the browser gets a fixed line
 * and the log gets the rest.
 */
export function finalErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const e = err as { status?: number; statusCode?: number; type?: string; message?: string; expose?: boolean };
  const status = e?.status ?? e?.statusCode ?? 500;
  if (res.headersSent) {
    next(err);
    return;
  }
  if (status >= 500) {
    console.error("Internal Server Error:", err);
    res.status(500).json({ error: { code: "internal", message: "Something went wrong on our side." } });
    return;
  }
  res.status(status).json({ error: { code: e?.type ?? "bad_request", message: e?.expose === false ? "Bad request." : (e?.message ?? "Bad request.") } });
}
