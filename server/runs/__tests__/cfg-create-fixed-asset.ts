/**
 * CFG-CREATE-FIXED-ASSET tests. Audit fix, problem 7: the insert, the exact
 * duplicate no-op, an unknown account refused, and the generated
 * depreciable_base_cents column staying correct for the in-memory double.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, baseDb, chartAccount, opts } from "./fixtures";
import {
  ERR_ASSET_UNKNOWN_ACCOUNT,
  ERR_ASSET_SALVAGE_EXCEEDS_COST,
  cfgCreateFixedAsset,
  fixedAssetIdFor,
  type CreateFixedAssetScope,
} from "../runs/cfg-create-fixed-asset";
import type { FixedAssetRow } from "../tables";

function fieldsFor(extra: Partial<CreateFixedAssetScope["fields"]> = {}): CreateFixedAssetScope["fields"] {
  return {
    tag: "VAN-1",
    description: "Delivery van",
    assetClass: "vehicles",
    costAccount: "1500",
    accumAccount: "1590",
    expenseAccount: "6600",
    acquiredOn: "2026-01-02",
    placedInServiceOn: "2026-01-02",
    costCents: 4000000,
    salvageCents: 500000,
    method: "straight_line",
    lifeMonths: 60,
    ddbFactorBps: null,
    macrsRecoveryYears: null,
    unitsTotal: null,
    convention: "full_month",
    halfMonthConvention: false,
    ...extra,
  };
}

function assetDb() {
  const db = baseDb();
  db.seed("chart_accounts", [
    chartAccount("CH-A1-1500", FIRM_A, CLIENT_A1, "1500", "Vehicles"),
    chartAccount("CH-A1-1590", FIRM_A, CLIENT_A1, "1590", "Accum depreciation, vehicles"),
    chartAccount("CH-A1-6600", FIRM_A, CLIENT_A1, "6600", "Depreciation expense"),
  ]);
  return db;
}

test("cfg-create-fixed-asset: a new asset is inserted with its generated depreciable base", async () => {
  const db = assetDb();
  const scope: CreateFixedAssetScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const preview = await execute(db, cfgCreateFixedAsset, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, cfgCreateFixedAsset, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const id = fixedAssetIdFor(CLIENT_A1, scope.fields);
  const row = (db.all("fixed_assets") as FixedAssetRow[]).find((a) => a.id === id);
  assert(row !== undefined, "the asset row exists");
  assertEqual(row?.costCents, BigInt(4000000), "cost carried through");
  assertEqual(row?.depreciableBaseCents, BigInt(3500000), "cost minus salvage");
  assertEqual(row?.status, "active", "starts active");
});

test("cfg-create-fixed-asset: the exact same asset twice is a no op the second time", async () => {
  const db = assetDb();
  const scope: CreateFixedAssetScope = { clientId: CLIENT_A1, fields: fieldsFor() };
  const first = await execute(db, cfgCreateFixedAsset, scope, opts("preview"));
  await execute(db, cfgCreateFixedAsset, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, cfgCreateFixedAsset, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(second.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("cfg-create-fixed-asset: an unknown cost account is refused", async () => {
  const db = assetDb();
  const scope: CreateFixedAssetScope = { clientId: CLIENT_A1, fields: fieldsFor({ costAccount: "1599" }) };
  const preview = await execute(db, cfgCreateFixedAsset, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_ASSET_UNKNOWN_ACCOUNT), "named error code");
});

test("cfg-create-fixed-asset: salvage above cost is refused", async () => {
  const db = assetDb();
  const scope: CreateFixedAssetScope = {
    clientId: CLIENT_A1,
    fields: fieldsFor({ costCents: 100000, salvageCents: 200000 }),
  };
  const preview = await execute(db, cfgCreateFixedAsset, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_ASSET_SALVAGE_EXCEEDS_COST), "named error code");
});
