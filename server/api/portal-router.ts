/**
 * Portal screen routes, docs/11-api.md and NOTES 240 onward.
 *
 * Mounted from router.ts under /api/portal/:clientId ahead of the first portal
 * router, so these handlers answer before the older not_configured stubs for
 * requests, documents and messages. Every route here runs behind requireClient
 * and a feature gate, reads through the query catalog inside one read session,
 * and writes only by starting one of the three client side runs from migration
 * 0028, preview then apply, the same pair the firm's create client flow uses.
 *
 * What is and is not configured is stated in the payload: storageConfigured
 * follows deps.storage (NOTES 256), uploadsConfigured and emailConfigured are
 * false and the screens say so.
 */
import { Router, type Request, type RequestHandler } from "express";
import type { ZodType } from "zod";
import type { RunTx } from "../runs/db";
import type { Actor } from "../db/with-actor";
import { FEATURE_KEYS, TIERS, type TierId } from "../../shared/tiers";
import type { FeatureKey } from "../../shared/tiers";
import {
  answerRequestBodySchema,
  postMessageBodySchema,
  signLetterBodySchema,
  type PortalAging,
  type PortalBudget,
  type PortalDocument,
  type PortalDocuments,
  type PortalForecast,
  type PortalMessages,
  type PortalNarrative,
  type PortalPeriods,
  type PortalReports,
  type PortalRequestDetail,
  type PortalRequests,
  type PortalSign,
  type RunOutcomeDto,
} from "../../shared/api";
import { ApiFailure } from "./errors";
import { type Entitlement, requireFeature } from "../entitlement";
import { readSession } from "./session";
import { triggerRun } from "./runs";
import { SIGN_CONSENT_TEXT } from "../runs/runs/eng-sign-letter";
import type { ApiDeps } from "./router";
import type { DocumentRow } from "../runs/tables";
import { createDocumentRoutes } from "./uploads";
import { type DocumentStorage, uploadMaxBytes } from "../storage/document-storage";

/* ---------------- Small helpers, kept local so router.ts stays as it is ---------------- */

function route(fn: (req: Request) => Promise<{ status?: number; body: unknown }>): RequestHandler {
  return (req, res, next) => {
    fn(req)
      .then((out) => {
        res.status(out.status ?? 200).json(out.body);
      })
      .catch(next);
  };
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function cents(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`cents out of safe integer range: ${value.toString()}`);
  return n;
}

function clientOf(req: Request): { actor: Actor; clientId: string; firmId: string; via: "firm" | "client" } {
  const client = req.client;
  const actor = req.actor;
  if (!client || !actor) throw new ApiFailure(400, "client_required", "A client is required.");
  return { actor, clientId: client.clientId, firmId: client.firmId, via: client.via };
}

function documentDto(d: DocumentRow): PortalDocument {
  return {
    id: d.id,
    docType: d.docType,
    title: d.title,
    periodStart: d.periodStart,
    periodEnd: d.periodEnd,
    status: d.status,
    byteSize: d.byteSize,
    contentType: d.contentType,
    uploadedAt: d.uploadedAt,
    createdAt: d.createdAt,
  };
}

/** The request's remote address as the signature record will keep it. */
function remoteIp(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  return ip.length > 0 ? ip : "0.0.0.0";
}

/**
 * True for the outcomes that mean the work is on record. A deduplicated apply
 * means an identical scope already applied, which for a button press is the
 * same thing as done.
 */
function succeeded(o: RunOutcomeDto): boolean {
  return o.status === "completed" || o.status === "completed_with_skips" || o.status === "deduplicated";
}

/**
 * Preview, then apply with the preview id, inside one request. A client side
 * run has no review step by design, doc 08 gives the client a button, not a
 * proposal queue. A failed preview is returned as is so the screen shows the
 * engine's own error code and sentence.
 */
async function previewThenApply(args: {
  deps: ApiDeps;
  req: Request;
  runCode: string;
  scope: Record<string, unknown>;
}): Promise<{ status: number; body: unknown }> {
  const { actor, clientId, firmId, via } = clientOf(args.req);
  const now = args.deps.now ? args.deps.now() : new Date();
  const common = { db: args.deps.db, actor, firmId, clientId, via, runCode: args.runCode, scope: args.scope, now };
  const preview = await triggerRun({ ...common, mode: "preview" });
  if (preview.status === "no_op") return { status: 200, body: { preview, applied: null, done: true } };
  // The outcome is the payload, as on the firm's run route. A run the engine
  // refused is a 200 with done false and the engine's error list, so the
  // screen shows the code and sentence rather than a generic failure.
  if (!succeeded(preview)) return { status: 200, body: { preview, applied: null, done: false } };
  const applied = await triggerRun({ ...common, mode: "apply", previewRunId: preview.executionId });
  return { status: 200, body: { preview, applied, done: succeeded(applied) } };
}

/* ---------------- Reads ---------------- */

async function requestsFor(tx: RunTx, firmId: string, clientId: string): Promise<PortalRequests> {
  const [portal, documents] = await Promise.all([
    tx.query("portal_requests_for_client", { firmId, clientId }),
    tx.query("document_requests_for_client", { firmId, clientId }),
  ]);
  const items: PortalRequestDetail[] = [
    ...portal.map((r) => ({
      id: r.id,
      kind: "transaction" as const,
      reasonCode: r.reasonCode,
      detail: r.detail,
      status: r.status,
      openedOn: r.openedOn,
      dueOn: r.dueOn,
      transactionId: r.transactionId,
      answer: r.answer,
      answeredAt: r.answeredAt,
      canAnswer: r.status === "open",
    })),
    ...documents
      .filter((r) => r.owner === "client")
      .map((r) => ({
        id: r.id,
        kind: "document" as const,
        reasonCode: r.catalogCode,
        detail: r.detail,
        status: r.status,
        openedOn: r.openedOn,
        dueOn: r.escalatesOn,
        transactionId: null,
        answer: null,
        answeredAt: null,
        canAnswer: false,
      })),
  ].sort((a, b) => {
    const ao = a.status === "open" ? 0 : 1;
    const bo = b.status === "open" ? 0 : 1;
    if (ao !== bo) return ao - bo;
    if (a.openedOn !== b.openedOn) return a.openedOn < b.openedOn ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return {
    items,
    openCount: items.filter((i) => i.status === "open").length,
    uploadsConfigured: false,
  };
}

async function messagesFor(tx: RunTx, firmId: string, clientId: string, userId: string): Promise<PortalMessages> {
  const rows = await tx.query("portal_messages_for_client", { firmId, clientId });
  return {
    items: rows.map((m) => ({
      id: m.id,
      authorScope: m.authorScope,
      authorUserId: m.authorUserId,
      mine: m.authorUserId === userId,
      body: m.body,
      createdAt: m.createdAt,
    })),
    emailConfigured: false,
  };
}

async function documentsFor(tx: RunTx, firmId: string, clientId: string, storage: DocumentStorage | null): Promise<PortalDocuments> {
  const [docs, requests, bankAccounts, vendors, fixedAssets, loans] = await Promise.all([
    tx.query("documents_for_client", { firmId, clientId }),
    requestsFor(tx, firmId, clientId),
    tx.query("bank_accounts_for_client", { firmId, clientId }),
    tx.query("vendors_for_client", { firmId, clientId }),
    tx.query("fixed_assets_for_client", { firmId, clientId }),
    tx.query("loans_for_client", { firmId, clientId }),
  ]);
  return {
    items: docs.map(documentDto),
    openRequests: requests.items.filter((r) => r.kind === "document" && r.status === "open"),
    storageConfigured: storage !== null,
    storageProvider: storage ? storage.provider : null,
    uploadMaxBytes: uploadMaxBytes(),
    bankAccounts: bankAccounts.map((a) => ({ id: a.id, nickname: a.nickname, accountNumber: a.accountNumber })),
    vendors: vendors.filter((v) => v.isActive).map((v) => ({ id: v.id, legalName: v.legalName })),
    fixedAssets: fixedAssets.map((a) => ({ id: a.id, description: a.description })),
    loans: loans.map((l) => ({ id: l.id, lenderName: l.lenderName })),
  };
}

async function signFor(tx: RunTx, firmId: string, clientId: string, actor: Actor): Promise<PortalSign> {
  const engagements = await tx.query("engagements_for_client", { firmId, clientId });
  const e = engagements[0];
  const signer = { name: actor.displayName ?? "", email: actor.email };
  if (!e) {
    return { engagement: null, letter: null, state: "no_engagement", consentText: SIGN_CONSENT_TEXT, signatures: [], signer };
  }
  const [letters, evidence] = await Promise.all([
    e.letterDocumentId
      ? tx.query("document_by_id", { firmId, clientId, documentId: e.letterDocumentId })
      : Promise.resolve([] as DocumentRow[]),
    tx.query("signature_evidence_for_engagement", { firmId, clientId, engagementId: e.id }),
  ]);
  const letter = letters[0] ?? null;
  const letterUsable =
    letter !== null && (letter.status === "uploaded" || letter.status === "verified") && letter.sha256Hex !== null;
  const scope = e.scope as { keys?: unknown } | null;
  const scopeItems =
    scope && Array.isArray(scope.keys) ? scope.keys.filter((k): k is string => typeof k === "string") : [];
  const tier = TIERS[e.serviceLevel as TierId];
  let state: PortalSign["state"];
  if (e.status === "terminated") state = "terminated";
  else if (e.status === "signed" || e.status === "active") state = "signed";
  else if (!letterUsable) state = "no_letter";
  else state = "ready";
  return {
    engagement: {
      id: e.id,
      name: e.name,
      status: e.status,
      serviceLevel: e.serviceLevel,
      tierName: tier ? tier.name : e.serviceLevel,
      reportingBasis: e.reportingBasis,
      startDate: e.startDate,
      endDate: e.endDate,
      scopeItems,
      signedAt: e.signedAt,
    },
    letter: letter ? documentDto(letter) : null,
    state,
    consentText: SIGN_CONSENT_TEXT,
    signatures: evidence.map((s) => ({
      id: s.id,
      signerName: s.signerName,
      signerEmail: s.signerEmail,
      signerTitle: s.signerTitle,
      signedAt: s.signedAt,
      signatureMethod: s.signatureMethod,
      status: s.status,
      documentSha256Hex: s.documentSha256Hex,
    })),
    signer,
  };
}

async function agingFor(tx: RunTx, firmId: string, clientId: string, side: "receivable" | "payable", today: string): Promise<PortalAging> {
  // Snapshots are dated. The newest snapshot date on or before today is the
  // one the client sees, and no snapshot at all is an empty table, not zeros.
  const periods = await tx.query("close_periods_for_client", { firmId, clientId });
  const candidates = Array.from(new Set([today, ...periods.map((p) => p.periodEnd)]))
    .filter((d) => d <= today)
    .sort()
    .reverse();
  for (const asOfDate of candidates) {
    const rows = (await tx.query("aging_snapshots_for_date", { firmId, clientId, asOfDate })).filter((r) => r.side === side);
    if (rows.length === 0) continue;
    const items = rows.map((r) => ({
      partyName: r.partyName,
      documentNumber: r.documentNumber,
      documentDate: r.documentDate,
      ageDays: r.ageDays,
      bucket: r.bucket,
      openBalanceCents: cents(r.openBalanceCents),
    }));
    return {
      asOfDate,
      side,
      items,
      totalCents: items.reduce((s, i) => s + i.openBalanceCents, 0),
      subledgerOutOfTie: rows.some((r) => r.subledgerOutOfTie),
    };
  }
  return { asOfDate: null, side, items: [], totalCents: 0, subledgerOutOfTie: false };
}

async function budgetFor(tx: RunTx, firmId: string, clientId: string, period: string | null): Promise<PortalBudget> {
  const periods = await tx.query("close_periods_for_client", { firmId, clientId });
  const starts = periods.map((p) => p.periodStart).sort().reverse();
  const periodStart = period ?? starts[0] ?? null;
  if (!periodStart) return { periodStart: null, items: [], budgetLineCount: 0 };
  const [variances, budgets] = await Promise.all([
    tx.query("report_variances_for_period", { firmId, clientId, periodStart }),
    tx.query("budgets_for_period", { firmId, clientId, periodStart }),
  ]);
  return {
    periodStart,
    items: variances.map((v) => ({
      accountNumber: v.accountNumber,
      accountName: v.accountName,
      actualCents: cents(v.actualCents),
      budgetCents: cents(v.budgetCents),
      varianceCents: cents(v.varianceCents),
      direction: v.direction,
      flagged: v.flagged,
      detail: v.detail,
    })),
    budgetLineCount: budgets.length,
  };
}

async function forecastFor(tx: RunTx, firmId: string, clientId: string, runId: string | null): Promise<PortalForecast> {
  const runs = await tx.query("cash_forecast_runs_for_client", { firmId, clientId });
  const sorted = runs.slice().sort((a, b) => (a.builtAt !== b.builtAt ? (a.builtAt > b.builtAt ? -1 : 1) : a.id < b.id ? -1 : 1));
  const chosen = runId ? sorted.find((r) => r.id === runId) ?? null : sorted.find((r) => r.scenario === "base") ?? sorted[0] ?? null;
  const weeks = chosen
    ? (await tx.query("cash_forecast_weeks_for_run", { firmId, clientId, forecastRunId: chosen.id })).sort(
        (a, b) => a.weekNumber - b.weekNumber,
      )
    : [];
  return {
    run: chosen
      ? {
          id: chosen.id,
          scenario: chosen.scenario,
          startDate: chosen.startDate,
          endDate: chosen.endDate,
          horizonWeeks: chosen.horizonWeeks,
          openingCashCents: cents(chosen.openingCashCents),
          closingCashCents: cents(chosen.closingCashCents),
          firstShortfallWeek: chosen.firstShortfallWeek,
          builtAt: chosen.builtAt,
        }
      : null,
    weeks: weeks.map((w) => ({
      weekNumber: w.weekNumber,
      weekStart: w.weekStart,
      weekEnd: w.weekEnd,
      openingCents: cents(w.openingCents),
      inflowCents: cents(w.inflowCents),
      outflowCents: cents(w.outflowCents),
      closingCents: cents(w.closingCents),
      shortfall: w.shortfall,
    })),
    runs: sorted.map((r) => ({
      id: r.id,
      scenario: r.scenario,
      startDate: r.startDate,
      closingCashCents: cents(r.closingCashCents),
      firstShortfallWeek: r.firstShortfallWeek,
      builtAt: r.builtAt,
    })),
  };
}

async function narrativeFor(tx: RunTx, firmId: string, clientId: string): Promise<PortalNarrative> {
  const rows = await tx.query("report_narratives_for_client", { firmId, clientId });
  return {
    items: rows
      .slice()
      .sort((a, b) => (a.periodStart !== b.periodStart ? (a.periodStart > b.periodStart ? -1 : 1) : a.id < b.id ? -1 : 1))
      .map((n) => ({
        id: n.id,
        periodStart: n.periodStart,
        audience: n.audience,
        bodyText: n.bodyText,
        sentenceCount: n.sentenceCount,
        composedAt: n.composedAt,
      })),
  };
}

async function reportsFor(tx: RunTx, firmId: string, clientId: string): Promise<PortalReports> {
  const rows = await tx.query("report_packages_for_client", { firmId, clientId });
  return {
    items: rows
      .slice()
      .sort((a, b) => (a.builtAt !== b.builtAt ? (a.builtAt > b.builtAt ? -1 : 1) : a.id < b.id ? -1 : 1))
      .map((p) => ({
        id: p.id,
        periodStart: p.periodStart,
        basis: p.basis,
        state: p.state,
        sectionCount: p.sectionCount,
        closedWithExceptions: p.closedWithExceptions,
        builtAt: p.builtAt,
      })),
    storageConfigured: false,
  };
}

async function periodsFor(tx: RunTx, firmId: string, clientId: string): Promise<PortalPeriods> {
  const rows = await tx.query("close_periods_for_client", { firmId, clientId });
  return {
    items: rows
      .slice()
      .sort((a, b) => (a.periodStart > b.periodStart ? -1 : 1))
      .map((p) => ({ periodStart: p.periodStart, status: p.status, lockedAt: p.lockedAt })),
  };
}

/* ---------------- Routers ---------------- */

export interface PortalRouterDeps {
  deps: ApiDeps;
  entitlementFor: (req: Request) => Promise<Entitlement>;
}

function todayOf(deps: ApiDeps): string {
  return deps.today ? deps.today() : new Date().toISOString().slice(0, 10);
}

function featureOrThrow(key: string): FeatureKey {
  if (!(FEATURE_KEYS as readonly string[]).includes(key)) throw new Error(`unknown feature ${key}`);
  return key as FeatureKey;
}

/** The client plane. Mounted under /api/portal/:clientId behind requireClient. */
export function createPortalScreensRouter({ deps, entitlementFor }: PortalRouterDeps): Router {
  const portal = Router({ mergeParams: true });
  portal.use(deps.guards.requireClient("clientId"));
  const gate = (key: string) => requireFeature(featureOrThrow(key), entitlementFor);

  const read = <T>(fn: (tx: RunTx, firmId: string, clientId: string, req: Request) => Promise<T>) =>
    route(async (req) => {
      const { actor, clientId, firmId } = clientOf(req);
      const body = await deps.db.tx(readSession(actor, firmId, clientId), (tx) => fn(tx, firmId, clientId, req));
      return { body };
    });

  portal.get("/requests", gate("requests"), read((tx, f, c) => requestsFor(tx, f, c)));
  portal.post(
    "/requests/answer",
    gate("requests"),
    route(async (req) => {
      const body = parse(answerRequestBodySchema, req.body);
      return previewThenApply({ deps, req, runCode: "PORTAL-ANSWER-REQUEST", scope: body });
    }),
  );

  portal.get("/messages", gate("messages"), read((tx, f, c, req) => messagesFor(tx, f, c, clientOf(req).actor.userId)));
  portal.post(
    "/messages",
    gate("messages"),
    route(async (req) => {
      const body = parse(postMessageBodySchema, req.body);
      const now = deps.now ? deps.now() : new Date();
      return previewThenApply({
        deps,
        req,
        runCode: "PORTAL-POST-MESSAGE",
        scope: { body: body.body, authorScope: "client", postedMinute: now.toISOString().slice(0, 16) },
      });
    }),
  );

  portal.get("/documents", gate("documents"), read((tx, f, c) => documentsFor(tx, f, c, deps.storage ?? null)));
  // Upload and download, server/api/uploads.ts. The same routes serve a client
  // user and firm staff; requireClient above decided who may be here.
  portal.use(createDocumentRoutes({ deps, gate: gate("documents") }));

  // Signing needs no feature beyond being this client's person. An engagement
  // that is not yet active has no tier to gate on.
  portal.get("/sign", read((tx, f, c, req) => signFor(tx, f, c, clientOf(req).actor)));
  portal.post(
    "/sign",
    route(async (req) => {
      const body = parse(signLetterBodySchema, req.body);
      if (body.consentText !== SIGN_CONSENT_TEXT) {
        throw new ApiFailure(400, "validation_failed", "The consent text does not match the letter shown.");
      }
      const { actor, clientId, firmId } = clientOf(req);
      const engagements = await deps.db.tx(readSession(actor, firmId, clientId), (tx) =>
        tx.query("engagements_for_client", { firmId, clientId }),
      );
      const engagement = engagements[0];
      if (!engagement) throw new ApiFailure(404, "not_found", "This client has no engagement to sign.");
      return previewThenApply({
        deps,
        req,
        runCode: "ENG-SIGN-LETTER",
        scope: {
          engagementId: engagement.id,
          signerName: body.signerName,
          signerEmail: actor.email,
          signerTitle: body.signerTitle && body.signerTitle.length > 0 ? body.signerTitle : null,
          consentText: body.consentText,
          signerIp: remoteIp(req),
          userAgent: req.get("user-agent") ?? "unknown",
        },
      });
    }),
  );

  portal.get(
    "/aging",
    gate("aging"),
    read((tx, f, c, req) => {
      const side = req.query.side === "payable" ? "payable" : "receivable";
      return agingFor(tx, f, c, side, todayOf(deps));
    }),
  );
  portal.get(
    "/budget",
    gate("budget"),
    read((tx, f, c, req) => budgetFor(tx, f, c, typeof req.query.period === "string" ? req.query.period : null)),
  );
  portal.get(
    "/forecast",
    gate("forecast"),
    read((tx, f, c, req) => forecastFor(tx, f, c, typeof req.query.run === "string" ? req.query.run : null)),
  );
  portal.get("/scenarios", gate("scenarios"), read((tx, f, c) => forecastFor(tx, f, c, null)));
  portal.get("/narrative", gate("narrative"), read((tx, f, c) => narrativeFor(tx, f, c)));
  portal.get("/reports", gate("custom_reports"), read((tx, f, c) => reportsFor(tx, f, c)));
  portal.get("/periods", gate("open_period"), read((tx, f, c) => periodsFor(tx, f, c)));

  return portal;
}

/**
 * The firm's side of the thread. Mounted under /api/firm/clients/:clientId
 * behind requireClient, which admits firm staff by their firm membership.
 */
export function createFirmMessagesRouter({ deps }: PortalRouterDeps): Router {
  const firm = Router({ mergeParams: true });
  firm.use(deps.guards.requireClient("clientId"));
  firm.get(
    "/messages",
    route(async (req) => {
      const { actor, clientId, firmId } = clientOf(req);
      const body = await deps.db.tx(readSession(actor, firmId, clientId), (tx) => messagesFor(tx, firmId, clientId, actor.userId));
      return { body };
    }),
  );
  firm.post(
    "/messages",
    route(async (req) => {
      const body = parse(postMessageBodySchema, req.body);
      const now = deps.now ? deps.now() : new Date();
      return previewThenApply({
        deps,
        req,
        runCode: "PORTAL-POST-MESSAGE",
        scope: { body: body.body, authorScope: "firm", postedMinute: now.toISOString().slice(0, 16) },
      });
    }),
  );
  firm.get(
    "/requests",
    route(async (req) => {
      const { actor, clientId, firmId } = clientOf(req);
      const body = await deps.db.tx(readSession(actor, firmId, clientId), (tx) => requestsFor(tx, firmId, clientId));
      return { body };
    }),
  );
  return firm;
}
