/**
 * CFG-SET-NOTIFICATION-PREFERENCE, version 1.
 *
 * Email feature, broad scope, 2026-11-08. The only run that ever writes
 * tenancy.notification_preferences. docs/09-architecture-and-decisions.md
 * states the shape this has to take: opt in per client per notification
 * type, per D4 (the line the firm must not cross, since Jose and Rosario
 * are not CPAs). An absent row means off -- the absence itself is the
 * default, not a row this run ever has to insert to express "off."
 *
 * Only the two client-facing notification types this round wires up
 * (PRAC-NUDGE-REQUESTS, SUB-RAISE-REQUESTS) are valid here. Staff
 * escalation email (PRAC-ESCALATE-OVERDUE) never reaches a client's inbox,
 * so it is not gated by this table at all -- there is nothing to opt into.
 *
 * Manual tier, writesLedger: false -- a communication preference, not a
 * ledger effect, the same reasoning CFG-DISABLE-RULE-AUTOPOST gives for its
 * own on/off toggle.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunResult,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { revertFieldWrite } from "../undo";
import { canonicalJson, derivedId, scopeHashFor } from "../ids";

export const NOTIFICATION_TYPES = ["document_request_nudge", "substantiation_request_raised"] as const;

export const setNotificationPreferenceScopeSchema = z.object({
  clientId: z.string().min(1),
  notificationType: z.enum(NOTIFICATION_TYPES),
  enabled: z.boolean(),
});

export type SetNotificationPreferenceScope = z.infer<typeof setNotificationPreferenceScopeSchema>;

export function notificationPreferenceIdFor(clientId: string, notificationType: string): string {
  return derivedId(`${clientId}:${notificationType}`, "cfg-set-notification-preference", 0);
}

export const cfgSetNotificationPreference: Run<SetNotificationPreferenceScope, Proposal> = {
  type: "CFG-SET-NOTIFICATION-PREFERENCE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.notificationType}`,
  scopeSchema: setNotificationPreferenceScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<SetNotificationPreferenceScope>> {
    const id = notificationPreferenceIdFor(scope.clientId, scope.notificationType);
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds: [id],
      scopeHash: scopeHashFor({ candidateIds: [id], versions: [{ id: "CFG-SET-NOTIFICATION-PREFERENCE", version: 1 }], period: canonicalJson({ enabled: scope.enabled }) }),
      versions: [{ id: "CFG-SET-NOTIFICATION-PREFERENCE", version: 1 }],
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const id = notificationPreferenceIdFor(scope.clientId, scope.notificationType);
    const rows = await tx.query("notification_preferences_for_client", { firmId: frozen.firmId, clientId: scope.clientId });
    const existing = rows.find((r) => r.notificationType === scope.notificationType) ?? null;

    if (!existing) {
      if (!scope.enabled) {
        return makeResult<Proposal>(
          1,
          [],
          [{ rowId: id, reason: "already_applied", detail: "already off (no row means off)" }],
          [],
          BigInt(0),
        );
      }
      const insert: ProposedRowInsert = {
        kind: "row_insert",
        table: "notification_preferences",
        rowId: id,
        row: {
          firmId: frozen.firmId,
          clientId: scope.clientId,
          version: 1,
          notificationType: scope.notificationType,
          enabled: true,
        },
        provenance: { cascadeLevel: null },
      };
      return makeResult<Proposal>(1, [insert], [], [], BigInt(0));
    }

    if (existing.enabled === scope.enabled) {
      return makeResult<Proposal>(1, [], [{ rowId: existing.id, reason: "already_applied", detail: `already ${scope.enabled ? "on" : "off"}` }], [], BigInt(0));
    }

    return makeResult<Proposal>(
      1,
      [
        {
          kind: "field_write",
          table: "notification_preferences",
          rowId: existing.id,
          before: { enabled: existing.enabled },
          after: { enabled: scope.enabled },
          provenance: { cascadeLevel: null },
        },
      ],
      [],
      [],
      BigInt(0),
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-SET-NOTIFICATION-PREFERENCE", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    return proposals.filter((p) => p.kind === "field_write").map((p) => revertFieldWrite(p));
  },
};
