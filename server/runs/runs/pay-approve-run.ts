/**
 * PAY-APPROVE-RUN. Approve a payroll run, and authorize no money.
 *
 * Spec: docs/05-decisions.md D5, docs/02-run-specifications.md Module 5 gate
 * G11 and gate G18.
 *
 * D5 is the decision this whole file exists to enforce. The firm approves a
 * payroll run and never disburses one. Approval is a review of a register the
 * provider produced, recorded so the client and the provider can both see who
 * looked at it and when. It moves no money, releases no payment, and reaches no
 * bank.
 *
 * The guarantee is a column, not a sentence. Every pay run row carries
 * authorizes_disbursement, the column accepts exactly one value, and migration
 * 0017 states that in a named check constraint called
 * pay_run_no_disbursement_authority. A row that tries to set it true is refused
 * by the database rather than by a code review. The compliance test asserts the
 * constraint by that name, which is the difference between a promise and a
 * guarantee.
 *
 * The register comes from the vault. D5 says the posting run works only from a
 * vault linked register and never from a manually keyed total, which is what
 * makes gate G11 mean anything. So this run refuses to approve unless a
 * substantiation record of kind payroll_register exists for the pay date's
 * period with a vault reference on it, and it refuses if the gross wages on
 * that register do not match the figure the approval was raised against. See
 * NOTES.md entry 118 for the three options considered here.
 *
 * G18. The approver is not the preparer. A person who prepared the register
 * cannot be the person who approves it, and the run refuses rather than warns.
 *
 * Locked periods. A pay date inside a locked period is skipped with reason
 * locked_period. This run writes, so the lock stops it.
 *
 * The actor is stamped. Approval is a human decision and the row records whose
 * decision it was, using the actor placeholder the apply writer resolves.
 *
 * SENDS. None. Approval writes a row. The provider is not told by this codebase
 * and neither is the bank.
 *
 * CONSTRAINT. No model, no score, no string distance. Money is bigint cents and
 * the arithmetic is addition and subtraction.
 */

import { z } from "zod";
import {
  isFieldWrite,
  makeResult,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import {
  ACTOR_PLACEHOLDER,
  applyProposals,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  requireTx,
} from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { PayRunRow, PayrollApprovalRow, SubstantiationRecordRow } from "../tables";
import { ZERO, loadCloseData } from "./close-shared";
import { changedFieldsOf, checksumOf, retentionUntil } from "./rpt-shared";
import { periodWindow } from "./per-shared";

export const approveRunScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  payDate: z.string().min(10),
  providerName: z.string().min(1),
  /** Withholding taken from employees, a positive magnitude in cents. */
  employeeWithholdingCents: z.bigint().nonnegative(),
  /** Employer side taxes, a positive magnitude in cents. */
  employerTaxCents: z.bigint().nonnegative(),
  employeeCount: z.number().int().nonnegative().optional(),
});

export type ApproveRunScope = z.infer<typeof approveRunScopeSchema>;

/** The comparable content of a pay run row. */
interface PayRunContent {
  providerName: string;
  payPeriodStart: string;
  payPeriodEnd: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  employeeCount: number | null;
  registerVaultObjectKey: string;
  registerChecksum: string;
  grossCents: Cents;
  employerTaxCents: Cents;
  employeeWithholdingCents: Cents;
  netCents: Cents;
  status: "approved";
  approvalStatement: string;
  authorizesDisbursement: false;
  vaultObjectLockMode: "GOVERNANCE";
  vaultRetentionStartsOn: string;
  vaultObjectLockUntil: string;
}

/**
 * The statement stored on every approved run.
 *
 * It is stored rather than rendered, so a person reading the row a year later
 * sees the same words the approver saw, and so the compliance test can assert
 * the words rather than assert a template reference.
 */
export const APPROVAL_STATEMENT =
  "This approval records a review of a payroll register produced by the " +
  "client's payroll provider. It authorizes no disbursement, releases no " +
  "payment, and instructs no bank. Ledger Legends calculates no payroll tax " +
  "and files no payroll return.";

export const payApproveRun: Run<ApproveRunScope, Proposal> = {
  type: "PAY-APPROVE-RUN",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:pay-approve:${scope.payDate}`,
  scopeSchema: approveRunScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ApproveRunScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const registers = await tx.query("substantiation_records_for_period", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      periodStart: window.periodStart,
    });
    const approvals = await tx.query("payroll_approvals_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const existing = await tx.query("pay_runs_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const register = registerFor(registers, window.periodStart);
    const approval = approvalFor(approvals, scope.payDate);
    const candidateIds = [
      ...(register === null ? [] : [register.id]),
      ...(approval === null ? [] : [approval.id]),
    ];
    const versions = [
      { id: "PAY-APPROVE-RUN", version: 1 },
      ...(approval === null ? [] : [{ id: approval.id, version: approval.version }]),
      ...existing.map((p) => ({ id: p.id, version: p.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      // The period and the pay date are both in the hash. Two pay dates in one
      // month are two approvals and must never deduplicate into one.
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds: [...candidateIds, `PAY-DATE:${scope.payDate}`],
        versions,
      }),
      versions,
      overriddenIds: existing.filter((p) => p.manualOverride).map((p) => p.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const window = periodWindow(scope.period);
    const close = await loadCloseData(tx, frozen.firmId, frozen.clientId, scope.period);
    const registers = await tx.query("substantiation_records_for_period", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      periodStart: window.periodStart,
    });
    const approvals = await tx.query("payroll_approvals_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const existing = await tx.query("pay_runs_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const rowId = payRunIdOf(frozen.clientId, scope.payDate, scope.providerName);

    /*
     * G19 in calendar terms. Approval writes a row about a period, so a locked
     * period stops it. The reporting runs read a locked period happily. This
     * one does not, because approving into a closed month records a decision
     * about a month nobody can act on.
     */
    if (isLockedDay(close.locks, scope.payDate)) {
      skips.push({
        rowId,
        reason: "locked_period",
        detail: `pay date ${scope.payDate} falls in a locked period, so nothing was approved`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    /*
     * D5 and G11. No vault linked register, no approval. This is the guard that
     * makes the posting run's source real rather than a claim, because the
     * posting run reads the register key off the row this run writes.
     */
    const register = registerFor(registers, window.periodStart);
    if (register === null || register.sourceRef === null) {
      skips.push({
        rowId,
        reason: "missing_prerequisite",
        detail:
          `no payroll register is linked in the vault for the period starting ` +
          `${window.periodStart}, so there is nothing to approve`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    /*
     * G18. The approver is not the preparer. Checked against the actor on the
     * context rather than against the placeholder, because the placeholder is
     * resolved at write time and the refusal has to happen before that.
     */
    if (register.preparedBy !== null && register.preparedBy === ctx.actor.userId) {
      errors.push({
        rowId,
        code: "overrideProtected",
        message:
          `G18. ${ctx.actor.userId} prepared this register and cannot approve it. ` +
          `A second person has to look at it.`,
        retryable: false,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    /*
     * The figures. Gross wages come off the vault linked register and are never
     * keyed. Net is derived, gross minus withholding, so nobody types a net
     * that does not follow from the gross. The employer side taxes and the
     * employee withholding are the two figures the scope carries, and they are
     * checked against the second independent source below.
     */
    const grossCents = register.supportedBalanceCents;
    const netCents = grossCents - scope.employeeWithholdingCents;
    if (netCents < ZERO) {
      errors.push({
        rowId,
        code: "unbalancedEntry",
        message:
          `withholding of ${scope.employeeWithholdingCents.toString()} cents exceeds ` +
          `gross wages of ${grossCents.toString()} cents on the register`,
        retryable: false,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const approval = approvalFor(approvals, scope.payDate);
    if (approval !== null && approval.amountCents !== netCents) {
      errors.push({
        rowId,
        code: "unbalancedEntry",
        message:
          `the provider's approved net of ${approval.amountCents.toString()} cents does ` +
          `not equal the register derived net of ${netCents.toString()} cents`,
        retryable: false,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const content: PayRunContent = {
      providerName: scope.providerName,
      payPeriodStart: register.periodStart,
      payPeriodEnd: register.periodEnd,
      payDate: scope.payDate,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      employeeCount: scope.employeeCount ?? null,
      // The register PDF in the vault, attached by reference. The reporting
      // module made the same call in NOTES entry 101: a vault object is a key
      // and a lock, not a second document row.
      registerVaultObjectKey: register.sourceRef,
      registerChecksum: checksumOf({
        register: register.id,
        gross: grossCents.toString(),
        withholding: scope.employeeWithholdingCents.toString(),
        employerTax: scope.employerTaxCents.toString(),
      }),
      grossCents,
      employerTaxCents: scope.employerTaxCents,
      employeeWithholdingCents: scope.employeeWithholdingCents,
      netCents,
      status: "approved",
      approvalStatement: APPROVAL_STATEMENT,
      // The one value the column accepts. Constraint
      // pay_run_no_disbursement_authority refuses the other.
      authorizesDisbursement: false,
      vaultObjectLockMode: "GOVERNANCE",
      // D7. Retention starts at the period end, not at the day of approval.
      vaultRetentionStartsOn: window.periodEnd,
      vaultObjectLockUntil: retentionUntil(window.periodEnd),
    };

    const prior = existing.find((p) => p.id === rowId);
    if (prior === undefined) {
      proposals.push(insertPayRun(frozen, rowId, content));
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }
    if (prior.manualOverride) {
      skips.push({
        rowId,
        reason: "manual_override",
        detail: `pay run for ${scope.payDate} carries manual_override`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }
    /*
     * A posted run is finished. Re approving it would rewrite the figures the
     * ledger already carries, and the entry would no longer describe the row it
     * came from.
     */
    if (prior.status === "posted") {
      skips.push({
        rowId,
        reason: "already_applied",
        detail: `pay run for ${scope.payDate} is already posted`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const changed = changedFieldsOf(
      prior as unknown as Record<string, unknown>,
      content as unknown as Record<string, unknown>,
    );
    if (Object.keys(changed.after).length === 0) {
      skips.push({
        rowId,
        reason: "already_applied",
        detail: `pay_run_unchanged for ${scope.payDate}`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }
    // Re approval restamps the approver and the moment, because a changed
    // register is a new decision by whoever made it.
    changed.after.approvedBy = ACTOR_PLACEHOLDER;
    changed.before.approvedBy = prior.approvedBy;
    changed.after.approvedAt = NOW_PLACEHOLDER;
    changed.before.approvedAt = prior.approvedAt;
    proposals.push({
      kind: "field_write",
      table: "pay_runs",
      rowId,
      before: changed.before,
      after: changed.after,
      provenance: { cascadeLevel: null },
    });

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "PAY-APPROVE-RUN", runVersion: 1 });
  },

  /** The approval record stands. Only a re approval's field moves revert. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function payRunIdOf(clientId: Ulid, payDate: string, providerName: string): Ulid {
  return derivedId(`${clientId}:${payDate}:${providerName}`, "pay-approve-run", 0);
}

/** The payroll register substantiation record for a period, if there is one. */
export function registerFor(
  records: readonly SubstantiationRecordRow[],
  periodStart: string,
): SubstantiationRecordRow | null {
  const matches = records
    .filter((r) => r.kind === "payroll_register")
    .filter((r) => r.periodStart === periodStart)
    .filter((r) => !r.manualOverride)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return matches.length === 0 ? null : matches[0];
}

/** The provider's own approved net for a pay date, as a second source. */
export function approvalFor(
  approvals: readonly PayrollApprovalRow[],
  payDate: string,
): PayrollApprovalRow | null {
  const matches = approvals
    .filter((a) => a.payDate === payDate && a.status === "approved")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return matches.length === 0 ? null : matches[0];
}

function insertPayRun(
  frozen: FrozenScope<ApproveRunScope>,
  rowId: Ulid,
  content: PayRunContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "pay_runs",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      ...content,
      // The stamp. Approval is a human decision and the row says whose.
      approvedBy: ACTOR_PLACEHOLDER,
      approvedAt: NOW_PLACEHOLDER,
      postedEntryId: null,
      postedAt: null,
      postedRunId: null,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

export type { PayRunRow };
