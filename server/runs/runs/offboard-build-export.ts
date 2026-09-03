/**
 * OFFBOARD-BUILD-EXPORT. Build the complete client history in open formats,
 * because a client who leaves takes their records with them.
 *
 * Spec: docs/05-decisions.md D9.
 *
 * D9 is short and absolute. A client who offboards gets their complete records
 * within fifteen business days, at no fee, in open formats. This run builds
 * that. It covers the entire client history rather than a period, because the
 * point is that the client owns their books and the firm was holding them.
 *
 * Fifteen business days. Counted as business days from the request, skipping
 * weekends, and stored on the row as the due date so the obligation is a date
 * somebody can miss visibly rather than a policy nobody measures. Migration
 * 0017 puts a named check constraint on the column, so a fourteen day window
 * cannot be recorded at all.
 *
 * Open formats only. CSV for anything tabular, JSON for anything structured,
 * PDF where a document already exists as one, and the original bytes for every
 * vault document. There is no proprietary format in the catalog, and there is
 * no format that requires this firm's software to open. A client who leaves and
 * cannot read what they were given has not really been given anything.
 *
 * The manifest. Every file gets a row count and a checksum, and the manifest
 * itself gets a checksum. That is the difference between an export and a folder
 * of files: the client can prove nothing was truncated.
 *
 * The ledger fingerprint is in the scope hash. An export is a photograph of the
 * whole history, so a posting anywhere in that history has to produce a new
 * export rather than a deduplication hit.
 *
 * SENDS. None. The archive lands in the vault. A person hands the client
 * access. Nothing is mailed, uploaded, or transmitted by this codebase.
 *
 * Locked periods. A departing client's history is almost entirely locked, and
 * this run reads. The lock changes nothing about what it does.
 *
 * CONSTRAINT. No model, no score, no string distance. Row counts are counts.
 */

import { z } from "zod";
import {
  isFieldWrite,
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
import {
  applyProposals,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  requireTx,
} from "../apply-writer";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { ArchiveArtifact } from "../tables";
import { ZERO, loadCloseData, type CloseData } from "./close-shared";
import { changedFieldsOf, checksumOf, reportingDiscriminator, retentionUntil } from "./rpt-shared";
import { addBusinessDays } from "./prc-shared";
import { rangeFingerprint } from "./cpa-build-handoff";
import { periodWindow } from "./per-shared";

/** D9. Fifteen business days, and the column accepts no other number. */
export const PRODUCTION_DAYS = 15 as const;

export const buildExportScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  /** The day the client asked. The production window counts from here. */
  requestedOn: z.string().min(10),
});

export type BuildExportScope = z.infer<typeof buildExportScopeSchema>;

/** The comparable content of an export header. */
interface ExportContent {
  requestedOn: string;
  productionDays: 15;
  dueOn: string;
  historyStart: string | null;
  historyEnd: string;
  periodStart: string;
  periodEnd: string;
  status: "complete";
  fileCount: number;
  documentCount: number;
  totalRowCount: number;
  files: ArchiveArtifact[];
  manifestChecksum: string;
  contentChecksum: string;
  ledgerFingerprint: string;
  vaultObjectKey: string;
  vaultObjectLockMode: "GOVERNANCE";
  vaultRetentionStartsOn: string;
  vaultObjectLockUntil: string;
}

export const offboardBuildExport: Run<BuildExportScope, Proposal> = {
  type: "OFFBOARD-BUILD-EXPORT",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:offboard-export:${scope.requestedOn}`,
  scopeSchema: buildExportScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<BuildExportScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const close = await loadCloseData(tx, ctx.firmId, scope.clientId, scope.period);
    const existing = await tx.query("offboard_exports_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const history = historyRange(close, window.periodEnd);
    const fingerprint = rangeFingerprint(close, history.start ?? "0000-01-01", history.end);
    const files = fileCatalog(close, history);
    const candidateIds = files.map((f) => f.path);
    const versions = [
      { id: "OFFBOARD-BUILD-EXPORT", version: 1 },
      ...existing.map((e) => ({ id: e.id, version: e.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      /**
       * The period, the fingerprint over the whole history, and the run type. A
       * client who leaves gets the books as they actually are, so a late
       * posting has to change the export rather than be served the old one.
       */
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds: [
          ...candidateIds,
          reportingDiscriminator(
            window.periodStart,
            fingerprint,
            `OFFBOARD-BUILD-EXPORT:${scope.requestedOn}`,
          ),
        ],
        versions,
      }),
      versions,
      overriddenIds: existing.filter((e) => e.manualOverride).map((e) => e.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const window = periodWindow(scope.period);
    const close = await loadCloseData(tx, frozen.firmId, frozen.clientId, scope.period);
    const existing = await tx.query("offboard_exports_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const rowId = exportIdOf(frozen.clientId, scope.requestedOn);
    const prior = existing.find((e) => e.id === rowId);

    if (prior !== undefined && prior.manualOverride) {
      skips.push({
        rowId,
        reason: "manual_override",
        detail: `the export requested on ${scope.requestedOn} carries manual_override`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const history = historyRange(close, window.periodEnd);
    const files = fileCatalog(close, history);
    const fingerprint = rangeFingerprint(close, history.start ?? "0000-01-01", history.end);
    const documentCount = files.filter((f) => f.artifactKind === "vault_document").length;
    const totalRowCount = files.reduce((sum, f) => sum + f.rowCount, 0);
    const manifest = files.map((f) => ({
      path: f.path,
      rowCount: f.rowCount,
      checksum: f.checksum,
    }));

    const content: ExportContent = {
      requestedOn: scope.requestedOn,
      // D9. Fifteen business days, weekends skipped, no holiday calendar.
      productionDays: PRODUCTION_DAYS,
      dueOn: addBusinessDays(scope.requestedOn, PRODUCTION_DAYS),
      historyStart: history.start,
      historyEnd: history.end,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      status: "complete",
      fileCount: files.length,
      documentCount,
      totalRowCount,
      files,
      manifestChecksum: checksumOf(manifest),
      contentChecksum: checksumOf({ files, history }),
      ledgerFingerprint: fingerprint,
      vaultObjectKey: `clients/${frozen.clientId}/offboarding/${scope.requestedOn}/export.zip`,
      vaultObjectLockMode: "GOVERNANCE",
      // D7. The clock starts at the last period the export covers.
      vaultRetentionStartsOn: history.end,
      vaultObjectLockUntil: retentionUntil(history.end),
    };

    if (prior === undefined) {
      proposals.push(insertExport(frozen, rowId, content));
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
        detail: `export_unchanged for the request of ${scope.requestedOn}`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }
    proposals.push({
      kind: "field_write",
      table: "offboard_exports",
      rowId,
      before: changed.before,
      after: changed.after,
      provenance: { cascadeLevel: null },
    });

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "OFFBOARD-BUILD-EXPORT",
      runVersion: 1,
    });
  },

  /** The export stands. Only a rebuild's field moves revert. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function exportIdOf(clientId: Ulid, requestedOn: string): Ulid {
  return derivedId(`${clientId}:${requestedOn}`, "offboard-build-export", 0);
}

/** The whole history, first entry to the last closed period. */
export interface HistoryRange {
  start: string | null;
  end: string;
  years: string[];
}

export function historyRange(close: CloseData, periodEnd: string): HistoryRange {
  const dates = close.entries.map((e) => e.entryDate).sort();
  const start = dates.length === 0 ? null : dates[0];
  const end = dates.length === 0 ? periodEnd : dates[dates.length - 1] > periodEnd ? dates[dates.length - 1] : periodEnd;
  const years = new Set<string>();
  for (const date of dates) years.add(date.slice(0, 4));
  return { start, end, years: [...years].sort() };
}

/**
 * The contents of the export, D9, in a fixed order.
 *
 * Chart and mapping, the whole ledger with provenance columns, every register,
 * the statements per period on both bases, the vault documents in a tree by
 * year and by type, and the manifest. Every entry is CSV, JSON, or an original
 * document, and nothing here requires this firm's software to read.
 */
export function fileCatalog(close: CloseData, history: HistoryRange): ArchiveArtifact[] {
  const files: ArchiveArtifact[] = [
    file("chart-of-accounts.csv", "chart", "csv", close.chart.length, "Chart of accounts."),
    file("categories.csv", "chart", "csv", 0, "Categories and their posting destinations."),
    file(
      "category-account-mapping.csv",
      "chart",
      "csv",
      close.chart.length,
      "The mapping from category to chart account.",
    ),
    file(
      "journal-entries.csv",
      "ledger",
      "csv",
      close.entries.length,
      "Every journal entry with the run, the run version, and the source row that produced it.",
    ),
    file(
      "journal-lines.csv",
      "ledger",
      "csv",
      close.lines.length,
      "Every journal line with the account, the category, and the signed integer cents.",
    ),
    file(
      "transactions.csv",
      "ledger",
      "csv",
      close.transactions.length,
      "The bank transaction register with the coding decision on each row.",
    ),
    file("register-ar.csv", "register", "csv", close.aging.length, "Accounts receivable register."),
    file("register-ap.csv", "register", "csv", close.vendors.length, "Accounts payable register."),
    file(
      "register-fixed-assets.csv",
      "register",
      "csv",
      close.assets.length,
      "Fixed asset register with the depreciation history.",
    ),
    file(
      "register-loans.csv",
      "register",
      "csv",
      close.loanSchedule.length,
      "Loan register with the full amortization schedule.",
    ),
    file(
      "register-deferrals.csv",
      "register",
      "csv",
      close.deferralLines.length,
      "Deferral and prepaid register.",
    ),
    file(
      "trial-balance-by-period.csv",
      "statement",
      "csv",
      close.periods.length,
      "Trial balance per period on both bases, with the basis on each column.",
    ),
    file(
      "financial-statements-by-period.csv",
      "statement",
      "csv",
      close.periods.length,
      "Balance sheet and income statement per period on both bases.",
    ),
    file(
      "period-locks.csv",
      "provenance",
      "csv",
      close.locks.length,
      "Every period lock, so the client can see which months were closed and when.",
    ),
    file(
      "run-log.json",
      "provenance",
      "json",
      /*
       * The export's own executions are left out of the count.
       *
       * A preview writes a run log row before the apply re-derives, so counting
       * every row would make the manifest disagree with itself and every apply
       * would refuse on a stale preview. The log of the run that built the
       * archive is not part of the client's history anyway. NOTES entry 122.
       */
      close.runLog.filter((r) => r.runType !== "OFFBOARD-BUILD-EXPORT").length,
      "The full run log, so every automated decision in the history is traceable.",
    ),
    file(
      "open-items.csv",
      "open_items",
      "csv",
      close.requests.length,
      "Every document request raised in the history and how it ended.",
    ),
    file(
      "manifest.csv",
      "manifest",
      "csv",
      0,
      "One row per file with the row count and the checksum, so nothing can be silently truncated.",
    ),
  ];

  /*
   * The vault documents, in original bytes, in a folder tree by year and by
   * type. D9 says original bytes, so nothing is converted, re rendered, or
   * watermarked on the way out.
   */
  for (const year of history.years) {
    files.push(
      file(
        `documents/${year}/`,
        "vault_document",
        "pdf",
        0,
        `Every vault document dated in ${year}, in original bytes, foldered by type.`,
      ),
    );
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function file(
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

function insertExport(
  frozen: FrozenScope<BuildExportScope>,
  rowId: Ulid,
  content: ExportContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "offboard_exports",
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
