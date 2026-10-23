/**
 * PORTAL-POST-MESSAGE v1.
 *
 * One message between the client and the firm. The same run serves both
 * directions: the portal route posts with authorScope client and the firm
 * route posts with authorScope firm, and the route sets that field from the
 * plane the request arrived on, never from the body. The thread is read inside
 * the product on both planes. No email leaves, because outbound email is not
 * set up, and the screens do not claim otherwise.
 *
 * One proposal: a row insert into ledger.portal_messages, migration 0028. The
 * row id is derived from the client, the author, the body, and the minute the
 * route stamped into the scope, so preview and apply agree and a double click
 * inside one minute is one message. The same words a minute later are a new
 * message, as they would be in any thread.
 *
 * Undo. A message once read cannot be unread, so undoPlan is empty. Retraction
 * is a second message.
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
import {
  ACTOR_PLACEHOLDER,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  applyProposals,
  requireTx,
} from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";
import type { PortalMessageRow } from "../tables";

export const postMessageScopeSchema = z.object({
  clientId: z.string().min(1),
  authorScope: z.enum(["client", "firm"]),
  body: z.string().trim().min(1).max(4000),
  /** ISO minute the route stamped, "2026-10-22T18:04". Part of the id seed. */
  postedMinute: z.string().min(16).max(16),
});

export type PostMessageScope = z.infer<typeof postMessageScopeSchema>;

export function messageIdOf(scope: PostMessageScope, actorUserId: string): string {
  return derivedId(
    `${scope.clientId}/${scope.authorScope}/${actorUserId}/${scope.postedMinute}/${scope.body}`,
    "portal-message",
    0,
  );
}

export const portalPostMessage: Run<PostMessageScope, Proposal> = {
  type: "PORTAL-POST-MESSAGE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:portal-messages`,
  scopeSchema: postMessageScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<PostMessageScope>> {
    requireTx(ctx);
    const candidateIds = [messageIdOf(scope, ctx.actor.userId)];
    const versions = [{ id: "PORTAL-POST-MESSAGE", version: 1 }];
    const day = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: day,
      periodEnd: day,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [scope.authorScope, scope.postedMinute].join("/"),
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    requireTx(ctx);
    const scope = frozen.input;
    const row: PortalMessageRow = {
      id: frozen.candidateIds[0],
      firmId: ctx.firmId,
      clientId: scope.clientId,
      authorUserId: ACTOR_PLACEHOLDER,
      authorScope: scope.authorScope,
      body: scope.body,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
    };
    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "portal_messages",
      rowId: row.id,
      row: row as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };
    return makeResult<Proposal>(1, [insert], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "PORTAL-POST-MESSAGE",
      runVersion: 1,
    });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
