/**
 * Shared machinery for the nine module 2 coding runs.
 *
 * Spec: docs/02-run-specifications.md Module 2 Parts A through D, and the ten
 * level cascade in docs/00-conventions.md Part 3. Everything in this file is a
 * rule that more than one of the nine runs has to apply the same way. Putting it
 * here is what makes "the cascade" a single definition rather than nine similar
 * ones that drift apart on the third bug report.
 *
 * Three things this file owns:
 *
 *   1. The level ledger. Which level a row is already resolved at, and the skip
 *      a later step records when it finds one. Steps 1 through 7 never recode a
 *      row that a lower level already decided, which is the whole reason the
 *      execution order in Part B is an order and not a suggestion.
 *   2. The suspense catalog. Owner and escalation age per code, straight from
 *      doc 00. A reason code is never blank and never invented at a call site.
 *   3. The category attribute checks, doc 02 steps 5 through 8, applied
 *      identically by TXN-APPLY-RULES, TXN-APPLY-VENDORDEFAULTS, and
 *      TXN-MAP-BANKCODES.
 */

import { z } from "zod";
import {
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type Skip,
  type Ulid,
} from "../contract";
import { requireTx } from "../apply-writer";
import { scopeHashFor } from "../ids";
import type {
  CategoryRow,
  ClientPolicyRow,
  TransactionRow,
} from "../tables";
import type { RunContext } from "../contract";

export const SUSPENSE_ACCOUNT = "1990";
export const PROCESSOR_CLEARING_ACCOUNT = "1910";
export const TRANSFER_CLEARING_ACCOUNT = "1920";

/** Doc 00 Part 2. Client level default when no category carries its own. */
export const DEFAULT_CAPITALIZE_OVER_CENTS: Cents = BigInt(250000);

/** Doc 00 Part 2. The one currency the ledger is kept in. */
export const FUNCTIONAL_CURRENCY = "USD";

/** The ten level cascade of doc 00 Part 3, named so nothing reads a bare digit. */
export const LEVEL = {
  manualOverride: 0,
  lockedPeriod: 1,
  duplicate: 2,
  transferPair: 3,
  processorSettlement: 4,
  recurringTemplate: 5,
  rule: 6,
  vendorDefault: 7,
  bankCode: 8,
  suspense: 9,
} as const;

/**
 * Doc 00 SUS-01 through SUS-20. Owner decides who is asked, escalation age
 * decides when the item stops being quiet. Neither is a call site choice.
 */
export interface SuspenseSpec {
  owner: "firm" | "client" | "system";
  escalationDays: number;
  label: string;
}

export const SUS_CATALOG: Record<string, SuspenseSpec> = {
  "SUS-01": { owner: "firm", escalationDays: 5, label: "unknown vendor, money out" },
  "SUS-02": { owner: "firm", escalationDays: 5, label: "unknown source, money in" },
  "SUS-03": { owner: "client", escalationDays: 7, label: "business purpose not determinable" },
  "SUS-04": { owner: "firm", escalationDays: 3, label: "possible transfer, no single pair" },
  "SUS-05": { owner: "firm", escalationDays: 3, label: "possible duplicate" },
  "SUS-06": { owner: "client", escalationDays: 10, label: "receipt missing over threshold" },
  "SUS-07": { owner: "client", escalationDays: 7, label: "mixed business and personal" },
  "SUS-08": { owner: "client", escalationDays: 7, label: "owner activity unclear" },
  "SUS-09": { owner: "firm", escalationDays: 5, label: "over capitalization threshold" },
  "SUS-10": { owner: "firm", escalationDays: 5, label: "sales tax treatment unclear" },
  "SUS-11": { owner: "firm", escalationDays: 5, label: "foreign currency" },
  "SUS-12": { owner: "system", escalationDays: 10, label: "processor gross and fee not settled" },
  "SUS-13": { owner: "firm", escalationDays: 10, label: "chargeback or reversal pending" },
  "SUS-14": { owner: "client", escalationDays: 7, label: "loan proceeds unclear" },
  "SUS-15": { owner: "client", escalationDays: 7, label: "grant restriction unknown" },
  "SUS-16": { owner: "firm", escalationDays: 7, label: "intercompany unconfirmed" },
  "SUS-17": { owner: "firm", escalationDays: 5, label: "amount disagrees with document" },
  "SUS-18": { owner: "firm", escalationDays: 30, label: "stale uncleared" },
  "SUS-19": { owner: "firm", escalationDays: 2, label: "rule conflict" },
  "SUS-20": { owner: "firm", escalationDays: 5, label: "dated in locked period" },
};

export function suspenseSpec(code: string): SuspenseSpec {
  const spec = SUS_CATALOG[code];
  if (!spec) throw new Error(`unknown suspense reason code ${code}`);
  return spec;
}

/** Every coding run takes the same scope: one client, one day window, optional accounts. */
export const codingScopeSchema = z.object({
  clientId: z.string().min(1),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bankAccountIds: z.array(z.string().min(1)).nullable().default(null),
});

export type CodingScope = z.infer<typeof codingScopeSchema>;

export function abs(value: bigint): bigint {
  return value < BigInt(0) ? -value : value;
}

/**
 * The default iteration order of doc 02: posted date ascending, absolute amount
 * ascending, id ascending. Total and stable, so two runs over the same rows in
 * the same state produce the same proposal order and therefore the same digest.
 */
export function iterationOrder(a: TransactionRow, b: TransactionRow): number {
  if (a.postedDate !== b.postedDate) return a.postedDate < b.postedDate ? -1 : 1;
  const aa = abs(a.amountCents);
  const ba = abs(b.amountCents);
  if (aa !== ba) return aa < ba ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Sign as the cascade means it. The register stores money leaving the account as
 * negative, so a negative amount is a debit to whatever the money bought, and a
 * positive amount is a credit to whatever produced it. Both the rule sign
 * condition and the category normal side check read this one function, which is
 * why they cannot disagree.
 */
export function signOf(t: TransactionRow): "debit" | "credit" {
  return t.amountCents < BigInt(0) ? "debit" : "credit";
}

/**
 * The level a row is already resolved at, or null when it is still uncoded.
 *
 * The register column is authoritative when it is set. When it is not, the
 * pointer columns still tell the truth, and reading them is what lets a run
 * respect an earlier step inside the same pipeline execution even before the
 * cascade level has been stamped. A paired transfer is level 3 whether or not
 * anything got around to writing a 3, which is exactly the guarantee
 * TXN-PAIR-TRANSFERS needs from the six steps that follow it.
 */
export function resolvedLevel(t: TransactionRow): number | null {
  if (t.pairedWithId !== null) return LEVEL.transferPair;
  if (t.settlementOfTransactionId !== null || t.isProcessorSettlement) {
    return LEVEL.processorSettlement;
  }
  if (t.duplicateFlag && t.duplicateOfTransactionId !== null) return LEVEL.duplicate;
  if (t.templateId !== null) return LEVEL.recurringTemplate;
  if (t.ruleId !== null) return LEVEL.rule;
  if (t.cascadeLevel !== null) return t.cascadeLevel;
  if (t.categoryId !== null) return LEVEL.bankCode;
  return null;
}

/**
 * The skip doc 02 Part B requires from steps 1 through 7 when a lower level
 * already decided the row. The level number goes in the detail because the
 * SkipReason union of doc 03 is fixed and does not carry a level.
 */
export function alreadyResolvedSkip(t: TransactionRow, level: number): Skip {
  return {
    rowId: t.id,
    reason: "already_applied",
    detail: `already_resolved_level_${String(level)}`,
  };
}

/** Doc 03 Part 6. Reported, counted, never written to. */
export function overrideSkips(overriddenIds: readonly Ulid[]): Skip[] {
  return overriddenIds.map((id) => ({
    rowId: id,
    reason: "manual_override" as const,
    detail: "row carries the manual override flag and is invisible to runs",
  }));
}

/**
 * The scope every coding run freezes: the candidate rows of the window, the
 * overridden ids of the same window kept separately, and a version list that
 * makes reference data drift a scope drift rather than a silent recode.
 */
export async function freezeCodingScope(
  scope: CodingScope,
  ctx: RunContext,
  runType: string,
  runVersion: number,
  extraVersions: readonly { id: string; version: number }[],
): Promise<FrozenScope<CodingScope>> {
  const tx = requireTx(ctx);
  const candidates = await tx.query("transactions_in_window", {
    firmId: ctx.firmId,
    clientId: scope.clientId,
    from: scope.from,
    to: scope.to,
    bankAccountIds: scope.bankAccountIds,
    includeOverridden: false,
  });
  const overridden = await tx.query("overridden_transaction_ids_in_window", {
    firmId: ctx.firmId,
    clientId: scope.clientId,
    from: scope.from,
    to: scope.to,
  });

  const candidateIds = candidates
    .slice()
    .sort(iterationOrder)
    .map((t) => t.id)
    .concat(overridden.map((o) => o.id));

  const versions = [
    { id: runType, version: runVersion },
    ...extraVersions,
    ...candidates.map((t) => ({ id: t.id, version: t.version })),
  ];

  return {
    input: scope,
    clientId: scope.clientId,
    firmId: ctx.firmId,
    periodStart: scope.from,
    periodEnd: scope.to,
    candidateIds,
    scopeHash: scopeHashFor({ candidateIds, versions }),
    versions,
    overriddenIds: overridden.map((o) => o.id),
  };
}

/** The client policy row, or the documented defaults when the client has none. */
export function policyOf(rows: readonly ClientPolicyRow[]): {
  functionalCurrency: string;
  capitalizeOverCents: Cents;
  grossAtSaleTime: boolean;
  cleanupEngagement: boolean;
} {
  const row = rows.length > 0 ? rows[0] : null;
  return {
    functionalCurrency: row?.functionalCurrency ?? FUNCTIONAL_CURRENCY,
    capitalizeOverCents:
      row?.capitalizeOverCents ?? DEFAULT_CAPITALIZE_OVER_CENTS,
    grossAtSaleTime: row?.grossAtSaleTime ?? false,
    cleanupEngagement: row?.cleanupEngagement ?? false,
  };
}

/**
 * Doc 00 Part 1. Foreign currency is out of scope, and the register constraint
 * txn_currency_scope says a row that is not in the functional currency may only
 * exist with suspense reason SUS-11 on it. So every coding step between level 5
 * and level 8 stands down on such a row and lets the sweep put it where the
 * constraint allows. Returning a skip rather than routing SUS-11 here keeps the
 * reason code in exactly one place, which is the sweep.
 */
export function foreignCurrencySkip(
  t: TransactionRow,
  functionalCurrency: string,
): Skip | null {
  if (t.currency === functionalCurrency) return null;
  return {
    rowId: t.id,
    reason: "out_of_scope_engagement",
    detail: `currency ${t.currency} is not the functional currency ${functionalCurrency}, SUS-11 is the only allowed outcome`,
  };
}

/**
 * Doc 02 step 5 wording. A treatment that feeds a tax position makes a sign
 * disagreement a tax question, so it routes to SUS-10. A treatment that does
 * not makes it a purpose question, so it routes to SUS-03.
 */
export function isTaxRelated(cat: CategoryRow): boolean {
  return cat.taxTreatment !== "not_applicable" && cat.taxTreatment !== "transfer";
}

export interface AttributeBlock {
  reasonCode: string;
  detail: string;
}

export interface AttributeException {
  kind: "missing_class" | "missing_receipt";
  reasonCode: string | null;
  detail: string;
}

export interface AttributeOutcome {
  /** Set when the coding must not be written. The sweep picks the row up later. */
  block: AttributeBlock | null;
  /** Raised alongside a coding that is still written. */
  exceptions: AttributeException[];
}

/**
 * Doc 02 steps 5 through 8, run identically by the rule, vendor default, and
 * bank code steps. Steps 5 and 6 block the coding. Steps 7 and 8 do not: the
 * coding is right, the support behind it is missing, and treating a missing
 * receipt as a coding failure would put a correct expense in suspense for a
 * reason that has nothing to do with where it belongs.
 */
export function categoryChecks(
  t: TransactionRow,
  cat: CategoryRow,
  opts: { hasDocument: boolean; policyCapitalizeOverCents: Cents },
): AttributeOutcome {
  const exceptions: AttributeException[] = [];
  const magnitude = abs(t.amountCents);

  // Step 5. Sign sanity against the category normal side.
  if (signOf(t) !== cat.normalSide) {
    const code = isTaxRelated(cat) ? "SUS-10" : "SUS-03";
    return {
      block: {
        reasonCode: code,
        detail: `sign ${signOf(t)} disagrees with normal side ${cat.normalSide} on ${cat.id}`,
      },
      exceptions,
    };
  }

  // Step 6. Capitalization threshold. At or above, not over.
  const ceiling = cat.capitalizeOverCents ?? opts.policyCapitalizeOverCents;
  if (cat.normalSide === "debit" && magnitude >= ceiling) {
    return {
      block: {
        reasonCode: "SUS-09",
        detail: `amount ${magnitude.toString()} is at or above the capitalization threshold ${ceiling.toString()}`,
      },
      exceptions,
    };
  }

  // Step 7. Receipt required over a threshold, with no document linked.
  if (
    cat.requiresReceiptOverCents !== null &&
    magnitude > cat.requiresReceiptOverCents &&
    !opts.hasDocument
  ) {
    exceptions.push({
      kind: "missing_receipt",
      reasonCode: "SUS-06",
      detail: `no document linked and ${cat.id} requires a receipt over ${cat.requiresReceiptOverCents.toString()}`,
    });
  }

  // Step 8. Class required, none carried. A documentation exception, not suspense.
  if (cat.requiresClass && t.classId === null) {
    exceptions.push({
      kind: "missing_class",
      reasonCode: null,
      detail: `${cat.id} requires a class and the row carries none`,
    });
  }

  return { block: null, exceptions };
}

/**
 * The field write that records a coding decision plus its provenance. Every
 * before value is read off the row so undo shape R2 can put it back exactly.
 */
export function codingWrite(args: {
  t: TransactionRow;
  categoryId: string;
  categoryVersion: number;
  cascadeLevel: number;
  ruleId?: string | null;
  ruleVersion?: number | null;
  templateId?: Ulid | null;
  templateVersion?: number | null;
  vendorId?: Ulid | null;
  classId?: Ulid | null;
  matchedConditions?: unknown;
}): ProposedFieldWrite {
  const t = args.t;
  const after: Record<string, unknown> = {
    categoryId: args.categoryId,
    categoryVersion: args.categoryVersion,
    cascadeLevel: args.cascadeLevel,
    ruleId: args.ruleId ?? null,
    ruleVersion: args.ruleVersion ?? null,
    templateId: args.templateId ?? null,
    templateVersion: args.templateVersion ?? null,
    matchedConditions: args.matchedConditions ?? null,
  };
  const before: Record<string, unknown> = {
    categoryId: t.categoryId,
    categoryVersion: t.categoryVersion,
    cascadeLevel: t.cascadeLevel,
    ruleId: t.ruleId,
    ruleVersion: t.ruleVersion,
    templateId: t.templateId,
    templateVersion: t.templateVersion,
    matchedConditions: t.matchedConditions ?? null,
  };
  if (args.vendorId !== undefined) {
    after.vendorId = args.vendorId;
    before.vendorId = t.vendorId;
  }
  if (args.classId !== undefined && args.classId !== null) {
    after.classId = args.classId;
    before.classId = t.classId;
  }
  return {
    kind: "field_write",
    table: "transactions",
    rowId: t.id,
    before,
    after,
    provenance: {
      cascadeLevel: args.cascadeLevel,
      ruleId: args.ruleId ?? undefined,
      ruleVersion: args.ruleVersion ?? undefined,
      templateId: args.templateId ?? undefined,
      templateVersion: args.templateVersion ?? undefined,
    },
  };
}

/** Index categories by id, newest version winning when several are present. */
export function categoryIndex(
  rows: readonly CategoryRow[],
): Map<string, CategoryRow> {
  const out = new Map<string, CategoryRow>();
  for (const c of rows) {
    const seen = out.get(c.id);
    if (!seen || c.version > seen.version) out.set(c.id, c);
  }
  return out;
}

/** Doc 02 module 2. A suspense proposal always carries a catalog code. */
export function suspenseProposal(args: {
  transactionId: Ulid;
  reasonCode: string;
  detail: string;
  relatedIds?: readonly Ulid[];
}): Proposal {
  suspenseSpec(args.reasonCode);
  return {
    kind: "suspense",
    transactionId: args.transactionId,
    reasonCode: args.reasonCode as `SUS-${string}`,
    account: SUSPENSE_ACCOUNT,
    detail: args.detail,
    relatedIds: args.relatedIds ? args.relatedIds.slice() : undefined,
  };
}
