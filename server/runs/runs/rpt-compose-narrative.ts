/**
 * RPT-COMPOSE-NARRATIVE. Compose the period narrative.
 *
 * Spec: docs/02-run-specifications.md Module 8 RPT-COMPOSE-NARRATIVE.
 *
 * CONSTRAINT, and this is the whole point of the file. There is no language
 * model here and there never will be. Every sentence in the output comes from
 * the fixed template table below, selected by a rule that either fired or did
 * not, and filled from figures that are already on the books. Two runs over the
 * same ledger produce the same words, character for character, which is a
 * property a generated narrative cannot offer and an accounting record needs.
 *
 * COMPLIANCE, and this is the second point. We are not CPAs. Every template in
 * this file states what a figure is or how it moved. Not one of them says what
 * it means, whether it is good, or what anybody should do about it. There is no
 * opinion, no assurance, and no tax conclusion in this file, and any template
 * added later that offers one is a defect. That line is why the templates are a
 * table a person can read in one screen rather than a string built at runtime.
 *
 * The trigger log records every rule that was evaluated, fired or not, with the
 * value it computed and the threshold it compared against. A narrative that
 * lists only what fired cannot be checked, because a reader cannot tell a rule
 * that stayed quiet from a rule that never ran.
 *
 * SENDS. None. A narrative_available audit row is the only signal.
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
import { addDays, dayGap } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { NarrativeSentence, NarrativeTrigger } from "../tables";
import { periodWindow } from "./per-shared";
import { ZERO, balanceOf, blockOf } from "./close-shared";
import {
  SUSPENSE_AGE_DAYS,
  absCents,
  agingFor,
  changedFieldsOf,
  checksumOf,
  failedGates,
  loadReportData,
  reportingDiscriminator,
  type ReportData,
} from "./rpt-shared";

export const composeNarrativeScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
  audience: z.enum(["owner", "lender"]).default("owner"),
  maxSentencesPerSection: z.number().int().min(1).max(20).default(5),
});

export type ComposeNarrativeScope = z.infer<typeof composeNarrativeScopeSchema>;

/**
 * The sections, in the order they are read.
 *
 * Close first, because a reader who is about to read figures deserves to know
 * up front whether the period they came from is closed and whether anything
 * failed on the way. Putting the caveat last would be burying it.
 */
export const NARRATIVE_SECTIONS: readonly string[] = [
  "CLOSE",
  "PERFORMANCE",
  "CASH",
  "RECEIVABLES",
];

/**
 * The template table. One row per rule.
 *
 * A template is a sentence with named slots and nothing else. No conditionals
 * inside the text, no concatenation at runtime, no phrasing chosen by anything
 * other than which rule fired. Priority decides what survives a section cap, and
 * droppable false means the sentence is never cut no matter how full a section
 * is, because a period closed with exceptions is not an optional detail.
 */
interface TemplateSpec {
  triggerCode: string;
  sectionCode: string;
  templateId: string;
  priority: number;
  droppable: boolean;
  text: string;
}

export const NARRATIVE_TEMPLATES: readonly TemplateSpec[] = [
  {
    triggerCode: "CLOSED_WITH_EXCEPTIONS",
    sectionCode: "CLOSE",
    templateId: "CLOSE.EXCEPTIONS.V1",
    priority: 100,
    droppable: false,
    text: "The period {period} was closed with exceptions recorded. {note}",
  },
  {
    triggerCode: "GATE_FAILED",
    sectionCode: "CLOSE",
    templateId: "CLOSE.GATE.V1",
    priority: 90,
    droppable: false,
    text: "Close gate {gate} did not pass, with {count} blocking items at close.",
  },
  {
    triggerCode: "SUSPENSE_AGED",
    sectionCode: "CLOSE",
    templateId: "CLOSE.SUSPENSE.V1",
    priority: 70,
    droppable: true,
    text: "{count} suspense items have been open more than {days} days, totalling {amount}.",
  },
  {
    triggerCode: "STALE_RECONCILIATION",
    sectionCode: "CLOSE",
    templateId: "CLOSE.RECONCILIATION.V1",
    priority: 65,
    droppable: true,
    text: "{count} bank reconciliations for the period are not reconciled, with a difference of {amount}.",
  },
  {
    triggerCode: "PERIOD_OPEN",
    sectionCode: "CLOSE",
    templateId: "CLOSE.OPEN.V1",
    priority: 60,
    droppable: false,
    text: "The period {period} is not closed and the figures below can still change.",
  },
  {
    triggerCode: "CLOSE_CLEAN",
    sectionCode: "CLOSE",
    templateId: "CLOSE.CLEAN.V1",
    priority: 1,
    droppable: true,
    text: "The period {period} was closed with all gates passing.",
  },
  {
    triggerCode: "VARIANCE_FLAGGED",
    sectionCode: "PERFORMANCE",
    templateId: "PERF.VARIANCE.V1",
    priority: 50,
    droppable: true,
    text: "Account {account} {name} came in at {actual} against a budget of {budget}, a variance of {variance}.",
  },
  {
    triggerCode: "UNBUDGETED_ACTIVITY",
    sectionCode: "PERFORMANCE",
    templateId: "PERF.UNBUDGETED.V1",
    priority: 48,
    droppable: true,
    text: "Account {account} {name} carries no budget for the period and recorded {actual}.",
  },
  {
    triggerCode: "REVENUE_TOTAL",
    sectionCode: "PERFORMANCE",
    templateId: "PERF.REVENUE.V1",
    priority: 40,
    droppable: true,
    text: "Revenue for {period} was {amount} on an accrual basis.",
  },
  {
    triggerCode: "EXPENSE_TOTAL",
    sectionCode: "PERFORMANCE",
    templateId: "PERF.EXPENSE.V1",
    priority: 38,
    droppable: true,
    text: "Operating expense for {period} was {amount} on an accrual basis.",
  },
  {
    triggerCode: "NO_PERFORMANCE_TRIGGER",
    sectionCode: "PERFORMANCE",
    templateId: "PERF.NONE.V1",
    priority: 1,
    droppable: true,
    text: "No account exceeded its variance threshold for {period}.",
  },
  {
    triggerCode: "SHORTFALL_WEEK",
    sectionCode: "CASH",
    templateId: "CASH.SHORTFALL.V1",
    priority: 80,
    droppable: false,
    text: "The thirteen week forecast shows a negative closing balance in week {week}, beginning {weekStart}, of {amount}.",
  },
  {
    triggerCode: "CASH_POSITION",
    sectionCode: "CASH",
    templateId: "CASH.POSITION.V1",
    priority: 55,
    droppable: true,
    text: "Cash at {periodEnd} was {amount}.",
  },
  {
    triggerCode: "FORECAST_CLOSING",
    sectionCode: "CASH",
    templateId: "CASH.FORECAST.V1",
    priority: 45,
    droppable: true,
    text: "The forecast ends week thirteen at {amount} on the {scenario} scenario.",
  },
  {
    triggerCode: "NO_FORECAST",
    sectionCode: "CASH",
    templateId: "CASH.NONE.V1",
    priority: 1,
    droppable: true,
    text: "No thirteen week cash forecast has been built for {period}.",
  },
  {
    triggerCode: "AR_OVER_90",
    sectionCode: "RECEIVABLES",
    templateId: "AR.OVER90.V1",
    priority: 46,
    droppable: true,
    text: "Receivables over ninety days at {periodEnd} were {amount}.",
  },
  {
    triggerCode: "AR_TOTAL",
    sectionCode: "RECEIVABLES",
    templateId: "AR.TOTAL.V1",
    priority: 42,
    droppable: true,
    text: "Total open receivables at {periodEnd} were {amount}.",
  },
  {
    triggerCode: "AP_TOTAL",
    sectionCode: "RECEIVABLES",
    templateId: "AP.TOTAL.V1",
    priority: 41,
    droppable: true,
    text: "Total open payables at {periodEnd} were {amount}.",
  },
  {
    triggerCode: "NO_RECEIVABLE_TRIGGER",
    sectionCode: "RECEIVABLES",
    templateId: "AR.NONE.V1",
    priority: 1,
    droppable: true,
    text: "No receivable or payable aging snapshot exists at {periodEnd}.",
  },
];

/**
 * Cents as prose.
 *
 * Sentences are read by owners, not by the ledger, so a figure in a sentence is
 * written the way a person writes money. The sign is stated as a word rather
 * than a minus, because a minus sign at the start of a sentence is easy to miss
 * and the difference between owing and being owed is not a detail.
 */
export function money(value: Cents): string {
  const negative = value < ZERO;
  const magnitude = negative ? -value : value;
  const whole = (magnitude / 100n).toString();
  const fraction = (magnitude % 100n).toString().padStart(2, "0");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative
    ? `negative ${grouped}.${fraction} dollars`
    : `${grouped}.${fraction} dollars`;
}

/** One rule that fired, with the values that fill its slots. */
interface Fired {
  spec: TemplateSpec;
  merge: Record<string, string>;
  /** Distinguishes two firings of the same rule, for example two failed gates. */
  key: string;
}

/** The comparable content of a narrative row. */
interface NarrativeContent {
  audience: "owner" | "lender";
  comparisonBasis: "prior_period" | "prior_year" | "budget" | "none";
  state: "draft";
  sentenceCount: number;
  droppedCount: number;
  maxSentencesPerSection: number;
  sentences: NarrativeSentence[];
  triggerLog: NarrativeTrigger[];
  bodyText: string;
  contentChecksum: string;
  ledgerFingerprint: string;
}

export const rptComposeNarrative: Run<ComposeNarrativeScope, Proposal> = {
  type: "RPT-COMPOSE-NARRATIVE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) =>
    `${scope.clientId}:report-narrative:${scope.period.slice(0, 7)}`,
  scopeSchema: composeNarrativeScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ComposeNarrativeScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const data = await loadReportData(tx, ctx.firmId, scope.clientId, scope.period);
    // The candidates are the trigger sources, so the candidate count says how
    // many inputs the narrative looked at, not how many sentences came out.
    const candidateIds = [
      ...data.gates.map((g) => g.id),
      ...data.variances.filter((v) => v.flagged).map((v) => v.id),
      ...data.forecasts.map((f) => f.id),
    ].sort();
    const versions = [
      { id: "RPT-COMPOSE-NARRATIVE", version: 1 },
      ...data.gates.map((g) => ({ id: g.id, version: g.version })),
      ...data.variances.map((v) => ({ id: v.id, version: v.version })),
      ...data.forecasts.map((f) => ({ id: f.id, version: f.version })),
    ];
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({
        period: window.periodStart,
        candidateIds: [
          ...candidateIds,
          reportingDiscriminator(
            window.periodStart,
            data.fingerprint,
            `RPT-COMPOSE-NARRATIVE:${scope.audience}`,
          ),
        ],
        versions,
      }),
      versions,
      overriddenIds: data.narratives
        .filter((n) => n.manualOverride)
        .map((n) => n.id),
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

    const rowId = narrativeIdOf(data.periodStart, frozen.input.audience);
    const prior = data.narratives.find((n) => n.id === rowId);

    if (prior !== undefined && prior.manualOverride) {
      skips.push({
        rowId,
        reason: "manual_override",
        detail: `narrative for ${data.periodStart} carries manual_override`,
      });
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        proposals,
        skips,
        errors,
        ZERO,
      );
    }
    // A person who edited the prose owns it now. Recomposing over an edit would
    // silently delete words somebody wrote on purpose.
    if (prior !== undefined && prior.manualEdit) {
      skips.push({
        rowId,
        reason: "manual_override",
        detail: `narrative for ${data.periodStart} has been edited by hand`,
      });
      return makeResult<Proposal>(
        frozen.candidateIds.length,
        proposals,
        skips,
        errors,
        ZERO,
      );
    }

    const content = composeNarrative(
      data,
      frozen.input.audience,
      frozen.input.maxSentencesPerSection,
    );

    if (prior === undefined) {
      proposals.push(insertNarrative(frozen, data, rowId, content));
      proposals.push(narrativeAudit(frozen, data, rowId));
    } else {
      const changed = changedFieldsOf(
        prior as unknown as Record<string, unknown>,
        content as unknown as Record<string, unknown>,
      );
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `narrative_unchanged for ${data.periodStart} audience ${frozen.input.audience}`,
        });
      } else {
        proposals.push({
          kind: "field_write",
          table: "report_narratives",
          rowId,
          before: changed.before,
          after: changed.after,
          provenance: { cascadeLevel: null },
        });
      }
      const auditId = auditIdOf(rowId);
      if (!data.auditEvents.some((e) => e.id === auditId)) {
        proposals.push(narrativeAudit(frozen, data, rowId));
      }
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
      runType: "RPT-COMPOSE-NARRATIVE",
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

export function narrativeIdOf(periodStart: string, audience: string): Ulid {
  return derivedId(`${periodStart}:${audience}`, "rpt-compose-narrative", 0);
}

function auditIdOf(narrativeId: Ulid): Ulid {
  return derivedId(
    `${narrativeId}:narrative_available`,
    "rpt-compose-narrative-audit",
    0,
  );
}

/**
 * Evaluate every rule, keep what fired, cap each section, render.
 *
 * The order is deliberate. Every rule is evaluated before any is dropped, so the
 * trigger log is complete even for sentences that did not survive the cap, and a
 * reader can tell a rule that never fired from one that fired and got cut.
 */
export function composeNarrative(
  data: ReportData,
  audience: "owner" | "lender",
  maxSentencesPerSection: number,
): NarrativeContent {
  const triggerLog: NarrativeTrigger[] = [];
  const fired: Fired[] = [];
  const spec = (code: string): TemplateSpec => {
    const found = NARRATIVE_TEMPLATES.find((t) => t.triggerCode === code);
    if (found === undefined) throw new Error(`no template for trigger ${code}`);
    return found;
  };
  const log = (
    code: string,
    computedValue: string,
    threshold: string,
    didFire: boolean,
    detail: string,
  ): void => {
    triggerLog.push({
      triggerCode: code,
      sectionCode: spec(code).sectionCode,
      computedValue,
      threshold,
      fired: didFire,
      detail,
    });
  };
  const fire = (code: string, key: string, merge: Record<string, string>): void => {
    fired.push({ spec: spec(code), merge, key });
  };

  const period = data.periodStart.slice(0, 7);
  const base: Record<string, string> = {
    period,
    periodEnd: data.periodEnd,
  };

  // CLOSE.
  const locked = data.lock !== null;
  log(
    "PERIOD_OPEN",
    locked ? "locked" : "open",
    "locked",
    !locked,
    `period lock state for ${data.periodStart}`,
  );
  if (!locked) fire("PERIOD_OPEN", "period", base);

  const withExceptions = data.lock !== null && data.lock.closedWithExceptions;
  log(
    "CLOSED_WITH_EXCEPTIONS",
    withExceptions ? "true" : "false",
    "false",
    withExceptions,
    "close exception flag on the period lock",
  );
  if (withExceptions && data.lock !== null) {
    fire("CLOSED_WITH_EXCEPTIONS", "exceptions", {
      ...base,
      note: data.lock.exceptionNote ?? "No exception note was recorded.",
    });
  }

  const failed = failedGates(data);
  log(
    "GATE_FAILED",
    String(failed.length),
    "0",
    failed.length > 0,
    "close gates with a fail outcome",
  );
  // Every failed gate gets its own sentence and none of them is droppable. A
  // narrative that named two of three failures would be worse than none.
  for (const gate of failed) {
    fire("GATE_FAILED", gate.gateCode, {
      ...base,
      gate: gate.gateCode,
      count: String(gate.blockingCount),
    });
  }

  const aged = agedSuspense(data);
  log(
    "SUSPENSE_AGED",
    String(aged.count),
    `${SUSPENSE_AGE_DAYS} days`,
    aged.count > 0,
    "open suspense items older than the threshold",
  );
  if (aged.count > 0) {
    fire("SUSPENSE_AGED", "suspense", {
      ...base,
      count: String(aged.count),
      days: String(SUSPENSE_AGE_DAYS),
      amount: money(aged.totalCents),
    });
  }

  const stale = staleReconciliations(data);
  log(
    "STALE_RECONCILIATION",
    String(stale.count),
    "0",
    stale.count > 0,
    "reconciliation batches for the period that are not reconciled",
  );
  if (stale.count > 0) {
    fire("STALE_RECONCILIATION", "reconciliation", {
      ...base,
      count: String(stale.count),
      amount: money(stale.diffCents),
    });
  }

  const clean =
    locked && !withExceptions && failed.length === 0 && stale.count === 0;
  log("CLOSE_CLEAN", clean ? "clean" : "not clean", "clean", clean, "close summary");
  if (clean) fire("CLOSE_CLEAN", "clean", base);

  // PERFORMANCE.
  const flagged = data.variances
    .filter((v) => v.flagged)
    .slice()
    .sort((a, b) =>
      a.accountNumber < b.accountNumber
        ? -1
        : a.accountNumber > b.accountNumber
          ? 1
          : 0,
    );
  log(
    "VARIANCE_FLAGGED",
    String(flagged.filter((v) => v.flagCode === "over_threshold").length),
    "0",
    flagged.some((v) => v.flagCode === "over_threshold"),
    "variance rows flagged over threshold",
  );
  log(
    "UNBUDGETED_ACTIVITY",
    String(flagged.filter((v) => v.flagCode === "unbudgeted_activity").length),
    "0",
    flagged.some((v) => v.flagCode === "unbudgeted_activity"),
    "accounts with activity and no budget",
  );
  // Every flagged account is named. The cap can never cut a variance sentence
  // out of the narrative, because the brief requires the narrative to name every
  // variance over threshold, so these are raised above the cap in rank order and
  // the section cap is widened to fit them.
  for (const v of flagged) {
    if (v.flagCode === "unbudgeted_activity") {
      fire("UNBUDGETED_ACTIVITY", v.accountNumber, {
        ...base,
        account: v.accountNumber,
        name: v.accountName,
        actual: money(v.actualCents),
      });
    } else {
      fire("VARIANCE_FLAGGED", v.accountNumber, {
        ...base,
        account: v.accountNumber,
        name: v.accountName,
        actual: money(v.actualCents),
        budget: money(v.budgetCents),
        variance: money(v.varianceCents),
      });
    }
  }

  const revenue = blockTotal(data, "revenue");
  log("REVENUE_TOTAL", money(revenue), "any", revenue !== ZERO, "revenue block total");
  if (revenue !== ZERO) {
    fire("REVENUE_TOTAL", "revenue", { ...base, amount: money(absCents(revenue)) });
  }
  const opex = blockTotal(data, "opex");
  log("EXPENSE_TOTAL", money(opex), "any", opex !== ZERO, "operating expense total");
  if (opex !== ZERO) {
    fire("EXPENSE_TOTAL", "opex", { ...base, amount: money(opex) });
  }
  const anyPerformance = flagged.length > 0;
  log(
    "NO_PERFORMANCE_TRIGGER",
    String(flagged.length),
    "0",
    !anyPerformance,
    "count of flagged accounts",
  );
  if (!anyPerformance) fire("NO_PERFORMANCE_TRIGGER", "none", base);

  // CASH.
  const forecast = latestForecast(data);
  log(
    "NO_FORECAST",
    forecast === null ? "missing" : "present",
    "present",
    forecast === null,
    "thirteen week forecast header for the period",
  );
  if (forecast === null) {
    fire("NO_FORECAST", "none", base);
  } else {
    log(
      "FORECAST_CLOSING",
      money(forecast.closingCashCents),
      "any",
      true,
      "week thirteen closing balance",
    );
    fire("FORECAST_CLOSING", "closing", {
      ...base,
      amount: money(forecast.closingCashCents),
      scenario: forecast.scenario.replace("_", " "),
    });
    const week = forecast.firstShortfallWeek;
    log(
      "SHORTFALL_WEEK",
      week === null ? "none" : String(week),
      "0 cents",
      week !== null,
      "first forecast week closing below zero",
    );
    if (week !== null) {
      fire("SHORTFALL_WEEK", "shortfall", {
        ...base,
        week: String(week),
        weekStart: addDays(forecast.startDate, (week - 1) * 7),
        amount: money(forecast.closingCashCents),
      });
    }
  }
  const cash = cashAtClose(data);
  log("CASH_POSITION", money(cash), "any", true, "cash block balance at period end");
  fire("CASH_POSITION", "cash", { ...base, amount: money(cash) });

  // RECEIVABLES.
  const ar = agingFor(data, "receivable", data.periodEnd);
  const ap = agingFor(data, "payable", data.periodEnd);
  log(
    "NO_RECEIVABLE_TRIGGER",
    String(ar.length + ap.length),
    "0",
    ar.length + ap.length === 0,
    "aging snapshot rows at period end",
  );
  if (ar.length + ap.length === 0) {
    fire("NO_RECEIVABLE_TRIGGER", "none", base);
  }
  if (ar.length > 0) {
    // The tie row is a control comparison, not an open balance, so counting it
    // in a total would double the receivable the narrative reports.
    const total = ar
      .filter((r) => r.bucket !== "tie")
      .reduce((sum, r) => sum + r.openBalanceCents, ZERO);
    const over90 = ar
      .filter((r) => r.bucket === "b91_plus")
      .reduce((sum, r) => sum + r.openBalanceCents, ZERO);
    log("AR_TOTAL", money(total), "any", true, "open receivable total");
    fire("AR_TOTAL", "ar", { ...base, amount: money(total) });
    log("AR_OVER_90", money(over90), "0", over90 !== ZERO, "receivables over ninety days");
    if (over90 !== ZERO) {
      fire("AR_OVER_90", "over90", { ...base, amount: money(over90) });
    }
  }
  if (ap.length > 0) {
    const total = ap
      .filter((r) => r.bucket !== "tie")
      .reduce((sum, r) => sum + r.openBalanceCents, ZERO);
    log("AP_TOTAL", money(total), "any", true, "open payable total");
    fire("AP_TOTAL", "ap", { ...base, amount: money(total) });
  }

  const { sentences, droppedCount } = selectSentences(fired, maxSentencesPerSection);
  const bodyText = sentences.map((s) => s.text).join(" ");
  const comparisonBasis: NarrativeContent["comparisonBasis"] =
    data.variances.length > 0
      ? "budget"
      : data.comparisonAvailable
        ? "prior_period"
        : "none";

  return {
    audience,
    comparisonBasis,
    // Never anything but draft. A run does not publish an accounting narrative,
    // a person does, and the compliance line depends on that staying true.
    state: "draft",
    sentenceCount: sentences.length,
    droppedCount,
    maxSentencesPerSection,
    sentences,
    triggerLog: triggerLog
      .slice()
      .sort((a, b) =>
        a.triggerCode < b.triggerCode ? -1 : a.triggerCode > b.triggerCode ? 1 : 0,
      ),
    bodyText,
    contentChecksum: checksumOf({ sentences, bodyText }),
    ledgerFingerprint: data.fingerprint,
  };
}

/**
 * Rank, cap, and render.
 *
 * Sections keep their reading order. Inside a section the highest priority wins,
 * with the trigger code and then the firing key as tie breakers so the order is
 * total and two runs cannot disagree. A sentence marked not droppable is placed
 * before the cap is measured, so a full section sheds ordinary detail rather
 * than the one line a reader had to see.
 */
function selectSentences(
  fired: readonly Fired[],
  maxSentencesPerSection: number,
): { sentences: NarrativeSentence[]; droppedCount: number } {
  const sentences: NarrativeSentence[] = [];
  let droppedCount = 0;
  for (const sectionCode of NARRATIVE_SECTIONS) {
    const inSection = fired
      .filter((f) => f.spec.sectionCode === sectionCode)
      .slice()
      .sort((a, b) => {
        if (a.spec.priority !== b.spec.priority) return b.spec.priority - a.spec.priority;
        if (a.spec.triggerCode !== b.spec.triggerCode) {
          return a.spec.triggerCode < b.spec.triggerCode ? -1 : 1;
        }
        return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      });
    const mandatory = inSection.filter((f) => !f.spec.droppable);
    // The cap stretches to fit the sentences that cannot be dropped, so a period
    // with six failed gates reports six failed gates.
    const room = Math.max(maxSentencesPerSection, mandatory.length);
    let used = 0;
    for (const f of inSection) {
      if (f.spec.droppable && used >= room) {
        droppedCount += 1;
        continue;
      }
      used += 1;
      sentences.push({
        sectionCode,
        triggerCode: f.spec.triggerCode,
        templateId: f.spec.templateId,
        priority: f.spec.priority,
        droppable: f.spec.droppable,
        text: fillTemplate(f.spec.text, f.merge),
      });
    }
  }
  return { sentences, droppedCount };
}

/**
 * Fill the named slots in a template.
 *
 * A slot with no value is an error rather than an empty string, because a
 * sentence with a hole in it published to an owner is worse than a run that
 * stopped and said which slot was missing.
 */
export function fillTemplate(
  text: string,
  merge: Record<string, string>,
): string {
  return text.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = merge[key];
    if (value === undefined) {
      throw new Error(`narrative template slot ${key} has no value`);
    }
    return value;
  });
}

/**
 * Suspense items older than the threshold.
 *
 * A suspense row carries no date of its own, so the age comes from the
 * transaction it points at, which is the day the money actually moved and the
 * day a reader would count from anyway.
 */
export function agedSuspense(data: ReportData): { count: number; totalCents: Cents } {
  let count = 0;
  let totalCents = ZERO;
  for (const item of data.close.suspense) {
    if (item.withdrawnByRunId !== null) continue;
    const txn = data.suspenseTransactions.find((t) => t.id === item.transactionId);
    if (txn === undefined) continue;
    if (txn.postedDate > data.periodEnd) continue;
    if (dayGap(txn.postedDate, data.periodEnd) <= SUSPENSE_AGE_DAYS) continue;
    count += 1;
    totalCents += absCents(txn.amountCents);
  }
  return { count, totalCents };
}

/** Reconciliation batches covering the period that never reached reconciled. */
export function staleReconciliations(data: ReportData): {
  count: number;
  diffCents: Cents;
} {
  let count = 0;
  let diffCents = ZERO;
  for (const batch of data.close.recBatches) {
    if (batch.periodStart !== data.periodStart) continue;
    if (batch.state === "reconciled") continue;
    count += 1;
    diffCents += batch.diffCents ?? ZERO;
  }
  return { count, diffCents };
}

/** The period total for one account block, as a magnitude a reader can say. */
function blockTotal(data: ReportData, block: string): Cents {
  let total = ZERO;
  for (const account of data.close.chart) {
    if (blockOf(account.accountNumber) !== block) continue;
    total += balanceOf(data.close.inPeriod, account.accountNumber);
  }
  return block === "revenue" ? total : absCents(total);
}

/** Cash across the cash block at the close date. */
function cashAtClose(data: ReportData): Cents {
  let total = ZERO;
  for (const account of data.close.chart) {
    if (blockOf(account.accountNumber) !== "cash") continue;
    total += balanceOf(data.close.through, account.accountNumber);
  }
  return total;
}

/**
 * The forecast the narrative speaks about.
 *
 * The base scenario when one exists, because that is the forecast without an
 * assumption layered on it. Speaking from a stress scenario without saying so
 * would misstate the position.
 */
function latestForecast(data: ReportData) {
  const forPeriod = data.forecasts.filter((f) => f.periodStart === data.periodStart);
  return (
    forPeriod.find((f) => f.scenario === "base") ??
    forPeriod.slice().sort((a, b) => (a.id < b.id ? -1 : 1))[0] ??
    null
  );
}

function insertNarrative(
  frozen: FrozenScope<ComposeNarrativeScope>,
  data: ReportData,
  rowId: Ulid,
  content: NarrativeContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "report_narratives",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      ...content,
      manualEdit: false,
      composedByRunId: RUN_ID_PLACEHOLDER,
      composedAt: NOW_PLACEHOLDER,
      manualOverride: false,
    },
    provenance: { cascadeLevel: null },
  };
}

/**
 * The only send side effect this module has, and it is a log row.
 *
 * No email, no webhook, no external call anywhere in the reporting module. A row
 * that says the narrative exists is the whole of it.
 */
function narrativeAudit(
  frozen: FrozenScope<ComposeNarrativeScope>,
  data: ReportData,
  narrativeId: Ulid,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "report_audit_events",
    rowId: auditIdOf(narrativeId),
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      action: "narrative_available",
      subjectTable: "report_narratives",
      subjectId: narrativeId,
      periodStart: data.periodStart,
      actorId: ACTOR_PLACEHOLDER,
      occurredAt: NOW_PLACEHOLDER,
      runId: RUN_ID_PLACEHOLDER,
      detail: `narrative composed for ${data.periodStart} audience ${frozen.input.audience}`,
    },
    provenance: { cascadeLevel: null },
  };
}
