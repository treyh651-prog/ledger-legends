/**
 * CFG-EDIT-MAPPING-PROFILE, version 1.
 *
 * A person at the firm corrects a column mapping profile: the bank renamed a
 * column, the date format changed, a new account uses the same institution's
 * format. Manual tier, same reasoning as CFG-EDIT-CATEGORY and CFG-EDIT-RULE:
 * which column means what is a judgment a person makes on purpose.
 *
 * Unlike a category or a rule, a profile is never edited in place.
 * MappingProfileRow's own comment says why: IMPORT-PARSE-FEED records the
 * exact profile id and version it parsed a batch under
 * (import.batches.mapping_profile_id/mapping_profile_version), so a file
 * parsed under version 2 has to stay explainable, forever, exactly as it
 * was. Editing therefore inserts a brand new row, carrying the next version
 * number for this client's (institution_name, file_format) family, and
 * deactivates the row it replaces so map_one_active_per_institution's
 * partial unique index never sees two active rows at once.
 *
 * import.mapping_profile_versions has carried the history shape since
 * migration 0009 and nothing has ever written to it. Each physical row gets
 * exactly one entry: the superseded row's own entry is backfilled here if
 * none exists yet (snapshotting it as it stood, under its own id and
 * version), and the new row gets its own entry the moment it is created.
 */

import { z } from "zod";
import {
  isFieldWrite,
  isRowInsert,
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
} from "../contract";
import {
  ACTOR_PLACEHOLDER,
  NOW_PLACEHOLDER,
  applyProposals,
  requireTx,
} from "../apply-writer";
import { canonicalJson, derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { MappingProfileRow } from "../tables";

export const editableMappingProfileFieldsSchema = z.object({
  institutionName: z.string().min(1).optional(),
  accountNumber: z.string().regex(/^[0-9]{4}$/).optional(),
  fileFormat: z.enum(["csv", "xlsx"]).optional(),
  headerFingerprint: z.string().min(1).optional(),
  headerRowNumber: z.number().int().min(1).optional(),
  skipRows: z.number().int().min(0).optional(),
  dateColumn: z.string().min(1).optional(),
  dateFormat: z.string().min(1).optional(),
  descriptionColumn: z.string().min(1).optional(),
  amountColumn: z.string().min(1).nullable().optional(),
  debitColumn: z.string().min(1).nullable().optional(),
  creditColumn: z.string().min(1).nullable().optional(),
  signConvention: z
    .enum(["debit_positive", "credit_positive", "separate_columns"])
    .optional(),
  currency: z.string().length(3).optional(),
  bankIdColumn: z.string().min(1).nullable().optional(),
  checkNumberColumn: z.string().min(1).nullable().optional(),
  bankCodeColumn: z.string().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const editMappingProfileScopeSchema = z.object({
  clientId: z.string().min(1),
  mappingProfileId: z.string().min(1),
  changeNote: z.string().min(1),
  fields: editableMappingProfileFieldsSchema,
});

export type EditMappingProfileScope = z.infer<typeof editMappingProfileScopeSchema>;

export const ERR_MAPPING_PROFILE_NOT_FOUND = "CFG-MAPPING-PROFILE-NOT-FOUND";
export const BACKFILL_CHANGE_NOTE = "initial version, backfilled on first edit";

export function supersedingProfileIdFor(oldId: string, newVersion: number): string {
  return derivedId(oldId, "cfg-edit-mapping-profile", newVersion);
}

function changedFields(
  current: MappingProfileRow,
  fields: z.infer<typeof editableMappingProfileFieldsSchema>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const key = k as keyof MappingProfileRow;
    if (current[key] !== v) {
      before[key] = current[key];
      after[key] = v;
    }
  }
  return { before, after };
}

export const cfgEditMappingProfile: Run<EditMappingProfileScope, Proposal> = {
  type: "CFG-EDIT-MAPPING-PROFILE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:mapping-profile:${scope.mappingProfileId}`,
  scopeSchema: editMappingProfileScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<EditMappingProfileScope>> {
    const tx = requireTx(ctx);
    const rows = await tx.query("mapping_profile_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      mappingProfileId: scope.mappingProfileId,
    });
    const profile = rows[0] ?? null;
    const candidateIds = [scope.mappingProfileId];
    const versions = [{ id: "CFG-EDIT-MAPPING-PROFILE", version: 1 }];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [
          profile ? String(profile.version) : "missing",
          canonicalJson(scope.fields),
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

    const rows = await tx.query("mapping_profile_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      mappingProfileId: scope.mappingProfileId,
    });
    const oldRow: MappingProfileRow | undefined = rows[0];
    if (!oldRow) {
      errors.push({
        rowId: scope.mappingProfileId,
        code: ERR_MAPPING_PROFILE_NOT_FOUND,
        message: `mapping profile ${scope.mappingProfileId} does not belong to client ${scope.clientId}`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const { after } = changedFields(oldRow, scope.fields);
    if (Object.keys(after).length === 0) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: oldRow.id, reason: "already_applied", detail: "every named field already has this value" }],
        [],
        BigInt(0),
      );
    }

    const newVersion = oldRow.version + 1;
    const newRowId = supersedingProfileIdFor(oldRow.id, newVersion);
    const { id: _oldId, ...oldRowFields } = oldRow;
    const newRowFields: Omit<MappingProfileRow, "id"> = {
      ...oldRowFields,
      ...after,
      version: newVersion,
      createdBy: ACTOR_PLACEHOLDER,
    };
    const newIsActive = newRowFields.isActive;

    const proposals: Proposal[] = [];

    // The partial unique index allows exactly one active row per institution
    // and file format. Both rows active at once is the state that violates it.
    if (oldRow.isActive && newIsActive) {
      const deactivate: ProposedFieldWrite = {
        kind: "field_write",
        table: "mapping_profiles",
        rowId: oldRow.id,
        before: { isActive: true },
        after: { isActive: false },
        provenance: { cascadeLevel: null },
      };
      proposals.push(deactivate);
    }

    const existingVersions = await tx.query("mapping_profile_versions_for_profile", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      mappingProfileId: oldRow.id,
    });
    if (existingVersions.length === 0) {
      const backfill: ProposedRowInsert = {
        kind: "row_insert",
        table: "mapping_profile_versions",
        rowId: `${oldRow.id}:${oldRow.version}`,
        row: {
          profileId: oldRow.id,
          version: oldRow.version,
          clientId: scope.clientId,
          firmId: ctx.firmId,
          snapshot: oldRow,
          validFrom: NOW_PLACEHOLDER,
          validTo: null,
          changedBy: ACTOR_PLACEHOLDER,
          changeNote: BACKFILL_CHANGE_NOTE,
        },
        provenance: { cascadeLevel: null },
      };
      proposals.push(backfill);
    }

    const insertProfile: ProposedRowInsert = {
      kind: "row_insert",
      table: "mapping_profiles",
      rowId: newRowId,
      row: newRowFields,
      provenance: { cascadeLevel: null },
    };
    proposals.push(insertProfile);

    const historyInsert: ProposedRowInsert = {
      kind: "row_insert",
      table: "mapping_profile_versions",
      rowId: `${newRowId}:${newVersion}`,
      row: {
        profileId: newRowId,
        version: newVersion,
        clientId: scope.clientId,
        firmId: ctx.firmId,
        snapshot: { ...newRowFields, id: newRowId },
        validFrom: NOW_PLACEHOLDER,
        validTo: null,
        changedBy: ACTOR_PLACEHOLDER,
        changeNote: scope.changeNote,
      },
      provenance: { cascadeLevel: null },
    };
    proposals.push(historyInsert);

    return makeResult<Proposal>(1, proposals, [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "CFG-EDIT-MAPPING-PROFILE",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    // Insert only history, same as every other audit trail here: the new
    // profile row and both version snapshots stay. What has to be undone is
    // which row is active, since that is the only in place state involved.
    const plan: Proposal[] = [];
    let newProfileRowId: string | null = null;
    let newProfileWasActive = false;
    for (const p of proposals) {
      if (isFieldWrite(p)) {
        plan.push(revertFieldWrite(p));
      } else if (isRowInsert(p) && p.table === "mapping_profiles") {
        newProfileRowId = p.rowId;
        newProfileWasActive = Boolean((p.row as Record<string, unknown>).isActive);
      }
    }
    if (newProfileRowId !== null && newProfileWasActive) {
      plan.push({
        kind: "field_write",
        table: "mapping_profiles",
        rowId: newProfileRowId,
        before: { isActive: true },
        after: { isActive: false },
        provenance: { cascadeLevel: null },
      });
    }
    return plan;
  },
};
