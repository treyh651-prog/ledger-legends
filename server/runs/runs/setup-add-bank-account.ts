/**
 * SETUP-ADD-BANK-ACCOUNT. Put the first bank or card account on a client's books.
 *
 * Not one of doc 02's documented runs, for the same reason AR-CREATE-CUSTOMER
 * and REC-IMPORT-STATEMENT are not: IMPORT-PARSE-FEED's own scope requires an
 * existing bankAccountId belonging to the client, and nothing in the original
 * run set, and nothing in apply-writer's insert table, ever creates one. A
 * client with a chart and a draft engagement had no way to record a single
 * bank or card account, which means the import pipeline, the coding cascade,
 * and all of module 3 reconciliation were unreachable from the real app for
 * every client, not only a new one.
 *
 * ledger.bank_accounts carries a foreign key to ledger.accounts on
 * (client_id, account_number), so the account this feeds has to already be
 * on the chart; the run refuses rather than let the insert fail on a bare
 * constraint name.
 *
 * Idempotent on (clientId, accountNumber): a chart account ordinarily feeds
 * exactly one bank or card account, so a second add naming the same chart
 * account is reported rather than creating a duplicate.
 *
 * Manual tier: naming a bank account and which chart account it feeds is a
 * one time setup decision, the same reasoning SETUP-IMPORT-BALANCES gives for
 * the opening entry, and a clock has no account of its own to discover.
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

export const addBankAccountScopeSchema = z.object({
  clientId: z.string().min(1),
  accountNumber: z.string().regex(/^[0-9]{4}$/),
  nickname: z.string().min(1),
  kind: z.enum(["bank", "card"]).default("bank"),
  institutionName: z.string().min(1),
});

export type AddBankAccountScope = z.infer<typeof addBankAccountScopeSchema>;

export function bankAccountIdFor(clientId: Ulid, accountNumber: string): Ulid {
  return derivedId(`${clientId}:${accountNumber}`, "setup-add-bank-account", 0);
}

export const setupAddBankAccount: Run<AddBankAccountScope, Proposal> = {
  type: "SETUP-ADD-BANK-ACCOUNT",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:setup-add-bank-account:${scope.accountNumber}`,
  scopeSchema: addBankAccountScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<AddBankAccountScope>> {
    const tx = requireTx(ctx);
    const existing = await tx.query("bank_accounts_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const bankAccountId = bankAccountIdFor(scope.clientId, scope.accountNumber);
    const candidateIds = [bankAccountId];
    const versions = [
      { id: "SETUP-ADD-BANK-ACCOUNT", version: 1 },
      ...existing.map((a) => ({ id: a.id, version: 1 })),
    ];
    const runDay = ctx.now.toISOString().slice(0, 10);
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: runDay,
      periodEnd: runDay,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const bankAccountId = bankAccountIdFor(frozen.clientId, scope.accountNumber);
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const existing = await tx.query("bank_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (existing.some((a) => a.id === bankAccountId)) {
      skips.push({
        rowId: bankAccountId,
        reason: "already_applied",
        detail: `a bank or card account already feeds chart account ${scope.accountNumber} for this client`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const accounts = await tx.query("chart_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (!accounts.some((a) => a.accountNumber === scope.accountNumber)) {
      errors.push({
        rowId: bankAccountId,
        code: "ACCOUNT_NOT_ON_CHART",
        message: `account ${scope.accountNumber} is not on the client's chart`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const row: Record<string, unknown> = {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      accountNumber: scope.accountNumber,
      nickname: scope.nickname,
      kind: scope.kind,
      institutionName: scope.institutionName,
      institutionId: null,
      maskLast4: null,
      currency: "USD",
      isProcessorDestination: false,
      amountToleranceCents: BigInt(0),
      isActive: true,
      openedOn: null,
      closedOn: null,
      createdBy: ACTOR_PLACEHOLDER,
    };

    const proposal: ProposedRowInsert = {
      kind: "row_insert",
      table: "bank_accounts",
      rowId: bankAccountId,
      row,
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [proposal], skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "SETUP-ADD-BANK-ACCOUNT",
      runVersion: 1,
    });
  },

  /**
   * No undo. A bank account that has already received an import batch or a
   * reconciliation batch cannot be quietly un-created, and one with neither
   * is harmless to leave; closing it is a separate, later decision this run
   * version does not implement.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
