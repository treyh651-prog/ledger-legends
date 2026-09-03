/**
 * RPT-BUILD-PACKAGE. Assemble the period report package.
 *
 * Spec: docs/02-run-specifications.md Module 8 RPT-BUILD-PACKAGE.
 *
 * Nine sections in a fixed order: a cover, a balance sheet, an income
 * statement, a statement of cash flows, a statement of equity, a receivable
 * aging, a payable aging, notes, and a change log. Each one is a snapshot of the
 * figures at the close date and not a live query, because a package reopened a
 * year from now has to show the numbers it showed on the day it was delivered.
 *
 * The run reads the ledger and writes only report rows. It proposes no journal
 * entry at all, which is why it is safe on a locked period and why
 * requiresOpenPeriod is false. A locked period is in fact the normal case here.
 * An open period is still packaged, and every section carries a watermark saying
 * the period is not closed, per doc 02 rule 1.
 *
 * Idempotency. The package id is derived from the period and the comparison
 * basis, and the section ids are derived from the package. The first execution
 * inserts, a later execution rewrites only the fields that moved, and an
 * execution that finds nothing moved reports already applied. The ledger
 * fingerprint is in the scope hash, so a rebuild after somebody posts an entry
 * is a different scope and produces a fresh package instead of a stale
 * deduplication hit.
 *
 * D7. The package carries the vault object key it will occupy, governance lock
 * mode, retention starting at the period end, and the seven year lock date. It
 * does not create a vault document, because a run has no bytes to upload and
 * cannot satisfy the scan and magic verification a usable vault document
 * requires. See NOTES.md entry 101.
 *
 * SENDS. None. The delivery side effect is one audit row of type
 * report_available. No address, no external call, no email.
 *
 * COMPLIANCE. Descriptive figures and fixed notes. No opinion, no assurance, no
 * tax computation. The notes section states the basis of accounting and what the
 * package does not do, and says nothing about what anybody should do next.
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
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { ReportSectionLine, ReportSectionRow } from "../tables";
import { periodWindow } from "./per-shared";
import {
  ZERO,
  balanceOf,
  blockOf,
  isBalanceSheet,
  isIncomeStatement,
} from "./close-shared";
import {
  SECTION_CATALOG,
  accountNameOf,
  agingFor,
  cashBalanceOf,
  centsStr,
  changedFieldsOf,
  checksumOf,
  isCashAccount,
  isMemoAccount,
  loadReportData,
  reportingDiscriminator,
  reportingWatermark,
  retentionUntil,
  type ReportData,
  type SectionSpec,
} from "./rpt-shared";

export const buildPackageScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  comparisonBasis: z
    .enum(["prior_period", "prior_year", "budget", "none"])
    .default("prior_period"),
});

export type BuildPackageScope = z.infer<typeof buildPackageScopeSchema>;

/** The comparable content of the package header. */
interface PackageContent {
  basis: "accrual" | "cash";
  comparisonBasis: "prior_period" | "prior_year" | "budget" | "none";
  comparisonAvailable: boolean;
  comparisonNote: string;
  state: "draft";
  watermark: string | null;
  closedWithExceptions: boolean;
  exceptionBanner: string | null;
  sectionCount: number;
  omissionCount: number;
  contentChecksum: string;
  ledgerFingerprint: string;
  vaultObjectKey: string;
  vaultObjectLockMode: "GOVERNANCE";
  vaultRetentionStartsOn: string;
  vaultObjectLockUntil: string;
}

/** The comparable content of one section row. */
interface SectionContent {
  sequence: number;
  sectionCode: string;
  sectionTitle: string;
  status: "rendered" | "omitted";
  omissionReason: string | null;
  asOfDate: string;
  bannerText: string | null;
  lines: ReportSectionLine[];
  contentChecksum: string;
}

export const rptBuildPackage: Run<BuildPackageScope, Proposal> = {
  type: "RPT-BUILD-PACKAGE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:report-package:${scope.period.slice(0, 7)}`,
  scopeSchema: buildPackageScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<BuildPackageScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadReportData(tx, ctx.firmId, scope.clientId, scope.period);
    // The candidates are the sections, because a package is nine sections and a
    // count of nine is what the log should say it considered.
    const candidateIds = SECTION_CATALOG.map((s) => s.code);
    const versions = [
      { id: "RPT-BUILD-PACKAGE", version: 1 },
      // The chart has no version column, so its identity is the account list
      // itself, which is already in the candidate set through the sections.
      ...data.close.aging.map((a) => ({ id: a.id, version: a.version })),
      ...data.gates.map((g) => ({ id: g.id, version: g.version })),
      ...(data.lock === null ? [] : [{ id: data.lock.id, version: 1 }]),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      /**
       * The period and the ledger fingerprint are both in the hash. The period
       * keeps two periods from colliding. The fingerprint makes a rebuild after
       * a posting a new scope, which is the whole reason a stale package cannot
       * be served from the deduplication table.
       */
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds: [
          ...candidateIds,
          reportingDiscriminator(
            window.periodStart,
            data.fingerprint,
            `RPT-BUILD-PACKAGE:${scope.comparisonBasis}`,
          ),
        ],
        versions,
      }),
      versions,
      overriddenIds: data.packages
        .filter((p) => p.manualOverride)
        .map((p) => p.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const data = await loadReportData(
      tx,
      frozen.firmId,
      frozen.clientId,
      frozen.input.period,
    );
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const basis = frozen.input.comparisonBasis;
    const packageId = packageIdOf(data.periodStart, basis);
    const sections = buildSections(data, basis);
    const sectionRows = await tx.query("report_sections_for_package", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      packageId,
    });
    const priorSectionById = new Map<string, ReportSectionRow>(
      sectionRows.map((r) => [r.id, r]),
    );
    const priorPackage = data.packages.find((p) => p.id === packageId);

    const content = packageContent(data, basis, sections);

    // Invariant 8, doc 03 Part 6. A package a person took over is not touched,
    // and neither are its sections, because a header and its sections are one
    // document and rewriting half of it would leave a package that does not
    // describe itself.
    if (priorPackage !== undefined && priorPackage.manualOverride) {
      skips.push({
        rowId: packageId,
        reason: "manual_override",
        detail: `report package for ${data.periodStart} carries manual_override`,
      });
      for (const section of sections) {
        skips.push({
          rowId: sectionIdOf(packageId, section.sectionCode),
          reason: "manual_override",
          detail: `section ${section.sectionCode} belongs to an overridden package`,
        });
      }
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        proposals,
        skips,
        errors,
        ZERO,
      );
    }

    if (priorPackage === undefined) {
      proposals.push(insertPackage(frozen, data, packageId, content));
    } else {
      const changed = changedFieldsOf(
        priorPackage as unknown as Record<string, unknown>,
        content as unknown as Record<string, unknown>,
      );
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId: packageId,
          reason: "already_applied",
          detail: `package_unchanged for ${data.periodStart} at ${data.periodEnd}`,
        });
      } else {
        proposals.push({
          kind: "field_write",
          table: "report_packages",
          rowId: packageId,
          before: changed.before,
          after: changed.after,
          // A report is not a coding decision, so it claims no cascade level,
          // the same call the reconciliation and tie out writes made.
          provenance: { cascadeLevel: null },
        });
      }
    }

    for (const section of sections) {
      const rowId = sectionIdOf(packageId, section.sectionCode);
      const prior = priorSectionById.get(rowId);
      if (prior === undefined) {
        proposals.push(insertSection(frozen, data, packageId, rowId, section));
        continue;
      }
      if (prior.manualOverride) {
        skips.push({
          rowId,
          reason: "manual_override",
          detail: `section ${section.sectionCode} carries manual_override`,
        });
        continue;
      }
      const changed = changedFieldsOf(
        prior as unknown as Record<string, unknown>,
        section as unknown as Record<string, unknown>,
      );
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `section_unchanged ${section.sectionCode} at ${data.periodEnd}`,
        });
        continue;
      }
      proposals.push({
        kind: "field_write",
        table: "report_sections",
        rowId,
        before: changed.before,
        after: changed.after,
        provenance: { cascadeLevel: null },
      });
    }

    // The delivery surface. One audit row saying the package exists, written
    // once. Nothing is sent, and a person decides what leaves the firm.
    const eventId = auditIdOf(packageId);
    const eventExists = data.auditEvents.some((e) => e.id === eventId);
    if (!eventExists) {
      proposals.push({
        kind: "row_insert",
        table: "report_audit_events",
        rowId: eventId,
        row: {
          firmId: frozen.firmId,
          clientId: frozen.clientId,
          version: 1,
          periodStart: data.periodStart,
          action: "report_available",
          subjectTable: "report_packages",
          subjectId: packageId,
          detail: `package assembled with ${content.sectionCount} sections and ${content.omissionCount} omissions`,
          createdByRunId: RUN_ID_PLACEHOLDER,
          createdAt: NOW_PLACEHOLDER,
          manualOverride: false,
        },
        provenance: { cascadeLevel: null },
      });
    }

    return makeResult<Proposal>(
      frozen.candidateIds.length,
      proposals,
      skips,
      errors,
      ZERO,
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "RPT-BUILD-PACKAGE",
      runVersion: 1,
    });
  },

  /**
   * A package a person may already have read stands. Only the field writes
   * revert, on the same reasoning the aging refresh and the tie out used: an
   * undo that deleted the report would also delete the record that it existed.
   */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function packageIdOf(periodStart: string, comparisonBasis: string): Ulid {
  return derivedId(`${periodStart}:${comparisonBasis}`, "rpt-build-package", 0);
}

export function sectionIdOf(packageId: Ulid, sectionCode: string): Ulid {
  return derivedId(`${packageId}:${sectionCode}`, "rpt-build-package-section", 0);
}

function auditIdOf(packageId: Ulid): Ulid {
  return derivedId(`${packageId}:report_available`, "rpt-build-package-audit", 0);
}

function packageContent(
  data: ReportData,
  comparisonBasis: BuildPackageScope["comparisonBasis"],
  sections: readonly SectionContent[],
): PackageContent {
  const omissions = sections.filter((s) => s.status === "omitted").length;
  const closedWithExceptions =
    data.lock !== null && data.lock.closedWithExceptions;
  return {
    // D3. The ledger is accrual and the cash view is derived, so a package says
    // accrual in words on its cover and its notes.
    basis: "accrual",
    comparisonBasis,
    comparisonAvailable: data.comparisonAvailable,
    comparisonNote: data.comparisonAvailable
      ? "Comparison figures are the prior period."
      : "No prior period figures exist, so the comparison column is blank.",
    state: "draft",
    watermark: reportingWatermark(data),
    closedWithExceptions,
    exceptionBanner: closedWithExceptions
      ? `Closed with exceptions. ${data.lock?.exceptionNote ?? "See the notes section."}`
      : null,
    sectionCount: sections.length,
    omissionCount: omissions,
    contentChecksum: checksumOf(
      sections.map((s) => ({ code: s.sectionCode, checksum: s.contentChecksum })),
    ),
    ledgerFingerprint: data.fingerprint,
    vaultObjectKey: `clients/${data.clientId}/reports/${data.periodStart}/${comparisonBasis}/package.json`,
    vaultObjectLockMode: "GOVERNANCE",
    // D7. The clock starts at the period end, not at the day of the upload.
    vaultRetentionStartsOn: data.periodEnd,
    vaultObjectLockUntil: retentionUntil(data.periodEnd),
  };
}

/**
 * The nine sections, always all nine, always in catalog order.
 *
 * A section with nothing to say is written with status omitted and a stated
 * reason rather than dropped, because a reader notices a section that says it is
 * empty and does not notice a section that is not there.
 */
function buildSections(
  data: ReportData,
  comparisonBasis: BuildPackageScope["comparisonBasis"],
): SectionContent[] {
  const banner = bannerFor(data);
  const out: SectionContent[] = [];
  for (const spec of SECTION_CATALOG) {
    const built = buildOneSection(data, comparisonBasis, spec);
    out.push({
      sequence: spec.sequence,
      sectionCode: spec.code,
      sectionTitle: spec.title,
      status: built.reason === null ? "rendered" : "omitted",
      omissionReason: built.reason,
      asOfDate: data.periodEnd,
      bannerText: banner,
      lines: built.lines,
      contentChecksum: checksumOf(built.lines),
    });
  }
  return out;
}

/**
 * The banner that prints on every section header.
 *
 * Doc 02 rule 5 says a period closed with exceptions says so on every statement
 * and that the banner cannot be suppressed by section selection, so it is
 * computed once and stamped on all nine rows.
 */
function bannerFor(data: ReportData): string | null {
  if (data.lock === null) {
    return "Draft. This period is not closed and these figures can still change.";
  }
  if (data.lock.closedWithExceptions) {
    return "This period was closed with exceptions. See the notes section.";
  }
  return null;
}

interface BuiltSection {
  lines: ReportSectionLine[];
  reason: string | null;
}

function buildOneSection(
  data: ReportData,
  comparisonBasis: BuildPackageScope["comparisonBasis"],
  spec: SectionSpec,
): BuiltSection {
  switch (spec.code) {
    case "COVER":
      return { lines: coverLines(data, comparisonBasis), reason: null };
    case "BALANCE_SHEET":
      return balanceSheetSection(data);
    case "INCOME_STATEMENT":
      return incomeStatementSection(data);
    case "CASH_FLOW":
      return cashFlowSection(data);
    case "STATEMENT_OF_EQUITY":
      return equitySection(data);
    case "AR_AGING":
      return agingSection(data, "receivable");
    case "AP_AGING":
      return agingSection(data, "payable");
    case "NOTES":
      return { lines: notesLines(data), reason: null };
    case "CHANGE_LOG":
      return changeLogSection(data);
    default:
      // The catalog is a constant in this file, so this branch is unreachable.
      // It exists so that adding a code without a builder fails loudly.
      return { lines: [], reason: `no builder for section ${spec.code}` };
  }
}

function line(
  label: string,
  accountNumber: string | null,
  amount: Cents,
  comparison: Cents | null,
  note: string | null,
): ReportSectionLine {
  return {
    label,
    accountNumber,
    amountCents: centsStr(amount),
    comparisonCents: comparison === null ? null : centsStr(comparison),
    note,
  };
}

function coverLines(
  data: ReportData,
  comparisonBasis: BuildPackageScope["comparisonBasis"],
): ReportSectionLine[] {
  return [
    line("Period start", null, ZERO, null, data.periodStart),
    line("Period end", null, ZERO, null, data.periodEnd),
    // D3. The basis is stated in words on the cover of every package.
    line(
      "Basis of accounting",
      null,
      ZERO,
      null,
      "Accrual basis. The cash view is derived from the same ledger.",
    ),
    line("Comparison basis", null, ZERO, null, comparisonBasis),
    line(
      "Period status",
      null,
      ZERO,
      null,
      data.lock === null ? "open" : "locked",
    ),
  ];
}

/**
 * The balance sheet. Balances through the close date, with the prior period end
 * in the comparison column, and totals by side.
 *
 * Figures keep the ledger sign convention, debit positive, so a liability reads
 * negative and a reader adding the column gets zero. Flipping signs for
 * presentation is a rendering decision, and a stored snapshot that already
 * flipped them cannot be checked against the ledger.
 */
function balanceSheetSection(data: ReportData): BuiltSection {
  const lines: ReportSectionLine[] = [];
  let assets = ZERO;
  let liabilities = ZERO;
  let equity = ZERO;
  for (const account of data.close.chart) {
    const number = account.accountNumber;
    if (isMemoAccount(number) || !isBalanceSheet(number)) continue;
    const amount = balanceOf(data.close.through, number);
    const prior = balanceOf(data.close.priorThrough, number);
    if (amount === ZERO && prior === ZERO) continue;
    lines.push(
      line(
        account.name,
        number,
        amount,
        data.comparisonAvailable ? prior : null,
        null,
      ),
    );
    const block = blockOf(number);
    if (block === "equity") equity += amount;
    else if (number < "2000") assets += amount;
    else liabilities += amount;
  }
  if (lines.length === 0) {
    return { lines: [], reason: "no_balance_sheet_activity" };
  }
  lines.push(line("Total assets", null, assets, null, null));
  lines.push(line("Total liabilities", null, liabilities, null, null));
  lines.push(line("Total equity before current period result", null, equity, null, null));
  return { lines, reason: null };
}

/**
 * The income statement. Activity inside the period only.
 *
 * The net result line is the negated sum of the income statement deltas, which
 * turns the ledger sign into the figure a reader calls net income: revenue is a
 * credit, expense is a debit, and a profitable period sums to a credit.
 */
function incomeStatementSection(data: ReportData): BuiltSection {
  const lines: ReportSectionLine[] = [];
  let total = ZERO;
  for (const account of data.close.chart) {
    const number = account.accountNumber;
    if (isMemoAccount(number) || !isIncomeStatement(number)) continue;
    const amount = balanceOf(data.close.inPeriod, number);
    const prior = balanceOf(data.priorInPeriod, number);
    if (amount === ZERO && prior === ZERO) continue;
    lines.push(
      line(
        account.name,
        number,
        amount,
        data.comparisonAvailable ? prior : null,
        null,
      ),
    );
    total += amount;
  }
  if (lines.length === 0) {
    return { lines: [], reason: "no_income_statement_activity" };
  }
  lines.push(line("Net result for the period", null, -total, null, null));
  return { lines, reason: null };
}

/**
 * The statement of cash flows, derived rather than collected.
 *
 * Every journal entry sums to zero, so the deltas of every account in the period
 * also sum to zero. That makes the change in cash exactly equal to the negated
 * sum of the deltas of every non cash account, and this section states it that
 * way: the net result, then the negated movement of each non cash balance sheet
 * account, then the change in cash. It foots by construction, not by a plug.
 *
 * D3 again. This is a derived view of the accrual ledger and the notes say so.
 */
function cashFlowSection(data: ReportData): BuiltSection {
  const lines: ReportSectionLine[] = [];
  let netResult = ZERO;
  for (const account of data.close.chart) {
    const number = account.accountNumber;
    if (isMemoAccount(number) || !isIncomeStatement(number)) continue;
    netResult += balanceOf(data.close.inPeriod, number);
  }
  const netIncome = -netResult;
  lines.push(line("Net result for the period", null, netIncome, null, null));

  let adjustments = ZERO;
  for (const account of data.close.chart) {
    const number = account.accountNumber;
    if (isMemoAccount(number) || !isBalanceSheet(number)) continue;
    if (isCashAccount(number)) continue;
    const delta = balanceOf(data.close.inPeriod, number);
    if (delta === ZERO) continue;
    const contribution = -delta;
    adjustments += contribution;
    lines.push(
      line(
        `Change in ${account.name}`,
        number,
        contribution,
        null,
        null,
      ),
    );
  }

  const openingCash = cashBalanceOf(data, data.close.priorThrough);
  const closingCash = cashBalanceOf(data, data.close.through);
  const change = netIncome + adjustments;
  lines.push(line("Net change in cash", null, change, null, null));
  lines.push(line("Cash at the start of the period", null, openingCash, null, null));
  lines.push(
    line(
      "Cash at the end of the period",
      null,
      closingCash,
      null,
      // The two figures are computed from different directions and have to
      // agree. When they do not, the package says so rather than hiding it.
      openingCash + change === closingCash
        ? null
        : "The derived change in cash does not agree with the cash accounts.",
    ),
  );
  return { lines, reason: null };
}

/** The statement of equity. Opening, the period result, movements, closing. */
function equitySection(data: ReportData): BuiltSection {
  const lines: ReportSectionLine[] = [];
  let opening = ZERO;
  let movement = ZERO;
  for (const account of data.close.chart) {
    const number = account.accountNumber;
    if (blockOf(number) !== "equity") continue;
    opening += balanceOf(data.close.priorThrough, number);
    const delta = balanceOf(data.close.inPeriod, number);
    if (delta === ZERO) continue;
    movement += delta;
    lines.push(line(`Movement in ${account.name}`, number, delta, null, null));
  }
  let netResult = ZERO;
  for (const account of data.close.chart) {
    const number = account.accountNumber;
    if (isMemoAccount(number) || !isIncomeStatement(number)) continue;
    netResult += balanceOf(data.close.inPeriod, number);
  }
  if (opening === ZERO && movement === ZERO && netResult === ZERO) {
    return { lines: [], reason: "no_equity_activity" };
  }
  const header = line("Equity at the start of the period", null, opening, null, null);
  lines.unshift(header);
  lines.push(line("Net result for the period", null, netResult, null, null));
  lines.push(
    line("Equity at the end of the period", null, opening + movement + netResult, null, null),
  );
  return { lines, reason: null };
}

/**
 * An aging section, read from the snapshot the aging run wrote at the close
 * date.
 *
 * The aging is not recomputed here. Doc 02 module 7 owns that arithmetic, and a
 * package that recomputed it could disagree with the aging the client already
 * received. When no snapshot exists at the close date the section is omitted
 * with that stated reason, which is a fact worth printing.
 */
function agingSection(
  data: ReportData,
  side: "receivable" | "payable",
): BuiltSection {
  const rows = agingFor(data, side, data.periodEnd);
  if (rows.length === 0) {
    return { lines: [], reason: `no_${side}_aging_snapshot_at_close_date` };
  }
  const lines: ReportSectionLine[] = [];
  let total = ZERO;
  for (const row of rows) {
    total += row.openBalanceCents;
    lines.push(
      line(
        `${row.partyName} ${row.documentNumber ?? ""}`.trim(),
        row.controlAccount,
        row.openBalanceCents,
        null,
        `${row.bucket} bucket, ${row.ageDays === null ? "no basis date" : `${row.ageDays} days`}`,
      ),
    );
  }
  lines.push(line("Total open", null, total, null, `${rows.length} open items`));
  const outOfTie = rows.find((r) => r.subledgerOutOfTie);
  if (outOfTie !== undefined) {
    lines.push(
      line(
        "Subledger does not tie to the control account",
        outOfTie.controlAccount,
        outOfTie.tieDifferenceCents ?? ZERO,
        null,
        "The aging and the ledger control account disagree by this amount.",
      ),
    );
  }
  return { lines, reason: null };
}

/**
 * The notes. Fixed sentences about the basis, the comparison, the exception
 * state, and the retention of the package.
 *
 * COMPLIANCE. Every sentence here is descriptive. There is no opinion, no
 * assurance language, no tax figure, and no recommendation. We are not CPAs and
 * the notes do not pretend otherwise: the last note says in plain words what the
 * package is and is not.
 */
function notesLines(data: ReportData): ReportSectionLine[] {
  const lines: ReportSectionLine[] = [
    line(
      "Basis of accounting",
      null,
      ZERO,
      null,
      "These statements are prepared on the accrual basis. Cash figures shown in this package are derived from the same ledger.",
    ),
    line(
      "Comparison",
      null,
      ZERO,
      null,
      data.comparisonAvailable
        ? "The comparison column is the prior period."
        : "No prior period figures exist, so the comparison column is blank.",
    ),
    line(
      "Period status",
      null,
      ZERO,
      null,
      data.lock === null
        ? "This period is not closed. The figures can still change."
        : "This period is closed and the ledger for it is locked.",
    ),
  ];
  if (data.lock !== null && data.lock.closedWithExceptions) {
    lines.push(
      line(
        "Exceptions at close",
        null,
        ZERO,
        null,
        data.lock.exceptionNote ??
          "This period was closed with exceptions and no note was recorded.",
      ),
    );
  }
  const failed = data.gates.filter((g) => g.outcome === "fail");
  if (failed.length > 0) {
    lines.push(
      line(
        "Close checks that did not pass",
        null,
        ZERO,
        null,
        failed
          .map((g) => g.gateCode)
          .sort()
          .join(", "),
      ),
    );
  }
  lines.push(
    line(
      "Retention",
      null,
      ZERO,
      null,
      `This package is retained until ${retentionUntil(data.periodEnd)}, counted from the period end.`,
    ),
  );
  lines.push(
    line(
      "What this package is",
      null,
      ZERO,
      null,
      "This is a bookkeeping report assembled from the client ledger. It is not an audit, a review, a compilation, or a tax return, and it contains no opinion or assurance.",
    ),
  );
  return lines;
}

/**
 * The change log. Every run that changed this period, in the order it started.
 *
 * A reader who asks why a figure moved since the last package gets an answer
 * here rather than having to ask somebody.
 *
 * Three filters, and every one of them earns its place. Applies only, because a
 * preview changed nothing. Completed only, because a refused run changed nothing
 * either. And no reporting runs, because a package that listed the run building
 * it would describe itself: the preview would see one log row, the apply would
 * see two, and the two calls would disagree over a package that is supposed to
 * be identical in both modes. See NOTES.md entry 110.
 */
function changeLogSection(data: ReportData): BuiltSection {
  const rows = data.close.runLog.filter(
    (r) =>
      r.periodStart === data.periodStart &&
      r.mode === "apply" &&
      r.status === "completed" &&
      !r.runType.startsWith("RPT-"),
  );
  if (rows.length === 0) {
    return { lines: [], reason: "no_runs_recorded_for_this_period" };
  }
  const lines = rows.map((r) =>
    line(
      r.runType,
      null,
      ZERO,
      null,
      `${r.mode} ${r.status} at ${r.startedAt} over ${r.candidateCount} candidates`,
    ),
  );
  return { lines, reason: null };
}

function insertPackage(
  frozen: FrozenScope<BuildPackageScope>,
  data: ReportData,
  rowId: Ulid,
  content: PackageContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "report_packages",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      ...content,
      builtByRunId: RUN_ID_PLACEHOLDER,
      builtAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

function insertSection(
  frozen: FrozenScope<BuildPackageScope>,
  data: ReportData,
  packageId: Ulid,
  rowId: Ulid,
  content: SectionContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "report_sections",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      packageId,
      ...content,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

/** Exported for the accounting checks and the tests. */
export { buildSections as buildPackageSections };
