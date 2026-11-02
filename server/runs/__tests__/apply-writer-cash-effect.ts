/**
 * The generic doc 05 Part 4 (D3) cash_effect/cash_event_date inference in
 * apply-writer.ts's journal-line insert. Traced here against the four
 * representative entry shapes that drove its design: a direct coded
 * transaction (both lines cash), an invoice (both lines accrual_only, no
 * cash leg at all), a depreciation entry (both lines none, on both bases),
 * and an accrual (both lines accrual_only). AR-APPLY-PAYMENTS/
 * AP-APPLY-PAYMENTS' own explicit override of this inference is covered in
 * their own test files, not repeated here.
 */

import { assert, assertEqual, test } from "./harness";
import { execute } from "../execute";
import { CLIENT_A1, FIRM_A, chartAccount, scopeFor, opts } from "./fixtures";
import { codingDb, standardCategories } from "./coding-fixtures";
import { txnPostCoded } from "../runs/txn-post-coded";
import type { TransactionRow, JournalLineRow } from "../tables";
import { arapDb, customer } from "./arap-fixtures";
import { arCreateInvoice, type CreateInvoiceScope } from "../runs/ar-create-invoice";
import { perDb, applyPer, periodScope, asset } from "./per-fixtures";
import { perPostDepreciation } from "../runs/per-post-depreciation";
import { accrualTemplate } from "./per-fixtures";
import { perPostAccruals } from "../runs/per-post-accruals";

function txnFor(id: string, extra: Record<string, unknown> = {}): TransactionRow {
  return {
    id,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    bankAccountId: "BA-A1-CARD",
    accountNumber: "1010",
    postedDate: "2026-01-15",
    amountCents: BigInt(-5000),
    currency: "USD",
    description: "office supplies",
    bankMerchantName: null,
    normalizedVendor: null,
    vendorNormalizationVersion: null,
    normalizationDegraded: false,
    vendorId: null,
    checkNumber: null,
    bankCode: null,
    institutionId: null,
    bankTransactionId: null,
    source: "import",
    importBatchId: null,
    stagedRowId: null,
    categoryId: "CAT-software",
    categoryVersion: 1,
    cascadeLevel: 6,
    ruleId: null,
    ruleVersion: null,
    matchedConditions: null,
    autoPostedUnderRulePromotion: false,
    templateId: null,
    templateVersion: null,
    classId: null,
    locationId: null,
    programId: null,
    suspenseReason: null,
    suspenseOwner: null,
    suspenseOpenedOn: null,
    suspenseEscalatesOn: null,
    pairedWithId: null,
    settlementOfTransactionId: null,
    isProcessorSettlement: false,
    duplicateFlag: false,
    duplicateOfTransactionId: null,
    legitimateRepeat: false,
    journalEntryId: null,
    instrumentType: "other",
    cleared: false,
    clearedDate: null,
    statementId: null,
    statementLineId: null,
    statementDate: null,
    matchTier: null,
    matchConfidence: null,
    recBatchId: null,
    staleFlagged: false,
    staleFlaggedOn: null,
    staleOwner: null,
    staleEscalatesOn: null,
    escheatReview: false,
    voided: false,
    voidOfTransactionId: null,
    reissueOfTransactionId: null,
    status: "active",
    manualOverride: false,
    manualOverrideBy: null,
    manualOverrideAt: null,
    ruleReviewedAt: null,
    ruleReviewOutcome: null,
    version: 1,
    ...extra,
  };
}

test("cash effect inference: a direct coded transaction tags both lines cash, dated the posting date", async () => {
  const db = codingDb();
  db.seed("categories", standardCategories());
  db.seed("transactions", [txnFor("TX-1")]);
  const preview = await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("preview"));
  await execute(db, txnPostCoded, scopeFor(CLIENT_A1), opts("apply", { previewRunId: preview.executionId }));

  const lines = db.all("journal_lines") as JournalLineRow[];
  assertEqual(lines.length, 2, "two lines posted");
  for (const l of lines) {
    assertEqual(l.cashEffect, "cash", `line on ${l.accountNumber} is cash, money moved this transaction`);
    assertEqual(l.cashEventDate, "2026-01-15", "dated the posting date");
  }
});

test("cash effect inference: an invoice's lines are both accrual_only, no cash leg at all", async () => {
  const db = arapDb();
  db.seed("customers", [customer("CUS-1")]);
  const scope: CreateInvoiceScope = {
    clientId: CLIENT_A1,
    customerId: "CUS-1",
    invoiceNumber: "INV-1001",
    invoiceDate: "2026-01-15",
    dueDate: "2026-02-14",
    amountCents: "100000",
    taxCents: "0",
    revenueAccount: "4100",
  };
  const preview = await execute(db, arCreateInvoice, scope, opts("preview"));
  await execute(db, arCreateInvoice, scope, opts("apply", { previewRunId: preview.executionId }));

  const lines = db.all("journal_lines") as JournalLineRow[];
  assertEqual(lines.length, 2, "two lines posted");
  assert(
    lines.every((l) => l.cashEffect === "accrual_only"),
    "neither the receivable leg nor the revenue leg saw cash move",
  );
  for (const l of lines) assertEqual(l.cashEventDate, null, "no cash event date");
});

test("cash effect inference: a depreciation entry is tagged none on both legs, shown on both bases", async () => {
  const db = perDb();
  // The default fixture chart uses 6700/1590 for its own test purposes; this
  // test needs the real shared-core literal accounts cashEffectOf keys on.
  db.seed("chart_accounts", [
    chartAccount("CH-A1-6800", FIRM_A, CLIENT_A1, "6800", "Depreciation expense"),
    chartAccount("CH-A1-1600", FIRM_A, CLIENT_A1, "1600", "Accumulated depreciation"),
  ]);
  db.seed("fixed_assets", [
    asset("FA-1", { expenseAccount: "6800", accumAccount: "1600" }),
  ]);
  await applyPer(db, perPostDepreciation, periodScope());

  const lines = db.all("journal_lines") as JournalLineRow[];
  assertEqual(lines.length, 2, "two lines posted");
  assert(
    lines.every((l) => l.cashEffect === "none"),
    "depreciation is excluded from neither basis -- doc 05, it stays on both",
  );
  for (const l of lines) assertEqual(l.cashEventDate, null, "no cash event date");
});

test("cash effect inference: an accrual's lines are both accrual_only", async () => {
  const db = perDb();
  db.seed("accrual_templates", [accrualTemplate("AT-RENT")]);
  await applyPer(db, perPostAccruals, periodScope());

  const lines = db.all("journal_lines") as JournalLineRow[];
  assertEqual(lines.length, 2, "two lines posted");
  assert(
    lines.every((l) => l.cashEffect === "accrual_only"),
    "a pure timing entry with no cash leg at all",
  );
});
