/**
 * CFG-CREATE-DEFERRAL-SCHEDULE tests. Audit fix, problem 7: the header
 * insert (lines are PER-AMORTIZE-PREPAIDS' own job, not this run's), an
 * unknown account refused, a backwards date range refused, and the exact
 * duplicate no-op.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, baseDb, chartAccount, opts } from "./fixtures";
import {
  ERR_DEFERRAL_DATE_ORDER,
  ERR_DEFERRAL_UNKNOWN_ACCOUNT,
  cfgCreateDeferralSchedule,
  deferralScheduleIdFor,
  type CreateDeferralScheduleScope,
} from "../runs/cfg-create-deferral-schedule";
import type { DeferralScheduleRow } from "../tables";

function fieldsFor(
  extra: Partial<CreateDeferralScheduleScope["fields"]> = {},
): CreateDeferralScheduleScope["fields"] {
  return {
    kind: "prepaid",
    description: "Annual insurance policy",
    balanceAccount: "1310",
    releaseAccount: "6700",
    accumAccount: null,
    totalCents: 1200000,
    serviceStart: "2026-01-01",
    serviceEnd: "2026-12-31",
    method: "straight_line_monthly",
    periods: 12,
    sourceTransactionId: null,
    sourceDocumentId: null,
    ...extra,
  };
}

function deferralDb() {
  const db = baseDb();
  db.seed("chart_accounts", [
    chartAccount("CH-A1-1310", FIRM_A, CLIENT_A1, "1310", "Prepaid insurance"),
    chartAccount("CH-A1-6700", FIRM_A, CLIENT_A1, "6700", "Insurance expense"),
  ]);
  return db;
}

test("cfg-create-deferral-schedule: a new schedule header is inserted, active, with no lines", async () => {
  const db = deferralDb();
  const scope: CreateDeferralScheduleScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const preview = await execute(db, cfgCreateDeferralSchedule, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, cfgCreateDeferralSchedule, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const id = deferralScheduleIdFor(CLIENT_A1, scope.fields);
  const row = (db.all("deferral_schedules") as DeferralScheduleRow[]).find((s) => s.id === id);
  assert(row !== undefined, "the schedule row exists");
  assertEqual(row?.status, "active", "starts active");
  assertEqual((db.all("deferral_lines") as unknown[]).length, 0, "no lines yet, PER-AMORTIZE-PREPAIDS builds them");
});

test("cfg-create-deferral-schedule: the exact same schedule twice is a no op the second time", async () => {
  const db = deferralDb();
  const scope: CreateDeferralScheduleScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const first = await execute(db, cfgCreateDeferralSchedule, scope, opts("preview"));
  await execute(db, cfgCreateDeferralSchedule, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, cfgCreateDeferralSchedule, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
});

test("cfg-create-deferral-schedule: an unknown release account is refused", async () => {
  const db = deferralDb();
  const scope: CreateDeferralScheduleScope = {
    clientId: CLIENT_A1,
    fields: fieldsFor({ releaseAccount: "6799" }),
  };
  const preview = await execute(db, cfgCreateDeferralSchedule, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_DEFERRAL_UNKNOWN_ACCOUNT), "named error code");
});

test("cfg-create-deferral-schedule: serviceEnd before serviceStart is refused", async () => {
  const db = deferralDb();
  const scope: CreateDeferralScheduleScope = {
    clientId: CLIENT_A1,
    fields: fieldsFor({ serviceStart: "2026-12-31", serviceEnd: "2026-01-01" }),
  };
  const preview = await execute(db, cfgCreateDeferralSchedule, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_DEFERRAL_DATE_ORDER), "named error code");
});
