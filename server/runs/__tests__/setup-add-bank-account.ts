/**
 * SETUP-ADD-BANK-ACCOUNT tests. The insert, the no-op repeat on the same
 * chart account, an account that is not on the chart, and the proof that
 * matters most: once this run has added an account, IMPORT-PARSE-FEED can
 * actually parse a feed against it, which was impossible before this run
 * existed because nothing ever put a bank account on the books at all.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, baseDb, chartAccount, opts } from "./fixtures";
import {
  bankAccountIdFor,
  setupAddBankAccount,
  type AddBankAccountScope,
} from "../runs/setup-add-bank-account";
import { importParseFeed } from "../runs/import-parse-feed";
import type { BankAccountRow } from "../tables";

function scopeFor(extra: Partial<AddBankAccountScope> = {}): AddBankAccountScope {
  return {
    clientId: CLIENT_A1,
    accountNumber: "1030",
    nickname: "New checking",
    kind: "bank",
    institutionName: "First Harbor Bank",
    ...extra,
  };
}

test("setup-add-bank-account: a new account is inserted", async () => {
  const db = baseDb();
  db.seed("chart_accounts", [chartAccount("CH-A1-1030", FIRM_A, CLIENT_A1, "1030", "New checking")]);
  const scope = scopeFor();
  const preview = await execute(db, setupAddBankAccount, scope, opts("preview"));
  assertEqual(preview.status, "completed", "preview completed");
  const applied = await execute(db, setupAddBankAccount, scope, opts("apply", { previewRunId: preview.executionId }));
  assertEqual(applied.status, "completed", "apply completed");

  const row = (db.all("bank_accounts") as BankAccountRow[]).find(
    (a) => a.id === bankAccountIdFor(CLIENT_A1, scope.accountNumber),
  );
  assert(row !== undefined, "the bank account row exists");
  assertEqual(row?.accountNumber, "1030", "feeds the named chart account");
  assertEqual(row?.nickname, "New checking", "nickname carried through");
  assertEqual(row?.kind, "bank", "kind carried through");
});

test("setup-add-bank-account: the same chart account twice is a no op the second time", async () => {
  const db = baseDb();
  db.seed("chart_accounts", [chartAccount("CH-A1-1030", FIRM_A, CLIENT_A1, "1030", "New checking")]);
  const scope = scopeFor();
  const first = await execute(db, setupAddBankAccount, scope, opts("preview"));
  await execute(db, setupAddBankAccount, scope, opts("apply", { previewRunId: first.executionId }));
  const second = await execute(db, setupAddBankAccount, scope, opts("preview"));
  assertEqual(second.status, "no_op", "no_op");
  assert(
    second.result.skips.some((s) => s.reason === "already_applied"),
    "reported as already applied",
  );
});

test("setup-add-bank-account: an account not on the chart is refused", async () => {
  const db = baseDb();
  const scope = scopeFor({ accountNumber: "1099" });
  const preview = await execute(db, setupAddBankAccount, scope, opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(
    preview.result.errors.some((e) => e.code === "ACCOUNT_NOT_ON_CHART"),
    "named error code",
  );
});

test("setup-add-bank-account: once added, IMPORT-PARSE-FEED can parse a feed against it", async () => {
  const db = baseDb();
  db.seed("chart_accounts", [chartAccount("CH-A1-1030", FIRM_A, CLIENT_A1, "1030", "New checking")]);
  const scope = scopeFor();
  const addPreview = await execute(db, setupAddBankAccount, scope, opts("preview"));
  await execute(db, setupAddBankAccount, scope, opts("apply", { previewRunId: addPreview.executionId }));
  const bankAccountId = bankAccountIdFor(CLIENT_A1, scope.accountNumber);

  const ofx = `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260115<TRNAMT>-42.50<FITID>FITID-1<NAME>Supplier Co</STMTTRN>`;
  const parsePreview = await execute(
    db,
    importParseFeed,
    {
      clientId: CLIENT_A1,
      bankAccountId,
      batchName: "Feb statement",
      institutionName: "First Harbor Bank",
      sourceFormat: "ofx" as const,
      fileText: ofx,
      grid: null,
      sourceDocumentId: null,
    },
    opts("preview"),
  );
  assertEqual(parsePreview.status, "completed", "the feed parses against the account this run added");
  assert(
    !parsePreview.result.errors.some((e) => e.code === "UNKNOWN_BANK_ACCOUNT"),
    "the account is known, which was impossible before this run existed",
  );
});
