import type { Express } from "express";
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { storage } from "./storage";
import { resolveRunDb } from "./db/run-db";
import { schedulerStatus } from "./sched/status";

/**
 * GET /api/sched/status
 *
 * The operator surface's read path. One route, read only, no parameters a
 * caller can use to reach another firm: the firm and the actor come from the
 * process environment, which is the same pair the Trigger.dev tasks run as.
 *
 * There is no write route here on purpose. Enabling a schedule, disabling
 * one, or freezing one by hand changes what a clock will do to a client's
 * books without a person present, and that belongs behind the same
 * authenticated path as every other write rather than behind an unauthorised
 * route added alongside a read. Until this application has sessions, the
 * writes are inserts and updates a person makes deliberately.
 */
export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/sched/status", async (_req, res) => {
    const firmId = (process.env.SCHEDULER_FIRM_ID ?? "").trim();
    const actorId = (process.env.SCHEDULER_ACTOR_ID ?? "").trim();
    if (firmId === "" || actorId === "") {
      // Not an error. A machine with no scheduler configured is the normal
      // state of a developer checkout, and the surface says so rather than
      // showing a red banner about it.
      res.json({
        configured: false,
        reason:
          "SCHEDULER_FIRM_ID and SCHEDULER_ACTOR_ID are not set in this process, so there is no firm to report on",
      });
      return;
    }
    try {
      const { db } = resolveRunDb();
      const status = await schedulerStatus(db, { firmId, userId: actorId }, new Date());
      res.json({ configured: true, status });
    } catch (err) {
      res.status(500).json({
        configured: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return httpServer;
}
