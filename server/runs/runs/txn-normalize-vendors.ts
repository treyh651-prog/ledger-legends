/**
 * TXN-NORMALIZE-VENDORS. Turn the raw bank descriptor into a normalized vendor.
 *
 * Spec: docs/02-run-specifications.md Module 2 TXN-NORMALIZE-VENDORS. This is
 * pipeline step 0 and it feeds three later steps: duplicate detection compares
 * normalized vendors, rules match on normalized vendors, and vendor defaults key
 * on normalized vendors. Everything downstream is only as consistent as this is,
 * so the seven steps run in exactly the documented order and the function is
 * pure. Same input, same output, forever, which is what makes the version stamp
 * mean something.
 *
 * The seven steps:
 *   1. Uppercase.
 *   2. Replace every character outside A to Z, 0 to 9, and space with one space.
 *   3. Collapse runs of whitespace and trim.
 *   4. Strip one known processor prefix, longest match first, and only when the
 *      prefix is followed by a space. One prefix, never two.
 *   5. Strip one trailing store or terminal number. A trailing token of one to
 *      six digits, optionally introduced by the token STORE or TERM or a single
 *      hash character.
 *   6. Collapse and trim again.
 *   7. If the result is empty, keep the step 3 result and set the degraded flag.
 *
 * Step 7 exists because an empty normalized vendor is worse than a noisy one. A
 * descriptor that is nothing but a terminal number would otherwise normalize to
 * the empty string, and every such row in the client would then look like a
 * duplicate of every other. Keeping the step 3 text and flagging the row says
 * plainly that the normalizer had nothing to work with.
 *
 * No ledger effect. This run writes two columns and never posts.
 */

import {
  makeResult,
  isFieldWrite,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { isLockedDay } from "../dates";
import { revertFieldWrite } from "../undo";
import type { TransactionRow } from "../tables";
import {
  codingScopeSchema,
  freezeCodingScope,
  iterationOrder,
  overrideSkips,
  type CodingScope,
} from "./coding-cascade";

/**
 * The version of the normalizer below. Bump it when any of the seven steps or
 * the prefix list changes, because the version is the only thing that tells a
 * later run whether a stored value came from this function or an older one.
 */
export const VENDOR_NORMALIZATION_VERSION = 1;

/**
 * Known processor and aggregator prefixes, doc 02 data list. Sorted longest
 * first at match time so SQ TST does not lose to SQ. A prefix only counts when a
 * space follows it, otherwise SQUARE would be stripped down to ARE.
 */
export const PROCESSOR_PREFIXES: readonly string[] = [
  "SQ",
  "SQC",
  "TST",
  "TS",
  "PAYPAL",
  "PP",
  "SP",
  "STRIPE",
  "TOAST",
  "CLOVER",
  "IZ",
  "POS",
  "PY",
  "WL",
  "EB",
  "IC",
];

/**
 * Step 5. The trailing token is one to six digits, and the token boundary is a
 * space or the start of the string. Allowing the start of the string is what
 * makes a descriptor of nothing but a terminal number reach step 7 rather than
 * quietly keeping the number as a vendor name. The hash alternative is kept for
 * readability against the spec even though step 2 has already turned every hash
 * into a space by the time this runs.
 */
const STEP_5_TRAILING = /(?:\s|^)(?:(?:STORE|TERM|#)\s)?\d{1,6}$/;

export interface NormalizationResult {
  value: string;
  degraded: boolean;
}

/**
 * The normalizer. Pure, exported, and tested directly, because a function this
 * many other rules depend on should be provable without a database.
 */
export function normalizeVendor(raw: string): NormalizationResult {
  // Steps 1 through 3.
  const stepThree = raw
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Step 4. Exactly one prefix, longest first.
  let working = stepThree;
  const ordered = PROCESSOR_PREFIXES.slice().sort((a, b) =>
    b.length !== a.length ? b.length - a.length : a < b ? -1 : 1,
  );
  for (const prefix of ordered) {
    if (working.startsWith(`${prefix} `)) {
      working = working.slice(prefix.length + 1);
      break;
    }
  }

  // Step 5. Exactly one trailing store or terminal number.
  working = working.replace(STEP_5_TRAILING, "");

  // Step 6.
  working = working.replace(/\s+/g, " ").trim();

  // Step 7.
  if (working.length === 0) return { value: stepThree, degraded: true };
  return { value: working, degraded: false };
}

/**
 * The descriptor the normalizer reads. The bank merchant name is preferred when
 * the feed sent one, because it is the cleaner of the two fields and using it
 * first is what makes TST* JOE S PIZZA and tst* joe's pizza land on one vendor.
 */
export function descriptorOf(t: TransactionRow): string {
  return t.bankMerchantName ?? t.description;
}

export const txnNormalizeVendors: Run<CodingScope, Proposal> = {
  type: "TXN-NORMALIZE-VENDORS",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => scope.clientId,
  scopeSchema: codingScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CodingScope>> {
    return freezeCodingScope(scope, ctx, "TXN-NORMALIZE-VENDORS", 1, [
      { id: "VENDOR-NORMALIZATION", version: VENDOR_NORMALIZATION_VERSION },
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
    const candidates = await tx.query("transactions_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from: scope.from,
      to: scope.to,
      bankAccountIds: scope.bankAccountIds,
      includeOverridden: false,
    });

    for (const t of candidates.slice().sort(iterationOrder)) {
      if (isLockedDay(locks, t.postedDate)) {
        skips.push({
          rowId: t.id,
          reason: "locked_period",
          detail: `posted ${t.postedDate} falls inside a locked period`,
        });
        continue;
      }
      if (t.vendorNormalizationVersion === VENDOR_NORMALIZATION_VERSION) {
        skips.push({
          rowId: t.id,
          reason: "already_applied",
          detail: `already_normalized_current_version ${String(VENDOR_NORMALIZATION_VERSION)}`,
        });
        continue;
      }

      const result = normalizeVendor(descriptorOf(t));
      const write: ProposedFieldWrite = {
        kind: "field_write",
        table: "transactions",
        rowId: t.id,
        before: {
          normalizedVendor: t.normalizedVendor,
          vendorNormalizationVersion: t.vendorNormalizationVersion,
          normalizationDegraded: t.normalizationDegraded,
        },
        after: {
          normalizedVendor: result.value,
          vendorNormalizationVersion: VENDOR_NORMALIZATION_VERSION,
          normalizationDegraded: result.degraded,
        },
        provenance: { cascadeLevel: 0 },
      };
      proposals.push(write);
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
      runType: "TXN-NORMALIZE-VENDORS",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};
