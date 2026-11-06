/**
 * CFG-CREATE-BANKCODE-MAPPING tests. Audit fix, problem 7: a bulk insert,
 * a mapping that already exists for that institution and code skipped
 * rather than duplicated, and an unknown category refused.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, opts } from "./fixtures";
import { codingDb, standardCategories } from "./coding-fixtures";
import {
  ERR_BANKCODE_UNKNOWN_CATEGORY,
  bankCodeMappingIdFor,
  cfgCreateBankcodeMapping,
  type CreateBankCodeMappingScope,
} from "../runs/cfg-create-bankcode-mapping";
import type { BankCodeMappingRow } from "../tables";

function mappingDb() {
  const db = codingDb();
  db.seed("categories", standardCategories());
  return db;
}

test("cfg-create-bankcode-mapping: a bulk set of mappings is inserted", async () => {
  const db = mappingDb();
  const scope: CreateBankCodeMappingScope = {
    clientId: CLIENT_A1,
    mappings: [
      { institutionId: "chase", bankCode: "CAT-GROCERY", categoryId: "CAT-meals", isActive: true },
      { institutionId: "*", bankCode: "CAT-OFFICE", categoryId: "CAT-software", isActive: true },
    ],
  };
  const preview = await execute(db, cfgCreateBankcodeMapping, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, cfgCreateBankcodeMapping, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const rows = db.all("bank_code_mappings") as BankCodeMappingRow[];
  assertEqual(rows.length, 2, "both mappings inserted");
  assert(rows.some((r) => r.institutionId === "chase" && r.bankCode === "CAT-GROCERY"), "the exact match row exists");
  assert(rows.some((r) => r.institutionId === "*" && r.bankCode === "CAT-OFFICE"), "the wildcard row exists");
});

test("cfg-create-bankcode-mapping: an existing institution and code pair is skipped, not duplicated", async () => {
  const db = mappingDb();
  const scope: CreateBankCodeMappingScope = {
    clientId: CLIENT_A1,
    mappings: [{ institutionId: "chase", bankCode: "CAT-GROCERY", categoryId: "CAT-meals", isActive: true }],
  };
  const first = await execute(db, cfgCreateBankcodeMapping, scope, opts("preview"));
  await execute(db, cfgCreateBankcodeMapping, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, cfgCreateBankcodeMapping, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(second.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("cfg-create-bankcode-mapping: an unknown category refuses the whole call", async () => {
  const db = mappingDb();
  const scope: CreateBankCodeMappingScope = {
    clientId: CLIENT_A1,
    mappings: [{ institutionId: "chase", bankCode: "CAT-NOPE", categoryId: "CAT-ghost", isActive: true }],
  };
  const preview = await execute(db, cfgCreateBankcodeMapping, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_BANKCODE_UNKNOWN_CATEGORY), "named error code");
  const id = bankCodeMappingIdFor(CLIENT_A1, "chase", "CAT-NOPE");
  assert(!(db.all("bank_code_mappings") as BankCodeMappingRow[]).some((r) => r.id === id), "nothing was inserted");
});
