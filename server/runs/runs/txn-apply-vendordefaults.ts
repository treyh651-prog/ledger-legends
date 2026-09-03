/**
 * TXN-APPLY-VENDORDEFAULTS. Level 7, the vendor master default category.
 *
 * Spec: docs/02-run-specifications.md Module 2 TXN-APPLY-VENDORDEFAULTS, vendor
 * shape from docs/04-reference-data.md Part 5.
 *
 * This step only runs when nothing above it decided the row. A duplicate, a
 * paired transfer, a settlement, a template, and a rule all outrank a vendor
 * default, and each of those is reported as already resolved rather than
 * recoded. The lookup itself is the narrowest in the cascade: exact key equality
 * between the transaction normalized vendor and the vendor master normalized key.
 * No aliases fuzzed into the comparison, no prefixes, no similarity. A vendor
 * default is a standing instruction about one name and it applies to that name.
 *
 * Exactly one active vendor with a default category means the coding applies at
 * level 7. More than one means SUS-19, because two standing instructions for the
 * same name is a data problem and picking one hides it.
 *
 * Then the shared attribute checks of doc 02 steps 5 through 8.
 *
 * Part D. This run never auto posts under any configuration. A vendor default is
 * weaker evidence than a promoted rule and it has no acceptance history behind
 * it, so there is nothing that could earn it the right to post on its own.
 */

import {
  makeResult,
  isFieldWrite,
  isRowInsert,
  type FrozenScope,
  type Proposal,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { isLockedDay } from "../dates";
import { revertFieldWrite } from "../undo";
import type { VendorRow } from "../tables";
import {
  LEVEL,
  alreadyResolvedSkip,
  foreignCurrencySkip,
  categoryChecks,
  categoryIndex,
  codingScopeSchema,
  codingWrite,
  freezeCodingScope,
  iterationOrder,
  overrideSkips,
  policyOf,
  resolvedLevel,
  suspenseProposal,
  type CodingScope,
} from "./coding-cascade";
import { exceptionInsert } from "./txn-apply-rules";

/** Doc 02 Part D. Never eligible for auto post under any configuration. */
export const VENDORDEFAULTS_AUTO_POST_ELIGIBLE = false;
export const SUS_VENDOR_CONFLICT = "SUS-19";

export const txnApplyVendorDefaults: Run<CodingScope, Proposal> = {
  type: "TXN-APPLY-VENDORDEFAULTS",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => scope.clientId,
  scopeSchema: codingScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CodingScope>> {
    const tx = requireTx(ctx);
    const vendors = await tx.query("vendors_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    return freezeCodingScope(scope, ctx, "TXN-APPLY-VENDORDEFAULTS", 1, [
      ...vendors.map((v) => ({ id: v.id, version: v.normalizerVersion })),
    ]);
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const proposals: Proposal[] = [];
    const skips: Skip[] = overrideSkips(frozen.overriddenIds);
    const errors: RunError[] = [];

    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const categories = categoryIndex(
      await tx.query("categories_for_client", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
      }),
    );
    const policy = policyOf(
      await tx.query("client_policy", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
      }),
    );
    const vendors = await tx.query("vendors_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const candidates = await tx.query("transactions_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: scope.from,
      to: scope.to,
      bankAccountIds: scope.bankAccountIds,
      includeOverridden: false,
    });
    const documents = await tx.query("document_links_for_transactions", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      transactionIds: candidates.map((t) => t.id),
    });
    const documented = new Set<Ulid>(documents.map((d) => d.transactionId));

    // Exact key equality, one bucket per normalized name.
    const byKey = new Map<string, VendorRow[]>();
    for (const v of vendors) {
      if (!v.isActive) continue;
      if (v.defaultCategoryId === null) continue;
      const bucket = byKey.get(v.normalizedName);
      if (bucket) bucket.push(v);
      else byKey.set(v.normalizedName, [v]);
    }

    let ordinal = 0;
    for (const t of candidates.slice().sort(iterationOrder)) {
      if (isLockedDay(locks, t.postedDate)) {
        skips.push({
          rowId: t.id,
          reason: "locked_period",
          detail: `posted ${t.postedDate} falls inside a locked period`,
        });
        continue;
      }
      const level = resolvedLevel(t);
      if (level !== null && level < LEVEL.vendorDefault) {
        skips.push(alreadyResolvedSkip(t, level));
        continue;
      }
      const currencySkip = foreignCurrencySkip(t, policy.functionalCurrency);
      if (currencySkip !== null) {
        skips.push(currencySkip);
        continue;
      }
      if (t.normalizedVendor === null) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: "vendor is not normalized yet, TXN-NORMALIZE-VENDORS runs first",
        });
        continue;
      }

      const hits = (byKey.get(t.normalizedVendor) ?? [])
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (hits.length === 0) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: "no_vendor_default",
        });
        continue;
      }
      if (hits.length > 1) {
        proposals.push(
          suspenseProposal({
            transactionId: t.id,
            reasonCode: SUS_VENDOR_CONFLICT,
            detail: `more than one active vendor default on key ${t.normalizedVendor}, every match: ${hits.map((h) => h.id).join(",")}`,
            relatedIds: hits.map((h) => h.id),
          }),
        );
        continue;
      }

      const vendor = hits[0];
      const categoryId = vendor.defaultCategoryId as string;
      const category = categories.get(categoryId);
      if (!category) {
        errors.push({
          rowId: t.id,
          code: "MISSING_ACCOUNT",
          message: `vendor ${vendor.id} defaults to category ${categoryId} which is not on this client`,
          retryable: false,
        });
        continue;
      }
      if (!category.isActive) {
        proposals.push(
          suspenseProposal({
            transactionId: t.id,
            reasonCode: "SUS-03",
            detail: `vendor ${vendor.id} defaults to inactive category ${category.id}`,
            relatedIds: [vendor.id],
          }),
        );
        continue;
      }

      const outcome = categoryChecks(t, category, {
        hasDocument: documented.has(t.id),
        policyCapitalizeOverCents: policy.capitalizeOverCents,
      });
      if (outcome.block) {
        proposals.push(
          suspenseProposal({
            transactionId: t.id,
            reasonCode: outcome.block.reasonCode,
            detail: `${outcome.block.detail}, vendor default ${vendor.id}`,
            relatedIds: [vendor.id],
          }),
        );
        continue;
      }

      proposals.push(
        codingWrite({
          t,
          categoryId: category.id,
          categoryVersion: vendor.defaultCategoryVersion ?? category.version,
          cascadeLevel: LEVEL.vendorDefault,
          vendorId: vendor.id,
        }),
      );

      for (const ex of outcome.exceptions) {
        ordinal += 1;
        proposals.push(exceptionInsert(t, category.id, ex.kind, ex.detail, ordinal));
        if (ex.reasonCode !== null) {
          proposals.push(
            suspenseProposal({
              transactionId: t.id,
              reasonCode: ex.reasonCode,
              detail: ex.detail,
              relatedIds: [vendor.id],
            }),
          );
        }
      }
    }

    return makeResult<Proposal>(
      frozen.candidateIds.length,
      proposals,
      skips,
      errors,
      BigInt(0),
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "TXN-APPLY-VENDORDEFAULTS",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
      if (isRowInsert(p)) continue;
    }
    return plan;
  },
};
