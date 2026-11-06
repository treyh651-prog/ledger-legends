/**
 * CFG-CREATE-SUBSTANTIATION-RECORD, version 1.
 *
 * Audit fix, 2026-11-06 (problem 8, found while wiring a UI for payroll
 * approval). close.substantiation_records has had a real insert case in
 * apply-writer.ts since before this round -- confirmed by reading the
 * file directly, `case "substantiation_records":` already existed -- but
 * grepping the whole run registry for `table: "substantiation_records"`
 * found zero callers. Nothing ever wrote the first row. close-shared.ts's
 * own recordSource() has looked up a record by (kind, accountNumber) for
 * as long as the close gates have existed; every test exercising G06
 * (inventory) or G10 (payroll) seeds the row directly rather than through
 * any run, the same tell the action audit's methodology section
 * describes for every other finding in this campaign. PAY-APPROVE-RUN's
 * own precondition -- "a payroll register is linked in the vault for the
 * period" -- could never be satisfied from the real app as a result.
 *
 * sourceRef is the vault object key a document upload already produced
 * (DOC-RECORD-UPLOAD's own row id, or any other stable reference a firm
 * types in); this run does not touch the vault itself, the same
 * reasoning PAY-APPROVE-RUN's own header gives for reading the register
 * key "by reference, not a second document row."
 *
 * The natural key is (clientId, period, kind, accountNumber) -- the exact
 * tuple recordSource() looks up by. A second create for the same tuple is
 * a no-op: correcting an existing record is a future edit run's job, not
 * this one's, same "don't retrofit edit, just don't inherit the gap"
 * reasoning every other CFG-CREATE-* run in this file gives.
 *
 * Manual tier: a person counted the inventory or pulled the payroll
 * register, and writing down what they found and where it is filed is a
 * decision a person makes once.
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
import { ACTOR_PLACEHOLDER, applyProposals, requireTx } from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";
import { periodWindow } from "./per-shared";
import { normalSideOf } from "./close-shared";

export const newSubstantiationRecordFieldsSchema = z.object({
  kind: z.enum(["inventory_count", "payroll_register", "other"]),
  accountNumber: z.string().regex(/^[0-9]{4}$/),
  // A magnitude, the way a person reads it off a count sheet or a
  // register total -- never signed. close-shared.ts's own blockTieGate
  // compares this against balanceOf()'s debit-positive/credit-negative
  // ledger convention, so propose() below signs it from the account's
  // own normal side (normalSideOf), the same derivation every other run
  // in this codebase uses rather than trusting a caller's sign.
  supportedBalanceCents: z.number().int().nonnegative().safe(),
  sourceRef: z.string().min(1).nullable().default(null),
  preparedOn: z.string().min(10).nullable().default(null),
});

export const createSubstantiationRecordScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  fields: newSubstantiationRecordFieldsSchema,
});

export type CreateSubstantiationRecordScope = z.infer<typeof createSubstantiationRecordScopeSchema>;

export const ERR_SUBSTANTIATION_UNKNOWN_ACCOUNT = "CFG-SUBSTANTIATION-UNKNOWN-ACCOUNT";

export function substantiationRecordIdFor(
  clientId: string,
  periodStart: string,
  fields: Pick<z.infer<typeof newSubstantiationRecordFieldsSchema>, "kind" | "accountNumber">,
): string {
  return derivedId(`${clientId}:${periodStart}:${fields.kind}:${fields.accountNumber}`, "cfg-create-substantiation-record", 0);
}

export const cfgCreateSubstantiationRecord: Run<CreateSubstantiationRecordScope, Proposal> = {
  type: "CFG-CREATE-SUBSTANTIATION-RECORD",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:substantiation:${scope.period.slice(0, 7)}:${scope.fields.kind}:${scope.fields.accountNumber}`,
  scopeSchema: createSubstantiationRecordScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateSubstantiationRecordScope>> {
    const window = periodWindow(scope.period);
    const candidateIds = [substantiationRecordIdFor(scope.clientId, window.periodStart, scope.fields)];
    const versions = [{ id: "CFG-CREATE-SUBSTANTIATION-RECORD", version: 1 }];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const id = substantiationRecordIdFor(scope.clientId, frozen.periodStart, scope.fields);

    const existing = await tx.query("substantiation_records_for_period", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      periodStart: frozen.periodStart,
    });
    if (existing.some((r) => r.id === id)) {
      return makeResult<Proposal>(
        1,
        [],
        [{
          rowId: id,
          reason: "already_applied",
          detail: `a ${scope.fields.kind} record already exists for account ${scope.fields.accountNumber} in ${frozen.periodStart}`,
        }],
        [],
        BigInt(0),
      );
    }

    const chart = await tx.query("chart_accounts_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    if (!chart.some((a) => a.accountNumber === scope.fields.accountNumber)) {
      errors.push({
        rowId: id,
        code: ERR_SUBSTANTIATION_UNKNOWN_ACCOUNT,
        message: `account ${scope.fields.accountNumber} is not on client ${scope.clientId}'s chart`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const magnitude = BigInt(scope.fields.supportedBalanceCents);
    const signedBalance = normalSideOf(scope.fields.accountNumber) === "credit" ? -magnitude : magnitude;

    const row: Record<string, unknown> = {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      version: 1,
      kind: scope.fields.kind,
      accountNumber: scope.fields.accountNumber,
      periodStart: frozen.periodStart,
      periodEnd: frozen.periodEnd,
      supportedBalanceCents: signedBalance,
      sourceRef: scope.fields.sourceRef,
      preparedBy: ACTOR_PLACEHOLDER,
      preparedOn: scope.fields.preparedOn,
      manualOverride: false,
    };

    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "substantiation_records",
      rowId: id,
      row,
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [insert], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-CREATE-SUBSTANTIATION-RECORD", runVersion: 1 });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
