/**
 * CFG-CREATE-MAPPING-PROFILE tests. Creating the first profile for an
 * institution, account, and format, a repeat create treated as already
 * applied, an already-active profile for the same institution/format
 * refused, an unknown bank account refused, and undo doing nothing since
 * every proposal here is an insert.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { ACTOR, baseDb, CLIENT_A1, FIRM_A, NOW, opts } from "./fixtures";
import {
  ERR_MAPPING_PROFILE_ALREADY_ACTIVE,
  ERR_MAPPING_PROFILE_UNKNOWN_ACCOUNT,
  cfgCreateMappingProfile,
  newMappingProfileIdFor,
  type CreateMappingProfileScope,
} from "../runs/cfg-create-mapping-profile";
import type { MappingProfileRow, MappingProfileVersionRow } from "../tables";

function scopeFor(
  fields: Partial<CreateMappingProfileScope["fields"]> = {},
  changeNote = "first statement from this bank",
): CreateMappingProfileScope {
  return {
    clientId: CLIENT_A1,
    changeNote,
    fields: {
      institutionName: "First National",
      accountNumber: "1010",
      fileFormat: "csv",
      headerCells: ["DATE", "DESCRIPTION", "AMOUNT"],
      headerRowNumber: 1,
      skipRows: 0,
      dateColumn: "DATE",
      dateFormat: "MM/DD/YYYY",
      descriptionColumn: "DESCRIPTION",
      amountColumn: "AMOUNT",
      debitColumn: null,
      creditColumn: null,
      signConvention: "debit_positive",
      currency: "USD",
      bankIdColumn: null,
      checkNumberColumn: null,
      bankCodeColumn: null,
      isActive: true,
      ...fields,
    },
  };
}

async function createAndApply(db: ReturnType<typeof baseDb>, scope: CreateMappingProfileScope) {
  const preview = await execute(db, cfgCreateMappingProfile, scope, opts("preview"));
  const applied = await execute(db, cfgCreateMappingProfile, scope, opts("apply", { previewRunId: preview.executionId }));
  return { preview, applied };
}

test("cfg-create-mapping-profile: the first profile for an institution is created", async () => {
  const db = baseDb();
  const { applied } = await createAndApply(db, scopeFor());
  assertEqual(applied.status, "completed", "apply completed");

  const id = newMappingProfileIdFor(CLIENT_A1, "First National", "1010", "csv");
  const row = (db.all("mapping_profiles") as unknown as MappingProfileRow[]).find((p) => p.id === id);
  assertEqual(row?.institutionName, "First National", "the profile was inserted");
  assertEqual(row?.version, 1, "a fresh profile starts at version 1");
  assertEqual(row?.isActive, true, "active by default");

  const versions = (db.all("mapping_profile_versions") as unknown as MappingProfileVersionRow[]).filter(
    (v) => v.profileId === id,
  );
  assertEqual(versions.length, 1, "one history row for the creation itself");
});

test("cfg-create-mapping-profile: creating the same institution, account, and format twice is a no op the second time", async () => {
  const db = baseDb();
  await createAndApply(db, scopeFor());
  const preview = await execute(db, cfgCreateMappingProfile, scopeFor(), opts("preview"));
  assertEqual(preview.status, "no_op", "no_op");
  assert(preview.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("cfg-create-mapping-profile: an already active profile for the same institution and format is refused, not superseded", async () => {
  const db = baseDb();
  await createAndApply(db, scopeFor());
  // A different account at the same institution and format: the partial
  // unique index is keyed by (institution, format), not account number, so
  // this collides even though the account differs.
  const preview = await execute(db, cfgCreateMappingProfile, scopeFor({ accountNumber: "1020" }), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_MAPPING_PROFILE_ALREADY_ACTIVE), "named error code");
  const secondId = newMappingProfileIdFor(CLIENT_A1, "First National", "1020", "csv");
  assertEqual(
    (db.all("mapping_profiles") as unknown as MappingProfileRow[]).find((p) => p.id === secondId),
    undefined,
    "nothing was created, the existing active profile was not superseded",
  );
});

test("cfg-create-mapping-profile: a bank account not on the client is refused", async () => {
  const db = baseDb();
  const preview = await execute(db, cfgCreateMappingProfile, scopeFor({ accountNumber: "9999" }), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_MAPPING_PROFILE_UNKNOWN_ACCOUNT), "named error code");
});

test("cfg-create-mapping-profile: undo does nothing, every proposal here is an insert", async () => {
  const db = baseDb();
  const { applied } = await createAndApply(db, scopeFor());
  const undone = await executeUndo(db, cfgCreateMappingProfile, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "no_op", "nothing to revert");
  const id = newMappingProfileIdFor(CLIENT_A1, "First National", "1010", "csv");
  assert(
    (db.all("mapping_profiles") as unknown as MappingProfileRow[]).some((p) => p.id === id),
    "the profile created by the insert is still there",
  );
});
