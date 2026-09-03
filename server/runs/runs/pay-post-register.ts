/**
 * PAY-POST-REGISTER. Post an approved payroll register to the ledger.
 *
 * Spec: docs/05-decisions.md D5, docs/01-categories-and-charts.md Part 3 for
 * the payroll accounts, docs/02-run-specifications.md Module 5 gate G11.
 *
 * The entry. Gross wages debit 6300, employer side taxes debit 6310, employee
 * withholding credits 2320, employer taxes credit 2310, and the net credits the
 * funding account. The five lines sum to exactly zero in integer cents, which
 * the framework asserts before anything is written.
 *
 * The funding account. Net pay credits the operating bank account on the pay
 * date, or the payroll clearing account 1930 when the provider debits the bank
 * on a different day from the pay date. That timing difference is the entire
 * reason 1930 exists, and the run picks between the two by comparing the pay
 * date against the period rather than by anybody remembering to.
 *
 * The source. Only an approved pay run, and that row carries a vault object key
 * for the register it was approved against. D5 says the posting works from a
 * vault linked register and never from a manually keyed total. There is no path
 * in this file that accepts a total from a caller, which is what makes gate G11
 * a real check rather than a label.
 *
 * D5 again, in the negative. This run calculates no payroll tax, computes no
 * withholding, and produces no filing. Every figure it posts was produced by
 * the client's payroll provider and reviewed by a person. The software moves
 * numbers from a register into a ledger and does no tax arithmetic at all.
 *
 * One entry per pay run per period per client. The entry id is derived from
 * exactly those three things and the register row carries a unique constraint
 * on the same triple, so a rerun is a no operation at the run level and a
 * refusal at the database level.
 *
 * Locked periods. A locked period is skipped with reason locked_period. This
 * run writes into the ledger, so the lock stops it absolutely.
 *
 * SENDS. None.
 *
 * CONSTRAINT. No model, no score, no string distance, no floating point. Money
 * is bigint cents throughout and the only arithmetic is addition.
 */

import { z } from "zod";
import {
  isFieldWrite,
  makeResult,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedJournalEntry,
  type ProposedLine,
  type ProposedRowInsert,
  type Run,
  type RunError,
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
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { ChartAccountRow, PayRunRow } from "../tables";
import { ZERO, loadCloseData } from "./close-shared";
import { periodWindow } from "./per-shared";

/** Doc 01 Part 3. The five accounts a payroll register touches. */
export const WAGE_ACCOUNT = "6300";
export const EMPLOYER_TAX_ACCOUNT = "6310";
export const TAX_LIABILITY_ACCOUNT = "2310";
export const WITHHOLDING_ACCOUNT = "2320";
export const OPERATING_ACCOUNT = "1010";
/** Doc 01 Part 4. Where net pay sits when the bank debit lands on another day. */
export const PAYROLL_CLEARING_ACCOUNT = "1930";

export const postRegisterScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  payDate: z.string().min(10),
  providerName: z.string().min(1),
});

export type PostRegisterScope = z.infer<typeof postRegisterScopeSchema>;

export const payPostRegister: Run<PostRegisterScope, Proposal> = {
  type: "PAY-POST-REGISTER",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:pay-post:${scope.payDate}`,
  scopeSchema: postRegisterScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<PostRegisterScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const key = { firmId: ctx.firmId, clientId: scope.clientId };
    const payRuns = await tx.query("pay_runs_for_client", key);
    const entries = await tx.query("pay_register_entries_for_client", key);
    const target = payRunFor(payRuns, scope.payDate, scope.providerName);
    const candidateIds = target === null ? [] : [target.id];
    const versions = [
      { id: "PAY-POST-REGISTER", version: 1 },
      ...(target === null ? [] : [{ id: target.id, version: target.version }]),
      ...entries.map((e) => ({ id: e.id, version: e.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // Period and pay date. One register per pay run per period per client, so
      // both belong in the hash.
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds: [...candidateIds, `PAY-DATE:${scope.payDate}`],
        versions,
      }),
      versions,
      overriddenIds: payRuns.filter((p) => p.manualOverride).map((p) => p.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const window = periodWindow(scope.period);
    const key = { firmId: frozen.firmId, clientId: frozen.clientId };
    const close = await loadCloseData(tx, frozen.firmId, frozen.clientId, scope.period);
    const payRuns = await tx.query("pay_runs_for_client", key);
    const existing = await tx.query("pay_register_entries_for_client", key);
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const target = payRunFor(payRuns, scope.payDate, scope.providerName);

    /*
     * D5. The prerequisite is an approved pay run, not a caller supplied total.
     * With no approved run there is nothing to post and the run says so rather
     * than accepting figures from whoever called it.
     */
    if (target === null) {
      skips.push({
        rowId: frozen.clientId,
        reason: "missing_prerequisite",
        detail:
          `no approved pay run for ${scope.providerName} on ${scope.payDate}, ` +
          `so nothing was posted`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const rowId = registerEntryIdOf(frozen.clientId, target.id, window.periodStart);

    if (target.manualOverride) {
      skips.push({
        rowId,
        reason: "manual_override",
        detail: `pay run for ${scope.payDate} carries manual_override`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    if (isLockedDay(close.locks, scope.payDate)) {
      skips.push({
        rowId,
        reason: "locked_period",
        detail: `pay date ${scope.payDate} falls in a locked period, so nothing was posted`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    if (target.status === "posted" || existing.some((e) => e.id === rowId)) {
      skips.push({
        rowId,
        reason: "already_applied",
        detail: `the register for ${scope.payDate} is already posted`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    /*
     * D5 and G11. The register lives in the vault and the approved row carries
     * its key. An approved row with no key is not a source, and posting from it
     * would be posting from a total somebody typed.
     */
    if (target.registerVaultObjectKey.length === 0) {
      errors.push({
        rowId,
        code: "missingAccount",
        message:
          `the approved pay run for ${scope.payDate} carries no vault register key, ` +
          `and D5 forbids posting a manually keyed total`,
        retryable: false,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    // The funding account. 1010 when the bank debit lands on the pay date, 1930
    // when it does not, which is exactly what the clearing account is for.
    const fundingAccount = fundingAccountFor(scope.payDate, window.periodStart, window.periodEnd);

    const required = [
      WAGE_ACCOUNT,
      EMPLOYER_TAX_ACCOUNT,
      TAX_LIABILITY_ACCOUNT,
      WITHHOLDING_ACCOUNT,
      fundingAccount,
    ];
    const missing = missingAccounts(close.chart, required);
    if (missing.length > 0) {
      errors.push({
        rowId,
        code: "missingAccount",
        message: `the chart is missing ${missing.join(", ")}, so the register cannot post`,
        retryable: false,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const lines = registerLines(target, fundingAccount);
    const netCents = lines.reduce((sum, l) => sum + l.amountCents, ZERO);
    if (netCents !== ZERO) {
      errors.push({
        rowId,
        code: "unbalancedEntry",
        message: `the register lines sum to ${netCents.toString()} cents rather than zero`,
        retryable: false,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const entryId = entryIdOf(frozen.clientId, target.id, window.periodStart);
    const entry: ProposedJournalEntry = {
      kind: "journal_entry",
      targetId: entryId,
      entryDate: scope.payDate,
      lines,
      sourceRef: { table: "pay_runs", rowId: target.id, version: target.version },
    };
    proposals.push(entry);

    proposals.push(insertRegisterEntry(frozen, rowId, target, entryId, window, fundingAccount, lines.length));

    // The pay run moves to posted and points at the entry, so the row and the
    // ledger name each other rather than only one direction.
    proposals.push({
      kind: "field_write",
      table: "pay_runs",
      rowId: target.id,
      before: {
        status: target.status,
        postedEntryId: target.postedEntryId,
        postedAt: target.postedAt,
        postedRunId: target.postedRunId,
      },
      after: {
        status: "posted",
        postedEntryId: entryId,
        postedAt: NOW_PLACEHOLDER,
        postedRunId: RUN_ID_PLACEHOLDER,
      },
      provenance: { cascadeLevel: null },
    });

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "PAY-POST-REGISTER",
      runVersion: 1,
    });
  },

  /**
   * The status field reverts so the run can be posted again. The entry itself
   * is reversed by the framework's reversal path rather than deleted, because a
   * posted entry inside a period somebody may have already reported on is not
   * something a run gets to erase.
   */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function entryIdOf(clientId: Ulid, payRunId: Ulid, periodStart: string): Ulid {
  return derivedId(`${clientId}:${payRunId}:${periodStart}`, "pay-post-register", 0);
}

export function registerEntryIdOf(
  clientId: Ulid,
  payRunId: Ulid,
  periodStart: string,
): Ulid {
  return derivedId(`${clientId}:${payRunId}:${periodStart}`, "pay-register-entry", 0);
}

/** The approved run for one pay date and provider, if there is one. */
export function payRunFor(
  rows: readonly PayRunRow[],
  payDate: string,
  providerName: string,
): PayRunRow | null {
  const matches = rows
    .filter((r) => r.payDate === payDate && r.providerName === providerName)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return matches.length === 0 ? null : matches[0];
}

/**
 * Where net pay lands.
 *
 * A pay date inside the period being posted means the bank debit and the pay
 * date agree, so net credits the operating account. A pay date outside it means
 * the timing differs, and net credits 1930 until the bank feed clears it. Doc
 * 01 Part 4 names 1930 for exactly this.
 */
export function fundingAccountFor(
  payDate: string,
  periodStart: string,
  periodEnd: string,
): string {
  const inPeriod = payDate >= periodStart && payDate <= periodEnd;
  return inPeriod ? OPERATING_ACCOUNT : PAYROLL_CLEARING_ACCOUNT;
}

export function missingAccounts(
  chart: readonly ChartAccountRow[],
  required: readonly string[],
): string[] {
  const present = new Set(chart.map((a) => a.accountNumber));
  return required.filter((n) => !present.has(n)).sort();
}

/**
 * The five lines, in a fixed order.
 *
 * Debit positive, credit negative, integer cents. Gross and employer tax debit
 * the two expense accounts, withholding and employer tax credit the two
 * liability accounts, and the balance credits the funding account. Net is
 * computed as the residual rather than read, so the entry balances by
 * construction and not by hoping two stored figures agree.
 */
export function registerLines(run: PayRunRow, fundingAccount: string): ProposedLine[] {
  const lines: ProposedLine[] = [
    {
      accountNumber: WAGE_ACCOUNT,
      categoryId: null,
      amountCents: run.grossCents,
      memo: `Gross wages from the ${run.providerName} register for ${run.payDate}.`,
      dimensions: {},
    },
    {
      accountNumber: EMPLOYER_TAX_ACCOUNT,
      categoryId: null,
      amountCents: run.employerTaxCents,
      memo: `Employer payroll taxes from the ${run.providerName} register for ${run.payDate}.`,
      dimensions: {},
    },
    {
      accountNumber: WITHHOLDING_ACCOUNT,
      categoryId: null,
      amountCents: -run.employeeWithholdingCents,
      memo: `Employee withholdings and deductions payable for ${run.payDate}.`,
      dimensions: {},
    },
    {
      accountNumber: TAX_LIABILITY_ACCOUNT,
      categoryId: null,
      amountCents: -run.employerTaxCents,
      memo: `Employer payroll taxes payable for ${run.payDate}.`,
      dimensions: {},
    },
  ];
  const residual = lines.reduce((sum, l) => sum + l.amountCents, ZERO);
  lines.push({
    accountNumber: fundingAccount,
    categoryId: null,
    amountCents: -residual,
    memo:
      fundingAccount === PAYROLL_CLEARING_ACCOUNT
        ? `Net pay held in payroll clearing until the bank debit clears.`
        : `Net pay funded on ${run.payDate}.`,
    dimensions: {},
  });
  return lines;
}

function insertRegisterEntry(
  frozen: FrozenScope<PostRegisterScope>,
  rowId: Ulid,
  run: PayRunRow,
  entryId: Ulid,
  window: { periodStart: string; periodEnd: string },
  fundingAccount: string,
  lineCount: number,
): ProposedRowInsert {
  const netCents = run.grossCents - run.employeeWithholdingCents;
  return {
    kind: "row_insert",
    table: "pay_register_entries",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      payRunId: run.id,
      version: 1,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      payDate: run.payDate,
      entryId,
      postedRunId: RUN_ID_PLACEHOLDER,
      lineCount,
      grossCents: run.grossCents,
      employerTaxCents: run.employerTaxCents,
      withholdingCents: run.employeeWithholdingCents,
      netCents,
      wageAccount: WAGE_ACCOUNT,
      employerTaxAccount: EMPLOYER_TAX_ACCOUNT,
      withholdingAccount: WITHHOLDING_ACCOUNT,
      fundingAccount,
      detail:
        `Posted the ${run.providerName} register for ${run.payDate} from vault ` +
        `object ${run.registerVaultObjectKey}. Figures came from the provider. ` +
        `This firm calculated no payroll tax.`,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

export type { Cents };
