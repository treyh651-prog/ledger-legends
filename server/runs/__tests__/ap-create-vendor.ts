/**
 * AP-CREATE-VENDOR tests. The insert, the no-op repeat, and the proof that
 * matters most: the normalized name it stamps agrees with what
 * TXN-NORMALIZE-VENDORS would stamp onto a matching bank descriptor, since
 * both read the same normalizeVendor function.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { baseDb, CLIENT_A1, opts } from "./fixtures";
import {
  apCreateVendor,
  vendorIdFor,
  type CreateVendorScope,
} from "../runs/ap-create-vendor";
import { normalizeVendor } from "../runs/txn-normalize-vendors";
import type { VendorRow } from "../tables";

function scopeFor(extra: Partial<CreateVendorScope> = {}): CreateVendorScope {
  return {
    clientId: CLIENT_A1,
    legalName: "Acme Office Supply LLC",
    earlyDiscountRule: null,
    tinLast4: null,
    ...extra,
  };
}

test("ap-create-vendor: a new vendor is inserted", async () => {
  const db = baseDb();
  const scope = scopeFor();
  const preview = await execute(db, apCreateVendor, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, apCreateVendor, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const row = (db.all("vendors") as VendorRow[]).find(
    (v) => v.id === vendorIdFor(CLIENT_A1, scope.legalName),
  );
  assert(row !== undefined, "the vendor row exists");
  assertEqual(row?.legalName, scope.legalName, "legal name carried through");
  assertEqual(row?.isActive, true, "a new vendor is active");
  assertEqual(
    row?.normalizedName,
    normalizeVendor(scope.legalName).value,
    "normalized the same way TXN-NORMALIZE-VENDORS would normalize a matching descriptor",
  );
  assertEqual(row?.entityType, "unknown", "the honest default");
});

test("ap-create-vendor: the same legal name twice is a no op the second time", async () => {
  const db = baseDb();
  const scope = scopeFor();
  const first = await execute(db, apCreateVendor, scope, opts("preview"));
  await execute(db, apCreateVendor, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, apCreateVendor, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(
    second.result.skips.some((s) => s.reason === "already_applied"),
    "reported as already applied",
  );
  assertEqual((db.all("vendors") as VendorRow[]).length, 1, "only one row exists");
});

test("ap-create-vendor: a malformed tin is refused before anything is written", async () => {
  const db = baseDb();
  const scope = { ...scopeFor(), tinLast4: "12" } as CreateVendorScope;
  let threw = false;
  try {
    await execute(db, apCreateVendor, scope, opts("preview"));
  } catch {
    threw = true;
  }
  assert(threw, "the scope schema itself refuses a tin that is not four digits");
  assertEqual((db.all("vendors") as VendorRow[]).length, 0, "nothing written");
});
