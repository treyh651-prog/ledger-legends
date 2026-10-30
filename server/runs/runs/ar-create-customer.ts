/**
 * AR-CREATE-CUSTOMER. Add a receivable counterparty to a client's books.
 *
 * Not one of doc 02's documented module 5 runs. Migration 0014 built the
 * receivable subledger on the assumption that a customer already existed on
 * the books by the time any of the six module 5 runs touched it, so nothing
 * in the original spec ever inserts one. A firm onboarding a client with real
 * customers had no way to record a single one through the app. This run
 * closes that gap the plain way: one insert into subledger.customers, nothing
 * posted, nothing else touched, so every run that reads customers_for_client
 * afterward sees a normal row it cannot tell apart from one the spec itself
 * produced.
 *
 * Manual tier: naming a new customer is a decision a person makes once, on
 * purpose, and a clock has no customer of its own to discover.
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
  type Skip,
  type Ulid,
} from "../contract";
import { ACTOR_PLACEHOLDER, applyProposals, requireTx } from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";
import type { CustomerRow } from "../tables";

export const createCustomerScopeSchema = z.object({
  clientId: z.string().min(1),
  name: z.string().min(1),
  lateFeeEnabled: z.boolean().default(false),
  annualizedRateBp: z.number().int().min(0).max(1000000).nullable().default(null),
  graceDays: z.number().int().min(0).nullable().default(null),
});

export type CreateCustomerScope = z.infer<typeof createCustomerScopeSchema>;

/** Stable id. Same client and name give the same customer every time. */
export function customerIdFor(clientId: Ulid, name: string): Ulid {
  return derivedId(`${clientId}:${name}`, "ar-create-customer", 0);
}

export const arCreateCustomer: Run<CreateCustomerScope, Proposal> = {
  type: "AR-CREATE-CUSTOMER",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:ar-create-customer:${scope.name}`,
  scopeSchema: createCustomerScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<CreateCustomerScope>> {
    const tx = requireTx(ctx);
    const existing = await tx.query("customers_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const customerId = customerIdFor(scope.clientId, scope.name);
    const candidateIds = [customerId];
    const versions = [
      { id: "AR-CREATE-CUSTOMER", version: 1 },
      ...existing.map((c) => ({ id: c.id, version: c.version })),
    ];
    const runDay = ctx.now.toISOString().slice(0, 10);
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      // Adding a customer has no accounting period of its own.
      periodStart: runDay,
      periodEnd: runDay,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: existing.filter((c) => c.manualOverride).map((c) => c.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const customerId = customerIdFor(frozen.clientId, scope.name);
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const existing = await tx.query("customers_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (existing.some((c) => c.id === customerId)) {
      skips.push({
        rowId: customerId,
        reason: "already_applied",
        detail: `a customer named ${scope.name} already exists for this client`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }
    // The store refuses a fee switched on with nothing to compute it from
    // (cust_fee_inputs). A named error here is more useful than the bare
    // constraint name a blind insert would surface.
    if (scope.lateFeeEnabled && scope.annualizedRateBp === null) {
      errors.push({
        rowId: customerId,
        code: "LATE_FEE_NEEDS_A_RATE",
        message:
          "lateFeeEnabled is true but annualizedRateBp is null, so no fee could ever be computed",
        retryable: false,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const row: CustomerRow = {
      id: customerId,
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      name: scope.name,
      isActive: true,
      statementSuppressed: false,
      statementType: null,
      applicationPreference: "oldest_first",
      lateFeeEnabled: scope.lateFeeEnabled,
      annualizedRateBp: scope.annualizedRateBp,
      graceDays: scope.graceDays,
      flatFeeCents: null,
      lateFeeExempt: false,
      doNotPursue: false,
      paymentPlanActive: false,
      statementDocumentId: null,
      statementDocumentDate: null,
      manualOverride: false,
      createdBy: ACTOR_PLACEHOLDER,
    };

    const proposal: ProposedRowInsert = {
      kind: "row_insert",
      table: "customers",
      rowId: customerId,
      row: row as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [proposal], skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "AR-CREATE-CUSTOMER",
      runVersion: 1,
    });
  },

  /**
   * No undo. A customer with invoices or payments against it cannot be
   * un-created, and one with none is harmless to leave; doc 03 Part 6's undo
   * contract covers reverting a run's effects, not deleting a party.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
