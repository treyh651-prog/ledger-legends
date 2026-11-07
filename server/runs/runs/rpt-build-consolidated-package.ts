/**
 * RPT-BUILD-CONSOLIDATED-PACKAGE. Combine two or more entities' figures into
 * one report package, with intercompany eliminations.
 *
 * client/src/pages/portal-entities.tsx used to say plainly "no consolidation
 * run exists in the engine yet." This is that run. It reuses RPT-BUILD-PACKAGE's
 * conventions (the nine-section catalog, the preview/apply/diff/manual-override
 * machinery, report.consolidated_packages/consolidated_sections mirroring
 * report.report_packages/report_sections) rather than inventing a second
 * shape for a versioned snapshot.
 *
 * Elimination. docs/02-run-specifications.md and docs/00-conventions.md both
 * describe a gate "G14: sum of due to and due from related party accounts
 * across the group is exactly 0," but the real G14 in cls-evaluate-gates.ts
 * is unrelated (a locked-period check) -- the docs are stale. The check is
 * not a 21st CLOSE_GATES entry: a failing gate there never blocks
 * RPT-BUILD-PACKAGE itself (data.gates only feeds a cosmetic banner; only
 * CLOSE-LOCK-PERIOD treats a failure as a hard stop), and this run needs a
 * hard stop at build time. So the check (relatedPartyNetCents,
 * consolidation-shared.ts) runs directly inside this run's own propose(),
 * refusing with ERR_CONSOLIDATION_ELIMINATIONS_UNBALANCED before anything is
 * built. The label G21 is kept only for doc/audit continuity with the
 * numbering docs 00/02 already use, not as a CLOSE_GATES member.
 *
 * The anchor client. Every run in this framework executes inside exactly
 * one client's tenant session (FrozenScope.clientId: Ulid, non-nullable --
 * contract.ts; ExecuteOptions.clientId: Ulid, non-nullable -- execute.ts),
 * because ledger.run_log.client_id is a real foreign key into
 * tenancy.clients and that table's own RLS requires it. A group spans
 * multiple clients, so this run uses the group's own first member (sorted
 * by id, the same deterministic order loadGroupMembers already returns) as
 * that single required clientId, purely for run_log/session bookkeeping.
 * Confirmed safe by reading db-postgres.ts's sessionSettings: app.client_id
 * is sent to Postgres but read by nothing in the schema (its own comment
 * says so), and tx.update() scopes its WHERE clause by id + firm_id only,
 * never by client_id. The actual package/section rows this run writes carry
 * their own explicit groupId/firmId, never the anchor client's id.
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
import type { RunTx } from "../db";
import type { ReportSectionLine } from "../tables";
import { periodWindow } from "./per-shared";
import {
  ZERO,
  blockOf,
  isBalanceSheet,
  isIncomeStatement,
  normalSideOf,
  priorDayOf,
} from "./close-shared";
import { statementLineOf } from "./statement-taxonomy";
import {
  changedFieldsOf,
  checksumOf,
  isCashAccount,
  isMemoAccount,
  retentionUntil,
  SECTION_CATALOG,
  type SectionSpec,
} from "./rpt-shared";
import {
  RELATED_PARTY_PAYABLE_ACCOUNT,
  RELATED_PARTY_RECEIVABLE_ACCOUNT,
  checkMembersHomogeneous,
  checkMembersReady,
  combinedAccountNumbers,
  combinedBalancesThrough,
  combinedCashBetween,
  combinedFingerprintOf,
  combinedInPeriod,
  combinedPriorBalancesThrough,
  combinedPriorInPeriod,
  loadConsolidationData,
  loadGroupMembers,
  relatedPartyNetCents,
  type ConsolidationData,
} from "./consolidation-shared";

export const ERR_CONSOLIDATION_MEMBER_NOT_READY = "ERR_CONSOLIDATION_MEMBER_NOT_READY";
export const ERR_CONSOLIDATION_HETEROGENEOUS_MEMBERS = "ERR_CONSOLIDATION_HETEROGENEOUS_MEMBERS";
export const ERR_CONSOLIDATION_ELIMINATIONS_UNBALANCED = "ERR_CONSOLIDATION_ELIMINATIONS_UNBALANCED";

/**
 * Last resort anchor when a group names no real member: any client the
 * firm has, purely so this run's required single clientId (see this file's
 * header comment) is a row has_client_access can actually find. Never used
 * for anything business-meaningful -- propose() reads scope.groupId, not
 * this value, for everything that matters.
 */
async function anyClientInFirm(tx: RunTx, firmId: Ulid): Promise<Ulid> {
  const clients = await tx.query("clients_for_firm", { firmId });
  if (clients.length === 0) {
    throw new Error(`firm ${firmId} has no clients at all, so this run has no client to anchor its session on`);
  }
  return clients[0].id;
}

export const buildConsolidatedPackageScopeSchema = z.object({
  groupId: z.string().min(1),
  period: z.string().min(10),
  comparisonBasis: z
    .enum(["prior_period", "prior_year", "budget", "none"])
    .default("prior_period"),
  reportBasis: z.enum(["accrual", "cash"]).default("accrual"),
});

export type BuildConsolidatedPackageScope = z.infer<typeof buildConsolidatedPackageScopeSchema>;

interface PackageContent {
  basis: "accrual" | "cash";
  comparisonBasis: "prior_period" | "prior_year" | "budget" | "none";
  comparisonAvailable: boolean;
  comparisonNote: string;
  state: "draft";
  watermark: string | null;
  closedWithExceptions: boolean;
  exceptionBanner: string | null;
  memberCount: number;
  sectionCount: number;
  omissionCount: number;
  contentChecksum: string;
  ledgerFingerprint: string;
  vaultObjectKey: string;
  vaultObjectLockMode: "GOVERNANCE";
  vaultRetentionStartsOn: string;
  vaultObjectLockUntil: string;
}

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

export const rptBuildConsolidatedPackage: Run<BuildConsolidatedPackageScope, Proposal> = {
  type: "RPT-BUILD-CONSOLIDATED-PACKAGE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.groupId}:consolidated-package:${scope.period.slice(0, 7)}`,
  scopeSchema: buildConsolidatedPackageScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<BuildConsolidatedPackageScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const memberClients = await loadGroupMembers(tx, ctx.firmId, scope.groupId);
    // When the group has no active member, checkMembersReady refuses
    // structurally inside propose() -- resolveScope still needs a real
    // client to stand in as this run's required single anchor clientId
    // (see this file's header comment), so it falls back to any client in
    // the firm rather than throwing for a case propose() already handles
    // cleanly.
    const anchorClientId = memberClients[0]?.id ?? (await anyClientInFirm(tx, ctx.firmId));
    const data = await loadConsolidationData(tx, ctx.firmId, scope.groupId, scope.period);
    const candidateIds = SECTION_CATALOG.map((s) => s.code);
    const fingerprint = combinedFingerprintOf(data.members);
    const versions = [{ id: "RPT-BUILD-CONSOLIDATED-PACKAGE", version: 1 }];
    return {
      input: { ...scope },
      clientId: anchorClientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds: [
          ...candidateIds,
          `${window.periodStart}:${fingerprint}:RPT-BUILD-CONSOLIDATED-PACKAGE:${scope.comparisonBasis}:${scope.reportBasis}`,
          ...memberClients.map((c) => c.id).sort(),
        ],
        versions,
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const refuse = (code: string, message: string): RunResult<Proposal> => {
      errors.push({ rowId: null, code, message, retryable: false });
      return makeResult<Proposal>(frozen.candidateIds.length, [], [], errors, ZERO);
    };

    const memberClients = await loadGroupMembers(tx, frozen.firmId, scope.groupId);
    const data = await loadConsolidationData(tx, frozen.firmId, scope.groupId, scope.period);

    const readyError = checkMembersReady(memberClients, data.members);
    if (readyError !== null) return refuse(ERR_CONSOLIDATION_MEMBER_NOT_READY, readyError);
    const homogeneousError = checkMembersHomogeneous(memberClients);
    if (homogeneousError !== null) return refuse(ERR_CONSOLIDATION_HETEROGENEOUS_MEMBERS, homogeneousError);

    const net = relatedPartyNetCents(data.members);
    if (net !== ZERO) {
      return refuse(
        ERR_CONSOLIDATION_ELIMINATIONS_UNBALANCED,
        `related-party balances across the group net to ${net.toString()} cents, not zero -- fix the intercompany coding on both sides before building`,
      );
    }

    const proposals: Proposal[] = [];
    const skips: Skip[] = [];

    const basis = scope.comparisonBasis;
    const reportBasis = scope.reportBasis;
    const packageId = consolidatedPackageIdOf(scope.groupId, data.periodStart, basis, reportBasis);
    const sections = buildConsolidatedSections(data, basis, reportBasis);
    const sectionRows = await tx.query("consolidated_sections_for_package", {
      firmId: frozen.firmId,
      groupId: scope.groupId,
      packageId,
    });
    const priorSectionById = new Map(sectionRows.map((r) => [r.id, r]));
    const priorPackages = await tx.query("consolidated_packages_for_group", {
      firmId: frozen.firmId,
      groupId: scope.groupId,
    });
    const priorPackage = priorPackages.find((p) => p.id === packageId);

    const content = packageContent(data, basis, reportBasis, sections);

    if (priorPackage !== undefined && priorPackage.manualOverride) {
      skips.push({
        rowId: packageId,
        reason: "manual_override",
        detail: `consolidated package for ${data.periodStart} carries manual_override`,
      });
      for (const section of sections) {
        skips.push({
          rowId: consolidatedSectionIdOf(packageId, section.sectionCode),
          reason: "manual_override",
          detail: `section ${section.sectionCode} belongs to an overridden package`,
        });
      }
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
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
          table: "consolidated_packages",
          rowId: packageId,
          before: changed.before,
          after: changed.after,
          provenance: { cascadeLevel: null },
        });
      }
    }

    for (const section of sections) {
      const rowId = consolidatedSectionIdOf(packageId, section.sectionCode);
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
        table: "consolidated_sections",
        rowId,
        before: changed.before,
        after: changed.after,
        provenance: { cascadeLevel: null },
      });
    }

    // The one delivery row. report.report_audit_events carries a nullable
    // group_id (migration 0061) for exactly this -- the single existing
    // delivery surface, reused rather than forked, same as RPT-BUILD-PACKAGE.
    const eventId = auditIdOf(packageId);
    const existingAudit = await tx.query("report_audit_events_for_group", {
      firmId: frozen.firmId,
      groupId: scope.groupId,
    });
    if (!existingAudit.some((e) => e.id === eventId)) {
      proposals.push({
        kind: "row_insert",
        table: "report_audit_events",
        rowId: eventId,
        row: {
          firmId: frozen.firmId,
          clientId: null,
          groupId: scope.groupId,
          version: 1,
          periodStart: data.periodStart,
          action: "report_available",
          subjectTable: "consolidated_packages",
          subjectId: packageId,
          detail: `consolidated package assembled from ${String(memberClients.length)} entities with ${String(content.sectionCount)} sections and ${String(content.omissionCount)} omissions`,
          createdByRunId: RUN_ID_PLACEHOLDER,
          createdAt: NOW_PLACEHOLDER,
          manualOverride: false,
        },
        provenance: { cascadeLevel: null },
      });
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "RPT-BUILD-CONSOLIDATED-PACKAGE",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function consolidatedPackageIdOf(
  groupId: Ulid,
  periodStart: string,
  comparisonBasis: string,
  reportBasis: "accrual" | "cash" = "accrual",
): Ulid {
  return derivedId(`${groupId}:${periodStart}:${comparisonBasis}:${reportBasis}`, "rpt-build-consolidated-package", 0);
}

export function consolidatedSectionIdOf(packageId: Ulid, sectionCode: string): Ulid {
  return derivedId(`${packageId}:${sectionCode}`, "rpt-build-consolidated-package-section", 0);
}

function auditIdOf(packageId: Ulid): Ulid {
  return derivedId(`${packageId}:report_available`, "rpt-build-consolidated-package-audit", 0);
}

function packageContent(
  data: ConsolidationData,
  comparisonBasis: BuildConsolidatedPackageScope["comparisonBasis"],
  reportBasis: BuildConsolidatedPackageScope["reportBasis"],
  sections: readonly SectionContent[],
): PackageContent {
  const omissions = sections.filter((s) => s.status === "omitted").length;
  const anyOpen = data.members.some((m) => m.lock === null);
  const anyExceptions = data.members.some((m) => m.lock !== null && m.lock.closedWithExceptions);
  const comparisonAvailable = data.members.every((m) => m.comparisonAvailable);
  return {
    basis: reportBasis,
    comparisonBasis,
    comparisonAvailable,
    comparisonNote: comparisonAvailable
      ? "Comparison figures are the prior period, for every member."
      : "At least one member has no prior period figures, so the comparison column is blank.",
    state: "draft",
    watermark: anyOpen ? "DRAFT. At least one member's period is not closed." : null,
    closedWithExceptions: anyExceptions,
    exceptionBanner: anyExceptions
      ? "At least one member's period closed with exceptions. See that entity's own package for detail."
      : null,
    memberCount: data.memberClients.length,
    sectionCount: sections.length,
    omissionCount: omissions,
    contentChecksum: checksumOf(sections.map((s) => ({ code: s.sectionCode, checksum: s.contentChecksum }))),
    ledgerFingerprint: combinedFingerprintOf(data.members),
    vaultObjectKey: `groups/${data.groupId}/reports/${data.periodStart}/${reportBasis}/${comparisonBasis}/package.json`,
    vaultObjectLockMode: "GOVERNANCE",
    vaultRetentionStartsOn: data.periodEnd,
    vaultObjectLockUntil: retentionUntil(data.periodEnd),
  };
}

function buildConsolidatedSections(
  data: ConsolidationData,
  comparisonBasis: BuildConsolidatedPackageScope["comparisonBasis"],
  reportBasis: BuildConsolidatedPackageScope["reportBasis"],
): SectionContent[] {
  const out: SectionContent[] = [];
  for (const spec of SECTION_CATALOG) {
    const built = buildOneSection(data, comparisonBasis, reportBasis, spec);
    out.push({
      sequence: spec.sequence,
      sectionCode: spec.code,
      sectionTitle: spec.title,
      status: built.reason === null ? "rendered" : "omitted",
      omissionReason: built.reason,
      asOfDate: data.periodEnd,
      bannerText: null,
      lines: built.lines,
      contentChecksum: checksumOf(built.lines),
    });
  }
  return out;
}

interface BuiltSection {
  lines: ReportSectionLine[];
  reason: string | null;
}

function buildOneSection(
  data: ConsolidationData,
  comparisonBasis: BuildConsolidatedPackageScope["comparisonBasis"],
  reportBasis: BuildConsolidatedPackageScope["reportBasis"],
  spec: SectionSpec,
): BuiltSection {
  switch (spec.code) {
    case "COVER":
      return { lines: coverLines(data, comparisonBasis, reportBasis), reason: null };
    case "BALANCE_SHEET":
      return balanceSheetSection(data, reportBasis);
    case "INCOME_STATEMENT":
      return incomeStatementSection(data, reportBasis);
    case "CASH_FLOW":
      return cashFlowSection(data);
    case "STATEMENT_OF_EQUITY":
      return equitySection(data);
    case "AR_AGING":
      return { lines: [], reason: "aging is a per-entity snapshot; see each member's own report package for its aging detail" };
    case "AP_AGING":
      return { lines: [], reason: "aging is a per-entity snapshot; see each member's own report package for its aging detail" };
    case "NOTES":
      return { lines: notesLines(data, reportBasis), reason: null };
    case "CHANGE_LOG":
      return { lines: [], reason: "a change log is per-entity; see each member's own report package for what changed its own ledger" };
    default:
      return { lines: [], reason: `no builder for section ${spec.code}` };
  }
}

function line(
  label: string,
  accountNumber: string | null,
  amount: Cents,
  comparison: Cents | null,
  note: string | null,
  statementLine: string | null = null,
): ReportSectionLine {
  return {
    label,
    accountNumber,
    amountCents: amount.toString(),
    comparisonCents: comparison === null ? null : comparison.toString(),
    note,
    statementLine,
  };
}

function coverLines(
  data: ConsolidationData,
  comparisonBasis: BuildConsolidatedPackageScope["comparisonBasis"],
  reportBasis: BuildConsolidatedPackageScope["reportBasis"],
): ReportSectionLine[] {
  return [
    line("Period start", null, ZERO, null, data.periodStart),
    line("Period end", null, ZERO, null, data.periodEnd),
    line(
      "Basis of accounting",
      null,
      ZERO,
      null,
      reportBasis === "cash"
        ? "Cash basis. Each member's own ledger always posts accrual; this package is a combined cash view derived from them."
        : "Accrual basis.",
    ),
    line("Comparison basis", null, ZERO, null, comparisonBasis),
    line(
      "Member entities",
      null,
      ZERO,
      null,
      data.memberClients.map((c) => c.name).join(", "),
    ),
    line(
      "Eliminations",
      null,
      ZERO,
      null,
      `Related-party balances (accounts ${RELATED_PARTY_PAYABLE_ACCOUNT} and ${RELATED_PARTY_RECEIVABLE_ACCOUNT}) net to zero across the group and are excluded from the balance sheet below.`,
    ),
  ];
}

function isEliminatedAccount(number: string): boolean {
  return number === RELATED_PARTY_PAYABLE_ACCOUNT || number === RELATED_PARTY_RECEIVABLE_ACCOUNT;
}

function balanceSheetSection(data: ConsolidationData, reportBasis: BuildConsolidatedPackageScope["reportBasis"]): BuiltSection {
  const lines: ReportSectionLine[] = [];
  let assets = ZERO;
  let liabilities = ZERO;
  let equity = ZERO;
  for (const number of combinedAccountNumbers(data.members)) {
    if (isMemoAccount(number) || !isBalanceSheet(number)) continue;
    if (isEliminatedAccount(number)) continue;
    const block = blockOf(number);
    if (reportBasis === "cash" && (block === "receivable" || block === "payable" || block === "prepaid" || block === "accrued")) {
      continue;
    }
    const amount = combinedBalancesThrough(data.members, number);
    const prior = combinedPriorBalancesThrough(data.members, number);
    if (amount === ZERO && prior === ZERO) continue;
    lines.push(line(accountNameAcross(data, number), number, amount, data.members.every((m) => m.comparisonAvailable) ? prior : null, null, statementLineOf(number)));
    if (block === "equity") equity += amount;
    else if (number < "2000") assets += amount;
    else liabilities += amount;
  }
  if (lines.length === 0) return { lines: [], reason: "no_balance_sheet_activity" };
  lines.push(line("Total assets", null, assets, null, null));
  lines.push(line("Total liabilities", null, liabilities, null, null));
  lines.push(line("Total equity before current period result", null, equity, null, null));
  return { lines, reason: null };
}

// Same normal-side display flip as the single-entity incomeStatementSection
// in rpt-build-package.ts -- revenue reads positive, expense reads positive,
// only the rendered amount changes, `total` stays raw ledger-signed.
function incomeStatementSection(data: ConsolidationData, reportBasis: BuildConsolidatedPackageScope["reportBasis"]): BuiltSection {
  const lines: ReportSectionLine[] = [];
  let total = ZERO;
  for (const number of combinedAccountNumbers(data.members)) {
    if (isMemoAccount(number) || !isIncomeStatement(number)) continue;
    const amount =
      reportBasis === "cash"
        ? combinedCashBetween(data.members, data.periodStart, data.periodEnd, number)
        : combinedInPeriod(data.members, number);
    const prior =
      reportBasis === "cash"
        ? combinedCashBetween(data.members, priorWindowStart(data.periodStart), priorDayOf(data.periodStart), number)
        : combinedPriorInPeriod(data.members, number);
    if (amount === ZERO && prior === ZERO) continue;
    const flip = normalSideOf(number) === "credit";
    lines.push(line(accountNameAcross(data, number), number, flip ? -amount : amount, data.members.every((m) => m.comparisonAvailable) ? (flip ? -prior : prior) : null, null, statementLineOf(number)));
    total += amount;
  }
  if (lines.length === 0) return { lines: [], reason: "no_income_statement_activity" };
  lines.push(line("Net result for the period", null, -total, null, null));
  return { lines, reason: null };
}

function priorWindowStart(periodStart: string): string {
  return periodWindow(priorDayOf(periodStart)).periodStart;
}

function cashFlowSection(data: ConsolidationData): BuiltSection {
  const lines: ReportSectionLine[] = [];
  let netResult = ZERO;
  for (const number of combinedAccountNumbers(data.members)) {
    if (isMemoAccount(number) || !isIncomeStatement(number)) continue;
    netResult += combinedInPeriod(data.members, number);
  }
  const netIncome = -netResult;
  lines.push(line("Net result for the period", null, netIncome, null, null));

  let adjustments = ZERO;
  for (const number of combinedAccountNumbers(data.members)) {
    if (isMemoAccount(number) || !isBalanceSheet(number)) continue;
    if (isCashAccount(number) || isEliminatedAccount(number)) continue;
    const delta = combinedInPeriod(data.members, number);
    if (delta === ZERO) continue;
    const contribution = -delta;
    adjustments += contribution;
    lines.push(line(`Change in ${accountNameAcross(data, number)}`, number, contribution, null, null));
  }

  let openingCash = ZERO;
  let closingCash = ZERO;
  for (const number of combinedAccountNumbers(data.members)) {
    if (!isCashAccount(number)) continue;
    openingCash += combinedPriorBalancesThrough(data.members, number);
    closingCash += combinedBalancesThrough(data.members, number);
  }
  const change = netIncome + adjustments;
  lines.push(line("Net change in cash", null, change, null, null));
  lines.push(line("Cash at the start of the period", null, openingCash, null, null));
  lines.push(
    line(
      "Cash at the end of the period",
      null,
      closingCash,
      null,
      openingCash + change === closingCash ? null : "The derived change in cash does not agree with the combined cash accounts.",
    ),
  );
  return { lines, reason: null };
}

function equitySection(data: ConsolidationData): BuiltSection {
  const lines: ReportSectionLine[] = [];
  let opening = ZERO;
  let movement = ZERO;
  for (const number of combinedAccountNumbers(data.members)) {
    if (blockOf(number) !== "equity") continue;
    opening += combinedPriorBalancesThrough(data.members, number);
    const delta = combinedInPeriod(data.members, number);
    if (delta === ZERO) continue;
    movement += delta;
    lines.push(line(`Movement in ${accountNameAcross(data, number)}`, number, delta, null, null, statementLineOf(number)));
  }
  let netResult = ZERO;
  for (const number of combinedAccountNumbers(data.members)) {
    if (isMemoAccount(number) || !isIncomeStatement(number)) continue;
    netResult += combinedInPeriod(data.members, number);
  }
  if (opening === ZERO && movement === ZERO && netResult === ZERO) {
    return { lines: [], reason: "no_equity_activity" };
  }
  lines.unshift(line("Equity at the start of the period", null, opening, null, null));
  lines.push(line("Net result for the period", null, netResult, null, null));
  lines.push(line("Equity at the end of the period", null, opening + movement + netResult, null, null));
  return { lines, reason: null };
}

function accountNameAcross(data: ConsolidationData, accountNumber: string): string {
  for (const m of data.members) {
    const row = m.close.chart.find((a) => a.accountNumber === accountNumber);
    if (row !== undefined) return row.name;
  }
  return accountNumber;
}

function notesLines(
  data: ConsolidationData,
  reportBasis: BuildConsolidatedPackageScope["reportBasis"],
): ReportSectionLine[] {
  const lines: ReportSectionLine[] = [
    line(
      "Basis of accounting",
      null,
      ZERO,
      null,
      reportBasis === "cash"
        ? "These combined statements are prepared on the cash basis, derived the same way a single entity's cash package is: receivables, payables, prepaid, and accrued liability balances are omitted from the balance sheet, and the income statement recognizes revenue and expense when cash moved rather than when billed."
        : "These combined statements are prepared on the accrual basis.",
    ),
    line(
      "Eliminations",
      null,
      ZERO,
      null,
      `Intercompany balances on accounts ${RELATED_PARTY_PAYABLE_ACCOUNT} and ${RELATED_PARTY_RECEIVABLE_ACCOUNT} are checked to net to exactly zero across every member before this package is built, and are excluded from the combined balance sheet.`,
    ),
    line(
      "Members",
      null,
      ZERO,
      null,
      `This package combines ${String(data.memberClients.length)} entities: ${data.memberClients.map((c) => c.name).join(", ")}.`,
    ),
    line(
      "Retention",
      null,
      ZERO,
      null,
      `This package is retained until ${retentionUntil(data.periodEnd)}, counted from the period end.`,
    ),
    line(
      "What this package is",
      null,
      ZERO,
      null,
      "This is a bookkeeping report combining several client ledgers. It is not an audit, a review, a compilation, or a tax return, and it contains no opinion or assurance.",
    ),
  ];
  return lines;
}

function insertPackage(
  frozen: FrozenScope<BuildConsolidatedPackageScope>,
  data: ConsolidationData,
  rowId: Ulid,
  content: PackageContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "consolidated_packages",
    rowId,
    row: {
      groupId: frozen.input.groupId,
      firmId: frozen.firmId,
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
  frozen: FrozenScope<BuildConsolidatedPackageScope>,
  data: ConsolidationData,
  packageId: Ulid,
  rowId: Ulid,
  content: SectionContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "consolidated_sections",
    rowId,
    row: {
      groupId: frozen.input.groupId,
      firmId: frozen.firmId,
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

/** Exported for tests. */
export { buildConsolidatedSections };
