/**
 * PAY-APPROVE-RUN tests.
 *
 * D5 is the whole point of this run: the firm reviews a register a provider
 * produced and records that review. It moves no money. The refusal to carry
 * disbursement authority is asserted here at the run level and again in
 * compliance-tests.ts at the database level, because the two are different
 * claims and only one of them survives somebody editing this file.
 */

import { assert, assertEqual, assertRejects, test } from "./harness";
import { isFieldWrite, isRowInsert } from "../contract";
import {
  ACTOR,
  CLIENT_A1,
  EMPLOYER_TAX,
  FIRM_A,
  GROSS,
  NET,
  PAY_DATE,
  PERIOD,
  PERIOD_END,
  PREPARER,
  PROVIDER,
  REGISTER_KEY,
  WITHHOLDING,
  applyDlv,
  approveScope,
  lockJanuary,
  opts,
  payRun,
  payRunsOf,
  payrollDb,
  payrollRegister,
  previewDlv,
  providerApproval,
  shapeOf,
} from "./dlv-fixtures";
import { CheckViolation } from "../db";
import type { PayRunRow } from "../tables";
import { APPROVAL_STATEMENT, payApproveRun, payRunIdOf } from "../runs/pay-approve-run";

test("preview and apply propose the same rows", async () => {
  const db = payrollDb();
  const { preview, applied } = await applyDlv(db, payApproveRun, approveScope());
  assertEqual(
    shapeOf(preview.result?.proposals ?? []),
    shapeOf(applied.result?.proposals ?? []),
    "the approval is the same on both passes",
  );
  assertEqual(payRunsOf(db).length, 1, "one pay run row landed");
  assertEqual(payRunsOf(db)[0].status, "approved", "at status approved");
});

test("ids are derived, so a rerun is a no operation", async () => {
  const db = payrollDb();
  await applyDlv(db, payApproveRun, approveScope());
  const again = await previewDlv(db, payApproveRun, approveScope());
  assertEqual((again.result?.proposals ?? []).length, 0, "nothing was approved twice");
  assert(
    (again.result?.skips ?? []).some((s) => s.detail.includes("pay_run_unchanged")),
    "the run says the approval already stands",
  );
  assertEqual(payRunsOf(db).length, 1, "and no second row appeared");
});

test("the pay run id is derived from the client, the pay date, and the provider", async () => {
  const db = payrollDb();
  await applyDlv(db, payApproveRun, approveScope());
  assertEqual(
    payRunsOf(db)[0].id,
    payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER),
    "the row sits at the derived id",
  );
  assert(
    payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER) !==
      payRunIdOf(CLIENT_A1, "2026-01-14", PROVIDER),
    "two pay dates in one month are two different rows",
  );
});

test("the period and the pay date are both in the scope hash", async () => {
  const db = payrollDb();
  const a = await previewDlv(db, payApproveRun, approveScope());
  const b = await previewDlv(db, payApproveRun, approveScope({ payDate: "2026-01-14" }));
  assert(
    a.scopeHash !== b.scopeHash,
    "two pay dates in one month must never deduplicate into one approval",
  );
});

test("the approval never carries disbursement authority", async () => {
  const db = payrollDb();
  const out = await previewDlv(db, payApproveRun, approveScope());
  const inserted = (out.result?.proposals ?? []).filter(isRowInsert);
  assertEqual(inserted.length, 1, "one row is proposed");
  assertEqual(
    inserted[0].row.authorizesDisbursement,
    false,
    "and it proposes no authority to move money",
  );
  await applyDlv(db, payApproveRun, approveScope());
  assertEqual(payRunsOf(db)[0].authorizesDisbursement, false, "nor does the stored row");
  assertEqual(
    payRunsOf(db)[0].approvalStatement,
    APPROVAL_STATEMENT,
    "and the row carries the statement of what it is and is not",
  );
});

test("the constraint pay_run_no_disbursement_authority refuses the other value", async () => {
  const db = payrollDb();
  await applyDlv(db, payApproveRun, approveScope());
  const rowId = payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER);
  await assertRejects(
    () =>
      db.tx(
      {
        firmId: FIRM_A,
        clientId: CLIENT_A1,
        actorId: ACTOR,
        actorKind: "human",
        isolation: "serializable",
        readOnly: false,
      },
      async (tx) => {
        // The cast is the point of the test. The row type forbids the value at
        // compile time, and the database has to forbid it again at write time,
        // because a cast like this one is exactly what a future caller might do.
        await tx.update("pay_runs", rowId, {
          authorizesDisbursement: true,
        } as unknown as Partial<PayRunRow>);
      },
    ),
    "pay_run_no_disbursement_authority",
    "setting the flag true is refused by that constraint, by name",
  );
  let caught: unknown = null;
  try {
    await db.tx(
      {
        firmId: FIRM_A,
        clientId: CLIENT_A1,
        actorId: ACTOR,
        actorKind: "human",
        isolation: "serializable",
        readOnly: false,
      },
      async (tx) => {
        await tx.update("pay_runs", rowId, {
          authorizesDisbursement: true,
        } as unknown as Partial<PayRunRow>);
      },
    );
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof CheckViolation, "the refusal is a check violation");
  assertEqual(
    (caught as CheckViolation).constraintName,
    "pay_run_no_disbursement_authority",
    "carrying the constraint name rather than only a message",
  );
  assertEqual(payRunsOf(db)[0].authorizesDisbursement, false, "and the row is unchanged");
});

test("an overridden pay run is never rewritten", async () => {
  const db = payrollDb();
  db.seed("pay_runs", [
    payRun(payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER), {
      manualOverride: true,
      employeeCount: 99,
    }),
  ]);
  const out = await previewDlv(db, payApproveRun, approveScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was proposed");
  assert(
    (out.result?.skips ?? []).some((s) => s.reason === "manual_override"),
    "the run reports the override",
  );
  assertEqual(payRunsOf(db)[0].employeeCount, 99, "the hand set row stands");
});

test("a locked pay date approves nothing, and the skip names the lock", async () => {
  const db = payrollDb();
  lockJanuary(db);
  const out = await previewDlv(db, payApproveRun, approveScope());
  assertEqual(payRunsOf(db).length, 0, "no approval landed");
  const reasons = [
    ...(out.result?.skips ?? []).map((s) => s.reason),
    ...(out.result?.errors ?? []).map((e) => e.code),
  ];
  assert(
    reasons.includes("locked_period") || reasons.includes("noOpenPeriod"),
    "and the run refused on the closed period rather than writing into it",
  );
});

test("no vault linked register means there is nothing to approve", async () => {
  const db = payrollDb();
  db.seed("substantiation_records", [payrollRegister({ sourceRef: null })]);
  const out = await previewDlv(db, payApproveRun, approveScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was approved");
  assert(
    (out.result?.skips ?? []).some((s) => s.reason === "missing_prerequisite"),
    "the run names the missing prerequisite",
  );
  assert(
    (out.result?.skips ?? [])[0].detail.includes("vault"),
    "and says the register is not in the vault",
  );
});

test("gross wages come off the register and are never keyed", async () => {
  const db = payrollDb();
  await applyDlv(db, payApproveRun, approveScope());
  const row = payRunsOf(db)[0];
  assertEqual(row.grossCents, GROSS, "the gross is the supported balance on the register");
  assertEqual(
    row.registerVaultObjectKey,
    REGISTER_KEY,
    "and the row points back at the object it came from",
  );
  assertEqual(row.payPeriodStart, PERIOD, "the pay period is the register's own window");
  assertEqual(row.payPeriodEnd, PERIOD_END, "both ends of it");
});

test("net is derived, gross less withholding, and never typed", async () => {
  const db = payrollDb();
  await applyDlv(db, payApproveRun, approveScope());
  const row = payRunsOf(db)[0];
  assertEqual(row.netCents, NET, "the net follows from the gross");
  assertEqual(row.netCents, row.grossCents - row.employeeWithholdingCents, "arithmetically");
  assertEqual(row.employerTaxCents, EMPLOYER_TAX, "and the employer side stands apart");
});

test("withholding above gross is refused rather than netted below zero", async () => {
  const db = payrollDb();
  const out = await previewDlv(
    db,
    payApproveRun,
    approveScope({ employeeWithholdingCents: GROSS + BigInt(1) }),
  );
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was approved");
  const errors = out.result?.errors ?? [];
  assertEqual(errors[0].code, "unbalancedEntry", "the run refuses on the arithmetic");
  assertEqual(errors[0].retryable, false, "and a retry would not help");
});

test("a provider net that disagrees with the register is refused", async () => {
  const db = payrollDb();
  db.seed("payroll_approvals", [providerApproval({ amountCents: NET + BigInt(500) })]);
  const out = await previewDlv(db, payApproveRun, approveScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was approved");
  const errors = out.result?.errors ?? [];
  assertEqual(errors[0].code, "unbalancedEntry", "the two sources have to agree");
  assert(
    errors[0].message.includes("provider"),
    "and the message says which source disagreed",
  );
});

test("the preparer of the register cannot approve it", async () => {
  const db = payrollDb();
  const out = await previewDlv(db, payApproveRun, approveScope(), {
    actor: { userId: PREPARER, kind: "human" },
  });
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was approved");
  const errors = out.result?.errors ?? [];
  assertEqual(errors[0].code, "overrideProtected", "G18 refuses the same pair of hands");
  assert(errors[0].message.includes("G18"), "and the message names the gate");
  assertEqual(
    opts("preview").actor.userId,
    ACTOR,
    "and the default actor is somebody else, so the base story approves fine",
  );
});

test("a posted run is finished and is not re approved", async () => {
  const db = payrollDb();
  db.seed("pay_runs", [
    payRun(payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER), { status: "posted" }),
  ]);
  const out = await previewDlv(db, payApproveRun, approveScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was proposed");
  assert(
    (out.result?.skips ?? []).some((s) => s.detail.includes("already posted")),
    "the run says the figures are already in the ledger",
  );
});

test("a changed register is a new decision and restamps who made it", async () => {
  const db = payrollDb();
  await applyDlv(db, payApproveRun, approveScope());
  db.seed("substantiation_records", [
    payrollRegister({ supportedBalanceCents: GROSS + BigInt(10000) }),
  ]);
  // The provider's own figure moves with it, because the two sources have to
  // agree and a test of the restamp should not be a test of the disagreement.
  db.seed("payroll_approvals", [providerApproval({ amountCents: NET + BigInt(10000) })]);
  const out = await previewDlv(db, payApproveRun, approveScope());
  const moves = (out.result?.proposals ?? []).filter(isFieldWrite);
  assertEqual(moves.length, 1, "the approval moved rather than a second row landing");
  assert("approvedBy" in moves[0].after, "the approver is restamped");
  assert("approvedAt" in moves[0].after, "and so is the moment");
  assertEqual(
    moves[0].after.grossCents,
    GROSS + BigInt(10000),
    "carrying the register's new gross",
  );
});

test("retention starts at period end and the object lock is governance", async () => {
  const db = payrollDb();
  await applyDlv(db, payApproveRun, approveScope());
  const row = payRunsOf(db)[0];
  assertEqual(row.vaultRetentionStartsOn, PERIOD_END, "D7 counts from the period end");
  assertEqual(row.vaultObjectLockMode, "GOVERNANCE", "and the object is locked");
  assert(row.vaultObjectLockUntil > PERIOD_END, "until a day well past it");
});

test("the checksum follows the figures, so a changed register is a changed row", async () => {
  const db = payrollDb();
  await applyDlv(db, payApproveRun, approveScope());
  const first = payRunsOf(db)[0].registerChecksum;
  const second = payrollDb();
  second.seed("payroll_approvals", [
    providerApproval({ amountCents: GROSS - (WITHHOLDING + BigInt(100)) }),
  ]);
  await applyDlv(
    second,
    payApproveRun,
    approveScope({ employeeWithholdingCents: WITHHOLDING + BigInt(100) }),
  );
  assert(
    payRunsOf(second)[0].registerChecksum !== first,
    "different figures produce a different checksum",
  );
});
