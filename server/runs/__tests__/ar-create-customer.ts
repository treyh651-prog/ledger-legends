/**
 * AR-CREATE-CUSTOMER tests. The insert, the no-op repeat, and the fee
 * configuration the store itself would otherwise refuse with a bare
 * constraint name.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { baseDb, CLIENT_A1, opts } from "./fixtures";
import { arCreateCustomer, customerIdFor, type CreateCustomerScope } from "../runs/ar-create-customer";
import type { CustomerRow } from "../tables";

function scopeFor(extra: Partial<CreateCustomerScope> = {}): CreateCustomerScope {
  return {
    clientId: CLIENT_A1,
    name: "Northgate Consulting Group LLC",
    lateFeeEnabled: false,
    annualizedRateBp: null,
    graceDays: null,
    ...extra,
  };
}

test("ar-create-customer: a new customer is inserted", async () => {
  const db = baseDb();
  const scope = scopeFor();
  const preview = await execute(db, arCreateCustomer, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, arCreateCustomer, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");
  const row = (db.all("customers") as CustomerRow[]).find(
    (c) => c.id === customerIdFor(CLIENT_A1, scope.name),
  );
  assert(row !== undefined, "the customer row exists");
  assertEqual(row?.name, scope.name, "name carried through");
  assertEqual(row?.isActive, true, "a new customer is active");
});

test("ar-create-customer: the same name twice is a no op the second time", async () => {
  const db = baseDb();
  const scope = scopeFor();
  const first = await execute(db, arCreateCustomer, scope, opts("preview"));
  await execute(db, arCreateCustomer, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, arCreateCustomer, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(
    second.result.skips.some((s) => s.reason === "already_applied"),
    "reported as already applied",
  );
  assertEqual((db.all("customers") as CustomerRow[]).length, 1, "only one row exists");
});

test("ar-create-customer: a late fee switched on with no rate refuses", async () => {
  const db = baseDb();
  const scope = scopeFor({ lateFeeEnabled: true, annualizedRateBp: null });
  const preview = await execute(db, arCreateCustomer, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "LATE_FEE_NEEDS_A_RATE"),
    "named error code",
  );
  assertEqual((db.all("customers") as CustomerRow[]).length, 0, "nothing written");
});
