/**
 * CFG-CREATE-LOAN tests. Audit fix, problem 7: the loan header plus its
 * full lender supplied amortization table, an unbalanced line refused, a
 * numbering gap refused, and the exact duplicate no-op.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, baseDb, chartAccount, opts } from "./fixtures";
import {
  ERR_LOAN_SCHEDULE_NUMBERING,
  ERR_LOAN_SCHEDULE_UNBALANCED,
  ERR_LOAN_UNKNOWN_ACCOUNT,
  cfgCreateLoan,
  loanIdFor,
  type CreateLoanScope,
} from "../runs/cfg-create-loan";
import type { LoanRow, LoanScheduleRow } from "../tables";

function twoPaymentSchedule() {
  return [
    {
      paymentNumber: 1,
      dueDate: "2026-02-01",
      paymentCents: 100000,
      principalCents: 80000,
      interestCents: 20000,
      escrowCents: 0,
      feesCents: 0,
      balanceAfterCents: 920000,
    },
    {
      paymentNumber: 2,
      dueDate: "2026-03-01",
      paymentCents: 100000,
      principalCents: 81000,
      interestCents: 19000,
      escrowCents: 0,
      feesCents: 0,
      balanceAfterCents: 839000,
    },
  ];
}

function fieldsFor(extra: Partial<CreateLoanScope["fields"]> = {}): CreateLoanScope["fields"] {
  return {
    lenderName: "First Harbor Bank",
    loanType: "equipment_note",
    principalAccountLt: "2700",
    principalAccountCp: null,
    interestAccount: "8100",
    fundingAccount: null,
    escrowAccount: null,
    originalPrincipalCents: 1000000,
    originationDate: "2026-01-01",
    firstPaymentDate: "2026-02-01",
    termMonths: 2,
    annualRateBps: 600,
    paymentCents: 100000,
    balloonCents: 0,
    rateType: "fixed",
    scheduleLines: twoPaymentSchedule(),
    ...extra,
  };
}

function loanDb() {
  const db = baseDb();
  db.seed("chart_accounts", [
    chartAccount("CH-A1-2700", FIRM_A, CLIENT_A1, "2700", "Equipment note payable"),
    chartAccount("CH-A1-8100", FIRM_A, CLIENT_A1, "8100", "Interest expense"),
  ]);
  return db;
}

test("cfg-create-loan: a new loan and its full schedule are inserted", async () => {
  const db = loanDb();
  const scope: CreateLoanScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const preview = await execute(db, cfgCreateLoan, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, cfgCreateLoan, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const loanId = loanIdFor(CLIENT_A1, scope.fields);
  const loan = (db.all("loans") as LoanRow[]).find((l) => l.id === loanId);
  assert(loan !== undefined, "the loan row exists");
  assertEqual(loan?.status, "active", "starts active");

  const lines = (db.all("loan_schedule") as LoanScheduleRow[]).filter((l) => l.loanId === loanId);
  assertEqual(lines.length, 2, "both payments inserted");
  assert(lines.some((l) => l.paymentNumber === 1), "payment 1 exists");
  assert(lines.some((l) => l.paymentNumber === 2), "payment 2 exists");
});

test("cfg-create-loan: the exact same loan twice is a no op the second time", async () => {
  const db = loanDb();
  const scope: CreateLoanScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const first = await execute(db, cfgCreateLoan, scope, opts("preview"));
  await execute(db, cfgCreateLoan, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, cfgCreateLoan, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
});

test("cfg-create-loan: an unknown interest account is refused", async () => {
  const db = loanDb();
  const scope: CreateLoanScope = { clientId: CLIENT_A1, fields: fieldsFor({ interestAccount: "8199" }) };
  const preview = await execute(db, cfgCreateLoan, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_LOAN_UNKNOWN_ACCOUNT), "named error code");
});

test("cfg-create-loan: a schedule line whose components do not foot is refused", async () => {
  const db = loanDb();
  const lines = twoPaymentSchedule();
  lines[0] = { ...lines[0], principalCents: 70000 };
  const scope: CreateLoanScope = { clientId: CLIENT_A1, fields: fieldsFor({ scheduleLines: lines }) };
  const preview = await execute(db, cfgCreateLoan, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_LOAN_SCHEDULE_UNBALANCED), "named error code");
});

test("cfg-create-loan: a gap in payment numbering is refused", async () => {
  const db = loanDb();
  const lines = twoPaymentSchedule();
  lines[1] = { ...lines[1], paymentNumber: 3 };
  const scope: CreateLoanScope = { clientId: CLIENT_A1, fields: fieldsFor({ scheduleLines: lines }) };
  const preview = await execute(db, cfgCreateLoan, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_LOAN_SCHEDULE_NUMBERING), "named error code");
});
