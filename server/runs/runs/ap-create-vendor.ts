/**
 * AP-CREATE-VENDOR. Add a payable counterparty to a client's books.
 *
 * Not one of doc 02's documented module 5 runs, for the same reason
 * AR-CREATE-CUSTOMER is not: migration 0005 built subledger.vendors and
 * migration 0014 built the payable subledger on top of it assuming a vendor
 * already existed by the time AP-APPLY-DISCOUNTS or ARAP-REFRESH-AGING ever
 * read one. Nothing in the original run set puts the first vendor on the
 * books. This run does, in the one shape every later module 5 payable run
 * already expects: a plain subledger.vendors row, nothing posted.
 *
 * The normalized name and its version come from the same normalizeVendor
 * function TXN-NORMALIZE-VENDORS stamps onto a coded transaction, so a vendor
 * created here and a bank descriptor coded later land on the same
 * normalized_name the moment both exist, with no second normalizer to drift
 * out of step with the first.
 *
 * 1099 fields (entityType, w9OnFile, w9ExpiresOn, tinLast4) default to the
 * honest unknown state, and every one is a real input: a firm onboarding a
 * vendor it already has a signed W-9 for should be able to say so on day
 * one rather than edit the row by hand afterward, since tax-shared.ts reads
 * every one of them (isExcludedEntity, the W-9 status TAX-TRACK-W9 reports,
 * TAX-BUILD-1099's own eligibility check) and nothing else in this engine
 * ever sets them. Nothing here compiles a 1099 or decides reportability;
 * that is TAX-BUILD-1099's job, reading whatever this run or a later edit
 * leaves on the row.
 *
 * Manual tier: naming a new vendor is a decision a person makes once, on
 * purpose, and a clock has no vendor of its own to discover.
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
  type Ulid,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";
import type { VendorRow } from "../tables";
import { normalizeVendor, VENDOR_NORMALIZATION_VERSION } from "./txn-normalize-vendors";

const ENTITY_TYPES = [
  "individual",
  "sole_proprietor",
  "partnership",
  "llc",
  "c_corporation",
  "s_corporation",
  "government",
  "tax_exempt",
  "unknown",
] as const;

export const createVendorScopeSchema = z.object({
  clientId: z.string().min(1),
  legalName: z.string().min(1),
  earlyDiscountRule: z
    .enum(["purchase_discount_income", "vendor_credit"])
    .nullable()
    .default(null),
  tinLast4: z
    .string()
    .regex(/^[0-9]{4}$/)
    .nullable()
    .default(null),
  /** What the payee is, per migration 0017. The honest default excludes nobody. */
  entityType: z.enum(ENTITY_TYPES).default("unknown"),
  w9OnFile: z.boolean().default(false),
  /** Meaningless unless w9OnFile is true; stored as given either way. */
  w9ExpiresOn: z.string().min(10).nullable().default(null),
});

export type CreateVendorScope = z.infer<typeof createVendorScopeSchema>;

/** Stable id. Same client and legal name give the same vendor every time. */
export function vendorIdFor(clientId: Ulid, legalName: string): Ulid {
  return derivedId(`${clientId}:${legalName}`, "ap-create-vendor", 0);
}

export const apCreateVendor: Run<CreateVendorScope, Proposal> = {
  type: "AP-CREATE-VENDOR",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:ap-create-vendor:${scope.legalName}`,
  scopeSchema: createVendorScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateVendorScope>> {
    const vendorId = vendorIdFor(scope.clientId, scope.legalName);
    const candidateIds = [vendorId];
    // subledger.vendors carries no version column (migration 0005), unlike
    // subledger.customers, so there is nothing of another vendor's state to
    // fold into the hash here.
    const versions = [{ id: "AP-CREATE-VENDOR", version: 1 }];
    const runDay = ctx.now.toISOString().slice(0, 10);
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      // Adding a vendor has no accounting period of its own.
      periodStart: runDay,
      periodEnd: runDay,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const vendorId = vendorIdFor(frozen.clientId, scope.legalName);
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const existing = await tx.query("vendors_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (existing.some((v) => v.id === vendorId)) {
      skips.push({
        rowId: vendorId,
        reason: "already_applied",
        detail: `a vendor named ${scope.legalName} already exists for this client`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const normalized = normalizeVendor(scope.legalName);
    const row: VendorRow = {
      id: vendorId,
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      legalName: scope.legalName,
      normalizedName: normalized.value,
      normalizerVersion: VENDOR_NORMALIZATION_VERSION,
      aliases: [],
      defaultCategoryId: null,
      defaultCategoryVersion: null,
      isActive: true,
      earlyDiscountRule: scope.earlyDiscountRule,
      w9OnFile: scope.w9OnFile,
      w9ExpiresOn: scope.w9ExpiresOn,
      entityType: scope.entityType,
      paymentHold: false,
      tinLast4: scope.tinLast4,
    };

    const proposal: ProposedRowInsert = {
      kind: "row_insert",
      table: "vendors",
      rowId: vendorId,
      row: row as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [proposal], skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "AP-CREATE-VENDOR",
      runVersion: 1,
    });
  },

  /**
   * No undo. A vendor with bills against it cannot be un-created, and one
   * with none is harmless to leave; doc 03 Part 6's undo contract covers
   * reverting a run's effects, not deleting a party.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
