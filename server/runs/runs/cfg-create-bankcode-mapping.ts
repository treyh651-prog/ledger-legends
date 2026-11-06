/**
 * CFG-CREATE-BANKCODE-MAPPING, version 1.
 *
 * Audit fix, 2026-11-06 (problem 7, one of seven missing setup-data
 * creators). ledger.bank_code_mappings has carried its full shape since
 * early in this engagement, and TXN-MAP-BANKCODES has always been able to
 * read a mapping that exists -- but apply-writer.ts had no insert case for
 * the table, so this run's own policy.ts reason ("maps the bank's own
 * category code through a table the firm maintains") described a table
 * nothing could ever write to. Every bank code fell through to suspense
 * (SUS-03 or further) forever, on every client, regardless of how
 * repetitive the bank's own coding turned out to be.
 *
 * Bulk, like SETUP-IMPORT-BALANCES's own lines: a firm maintaining this
 * table is adding several codes at once far more often than one, since a
 * bank or card issuer's own code list rarely arrives one entry at a time.
 *
 * TXN-MAP-BANKCODES's own lookup is exact institution id plus exact bank
 * code first, falling back to the "*" wildcard only when no institution
 * specific mapping exists -- so (institutionId, bankCode) is the natural
 * key per client, and a mapping that already exists for that pair is
 * reported rather than silently duplicated.
 *
 * categoryId is checked against the client's real categories, the same
 * reasoning every other CFG-CREATE-* run in this file gives for its own
 * foreign key fields.
 *
 * Manual tier: deciding what a bank's own code means on this client's
 * books is a judgment a person makes, the same reasoning CFG-CREATE-RULE
 * gives for its own category mapping.
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
  type Skip,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";
import { categoryIndex } from "./coding-cascade";

const newMappingFieldsSchema = z.object({
  institutionId: z.string().min(1),
  bankCode: z.string().min(1),
  categoryId: z.string().min(1),
  isActive: z.boolean().default(true),
});

export const createBankCodeMappingScopeSchema = z.object({
  clientId: z.string().min(1),
  mappings: z.array(newMappingFieldsSchema).min(1),
});

export type CreateBankCodeMappingScope = z.infer<typeof createBankCodeMappingScopeSchema>;

export const ERR_BANKCODE_UNKNOWN_CATEGORY = "CFG-BANKCODE-UNKNOWN-CATEGORY";

export function bankCodeMappingIdFor(clientId: string, institutionId: string, bankCode: string): string {
  return derivedId(`${clientId}:${institutionId}:${bankCode}`, "cfg-create-bankcode-mapping", 0);
}

export const cfgCreateBankcodeMapping: Run<CreateBankCodeMappingScope, Proposal> = {
  type: "CFG-CREATE-BANKCODE-MAPPING",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:bankcode-mapping`,
  scopeSchema: createBankCodeMappingScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateBankCodeMappingScope>> {
    const candidateIds = scope.mappings.map((m) =>
      bankCodeMappingIdFor(scope.clientId, m.institutionId, m.bankCode),
    );
    const versions = [{ id: "CFG-CREATE-BANKCODE-MAPPING", version: 1 }];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const skips: Skip[] = [];
    const proposals: Proposal[] = [];

    const existing = await tx.query("bank_code_mappings_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const existingIds = new Set(existing.map((m) => m.id));
    const categories = await tx.query("categories_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const index = categoryIndex(categories);

    for (const m of scope.mappings) {
      const id = bankCodeMappingIdFor(scope.clientId, m.institutionId, m.bankCode);
      if (existingIds.has(id)) {
        skips.push({
          rowId: id,
          reason: "already_applied",
          detail: `institution ${m.institutionId} already maps bank code ${m.bankCode}`,
        });
        continue;
      }
      if (!index.has(m.categoryId)) {
        errors.push({
          rowId: id,
          code: ERR_BANKCODE_UNKNOWN_CATEGORY,
          message: `category ${m.categoryId} does not belong to client ${scope.clientId}`,
          retryable: false,
        });
        continue;
      }
      proposals.push({
        kind: "row_insert",
        table: "bank_code_mappings",
        rowId: id,
        row: {
          firmId: ctx.firmId,
          clientId: scope.clientId,
          institutionId: m.institutionId,
          bankCode: m.bankCode,
          categoryId: m.categoryId,
          isActive: m.isActive,
        },
        provenance: { cascadeLevel: null },
      });
    }

    if (errors.length > 0) return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    return makeResult<Proposal>(1, proposals, skips, [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-BANKCODE-MAPPING", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
