/**
 * INTAKE-CREATE-CLIENT v1.
 *
 * The first thing the firm does for a new client is make the client exist.
 * Before the API layer that was a bare insert nobody could preview, undo, or
 * find in the run log. Now it is a run like the other three intake steps, so
 * the first real client of a firm is created by the engine, with an intent
 * row, a frozen scope, and a preview the apply has to agree with.
 *
 * Two proposals: the tenancy.clients row and its draft engagement. The
 * engagement starts as a draft because the eng_signed_has_letter constraint
 * requires a letter and a signature before it can be signed or active, and
 * neither exists at intake. The entitlement view therefore grants nothing
 * until a person activates the engagement, which is the tiers design and not a
 * gap in this run.
 *
 * Idempotency. The route picks the client id and carries it in the scope, so
 * preview and apply hash the same work. A second apply of the same scope is
 * deduplicated by the engine before it reaches the lock. A different scope with
 * the same name is a different client, as it would be on paper.
 *
 * Undo. Nothing reverts. A client row that other rows reference cannot be
 * removed by a reversal, and archiving is a person's decision, so undoPlan is
 * empty and the run log says so.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
  type Ulid,
} from "../contract";
import {
  ACTOR_PLACEHOLDER,
  NOW_PLACEHOLDER,
  applyProposals,
  requireTx,
} from "../apply-writer";
import { scopeHashFor } from "../ids";
import type { ClientRow, EngagementRow } from "../tables";
import { periodWindow } from "./per-shared";
import { templateFor } from "./intake-shared";

export const createClientScopeSchema = z.object({
  /** The id the route generated, a uuid, so preview and apply agree. */
  clientId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  entityType: z.string().min(1),
  industry: z.string().min(1),
  isNonprofit: z.boolean().default(false),
  fiscalYearEndMonth: z.number().int().min(1).max(12).default(12),
  scopeKeys: z.array(z.string().min(1)).default([]),
  serviceLevel: z.string().min(1),
  reportingBasis: z.enum(["accrual", "cash", "both"]).default("accrual"),
  startDate: z.string().min(10),
  monthlyFeeCents: z.number().int().min(0).default(0),
});

export type CreateClientScope = z.infer<typeof createClientScopeSchema>;

export const ERR_CLIENT_EXISTS = "INTAKE-CLIENT-EXISTS";
export const ERR_UNKNOWN_INDUSTRY = "INTAKE-UNKNOWN-INDUSTRY";

/** A stable uuid shaped id derived from a seed. Version nibble 5, RFC variant. */
export function uuidFrom(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][parseInt(hex[16], 16) % 4];
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function engagementIdOf(clientId: Ulid): Ulid {
  return uuidFrom(`${clientId}/engagement/1`);
}

export const intakeCreateClient: Run<CreateClientScope, Proposal> = {
  type: "INTAKE-CREATE-CLIENT",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:intake-client`,
  scopeSchema: createClientScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateClientScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.startDate);
    const existing = await tx.query("client_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const candidateIds = [scope.clientId, engagementIdOf(scope.clientId)];
    const versions = [{ id: "INTAKE-CREATE-CLIENT", version: 1 }];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [
          existing.length > 0 ? "exists" : "new",
          scope.name,
          scope.entityType,
          scope.industry,
          scope.serviceLevel,
          scope.startDate,
          [...scope.scopeKeys].sort().join("|"),
        ].join("/"),
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];

    const existing = await tx.query("client_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    if (existing.length > 0) {
      errors.push({
        rowId: scope.clientId,
        code: ERR_CLIENT_EXISTS,
        message: `client ${scope.clientId} already exists in this firm`,
        retryable: false,
      });
    }
    const template = templateFor(scope.industry);
    if (template === undefined) {
      errors.push({
        rowId: null,
        code: ERR_UNKNOWN_INDUSTRY,
        message: `${scope.industry} is not one of the standard chart templates`,
        retryable: false,
      });
    }
    if (errors.length > 0) {
      return makeResult<Proposal>(frozen.candidateIds.length, [], [], errors, BigInt(0));
    }

    const client: Omit<ClientRow, "onboardedAt" | "archivedAt"> & {
      onboardedAt: null;
      archivedAt: null;
    } = {
      id: scope.clientId,
      firmId: ctx.firmId,
      name: scope.name,
      entityType: scope.entityType,
      isNonprofit: scope.isNonprofit || scope.industry === "nonprofit",
      fiscalYearEndMonth: scope.fiscalYearEndMonth,
      functionalCurrency: "USD",
      capitalizeOverCents: BigInt(250000),
      engagementScope: { keys: [...scope.scopeKeys].sort() },
      chartTemplateId: template?.id ?? null,
      inventoryMethod: scope.scopeKeys.includes("inventory") ? "periodic_weighted_average" : "none",
      onboardedAt: null,
      archivedAt: null,
    };

    const engagement: EngagementRow = {
      id: engagementIdOf(scope.clientId),
      firmId: ctx.firmId,
      clientId: scope.clientId,
      name: `${scope.name} engagement`,
      status: "draft",
      serviceLevel: scope.serviceLevel,
      reportingBasis: scope.reportingBasis,
      scope: {
        keys: [...scope.scopeKeys].sort(),
        monthlyFeeCents: scope.monthlyFeeCents,
      },
      startDate: scope.startDate,
      endDate: null,
      letterDocumentId: null,
      signedAt: null,
      terminatedAt: null,
      terminationReason: null,
      offboardingExportDays: 15,
      createdAt: NOW_PLACEHOLDER,
      createdBy: ACTOR_PLACEHOLDER,
    };

    const proposals: ProposedRowInsert[] = [
      {
        kind: "row_insert",
        table: "clients",
        rowId: client.id,
        row: client as unknown as Record<string, unknown>,
        provenance: { cascadeLevel: null },
      },
      {
        kind: "row_insert",
        table: "engagements",
        rowId: engagement.id,
        row: engagement as unknown as Record<string, unknown>,
        provenance: { cascadeLevel: null },
      },
    ];
    return makeResult<Proposal>(frozen.candidateIds.length, proposals, [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "INTAKE-CREATE-CLIENT",
      runVersion: 1,
    });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
