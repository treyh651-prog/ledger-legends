/**
 * COMPILATION ONLY. This run compiles a data set and does nothing else with it.
 *
 * Ledger Legends is not a CPA firm. This run compiles data. It does not file,
 * issue, submit, or transmit any tax document. The compiled data set is
 * provided to the client's CPA for filing.
 *
 * TAX-BUILD-1099. Build the reportable payee data set for a calendar year.
 *
 * Spec: docs/02-run-specifications.md Module 8 TAX-BUILD-1099, and
 * docs/05-decisions.md D4 for the boundary this run sits behind.
 *
 * What the run does. It reads a whole calendar year of payments, aggregates
 * them per payee across every category and every funding account, measures each
 * payee against the dated threshold, routes the reportable amounts into form
 * boxes, and writes one header row and one line per payee per box. That data
 * set is the CPA handoff artifact. It is not a filing, it is not a form, and it
 * is not a substitute for either.
 *
 * What the run does not do, stated as code and not only as prose. There is no
 * form generation path in this file. There is no transmitter, no submission id,
 * no electronic filing call, and no external URL anywhere in it. It does not
 * write to any file table, it raises no document request, and it contacts no
 * payee. The compliance test file asserts every one of those by inspecting this
 * source.
 *
 * The threshold is dated, never a constant. Payments in a year beginning before
 * January 1, 2026 are measured against 600 dollars and payments from 2026
 * against 2,000 dollars, following section 70433 of the One Big Beautiful Bill
 * Act. The figure is read from tax.thresholds, and a year with no covering row
 * is refused rather than defaulted, because a set compiled against a guessed
 * threshold reads exactly like a correct one.
 *
 * Exclusions, every one of them a stored fact. A corporation is excluded unless
 * the class is attorney. A card or processor settled payment is excluded
 * because the processor reports it on a 1099-K. A class none category is not
 * reportable at all. And a payee with no W-9 who carries a payment hold is left
 * out entirely, because somebody already decided to stop paying them and
 * compiling them into a reportable set would contradict that decision.
 *
 * Idempotency. The data set id is derived from the client and the year, and
 * every line id is derived from the data set, the payee, and the box. A first
 * execution inserts, a later one rewrites only the fields that moved, and one
 * that finds nothing moved reports already applied.
 *
 * Locked periods. This run reads. It proposes no journal entry, writes nothing
 * into the ledger, and works perfectly well against a year that is entirely
 * locked, which is in fact the normal case for a January compilation.
 *
 * SENDS. None. There is no notification of any kind in this file.
 *
 * CONSTRAINT. No model, no score, no string distance. Every decision here is a
 * comparison of an integer against a stored integer, or a lookup of a value a
 * person recorded.
 *
 * PRIVACY. Only the last four digits of a taxpayer identification number are
 * read, compiled, or written. There is nowhere in this schema to put more.
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
import type { TaxDataLineRow, W9StatusCode } from "../tables";
import { ZERO } from "./close-shared";
import { changedFieldsOf, reportingDiscriminator } from "./rpt-shared";
import {
  COMPILATION_ONLY_BANNER,
  aggregatePayees,
  attorneyExceptionApplies,
  backupWithholdingFlag,
  checksumOf,
  isApproaching,
  isExcludedEntity,
  loadTaxData,
  meetsThreshold,
  retentionUntil,
  routeFor,
  thresholdFor,
  w9StatusOf,
  yearWindowOf,
  type PayeeTotals,
  type ReportableClass,
  type TaxData,
} from "./tax-shared";

export const build1099ScopeSchema = z.object({
  clientId: z.string().min(1),
  /** Any day inside the calendar year being compiled. */
  period: z.string().min(10),
});

export type Build1099Scope = z.infer<typeof build1099ScopeSchema>;

/** The comparable content of the data set header. */
interface DataSetContent {
  taxYear: number;
  periodStart: string;
  periodEnd: string;
  thresholdCents: Cents;
  thresholdEffectiveFrom: string;
  thresholdEffectiveTo: string | null;
  payeeCount: number;
  reportableCount: number;
  approachingCount: number;
  excludedCount: number;
  backupWithholdingCount: number;
  reportableTotalCents: Cents;
  excludedCardTotalCents: Cents;
  state: "compiled";
  compilationOnly: true;
  handoffStatement: string;
  contentChecksum: string;
  ledgerFingerprint: string;
  vaultObjectKey: string;
  vaultObjectLockMode: "GOVERNANCE";
  vaultRetentionStartsOn: string;
  vaultObjectLockUntil: string;
}

/** The comparable content of one compiled line. */
interface LineContent {
  payeeId: Ulid;
  payeeName: string;
  class1099: ReportableClass;
  formCode: "1099-NEC" | "1099-MISC";
  boxCode: "NEC-1" | "MISC-1" | "MISC-3" | "MISC-10";
  grossPaidCents: Cents;
  excludedCardCents: Cents;
  excludedClassNoneCents: Cents;
  reportableCents: Cents;
  payeeTotalCents: Cents;
  state: "reportable" | "approaching_threshold";
  w9State: W9StatusCode;
  backupWithholdingRequired: boolean;
  entityExcluded: boolean;
  attorneyExceptionApplied: boolean;
  tinLast4: string | null;
  reason: string;
}

export const taxBuild1099: Run<Build1099Scope, Proposal> = {
  type: "TAX-BUILD-1099",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:tax-1099:${scope.period.slice(0, 4)}`,
  scopeSchema: build1099ScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<Build1099Scope>> {
    const tx = requireTx(ctx);
    const taxYear = yearOf(scope.period);
    const window = yearWindowOf(taxYear);
    const data = await loadTaxData(tx, ctx.firmId, scope.clientId, taxYear);
    // The candidates are the payees. A count of payees is what the log should
    // say the run considered, not a count of the boxes they landed in.
    const payees = aggregatePayees(data);
    const candidateIds = payees.map((p) => p.vendor.id);
    const versions = [
      { id: "TAX-BUILD-1099", version: 1 },
      ...data.categories.map((c) => ({ id: c.id, version: c.version })),
      ...data.dataSets.map((d) => ({ id: d.id, version: d.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.yearStart,
      periodEnd: window.yearEnd,
      candidateIds,
      /**
       * The period and the ledger fingerprint are both in the hash. The period
       * keeps two years from colliding. The fingerprint makes a recompile after
       * somebody posts a payment a different scope, which is the whole reason a
       * stale data set cannot be served out of the deduplication table.
       */
      scopeHash: scopeHashFor({
        period: window.yearStart,
        candidateIds: [
          ...candidateIds,
          reportingDiscriminator(
            window.yearStart,
            data.fingerprint,
            `TAX-BUILD-1099:${taxYear}`,
          ),
        ],
        versions,
      }),
      versions,
      overriddenIds: data.dataSets.filter((d) => d.manualOverride).map((d) => d.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const taxYear = yearOf(frozen.input.period);
    const window = yearWindowOf(taxYear);
    const data = await loadTaxData(tx, frozen.firmId, frozen.clientId, taxYear);
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    /*
     * Doc 02 rule 1 blocker. No dated threshold row covering the year means the
     * run stops. It does not fall back to a constant, because the figure moved
     * from 600 to 2,000 dollars and a compiled set measured against the wrong
     * one is indistinguishable from a correct one when a CPA opens it.
     */
    const threshold = thresholdFor(data.thresholds, window);
    if (threshold === null) {
      errors.push({
        rowId: dataSetIdOf(frozen.clientId, taxYear),
        code: "missingAccount",
        message: `no 1099 threshold row covers ${window.yearStart}, so nothing was compiled`,
        // Retryable, because the fix is inserting the missing configuration row
        // and rerunning, not changing anything about the ledger.
        retryable: true,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const dataSetId = dataSetIdOf(frozen.clientId, taxYear);
    const priorSet = data.dataSets.find((d) => d.id === dataSetId);
    const priorLines = await tx.query("tax_data_lines_for_set", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      dataSetId,
    });
    const priorLineById = new Map<string, TaxDataLineRow>(
      priorLines.map((l) => [l.id, l]),
    );

    const payees = aggregatePayees(data);
    const built = buildLines(data, payees, threshold.thresholdCents, skips);

    /*
     * Invariant 8, doc 03 Part 6. A data set a person took over is not touched,
     * and neither are its lines, because a header and its lines are one
     * document and rewriting half of it leaves a set that does not describe
     * itself.
     */
    if (priorSet !== undefined && priorSet.manualOverride) {
      skips.push({
        rowId: dataSetId,
        reason: "manual_override",
        detail: `tax data set for ${taxYear} carries manual_override`,
      });
      for (const line of built.lines) {
        skips.push({
          rowId: lineIdOf(dataSetId, line.payeeId, line.boxCode),
          reason: "manual_override",
          detail: `line for ${line.payeeName} belongs to an overridden data set`,
        });
      }
      return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
    }

    const content = headerContent(data, built, threshold);

    if (priorSet === undefined) {
      proposals.push(insertDataSet(frozen, dataSetId, content));
    } else {
      const changed = changedFieldsOf(
        priorSet as unknown as Record<string, unknown>,
        content as unknown as Record<string, unknown>,
      );
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId: dataSetId,
          reason: "already_applied",
          detail: `data_set_unchanged for ${taxYear}`,
        });
      } else {
        proposals.push({
          kind: "field_write",
          table: "tax_data_sets",
          rowId: dataSetId,
          before: changed.before,
          after: changed.after,
          // A compiled data set is not a coding decision, so it claims no
          // cascade level, the same call the reporting runs made.
          provenance: { cascadeLevel: null },
        });
      }
    }

    for (const line of built.lines) {
      const rowId = lineIdOf(dataSetId, line.payeeId, line.boxCode);
      const prior = priorLineById.get(rowId);
      if (prior === undefined) {
        proposals.push(insertLine(frozen, dataSetId, rowId, line));
        continue;
      }
      if (prior.manualOverride) {
        skips.push({
          rowId,
          reason: "manual_override",
          detail: `line for ${line.payeeName} in ${line.boxCode} carries manual_override`,
        });
        continue;
      }
      const changed = changedFieldsOf(
        prior as unknown as Record<string, unknown>,
        line as unknown as Record<string, unknown>,
      );
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `line_unchanged for ${line.payeeName} in ${line.boxCode}`,
        });
        continue;
      }
      proposals.push({
        kind: "field_write",
        table: "tax_data_lines",
        rowId,
        before: changed.before,
        after: changed.after,
        provenance: { cascadeLevel: null },
      });
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, ZERO);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "TAX-BUILD-1099",
      runVersion: 1,
    });
  },

  /**
   * A data set a CPA may already have opened stands. Only the field writes
   * revert, on the same reasoning the report package used: an undo that deleted
   * the set would also delete the record that it existed.
   */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

/** The calendar year of any day inside it. */
export function yearOf(day: string): number {
  return Number(day.slice(0, 4));
}

export function dataSetIdOf(clientId: Ulid, taxYear: number): Ulid {
  return derivedId(`${clientId}:${taxYear}`, "tax-build-1099", 0);
}

export function lineIdOf(dataSetId: Ulid, payeeId: Ulid, boxCode: string): Ulid {
  return derivedId(`${dataSetId}:${payeeId}:${boxCode}`, "tax-build-1099-line", 0);
}

interface BuiltSet {
  lines: LineContent[];
  reportableCount: number;
  approachingCount: number;
  excludedCount: number;
  backupWithholdingCount: number;
  reportableTotalCents: Cents;
  excludedCardTotalCents: Cents;
  payeeCount: number;
}

/**
 * Turn the aggregated year into compiled lines.
 *
 * Every exclusion writes a skip with a reason, because a payee who is not in a
 * data set is a fact the firm has to be able to explain a year later.
 */
function buildLines(
  data: TaxData,
  payees: readonly PayeeTotals[],
  thresholdCents: Cents,
  skips: Skip[],
): BuiltSet {
  const lines: LineContent[] = [];
  let reportableCount = 0;
  let approachingCount = 0;
  let excludedCount = 0;
  let backupWithholdingCount = 0;
  let reportableTotalCents = ZERO;
  let excludedCardTotalCents = ZERO;

  for (const payee of payees) {
    const vendor = payee.vendor;
    excludedCardTotalCents += payee.cardCents;

    const request = data.requests.find(
      (r) => r.subjectKey === `w9:${vendor.id}` && r.catalogCode === "W9",
    );
    const status = w9StatusOf(vendor, request, data.window.yearEnd);

    /*
     * The brief's rule. A payee with no W-9 who carries a payment hold is left
     * out entirely. Somebody already stopped paying them pending paperwork, and
     * compiling them into a reportable set would hand the CPA a payee the firm
     * has explicitly parked.
     */
    if (vendor.paymentHold && !vendor.w9OnFile) {
      excludedCount += 1;
      skips.push({
        rowId: vendor.id,
        reason: "missing_prerequisite",
        detail: `payment_hold_no_w9 for ${vendor.legalName}`,
      });
      continue;
    }

    if (payee.totalCents <= ZERO && payee.cardCents > ZERO) {
      excludedCount += 1;
      skips.push({
        rowId: vendor.id,
        reason: "out_of_scope_engagement",
        detail: `reportable_by_processor_1099k for ${vendor.legalName}`,
      });
      continue;
    }

    if (payee.byClass.size === 0) {
      excludedCount += 1;
      skips.push({
        rowId: vendor.id,
        reason: "out_of_scope_engagement",
        detail: `class_none for ${vendor.legalName}`,
      });
      continue;
    }

    /*
     * The entity exclusion is decided before anything is counted. Doc 02 rule 3
     * excludes a corporation, and the attorney class is the exception that
     * survives incorporation, so the test is which classes are left rather than
     * which entity the payee is. NOTES entry 119. A payee with nothing left is
     * an excluded payee and is counted as one, so the header counts and the
     * lines under it always describe the same set.
     */
    const eligible = [...payee.byClass.keys()]
      .sort()
      .filter((cls) => attorneyExceptionApplies(cls) || !isExcludedEntity(vendor.entityType));
    if (eligible.length === 0) {
      excludedCount += 1;
      skips.push({
        rowId: vendor.id,
        reason: "out_of_scope_engagement",
        detail:
          `corporation_excluded for ${vendor.legalName}, entity type ` +
          `${vendor.entityType}, in every class paid`,
      });
      continue;
    }

    const meets = meetsThreshold(payee.totalCents, thresholdCents);
    const approaching = isApproaching(payee.totalCents, thresholdCents);
    if (!meets && !approaching) {
      skips.push({
        rowId: vendor.id,
        reason: "out_of_scope_engagement",
        detail: `below_threshold_for_year for ${vendor.legalName}`,
      });
      continue;
    }

    const flagged = backupWithholdingFlag(status, meets);
    if (flagged) backupWithholdingCount += 1;
    if (meets) {
      reportableCount += 1;
      reportableTotalCents += payee.totalCents;
    } else {
      approachingCount += 1;
    }

    /*
     * The excluded classes of a partly excluded payee. A law firm that also
     * invoices consulting has one reportable box and one excluded one, and the
     * excluded half still gets a skip so the firm can explain it later.
     */
    for (const cls of [...payee.byClass.keys()].sort()) {
      if (eligible.includes(cls)) continue;
      skips.push({
        rowId: vendor.id,
        reason: "out_of_scope_engagement",
        detail: `corporation_excluded for ${vendor.legalName} in class ${cls}`,
      });
    }

    // Classes in a fixed order, so two executions build the boxes the same way.
    for (const cls of eligible) {
      const amount = payee.byClass.get(cls) ?? ZERO;
      if (amount <= ZERO) continue;

      const attorneyException = attorneyExceptionApplies(cls);
      const route = routeFor(cls);
      lines.push({
        payeeId: vendor.id,
        payeeName: vendor.legalName,
        class1099: cls,
        formCode: route.formCode,
        boxCode: route.boxCode,
        grossPaidCents: amount,
        excludedCardCents: payee.cardCents,
        excludedClassNoneCents: payee.classNoneCents,
        reportableCents: meets ? amount : ZERO,
        payeeTotalCents: payee.totalCents,
        state: meets ? "reportable" : "approaching_threshold",
        w9State: status,
        backupWithholdingRequired: flagged,
        entityExcluded: false,
        attorneyExceptionApplied: attorneyException && isExcludedEntity(vendor.entityType),
        tinLast4: vendor.tinLast4,
        reason: reasonFor(cls, meets, status, thresholdCents, payee.totalCents),
      });
    }
  }

  return {
    lines,
    reportableCount,
    approachingCount,
    excludedCount,
    backupWithholdingCount,
    reportableTotalCents,
    excludedCardTotalCents,
    payeeCount: payees.length,
  };
}

/**
 * Why a line says what it says.
 *
 * Doc 02 Part F explainability. Every written value carries a reason built from
 * a stored template and merge fields rather than free text, so two runs over the
 * same facts produce the same sentence.
 */
function reasonFor(
  cls: ReportableClass,
  meets: boolean,
  status: W9StatusCode,
  thresholdCents: Cents,
  totalCents: Cents,
): string {
  const state = meets ? "at or above" : "below";
  return (
    `Class ${cls}. Payee total ${totalCents.toString()} cents is ${state} ` +
    `the ${thresholdCents.toString()} cent threshold. W-9 status ${status}. ` +
    `Compiled for the client's CPA. Not filed by this firm.`
  );
}

function headerContent(
  data: TaxData,
  built: BuiltSet,
  threshold: { thresholdCents: Cents; effectiveFrom: string; effectiveTo: string | null },
): DataSetContent {
  return {
    taxYear: data.window.taxYear,
    periodStart: data.window.yearStart,
    periodEnd: data.window.yearEnd,
    thresholdCents: threshold.thresholdCents,
    thresholdEffectiveFrom: threshold.effectiveFrom,
    thresholdEffectiveTo: threshold.effectiveTo,
    payeeCount: built.payeeCount,
    reportableCount: built.reportableCount,
    approachingCount: built.approachingCount,
    excludedCount: built.excludedCount,
    backupWithholdingCount: built.backupWithholdingCount,
    reportableTotalCents: built.reportableTotalCents,
    excludedCardTotalCents: built.excludedCardTotalCents,
    state: "compiled",
    compilationOnly: true,
    handoffStatement: COMPILATION_ONLY_BANNER,
    contentChecksum: checksumOf(
      built.lines.map((l) => ({
        payee: l.payeeId,
        box: l.boxCode,
        cents: l.reportableCents.toString(),
      })),
    ),
    ledgerFingerprint: data.fingerprint,
    vaultObjectKey: `clients/${data.clientId}/tax/${data.window.taxYear}/1099-data-set.json`,
    vaultObjectLockMode: "GOVERNANCE",
    // D7. The clock starts at the period end, not the day of the compile.
    vaultRetentionStartsOn: data.window.yearEnd,
    vaultObjectLockUntil: retentionUntil(data.window.yearEnd),
  };
}

function insertDataSet(
  frozen: FrozenScope<Build1099Scope>,
  rowId: Ulid,
  content: DataSetContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "tax_data_sets",
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

function insertLine(
  frozen: FrozenScope<Build1099Scope>,
  dataSetId: Ulid,
  rowId: Ulid,
  content: LineContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "tax_data_lines",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      dataSetId,
      version: 1,
      ...content,
      createdByRunId: RUN_ID_PLACEHOLDER,
      createdAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

/** Exported for the compliance checks and the tests. */
export { buildLines as build1099Lines };
