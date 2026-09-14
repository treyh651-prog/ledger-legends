/**
 * Trigger.dev project configuration.
 *
 * Read the deploy notes in docs/SCHEDULING.md before changing anything here.
 * Two things about this file are load bearing.
 *
 * FIRST, the project reference is required and its absence is loud.
 *
 * `npx trigger.dev@latest deploy` reads this file to learn which project it is
 * deploying to. If `project` were an empty string or a placeholder, the deploy
 * would either go nowhere or, worse, appear to succeed against a project that
 * is not this firm's. So a missing TRIGGER_PROJECT_REF throws here, at the
 * moment the CLI loads the config, with a message that names the variable and
 * where to find its value. A deploy that silently does nothing costs the
 * operator an afternoon of wondering why nothing runs at 6am.
 *
 * Nothing in the seven gates imports this file. `tsc --noEmit` typechecks it
 * without executing it, so the gates pass on a machine where neither
 * TRIGGER_PROJECT_REF nor any Trigger.dev credential is set, which is the true
 * state of the operator's machine today.
 *
 * SECOND, this file holds no secret and asks for none.
 *
 * The project reference is the identifier in the dashboard URL. It is not a
 * credential. The CLI authenticates separately, with TRIGGER_ACCESS_TOKEN in
 * CI or an interactive `npx trigger.dev@latest login` on a laptop, and the
 * deployed tasks reach the database through DATABASE_URL set in the
 * Trigger.dev dashboard under Environment Variables. Neither value is read
 * here, stored here, or committed anywhere in this repository.
 */

import { defineConfig } from "@trigger.dev/sdk";

const projectRef = (process.env.TRIGGER_PROJECT_REF ?? "").trim();

if (projectRef === "") {
  throw new Error(
    [
      "TRIGGER_PROJECT_REF is not set, so there is no project to deploy to.",
      "",
      "Find the reference in the Trigger.dev dashboard. Open the project and",
      "read it out of the address bar: it is the segment after /projects/ and",
      "it starts with proj_. Then run the deploy with it in front:",
      "",
      "  TRIGGER_PROJECT_REF=proj_your_reference npx trigger.dev@latest deploy",
      "",
      "This throws instead of defaulting, because a deploy pointed at no",
      "project is a deploy that looks fine and schedules nothing.",
    ].join("\n"),
  );
}

export default defineConfig({
  project: projectRef,

  // Only this directory. Everything under server/ is library code the tasks
  // import, and a stray file matching their task glob would be deployed as a
  // task nobody meant to declare.
  dirs: ["./trigger"],

  runtime: "node",

  /**
   * Fifteen minutes. A nightly tick across every client in the firm is the
   * longest of these, and a tick that has not finished in fifteen minutes has
   * something wrong with it rather than something slow. The window rows it
   * claimed are taken back by the next sweep, so an interrupted tick loses
   * nothing except the time.
   */
  maxDuration: 900,

  retries: {
    // A retry loop on a developer laptop hides the error that caused it.
    enabledInDev: false,
    /**
     * Three attempts, well spaced.
     *
     * Retrying is safe here for exactly one reason, and it is worth stating
     * where the retry policy is configured rather than somewhere else: the
     * unique constraint on (schedule_id, window_start) in migration 0022
     * means an attempt that already claimed and ran a window cannot claim it
     * again. A second attempt finds the row present, treats the collision as
     * an ordinary outcome, and moves on. Without that constraint, three
     * attempts would mean three postings.
     *
     * Thirty seconds before the first retry, because the failures worth
     * retrying are a database failover or a momentary connection limit, and
     * both take longer than a second to clear.
     */
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 30_000,
      maxTimeoutInMs: 300_000,
      factor: 2,
      randomize: true,
    },
  },

  build: {
    /**
     * pg ships a native path and their bundler should not try to inline it.
     * Everything else this repository imports is plain TypeScript and bundles
     * cleanly.
     */
    external: ["pg"],
  },
});
