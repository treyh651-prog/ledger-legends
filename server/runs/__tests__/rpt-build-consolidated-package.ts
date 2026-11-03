/**
 * RPT-BUILD-CONSOLIDATED-PACKAGE tests.
 *
 * The elimination refusal is the one thing this run must never get wrong:
 * it either nets to zero and builds, or it does not and nothing is written.
 * The rest mirrors RPT-BUILD-PACKAGE's own test shape -- the combined
 * sections are a snapshot, so the same ledger has to produce the same
 * snapshot and a different one has to produce a different one.
 */

import { assert, assertEqual, test } from "./harness";
import { isFieldWrite, isJournalEntry, type Proposal } from "../contract";
import { execute, type ExecuteOptions, type RunOutcome } from "../execute";
import { executeUndo } from "../undo";
import { MemoryRunDb } from "../db-memory";
import { ACTOR, FIRM_A, NOW, CLIENT_A1, CLIENT_A2 } from "./fixtures";
import { closeEntry, closeLine } from "./close-fixtures";
import { CLIENT_A3, clientRow, consolidationDb, seedGroup } from "./consolidation-fixtures";
import {
  ERR_CONSOLIDATION_ELIMINATIONS_UNBALANCED,
  ERR_CONSOLIDATION_HETEROGENEOUS_MEMBERS,
  ERR_CONSOLIDATION_MEMBER_NOT_READY,
  consolidatedPackageIdOf,
  rptBuildConsolidatedPackage,
  type BuildConsolidatedPackageScope,
} from "../runs/rpt-build-consolidated-package";

const GROUP = "GRP-1";
const PERIOD = "2026-01-01";

function scope(extra: Partial<BuildConsolidatedPackageScope> = {}): BuildConsolidatedPackageScope {
  return { groupId: GROUP, period: PERIOD, comparisonBasis: "prior_period", reportBasis: "accrual", ...extra };
}

function runOpts(mode: "preview" | "apply", extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return { mode, firmId: FIRM_A, clientId: CLIENT_A1, actor: { userId: ACTOR, kind: "human" }, now: NOW, source: "button", ...extra };
}

async function preview(db: MemoryRunDb, s: BuildConsolidatedPackageScope, extra: Partial<ExecuteOptions> = {}): Promise<RunOutcome<Proposal>> {
  return execute(db, rptBuildConsolidatedPackage, s, runOpts("preview", extra));
}

async function build(db: MemoryRunDb, s: BuildConsolidatedPackageScope): Promise<{ preview: RunOutcome<Proposal>; applied: RunOutcome<Proposal> }> {
  const p = await preview(db, s);
  const applied = await execute(db, rptBuildConsolidatedPackage, s, runOpts("apply", { previewRunId: p.executionId }));
  return { preview: p, applied };
}

/** A1 lends cash to A2: A1 debits 1420 (owed to it), A2 credits 2900 (owes it). Nets to zero across the group. */
function seedOffsettingIntercompany(db: MemoryRunDb, amount = 50000n): void {
  db.seed("journal_entries", [
    closeEntry("JE-A1-LOAN", PERIOD, { clientId: CLIENT_A1 }),
    closeEntry("JE-A2-LOAN", PERIOD, { clientId: CLIENT_A2 }),
  ]);
  db.seed("journal_lines", [
    closeLine("JE-A1-LOAN-L1", "JE-A1-LOAN", "1420", amount, PERIOD, { clientId: CLIENT_A1 }),
    closeLine("JE-A1-LOAN-L2", "JE-A1-LOAN", "1010", -amount, PERIOD, { clientId: CLIENT_A1 }),
    closeLine("JE-A2-LOAN-L1", "JE-A2-LOAN", "1010", amount, PERIOD, { clientId: CLIENT_A2 }),
    closeLine("JE-A2-LOAN-L2", "JE-A2-LOAN", "2900", -amount, PERIOD, { clientId: CLIENT_A2 }),
  ]);
}

function seedRevenueAndExpense(db: MemoryRunDb): void {
  db.seed("journal_entries", [
    ...db.all("journal_entries"),
    closeEntry("JE-A1-SALE", PERIOD, { clientId: CLIENT_A1 }),
    closeEntry("JE-A2-SALE", PERIOD, { clientId: CLIENT_A2 }),
  ]);
  db.seed("journal_lines", [
    ...db.all("journal_lines"),
    closeLine("JE-A1-SALE-L1", "JE-A1-SALE", "1010", 100000n, PERIOD, { clientId: CLIENT_A1 }),
    closeLine("JE-A1-SALE-L2", "JE-A1-SALE", "4100", -100000n, PERIOD, { clientId: CLIENT_A1 }),
    closeLine("JE-A2-SALE-L1", "JE-A2-SALE", "6100", 40000n, PERIOD, { clientId: CLIENT_A2 }),
    closeLine("JE-A2-SALE-L2", "JE-A2-SALE", "1010", -40000n, PERIOD, { clientId: CLIENT_A2 }),
  ]);
}

test("consolidated package: offsetting intercompany balances build cleanly, excluding 2900/1420 from the sheet", async () => {
  const db = consolidationDb();
  seedGroup(db, GROUP, [CLIENT_A1, CLIENT_A2]);
  seedOffsettingIntercompany(db);
  seedRevenueAndExpense(db);

  const { applied } = await build(db, scope());
  assertEqual(applied.status, "completed", "the build completed");

  const packageId = consolidatedPackageIdOf(GROUP, PERIOD, "prior_period", "accrual");
  const sections = db
    .all("consolidated_sections")
    .filter((s) => s.packageId === packageId)
    .sort((a, b) => a.sequence - b.sequence);
  assertEqual(sections.length, 9, "nine sections written");

  const balanceSheet = sections.find((s) => s.sectionCode === "BALANCE_SHEET")!;
  assert(!balanceSheet.lines.some((l) => l.accountNumber === "2900"), "2900 excluded from the combined sheet");
  assert(!balanceSheet.lines.some((l) => l.accountNumber === "1420"), "1420 excluded from the combined sheet");

  const incomeStatement = sections.find((s) => s.sectionCode === "INCOME_STATEMENT")!;
  const revenueLine = incomeStatement.lines.find((l) => l.accountNumber === "4100");
  assertEqual(revenueLine?.amountCents, "-100000", "A1's revenue carried through combined");
  const expenseLine = incomeStatement.lines.find((l) => l.accountNumber === "6100");
  assertEqual(expenseLine?.amountCents, "40000", "A2's expense carried through combined");

  const pkg = db.all("consolidated_packages").find((p) => p.id === packageId)!;
  assertEqual(pkg.memberCount, 2, "two members on the header");
});

test("consolidated package: a nonzero intercompany net refuses and writes nothing", async () => {
  const db = consolidationDb();
  seedGroup(db, GROUP, [CLIENT_A1, CLIENT_A2]);
  // Only A1's side of the loan -- A2 never recorded its 2900 liability.
  db.seed("journal_entries", [closeEntry("JE-A1-LOAN", PERIOD, { clientId: CLIENT_A1 })]);
  db.seed("journal_lines", [
    closeLine("JE-A1-LOAN-L1", "JE-A1-LOAN", "1420", 50000n, PERIOD, { clientId: CLIENT_A1 }),
    closeLine("JE-A1-LOAN-L2", "JE-A1-LOAN", "1010", -50000n, PERIOD, { clientId: CLIENT_A1 }),
  ]);

  const p = await preview(db, scope());
  assertEqual(p.status, "refused", "refused");
  assert(
    p.result.errors.some((e) => e.code === ERR_CONSOLIDATION_ELIMINATIONS_UNBALANCED && e.message.includes("50000")),
    "named error code naming the exact amount",
  );
  assertEqual(db.all("consolidated_packages").length, 0, "nothing written");
  assertEqual(db.all("consolidated_sections").length, 0, "nothing written");
});

test("consolidated package: a single member group still builds", async () => {
  const db = consolidationDb([CLIENT_A1]);
  seedGroup(db, GROUP, [CLIENT_A1]);
  const { applied } = await build(db, scope());
  assertEqual(applied.status, "completed", "a degenerate one member group still builds");
  const packageId = consolidatedPackageIdOf(GROUP, PERIOD, "prior_period", "accrual");
  assertEqual(db.all("consolidated_packages").find((p) => p.id === packageId)?.memberCount, 1, "member_count of one");
});

test("consolidated package: heterogeneous fiscal years refuse", async () => {
  const db = consolidationDb();
  db.seed("clients", [
    ...db.all("clients").filter((c) => c.id !== CLIENT_A2),
    clientRow(CLIENT_A2, { fiscalYearEndMonth: 6 }),
  ]);
  seedGroup(db, GROUP, [CLIENT_A1, CLIENT_A2]);
  seedOffsettingIntercompany(db);
  const p = await preview(db, scope());
  assertEqual(p.status, "refused", "refused");
  assert(
    p.result.errors.some((e) => e.code === ERR_CONSOLIDATION_HETEROGENEOUS_MEMBERS),
    "named error code",
  );
});

test("consolidated package: a member missing its chart refuses", async () => {
  const db = consolidationDb([CLIENT_A1]);
  db.seed("clients", [...db.all("clients"), clientRow(CLIENT_A3)]);
  // CLIENT_A3 has no chart_accounts rows at all.
  seedGroup(db, GROUP, [CLIENT_A1, CLIENT_A3]);
  const p = await preview(db, scope());
  assertEqual(p.status, "refused", "refused");
  assert(
    p.result.errors.some((e) => e.code === ERR_CONSOLIDATION_MEMBER_NOT_READY && e.message.includes(CLIENT_A3)),
    "named error code naming the unready member",
  );
});

test("consolidated package: a posting on one member after a build produces a fresh scope", async () => {
  const db = consolidationDb();
  seedGroup(db, GROUP, [CLIENT_A1, CLIENT_A2]);
  seedOffsettingIntercompany(db);
  const before = await preview(db, scope());
  db.seed("journal_entries", [...db.all("journal_entries"), closeEntry("JE-LATE", "2026-01-28", { clientId: CLIENT_A2 })]);
  db.seed("journal_lines", [
    ...db.all("journal_lines"),
    closeLine("JE-LATE-L1", "JE-LATE", "1010", 5000n, "2026-01-28", { clientId: CLIENT_A2 }),
    closeLine("JE-LATE-L2", "JE-LATE", "4100", -5000n, "2026-01-28", { clientId: CLIENT_A2 }),
  ]);
  const after = await preview(db, scope());
  assert(before.scopeHash !== after.scopeHash, "a posting on either member is a new scope, not a stale dedupe hit");
});

test("consolidated package: undo on a first build is a no op, the same as every insert-only run", async () => {
  const db = consolidationDb();
  seedGroup(db, GROUP, [CLIENT_A1, CLIENT_A2]);
  seedOffsettingIntercompany(db);
  const { applied } = await build(db, scope());
  assertEqual(
    applied.result.proposals.filter(isJournalEntry).length,
    0,
    "a reporting run posts no journal entry, so there is nothing for undo to reverse on the ledger",
  );
  // Every proposal on a first build is a row_insert (the package, its nine
  // sections, the one audit row), and inserts never revert in this
  // framework -- the same reasoning RPT-BUILD-PACKAGE's own undoPlan gives.
  const undone = await executeUndo(db, rptBuildConsolidatedPackage, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "no_op", "no_op");
});

test("consolidated package: undo after a rebuild reverts the field writes the rebuild made", async () => {
  const db = consolidationDb();
  seedGroup(db, GROUP, [CLIENT_A1, CLIENT_A2]);
  seedOffsettingIntercompany(db);
  await build(db, scope());
  db.seed("journal_entries", [...db.all("journal_entries"), closeEntry("JE-LATE", "2026-01-28", { clientId: CLIENT_A2 })]);
  db.seed("journal_lines", [
    ...db.all("journal_lines"),
    closeLine("JE-LATE-L1", "JE-LATE", "1010", 5000n, "2026-01-28", { clientId: CLIENT_A2 }),
    closeLine("JE-LATE-L2", "JE-LATE", "4100", -5000n, "2026-01-28", { clientId: CLIENT_A2 }),
  ]);
  const { applied: rebuilt } = await build(db, scope());
  assert(rebuilt.result.proposals.some(isFieldWrite), "the rebuild changed existing rows, not just inserted new ones");
  const packageId = consolidatedPackageIdOf(GROUP, PERIOD, "prior_period", "accrual");
  const beforeUndo = db.all("consolidated_packages").find((p) => p.id === packageId)!.contentChecksum;

  const undone = await executeUndo(db, rptBuildConsolidatedPackage, rebuilt.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");
  const afterUndo = db.all("consolidated_packages").find((p) => p.id === packageId)!.contentChecksum;
  assert(afterUndo !== beforeUndo, "the checksum reverted to the pre-rebuild value");
});

test("consolidated package: a rerun on an unchanged ledger is a no op", async () => {
  const db = consolidationDb();
  seedGroup(db, GROUP, [CLIENT_A1, CLIENT_A2]);
  seedOffsettingIntercompany(db);
  await build(db, scope());
  const again = await preview(db, scope());
  assertEqual(again.result.proposals.length, 0, "nothing proposed the second time");
  assert(again.result.skips.every((s) => s.reason === "already_applied"), "every row reports already_applied");
});
