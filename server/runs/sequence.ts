/**
 * Convenience sequences, doc 03 Part 10.
 *
 * A sequence is a named ordered list of runs and nothing more. Every child gets
 * its own execution id, its own idempotency key, its own transaction, and its
 * own undo plan. There is no combined transaction and no combined log entry,
 * because an auditor asking when depreciation was posted must get one answer
 * about depreciation and not a composite about a button.
 *
 * On trouble the sequence stops at the first child with errors or lock
 * contention, leaves completed children applied, and reports the step that
 * stopped it.
 */

import type { RunStatus, Run, Ulid } from "./contract";
import type { RunDb } from "./db";
import { execute, type ExecuteOptions, type RunOutcome } from "./execute";
import { ulid } from "./ids";
import type { RunSequenceRow } from "./tables";

export interface SequenceStep {
  runType: string;
  invoke: (db: RunDb, opts: ExecuteOptions) => Promise<RunOutcome<unknown>>;
}

/** Wrap a run and its scope into a step, erasing the scope type. */
export function step<S, P>(run: Run<S, P>, scope: unknown): SequenceStep {
  return {
    runType: run.type,
    invoke: (db, opts) =>
      execute(db, run, scope, opts) as Promise<RunOutcome<unknown>>,
  };
}

export interface SequenceOptions {
  name: string;
  firmId: Ulid;
  clientId: Ulid;
  actorId: Ulid;
  now: Date;
  /** apply runs a preview first and then applies, exactly like the UI does. */
  mode: "preview" | "apply";
}

export interface SequenceOutcome {
  sequenceId: string;
  name: string;
  childRunIds: string[];
  outcomes: RunOutcome<unknown>[];
  stoppedAtStep: number | null;
  stoppedBy: string | null;
}

const STOPPING_STATUSES: readonly RunStatus[] = [
  "refused",
  "failed",
  "rejected_locked",
  "abandoned",
];

export async function executeSequence(
  db: RunDb,
  steps: readonly SequenceStep[],
  opts: SequenceOptions,
): Promise<SequenceOutcome> {
  const sequenceId = `RUNSEQ-${ulid(opts.now)}`;
  const childRunIds: string[] = [];
  const outcomes: RunOutcome<unknown>[] = [];
  let stoppedAtStep: number | null = null;
  let stoppedBy: string | null = null;

  const base: Omit<ExecuteOptions, "mode" | "previewRunId"> = {
    firmId: opts.firmId,
    clientId: opts.clientId,
    actor: { userId: opts.actorId, kind: "sequence" },
    now: opts.now,
    source: "sequence",
    parentSequenceId: sequenceId,
  };

  for (let i = 0; i < steps.length; i += 1) {
    const current = steps[i];
    const preview = await current.invoke(db, { ...base, mode: "preview" });
    childRunIds.push(preview.executionId);
    outcomes.push(preview);
    if (STOPPING_STATUSES.includes(preview.status)) {
      stoppedAtStep = i;
      stoppedBy = `${current.runType}:${preview.status}`;
      break;
    }
    if (opts.mode === "preview") continue;
    if (preview.status === "no_op") continue;

    const applied = await current.invoke(db, {
      ...base,
      mode: "apply",
      previewRunId: preview.executionId,
    });
    childRunIds.push(applied.executionId);
    outcomes.push(applied);
    if (STOPPING_STATUSES.includes(applied.status)) {
      stoppedAtStep = i;
      stoppedBy = `${current.runType}:${applied.status}`;
      break;
    }
  }

  const row: RunSequenceRow = {
    id: sequenceId,
    firmId: opts.firmId,
    clientId: opts.clientId,
    name: opts.name,
    childRunIds: childRunIds.slice(),
    stoppedAtStep,
    actorId: opts.actorId,
    startedAt: opts.now.toISOString(),
    finishedAt: opts.now.toISOString(),
  };
  await db.tx(
    {
      isolation: "repeatable read",
      readOnly: false,
      firmId: opts.firmId,
      clientId: opts.clientId,
      actorId: opts.actorId,
      actorKind: "sequence",
    },
    async (tx) => {
      await tx.insert("run_sequence", [row]);
    },
  );

  return { sequenceId, name: opts.name, childRunIds, outcomes, stoppedAtStep, stoppedBy };
}

/**
 * The month end prep order from doc 03 Part 10. Listed as run types rather than
 * built steps, because only the runs that exist can be wired in yet.
 */
export const MONTH_END_PREP_ORDER: readonly string[] = [
  "TXN-NORMALIZE-VENDORS",
  "TXN-DETECT-DUPLICATES",
  "TXN-PAIR-TRANSFERS",
  "TXN-SPLIT-SETTLEMENTS",
  "TXN-APPLY-RECURRING",
  "TXN-APPLY-RULES",
  "TXN-APPLY-VENDORDEFAULTS",
  "TXN-MAP-BANKCODES",
  "TXN-SWEEP-SUSPENSE",
  "PER-POST-RECURRING",
  "PER-POST-DEPRECIATION",
  "PER-AMORTIZE-PREPAID",
  "PER-SPLIT-LOANPAYMENT",
  "PER-POST-ACCRUALS",
  "CLOSE-CHECK-GATES",
];
