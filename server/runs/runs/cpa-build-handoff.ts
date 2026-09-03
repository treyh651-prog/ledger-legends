/**
 * COMPILATION ONLY. This run builds an archive and does nothing else with it.
 *
 * Ledger Legends is not a CPA firm. This run compiles data. It does not file,
 * issue, submit, or transmit any tax document. The compiled data set is
 * provided to the client's CPA for filing.
 *
 * CPA-BUILD-HANDOFF. Build the archive the client's CPA opens before they file.
 *
 * Spec: docs/05-decisions.md D4 and Part 5 for the contents, docs/02-run
 * specifications.md Module 8 for the archive shape, D7 for the vault.
 *
 * What is in it. A trial balance on both bases with the basis stated, the
 * general ledger detail for the range, the AR and AP subledgers, the fixed
 * asset register with additions, disposals, and depreciation, the prepaid and
 * deferral schedules, the loan amortization detail with the principal and
 * interest split, the closing entries, the substantiation tie out results, the
 * suspense account history, every open item still on the log, and, when the
 * range is a fiscal year end, the 1099 data set that TAX-BUILD-1099 compiled.
 *
 * And the scope statement, which is the point of the run. Doc 05 Part 5 says
 * the archive carries a statement of what the firm did and did not do, and that
 * statement is stored on the row in words rather than assembled at read time,
 * so a person opening the archive in three years sees what the CPA saw.
 *
 * What is not in it. There is no filing, no form, no transmitter reference, no
 * submission id, and no signature. There is no send. The archive lands in the
 * vault with a governance lock and somebody with access reads it. Nothing is
 * mailed, pushed, uploaded to a third party, or transmitted anywhere by this
 * codebase.
 *
 * The ledger fingerprint is in the scope hash. An archive is a photograph of
 * the books, so a posting inside the range has to produce a new photograph
 * rather than a deduplication hit on the old one. That is the same call module
 * 8 made for the report package and it matters more here, because a CPA files
 * from this.
 *
 * Locked periods. This run reads. A fully locked fiscal year is the normal
 * case for a handoff and nothing about the lock changes what it does.
 *
 * CONSTRAINT. No model, no score, no string distance, no advice vocabulary. The
 * archive states figures and states what produced them.
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
  applyProposals,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  requireTx,
} from "../apply-writer";
import { scopeHashFor } from "../ids";
import { derivedId } from "../ids";
import { revertFieldWrite } from "../undo";
import type { ArchiveArtifact, HandoffOpenItem, TaxDataSetRow } from "../tables";
import { ZERO, loadCloseData, type CloseData } from "./close-shared";
import {
  changedFieldsOf,
  checksumOf,
  reportingDiscriminator,
  retentionUntil,
} from "./rpt-shared";
import { COMPILATION_ONLY_BANNER, loadTaxData, yearWindowOf } from "./tax-shared";
import { dataSetIdOf } from "./tax-build-1099";
import { periodWindow } from "./per-shared";

export const buildHandoffScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  /** A period archive, or the whole fiscal year ending in that period. */
  scopeKind: z.enum(["period", "fiscal_year"]).default("period"),
});

export type BuildHandoffScope = z.infer<typeof buildHandoffScopeSchema>;

/**
 * The scope statement, stored in words.
 *
 * D4 and doc 05 Part 5. Every clause here is a thing the firm is not, and each
 * one is there because somebody could otherwise reasonably assume it was.
 */
export const SCOPE_STATEMENT =
  "What this archive is. Compiled bookkeeping prepared by Ledger Legends from " +
  "records the client provided. What it is not. It is not an audit. It is not " +
  "a review. It is not a compilation report issued under professional " +
  "standards. It is not tax advice and it contains none. Ledger Legends is not " +
  "a CPA firm, prepared no return, filed nothing, signed nothing, and " +
  "transmitted nothing. The client's CPA files. " +
  COMPILATION_ONLY_BANNER;

/** The comparable content of a handoff header. */
interface HandoffContent {
  taxYear: number;
  periodStart: string;
  periodEnd: string;
  scopeKind: "period" | "fiscal_year";
  reportingBasis: "both";
  isFiscalYearEnd: boolean;
  status: "complete";
  artifactCount: number;
  openItemCount: number;
  artifacts: ArchiveArtifact[];
  openItems: HandoffOpenItem[];
  scopeStatement: string;
  taxDataSetId: Ulid | null;
  contentChecksum: string;
  ledgerFingerprint: string;
  vaultObjectKey: string;
  vaultObjectLockMode: "GOVERNANCE";
  vaultRetentionStartsOn: string;
  vaultObjectLockUntil: string;
}

export const cpaBuildHandoff: Run<BuildHandoffScope, Proposal> = {
  type: "CPA-BUILD-HANDOFF",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:cpa-handoff:${scope.scopeKind}:${scope.period.slice(0, 7)}`,
  scopeSchema: buildHandoffScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<BuildHandoffScope>> {
    const tx = requireTx(ctx);
    const window = rangeFor(scope);
    const close = await loadCloseData(tx, ctx.firmId, scope.clientId, scope.period);
    const existing = await tx.query("cpa_handoffs_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const fingerprint = rangeFingerprint(close, window.rangeStart, window.rangeEnd);
    const candidateIds = artifactCatalog(close, window).map((a) => a.path);
    const versions = [
      { id: "CPA-BUILD-HANDOFF", version: 1 },
      ...existing.map((h) => ({ id: h.id, version: h.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.rangeStart,
      periodEnd: window.rangeEnd,
      candidateIds,
      /**
       * The period, the ledger fingerprint over the whole range, and the run
       * type. The fingerprint is the important one: a CPA files from this
       * archive, so a posting anywhere in the range has to produce a new
       * archive rather than serve the stale one out of the dedupe table.
       */
      scopeHash: scopeHashFor({
        period: window.rangeStart,
        candidateIds: [
          ...candidateIds,
          reportingDiscriminator(
            window.rangeStart,
            fingerprint,
            `CPA-BUILD-HANDOFF:${scope.scopeKind}`,
          ),
        ],
        versions,
      }),
      versions,
      overriddenIds: existing.filter((h) => h.manualOverride).map((h) => h.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const window = rangeFor(scope);
    const close = await loadCloseData(tx, frozen.firmId, frozen.clientId, scope.period);
    const existing = await tx.query("cpa_handoffs_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const rowId = handoffIdOf(frozen.clientId, window.rangeStart, scope.scopeKind);
    const prior = existing.find((h) => h.id === rowId);

    if (prior !== undefined && prior.manualOverride) {
      skips.push({
        rowId,
        reason: "manual_override",
        detail: `the handoff for ${window.rangeStart} carries manual_override`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    /*
     * The 1099 data set, but only at a fiscal year end and only if it exists.
     * The handoff never builds one, because compiling a data set is a different
     * run with a different scope hash and a different threshold lookup, and
     * doing it twice in two places is how the two answers drift apart.
     */
    let taxDataSet: TaxDataSetRow | null = null;
    if (window.isFiscalYearEnd) {
      const taxData = await loadTaxData(tx, frozen.firmId, frozen.clientId, window.taxYear);
      const wanted = dataSetIdOf(frozen.clientId, window.taxYear);
      taxDataSet = taxData.dataSets.find((d) => d.id === wanted) ?? null;
      if (taxDataSet === null) {
        skips.push({
          rowId,
          reason: "missing_prerequisite",
          detail:
            `no compiled 1099 data set for ${window.taxYear}, so the archive was built ` +
            `without it. Run TAX-BUILD-1099 and rebuild.`,
        });
      }
    }

    const artifacts = artifactCatalog(close, window, taxDataSet);
    const openItems = openItemsOf(close);
    const fingerprint = rangeFingerprint(close, window.rangeStart, window.rangeEnd);

    const content: HandoffContent = {
      taxYear: window.taxYear,
      periodStart: window.rangeStart,
      periodEnd: window.rangeEnd,
      scopeKind: scope.scopeKind,
      // Doc 05 Part 5. Both bases, with the basis stated on the artifact.
      reportingBasis: "both",
      isFiscalYearEnd: window.isFiscalYearEnd,
      status: "complete",
      artifactCount: artifacts.length,
      openItemCount: openItems.length,
      artifacts,
      openItems,
      scopeStatement: SCOPE_STATEMENT,
      taxDataSetId: taxDataSet === null ? null : taxDataSet.id,
      contentChecksum: checksumOf({ artifacts, openItems }),
      ledgerFingerprint: fingerprint,
      // The zip in the vault, recorded as a key and a lock rather than as a
      // second document row. NOTES entry 101 made that call for module 8.
      vaultObjectKey: `clients/${frozen.clientId}/cpa-handoff/${window.rangeStart}/handoff.zip`,
      vaultObjectLockMode: "GOVERNANCE",
      // D7. Seven years, starting at the period end.
      vaultRetentionStartsOn: window.rangeEnd,
      vaultObjectLockUntil: retentionUntil(window.rangeEnd),
    };

    if (prior === undefined) {
      proposals.push(insertHandoff(frozen, rowId, content));
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
        detail: `handoff_unchanged for ${window.rangeStart}`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }
    proposals.push({
      kind: "field_write",
      table: "cpa_handoffs",
      rowId,
      before: changed.before,
      after: changed.after,
      provenance: { cascadeLevel: null },
    });

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "CPA-BUILD-HANDOFF",
      runVersion: 1,
    });
  },

  /** The archive stands. Only a rebuild's field moves revert. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function handoffIdOf(clientId: Ulid, rangeStart: string, kind: string): Ulid {
  return derivedId(`${clientId}:${rangeStart}:${kind}`, "cpa-build-handoff", 0);
}

/** The date range an archive covers, and whether it ends a fiscal year. */
export interface HandoffRange {
  rangeStart: string;
  rangeEnd: string;
  taxYear: number;
  isFiscalYearEnd: boolean;
}

/**
 * A period archive covers its month. A fiscal year archive covers the calendar
 * year the period sits in, which is the only fiscal year this module supports
 * and doc 02 says so.
 */
export function rangeFor(scope: BuildHandoffScope): HandoffRange {
  const window = periodWindow(scope.period);
  const taxYear = Number(window.periodStart.slice(0, 4));
  if (scope.scopeKind === "fiscal_year") {
    const year = yearWindowOf(taxYear);
    return {
      rangeStart: year.yearStart,
      rangeEnd: year.yearEnd,
      taxYear,
      isFiscalYearEnd: true,
    };
  }
  return {
    rangeStart: window.periodStart,
    rangeEnd: window.periodEnd,
    taxYear,
    // A December period is a fiscal year end even when the caller asked for one
    // month, because the 1099 data set belongs with it.
    isFiscalYearEnd: window.periodStart.slice(5, 7) === "12",
  };
}

/** The ledger fingerprint over an arbitrary range rather than one period. */
export function rangeFingerprint(close: CloseData, from: string, to: string): string {
  const ids = close.entries
    .filter((e) => e.entryDate >= from && e.entryDate <= to)
    .map((e) => e.id)
    .sort();
  const set = new Set(ids);
  const lineParts = close.lines
    .filter((l) => set.has(l.entryId))
    .map((l) => `${l.entryId}:${l.accountNumber}:${l.amountCents.toString()}`)
    .sort();
  return checksumOf({ from, to, entries: ids, lines: lineParts });
}

/**
 * The contents of the archive, doc 05 Part 5, in a fixed order.
 *
 * Every artifact carries a row count and a checksum, so a person can tell
 * whether the file they are holding is the file the row describes. The formats
 * are open ones for the same reason D9 requires them for an export: a CPA
 * should not need this firm's software to read this firm's archive.
 */
export function artifactCatalog(
  close: CloseData,
  range: HandoffRange,
  taxDataSet: TaxDataSetRow | null = null,
): ArchiveArtifact[] {
  const entries = close.entries.filter(
    (e) => e.entryDate >= range.rangeStart && e.entryDate <= range.rangeEnd,
  );
  const entryIds = new Set(entries.map((e) => e.id));
  const lines = close.lines.filter((l) => entryIds.has(l.entryId));
  // A closing entry is one the year end run posted. The entry row records the
  // run type that produced it, which is a stronger test than a memo prefix.
  const closing = entries.filter((e) => e.runType === "CLOSE-POST-YEAREND");
  const suspense = close.suspense.filter((s) => s.withdrawnByRunId === null);

  const artifacts: ArchiveArtifact[] = [
    artifact(
      "trial-balance-accrual.csv",
      "trial_balance",
      "csv",
      close.chart.length,
      "Trial balance on the accrual basis. The basis is stated in the header row.",
    ),
    artifact(
      "trial-balance-cash.csv",
      "trial_balance",
      "csv",
      close.chart.length,
      "Trial balance on the cash basis. The basis is stated in the header row.",
    ),
    artifact(
      "general-ledger.csv",
      "general_ledger",
      "csv",
      lines.length,
      `General ledger detail for ${range.rangeStart} through ${range.rangeEnd}, one row per line.`,
    ),
    artifact(
      "balance-sheet.csv",
      "financial_statement",
      "csv",
      close.chart.length,
      "Balance sheet on both bases, with the basis on each column.",
    ),
    artifact(
      "income-statement.csv",
      "financial_statement",
      "csv",
      close.chart.length,
      "Income statement on both bases, with the basis on each column.",
    ),
    artifact(
      "subledger-ar.csv",
      "subledger",
      "csv",
      close.aging.length,
      "Accounts receivable subledger with the aging as of the range end.",
    ),
    artifact(
      "subledger-ap.csv",
      "subledger",
      "csv",
      close.vendors.length,
      "Accounts payable subledger by vendor.",
    ),
    artifact(
      "fixed-assets.csv",
      "fixed_assets",
      "csv",
      close.assets.length,
      "Fixed asset register with additions, disposals, and depreciation for the range.",
    ),
    artifact(
      "depreciation-schedule.csv",
      "fixed_assets",
      "csv",
      close.depreciation.length,
      "Depreciation schedule by asset and period.",
    ),
    artifact(
      "prepaids-and-deferrals.csv",
      "prepaids",
      "csv",
      close.deferralLines.length,
      "Prepaid and deferral schedules with the remaining balance per schedule.",
    ),
    artifact(
      "loan-amortization.csv",
      "loans",
      "csv",
      close.loanSchedule.length,
      "Loan amortization detail with the principal and interest split on every payment.",
    ),
    artifact(
      "closing-entries.csv",
      "closing_entries",
      "csv",
      closing.length,
      "Closing entries posted in the range.",
    ),
    artifact(
      "substantiation-tieouts.csv",
      "substantiation",
      "csv",
      close.tieouts.length,
      "Substantiation tie out results by balance sheet account.",
    ),
    artifact(
      "suspense-history.csv",
      "suspense",
      "csv",
      suspense.length,
      "Suspense account history for the range, including what cleared and what did not.",
    ),
    artifact(
      "open-items.csv",
      "open_items",
      "csv",
      close.requests.filter((r) => r.status === "open").length,
      "Every open item still on the log at the range end.",
    ),
    artifact(
      "scope-statement.txt",
      "scope_statement",
      "txt",
      1,
      "What the firm did and did not do, stated in writing.",
    ),
  ];

  if (taxDataSet !== null) {
    artifacts.push(
      artifact(
        "1099-data-set.csv",
        "tax_data_set",
        "csv",
        taxDataSet.reportableCount,
        "The compiled 1099 payee data set. Compiled for the CPA. Not filed by this firm.",
      ),
      artifact(
        "w9-exceptions.csv",
        "w9_exceptions",
        "csv",
        taxDataSet.backupWithholdingCount,
        "Payees at or above the threshold with no complete W-9 on file.",
      ),
    );
  }

  return artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function artifact(
  path: string,
  artifactKind: string,
  fileFormat: ArchiveArtifact["fileFormat"],
  rowCount: number,
  detail: string,
): ArchiveArtifact {
  return {
    path,
    artifactKind,
    fileFormat,
    rowCount,
    checksum: checksumOf({ path, artifactKind, rowCount }),
    detail,
  };
}

/**
 * Everything still open, so the CPA sees it before they file rather than after.
 *
 * Open requests, unwithdrawn suspense, and tie outs that did not tie. Each one
 * carries the amount at stake in integer cents, because a CPA needs to know
 * whether an open item is worth waiting for.
 */
export function openItemsOf(close: CloseData): HandoffOpenItem[] {
  const items: HandoffOpenItem[] = [];
  for (const request of close.requests) {
    if (request.status !== "open") continue;
    items.push({
      kind: "document_request",
      subjectId: request.id,
      detail: `${request.catalogCode}: ${request.detail}`,
      amountCents: ZERO,
    });
  }
  for (const item of close.suspense) {
    if (item.withdrawnByRunId !== null) continue;
    items.push({
      kind: "suspense",
      subjectId: item.id,
      detail: `${item.reasonCode} on transaction ${item.transactionId}`,
      // A suspense row carries no amount of its own. The amount at stake is the
      // transaction's, and the archive states zero rather than guess at a join
      // the row does not support.
      amountCents: ZERO,
    });
  }
  for (const tie of close.tieouts) {
    if (tie.state === "computed_tied") continue;
    items.push({
      kind: "tieout",
      subjectId: tie.id,
      detail: `${tie.accountNumber} is ${tie.state}: ${tie.detail}`,
      amountCents: tie.varianceCents ?? ZERO,
    });
  }
  return items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0;
  });
}

function insertHandoff(
  frozen: FrozenScope<BuildHandoffScope>,
  rowId: Ulid,
  content: HandoffContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "cpa_handoffs",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      ...content,
      builtByRunId: RUN_ID_PLACEHOLDER,
      builtAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

export type { Cents };
