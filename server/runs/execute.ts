/**
 * The single execution path, doc 03 Part 2.
 *
 * Preview is apply with the commit removed. There is one propose call, one
 * apply call, one log writer, and one status derivation, and the mode flag only
 * decides whether the outer transaction commits.
 *
 * Order inside the transaction: set the tenant context, take the advisory lock,
 * freeze the scope, propose, apply, write the log, commit.
 */

import {
  RUN_ERROR_CODES,
  makeResult,
  type FrozenScope,
  type Proposal,
  type Run,
  type RunActor,
  type RunContext,
  type RunError,
  type RunLogger,
  type RunMode,
  type RunResult,
  type RunStatus,
  type Ulid,
} from "./contract";
import {
  isRetryable,
  UniqueViolation,
  type Isolation,
  type RunDb,
  type RunTx,
  type TxSession,
} from "./db";
import { idempotencyKeyFor, proposalsDigest, runExecutionId } from "./ids";
import { emptySink } from "./apply-writer";
import {
  appendBareEvent,
  buildIntentRow,
  DEFAULT_ENVIRONMENT,
  writeRunLog,
  type LogEnvironment,
} from "./run-log";
import type { RunLogRow } from "./tables";

/** Thrown to unwind a preview transaction without committing anything. */
export class RollbackSignal<T> extends Error {
  constructor(readonly payload: T) {
    super("preview_rollback");
  }
}

export interface ExecuteOptions {
  mode: RunMode;
  firmId: Ulid;
  clientId: Ulid;
  actor: RunActor;
  now: Date;
  logger?: RunLogger;
  /** Required for apply, per doc 03 Part 2. Apply re-derives, never trusts it. */
  previewRunId?: string;
  source?: "button" | "cron" | "sequence";
  parentSequenceId?: string | null;
  originalRunId?: string | null;
  executionId?: string;
  maxAttempts?: number;
  env?: LogEnvironment;
  /** Set false only for the undo runner, which posts its own reversal plan. */
  requirePreviewForApply?: boolean;
}

export interface RunOutcome<P> {
  executionId: string;
  runType: string;
  runVersion: number;
  mode: RunMode;
  status: RunStatus;
  idempotencyKey: string;
  scopeHash: string;
  result: RunResult<P>;
  /** Number of candidate rows carrying the manual override flag in the window. */
  overriddenInScope: number;
  entriesCreated: number;
  entriesReversed: number;
  attempts: number;
  deduplicatedFrom?: string;
  lockHolder?: string;
  startedAt: string;
  finishedAt: string;
}

const NOOP_LOGGER: RunLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function emptyResult<P>(): RunResult<P> {
  return makeResult<P>(0, [], [], [], BigInt(0));
}

function isolationFor<S, P>(run: Run<S, P>): Isolation {
  return run.writesLedger ? "serializable" : "repeatable read";
}

/**
 * A run acting on behalf of a person is still automation. The session actor
 * kind is therefore never 'human', which is what keeps the override guard and
 * the override clearing rule meaningful.
 */
function sessionActorKind(actor: RunActor): TxSession["actorKind"] {
  if (actor.kind === "schedule") return "schedule";
  if (actor.kind === "sequence") return "sequence";
  return "run";
}

function sessionFor<S, P>(
  run: Run<S, P>,
  opts: ExecuteOptions,
  overrides: Partial<TxSession> = {},
): TxSession {
  return {
    isolation: isolationFor(run),
    readOnly: false,
    firmId: opts.firmId,
    clientId: opts.clientId,
    actorId: opts.actor.userId,
    actorKind: sessionActorKind(opts.actor),
    ...overrides,
  };
}

/** Doc 03 Part 11. Status derivation is shared by both modes. */
export function deriveStatus<P>(result: RunResult<P>): RunStatus {
  if (result.errors.length > 0) return "refused";
  if (result.proposals.length === 0) return "no_op";
  if (result.skips.length > 0) return "completed_with_skips";
  return "completed";
}

function buildContext(
  db: RunDb,
  opts: ExecuteOptions,
  executionId: string,
  idempotencyKey: string,
  tx: RunTx | undefined,
): RunContext {
  return {
    db,
    tx,
    actor: opts.actor,
    runExecutionId: executionId,
    idempotencyKey,
    now: opts.now,
    logger: opts.logger ?? NOOP_LOGGER,
    firmId: opts.firmId,
    clientId: opts.clientId,
    mode: opts.mode,
    applySink: emptySink(),
  };
}

/**
 * Find the execution that holds the lock, so a rejected caller can be told what
 * to watch instead of being told to try again. A holder is a run_log row of the
 * same type and client still in status started with no terminal event.
 */
async function findLockHolder(
  tx: RunTx,
  runType: string,
  firmId: Ulid,
  clientId: Ulid,
  selfId: string,
  now: Date,
): Promise<string | undefined> {
  const started = await tx.query("started_runs_before", {
    before: now.toISOString(),
  });
  for (const row of started) {
    if (row.id === selfId) continue;
    if (row.runType !== runType) continue;
    if (row.firmId !== firmId || row.clientId !== clientId) continue;
    const events = await tx.query("run_log_events_by_execution", {
      firmId,
      executionId: row.id,
    });
    const terminal = events.some(
      (e) => e.event !== "attempt_retried" && e.event !== "undone_by",
    );
    if (!terminal) return row.id;
  }
  return undefined;
}

export async function execute<S, P>(
  db: RunDb,
  run: Run<S, P>,
  scopeInput: unknown,
  opts: ExecuteOptions,
): Promise<RunOutcome<P>> {
  const env = opts.env ?? DEFAULT_ENVIRONMENT;
  const startedAt = opts.now;
  const executionId = opts.executionId ?? runExecutionId(opts.now);
  const scope = run.scopeSchema.parse(scopeInput) as S;
  const requirePreview = opts.requirePreviewForApply !== false;

  if (opts.mode === "apply" && requirePreview && !opts.previewRunId) {
    // A pre flight refusal. Nothing was frozen, nothing was locked, and no log
    // row is written, because the caller never started a run in the first place.
    const errors: RunError[] = [
      {
        rowId: null,
        code: RUN_ERROR_CODES.staleReview,
        message: `${run.type} apply requires a previewRunId, per doc 03 Part 2`,
        retryable: false,
      },
    ];
    return {
      executionId,
      runType: run.type,
      runVersion: run.version,
      mode: opts.mode,
      status: "refused",
      idempotencyKey: "",
      scopeHash: "",
      result: makeResult<P>(0, [], [], errors, BigInt(0)),
      overriddenInScope: 0,
      entriesCreated: 0,
      entriesReversed: 0,
      attempts: 0,
      startedAt: startedAt.toISOString(),
      finishedAt: opts.now.toISOString(),
    };
  }

  // Phase 0. Freeze the scope in a read only transaction so the idempotency key
  // exists before the intent row is written. No lock, no writes.
  const frozen0 = await db.tx(
    sessionFor(run, opts, { readOnly: true, isolation: "repeatable read" }),
    async (tx) => {
      const ctx = buildContext(db, opts, executionId, "pending", tx);
      return run.resolveScope(scope, ctx);
    },
  );

  const idempotencyKey = idempotencyKeyFor({
    runType: run.type,
    runVersion: run.version,
    firmId: frozen0.firmId,
    clientId: frozen0.clientId,
    scopeHash: frozen0.scopeHash,
    mode: opts.mode,
  });

  // Phase 0b. The key check. A second apply with the same key never reaches the
  // lock and never executes.
  if (opts.mode === "apply") {
    const priorRows = await db.tx(
      sessionFor(run, opts, { readOnly: true, isolation: "repeatable read" }),
      async (tx) =>
        tx.query("applied_run_by_idempotency_key", { idempotencyKey }),
    );
    const prior = pickDeduplicationTarget(priorRows);
    if (prior) {
      return {
        executionId: prior.id,
        runType: run.type,
        runVersion: run.version,
        mode: opts.mode,
        status: "deduplicated",
        idempotencyKey,
        scopeHash: frozen0.scopeHash,
        result: emptyResult<P>(),
        overriddenInScope: frozen0.overriddenIds.length,
        entriesCreated: 0,
        entriesReversed: 0,
        attempts: 0,
        deduplicatedFrom: prior.id,
        startedAt: startedAt.toISOString(),
        finishedAt: opts.now.toISOString(),
      };
    }
  }

  // Phase 1. The intent row, in its own short transaction.
  const intent = buildIntentRow({
    executionId,
    runType: run.type,
    runVersion: run.version,
    mode: opts.mode,
    firmId: frozen0.firmId,
    clientId: frozen0.clientId,
    idempotencyKey,
    frozen: frozen0,
    actorId: opts.actor.userId,
    actorKind: opts.actor.kind,
    source: opts.source ?? "button",
    parentSequenceId: opts.parentSequenceId ?? null,
    previewRunId: opts.previewRunId ?? null,
    originalRunId: opts.originalRunId ?? null,
    startedAt,
    env,
  });
  try {
    await db.tx(sessionFor(run, opts), async (tx) => {
      await tx.insert("run_log", [intent]);
    });
  } catch (err) {
    if (err instanceof UniqueViolation) {
      const priorRows = await db.tx(
        sessionFor(run, opts, { readOnly: true }),
        async (tx) =>
          tx.query("applied_run_by_idempotency_key", { idempotencyKey }),
      );
      const prior = pickDeduplicationTarget(priorRows);
      return {
        executionId: prior ? prior.id : executionId,
        runType: run.type,
        runVersion: run.version,
        mode: opts.mode,
        status: "deduplicated",
        idempotencyKey,
        scopeHash: frozen0.scopeHash,
        result: emptyResult<P>(),
        overriddenInScope: frozen0.overriddenIds.length,
        entriesCreated: 0,
        entriesReversed: 0,
        attempts: 0,
        deduplicatedFrom: prior ? prior.id : undefined,
        startedAt: startedAt.toISOString(),
        finishedAt: opts.now.toISOString(),
      };
    }
    throw err;
  }

  // Phase 2. The run transaction, retried on a transient failure with the same
  // execution id and the same idempotency key.
  const maxAttempts = opts.maxAttempts ?? 3;
  let attempt = 0;
  let lastTransient: unknown = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    const attemptStarted = opts.now;
    try {
      const outcome = await runOnce(
        db,
        run,
        scope,
        opts,
        executionId,
        idempotencyKey,
        frozen0,
        attempt,
        attemptStarted,
        env,
      );
      return outcome;
    } catch (err) {
      if (isRetryable(err) && attempt < maxAttempts) {
        lastTransient = err;
        await db.tx(sessionFor(run, opts), async (tx) => {
          await appendBareEvent(
            tx,
            frozen0.firmId,
            executionId,
            "attempt_retried",
            attempt,
            RUN_ERROR_CODES.serialization,
            opts.now,
          );
        });
        continue;
      }
      const runError: RunError = {
        rowId: null,
        code: codeOf(err),
        message: messageOf(err),
        retryable: isRetryable(err),
      };
      const failed = makeResult<P>(
        frozen0.candidateIds.length,
        [],
        [],
        [runError],
        BigInt(0),
      );
      await writeTerminalOnly(
        db,
        run,
        opts,
        executionId,
        idempotencyKey,
        frozen0,
        failed,
        "failed",
        attempt,
        attemptStarted,
        env,
        runError.code,
      );
      return {
        executionId,
        runType: run.type,
        runVersion: run.version,
        mode: opts.mode,
        status: "failed",
        idempotencyKey,
        scopeHash: frozen0.scopeHash,
        result: failed,
        overriddenInScope: frozen0.overriddenIds.length,
        entriesCreated: 0,
        entriesReversed: 0,
        attempts: attempt,
        startedAt: startedAt.toISOString(),
        finishedAt: opts.now.toISOString(),
      };
    }
  }

  throw lastTransient instanceof Error
    ? lastTransient
    : new Error("run exhausted its attempts");
}

/**
 * One attempt. Everything the run does happens here, inside one transaction.
 */
async function runOnce<S, P>(
  db: RunDb,
  run: Run<S, P>,
  scope: S,
  opts: ExecuteOptions,
  executionId: string,
  idempotencyKey: string,
  frozen0: FrozenScope<S>,
  attempt: number,
  attemptStarted: Date,
  env: LogEnvironment,
): Promise<RunOutcome<P>> {
  interface Attempted {
    status: RunStatus;
    result: RunResult<P>;
    frozen: FrozenScope<S>;
    entriesCreated: number;
    entriesReversed: number;
    entryIdByProposalIndex: Record<number, Ulid>;
    lockHolder?: string;
    detail: string;
  }

  let previewPayload: Attempted | null = null;

  const runTransaction = async (tx: RunTx): Promise<Attempted> => {
    // The advisory lock. Preview takes it too, per doc 03 Part 5.
    const gotLock = await tx.tryAdvisoryXactLock(
      run.type,
      run.concurrencyKey(scope),
    );
    if (!gotLock) {
      const holder = await findLockHolder(
        tx,
        run.type,
        frozen0.firmId,
        frozen0.clientId,
        executionId,
        opts.now,
      );
      return {
        status: "rejected_locked",
        result: makeResult<P>(
          frozen0.candidateIds.length,
          [],
          [],
          [
            {
              rowId: null,
              code: RUN_ERROR_CODES.alreadyRunning,
              message: `another execution of ${run.type} holds the lock for this client`,
              retryable: false,
            },
          ],
          BigInt(0),
        ),
        frozen: frozen0,
        entriesCreated: 0,
        entriesReversed: 0,
        entryIdByProposalIndex: {},
        lockHolder: holder,
        detail: holder ? `held_by:${holder}` : "held_by:unknown",
      };
    }

    const ctx = buildContext(db, opts, executionId, idempotencyKey, tx);
    const frozen = await run.resolveScope(scope, ctx);

    if (frozen.scopeHash !== frozen0.scopeHash) {
      // The world moved between freezing and locking. The operator gets a fresh
      // preview rather than a surprise.
      return {
        status: "refused",
        result: makeResult<P>(
          frozen.candidateIds.length,
          [],
          [],
          [
            {
              rowId: null,
              code:
                opts.mode === "apply"
                  ? RUN_ERROR_CODES.staleReview
                  : RUN_ERROR_CODES.scopeDrift,
              message: "the frozen scope changed before the lock was taken",
              retryable: false,
            },
          ],
          BigInt(0),
        ),
        frozen,
        entriesCreated: 0,
        entriesReversed: 0,
        entryIdByProposalIndex: {},
        detail: RUN_ERROR_CODES.scopeDrift,
      };
    }

    const result = await run.propose(frozen, ctx);
    const status = deriveStatus(result);
    const detail = "";

    if (opts.mode === "apply") {
      if (result.errors.length > 0) {
        // Apply refuses to start. This is what makes no partial application
        // true rather than aspirational.
        return {
          status: "refused",
          result,
          frozen,
          entriesCreated: 0,
          entriesReversed: 0,
          entryIdByProposalIndex: {},
          detail: RUN_ERROR_CODES.notClean,
        };
      }
      if (opts.previewRunId) {
        const stale = await previewDiffers(
          tx,
          frozen.firmId,
          opts.previewRunId,
          result.proposals as unknown as Proposal[],
        );
        if (stale) {
          const withError = makeResult<P>(
            frozen.candidateIds.length,
            [],
            result.skips,
            [
              {
                rowId: null,
                code: RUN_ERROR_CODES.staleReview,
                message: `re-derived proposals differ from preview ${opts.previewRunId}`,
                retryable: false,
              },
            ],
            BigInt(0),
          );
          return {
            status: "refused",
            result: withError,
            frozen,
            entriesCreated: 0,
            entriesReversed: 0,
            entryIdByProposalIndex: {},
            detail: RUN_ERROR_CODES.staleReview,
          };
        }
      }
      if (result.proposals.length > 0) {
        await run.apply(result.proposals, ctx);
      }
    }

    const sink = ctx.applySink ?? emptySink();
    const attempted: Attempted = {
      status,
      result,
      frozen,
      entriesCreated: sink.entriesCreated,
      entriesReversed: sink.entriesReversed,
      entryIdByProposalIndex: sink.entryIdByProposalIndex,
      detail,
    };

    await writeRunLog(tx, {
      run,
      ctx,
      mode: opts.mode,
      frozen,
      result,
      status,
      attempt,
      startedAt: attemptStarted,
      finishedAt: opts.now,
      entriesCreated: attempted.entriesCreated,
      entriesReversed: attempted.entriesReversed,
      entryIdByProposalIndex: attempted.entryIdByProposalIndex,
      detail: attempted.detail,
    });

    if (opts.mode === "preview") {
      // Nothing persists. The log is rewritten by the same writer in the short
      // follow up transaction below.
      throw new RollbackSignal(attempted);
    }
    return attempted;
  };

  let attempted: Attempted;
  try {
    attempted = await db.tx(sessionFor(run, opts), runTransaction);
  } catch (err) {
    if (err instanceof RollbackSignal) {
      previewPayload = err.payload as Attempted;
      attempted = previewPayload;
    } else {
      throw err;
    }
  }

  // A rejected, refused, or previewed attempt wrote nothing, so its evidence is
  // committed here through the same writer.
  if (previewPayload || attempted.status === "rejected_locked" || attempted.status === "refused") {
    await writeTerminalOnly(
      db,
      run,
      opts,
      executionId,
      idempotencyKey,
      attempted.frozen,
      attempted.result,
      attempted.status,
      attempt,
      attemptStarted,
      env,
      attempted.detail,
      attempted.entryIdByProposalIndex,
    );
  }

  return {
    executionId,
    runType: run.type,
    runVersion: run.version,
    mode: opts.mode,
    status: attempted.status,
    idempotencyKey,
    scopeHash: attempted.frozen.scopeHash,
    result: attempted.result,
    overriddenInScope: attempted.frozen.overriddenIds.length,
    entriesCreated: attempted.entriesCreated,
    entriesReversed: attempted.entriesReversed,
    attempts: attempt,
    lockHolder: attempted.lockHolder,
    startedAt: attemptStarted.toISOString(),
    finishedAt: opts.now.toISOString(),
  };
}

/** Commit only the evidence, for an outcome whose transaction wrote nothing. */
async function writeTerminalOnly<S, P>(
  db: RunDb,
  run: Run<S, P>,
  opts: ExecuteOptions,
  executionId: string,
  idempotencyKey: string,
  frozen: FrozenScope<S>,
  result: RunResult<P>,
  status: RunStatus,
  attempt: number,
  attemptStarted: Date,
  env: LogEnvironment,
  detail: string,
  entryIdByProposalIndex: Record<number, Ulid> = {},
): Promise<void> {
  await db.tx(sessionFor(run, opts), async (tx) => {
    const ctx = buildContext(db, opts, executionId, idempotencyKey, tx);
    await writeRunLog(tx, {
      run,
      ctx,
      mode: opts.mode,
      frozen,
      result,
      status,
      attempt,
      startedAt: attemptStarted,
      finishedAt: opts.now,
      entriesCreated: 0,
      entriesReversed: 0,
      entryIdByProposalIndex,
      detail,
    });
  });
  void env;
}

/**
 * Preview to apply parity. Apply re-derives its proposals and compares the
 * digest against what the preview logged.
 */
async function previewDiffers(
  tx: RunTx,
  firmId: Ulid,
  previewRunId: string,
  proposals: readonly Proposal[],
): Promise<boolean> {
  const items = await tx.query("run_log_items_by_execution", {
    firmId,
    executionId: previewRunId,
  });
  const previewed = items
    .filter((i) => i.decision === "proposed" && i.proposalJson !== null)
    .map((i) => i.proposalJson);
  if (previewed.length !== proposals.length) return true;
  const current = proposals.map((p) => toComparable(p));
  return proposalsDigest(previewed) !== proposalsDigest(current);
}

function toComparable(p: Proposal): unknown {
  // The stored form is the JSON safe encoding, so compare on that encoding.
  return jsonSafe(p);
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return { $cents: value.toString() };
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = jsonSafe(v);
    }
    return out;
  }
  return value;
}

/** Only a committed apply row counts for deduplication. */
function pickDeduplicationTarget(rows: readonly RunLogRow[]): RunLogRow | null {
  for (const row of rows) {
    if (row.mode === "apply") return row;
  }
  return null;
}

function codeOf(err: unknown): string {
  const candidate = err as { code?: unknown };
  if (candidate && typeof candidate.code === "string") return candidate.code;
  return "UNHANDLED_ERROR";
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The sweeper of doc 03 Part 11. Any run_log row still in status started with no
 * terminal event after the grace window becomes abandoned.
 */
export async function sweepAbandoned(
  db: RunDb,
  session: TxSession,
  now: Date,
  graceMs = 600000,
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - graceMs).toISOString();
  return db.tx(session, async (tx) => {
    const started = await tx.query("started_runs_before", { before: cutoff });
    const marked: string[] = [];
    for (const row of started) {
      const events = await tx.query("run_log_events_by_execution", {
        firmId: row.firmId,
        executionId: row.id,
      });
      const terminal = events.some(
        (e) => e.event !== "attempt_retried" && e.event !== "undone_by",
      );
      if (terminal) continue;
      await appendBareEvent(
        tx,
        row.firmId,
        row.id,
        "abandoned",
        1,
        "no terminal event and no active backend",
        now,
      );
      marked.push(row.id);
    }
    return marked;
  });
}
