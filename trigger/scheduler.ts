/**
 * The four declared schedules, and nothing else.
 *
 * Every task here is a wrapper. It resolves the database port, builds the
 * service actor, calls tick() in server/sched/runner.ts, and returns the
 * report. There is no decision in this file, on purpose: this is the only code
 * in the repository that runs on somebody else's platform, inside a bundle
 * built by their CLI, and it is the hardest code here to test. So it holds no
 * logic worth testing. The logic is in server/sched/, covered by the suite,
 * running against the memory port with no network.
 *
 * WHY FOUR SCHEDULES AND NOT ONE PER CLIENT.
 *
 * Trigger.dev supports imperative schedules, one per client, created through
 * their API. That would put the firm's client list inside their dashboard and
 * make signing a client a two system operation: a row here, and an API call
 * there that can fail on its own. These four declared schedules are a wake up
 * call instead. They fire, and this process reads sched.schedules to find out
 * what that means. Signing a client is one insert.
 *
 * The consequence is that the cron expressions below are coarse, and the real
 * cadence lives in the database where a person can read it, change it, and see
 * its history. See NOTES 182.
 *
 * WHY THE TIMES ARE 06:00 DENVER AND THE SWEEP IS NOT.
 *
 * The three cadence ticks carry `timezone: "America/Denver"`, so they fire at
 * six in the morning local through the whole year rather than drifting an hour
 * twice a year. Trigger.dev's own daylight saving handling is theirs, but this
 * process does not depend on it: window boundaries come from
 * server/runs/dates.ts, and a tick that arrives at the wrong hour still
 * resolves the correct windows. The sweep runs every six hours on UTC, because
 * a safety net does not care what the clocks did.
 */

import { schedules } from "@trigger.dev/sdk";

import { resolveRunDb } from "../server/db/run-db";
import { tick, type SchedulerActor, type TickReport } from "../server/sched/runner";

/**
 * Who the scheduler is, read from the environment at run time.
 *
 * Both values are identifiers rather than credentials. Set them in the
 * Trigger.dev dashboard under Environment Variables, beside DATABASE_URL. The
 * actor needs a firm scope membership in tenancy.memberships, because row
 * level security answers every read in a tick from that membership.
 */
function actorFromEnv(): SchedulerActor {
  const firmId = (process.env.SCHEDULER_FIRM_ID ?? "").trim();
  const userId = (process.env.SCHEDULER_ACTOR_ID ?? "").trim();
  if (firmId === "" || userId === "") {
    throw new Error(
      "SCHEDULER_FIRM_ID and SCHEDULER_ACTOR_ID must both be set in the Trigger.dev environment. " +
        "They name the firm the tick runs for and the firm scope service membership it runs as. " +
        "Neither is a secret. See docs/SCHEDULING.md.",
    );
  }
  return { firmId, userId };
}

interface TickPayload {
  timestamp: Date;
  lastTimestamp?: Date;
  timezone: string;
  scheduleId: string;
  externalId?: string;
  upcoming: Date[];
}

async function runTick(
  payload: TickPayload,
  triggerRunId: string,
  cadences: ReadonlyArray<"daily" | "weekly" | "monthly_day" | "monthly_business_day"> | undefined,
  sweep: boolean,
): Promise<TickReport> {
  const { db, description } = resolveRunDb();
  // Printed rather than assumed. A task that quietly ran against the memory
  // port would report every window as succeeded and write nothing.
  console.log(`scheduler tick: ${description}`);
  return tick(db, {
    actor: actorFromEnv(),
    // The platform's timestamp, not a clock read inside the task. A retry an
    // hour later resolves the same windows the first attempt did.
    now: payload.timestamp,
    cadences,
    triggerRunId,
    sweep,
  });
}

/**
 * The nightly tick. Daily cadences, 06:00 in Denver.
 *
 * Six rather than midnight because the bank feeds that the derived runs read
 * land overnight, and a refresh that runs before its inputs arrive is a
 * refresh that produces yesterday's answer twice.
 */
export const nightlyTick = schedules.task({
  id: "sched-nightly",
  cron: { pattern: "0 6 * * *", timezone: "America/Denver" },
  run: async (payload, { ctx }) =>
    runTick(payload, ctx.run.id, ["daily"], false),
});

/** Weekly cadences, Monday morning, after the nightly tick has finished. */
export const weeklyTick = schedules.task({
  id: "sched-weekly",
  cron: { pattern: "15 6 * * 1", timezone: "America/Denver" },
  run: async (payload, { ctx }) =>
    runTick(payload, ctx.run.id, ["weekly"], false),
});

/**
 * Monthly cadences.
 *
 * Fires every morning, not on the first. Both monthly cadences are resolved
 * against the calendar in server/runs/dates.ts, and the one that means
 * "business day three" cannot be expressed as a cron expression at all. A
 * daily tick that finds nothing due is a database read and no runs.
 */
export const monthlyTick = schedules.task({
  id: "sched-monthly",
  cron: { pattern: "30 6 * * *", timezone: "America/Denver" },
  run: async (payload, { ctx }) =>
    runTick(payload, ctx.run.id, ["monthly_day", "monthly_business_day"], false),
});

/**
 * The safety net. Every six hours, all cadences, sweep mode.
 *
 * This is the task that makes a missed window recoverable. It takes back
 * windows claimed and never finished, re drives windows recorded and never
 * run, and records everything outside the seven day catch up bound as skipped
 * with the reason attached, so a gap is visible in npm run sched:status rather
 * than absent from it.
 *
 * On UTC deliberately. A sweep is not a business event and giving it a local
 * timezone would mean it runs three times or one time on the two days a year
 * the clocks move.
 */
export const sweepTick = schedules.task({
  id: "sched-sweep",
  cron: "0 */6 * * *",
  run: async (payload, { ctx }) => runTick(payload, ctx.run.id, undefined, true),
});
