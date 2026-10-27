import serverless from "serverless-http";
import { createApp } from "../../server/app";
import type { Handler } from "@netlify/functions";

/**
 * The Netlify Function entry point. `createApp` builds the same Express app
 * `server/index.ts` builds for a traditional process, minus the listen call;
 * serverless-http adapts one request at a time to it, which is all a function
 * invocation ever is. The app is built once per cold start and reused for
 * every invocation the same container serves afterward, including the one
 * `pg.Pool` in `server/db/pool.ts`, which is why that pool stays alive here
 * rather than closing at the end of a request: a Netlify function freezes
 * between invocations rather than exiting, and closing it would mean paying
 * a new connection on every single request instead of only on a cold one.
 *
 * netlify.toml routes `/api/*` to this function before the SPA fallback, so
 * every request this function sees already carries that prefix; nothing
 * outside `/api` is expected to reach here, and the Express app mounted by
 * `createApp` only answers `/healthz` and `/api/*` in any case.
 */
let handlerPromise: Promise<Handler> | null = null;

function getHandler(): Promise<Handler> {
  if (!handlerPromise) {
    handlerPromise = createApp().then((app) => serverless(app) as unknown as Handler);
  }
  return handlerPromise;
}

export const handler: Handler = async (event, context) => {
  if (event.httpMethod === "POST") {
    console.log(
      "DEBUG event",
      JSON.stringify({
        httpMethod: event.httpMethod,
        path: event.path,
        isBase64Encoded: event.isBase64Encoded,
        bodyType: typeof event.body,
        bodyLength: event.body ? event.body.length : null,
        bodyPreview: event.body ? event.body.slice(0, 120) : null,
        contentType: event.headers?.["content-type"] ?? event.headers?.["Content-Type"],
        contentLength: event.headers?.["content-length"] ?? event.headers?.["Content-Length"],
        headerKeys: Object.keys(event.headers ?? {}),
      }),
    );
  }
  const h = await getHandler();
  return h(event, context);
};
