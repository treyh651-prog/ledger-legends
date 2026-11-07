/**
 * The scheduler's `period` gap, found in problem 5's own audit-fix round and
 * left deliberately unfixed there pending a product decision on what
 * calendar period a given firing date represents. The decision: a monthly
 * schedule firing on any day names the month that just ended, the same way
 * a person builds a report, checks a close gate, or refreshes aging after a
 * month is over rather than mid-month against a period still open.
 *
 * server/sched/runner.ts's runWindow() now folds `period:
 * priorPeriodStartOf(window.localDay)` into every scheduled scope. This file
 * proves two things, neither of which a schedule row existing would prove on
 * its own: priorPeriodStartOf's own arithmetic, and that every schedulable
 * (non manual tier) run type whose scope needs a `period` field actually
 * accepts what the runner now builds -- not just the six run types problem
 * 5's own SETUP-CREATE-DEFAULT-SCHEDULES already covered.
 */

import { assert, assertEqual, test } from "./harness";
import { priorPeriodStartOf } from "../dates";
import { applyEarlyDiscountScopeSchema } from "../runs/ap-apply-earlydiscount";
import { applyApPaymentsScopeSchema } from "../runs/ap-apply-payments";
import { applyPaymentsScopeSchema } from "../runs/ar-apply-payments";
import { buildStatementsScopeSchema } from "../runs/ar-build-statements";
import { chargeLateFeesScopeSchema } from "../runs/ar-charge-latefees";
import { refreshAgingScopeSchema } from "../runs/ar-refresh-aging";
import { writeoffScopeSchema } from "../runs/ar-writeoff-uncollectible";
import { evaluateGatesScopeSchema } from "../runs/cls-evaluate-gates";
import { rollForwardScopeSchema } from "../runs/cls-roll-forward";
import { buildHandoffScopeSchema } from "../runs/cpa-build-handoff";
import { postRegisterScopeSchema } from "../runs/pay-post-register";
import { amortizePrepaidsScopeSchema } from "../runs/per-amortize-prepaids";
import { postAccrualsScopeSchema } from "../runs/per-post-accruals";
import { postDepreciationScopeSchema } from "../runs/per-post-depreciation";
import { postRecurringScopeSchema } from "../runs/per-post-recurring";
import { reverseAccrualsScopeSchema } from "../runs/per-reverse-accruals";
import { splitLoanScopeSchema } from "../runs/per-split-loan";
import { escalateOverdueScopeSchema } from "../runs/prc-escalate-overdue";
import { generateWorkScopeSchema } from "../runs/prc-generate-work";
import { nudgeRequestsScopeSchema } from "../runs/prc-nudge-requests";
import { buildPackageScopeSchema } from "../runs/rpt-build-package";
import { composeNarrativeScopeSchema } from "../runs/rpt-compose-narrative";
import { flagVariancesScopeSchema } from "../runs/rpt-flag-variances";
import { rebuildForecastScopeSchema } from "../runs/rpt-rebuild-forecast";
import { raiseRequestsScopeSchema } from "../runs/sub-raise-requests";
import { tieBalancesScopeSchema } from "../runs/sub-tie-balances";
import { build1099ScopeSchema } from "../runs/tax-build-1099";
import { trackW9ScopeSchema } from "../runs/w9-track";

test("priorPeriodStartOf: an ordinary month rolls back one", () => {
  assertEqual(priorPeriodStartOf("2026-12-01"), "2026-11-01", "December's prior period is November");
  assertEqual(priorPeriodStartOf("2026-06-15"), "2026-05-01", "any day in June rolls back to May 1st");
});

test("priorPeriodStartOf: January rolls back into the prior year", () => {
  assertEqual(priorPeriodStartOf("2026-01-01"), "2025-12-01", "January's prior period is the prior December");
  assertEqual(priorPeriodStartOf("2026-01-31"), "2025-12-01", "any day in January, same answer");
});

/**
 * Every schedulable run type whose scope requires a `period` field, mapped
 * to that schema, for run types where server/sched/runner.ts's own scope
 * construction -- {firmId, clientId, from, to, asOf, period} -- is the
 * whole scope a real schedule row would ever supply beyond what scopeJson
 * itself carries. This is every such run type found by grepping the
 * registry for `period: z.string().min(10)` and excluding manual tier
 * (which runWindow refuses before building a scope at all) and
 * PAY-POST-REGISTER, whose own schema also requires payDate and
 * providerName -- real payroll-provider data no schedule can invent, so it
 * stays mechanically unreachable on purpose, covered by its own test below
 * rather than silently included here.
 */
const PERIOD_ONLY_SCHEMAS: ReadonlyArray<readonly [string, { safeParse: (v: unknown) => { success: boolean } }]> = [
  ["AP-APPLY-DISCOUNTS", applyEarlyDiscountScopeSchema],
  ["AP-APPLY-PAYMENTS", applyApPaymentsScopeSchema],
  ["AR-APPLY-PAYMENTS", applyPaymentsScopeSchema],
  ["AR-BUILD-STATEMENTS", buildStatementsScopeSchema],
  ["AR-CHARGE-LATEFEES", chargeLateFeesScopeSchema],
  ["ARAP-REFRESH-AGING", refreshAgingScopeSchema],
  ["AR-WRITEOFF-UNCOLLECTIBLE", writeoffScopeSchema],
  ["CLOSE-CHECK-GATES", evaluateGatesScopeSchema],
  ["CLOSE-ROLL-FORWARD", rollForwardScopeSchema],
  ["CPA-BUILD-HANDOFF", buildHandoffScopeSchema],
  ["PER-AMORTIZE-PREPAID", amortizePrepaidsScopeSchema],
  ["PER-POST-ACCRUALS", postAccrualsScopeSchema],
  ["PER-POST-DEPRECIATION", postDepreciationScopeSchema],
  ["PER-POST-RECURRING", postRecurringScopeSchema],
  ["PER-REVERSE-ACCRUALS", reverseAccrualsScopeSchema],
  ["PER-SPLIT-LOANPAYMENT", splitLoanScopeSchema],
  ["PRAC-ESCALATE-OVERDUE", escalateOverdueScopeSchema],
  ["PRAC-GENERATE-TASKS", generateWorkScopeSchema],
  ["PRAC-NUDGE-REQUESTS", nudgeRequestsScopeSchema],
  ["RPT-BUILD-PACKAGE", buildPackageScopeSchema],
  ["RPT-COMPOSE-NARRATIVE", composeNarrativeScopeSchema],
  ["RPT-FLAG-VARIANCES", flagVariancesScopeSchema],
  ["RPT-REBUILD-FORECAST", rebuildForecastScopeSchema],
  ["SUB-RAISE-REQUESTS", raiseRequestsScopeSchema],
  ["SUB-TIEOUT-ACCOUNTS", tieBalancesScopeSchema],
  ["TAX-BUILD-1099", build1099ScopeSchema],
  ["TAX-TRACK-W9", trackW9ScopeSchema],
];

test("sched period fix: every period-only schedulable run accepts the scope runWindow() now builds", () => {
  const localDay = "2026-12-01";
  const scope = {
    firmId: "FIRM-A",
    clientId: "CLI-A1",
    from: localDay,
    to: localDay,
    asOf: localDay,
    period: priorPeriodStartOf(localDay),
  };
  for (const [runType, schema] of PERIOD_ONLY_SCHEMAS) {
    const result = schema.safeParse(scope);
    assert(result.success, `${runType}'s own schema accepts what the scheduler now builds`);
  }
});

test("sched period fix: a schedule fired on any day of a month resolves to the same prior period", () => {
  // The cadence's own dayOfMonth setting (1, 15, the last business day, ...)
  // never changes which period a fire names -- only which month contains
  // that firing day, so every day in April resolves to March regardless.
  for (const day of ["2026-04-01", "2026-04-15", "2026-04-30"]) {
    assertEqual(priorPeriodStartOf(day), "2026-03-01", `${day} names March as the period that just closed`);
  }
});

test("sched period fix: PAY-POST-REGISTER stays mechanically unreachable on purpose", () => {
  // Unlike every run type above, this one also needs payDate and
  // providerName -- a real payroll provider's own register, which a
  // schedule's fixed scope can never invent. The period fix alone does not
  // and should not make this one schedulable.
  const localDay = "2026-12-01";
  const scope = {
    firmId: "FIRM-A",
    clientId: "CLI-A1",
    from: localDay,
    to: localDay,
    asOf: localDay,
    period: priorPeriodStartOf(localDay),
  };
  const result = postRegisterScopeSchema.safeParse(scope);
  assert(!result.success, "PAY-POST-REGISTER still refuses a scope with no payDate or providerName");
});
