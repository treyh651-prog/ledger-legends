/**
 * CFG-CREATE-FIXED-ASSET, version 1.
 *
 * Audit fix, 2026-11-06 (problem 7, one of seven missing setup-data
 * creators). subledger.fixed_assets has carried its full doc 04 Part 4
 * shape since migration 0005, and PER-POST-DEPRECIATION/PER-DISPOSE-ASSET
 * have always been able to read and act on a row that exists -- but
 * apply-writer.ts had no insert case for the table at all, confirmed by
 * grepping the whole file. A client with real equipment, vehicles, or
 * leasehold improvements had no way to put a single one on the books.
 *
 * costAccount/accumAccount/expenseAccount are each checked against the
 * client's real chart, the same "don't inherit a typo that points nowhere"
 * reasoning CFG-CREATE-CATEGORY gives for its own accountNumber check.
 *
 * depreciable_base_cents is a generated column (migration 0005: cost minus
 * salvage, stored). This run computes the identical value for the in-memory
 * test double's benefit -- there is no second copy of the arithmetic to
 * drift, db-postgres.ts's insert() silently drops the column from the
 * actual statement it sends, so Postgres computes its own copy and the two
 * never disagree.
 *
 * The id is derived from the client and the full field set, the same
 * content-addressed idiom CFG-CREATE-RULE uses: there is no natural key on
 * an asset (two identical typewriters bought the same day are two assets),
 * so this only guards against the exact same create submitted twice, not
 * against two different real assets that happen to share every field.
 *
 * Manual tier: naming an asset, its cost, and how it depreciates is a
 * judgment a person makes once, the same reasoning every other CFG-CREATE-*
 * run in this file gives.
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
import { applyProposals, requireTx } from "../apply-writer";
import { canonicalJson, derivedId, scopeHashFor } from "../ids";

export const newFixedAssetFieldsSchema = z.object({
  tag: z.string().min(1).nullable().default(null),
  description: z.string().min(1),
  assetClass: z.string().min(1),
  costAccount: z.string().regex(/^[0-9]{4}$/),
  accumAccount: z.string().regex(/^[0-9]{4}$/),
  expenseAccount: z.string().regex(/^[0-9]{4}$/),
  acquiredOn: z.string().min(10),
  placedInServiceOn: z.string().min(10),
  // Plain numbers, not z.bigint() -- the scope arrives as parsed JSON over
  // HTTP, same wire-safe convention every other dollar field in this file
  // follows. Cast to Cents below.
  costCents: z.number().int().positive().safe(),
  salvageCents: z.number().int().nonnegative().safe().default(0),
  method: z.enum(["straight_line", "ddb", "ddb_150", "macrs", "sum_of_years", "units_of_production", "none"]),
  lifeMonths: z.number().int().positive().nullable().default(null),
  ddbFactorBps: z.number().int().positive().nullable().default(null),
  macrsRecoveryYears: z.number().int().positive().nullable().default(null),
  unitsTotal: z.number().int().positive().nullable().default(null),
  convention: z.enum(["full_month", "mid_month", "mid_quarter", "mid_year", "actual_days"]),
  halfMonthConvention: z.boolean().default(false),
});

export const createFixedAssetScopeSchema = z.object({
  clientId: z.string().min(1),
  fields: newFixedAssetFieldsSchema,
});

export type CreateFixedAssetScope = z.infer<typeof createFixedAssetScopeSchema>;

export const ERR_ASSET_UNKNOWN_ACCOUNT = "CFG-ASSET-UNKNOWN-ACCOUNT";
export const ERR_ASSET_SALVAGE_EXCEEDS_COST = "CFG-ASSET-SALVAGE-EXCEEDS-COST";

export function fixedAssetIdFor(clientId: string, fields: z.infer<typeof newFixedAssetFieldsSchema>): string {
  return derivedId(`${clientId}:${canonicalJson(fields)}`, "cfg-create-fixed-asset", 0);
}

export const cfgCreateFixedAsset: Run<CreateFixedAssetScope, Proposal> = {
  type: "CFG-CREATE-FIXED-ASSET",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:fixed-asset:${fixedAssetIdFor(scope.clientId, scope.fields)}`,
  scopeSchema: createFixedAssetScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateFixedAssetScope>> {
    const candidateIds = [fixedAssetIdFor(scope.clientId, scope.fields)];
    const versions = [{ id: "CFG-CREATE-FIXED-ASSET", version: 1 }];
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
    const id = fixedAssetIdFor(scope.clientId, scope.fields);

    const existing = await tx.query("fixed_assets_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    if (existing.some((a) => a.id === id)) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: id, reason: "already_applied", detail: "an identical asset has already been created for this client" }],
        [],
        BigInt(0),
      );
    }

    const chart = await tx.query("chart_accounts_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const knownNumbers = new Set(chart.map((a) => a.accountNumber));
    for (const [label, number] of [
      ["cost", scope.fields.costAccount],
      ["accumulated depreciation", scope.fields.accumAccount],
      ["depreciation expense", scope.fields.expenseAccount],
    ] as const) {
      if (!knownNumbers.has(number)) {
        errors.push({
          rowId: id,
          code: ERR_ASSET_UNKNOWN_ACCOUNT,
          message: `${label} account ${number} is not on client ${scope.clientId}'s chart`,
          retryable: false,
        });
      }
    }
    if (errors.length > 0) return makeResult<Proposal>(1, [], [], errors, BigInt(0));

    const costCents = BigInt(scope.fields.costCents);
    const salvageCents = BigInt(scope.fields.salvageCents);
    if (salvageCents > costCents) {
      errors.push({
        rowId: id,
        code: ERR_ASSET_SALVAGE_EXCEEDS_COST,
        message: `salvage of ${salvageCents.toString()} cents exceeds cost of ${costCents.toString()} cents`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const row: Record<string, unknown> = {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      tag: scope.fields.tag,
      description: scope.fields.description,
      assetClass: scope.fields.assetClass,
      costAccount: scope.fields.costAccount,
      accumAccount: scope.fields.accumAccount,
      expenseAccount: scope.fields.expenseAccount,
      acquiredOn: scope.fields.acquiredOn,
      placedInServiceOn: scope.fields.placedInServiceOn,
      costCents,
      salvageCents,
      // Generated in the database (migration 0005); db-postgres.ts's insert()
      // drops this key from the real statement, so this value only ever
      // matters to the in-memory test double. See this file's own header.
      depreciableBaseCents: costCents - salvageCents,
      method: scope.fields.method,
      lifeMonths: scope.fields.lifeMonths,
      ddbFactorBps: scope.fields.ddbFactorBps,
      macrsRecoveryYears: scope.fields.macrsRecoveryYears,
      unitsTotal: scope.fields.unitsTotal,
      convention: scope.fields.convention,
      halfMonthConvention: scope.fields.halfMonthConvention,
      status: "active",
      disposedOn: null,
      disposalEntryId: null,
      disposalProceedsCents: null,
      manualOverride: false,
      version: 1,
    };

    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "fixed_assets",
      rowId: id,
      row,
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [insert], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-FIXED-ASSET", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    // An insert of a row with no prior value; inserts never revert in this
    // framework (same reasoning CFG-CREATE-CATEGORY's own undoPlan gives).
    return [];
  },
};
