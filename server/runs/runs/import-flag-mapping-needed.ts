/**
 * IMPORT-FLAG-MAPPING-NEEDED. Tell a bookkeeper a statement could not be read.
 *
 * Not one of doc 05's documented runs, for the reason most of the runs added
 * after doc 02 and doc 05 share: IMPORT-PARSE-FEED has refused a csv or xlsx
 * file with no active mapping profile, or with a header that does not match
 * the one on file, since the day it was written, and nothing in the original
 * set ever wrote that refusal down anywhere a person would see it. The upload
 * route calls this run when that happens, and calls it again, resolved true,
 * the next time a parse for the same account gets past the header check. See
 * NOTES.md on IMPORT-PARSE-FEED for the two failures this exists to surface.
 *
 * One row per bank account, by design. A second failure on an account that
 * already has an open exception reopens the same row with the newer error
 * rather than inserting a second one, so a bookkeeper is never asked to map
 * the same account twice. A resolve with no open row to close is a no op, not
 * an error: the account may already have been fixed by hand, or the resolve
 * may simply have arrived twice.
 *
 * Posting: none. writesLedger is false and no open period is required. This
 * run records a fact about a file, not about the client's books.
 */

import { z } from "zod";
import {
  isFieldWrite,
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedRowInsert,
  type Run,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import {
  applyProposals,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  requireTx,
} from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { MappingExceptionRow } from "../tables";

export const flagMappingNeededScopeSchema = z.object({
  clientId: z.string().min(1),
  bankAccountId: z.string().min(1),
  sourceDocumentId: z.string().nullable().default(null),
  institutionName: z.string().min(1),
  sourceFormat: z.string().min(1),
  errorCode: z.string().min(1),
  errorMessage: z.string().min(1),
  /** False opens or reopens the exception. True resolves the open one, if any. */
  resolved: z.boolean().default(false),
});

export type FlagMappingNeededScope = z.infer<typeof flagMappingNeededScopeSchema>;

/** Stable id. One row per client and bank account, reused across its lifecycle. */
export function mappingExceptionIdFor(clientId: Ulid, bankAccountId: Ulid): Ulid {
  return derivedId(`${clientId}:${bankAccountId}`, "import-flag-mapping-needed", 0);
}

export const importFlagMappingNeeded: Run<FlagMappingNeededScope, Proposal> = {
  type: "IMPORT-FLAG-MAPPING-NEEDED",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:import-flag-mapping-needed:${scope.bankAccountId}`,
  scopeSchema: flagMappingNeededScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<FlagMappingNeededScope>> {
    const tx = requireTx(ctx);
    const rowId = mappingExceptionIdFor(scope.clientId, scope.bankAccountId);
    const existing = await tx.query("mapping_exception_for_account", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      bankAccountId: scope.bankAccountId,
    });
    const candidateIds = [rowId];
    const versions = [
      { id: "IMPORT-FLAG-MAPPING-NEEDED", version: 1 },
      ...existing.map((r) => ({ id: r.id, version: r.version })),
    ];
    const runDay = ctx.now.toISOString().slice(0, 10);
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: runDay,
      periodEnd: runDay,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions, period: scope.errorCode }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const rowId = mappingExceptionIdFor(frozen.clientId, scope.bankAccountId);
    const skips: Skip[] = [];

    const existing = await tx.query("mapping_exception_for_account", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      bankAccountId: scope.bankAccountId,
    });
    const prior = existing.length > 0 ? existing[0] : null;

    if (scope.resolved) {
      if (prior === null || prior.status !== "open") {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `no open mapping exception for account ${scope.bankAccountId}`,
        });
        return makeResult<Proposal>(1, [], skips, [], BigInt(0));
      }
      const resolve: ProposedFieldWrite = {
        kind: "field_write",
        table: "mapping_exceptions",
        rowId,
        before: {
          status: prior.status,
          resolvedAt: prior.resolvedAt,
          resolvedByRunId: prior.resolvedByRunId,
        },
        after: {
          status: "resolved",
          resolvedAt: NOW_PLACEHOLDER,
          resolvedByRunId: RUN_ID_PLACEHOLDER,
        },
        provenance: { cascadeLevel: null },
      };
      return makeResult<Proposal>(1, [resolve], skips, [], BigInt(0));
    }

    if (prior === null) {
      const row: MappingExceptionRow = {
        id: rowId,
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        bankAccountId: scope.bankAccountId,
        sourceDocumentId: scope.sourceDocumentId,
        institutionName: scope.institutionName,
        sourceFormat: scope.sourceFormat,
        errorCode: scope.errorCode,
        errorMessage: scope.errorMessage,
        status: "open",
        openedAt: NOW_PLACEHOLDER,
        openedByRunId: RUN_ID_PLACEHOLDER,
        resolvedAt: null,
        resolvedByRunId: null,
        version: 1,
      };
      const insert: ProposedRowInsert = {
        kind: "row_insert",
        table: "mapping_exceptions",
        rowId,
        row: row as unknown as Record<string, unknown>,
        provenance: { cascadeLevel: null },
      };
      return makeResult<Proposal>(1, [insert], skips, [], BigInt(0));
    }

    if (
      prior.status === "open" &&
      prior.sourceDocumentId === scope.sourceDocumentId &&
      prior.errorCode === scope.errorCode &&
      prior.errorMessage === scope.errorMessage
    ) {
      skips.push({
        rowId,
        reason: "already_applied",
        detail: `mapping exception for account ${scope.bankAccountId} is already open with the same error`,
      });
      return makeResult<Proposal>(1, [], skips, [], BigInt(0));
    }

    // Either the account's one row was resolved and this is a fresh failure, or
    // it is still open but the next document or the next error differs. Either
    // way the same row reopens with what this attempt found, rather than a
    // second row that would ask the same question twice.
    const reopen: ProposedFieldWrite = {
      kind: "field_write",
      table: "mapping_exceptions",
      rowId,
      before: {
        sourceDocumentId: prior.sourceDocumentId,
        institutionName: prior.institutionName,
        sourceFormat: prior.sourceFormat,
        errorCode: prior.errorCode,
        errorMessage: prior.errorMessage,
        status: prior.status,
        openedAt: prior.openedAt,
        openedByRunId: prior.openedByRunId,
        resolvedAt: prior.resolvedAt,
        resolvedByRunId: prior.resolvedByRunId,
      },
      after: {
        sourceDocumentId: scope.sourceDocumentId,
        institutionName: scope.institutionName,
        sourceFormat: scope.sourceFormat,
        errorCode: scope.errorCode,
        errorMessage: scope.errorMessage,
        status: "open",
        openedAt: NOW_PLACEHOLDER,
        openedByRunId: RUN_ID_PLACEHOLDER,
        resolvedAt: null,
        resolvedByRunId: null,
      },
      provenance: { cascadeLevel: null },
    };
    return makeResult<Proposal>(1, [reopen], skips, [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "IMPORT-FLAG-MAPPING-NEEDED",
      runVersion: 1,
    });
  },

  /** Field moves revert. The row itself stands, same reasoning as the batch it reports on. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};
