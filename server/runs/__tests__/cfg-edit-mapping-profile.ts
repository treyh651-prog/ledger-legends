/**
 * CFG-EDIT-MAPPING-PROFILE tests. Unlike CFG-EDIT-CATEGORY and CFG-EDIT-RULE,
 * a profile is never edited in place: the edit inserts a new row, carries
 * forward every field the scope did not name, deactivates the row it
 * replaces, and backfills the superseded row's own version 1 snapshot on its
 * first edit. Covered: the new row, the deactivation, the backfill, the no
 * op, the not found refusal, and undo restoring exactly one active row.
 */

import { assert, assertEqual, test } from "./harness";
import { MemoryRunDb } from "../db-memory";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { ACTOR, CLIENT_A1, FIRM_A, NOW, mappingProfile, opts } from "./fixtures";
import {
  BACKFILL_CHANGE_NOTE,
  ERR_MAPPING_PROFILE_NOT_FOUND,
  cfgEditMappingProfile,
  supersedingProfileIdFor,
  type EditMappingProfileScope,
} from "../runs/cfg-edit-mapping-profile";
import type { MappingProfileRow, MappingProfileVersionRow } from "../tables";

const PROFILE_ID = "MP-FIRSTBANK-CSV";
const HEADER = ["Date", "Description", "Amount"];

function seedProfile(db: MemoryRunDb, extra: Partial<MappingProfileRow> = {}): MappingProfileRow {
  const row = mappingProfile(PROFILE_ID, FIRM_A, CLIENT_A1, HEADER, extra);
  db.seed("mapping_profiles", [row]);
  return row;
}

function scopeFor(
  fields: EditMappingProfileScope["fields"],
  changeNote = "the bank renamed a column",
): EditMappingProfileScope {
  return { clientId: CLIENT_A1, mappingProfileId: PROFILE_ID, changeNote, fields };
}

async function editAndApply(db: MemoryRunDb, scope: EditMappingProfileScope) {
  const preview = await execute(db, cfgEditMappingProfile, scope, opts("preview"));
  const applied = await execute(db, cfgEditMappingProfile, scope, opts("apply", { previewRunId: preview.executionId }));
  return { preview, applied };
}

function profilesOf(db: MemoryRunDb): MappingProfileRow[] {
  return (db.all("mapping_profiles") as unknown as MappingProfileRow[]).filter(
    (p) => p.clientId === CLIENT_A1 && p.institutionName === "First Bank" && p.fileFormat === "csv",
  );
}

function versionsFor(db: MemoryRunDb, profileId: string): MappingProfileVersionRow[] {
  return (db.all("mapping_profile_versions") as unknown as MappingProfileVersionRow[]).filter(
    (v) => v.profileId === profileId,
  );
}

test("cfg-edit-mapping-profile: editing inserts a new row at the next version and deactivates the old one", async () => {
  const db = new MemoryRunDb();
  seedProfile(db);
  const { applied } = await editAndApply(db, scopeFor({ dateFormat: "DD/MM/YYYY" }));
  assertEqual(applied.status, "completed", "apply completed");
  const rows = profilesOf(db);
  assertEqual(rows.length, 2, "the old row stays, a new one is added");
  const oldRow = rows.find((r) => r.id === PROFILE_ID)!;
  assertEqual(oldRow.isActive, false, "the superseded row is deactivated");
  assertEqual(oldRow.dateFormat, "MM/DD/YYYY", "the superseded row's own fields are never rewritten");
  const newId = supersedingProfileIdFor(PROFILE_ID, 2);
  const newRow = rows.find((r) => r.id === newId)!;
  assert(newRow !== undefined, "the new row exists at its derived id");
  assertEqual(newRow.isActive, true, "the new row is the active one");
  assertEqual(newRow.version, 2, "the new row carries the next version");
  assertEqual(newRow.dateFormat, "DD/MM/YYYY", "the new row carries the edited field");
  assertEqual(newRow.institutionName, "First Bank", "every other field carried forward unedited");
});

test("cfg-edit-mapping-profile: the superseded row's own version history is backfilled on its first edit", async () => {
  const db = new MemoryRunDb();
  seedProfile(db);
  await editAndApply(db, scopeFor({ dateFormat: "DD/MM/YYYY" }));
  const oldVersions = versionsFor(db, PROFILE_ID);
  assertEqual(oldVersions.length, 1, "exactly one backfilled entry for the superseded row");
  assertEqual(oldVersions[0].version, 1, "it names the superseded row's own version");
  assertEqual(oldVersions[0].changeNote, BACKFILL_CHANGE_NOTE, "it names itself as a backfill");
  const newId = supersedingProfileIdFor(PROFILE_ID, 2);
  const newVersions = versionsFor(db, newId);
  assertEqual(newVersions.length, 1, "the new row gets its own entry, under its own id");
  assertEqual(newVersions[0].version, 2, "at the new row's own version");
  assertEqual(newVersions[0].changeNote, "the bank renamed a column", "carrying the caller's note");
});

test("cfg-edit-mapping-profile: a second edit does not redo the first row's backfill", async () => {
  const db = new MemoryRunDb();
  seedProfile(db);
  await editAndApply(db, scopeFor({ dateFormat: "DD/MM/YYYY" }));
  const secondId = supersedingProfileIdFor(PROFILE_ID, 2);
  await execute(
    db,
    cfgEditMappingProfile,
    { clientId: CLIENT_A1, mappingProfileId: secondId, changeNote: "corrected again", fields: { skipRows: 1 } },
    opts("preview"),
  ).then((preview) =>
    execute(db, cfgEditMappingProfile, {
      clientId: CLIENT_A1,
      mappingProfileId: secondId,
      changeNote: "corrected again",
      fields: { skipRows: 1 },
    }, opts("apply", { previewRunId: preview.executionId })),
  );
  assertEqual(versionsFor(db, PROFILE_ID).length, 1, "the first row's backfill happens exactly once, ever");
  const thirdId = supersedingProfileIdFor(secondId, 3);
  assertEqual(versionsFor(db, thirdId).length, 1, "the third row gets its own fresh entry");
});

test("cfg-edit-mapping-profile: naming the value a profile already has is a no op and inserts nothing", async () => {
  const db = new MemoryRunDb();
  seedProfile(db);
  const preview = await execute(db, cfgEditMappingProfile, scopeFor({ dateFormat: "MM/DD/YYYY" }), opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(preview.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
  assertEqual(profilesOf(db).length, 1, "no new row was proposed, let alone inserted");
});

test("cfg-edit-mapping-profile: a profile that is not this client's own is refused", async () => {
  const db = new MemoryRunDb();
  seedProfile(db);
  const preview = await execute(
    db,
    cfgEditMappingProfile,
    { clientId: CLIENT_A1, mappingProfileId: "MP-DOES-NOT-EXIST", changeNote: "x", fields: { skipRows: 1 } },
    opts("preview"),
  );
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_MAPPING_PROFILE_NOT_FOUND), "named error code");
});

test("cfg-edit-mapping-profile: undo reactivates the old row and deactivates the new one, never two active at once", async () => {
  const db = new MemoryRunDb();
  seedProfile(db);
  const { applied } = await editAndApply(db, scopeFor({ dateFormat: "DD/MM/YYYY" }));
  const undone = await executeUndo(db, cfgEditMappingProfile, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");
  const rows = profilesOf(db);
  const active = rows.filter((r) => r.isActive);
  assertEqual(active.length, 1, "exactly one active row after undo");
  assertEqual(active[0].id, PROFILE_ID, "the original row is active again");
  assertEqual(active[0].dateFormat, "MM/DD/YYYY", "with its original field value");
});

