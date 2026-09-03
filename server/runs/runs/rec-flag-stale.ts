/**
 * REC-FLAG-STALE. Flag outstanding items that have gone stale.
 *
 * Spec: docs/02-run-specifications.md Module 3, and SUS-18 in
 * docs/00-conventions.md, which is the stale uncleared item, firm owned, at a
 * thirty day escalation.
 *
 * An outstanding item is a register row the books recorded and the bank never
 * cleared. Past a threshold it stops being a timing difference and becomes a
 * question: was the check ever cashed, was the deposit ever taken to the bank,
 * was this row recorded twice. This run finds those rows, flags them, gives each
 * one an owner and a follow up date, and raises the follow up.
 *
 * It does not touch coding. Not the category, not the class, not the suspense
 * reason on the register row, not the cascade level. A stale check is not a
 * miscoded check, and re-deciding the coding of a row because the bank was slow
 * would corrupt a decision that was correct when it was made. The flag, the
 * owner, and the follow up date live in their own columns, and the SUS-18 work
 * item lives in its own table.
 *
 * A row carrying the manual override flag is skipped here, and that is the one
 * place in module 3 where the override wins. Matching and clearing record a
 * fact the bank supplied about the row. Flagging assigns an owner and starts an
 * escalation clock, which is a judgment about the row, and a person who took the
 * row by hand already owns it.
 *
 * Thresholds are per instrument, from doc 02: an issued check at ninety days, an
 * electronic item at thirty, a deposit at ten, anything else at sixty. An
 * explicit threshold in the scope overrides all four.
 */

import { z } from "zod";
import {
  makeResult,
  isFieldWrite,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedRowInsert,
  type ProposedSuspenseRouting,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import {
  applyProposals,
  requireTx,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
} from "../apply-writer";
import { addDays, dayGap, isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { TransactionRow } from "../tables";
import { suspenseSpec } from "./coding-cascade";

/** Doc 00 Part 2. The one suspense account, as a literal the contract accepts. */
const SUSPENSE_ACCOUNT = "1990" as const;
import {
  ESCHEAT_REVIEW_DAYS,
  STALE_THRESHOLD_DAYS,
  SUS_STALE_UNCLEARED,
  bookOrder,
} from "./rec-shared";

/** The brief's single default, which is also the doc 02 threshold for "other". */
export const DEFAULT_STALE_DAYS = 60;

export const flagStaleScopeSchema = z.object({
  clientId: z.string().min(1),
  /** Null means every bank and card account on the client. */
  bankAccountIds: z.array(z.string().min(1)).nullable().default(null),
  /** The day staleness is measured from. Never the wall clock inside the run. */
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * How far back to look for outstanding items. Wide by default, because a
   * check that went stale is by definition old and a narrow window would find
   * only the items that are not yet a problem.
   */
  lookbackDays: z.number().int().min(1).max(3650).default(730),
  /**
   * One threshold for every instrument. Null keeps the per instrument defaults
   * of doc 02, whose "other" value is the sixty days the brief asks for.
   */
  thresholdDays: z.number().int().min(1).max(3650).nullable().default(null),
});

export type FlagStaleScope = z.infer<typeof flagStaleScopeSchema>;

/** What made one row stale, kept together so the write and the item agree. */
interface StaleFinding {
  row: TransactionRow;
  ageDays: number;
  thresholdDays: number;
  escheat: boolean;
}

export const recFlagStale: Run<FlagStaleScope, Proposal> = {
  type: "REC-FLAG-STALE",
  version: 1,
  // No journal entry. Doc 02 is explicit that writing off a stale check is a
  // separate decision a person makes, and this run only raises the question.
  writesLedger: false,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => scope.clientId,
  scopeSchema: flagStaleScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<FlagStaleScope>> {
    const tx = requireTx(ctx);
    const from = addDays(scope.asOf, -scope.lookbackDays);
    const candidates = await tx.query("transactions_in_window", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      from,
      to: scope.asOf,
      bankAccountIds: scope.bankAccountIds,
      // Loaded so they are counted and reported, then skipped in propose.
      includeOverridden: true,
    });
    const overridden = await tx.query("overridden_transaction_ids_in_window", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      from,
      to: scope.asOf,
    });

    const outstanding = candidates
      .filter((t) => !t.cleared && t.status === "active" && !t.voided)
      .sort(bookOrder);

    const candidateIds = outstanding.map((t) => t.id);
    const versions = [
      { id: "REC-FLAG-STALE", version: 1 },
      { id: SUS_STALE_UNCLEARED, version: 1 },
      ...outstanding.map((t) => ({ id: t.id, version: t.version })),
    ];

    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: from,
      periodEnd: scope.asOf,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: overridden
        .map((o) => o.id)
        .filter((id) => candidateIds.includes(id)),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const from = addDays(scope.asOf, -scope.lookbackDays);
    const candidates = await tx.query("transactions_in_window", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      from,
      to: scope.asOf,
      bankAccountIds: scope.bankAccountIds,
      includeOverridden: true,
    });
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const openRequests = await tx.query("open_portal_requests_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });

    // Doc 02 dedup rule, same shape as decision 40 in NOTES.md: one open follow
    // up per transaction and reason code, so a daily run does not stack them.
    const covered = new Set<string>();
    for (const r of openRequests) {
      if (r.transactionId === null) continue;
      covered.add(`${r.transactionId}\u0000${r.reasonCode}`);
    }

    const inScope = new Set<Ulid>(frozen.candidateIds);
    const overridden = new Set<Ulid>(frozen.overriddenIds);
    const spec = suspenseSpec(SUS_STALE_UNCLEARED);

    const findings: StaleFinding[] = [];

    for (const t of candidates.filter((t) => inScope.has(t.id)).sort(bookOrder)) {
      if (overridden.has(t.id) || t.manualOverride) {
        skips.push({
          rowId: t.id,
          reason: "manual_override",
          detail:
            "row carries the manual override flag, so the person who set it already owns the follow up",
        });
        continue;
      }
      if (t.staleFlagged) {
        skips.push({
          rowId: t.id,
          reason: "already_applied",
          detail: `stale_flag_exists since ${String(t.staleFlaggedOn)}`,
        });
        continue;
      }
      if (t.postedDate > scope.asOf) {
        skips.push({
          rowId: t.id,
          reason: "out_of_scope_engagement",
          detail: `future_of_as_of_date, posted ${t.postedDate} is after ${scope.asOf}`,
        });
        continue;
      }
      if (isLockedDay(locks, t.postedDate)) {
        // The flag columns sit on a row inside a closed period, and doc 00 keeps
        // runs out of closed periods without exception. The item is reported so
        // it is not lost.
        skips.push({
          rowId: t.id,
          reason: "locked_period",
          detail: `posted ${t.postedDate} falls inside a locked period`,
        });
        continue;
      }

      const threshold =
        scope.thresholdDays === null
          ? STALE_THRESHOLD_DAYS[t.instrumentType]
          : scope.thresholdDays;
      const age = dayGap(t.postedDate, scope.asOf);
      if (age < threshold) {
        skips.push({
          rowId: t.id,
          reason: "missing_prerequisite",
          detail: `outstanding ${String(age)} days, under the ${String(threshold)} day threshold for ${t.instrumentType}`,
        });
        continue;
      }

      findings.push({
        row: t,
        ageDays: age,
        thresholdDays: threshold,
        escheat: age >= ESCHEAT_REVIEW_DAYS,
      });
    }

    let ordinal = 0;
    for (const finding of findings) {
      const escalatesOn = addDays(scope.asOf, spec.escalationDays);
      proposals.push(flagWrite(finding, scope.asOf, escalatesOn, spec.owner));
      proposals.push(staleItem(finding));
      const key = `${finding.row.id}\u0000${SUS_STALE_UNCLEARED}`;
      if (covered.has(key)) {
        skips.push({
          rowId: finding.row.id,
          reason: "already_applied",
          detail: `an open ${SUS_STALE_UNCLEARED} follow up already exists on this row`,
        });
        continue;
      }
      proposals.push(followUp(finding, scope.asOf, escalatesOn, ordinal));
      ordinal += 1;
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
      runType: "REC-FLAG-STALE",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) {
        // Shape R2. The flag, the owner, and the follow up date go back.
        plan.push(revertFieldWrite(p));
      }
      // The SUS-18 item and the follow up request are left standing. The item is
      // a question for a person and undoing the run does not answer it. The
      // check really has been outstanding for ninety days either way.
    }
    return plan;
  },
};

/**
 * The flag. Five fields, all of them stale fields, none of them coding.
 *
 * There is a tempting alternative here, which is to write SUS-18 into
 * transactions.suspense_reason the way the coding cascade does. It is rejected
 * because suspense_reason is a coding column, it is watched by the override
 * guard, and writing it would overwrite whatever coding question the row was
 * already carrying. The brief is explicit: flag the row, do not alter its
 * coding.
 */
function flagWrite(
  finding: StaleFinding,
  flaggedOn: string,
  escalatesOn: string,
  owner: "firm" | "client" | "system",
): ProposedFieldWrite {
  const t = finding.row;
  return {
    kind: "field_write",
    table: "transactions",
    rowId: t.id,
    before: {
      staleFlagged: t.staleFlagged,
      staleFlaggedOn: t.staleFlaggedOn,
      staleOwner: t.staleOwner,
      staleEscalatesOn: t.staleEscalatesOn,
      escheatReview: t.escheatReview,
    },
    after: {
      staleFlagged: true,
      staleFlaggedOn: flaggedOn,
      staleOwner: owner,
      staleEscalatesOn: escalatesOn,
      // Past the escheat age the question stops being a bank question and starts
      // being an unclaimed property question. The flag says look, it does not
      // file anything, because the filing is jurisdiction by jurisdiction.
      escheatReview: finding.escheat ? true : t.escheatReview,
    },
    provenance: { cascadeLevel: null },
  };
}

/** The SUS-18 work item. A row in suspense_items, not a coding write. */
function staleItem(finding: StaleFinding): ProposedSuspenseRouting {
  const t = finding.row;
  return {
    kind: "suspense",
    transactionId: t.id,
    reasonCode: SUS_STALE_UNCLEARED,
    account: SUSPENSE_ACCOUNT,
    detail: `outstanding ${String(finding.ageDays)} days against a ${String(finding.thresholdDays)} day threshold for ${t.instrumentType}, amount ${t.amountCents.toString()} cents posted ${t.postedDate}`,
  };
}

/**
 * The follow up, in the shape the SUS-15 sweep uses for a client request: an
 * open portal request with a due date on the escalation age.
 *
 * The item is firm owned, and a firm owned code does not normally raise a client
 * portal request. The follow up is raised anyway because the brief asks for the
 * escalation, and a request with a due date is the only place in this schema
 * where a follow up has a clock on it. Nothing is sent anywhere. The row is a
 * queue entry a person works, which is the same thing the sweep's requests are.
 */
function followUp(
  finding: StaleFinding,
  openedOn: string,
  dueOn: string,
  ordinal: number,
): ProposedRowInsert {
  const t = finding.row;
  return {
    kind: "row_insert",
    table: "portal_requests",
    rowId: derivedId(t.id, `stale-${SUS_STALE_UNCLEARED}`, ordinal),
    row: {
      firmId: t.firmId,
      clientId: t.clientId,
      transactionId: t.id,
      reasonCode: SUS_STALE_UNCLEARED,
      detail: `confirm whether this ${t.instrumentType} item ever cleared, outstanding ${String(finding.ageDays)} days as of ${openedOn}`,
      status: "open",
      openedOn,
      dueOn,
      createdByRunId: RUN_ID_PLACEHOLDER,
      requestedAt: NOW_PLACEHOLDER,
    },
    provenance: { cascadeLevel: null },
  };
}
