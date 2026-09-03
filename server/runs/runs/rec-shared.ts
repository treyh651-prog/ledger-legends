/**
 * Shared machinery for the three module 3 reconciliation runs.
 *
 * Spec: docs/02-run-specifications.md Module 3, and the reconciliation identity
 * in docs/00-conventions.md gate G03. What lives here is anything more than one
 * of the three runs has to decide the same way, for the same reason the coding
 * cascade keeps its shared rules in one file: three similar definitions of a
 * tier or a difference is three definitions that drift.
 *
 * Four things this file owns:
 *
 *   1. The tier constants. Which tier means what, and the confidence value that
 *      renders it. Confidence is a rendering of the tier and nothing else. It is
 *      not a score, not a percentage, and not a probability, which is why the
 *      only allowed values are the four constants below.
 *   2. The scope shape every reconciliation run takes: one client, one bank or
 *      card account, one statement.
 *   3. The stale thresholds, per instrument, from doc 02.
 *   4. The difference identity, in one function, so the batch row and the tests
 *      cannot disagree about what a difference is.
 */

import { z } from "zod";
import type { Cents, Ulid } from "../contract";
import { abs } from "./coding-cascade";
import type { StatementLineRow, TransactionRow } from "../tables";

/** The four tiers of doc 02 module 3, named so nothing reads a bare digit. */
export const TIER = {
  /** Exact amount and the same date. Identity, written directly. */
  exactDate: 1,
  /** Exact amount inside the date window. */
  exactWindow: 2,
  /** Amount inside the cent tolerance plus an equal normalized vendor. */
  tolerantVendor: 3,
  /** One statement line against the exact sum of several book rows. */
  sumToSum: 4,
} as const;

export type Tier = (typeof TIER)[keyof typeof TIER];

/**
 * Confidence per tier. A fixed constant, one per tier, deliberately not a
 * computation. Doc 02 Part A invariant 3 forbids a score, a percentage, or a
 * probability on a match, and a constant that only ever renders the tier is
 * none of those. If it were computed from the data it would be a likelihood,
 * and a person reading 87 on a screen would reasonably ask what the other 13
 * was, which is a question the engine has no honest answer to.
 */
export const CONFIDENCE: Record<Tier, number> = {
  [TIER.exactDate]: 100,
  [TIER.exactWindow]: 90,
  [TIER.tolerantVendor]: 80,
  [TIER.sumToSum]: 70,
};

/** Doc 00 SUS-18. Stale uncleared item, firm owned, escalates at 30 days. */
export const SUS_STALE_UNCLEARED = "SUS-18" as const;

/** The default T2 and T3 date window in calendar days. */
export const DEFAULT_WINDOW_DAYS = 5;

/**
 * The default T3 tolerance in cents, and its ceiling. A tolerance is only ever
 * safe because T3 also requires an equal normalized vendor, so a one cent
 * default absorbs a rounding difference on a known payee and never silently
 * matches two unrelated amounts that happen to sit a cent apart.
 */
export const DEFAULT_TOLERANCE_CENTS = 1;
export const MAX_TOLERANCE_CENTS = 100;

/** Largest group of book rows one statement line may be matched against at T4. */
export const DEFAULT_MAX_GROUP_SIZE = 4;

/**
 * Largest pool of book rows T4 will enumerate subsets of. Subset enumeration is
 * exponential in the pool, so the pool is capped and a line whose pool is over
 * the cap is reported rather than matched. Reporting a line a person has to look
 * at is correct. Spending a minute of a serializable transaction on it is not.
 */
export const DEFAULT_CANDIDATE_POOL_CAP = 12;

/** Doc 02 module 3 stale thresholds, in days, per instrument type. */
export const STALE_THRESHOLD_DAYS: Record<
  TransactionRow["instrumentType"],
  number
> = {
  issued_check: 90,
  electronic: 30,
  deposit: 10,
  other: 60,
};

/**
 * Age at which a stale item stops being a reconciliation question and becomes
 * an unclaimed property question. Doc 02 asks for the review flag, not for the
 * escheat filing, which is a jurisdiction by jurisdiction matter for a person.
 */
export const ESCHEAT_REVIEW_DAYS = 180;

/** Every reconciliation run addresses exactly one statement on one account. */
export const recScopeSchema = z.object({
  clientId: z.string().min(1),
  bankAccountId: z.string().min(1),
  statementId: z.string().min(1),
});

export type RecScope = z.infer<typeof recScopeSchema>;

export function sameSign(a: bigint, b: bigint): boolean {
  return a < BigInt(0) === b < BigInt(0);
}

/**
 * Doc 02 module 3 iteration order for the bank side: statement line date
 * ascending, absolute amount ascending, statement line id ascending. Total and
 * stable, so a preview and an apply of the same statement walk the same lines
 * in the same order and produce the same proposals.
 */
export function lineOrder(a: StatementLineRow, b: StatementLineRow): number {
  if (a.statementDate !== b.statementDate) {
    return a.statementDate < b.statementDate ? -1 : 1;
  }
  const aa = abs(a.amountCents);
  const ba = abs(b.amountCents);
  if (aa !== ba) return aa < ba ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Doc 02 default book side order: posted date, absolute amount, id. */
export function bookOrder(a: TransactionRow, b: TransactionRow): number {
  if (a.postedDate !== b.postedDate) return a.postedDate < b.postedDate ? -1 : 1;
  const aa = abs(a.amountCents);
  const ba = abs(b.amountCents);
  if (aa !== ba) return aa < ba ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The reconciliation difference, in one place.
 *
 * The brief states it as the statement balance minus the cleared ledger
 * balance. Doc 02 states the same fact as an identity on the adjusted book
 * balance: statement balance plus deposits in transit minus outstanding items
 * equals the book balance. The two are algebraically the same statement,
 * because the cleared ledger balance is exactly the book balance with the
 * deposits in transit and the outstanding items taken back out of it. The
 * subtraction is used here because it produces one signed number that a person
 * can read, and because gate G03 asks whether that number is zero.
 */
export function reconciliationDiff(
  statementBalanceCents: Cents,
  clearedLedgerBalanceCents: Cents,
): Cents {
  return statementBalanceCents - clearedLedgerBalanceCents;
}

/** A difference of exactly zero is reconciled. One cent is not. */
export function batchStateFor(diff: Cents): "reconciled" | "out_of_balance" {
  return diff === BigInt(0) ? "reconciled" : "out_of_balance";
}

/** Vendor comparison for T3. Missing on either side is never a match. */
export function vendorMatches(
  line: StatementLineRow,
  book: TransactionRow,
): boolean {
  const a = line.normalizedVendor;
  const b = book.normalizedVendor;
  if (a === null || b === null) return false;
  if (a === "" || b === "") return false;
  return a === b;
}

/**
 * A register row eligible to be matched at all.
 *
 * Note what is absent. The manual override flag is not tested here, on purpose.
 * A row a person coded by hand is still a row the bank either cleared or did
 * not, and matching it to a statement line records the bank's fact without
 * touching the person's coding. See NOTES.md decision on the override contract.
 */
export function matchable(t: TransactionRow): boolean {
  return (
    t.status === "active" &&
    !t.voided &&
    !t.cleared &&
    t.statementLineId === null &&
    t.amountCents !== BigInt(0)
  );
}

/** Deterministic subset enumeration for T4, smallest group first. */
export function subsetsOfSize<T>(pool: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const pick: number[] = [];
  const walk = (start: number): void => {
    if (pick.length === size) {
      out.push(pick.map((i) => pool[i]));
      return;
    }
    for (let i = start; i < pool.length; i += 1) {
      pick.push(i);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return out;
}

export function sumOf(rows: readonly TransactionRow[]): Cents {
  let total = BigInt(0);
  for (const r of rows) total += r.amountCents;
  return total;
}

/** The set of ids a group match consumed, joined for a readable detail line. */
export function idList(ids: readonly Ulid[]): string {
  return ids.slice().sort().join(",");
}
