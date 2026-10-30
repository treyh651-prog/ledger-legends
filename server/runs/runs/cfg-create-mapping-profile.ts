/**
 * CFG-CREATE-MAPPING-PROFILE, version 1.
 *
 * A person at the firm maps a bank or card statement format the first time
 * -- the very first profile for this client's (institution, file format)
 * family. Manual tier, same reasoning as CFG-EDIT-MAPPING-PROFILE: which
 * column means what is a judgment a person makes on purpose.
 *
 * id is a derived id from the client, institution, account, and file
 * format (same idiom AP-CREATE-VENDOR/AR-CREATE-CUSTOMER/
 * SETUP-ADD-BANK-ACCOUNT already use for a natural-key row minted for the
 * first time). supersedingProfileIdFor in CFG-EDIT-MAPPING-PROFILE derives
 * from an *old id*, which does not exist yet here.
 *
 * If a profile is already active for this (institution, file format)
 * family, this run refuses rather than superseding it. Superseding an
 * active profile is a deliberate correction with a change note -- that is
 * CFG-EDIT-MAPPING-PROFILE's job, not an implicit side effect of creating
 * what was asked to be the first one.
 *
 * accountNumber is checked against the client's real bank/card accounts
 * (not the chart -- a mapping profile's account number identifies which
 * bank account a statement is for, same field doc-record-upload.ts's own
 * bankAccountId link validates), a check CFG-EDIT-MAPPING-PROFILE does not
 * have. Not retrofitting the edit run in this pass.
 *
 * import.mapping_profile_versions gets this profile's version 1 row
 * directly, no backfill branch: this run is always the first and only
 * writer of the row it creates.
 *
 * headerFingerprint is never accepted from the caller: IMPORT-PARSE-FEED
 * computes it with headerFingerprintOf (sha256 over the trimmed, upper
 * cased header cells) and refuses a file whose header does not match
 * exactly, so the value this run stores has to come from that same
 * function or a profile could be created that no real import would ever
 * match. The caller sends the raw header cells instead, the same array a
 * real parse would read.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
} from "../contract";
import { ACTOR_PLACEHOLDER, NOW_PLACEHOLDER, applyProposals, requireTx } from "../apply-writer";
import { canonicalJson, derivedId, scopeHashFor } from "../ids";
import { headerFingerprintOf } from "./import-parse-feed";
import type { MappingProfileRow } from "../tables";

export const newMappingProfileFieldsSchema = z.object({
  institutionName: z.string().min(1),
  accountNumber: z.string().regex(/^[0-9]{4}$/),
  fileFormat: z.enum(["csv", "xlsx"]),
  /** The exact header cells as read from a real file; the fingerprint is derived from these, never trusted pre-computed from the caller. */
  headerCells: z.array(z.string().min(1)).min(1),
  headerRowNumber: z.number().int().min(1).default(1),
  skipRows: z.number().int().min(0).default(0),
  dateColumn: z.string().min(1),
  dateFormat: z.string().min(1),
  descriptionColumn: z.string().min(1),
  amountColumn: z.string().min(1).nullable().default(null),
  debitColumn: z.string().min(1).nullable().default(null),
  creditColumn: z.string().min(1).nullable().default(null),
  signConvention: z.enum(["debit_positive", "credit_positive", "separate_columns"]),
  currency: z.string().length(3).default("USD"),
  bankIdColumn: z.string().min(1).nullable().default(null),
  checkNumberColumn: z.string().min(1).nullable().default(null),
  bankCodeColumn: z.string().min(1).nullable().default(null),
  isActive: z.boolean().default(true),
});

export const createMappingProfileScopeSchema = z.object({
  clientId: z.string().min(1),
  changeNote: z.string().min(1),
  fields: newMappingProfileFieldsSchema,
});

export type CreateMappingProfileScope = z.infer<typeof createMappingProfileScopeSchema>;

export const ERR_MAPPING_PROFILE_UNKNOWN_ACCOUNT = "CFG-MAPPING-PROFILE-UNKNOWN-ACCOUNT";
export const ERR_MAPPING_PROFILE_ALREADY_ACTIVE = "CFG-MAPPING-PROFILE-ALREADY-ACTIVE";
export const ERR_MAPPING_PROFILE_UNKNOWN_COLUMN = "CFG-MAPPING-PROFILE-UNKNOWN-COLUMN";

export function newMappingProfileIdFor(
  clientId: string,
  institutionName: string,
  accountNumber: string,
  fileFormat: string,
): string {
  return derivedId(`${clientId}:${institutionName}:${accountNumber}:${fileFormat}`, "cfg-create-mapping-profile", 0);
}

export const cfgCreateMappingProfile: Run<CreateMappingProfileScope, Proposal> = {
  type: "CFG-CREATE-MAPPING-PROFILE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:mapping-profile:${scope.fields.institutionName}:${scope.fields.fileFormat}`,
  scopeSchema: createMappingProfileScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateMappingProfileScope>> {
    const id = newMappingProfileIdFor(
      scope.clientId,
      scope.fields.institutionName,
      scope.fields.accountNumber,
      scope.fields.fileFormat,
    );
    const candidateIds = [id];
    const versions = [{ id: "CFG-CREATE-MAPPING-PROFILE", version: 1 }];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions, period: canonicalJson(scope.fields) }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const id = newMappingProfileIdFor(
      scope.clientId,
      scope.fields.institutionName,
      scope.fields.accountNumber,
      scope.fields.fileFormat,
    );

    const existing = await tx.query("mapping_profile_by_id", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      mappingProfileId: id,
    });
    if (existing.length > 0) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: id, reason: "already_applied", detail: "this institution, account, and format already has a profile" }],
        [],
        BigInt(0),
      );
    }

    const active = await tx.query("active_mapping_profile", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      institutionName: scope.fields.institutionName,
      fileFormat: scope.fields.fileFormat,
    });
    if (active.length > 0) {
      errors.push({
        rowId: id,
        code: ERR_MAPPING_PROFILE_ALREADY_ACTIVE,
        message: `an active profile already exists for ${scope.fields.institutionName} ${scope.fields.fileFormat}; edit it with CFG-EDIT-MAPPING-PROFILE instead`,
        retryable: false,
      });
    }

    const bankAccounts = await tx.query("bank_accounts_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    if (!bankAccounts.some((a) => a.accountNumber === scope.fields.accountNumber)) {
      errors.push({
        rowId: id,
        code: ERR_MAPPING_PROFILE_UNKNOWN_ACCOUNT,
        message: `account ${scope.fields.accountNumber} is not on client ${scope.clientId}'s bank accounts`,
        retryable: false,
      });
    }

    const headerSet = new Set(scope.fields.headerCells.map((h) => h.trim().toUpperCase()));
    const namedColumns = [
      scope.fields.dateColumn,
      scope.fields.descriptionColumn,
      scope.fields.amountColumn,
      scope.fields.debitColumn,
      scope.fields.creditColumn,
      scope.fields.bankIdColumn,
      scope.fields.checkNumberColumn,
      scope.fields.bankCodeColumn,
    ].filter((c): c is string => c !== null);
    for (const column of namedColumns) {
      if (!headerSet.has(column.trim().toUpperCase())) {
        errors.push({
          rowId: id,
          code: ERR_MAPPING_PROFILE_UNKNOWN_COLUMN,
          message: `column "${column}" is not in the pasted header`,
          retryable: false,
        });
      }
    }
    if (errors.length > 0) return makeResult<Proposal>(1, [], [], errors, BigInt(0));

    const row: MappingProfileRow = {
      id,
      firmId: ctx.firmId,
      clientId: scope.clientId,
      version: 1,
      institutionName: scope.fields.institutionName,
      accountNumber: scope.fields.accountNumber,
      fileFormat: scope.fields.fileFormat,
      headerFingerprint: headerFingerprintOf(scope.fields.headerCells),
      headerRowNumber: scope.fields.headerRowNumber,
      skipRows: scope.fields.skipRows,
      dateColumn: scope.fields.dateColumn,
      dateFormat: scope.fields.dateFormat,
      descriptionColumn: scope.fields.descriptionColumn,
      amountColumn: scope.fields.amountColumn,
      debitColumn: scope.fields.debitColumn,
      creditColumn: scope.fields.creditColumn,
      signConvention: scope.fields.signConvention,
      currency: scope.fields.currency,
      bankIdColumn: scope.fields.bankIdColumn,
      checkNumberColumn: scope.fields.checkNumberColumn,
      bankCodeColumn: scope.fields.bankCodeColumn,
      isActive: scope.fields.isActive,
      createdBy: ACTOR_PLACEHOLDER,
    };
    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "mapping_profiles",
      rowId: id,
      row: row as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };
    const historyInsert: ProposedRowInsert = {
      kind: "row_insert",
      table: "mapping_profile_versions",
      rowId: `${id}:1`,
      row: {
        profileId: id,
        version: 1,
        clientId: scope.clientId,
        firmId: ctx.firmId,
        snapshot: row,
        validFrom: NOW_PLACEHOLDER,
        validTo: null,
        changedBy: ACTOR_PLACEHOLDER,
        changeNote: scope.changeNote,
      },
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [insert, historyInsert], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-MAPPING-PROFILE", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
