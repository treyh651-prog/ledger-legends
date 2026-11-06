/**
 * CFG-CREATE-SUBSTANTIATION-RECORD tests. Audit fix, found while wiring
 * problem 8's payroll approval UI: the insert, the duplicate (clientId,
 * period, kind, accountNumber) no op, an unknown account refused, and the
 * proof that matters most -- a record this run writes is actually found
 * by close-shared.ts's own recordSource() lookup, the same one G10
 * (and PAY-APPROVE-RUN) depends on.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, opts } from "./fixtures";
import { clsEvaluateGates } from "../runs/cls-evaluate-gates";
import { addAccount, applyClose, closeDb, closeScope, outcomesOf, PERIOD, seedEntry } from "./close-fixtures";
import {
  ERR_SUBSTANTIATION_UNKNOWN_ACCOUNT,
  cfgCreateSubstantiationRecord,
  substantiationRecordIdFor,
  type CreateSubstantiationRecordScope,
} from "../runs/cfg-create-substantiation-record";
import type { SubstantiationRecordRow } from "../tables";

function fieldsFor(
  extra: Partial<CreateSubstantiationRecordScope["fields"]> = {},
): CreateSubstantiationRecordScope["fields"] {
  return {
    kind: "payroll_register",
    accountNumber: "2300",
    supportedBalanceCents: 30000,
    sourceRef: "vault://payroll/jan-2026.pdf",
    preparedOn: "2026-01-31",
    ...extra,
  };
}

function substantiationDb() {
  const db = closeDb();
  addAccount(db, "2300", "Payroll liabilities");
  return db;
}

test("cfg-create-substantiation-record: a new record is inserted", async () => {
  const db = substantiationDb();
  const scope: CreateSubstantiationRecordScope = { clientId: CLIENT_A1, period: PERIOD, fields: fieldsFor() };
  const preview = await execute(db, cfgCreateSubstantiationRecord, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, cfgCreateSubstantiationRecord, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const id = substantiationRecordIdFor(CLIENT_A1, PERIOD, scope.fields);
  const row = (db.all("substantiation_records") as SubstantiationRecordRow[]).find((r) => r.id === id);
  assert(row !== undefined, "the record exists");
  // 2300 is a credit normal liability; the stored value is signed to match
  // balanceOf()'s own debit positive, credit negative ledger convention,
  // not the plain magnitude a person typed in.
  assertEqual(row?.supportedBalanceCents, BigInt(-30000), "supported balance stored in ledger sign convention");
  assert(row?.preparedBy !== null && row?.preparedBy !== undefined, "the actor was stamped");
});

test("cfg-create-substantiation-record: the same account and kind twice this period is a no op", async () => {
  const db = substantiationDb();
  const scope: CreateSubstantiationRecordScope = { clientId: CLIENT_A1, period: PERIOD, fields: fieldsFor() };
  const first = await execute(db, cfgCreateSubstantiationRecord, scope, opts("preview"));
  await execute(db, cfgCreateSubstantiationRecord, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, cfgCreateSubstantiationRecord, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(second.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("cfg-create-substantiation-record: an unknown account is refused", async () => {
  const db = substantiationDb();
  const scope: CreateSubstantiationRecordScope = {
    clientId: CLIENT_A1,
    period: PERIOD,
    fields: fieldsFor({ accountNumber: "2399" }),
  };
  const preview = await execute(db, cfgCreateSubstantiationRecord, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_SUBSTANTIATION_UNKNOWN_ACCOUNT), "named error code");
});

test("cfg-create-substantiation-record: a written record is what turns G10 from fail to pass", async () => {
  const db = substantiationDb();
  seedEntry(db, "JE-PR", "2026-01-31", [
    ["6100", BigInt(30000)],
    ["2300", -BigInt(30000)],
  ]);

  await applyClose(db, clsEvaluateGates, closeScope());
  assertEqual(outcomesOf(db).get("G10"), "fail", "G10 fails with a balance and no register to support it");

  const scope: CreateSubstantiationRecordScope = { clientId: CLIENT_A1, period: PERIOD, fields: fieldsFor() };
  const preview = await execute(db, cfgCreateSubstantiationRecord, scope, opts("preview"));
  await execute(db, cfgCreateSubstantiationRecord, scope, opts("apply", { previewRunId: preview.executionId }));

  await applyClose(db, clsEvaluateGates, closeScope());
  assertEqual(outcomesOf(db).get("G10"), "pass", "G10 passes once this run's own record supports the exact balance");
});
