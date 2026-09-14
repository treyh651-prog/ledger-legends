/**
 * npm run sched:status
 *
 * What did not run, and what is waiting for a person. The operator's morning
 * question, answered from the database rather than from the Trigger.dev
 * dashboard, because the dashboard knows whether a task started and this knows
 * whether the work happened.
 *
 * Reads only. It opens a read only transaction, prints, and exits.
 *
 * With RUN_DB unset this resolves to the memory port and reports an empty
 * firm, which is correct rather than broken: there is no state in a process
 * that just started. Point it at the real database with
 *
 *   RUN_DB=postgres DATABASE_URL=... SCHEDULER_FIRM_ID=... SCHEDULER_ACTOR_ID=... \
 *     npm run sched:status
 *
 * and it prints the live picture. This script never asks for, prints, or
 * stores a connection string.
 */

import { resolveRunDb } from "../server/db/run-db";
import { schedulerStatus, type SchedulerStatus } from "../server/sched/status";

const firmId = (process.env.SCHEDULER_FIRM_ID ?? "").trim();
const actorId = (process.env.SCHEDULER_ACTOR_ID ?? "").trim();

function bar(title: string): void {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
}

function render(status: SchedulerStatus): void {
  console.log(`Scheduler status as of ${status.asOf}`);
  console.log(
    `${String(status.counts.enabled)} enabled schedules of ${String(status.counts.schedules)}, ` +
      `catch up bound ${String(status.catchUpDays)} days.`,
  );
  console.log(
    `Last ${String(status.catchUpDays)} days: ${String(status.counts.succeeded)} succeeded, ` +
      `${String(status.counts.failed)} failed, ${String(status.counts.skipped)} skipped, ` +
      `${String(status.counts.outstanding)} still outstanding.`,
  );

  if (status.failing.length > 0) {
    bar("FAILING, two or more in a row");
    for (const s of status.failing) {
      console.log(
        `  ${s.name} (${s.runType}) failed ${String(s.consecutiveFailures)} times, last ${String(s.lastFailureAt)}`,
      );
      console.log(`    ${String(s.lastFailureDetail)}`);
    }
  }

  if (status.missed.length > 0) {
    bar("MISSED, recorded and not run");
    for (const w of status.missed) {
      console.log(`  ${w.localDay} ${w.scheduleName} (${w.runType})`);
      console.log(`    ${String(w.detail)}`);
    }
  }

  if (status.stalled.length > 0) {
    bar("OUTSTANDING");
    for (const w of status.stalled) {
      console.log(`  ${w.localDay} ${w.scheduleName} ${w.status}, ${String(w.detail)}`);
    }
  }

  if (status.waitingForApproval.length > 0) {
    bar("WAITING FOR A DECISION, propose tier");
    for (const w of status.waitingForApproval) {
      console.log(`  ${w.localDay} ${w.scheduleName} (${w.runType}) run ${String(w.runId)}`);
    }
  }

  bar("SCHEDULES");
  for (const s of status.schedules) {
    const frozen = s.frozenByHand ? ", frozen by hand" : "";
    console.log(
      `  ${s.name} (${s.runType}) ${s.tier} in ${s.executionMode} mode${frozen}`,
    );
    console.log(`    ${s.cadence}, ${s.timezone}`);
    console.log(
      `    last ${String(s.lastWindowStart)} ${String(s.lastWindowStatus)}, next ${String(s.nextFireAt)}`,
    );
  }
  console.log("");
}

async function main(): Promise<void> {
  if (firmId === "" || actorId === "") {
    console.log(
      "SCHEDULER_FIRM_ID and SCHEDULER_ACTOR_ID are not set, so there is no firm to report on.",
    );
    console.log(
      "Neither is a secret. The firm id is the tenancy.firms row, the actor id is the firm scope",
    );
    console.log("service membership the scheduler runs as. See docs/SCHEDULING.md.");
    process.exit(1);
  }
  const { db, kind, description } = resolveRunDb();
  console.log(`Port: ${description}`);
  if (kind === "memory") {
    console.log(
      "Nothing is stored in the memory port between processes, so the numbers below will be zero.",
    );
  }
  const status = await schedulerStatus(db, { firmId, userId: actorId }, new Date());
  render(status);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
