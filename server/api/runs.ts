/**
 * Writes are runs. NOTES 222.
 *
 * A person at a screen never writes a table. The route resolves the run from
 * the registry, checks the tier allows a person to start it in the asked
 * mode, and calls execute() with a human actor. The engine does the rest:
 * intent row, frozen scope, lock, preview or apply, log. Undo goes through
 * executeUndo, which is itself a run.
 */

import { randomUUID } from "node:crypto";
import type { CreateClientBody } from "../../shared/api/clients";
import type { RunCatalogItem, RunOutcomeDto } from "../../shared/api/runs";
import type { Actor } from "../db/with-actor";
import type { Proposal, Run } from "../runs/contract";
import type { RunDb } from "../runs/db";
import { execute, type RunOutcome } from "../runs/execute";
import { toJsonValue } from "../runs/ids";
import { RUN_POLICIES, tierOf, tierReasonOf, type RunTier } from "../runs/policy";
import { CLIENT_INTAKE_ORDER, lookupRun, registry } from "../runs/registry";
import { executeUndo } from "../runs/undo";
import { ApiFailure, notFound } from "./errors";
import { readSession, runActor } from "./session";

/**
 * Runs a client scoped actor may trigger. Doc 08 says nothing a client does
 * posts a journal entry: a client uploads, answers, escalates, messages, and
 * signs. Three of those are registered runs since migration 0028: answering a
 * request, posting a message, and signing the engagement letter. Uploads wait
 * on document storage, which is outside this brief. A client scoped actor gets
 * 403 on every other run route. When a client side run is registered, add its
 * type here and nowhere else.
 */
export const CLIENT_SIDE_RUNS: readonly string[] = [
  "PORTAL-ANSWER-REQUEST",
  "PORTAL-POST-MESSAGE",
  "DOC-RECORD-UPLOAD",
  "ENG-SIGN-LETTER",
];

/** What a person may do on demand, by tier. Every tier allows a preview. */
export function modeAllowed(tier: RunTier | null, mode: "preview" | "apply"): boolean {
  if (tier === null) return false;
  if (mode === "preview") return true;
  return true;
}

export function runCatalog(): RunCatalogItem[] {
  return registry.map((entry) => ({
    runType: entry.type,
    version: entry.version,
    writesLedger: entry.writesLedger,
    requiresOpenPeriod: entry.run.requiresOpenPeriod,
    tier: tierOf(entry.type) ?? "manual",
    reason: tierReasonOf(entry.type) ?? "",
    clientSide: CLIENT_SIDE_RUNS.includes(entry.type),
  }));
}

export function outcomeDto<P>(o: RunOutcome<P>): RunOutcomeDto {
  const dto: RunOutcomeDto = {
    executionId: o.executionId,
    runType: o.runType,
    runVersion: o.runVersion,
    mode: o.mode,
    status: o.status,
    idempotencyKey: o.idempotencyKey,
    scopeHash: o.scopeHash,
    candidateCount: o.result.totals.candidates,
    proposals: o.result.proposals.map((p) => toJsonValue(p)),
    skips: o.result.skips.map((s) => ({ rowId: s.rowId, reason: s.reason, detail: s.detail })),
    errors: o.result.errors.map((e) => ({ rowId: e.rowId, code: e.code, message: e.message, retryable: e.retryable })),
    netCents: Number(o.result.totals.netCents),
    overriddenInScope: o.overriddenInScope,
    entriesCreated: o.entriesCreated,
    entriesReversed: o.entriesReversed,
    attempts: o.attempts,
    startedAt: o.startedAt,
    finishedAt: o.finishedAt,
  };
  if (o.deduplicatedFrom) dto.deduplicatedFrom = o.deduplicatedFrom;
  if (o.lockHolder) dto.lockHolder = o.lockHolder;
  return dto;
}

export interface TriggerArgs {
  db: RunDb;
  actor: Actor;
  firmId: string;
  clientId: string;
  /** How the actor reaches the client. Client scope is limited to CLIENT_SIDE_RUNS. */
  via: "firm" | "client";
  runCode: string;
  mode: "preview" | "apply";
  previewRunId?: string;
  scope: Record<string, unknown>;
  now?: Date;
}

export function resolveRun(runCode: string): Run<never, Proposal> {
  const entry = lookupRun(runCode);
  if (!entry) throw notFound("run");
  if (!(runCode in RUN_POLICIES)) {
    throw new ApiFailure(500, "internal", `${runCode} has no compliance tier on record`);
  }
  return entry.run;
}

export async function triggerRun(args: TriggerArgs): Promise<RunOutcomeDto> {
  const run = resolveRun(args.runCode);
  if (args.via === "client" && !CLIENT_SIDE_RUNS.includes(args.runCode)) {
    throw new ApiFailure(403, "forbidden", `${args.runCode} is a firm side run.`);
  }
  if (!modeAllowed(tierOf(args.runCode), args.mode)) {
    throw new ApiFailure(403, "forbidden", `${args.runCode} may not be started in ${args.mode} mode from the interface.`);
  }
  // Every run's scope carries the client id. The route's client wins over
  // anything the body said, so a body cannot point a run at another client.
  const scope = { ...args.scope, clientId: args.clientId };
  const outcome = await execute(args.db, run as unknown as Run<unknown, Proposal>, scope, {
    mode: args.mode,
    firmId: args.firmId,
    clientId: args.clientId,
    actor: runActor(args.actor),
    now: args.now ?? new Date(),
    previewRunId: args.previewRunId,
    source: "button",
  });
  return outcomeDto(outcome);
}

/** The run log row a log id names, within the actor's firm. */
export async function findLog(db: RunDb, actor: Actor, firmId: string, logId: string) {
  const rows = await db.tx(readSession(actor, firmId, ""), (tx) =>
    tx.query("run_log_by_id", { firmId, executionId: logId }),
  );
  const row = rows[0];
  if (!row || row.firmId !== firmId) throw notFound("run");
  return row;
}

/**
 * Apply a preview. The scope is the one the preview froze, read back from its
 * log row, so the apply cannot be pointed at different work. The engine
 * re-derives and compares digests regardless.
 */
export async function applyPreview(db: RunDb, actor: Actor, firmId: string, logId: string, now = new Date()): Promise<RunOutcomeDto> {
  const row = await findLog(db, actor, firmId, logId);
  if (row.mode !== "preview") {
    throw new ApiFailure(409, "run_refused", `${logId} is not a preview, so there is nothing to apply.`);
  }
  if (row.status !== "completed" && row.status !== "completed_with_skips") {
    throw new ApiFailure(409, "run_refused", `${logId} finished ${row.status}, so it cannot be applied.`);
  }
  const run = resolveRun(row.runType);
  const outcome = await execute(db, run as unknown as Run<unknown, Proposal>, row.scopeInput, {
    mode: "apply",
    firmId,
    clientId: row.clientId,
    actor: runActor(actor),
    now,
    previewRunId: row.id,
    source: "button",
  });
  return outcomeDto(outcome);
}

export async function undoApplied(db: RunDb, actor: Actor, firmId: string, logId: string, now = new Date()): Promise<RunOutcomeDto> {
  const row = await findLog(db, actor, firmId, logId);
  if (row.mode !== "apply") {
    throw new ApiFailure(409, "run_refused", `${logId} is a preview. Only an applied run can be undone.`);
  }
  if (row.originalRunId !== null) {
    throw new ApiFailure(409, "run_refused", `${logId} is itself an undo. Reapply the original run instead.`);
  }
  const run = resolveRun(row.runType);
  const outcome = await executeUndo(db, run as unknown as Run<unknown, Proposal>, row.id, {
    mode: "apply",
    firmId,
    clientId: row.clientId,
    actor: runActor(actor),
    now,
    source: "button",
  });
  return outcomeDto(outcome);
}

/* ---------------- Create client ---------------- */

export interface CreateClientResult {
  clientId: string;
  runs: RunOutcomeDto[];
  /** True when every intake step applied. */
  complete: boolean;
  /** Set only by createClientFirstStep: whether INTAKE-CREATE-CLIENT itself applied. */
  firstStepComplete?: boolean;
}

function startOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/**
 * The firm's first run path. Four intake runs in CLIENT_INTAKE_ORDER, each
 * previewed and then applied against its preview, stopping at the first that
 * does not apply. SETUP-IMPORT-BALANCES is not run here, because a new
 * client has no opening balances to import until a person supplies them.
 *
 * Split in two because the full cascade, chart included, is the one
 * operation in this codebase measured taking thirty to forty seconds against
 * real Postgres: a standard chart is on the order of two hundred rows across
 * chart_accounts and categories, each its own run managed insert inside the
 * run framework's own transaction and log writes. A synchronous Netlify
 * function sits behind an upstream proxy with roughly a twenty nine second
 * inactivity timeout, confirmed against the deployed function directly
 * (Inactivity Timeout, no data sent) rather than assumed from Netlify's own
 * stated function limit, which is longer and was not the one actually hit.
 *
 * buildIntakeScopes names every run's scope once, so the two halves below
 * read it from the same place rather than each repeating it.
 */
export function buildIntakeScopes(clientId: string, body: CreateClientBody): Record<string, Record<string, unknown>> {
  const period = body.period ?? startOfMonth(body.startDate);
  return {
    "INTAKE-CREATE-CLIENT": {
      clientId,
      name: body.name,
      entityType: body.entityType,
      industry: body.industry,
      isNonprofit: body.isNonprofit,
      fiscalYearEndMonth: body.fiscalYearEndMonth,
      scopeKeys: body.scopeKeys,
      serviceLevel: body.serviceLevel,
      reportingBasis: body.reportingBasis,
      startDate: body.startDate,
      monthlyFeeCents: body.monthlyFeeCents,
    },
    "INTAKE-BUILD-CHART": {
      clientId,
      industry: body.industry,
      period,
      scopeKeys: body.scopeKeys,
      excludeAccountNumbers: body.excludeAccountNumbers,
      addAccounts: body.addAccounts,
    },
    "INTAKE-SEED-TASKS": { clientId, period, scopeKeys: body.scopeKeys },
    "INTAKE-OPEN-REQUESTS": { clientId, period, scopeKeys: body.scopeKeys, openedOn: body.startDate },
  };
}

/** Preview then apply one run type in CLIENT_INTAKE_ORDER, appending its outcomes and reporting whether it applied clean. */
async function runIntakeStep(
  db: RunDb,
  actor: Actor,
  firmId: string,
  clientId: string,
  runCode: string,
  scope: Record<string, unknown>,
  now: Date,
  runs: RunOutcomeDto[],
): Promise<boolean> {
  const preview = await triggerRun({ db, actor, firmId, clientId, via: "firm", runCode, mode: "preview", scope, now });
  runs.push(preview);
  if (preview.status !== "completed" && preview.status !== "completed_with_skips" && preview.status !== "no_op") {
    return false;
  }
  if (preview.status === "no_op") return true;
  const applied = await triggerRun({
    db,
    actor,
    firmId,
    clientId,
    via: "firm",
    runCode,
    mode: "apply",
    previewRunId: preview.executionId,
    scope,
    now,
  });
  runs.push(applied);
  return applied.status === "completed" || applied.status === "completed_with_skips";
}

/**
 * Step one, synchronous: the client and its draft engagement, two row
 * inserts. Fast enough that there was never a reason to split it off the
 * request that creates it.
 */
export async function createClientFirstStep(
  db: RunDb,
  actor: Actor,
  firmId: string,
  body: CreateClientBody,
  now = new Date(),
  clientId = randomUUID(),
): Promise<CreateClientResult> {
  const scopes = buildIntakeScopes(clientId, body);
  const runs: RunOutcomeDto[] = [];
  const ok = await runIntakeStep(db, actor, firmId, clientId, "INTAKE-CREATE-CLIENT", scopes["INTAKE-CREATE-CLIENT"], now, runs);
  return { clientId, runs, complete: false, firstStepComplete: ok };
}

/**
 * Steps two through four: the chart, the workload, the first document
 * requests. Runs wherever it is called from, which is either in process
 * right behind createClientFirstStep (local dev, `npm start`, anywhere not a
 * Netlify function) or from finish-client-onboarding-background.ts, a
 * background function with a fifteen minute budget instead of a synchronous
 * one's twenty nine seconds. netlify/functions/api.ts decides which; this
 * function does not know or care which call reached it.
 */
export async function continueClientOnboarding(
  db: RunDb,
  actor: Actor,
  firmId: string,
  clientId: string,
  body: CreateClientBody,
  now = new Date(),
): Promise<CreateClientResult> {
  const scopes = buildIntakeScopes(clientId, body);
  const runs: RunOutcomeDto[] = [];
  let complete = true;
  for (const type of CLIENT_INTAKE_ORDER) {
    if (type === "INTAKE-CREATE-CLIENT") continue;
    const scope = scopes[type];
    if (!scope) continue;
    const ok = await runIntakeStep(db, actor, firmId, clientId, type, scope, now, runs);
    if (!ok) {
      complete = false;
      break;
    }
  }
  return { clientId, runs, complete };
}

/**
 * The full cascade in one call, both steps back to back. What a direct
 * caller wants (local dev, the background function itself, a future script);
 * the HTTP route never calls this, because it is exactly the shape that
 * times out against real Postgres through the proxy in front of a
 * synchronous Netlify function.
 */
export async function createClient(
  db: RunDb,
  actor: Actor,
  firmId: string,
  body: CreateClientBody,
  now = new Date(),
  clientId = randomUUID(),
): Promise<CreateClientResult> {
  const first = await createClientFirstStep(db, actor, firmId, body, now, clientId);
  if (!first.firstStepComplete) return { ...first, complete: false };
  const rest = await continueClientOnboarding(db, actor, firmId, clientId, body, now);
  return { clientId, runs: [...first.runs, ...rest.runs], complete: rest.complete };
}

/**
 * Fires the chart, workload, and first document requests. In a Netlify
 * function (ONBOARDING_BACKGROUND_SECRET set) this is a fire and forget call
 * to finish-client-onboarding-background.ts, a background function with a
 * fifteen minute budget rather than a synchronous function's roughly twenty
 * nine seconds; the client sees the client row immediately, and the
 * portal and firm screens pick up the chart and workload once it lands.
 * Without that secret set (local dev, `npm start`, and the test suite) it
 * runs continueClientOnboarding in process instead and returns its real
 * outcome, so nothing about local development or the traditional server
 * path changes: the caller still sees the full run list and true
 * completion in the same response. When it does dispatch to the
 * background function, the outcome is unknown yet (the caller only sees
 * that the call was handed off), so it answers with an empty run list and
 * complete: false — the client and portal screens pick that up later by
 * polling.
 */
export async function dispatchOnboardingContinuation(
  db: RunDb,
  actor: Actor,
  firmId: string,
  clientId: string,
  body: CreateClientBody,
  now: Date,
): Promise<{ runs: RunOutcomeDto[]; complete: boolean }> {
  const secret = process.env.ONBOARDING_BACKGROUND_SECRET;
  const appOrigin = process.env.APP_ORIGIN;
  if (!secret || !appOrigin) {
    return continueClientOnboarding(db, actor, firmId, clientId, body, now);
  }
  try {
    const res = await fetch(`${appOrigin}/.netlify/functions/finish-client-onboarding-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({
        clientId,
        firmId,
        actor: { userId: actor.userId, email: actor.email, displayName: actor.displayName },
        body,
        now: now.toISOString(),
      }),
    });
    if (!res.ok && res.status !== 202) {
      // The client row still exists; its chart just never gets built, which
      // is worse silently than loudly logged.
      console.error(`[api] onboarding continuation dispatch answered ${res.status} for client ${clientId}`);
    }
  } catch (err) {
    console.error(`[api] onboarding continuation dispatch failed for client ${clientId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { runs: [], complete: false };
}
