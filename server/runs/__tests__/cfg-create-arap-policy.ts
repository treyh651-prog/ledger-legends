/**
 * CFG-CREATE-ARAP-POLICY tests. Audit fix, problem 7: the insert (doc 02
 * module 5 defaults applied where the firm does not override), a second
 * create for the same client refused as a no op rather than an edit, and
 * an unknown control account refused.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, baseDb, chartAccount, opts } from "./fixtures";
import {
  ERR_ARAP_POLICY_UNKNOWN_ACCOUNT,
  arapPolicyIdFor,
  cfgCreateArapPolicy,
  type CreateArapPolicyScope,
} from "../runs/cfg-create-arap-policy";
import type { ArapPolicyRow } from "../tables";

function fieldsFor(extra: Partial<CreateArapPolicyScope["fields"]> = {}): CreateArapPolicyScope["fields"] {
  return {
    agingBasis: "due_date",
    minimumStatementBalanceCents: 0,
    statementType: "open_item",
    messageNeutral: null,
    messageReminder: null,
    messageFirm: null,
    messageFinal: null,
    graceDays: 10,
    lateFeeMinimumCents: 2500,
    lateFeeMaximumCents: null,
    suppressBelowMinimumFee: true,
    writeoffAgeDays: 180,
    writeoffMinimumCents: 100,
    requiredAttempts: 3,
    writeoffMethod: "direct",
    approvalTier1Cents: 100000,
    discountBaseExcludesFreightTax: true,
    arControlAccount: "1100",
    arClearingAccount: "1200",
    allowanceAccount: null,
    badDebtAccount: null,
    salesTaxAccount: null,
    lateFeeRevenueAccount: null,
    apControlAccount: "2000",
    apClearingAccount: "1010",
    purchaseDiscountAccount: null,
    vendorCreditAccount: null,
    ...extra,
  };
}

function policyDb() {
  const db = baseDb();
  db.seed("chart_accounts", [
    chartAccount("CH-A1-1100", FIRM_A, CLIENT_A1, "1100", "Accounts receivable"),
    chartAccount("CH-A1-1200", FIRM_A, CLIENT_A1, "1200", "AR clearing"),
    chartAccount("CH-A1-2000", FIRM_A, CLIENT_A1, "2000", "Accounts payable"),
  ]);
  return db;
}

test("cfg-create-arap-policy: a new policy is inserted with its stated fields", async () => {
  const db = policyDb();
  const scope: CreateArapPolicyScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const preview = await execute(db, cfgCreateArapPolicy, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, cfgCreateArapPolicy, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const id = arapPolicyIdFor(CLIENT_A1);
  const row = (db.all("arap_policies") as ArapPolicyRow[]).find((p) => p.id === id);
  assert(row !== undefined, "the policy row exists");
  assertEqual(row?.lateFeeMinimumCents, BigInt(2500), "late fee minimum carried through");
  assertEqual(row?.arControlAccount, "1100", "AR control account carried through");
});

test("cfg-create-arap-policy: a second create for the same client is a no op, not an edit", async () => {
  const db = policyDb();
  const scope: CreateArapPolicyScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const first = await execute(db, cfgCreateArapPolicy, scope, opts("preview"));
  await execute(db, cfgCreateArapPolicy, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(
    db,
    cfgCreateArapPolicy,
    { clientId: CLIENT_A1, fields: fieldsFor({ graceDays: 30 }) },
    opts("preview"),
  );
  assertEqual(second.status, "no_op", "no_op");
  const row = (db.all("arap_policies") as ArapPolicyRow[]).find((p) => p.id === arapPolicyIdFor(CLIENT_A1));
  assertEqual(row?.graceDays, 10, "the first policy's own value stands, not overwritten");
});

test("cfg-create-arap-policy: an unknown AP clearing account is refused", async () => {
  const db = policyDb();
  const scope: CreateArapPolicyScope = { clientId: CLIENT_A1, fields: fieldsFor({ apClearingAccount: "1099" }) };
  const preview = await execute(db, cfgCreateArapPolicy, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_ARAP_POLICY_UNKNOWN_ACCOUNT), "named error code");
});
