/**
 * CFG-CREATE-ENTITY-GROUP, CFG-EDIT-ENTITY-GROUP, CFG-SET-GROUP-MEMBERS.
 *
 * Group consolidation needs a firm-defined set of client entities to
 * combine, and nothing in this codebase ever modeled that: the only
 * multi-entity relationship on file is tenancy.memberships, which ties a
 * person to a client, not a client to another client. These three runs are
 * the first writers of tenancy.entity_groups/entity_group_members (migration
 * 0061), in the same manual-tier, run-framework shape every other piece of
 * firm setup in this app already uses (CFG-CREATE-CATEGORY, CFG-EDIT-CLIENT-POLICY)
 * rather than a raw CRUD table nothing else in this app has.
 *
 * CFG-SET-GROUP-MEMBERS takes the whole desired roster and diffs it against
 * the current one, the same "take the whole desired state" shape
 * CFG-EDIT-CLIENT-POLICY already uses. Removing a member is a field write on
 * removed_at, never a delete: this codebase has no delete-shaped proposal at
 * all (contract.ts's Proposal union is journal_entry | field_write |
 * row_insert | suspense), and every other removal in this app is a soft
 * state change (a category deactivates, a mapping profile deactivates, a
 * client archives) rather than a row disappearing. Re-adding a previously
 * removed member clears removed_at on its existing row rather than
 * inserting a duplicate, which the table's own unique(group_id, client_id)
 * constraint would refuse anyway.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
} from "../contract";
import { NOW_PLACEHOLDER, applyProposals, requireTx } from "../apply-writer";
import { canonicalJson, derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { RunTx } from "../db";
import type { EntityGroupMemberRow, EntityGroupRow } from "../tables";

/**
 * Last resort anchor when a group names no active member: any client the
 * firm has, purely so this run's required single clientId is a row
 * has_client_access can actually find (same reasoning
 * rpt-build-consolidated-package.ts's own anyClientInFirm gives). Never
 * used for anything business-meaningful -- propose() reads scope.groupId.
 */
async function anyClientInFirm(tx: RunTx, firmId: string): Promise<string> {
  const clients = await tx.query("clients_for_firm", { firmId });
  if (clients.length === 0) {
    throw new Error(`firm ${firmId} has no clients at all, so this run has no client to anchor its session on`);
  }
  return clients[0].id;
}

export const ERR_ENTITY_GROUP_UNKNOWN = "ERR_ENTITY_GROUP_UNKNOWN";
export const ERR_ENTITY_GROUP_UNKNOWN_CLIENT = "ERR_ENTITY_GROUP_UNKNOWN_CLIENT";

/* -------------------------------------------------------------------------- */
/* CFG-CREATE-ENTITY-GROUP                                                    */
/* -------------------------------------------------------------------------- */

export const createEntityGroupScopeSchema = z.object({
  name: z.string().min(1),
  // At least one, so this run always has a real member client to use as
  // this framework's required single anchor clientId (see
  // rpt-build-consolidated-package.ts's header comment for why every run
  // needs one). A group can still be emptied out later through
  // CFG-SET-GROUP-MEMBERS.
  memberClientIds: z.array(z.string().min(1)).min(1),
});

export type CreateEntityGroupScope = z.infer<typeof createEntityGroupScopeSchema>;

/**
 * Derived from the firm, the name, and the sorted member set -- the same
 * "no natural key, derive from the full canonical field set" answer
 * CFG-CREATE-RULE already uses for a row with nothing else to key on. Two
 * identical create calls collapse to the same row and the second reports
 * already_applied, which is the correct outcome for a true duplicate.
 */
export function entityGroupIdFor(firmId: string, name: string, memberClientIds: readonly string[]): string {
  return derivedId(
    canonicalJson({ firmId, name, memberClientIds: [...memberClientIds].sort() }),
    "cfg-create-entity-group",
    0,
  );
}

/** A member row's id, derived from the group and the client so a re-add after removal is reproducible. */
export function entityGroupMemberIdFor(groupId: string, clientId: string): string {
  return derivedId(`${groupId}:${clientId}`, "entity-group-member", 0);
}

export const cfgCreateEntityGroup: Run<CreateEntityGroupScope, Proposal> = {
  type: "CFG-CREATE-ENTITY-GROUP",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  // No firmId on this scope (the action is firm-wide, not client-scoped) to
  // fold in here the way every other create-shaped run's own concurrencyKey
  // does -- harmless, since this is only a lock key, never the stored id,
  // which propose() derives properly from ctx.firmId.
  concurrencyKey: (scope) => `entity-group:${canonicalJson({ name: scope.name, memberClientIds: [...scope.memberClientIds].sort() })}`,
  scopeSchema: createEntityGroupScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateEntityGroupScope>> {
    const id = entityGroupIdFor(ctx.firmId, scope.name, scope.memberClientIds);
    const candidateIds = [id, ...scope.memberClientIds.map((c) => entityGroupMemberIdFor(id, c))];
    const versions = [{ id: "CFG-CREATE-ENTITY-GROUP", version: 1 }];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      // The scope schema requires at least one member, so this always
      // names a real client -- this framework's required single anchor
      // clientId (see rpt-build-consolidated-package.ts's header comment).
      clientId: scope.memberClientIds[0],
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions, period: canonicalJson(scope) }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const id = entityGroupIdFor(frozen.firmId, scope.name, scope.memberClientIds);

    const existingGroups = await tx.query("entity_groups_for_firm", { firmId: frozen.firmId });
    if (existingGroups.some((g) => g.id === id)) {
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        [],
        [{ rowId: id, reason: "already_applied", detail: "a group with this name and member set already exists" }],
        [],
        BigInt(0),
      );
    }

    for (const clientId of scope.memberClientIds) {
      const rows = await tx.query("client_by_id", { firmId: frozen.firmId, clientId });
      if (rows.length === 0) {
        errors.push({
          rowId: id,
          code: ERR_ENTITY_GROUP_UNKNOWN_CLIENT,
          message: `client ${clientId} does not belong to this firm`,
          retryable: false,
        });
      }
    }
    if (errors.length > 0) return makeResult<Proposal>(frozen.candidateIds.length, [], [], errors, BigInt(0));

    const groupRow: EntityGroupRow = {
      id,
      firmId: frozen.firmId,
      name: scope.name,
      createdAt: NOW_PLACEHOLDER,
      archivedAt: null,
    };
    const proposals: Proposal[] = [
      {
        kind: "row_insert",
        table: "entity_groups",
        rowId: id,
        row: groupRow as unknown as Record<string, unknown>,
        provenance: { cascadeLevel: null },
      },
    ];
    for (const clientId of scope.memberClientIds) {
      const memberRow: EntityGroupMemberRow = {
        id: entityGroupMemberIdFor(id, clientId),
        groupId: id,
        firmId: frozen.firmId,
        clientId,
        addedAt: NOW_PLACEHOLDER,
        removedAt: null,
      };
      proposals.push({
        kind: "row_insert",
        table: "entity_group_members",
        rowId: memberRow.id,
        row: memberRow as unknown as Record<string, unknown>,
        provenance: { cascadeLevel: null },
      });
    }
    return makeResult<Proposal>(frozen.candidateIds.length, proposals, [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-ENTITY-GROUP", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    // Every proposal is an insert of a row with no prior value; inserts
    // never revert in this framework.
    return [];
  },
};

/* -------------------------------------------------------------------------- */
/* CFG-EDIT-ENTITY-GROUP                                                      */
/* -------------------------------------------------------------------------- */

export const editEntityGroupScopeSchema = z.object({
  groupId: z.string().min(1),
  name: z.string().min(1).optional(),
  archived: z.boolean().optional(),
});

export type EditEntityGroupScope = z.infer<typeof editEntityGroupScopeSchema>;

export const cfgEditEntityGroup: Run<EditEntityGroupScope, Proposal> = {
  type: "CFG-EDIT-ENTITY-GROUP",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `entity-group:${scope.groupId}`,
  scopeSchema: editEntityGroupScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<EditEntityGroupScope>> {
    const tx = requireTx(ctx);
    const groups = await tx.query("entity_groups_for_firm", { firmId: ctx.firmId });
    const existing = groups.find((g) => g.id === scope.groupId);
    const members = await tx.query("entity_group_members_for_group", { firmId: ctx.firmId, groupId: scope.groupId });
    const activeMember = members.find((m) => m.removedAt === null);
    const anchor = activeMember?.clientId ?? (await anyClientInFirm(tx, ctx.firmId));
    const candidateIds = [scope.groupId];
    const versions = [{ id: "CFG-EDIT-ENTITY-GROUP", version: 1 }];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: anchor,
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [existing ? "exists" : "missing", canonicalJson(scope)].join("/"),
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const groups = await tx.query("entity_groups_for_firm", { firmId: frozen.firmId });
    const existing = groups.find((g) => g.id === scope.groupId);
    if (existing === undefined) {
      return makeResult<Proposal>(
        1,
        [],
        [],
        [{ rowId: scope.groupId, code: ERR_ENTITY_GROUP_UNKNOWN, message: `entity group ${scope.groupId} does not exist for this firm`, retryable: false }],
        BigInt(0),
      );
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (scope.name !== undefined && scope.name !== existing.name) {
      before.name = existing.name;
      after.name = scope.name;
    }
    const archivedAt = scope.archived === true ? NOW_PLACEHOLDER : scope.archived === false ? null : undefined;
    if (archivedAt !== undefined && (archivedAt === null ? existing.archivedAt !== null : existing.archivedAt === null)) {
      before.archivedAt = existing.archivedAt;
      after.archivedAt = archivedAt;
    }

    if (Object.keys(after).length === 0) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: scope.groupId, reason: "already_applied", detail: "every named field already has this value" }],
        [],
        BigInt(0),
      );
    }

    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "entity_groups",
      rowId: scope.groupId,
      before,
      after,
      provenance: { cascadeLevel: null },
    };
    return makeResult<Proposal>(1, [write], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-EDIT-ENTITY-GROUP", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    return proposals.filter((p) => p.kind === "field_write").map(revertFieldWrite);
  },
};

/* -------------------------------------------------------------------------- */
/* CFG-SET-GROUP-MEMBERS                                                      */
/* -------------------------------------------------------------------------- */

export const setGroupMembersScopeSchema = z.object({
  groupId: z.string().min(1),
  memberClientIds: z.array(z.string().min(1)),
});

export type SetGroupMembersScope = z.infer<typeof setGroupMembersScopeSchema>;

export const cfgSetGroupMembers: Run<SetGroupMembersScope, Proposal> = {
  type: "CFG-SET-GROUP-MEMBERS",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `entity-group:${scope.groupId}:members`,
  scopeSchema: setGroupMembersScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<SetGroupMembersScope>> {
    const tx = requireTx(ctx);
    const members = await tx.query("entity_group_members_for_group", { firmId: ctx.firmId, groupId: scope.groupId });
    const anchor =
      scope.memberClientIds[0] ??
      members.find((m) => m.removedAt === null)?.clientId ??
      (await anyClientInFirm(tx, ctx.firmId));
    const candidateIds = [scope.groupId, ...scope.memberClientIds.map((c) => entityGroupMemberIdFor(scope.groupId, c))];
    const versions = [{ id: "CFG-SET-GROUP-MEMBERS", version: 1 }];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: anchor,
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions, period: canonicalJson([...scope.memberClientIds].sort()) }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];

    const groups = await tx.query("entity_groups_for_firm", { firmId: frozen.firmId });
    if (!groups.some((g) => g.id === scope.groupId)) {
      return makeResult<Proposal>(
        1,
        [],
        [],
        [{ rowId: scope.groupId, code: ERR_ENTITY_GROUP_UNKNOWN, message: `entity group ${scope.groupId} does not exist for this firm`, retryable: false }],
        BigInt(0),
      );
    }

    for (const clientId of scope.memberClientIds) {
      const rows = await tx.query("client_by_id", { firmId: frozen.firmId, clientId });
      if (rows.length === 0) {
        errors.push({
          rowId: scope.groupId,
          code: ERR_ENTITY_GROUP_UNKNOWN_CLIENT,
          message: `client ${clientId} does not belong to this firm`,
          retryable: false,
        });
      }
    }
    if (errors.length > 0) return makeResult<Proposal>(frozen.candidateIds.length, [], [], errors, BigInt(0));

    const existingMembers = await tx.query("entity_group_members_for_group", { firmId: frozen.firmId, groupId: scope.groupId });
    const existingByClient = new Map(existingMembers.map((m) => [m.clientId, m]));
    const desired = new Set(scope.memberClientIds);

    const proposals: Proposal[] = [];
    const skips: RunResult<Proposal>["skips"] = [];

    for (const clientId of scope.memberClientIds) {
      const existing = existingByClient.get(clientId);
      if (existing === undefined) {
        const rowId = entityGroupMemberIdFor(scope.groupId, clientId);
        proposals.push({
          kind: "row_insert",
          table: "entity_group_members",
          rowId,
          row: {
            groupId: scope.groupId,
            firmId: frozen.firmId,
            clientId,
            addedAt: NOW_PLACEHOLDER,
            removedAt: null,
          },
          provenance: { cascadeLevel: null },
        });
        continue;
      }
      if (existing.removedAt === null) {
        skips.push({ rowId: existing.id, reason: "already_applied", detail: `${clientId} is already a member` });
        continue;
      }
      proposals.push({
        kind: "field_write",
        table: "entity_group_members",
        rowId: existing.id,
        before: { removedAt: existing.removedAt },
        after: { removedAt: null },
        provenance: { cascadeLevel: null },
      });
    }

    for (const existing of existingMembers) {
      if (existing.removedAt !== null) continue;
      if (desired.has(existing.clientId)) continue;
      proposals.push({
        kind: "field_write",
        table: "entity_group_members",
        rowId: existing.id,
        before: { removedAt: null },
        after: { removedAt: NOW_PLACEHOLDER },
        provenance: { cascadeLevel: null },
      });
    }

    if (proposals.length === 0 && skips.length === 0) {
      skips.push({ rowId: scope.groupId, reason: "already_applied", detail: "the member roster already matches" });
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-SET-GROUP-MEMBERS", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (p.kind === "field_write") plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};
