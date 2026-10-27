import { createServer } from "node:http";
import { createApp, log } from "./app";
import { serveStatic } from "./static";

/**
 * The traditional, always running entry point: `npm run dev` on a developer
 * machine, and `npm start` (`node dist/index.cjs`) anywhere that runs this as
 * a long lived process rather than a function. Netlify's own function runtime
 * never imports this file; it imports `server/app.ts` directly through
 * `netlify/functions/api.ts`, so that importing the app never has the side
 * effect of opening a port. Keeping this path working is what lets `npm start`
 * remain a rollback: the same server, the same build, run anywhere that can
 * run a Node process, with no Netlify involved at all.
 */
(async () => {
  const app = await createApp();
  const httpServer = createServer(app);

  // importantly only setup vite in development and after every route is
  // registered, so the catch-all route doesn't interfere with the API. The
  // comparison is written out here rather than through a boolean so esbuild
  // can fold it and leave the Vite dev server out of the production bundle.
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
