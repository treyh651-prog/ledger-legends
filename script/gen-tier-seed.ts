/**
 * Emits the sched.run_policies seed block for db/migrations/0022_scheduler.sql
 * from RUN_POLICIES and the registry. Generated rather than typed so the
 * migration and the code cannot disagree on the day they are written.
 */
import { RUN_POLICIES } from "../server/runs/policy";
import { registry } from "../server/runs/registry";

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const rows: string[] = [];
for (const run of registry) {
  const pol = RUN_POLICIES[run.type];
  if (!pol) throw new Error(`no policy for ${run.type}`);
  rows.push(`  (${q(run.type)}, ${q(pol.tier)}, ${q(pol.reason)}, ${run.writesLedger ? "true" : "false"})`);
}
console.log(rows.join(",\n") + ";");
