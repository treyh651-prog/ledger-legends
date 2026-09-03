/**
 * CLOSE-CHECK-GATES. The nineteen close gates, one passing case and one failing
 * case each.
 *
 * The questions these tests answer: does every gate return a definite pass, fail
 * or not applicable, does a gate fail for the reason it is supposed to fail for
 * rather than by accident, and does a gate that is out of scope say so instead of
 * quietly passing. A gate that cannot fail is not a gate, so every one of the
 * nineteen is proved in both directions here.
 *
 * Each test seeds only the condition its gate reads. The other eighteen gates are
 * free to answer whatever the small base book makes true, and no test asserts
 * anything about them.
 */

import {
  clsEvaluateGates,
  gateResultId,
  CLOSE_GATES,
} from "../runs/cls-evaluate-gates";
import type { MemoryRunDb } from "../db-memory";
import type { RunLogRow } from "../tables";
import { CLIENT_A1, FIRM_A, NOW, lock, txn } from "./fixtures";
import {
  addAccount,
  applyClose,
  closeDb,
  closeScope,
  gateResult,
  outcomesOf,
  PERIOD,
  PERIOD_END,
  PREPARER,
  previewClose,
  recBatch,
  request,
  seedEntry,
  substantiation,
} from "./close-fixtures";
import { assert, assertEqual, test } from "./harness";

/** Evaluate the gates on a database and return the outcome by gate code. */
async function gatesOn(db: MemoryRunDb): Promise<Map<string, string>> {
  await applyClose(db, clsEvaluateGates, closeScope());
  return outcomesOf(db);
}

/** Assert one gate reached one outcome, naming the gate in the failure. */
function assertGate(
  outcomes: Map<string, string>,
  code: string,
  expected: string,
): void {
  assertEqual(outcomes.get(code), expected, `${code} outcome`);
}

// ---------------------------------------------------------------------------
// Shape of the answer.
// ---------------------------------------------------------------------------

test("gates, all nineteen answer definitely on a plain period", async () => {
  const db = closeDb();
  const outcomes = await gatesOn(db);
  assertEqual(CLOSE_GATES.length, 19, "nineteen gates are defined");
  for (const gate of CLOSE_GATES) {
    const outcome = outcomes.get(gate.code);
    assert(
      outcome === "pass" || outcome === "fail" || outcome === "not_applicable",
      `${gate.code} answered ${String(outcome)} rather than a definite outcome`,
    );
  }
  assertEqual(outcomes.size, 19, "one result row per gate");
});

test("gates, a not applicable answer carries the reason it is out of scope", async () => {
  const db = closeDb();
  await applyClose(db, clsEvaluateGates, closeScope());
  const rows = db.all("close_gate_results");
  for (const row of rows) {
    if (row.outcome !== "not_applicable") continue;
    assert(
      row.scopeReason !== null && row.scopeReason.length > 0,
      `${row.gateCode} is not applicable with no reason recorded`,
    );
  }
});

test("gates, a failing gate lists the rows that block it", async () => {
  const db = closeDb();
  seedEntry(db, "JE-STUCK", "2026-01-20", [
    ["1990", BigInt(5000)],
    ["4100", BigInt(-5000)],
  ]);
  await applyClose(db, clsEvaluateGates, closeScope());
  const row = db.all("close_gate_results").find((r) => r.gateCode === "G01");
  assert(row !== undefined, "G01 produced a row");
  assertEqual(row?.outcome, "fail", "G01 failed");
  assertEqual(row?.blockingCount, 1, "one blocking row");
  assertEqual(row?.payload[0]?.label, "1990", "the suspense account is named");
});

test("gates, the run never posts and preview equals apply", async () => {
  const db = closeDb();
  const preview = await previewClose(db, clsEvaluateGates, closeScope());
  assertEqual(db.all("journal_entries").length, 1, "preview posted nothing");
  const { applied } = await applyClose(db, clsEvaluateGates, closeScope());
  assertEqual(
    applied.result.proposals.length,
    preview.result.proposals.length,
    "apply proposed what preview proposed",
  );
  assertEqual(db.all("journal_entries").length, 1, "apply posted nothing");
});

test("gates, a locked period is still evaluated because reading is not writing", async () => {
  const db = closeDb();
  db.seed("period_locks", [
    lock("LOCK-JAN", FIRM_A, CLIENT_A1, PERIOD, PERIOD_END),
  ]);
  const outcomes = await gatesOn(db);
  assertEqual(outcomes.size, 19, "every gate answered on a locked period");
});

test("gates, an overridden result is left alone", async () => {
  const db = closeDb();
  db.seed("close_gate_results", [
    gateResult(gateResultId(PERIOD, "G01"), "G01", {
      outcome: "fail",
      manualOverride: true,
      overrideReason: "the client is fixing this next week",
    }),
  ]);
  const { applied } = await applyClose(db, clsEvaluateGates, closeScope());
  const kept = db
    .all("close_gate_results")
    .find((r) => r.id === gateResultId(PERIOD, "G01"));
  assertEqual(kept?.outcome, "fail", "the overridden outcome stands");
  assert(
    applied.result.skips.some((s) => s.reason === "manual_override"),
    "the override was reported as a skip",
  );
});

test("gates, a second run against an unchanged book changes nothing", async () => {
  const db = closeDb();
  await applyClose(db, clsEvaluateGates, closeScope());
  const second = await previewClose(db, clsEvaluateGates, closeScope());
  assertEqual(second.result.proposals.length, 0, "nothing left to propose");
  assertEqual(
    second.result.skips.filter((s) => s.reason === "already_applied").length,
    19,
    "every gate was unchanged",
  );
});

// ---------------------------------------------------------------------------
// G01 clearing and suspense at zero.
// ---------------------------------------------------------------------------

test("G01 passes when every clearing account is at zero", async () => {
  assertGate(await gatesOn(closeDb()), "G01", "pass");
});

test("G01 fails when suspense holds a balance", async () => {
  const db = closeDb();
  seedEntry(db, "JE-SUSPENSE", "2026-01-20", [
    ["1990", BigInt(5000)],
    ["4100", BigInt(-5000)],
  ]);
  assertGate(await gatesOn(db), "G01", "fail");
});

// ---------------------------------------------------------------------------
// G02 bank register cleared to the statement.
// ---------------------------------------------------------------------------

test("G02 passes when the batch is reconciled and carries a cleared balance", async () => {
  assertGate(await gatesOn(closeDb()), "G02", "pass");
});

test("G02 fails when the batch is still open", async () => {
  const db = closeDb();
  db.seed("rec_batches", [recBatch("RB-JAN", { state: "open" })]);
  assertGate(await gatesOn(db), "G02", "fail");
});

// ---------------------------------------------------------------------------
// G03 reconciliation difference zero.
// ---------------------------------------------------------------------------

test("G03 passes when the reconciliation difference is zero", async () => {
  assertGate(await gatesOn(closeDb()), "G03", "pass");
});

test("G03 fails when a difference remains", async () => {
  const db = closeDb();
  db.seed("rec_batches", [recBatch("RB-JAN", { diffCents: BigInt(2500) })]);
  assertGate(await gatesOn(db), "G03", "fail");
});

// ---------------------------------------------------------------------------
// G04 AR subledger equals the AR control.
// ---------------------------------------------------------------------------

/** Put a receivable of the stated size on the books and in the aging. */
function seedReceivable(db: MemoryRunDb, ledger: bigint, aging: bigint): void {
  addAccount(db, "1100", "Accounts receivable");
  seedEntry(db, "JE-AR", "2026-01-18", [
    ["1100", ledger],
    ["4100", -ledger],
  ]);
  db.seed("aging_snapshots", [
    {
      id: "AG-AR",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      version: 1,
      asOfDate: PERIOD_END,
      side: "receivable",
      agingBasis: "due_date",
      partyId: "CUS-1",
      partyName: "customer one",
      documentId: "INV-1",
      documentNumber: "INV-1",
      documentDate: "2026-01-18",
      basisDate: "2026-01-18",
      ageDays: 13,
      bucket: "current",
      openBalanceCents: aging,
      controlAccount: "1100",
      controlBalanceCents: ledger,
      tieDifferenceCents: ledger - aging,
      subledgerOutOfTie: ledger !== aging,
      createdByRunId: "RUNX-SEED",
      createdAt: NOW.toISOString(),
      manualOverride: false,
    },
  ]);
}

test("G04 passes when the aging total equals the control balance", async () => {
  const db = closeDb();
  seedReceivable(db, BigInt(50000), BigInt(50000));
  assertGate(await gatesOn(db), "G04", "pass");
});

test("G04 fails when the aging total is short of the control balance", async () => {
  const db = closeDb();
  seedReceivable(db, BigInt(50000), BigInt(40000));
  assertGate(await gatesOn(db), "G04", "fail");
});

// ---------------------------------------------------------------------------
// G05 AP subledger equals the AP control.
// ---------------------------------------------------------------------------

function seedPayable(db: MemoryRunDb, ledger: bigint, aging: bigint): void {
  addAccount(db, "2000", "Accounts payable");
  seedEntry(db, "JE-AP", "2026-01-19", [
    ["6100", ledger],
    ["2000", -ledger],
  ]);
  db.seed("aging_snapshots", [
    {
      id: "AG-AP",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      version: 1,
      asOfDate: PERIOD_END,
      side: "payable",
      agingBasis: "due_date",
      partyId: "VEN-1",
      partyName: "vendor one",
      documentId: "BILL-1",
      documentNumber: "BILL-1",
      documentDate: "2026-01-19",
      basisDate: "2026-01-19",
      ageDays: 12,
      bucket: "current",
      openBalanceCents: aging,
      controlAccount: "2000",
      controlBalanceCents: -ledger,
      tieDifferenceCents: aging - ledger,
      subledgerOutOfTie: ledger !== aging,
      createdByRunId: "RUNX-SEED",
      createdAt: NOW.toISOString(),
      manualOverride: false,
    },
  ]);
}

test("G05 passes when the payable aging equals the control balance", async () => {
  const db = closeDb();
  seedPayable(db, BigInt(30000), BigInt(30000));
  assertGate(await gatesOn(db), "G05", "pass");
});

test("G05 fails when the payable aging disagrees with the control", async () => {
  const db = closeDb();
  seedPayable(db, BigInt(30000), BigInt(31000));
  assertGate(await gatesOn(db), "G05", "fail");
});

// ---------------------------------------------------------------------------
// G06 inventory count equals the inventory ledger.
// ---------------------------------------------------------------------------

function seedInventory(db: MemoryRunDb, ledger: bigint, counted: bigint): void {
  addAccount(db, "1200", "Inventory");
  seedEntry(db, "JE-INV", "2026-01-12", [
    ["1200", ledger],
    ["1010", -ledger],
  ]);
  db.seed("substantiation_records", [
    substantiation("SR-INV", "inventory_count", "1200", counted),
  ]);
}

test("G06 passes when the count agrees with the inventory ledger", async () => {
  const db = closeDb();
  seedInventory(db, BigInt(40000), BigInt(40000));
  assertGate(await gatesOn(db), "G06", "pass");
});

test("G06 fails when the count is short", async () => {
  const db = closeDb();
  seedInventory(db, BigInt(40000), BigInt(39000));
  assertGate(await gatesOn(db), "G06", "fail");
});

// ---------------------------------------------------------------------------
// G07 fixed asset schedule equals the asset ledger.
// ---------------------------------------------------------------------------

function seedAsset(
  db: MemoryRunDb,
  ledgerCost: bigint,
  scheduleCost: bigint,
  method: "straight_line" | "none" = "none",
): void {
  addAccount(db, "1500", "Equipment");
  seedEntry(db, "JE-ASSET", "2026-01-05", [
    ["1500", ledgerCost],
    ["1010", -ledgerCost],
  ]);
  db.seed("fixed_assets", [
    {
      id: "FA-1",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      tag: "FA-1",
      description: "a press",
      assetClass: "equipment",
      costAccount: "1500",
      accumAccount: "1600",
      expenseAccount: "6100",
      acquiredOn: "2026-01-05",
      placedInServiceOn: "2026-01-05",
      costCents: scheduleCost,
      salvageCents: BigInt(0),
      depreciableBaseCents: scheduleCost,
      method,
      lifeMonths: method === "none" ? null : 60,
      ddbFactorBps: null,
      macrsRecoveryYears: null,
      unitsTotal: null,
      convention: "full_month",
      halfMonthConvention: false,
      status: "active",
      disposedOn: null,
      manualOverride: false,
      version: 1,
    },
  ]);
}

test("G07 passes when the asset schedule equals the asset ledger", async () => {
  const db = closeDb();
  seedAsset(db, BigInt(200000), BigInt(200000));
  assertGate(await gatesOn(db), "G07", "pass");
});

test("G07 fails when the ledger carries a cost the schedule does not", async () => {
  const db = closeDb();
  seedAsset(db, BigInt(200000), BigInt(190000));
  assertGate(await gatesOn(db), "G07", "fail");
});

// ---------------------------------------------------------------------------
// G08 loan schedule equals the loan liability ledger.
// ---------------------------------------------------------------------------

function seedLoan(db: MemoryRunDb, ledger: bigint, principal: bigint): void {
  addAccount(db, "2700", "Note payable");
  seedEntry(db, "JE-LOAN", "2026-01-03", [
    ["1010", ledger],
    ["2700", -ledger],
  ]);
  db.seed("loans", [
    {
      id: "LN-1",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      lenderName: "a bank",
      loanType: "term",
      principalAccountLt: "2700",
      principalAccountCp: null,
      interestAccount: "8100",
      fundingAccount: "1010",
      escrowAccount: null,
      originalPrincipalCents: principal,
      originationDate: "2026-01-03",
      firstPaymentDate: "2026-02-03",
      termMonths: 60,
      annualRateBps: 600,
      paymentCents: BigInt(10000),
      status: "active",
      manualOverride: false,
      version: 1,
    },
  ]);
}

test("G08 passes when the amortization remaining equals the liability", async () => {
  const db = closeDb();
  seedLoan(db, BigInt(500000), BigInt(500000));
  assertGate(await gatesOn(db), "G08", "pass");
});

test("G08 fails when the liability is larger than the schedule", async () => {
  const db = closeDb();
  seedLoan(db, BigInt(500000), BigInt(400000));
  assertGate(await gatesOn(db), "G08", "fail");
});

// ---------------------------------------------------------------------------
// G09 prepaid schedule equals the prepaid asset ledger.
// ---------------------------------------------------------------------------

function seedPrepaid(db: MemoryRunDb, ledger: bigint, schedule: bigint): void {
  addAccount(db, "1300", "Prepaid insurance");
  seedEntry(db, "JE-PPD", "2026-01-02", [
    ["1300", ledger],
    ["1010", -ledger],
  ]);
  db.seed("deferral_schedules", [
    {
      id: "DS-1",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      kind: "prepaid",
      description: "annual insurance",
      balanceAccount: "1300",
      releaseAccount: "6100",
      accumAccount: null,
      totalCents: schedule,
      serviceStart: "2026-01-01",
      serviceEnd: "2026-12-31",
      method: "straight_line_monthly",
      periods: 12,
      status: "active",
      sourceTransactionId: null,
      sourceDocumentId: null,
      linkedDocumentId: null,
      manualOverride: false,
      version: 1,
    },
  ]);
}

test("G09 passes when the prepaid schedule equals the prepaid ledger", async () => {
  const db = closeDb();
  seedPrepaid(db, BigInt(60000), BigInt(60000));
  assertGate(await gatesOn(db), "G09", "pass");
});

test("G09 fails when the prepaid ledger runs ahead of the schedule", async () => {
  const db = closeDb();
  seedPrepaid(db, BigInt(60000), BigInt(50000));
  assertGate(await gatesOn(db), "G09", "fail");
});

// ---------------------------------------------------------------------------
// G10 payroll register equals the payroll liability ledger.
// ---------------------------------------------------------------------------

function seedPayroll(db: MemoryRunDb, ledger: bigint, register: bigint): void {
  addAccount(db, "2300", "Payroll liabilities");
  seedEntry(db, "JE-PR", "2026-01-31", [
    ["6100", ledger],
    ["2300", -ledger],
  ]);
  db.seed("substantiation_records", [
    substantiation("SR-PR", "payroll_register", "2300", -register),
  ]);
}

test("G10 passes when the register equals the payroll liability", async () => {
  const db = closeDb();
  seedPayroll(db, BigInt(30000), BigInt(30000));
  assertGate(await gatesOn(db), "G10", "pass");
});

test("G10 fails when the register is smaller than the accrued liability", async () => {
  const db = closeDb();
  seedPayroll(db, BigInt(30000), BigInt(20000));
  assertGate(await gatesOn(db), "G10", "fail");
});

// ---------------------------------------------------------------------------
// G11 accruals due to reverse in the period were reversed.
// ---------------------------------------------------------------------------

function seedAccrual(db: MemoryRunDb, reversed: boolean): void {
  addAccount(db, "2200", "Accrued expenses");
  seedEntry(
    db,
    "JE-ACCRUAL",
    "2025-12-31",
    [
      ["6100", BigInt(20000)],
      ["2200", BigInt(-20000)],
    ],
    { reversesOn: "2026-01-01" },
  );
  if (!reversed) return;
  seedEntry(
    db,
    "JE-REVERSAL",
    "2026-01-01",
    [
      ["6100", BigInt(-20000)],
      ["2200", BigInt(20000)],
    ],
    { reversalOf: "JE-ACCRUAL" },
  );
}

test("G11 passes when every accrual due to reverse was reversed", async () => {
  const db = closeDb();
  seedAccrual(db, true);
  assertGate(await gatesOn(db), "G11", "pass");
});

test("G11 fails when an accrual due to reverse is still on the books", async () => {
  const db = closeDb();
  seedAccrual(db, false);
  assertGate(await gatesOn(db), "G11", "fail");
});

// ---------------------------------------------------------------------------
// G12 depreciation posted for every open asset.
// ---------------------------------------------------------------------------

function seedDepreciableAsset(db: MemoryRunDb, posted: boolean): void {
  seedAsset(db, BigInt(200000), BigInt(200000), "straight_line");
  if (!posted) return;
  db.seed("depreciation_schedule", [
    {
      id: "DEP-1",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      assetId: "FA-1",
      periodStart: PERIOD,
      periodEnd: PERIOD_END,
      periodNumber: 1,
      scheduleVersion: 1,
      amountCents: BigInt(3333),
      accumulatedAfterCents: BigInt(3333),
      nbvAfterCents: BigInt(196667),
      status: "posted",
      postedEntryId: "JE-DEP",
      postedRunId: "RUNX-SEED",
      postedAt: NOW.toISOString(),
      manualOverride: false,
      version: 1,
    },
  ]);
}

test("G12 passes when depreciation is posted for the open asset", async () => {
  const db = closeDb();
  seedDepreciableAsset(db, true);
  assertGate(await gatesOn(db), "G12", "pass");
});

test("G12 fails when an open asset has no posted depreciation", async () => {
  const db = closeDb();
  seedDepreciableAsset(db, false);
  assertGate(await gatesOn(db), "G12", "fail");
});

// ---------------------------------------------------------------------------
// G13 every rule assignment carries a rule version.
// ---------------------------------------------------------------------------

function seedRuleCoded(db: MemoryRunDb, version: number | null): void {
  db.seed("transactions", [
    txn("TXN-RULE", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-14", BigInt(-2500), {
      ruleId: "RULE-1",
      ruleVersion: version,
      categoryId: "CAT-OFFICE",
      cascadeLevel: 6,
    }),
  ]);
}

test("G13 passes when a rule coded row carries the rule version", async () => {
  const db = closeDb();
  seedRuleCoded(db, 3);
  assertGate(await gatesOn(db), "G13", "pass");
});

test("G13 fails when a rule was applied without a version", async () => {
  const db = closeDb();
  seedRuleCoded(db, null);
  assertGate(await gatesOn(db), "G13", "fail");
});

// ---------------------------------------------------------------------------
// G14 no journal line dated in a locked period.
// ---------------------------------------------------------------------------

function seedLockedDecember(db: MemoryRunDb, redated: boolean): void {
  db.seed("period_locks", [
    lock("LOCK-DEC", FIRM_A, CLIENT_A1, "2025-12-01", "2025-12-31"),
  ]);
  seedEntry(
    db,
    "JE-DEC",
    "2025-12-20",
    [
      ["6100", BigInt(1000)],
      ["1010", BigInt(-1000)],
    ],
    redated ? { redatedFromLockedPeriod: "2025-12-20" } : {},
  );
}

test("G14 passes when the only entry inside a lock was redated", async () => {
  const db = closeDb();
  seedLockedDecember(db, true);
  assertGate(await gatesOn(db), "G14", "pass");
});

test("G14 fails when an entry sits inside a locked period", async () => {
  const db = closeDb();
  seedLockedDecember(db, false);
  assertGate(await gatesOn(db), "G14", "fail");
});

// ---------------------------------------------------------------------------
// G15 every posted line carries a cascade level and a rule or an override.
// ---------------------------------------------------------------------------

function seedCodedEntry(db: MemoryRunDb, coded: boolean): void {
  db.seed("transactions", [
    txn("TXN-CODED", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-16", BigInt(-4000), {
      categoryId: coded ? "CAT-OFFICE" : null,
      cascadeLevel: coded ? 6 : null,
    }),
  ]);
  seedEntry(
    db,
    "JE-CODED",
    "2026-01-16",
    [
      ["6100", BigInt(4000)],
      ["1010", BigInt(-4000)],
    ],
    { sourceTable: "transactions", sourceRowId: "TXN-CODED" },
  );
}

test("G15 passes when a posted entry traces to a coded transaction", async () => {
  const db = closeDb();
  seedCodedEntry(db, true);
  assertGate(await gatesOn(db), "G15", "pass");
});

test("G15 fails when a posted entry traces to an uncoded transaction", async () => {
  const db = closeDb();
  seedCodedEntry(db, false);
  assertGate(await gatesOn(db), "G15", "fail");
});

// ---------------------------------------------------------------------------
// G16 the trial balance foots to zero.
// ---------------------------------------------------------------------------

test("G16 passes when the trial balance foots", async () => {
  assertGate(await gatesOn(closeDb()), "G16", "pass");
});

test("G16 fails when the ledger does not foot to zero", async () => {
  const db = closeDb();
  // Seeded past the balance guard on purpose, which is the only way a book gets
  // into the state the gate exists to catch.
  seedEntry(db, "JE-BENT", "2026-01-22", [
    ["6100", BigInt(1000)],
    ["1010", BigInt(-900)],
  ]);
  assertGate(await gatesOn(db), "G16", "fail");
});

// ---------------------------------------------------------------------------
// G17 no orphan document request older than thirty days.
// ---------------------------------------------------------------------------

test("G17 passes when an old request has changed hands", async () => {
  const db = closeDb();
  db.seed("document_requests", [
    request("DR-OLD", "receipt:TXN-OLD", { ownerChangedOn: "2026-01-20" }),
  ]);
  assertGate(await gatesOn(db), "G17", "pass");
});

test("G17 fails when a request is thirty days old with no owner change", async () => {
  const db = closeDb();
  db.seed("document_requests", [request("DR-OLD", "receipt:TXN-OLD")]);
  assertGate(await gatesOn(db), "G17", "fail");
});

// ---------------------------------------------------------------------------
// G18 the preparer is not the approver.
// ---------------------------------------------------------------------------

function runLogPair(previewActor: string, applyActor: string): RunLogRow[] {
  const base = {
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    runType: "PER-POST-DEPRECIATION",
    runVersion: 1,
    status: "completed" as const,
    idempotencyKey: "IK-1",
    scopeHash: "HASH-1",
    actorKind: "human",
    source: "button",
    parentSequenceId: null,
    originalRunId: null,
    periodStart: PERIOD,
    periodEnd: PERIOD_END,
    candidateCount: 1,
    candidateIds: [],
    scopeInput: null,
    versions: null,
    gitSha: "sha",
    releaseId: "rel",
  };
  return [
    {
      ...base,
      id: "RUNX-PREVIEW",
      mode: "preview" as const,
      actorId: previewActor,
      previewRunId: null,
      startedAt: "2026-02-01T10:00:00.000Z",
    },
    {
      ...base,
      id: "RUNX-APPLY",
      mode: "apply" as const,
      actorId: applyActor,
      previewRunId: "RUNX-PREVIEW",
      startedAt: "2026-02-01T10:05:00.000Z",
    },
  ];
}

test("G18 passes when two different people previewed and applied", async () => {
  const db = closeDb();
  db.seed("run_log", runLogPair(PREPARER, "USR-SECOND"));
  assertGate(await gatesOn(db), "G18", "pass");
});

test("G18 fails when one person previewed and applied the same run", async () => {
  const db = closeDb();
  db.seed("run_log", runLogPair(PREPARER, PREPARER));
  assertGate(await gatesOn(db), "G18", "fail");
});

// ---------------------------------------------------------------------------
// G19 the derived cash basis agrees with the accrual basis.
// ---------------------------------------------------------------------------

test("G19 passes when every revenue line moved cash or a control account", async () => {
  assertGate(await gatesOn(closeDb()), "G19", "pass");
});

test("G19 fails when revenue was booked against suspense", async () => {
  const db = closeDb();
  seedEntry(db, "JE-PARKED", "2026-01-25", [
    ["1990", BigInt(7500)],
    ["4100", BigInt(-7500)],
  ]);
  assertGate(await gatesOn(db), "G19", "fail");
});
