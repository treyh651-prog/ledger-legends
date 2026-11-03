/**
 * CFG-CREATE-ENTITY-GROUP, CFG-EDIT-ENTITY-GROUP, CFG-SET-GROUP-MEMBERS tests.
 */

import { assert, assertEqual, test } from "./harness";
import { execute, type ExecuteOptions, type RunOutcome } from "../execute";
import type { Proposal } from "../contract";
import { MemoryRunDb } from "../db-memory";
import { ACTOR, FIRM_A, NOW, CLIENT_A1, CLIENT_A2 } from "./fixtures";
import { consolidationDb } from "./consolidation-fixtures";
import {
  ERR_ENTITY_GROUP_UNKNOWN,
  ERR_ENTITY_GROUP_UNKNOWN_CLIENT,
  cfgCreateEntityGroup,
  cfgEditEntityGroup,
  cfgSetGroupMembers,
  entityGroupIdFor,
  type CreateEntityGroupScope,
  type EditEntityGroupScope,
  type SetGroupMembersScope,
} from "../runs/cfg-entity-group";

function runOpts(mode: "preview" | "apply", extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return { mode, firmId: FIRM_A, clientId: CLIENT_A1, actor: { userId: ACTOR, kind: "human" }, now: NOW, source: "button", ...extra };
}

async function applyRun<S>(db: MemoryRunDb, run: Parameters<typeof execute<S, Proposal>>[1], scope: S): Promise<{ preview: RunOutcome<Proposal>; applied: RunOutcome<Proposal> }> {
  const preview = await execute<S, Proposal>(db, run, scope, runOpts("preview"));
  const applied = await execute<S, Proposal>(db, run, scope, runOpts("apply", { previewRunId: preview.executionId }));
  return { preview, applied };
}

test("create entity group: a real initial roster lands", async () => {
  const db = consolidationDb();
  const scope: CreateEntityGroupScope = { name: "Smith Holdings", memberClientIds: [CLIENT_A1, CLIENT_A2] };
  const { applied } = await applyRun(db, cfgCreateEntityGroup, scope);
  assertEqual(applied.status, "completed", "completed");
  const id = entityGroupIdFor(FIRM_A, scope.name, scope.memberClientIds);
  const group = db.all("entity_groups").find((g) => g.id === id);
  assert(group !== undefined, "the group row exists");
  const members = db.all("entity_group_members").filter((m) => m.groupId === id);
  assertEqual(members.length, 2, "both initial members landed");
  assert(members.every((m) => m.removedAt === null), "neither is removed");
});

test("create entity group: an unknown client refuses and writes nothing", async () => {
  const db = consolidationDb([CLIENT_A1]);
  const scope: CreateEntityGroupScope = { name: "Bad Group", memberClientIds: [CLIENT_A1, "CLI-GHOST"] };
  const preview = await execute(db, cfgCreateEntityGroup, scope, runOpts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_ENTITY_GROUP_UNKNOWN_CLIENT), "named error code");
  assertEqual(db.all("entity_groups").length, 0, "nothing written");
});

test("create entity group: an identical second call is already_applied", async () => {
  const db = consolidationDb();
  const scope: CreateEntityGroupScope = { name: "Smith Holdings", memberClientIds: [CLIENT_A1, CLIENT_A2] };
  await applyRun(db, cfgCreateEntityGroup, scope);
  const second = await execute(db, cfgCreateEntityGroup, scope, runOpts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(second.result.skips.some((s) => s.reason === "already_applied"), "already_applied");
});

test("edit entity group: rename and archive, each a clean field write", async () => {
  const db = consolidationDb();
  const createScope: CreateEntityGroupScope = { name: "Smith Holdings", memberClientIds: [CLIENT_A1] };
  await applyRun(db, cfgCreateEntityGroup, createScope);
  const id = entityGroupIdFor(FIRM_A, createScope.name, createScope.memberClientIds);

  const renameScope: EditEntityGroupScope = { groupId: id, name: "Smith Family Holdings" };
  const renamed = await applyRun(db, cfgEditEntityGroup, renameScope);
  assertEqual(renamed.applied.status, "completed", "renamed");
  assertEqual(db.all("entity_groups").find((g) => g.id === id)?.name, "Smith Family Holdings", "the new name landed");

  const archiveScope: EditEntityGroupScope = { groupId: id, archived: true };
  const archived = await applyRun(db, cfgEditEntityGroup, archiveScope);
  assertEqual(archived.applied.status, "completed", "archived");
  assert(db.all("entity_groups").find((g) => g.id === id)?.archivedAt !== null, "archived_at is set");
});

test("edit entity group: an unknown group refuses", async () => {
  const db = consolidationDb();
  const preview = await execute(db, cfgEditEntityGroup, { groupId: "GRP-GHOST", name: "x" }, runOpts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_ENTITY_GROUP_UNKNOWN), "named error code");
});

test("set group members: adding a new member inserts, removing an existing one field-writes removed_at", async () => {
  const db = consolidationDb();
  const createScope: CreateEntityGroupScope = { name: "Smith Holdings", memberClientIds: [CLIENT_A1] };
  await applyRun(db, cfgCreateEntityGroup, createScope);
  const id = entityGroupIdFor(FIRM_A, createScope.name, createScope.memberClientIds);

  const setScope: SetGroupMembersScope = { groupId: id, memberClientIds: [CLIENT_A2] };
  const { applied } = await applyRun(db, cfgSetGroupMembers, setScope);
  assertEqual(applied.status, "completed", "completed");
  const members = db.all("entity_group_members").filter((m) => m.groupId === id);
  const a1 = members.find((m) => m.clientId === CLIENT_A1);
  const a2 = members.find((m) => m.clientId === CLIENT_A2);
  assert(a1?.removedAt !== null, "A1 was removed, not deleted");
  assert(a2 !== undefined && a2.removedAt === null, "A2 was added, active");
});

test("set group members: re-adding a previously removed member reuses the same row", async () => {
  const db = consolidationDb();
  const createScope: CreateEntityGroupScope = { name: "Smith Holdings", memberClientIds: [CLIENT_A1, CLIENT_A2] };
  await applyRun(db, cfgCreateEntityGroup, createScope);
  const id = entityGroupIdFor(FIRM_A, createScope.name, createScope.memberClientIds);

  await applyRun(db, cfgSetGroupMembers, { groupId: id, memberClientIds: [CLIENT_A1] });
  let members = db.all("entity_group_members").filter((m) => m.groupId === id);
  assertEqual(members.length, 2, "the removed row still exists, not deleted");
  const removedRowId = members.find((m) => m.clientId === CLIENT_A2)!.id;

  await applyRun(db, cfgSetGroupMembers, { groupId: id, memberClientIds: [CLIENT_A1, CLIENT_A2] });
  members = db.all("entity_group_members").filter((m) => m.groupId === id);
  assertEqual(members.length, 2, "still exactly two rows, not a third");
  const reAdded = members.find((m) => m.clientId === CLIENT_A2)!;
  assertEqual(reAdded.id, removedRowId, "the same row was reused");
  assertEqual(reAdded.removedAt, null, "and it is active again");
});

test("set group members: an unchanged roster is a no op", async () => {
  const db = consolidationDb();
  const createScope: CreateEntityGroupScope = { name: "Smith Holdings", memberClientIds: [CLIENT_A1, CLIENT_A2] };
  await applyRun(db, cfgCreateEntityGroup, createScope);
  const id = entityGroupIdFor(FIRM_A, createScope.name, createScope.memberClientIds);
  const again = await execute(db, cfgSetGroupMembers, { groupId: id, memberClientIds: [CLIENT_A1, CLIENT_A2] }, runOpts("preview"));
  assertEqual(again.status, "no_op", "no_op");
});
