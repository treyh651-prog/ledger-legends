/**
 * TXN-MAP-BANKCODES. Level 8, the last chance before suspense.
 *
 * Spec: docs/02-run-specifications.md Module 2 TXN-MAP-BANKCODES.
 *
 * Banks and card issuers send a category code of their own on many feed rows.
 * It is coarse and it is not the client chart, but it is better than nothing and
 * nothing is the only alternative left at this point in the cascade. So this step
 * only runs on rows that duplicate detection, transfer pairing, settlement
 * splitting, templates, rules, and vendor defaults all declined to decide.
 *
 * The lookup: exact institution id plus exact bank code. The institution wildcard
 * is used only when no institution specific mapping exists for that code, so a
 * firm library fallback can never shadow a mapping a person wrote for one bank.
 *
 * Then the shared attribute checks of doc 02 steps 5 through 8, and an inactive
 * target category routes SUS-03 rather than coding to a category nobody uses.
 *
 * Part D. This run never posts. A bank code is the bank's opinion about its own
 * transaction and no amount of repetition turns that into the client's books.
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
import type { BankCodeMappingRow, TransactionRow } from "../tables";
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
export const BANKCODES_AUTO_POST_ELIGIBLE = false;
export const INSTITUTION_WILDCARD = "*";

/**
 * The institution the row belongs to. Migration 0011 keeps institution_id on the
 * register row itself, set by the import from the feed side identifier, so the
 * lookup reads it there and nowhere else. A null means the feed never sent one
 * and only a wildcard mapping can help.
 */
export function institutionOf(t: TransactionRow): string | null {
  return t.institutionId;
}

/**
 * Exact institution first, wildcard only when no institution specific mapping
 * exists for the code. Returning the whole surviving list rather than one row
 * lets the caller treat more than one specific mapping as a conflict instead of
 * silently taking the first.
 */
export function mappingsFor(
  mappings: readonly BankCodeMappingRow[],
  institutionId: string | null,
  bankCode: string,
): BankCodeMappingRow[] {
  const active = mappings.filter((m) => m.isActive && m.bankCode === bankCode);
  const specific =
    institutionId === null
      ? []
      : active.filter((m) => m.institutionId === institutionId);
  const chosen =
    specific.length > 0
      ? specific
      : active.filter((m) => m.institutionId === INSTITUTION_WILDCARD);
  return chosen.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const txnMapBankCodes: Run<CodingScope, Proposal> = {
  type: "TXN-MAP-BANKCODES",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => scope.clientId,
  scopeSchema: codingScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CodingScope>> {
    const tx = requireTx(ctx);
    const mappings = await tx.query("bank_code_mappings_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    return freezeCodingScope(scope, ctx, "TXN-MAP-BANKCODES", 1, [
      ...mappings.map((m) => ({ id: m.id, version: m.isActive ? 1 : 0 })),
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
    const mappings = await tx.query("bank_code_mappings_for_client", {
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
      if (level !== null && level < LEVEL.bankCode) {
        skips.push(alreadyResolvedSkip(t, level));
        continue;
      }
      const currencySkip = foreignCurrencySkip(t, policy.functionalCurrency);
      if (currencySkip !== null) {
        skips.push(currencySkip);
        continue;
      }
      if (t.bankCode === null || t.bankCode.length === 0) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: "no_bank_code",
        });
        continue;
      }

      const hits = mappingsFor(mappings, institutionOf(t), t.bankCode);
      if (hits.length === 0) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: "no_code_mapping",
        });
        continue;
      }
      if (hits.length > 1) {
        proposals.push(
          suspenseProposal({
            transactionId: t.id,
            reasonCode: "SUS-19",
            detail: `more than one mapping for bank code ${t.bankCode}, every match: ${hits.map((h) => h.id).join(",")}`,
            relatedIds: hits.map((h) => h.id),
          }),
        );
        continue;
      }

      const mapping = hits[0];
      const category = categories.get(mapping.categoryId);
      if (!category) {
        errors.push({
          rowId: t.id,
          code: "MISSING_ACCOUNT",
          message: `bank code mapping ${mapping.id} targets category ${mapping.categoryId} which is not on this client`,
          retryable: false,
        });
        continue;
      }
      if (!category.isActive) {
        proposals.push(
          suspenseProposal({
            transactionId: t.id,
            reasonCode: "SUS-03",
            detail: `bank code ${t.bankCode} maps to inactive category ${category.id}`,
            relatedIds: [mapping.id],
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
            detail: `${outcome.block.detail}, bank code mapping ${mapping.id}`,
            relatedIds: [mapping.id],
          }),
        );
        continue;
      }

      proposals.push(
        codingWrite({
          t,
          categoryId: category.id,
          categoryVersion: category.version,
          cascadeLevel: LEVEL.bankCode,
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
              relatedIds: [mapping.id],
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
      runType: "TXN-MAP-BANKCODES",
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
