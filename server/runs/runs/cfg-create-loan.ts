/**
 * CFG-CREATE-LOAN, version 1.
 *
 * Audit fix, 2026-11-06 (problem 7, one of seven missing setup-data
 * creators). subledger.loans and subledger.loan_schedule have carried
 * their full doc 04 Part 7 shape since migration 0005, and
 * PER-SPLIT-LOANPAYMENT has always been able to read a schedule that
 * exists -- but apply-writer.ts had no insert case for either table.
 *
 * Unlike a prepaid's deferral schedule (PER-AMORTIZE-PREPAIDS builds its
 * own lines the first time it runs, because every period is equal except
 * the last), a loan's amortization table is never generated here.
 * PER-SPLIT-LOAN's own header comment is explicit that it never recomputes
 * interest from a rate, because "a lender rounds its own way" -- the
 * schedule this run writes has to be the lender's actual table, payment by
 * payment, not an approximation this engine derives from
 * annualRateBps/termMonths. scheduleLines is therefore required input, not
 * computed, the same reasoning SETUP-IMPORT-BALANCES gives for taking real
 * opening balance lines rather than deriving them.
 *
 * principalAccountLt/interestAccount (required) and
 * principalAccountCp/fundingAccount/escrowAccount (optional, only checked
 * when given) are each checked against the client's real chart. Every
 * schedule line's four components (principal, interest, escrow, fees) must
 * sum to exactly that line's payment, and payment numbers must run 1..N
 * with no gap -- PER-SPLIT-LOAN trusts the stored table completely, so a
 * line that does not foot would silently misstate every payment it splits.
 *
 * Manual tier: entering a real lender's note and amortization table is a
 * one time setup decision, the same reasoning every other CFG-CREATE-*
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

const scheduleLineFieldsSchema = z.object({
  paymentNumber: z.number().int().positive(),
  dueDate: z.string().min(10),
  paymentCents: z.number().int().nonnegative().safe(),
  principalCents: z.number().int().nonnegative().safe(),
  interestCents: z.number().int().nonnegative().safe(),
  escrowCents: z.number().int().nonnegative().safe().default(0),
  feesCents: z.number().int().nonnegative().safe().default(0),
  balanceAfterCents: z.number().int().nonnegative().safe(),
});

export const newLoanFieldsSchema = z.object({
  lenderName: z.string().min(1),
  loanType: z.string().min(1),
  principalAccountLt: z.string().regex(/^[0-9]{4}$/),
  principalAccountCp: z.string().regex(/^[0-9]{4}$/).nullable().default(null),
  interestAccount: z.string().regex(/^[0-9]{4}$/),
  fundingAccount: z.string().regex(/^[0-9]{4}$/).nullable().default(null),
  escrowAccount: z.string().regex(/^[0-9]{4}$/).nullable().default(null),
  originalPrincipalCents: z.number().int().positive().safe(),
  originationDate: z.string().min(10),
  firstPaymentDate: z.string().min(10),
  termMonths: z.number().int().positive(),
  annualRateBps: z.number().int().nonnegative(),
  paymentCents: z.number().int().positive().safe().nullable().default(null),
  balloonCents: z.number().int().nonnegative().safe().default(0),
  rateType: z.enum(["fixed", "variable"]),
  // The lender's own table, required: see this file's own header for why
  // nothing here computes one from a rate.
  scheduleLines: z.array(scheduleLineFieldsSchema).min(1),
});

export const createLoanScopeSchema = z.object({
  clientId: z.string().min(1),
  fields: newLoanFieldsSchema,
});

export type CreateLoanScope = z.infer<typeof createLoanScopeSchema>;

export const ERR_LOAN_UNKNOWN_ACCOUNT = "CFG-LOAN-UNKNOWN-ACCOUNT";
export const ERR_LOAN_SCHEDULE_NUMBERING = "CFG-LOAN-SCHEDULE-NUMBERING";
export const ERR_LOAN_SCHEDULE_UNBALANCED = "CFG-LOAN-SCHEDULE-UNBALANCED";
export const ERR_LOAN_SCHEDULE_LENGTH = "CFG-LOAN-SCHEDULE-LENGTH";

export function loanIdFor(clientId: string, fields: z.infer<typeof newLoanFieldsSchema>): string {
  return derivedId(`${clientId}:${canonicalJson(fields)}`, "cfg-create-loan", 0);
}

export function loanScheduleIdFor(loanId: string, paymentNumber: number): string {
  return derivedId(`${loanId}:${paymentNumber}`, "cfg-create-loan", 0);
}

export const cfgCreateLoan: Run<CreateLoanScope, Proposal> = {
  type: "CFG-CREATE-LOAN",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:loan:${loanIdFor(scope.clientId, scope.fields)}`,
  scopeSchema: createLoanScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateLoanScope>> {
    const loanId = loanIdFor(scope.clientId, scope.fields);
    const candidateIds = [
      loanId,
      ...scope.fields.scheduleLines.map((l) => loanScheduleIdFor(loanId, l.paymentNumber)),
    ];
    const versions = [{ id: "CFG-CREATE-LOAN", version: 1 }];
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
    const loanId = loanIdFor(scope.clientId, scope.fields);

    const existing = await tx.query("loans_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    if (existing.some((l) => l.id === loanId)) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: loanId, reason: "already_applied", detail: "an identical loan has already been created for this client" }],
        [],
        BigInt(0),
      );
    }

    const chart = await tx.query("chart_accounts_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const knownNumbers = new Set(chart.map((a) => a.accountNumber));
    const accountsToCheck: Array<[string, string | null]> = [
      ["long term principal", scope.fields.principalAccountLt],
      ["interest", scope.fields.interestAccount],
      ["current portion principal", scope.fields.principalAccountCp],
      ["funding", scope.fields.fundingAccount],
      ["escrow", scope.fields.escrowAccount],
    ];
    for (const [label, number] of accountsToCheck) {
      if (number !== null && !knownNumbers.has(number)) {
        errors.push({
          rowId: loanId,
          code: ERR_LOAN_UNKNOWN_ACCOUNT,
          message: `${label} account ${number} is not on client ${scope.clientId}'s chart`,
          retryable: false,
        });
      }
    }
    if (errors.length > 0) return makeResult<Proposal>(1, [], [], errors, BigInt(0));

    if (scope.fields.scheduleLines.length !== scope.fields.termMonths) {
      errors.push({
        rowId: loanId,
        code: ERR_LOAN_SCHEDULE_LENGTH,
        message: `the schedule has ${scope.fields.scheduleLines.length} payments but the term is ${scope.fields.termMonths} months`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const sorted = [...scope.fields.scheduleLines].sort((a, b) => a.paymentNumber - b.paymentNumber);
    for (let i = 0; i < sorted.length; i++) {
      const line = sorted[i];
      if (line.paymentNumber !== i + 1) {
        errors.push({
          rowId: loanId,
          code: ERR_LOAN_SCHEDULE_NUMBERING,
          message: `payment numbers must run 1..${sorted.length} with no gap; found ${line.paymentNumber} at position ${i + 1}`,
          retryable: false,
        });
        return makeResult<Proposal>(1, [], [], errors, BigInt(0));
      }
      const sum = line.principalCents + line.interestCents + line.escrowCents + line.feesCents;
      if (sum !== line.paymentCents) {
        errors.push({
          rowId: loanId,
          code: ERR_LOAN_SCHEDULE_UNBALANCED,
          message: `payment ${line.paymentNumber}: principal + interest + escrow + fees (${sum}) does not equal the payment amount (${line.paymentCents})`,
          retryable: false,
        });
        return makeResult<Proposal>(1, [], [], errors, BigInt(0));
      }
    }

    const loanRow: Record<string, unknown> = {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      lenderName: scope.fields.lenderName,
      loanType: scope.fields.loanType,
      principalAccountLt: scope.fields.principalAccountLt,
      principalAccountCp: scope.fields.principalAccountCp,
      interestAccount: scope.fields.interestAccount,
      fundingAccount: scope.fields.fundingAccount,
      escrowAccount: scope.fields.escrowAccount,
      originalPrincipalCents: BigInt(scope.fields.originalPrincipalCents),
      originationDate: scope.fields.originationDate,
      firstPaymentDate: scope.fields.firstPaymentDate,
      termMonths: scope.fields.termMonths,
      annualRateBps: scope.fields.annualRateBps,
      paymentCents: scope.fields.paymentCents === null ? null : BigInt(scope.fields.paymentCents),
      balloonCents: BigInt(scope.fields.balloonCents),
      rateType: scope.fields.rateType,
      status: "active",
      payoffDate: null,
      manualOverride: false,
      version: 1,
    };

    const proposals: Proposal[] = [
      {
        kind: "row_insert",
        table: "loans",
        rowId: loanId,
        row: loanRow,
        provenance: { cascadeLevel: null },
      },
    ];

    for (const line of sorted) {
      proposals.push({
        kind: "row_insert",
        table: "loan_schedule",
        rowId: loanScheduleIdFor(loanId, line.paymentNumber),
        row: {
          firmId: ctx.firmId,
          clientId: scope.clientId,
          loanId,
          scheduleVersion: 1,
          paymentNumber: line.paymentNumber,
          dueDate: line.dueDate,
          paymentCents: BigInt(line.paymentCents),
          principalCents: BigInt(line.principalCents),
          interestCents: BigInt(line.interestCents),
          escrowCents: BigInt(line.escrowCents),
          feesCents: BigInt(line.feesCents),
          balanceAfterCents: BigInt(line.balanceAfterCents),
          status: "scheduled",
          matchedTransactionId: null,
          postedEntryId: null,
          postedRunId: null,
          postedAt: null,
          manualOverride: false,
          version: 1,
        },
        provenance: { cascadeLevel: null },
      });
    }

    return makeResult<Proposal>(1, proposals, [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-LOAN", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    // Every proposal here is an insert of a row with no prior value;
    // inserts never revert in this framework.
    return [];
  },
};
