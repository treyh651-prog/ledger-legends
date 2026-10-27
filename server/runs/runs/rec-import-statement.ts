/**
 * REC-IMPORT-STATEMENT. Record the bank's own lines for one statement.
 *
 * Not one of doc 02 module 3's three documented runs. REC-MATCH-TIERED's own
 * header says "the statement has already been imported. Its lines are in
 * ledger.statement_lines" and reads them, but nothing in the original run set
 * ever puts them there: the import pipeline (IMPORT-PARSE-FEED,
 * IMPORT-COMMIT-BATCH) produces register rows, the book's own side of a
 * reconciliation, and never touches statement_lines at all. A firm that
 * wanted to reconcile a real statement had no way to record the bank's side
 * of it. This run is that missing door: it writes exactly what the bank
 * statement says, nothing more, so REC-MATCH-TIERED has something to compare
 * the register against.
 *
 * One statement, one call. statementId is supplied rather than derived,
 * because REC-MATCH-TIERED and REC-CLEAR-MATCHED both take the same
 * statementId on their own scopes and the three runs have to agree on what it
 * names. A repeat call naming a statementId that already has lines changes
 * nothing: the whole import is reported already done rather than appended to,
 * because a bank statement is a closed document and a second file under the
 * same id is either the same statement again or a mistake, never an addition.
 *
 * Posting: none. writesLedger is false and no open period is required, for
 * the same reason IMPORT-PARSE-FEED needs neither: a statement line is a fact
 * about what the bank says, not an entry in the client's own books.
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
import { applyProposals, requireTx } from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";
import type { StatementLineRow } from "../tables";

const statementLineInputSchema = z.object({
  statementDate: z.string().min(10),
  /** Signed integer cents. Debit negative on the bank's own side, matching ledger.transactions. */
  amountCents: z.string().regex(/^-?[0-9]+$/),
  description: z.string().min(1),
  normalizedVendor: z.string().nullable().default(null),
  checkNumber: z.string().nullable().default(null),
});

export const importStatementScopeSchema = z.object({
  clientId: z.string().min(1),
  bankAccountId: z.string().min(1),
  statementId: z.string().min(1),
  sourceFormat: z.enum(["csv", "ofx", "qfx", "qbo", "xlsx"]),
  lines: z.array(statementLineInputSchema).min(1),
});

export type ImportStatementScope = z.infer<typeof importStatementScopeSchema>;

export function statementLineIdFor(statementId: Ulid, index: number): Ulid {
  return derivedId(statementId, "rec-import-statement", index);
}

export const recImportStatement: Run<ImportStatementScope, Proposal> = {
  type: "REC-IMPORT-STATEMENT",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.bankAccountId}:${scope.statementId}`,
  scopeSchema: importStatementScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ImportStatementScope>> {
    const tx = requireTx(ctx);
    const accounts = await tx.query("bank_accounts_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const existing = await tx.query("statement_lines_for_statement", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      bankAccountId: scope.bankAccountId,
      statementId: scope.statementId,
    });
    const candidateIds = scope.lines.map((_, i) => statementLineIdFor(scope.statementId, i));
    const versions = [
      { id: "REC-IMPORT-STATEMENT", version: 1 },
      ...accounts.filter((a) => a.id === scope.bankAccountId).map((a) => ({ id: a.id, version: 1 })),
      ...existing.map((l) => ({ id: l.id, version: l.version })),
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
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const candidateCount = scope.lines.length;

    const accounts = await tx.query("bank_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (!accounts.some((a) => a.id === scope.bankAccountId)) {
      errors.push({
        rowId: null,
        code: "UNKNOWN_BANK_ACCOUNT",
        message: `bank account ${scope.bankAccountId} does not belong to client ${frozen.clientId}`,
        retryable: false,
      });
      return makeResult<Proposal>(candidateCount, [], skips, errors, BigInt(0));
    }

    const existing = await tx.query("statement_lines_for_statement", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      bankAccountId: scope.bankAccountId,
      statementId: scope.statementId,
    });
    if (existing.length > 0) {
      skips.push({
        rowId: scope.statementId,
        reason: "already_applied",
        detail: `statement ${scope.statementId} already carries ${String(existing.length)} lines on this account`,
      });
      return makeResult<Proposal>(candidateCount, [], skips, errors, BigInt(0));
    }

    const proposals: Proposal[] = scope.lines.map((line, index) => {
      const row: StatementLineRow = {
        id: statementLineIdFor(scope.statementId, index),
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        bankAccountId: scope.bankAccountId,
        statementId: scope.statementId,
        statementDate: line.statementDate,
        amountCents: BigInt(line.amountCents),
        currency: "USD",
        description: line.description,
        normalizedVendor: line.normalizedVendor,
        checkNumber: line.checkNumber,
        sourceFormat: scope.sourceFormat,
        recBatchId: null,
        matchTier: null,
        matchConfidence: null,
        matchDiffCents: null,
        matchConfirmed: false,
        matchedTransactionId: null,
        matchedTransactionCount: 0,
        matchedByRunId: null,
        version: 1,
      };
      const insert: ProposedRowInsert = {
        kind: "row_insert",
        table: "statement_lines",
        rowId: row.id,
        row: row as unknown as Record<string, unknown>,
        provenance: { cascadeLevel: null },
      };
      return insert;
    });

    // The bank's own record carries no ledger impact by itself.
    return makeResult<Proposal>(candidateCount, proposals, skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "REC-IMPORT-STATEMENT",
      runVersion: 1,
    });
  },

  /**
   * No undo. A statement line is evidence of what the bank said, on the same
   * footing as a staged row from the import pipeline: withdrawing it would
   * erase a record of an attempt rather than reverse an effect, and nothing
   * here posted anything to reverse.
   */
  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
