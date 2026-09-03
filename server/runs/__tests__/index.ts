/**
 * Run framework tests. Hand rolled harness, no test runner installed.
 *
 * Run with: npx tsx server/runs/__tests__/index.ts
 *
 * The suite walks the twelve invariant property table in doc 03 Part 12, plus
 * the two tenant negative test and the preview versus apply parity test the
 * framework rests on.
 */

import {
  isFieldWrite,
  isJournalEntry,
  isSuspenseRouting,
  netCentsOf,
  TERMINAL_STATUSES,
  type Proposal,
} from "../contract";
import { MemoryRunDb } from "../db-memory";
import { execute, sweepAbandoned } from "../execute";
import { canonicalJson, idempotencyKeyFor, toJsonValue } from "../ids";
import { executeSequence, step } from "../sequence";
import { executeUndo } from "../undo";
import {
  pairTransfersScopeSchema,
  txnPairTransfers,
  type PairTransfersScope,
} from "../runs/txn-pair-transfers";
import type { JournalLineRow, SuspenseItemRow, TransactionRow } from "../tables";
import {
  ACTOR,
  baseDb,
  CLIENT_A1,
  CLIENT_A2,
  CLIENT_B1,
  FIRM_A,
  FIRM_B,
  lock,
  NOW,
  opts,
  scopeFor,
  txn,
} from "./fixtures";
import { assert, assertEqual, runAll, show, test } from "./harness";
// The import pipeline suite registers its own tests on the same queue.
import "./import-pipeline";
// The module 2 coding cascade suites, one file per run plus the pipeline test.
import "./txn-normalize-vendors";
import "./txn-detect-duplicates";
import "./txn-split-settlements";
import "./txn-apply-recurring";
import "./txn-apply-rules";
import "./txn-apply-vendordefaults";
import "./txn-map-bankcodes";
import "./txn-sweep-suspense";
import "./coding-pipeline";
// The module 3 reconciliation suites, one file per run plus the pipeline test.
import "./rec-match-tiered";
import "./rec-clear-matched";
import "./rec-flag-stale";
import "./rec-pipeline";
// The module 4 period end suites, one file per run plus the pipeline test.
import "./per-post-recurring";
import "./per-amortize-prepaids";
import "./per-split-loan";
import "./per-post-accruals";
import "./per-reverse-accruals";
import "./per-post-depreciation";
import "./per-pipeline";
// The module 5 AR and AP suites, one file per run plus the pipeline test.
import "./ar-refresh-aging";
import "./ar-build-statements";
import "./ar-apply-payments";
import "./ar-charge-latefees";
import "./ap-apply-earlydiscount";
import "./ar-writeoff-uncollectible";
import "./arap-pipeline";

import "./close-tieouts";
import "./close-requests";
import "./close-gates";
import "./close-lock";
import "./close-rollforward";
import "./close-yearend";
import "./close-pipeline";
// Module 8 reporting. The pipeline suite comes last because it runs all four.
import "./rpt-build-package";
import "./rpt-flag-variances";
import "./rpt-rebuild-forecast";
import "./rpt-compose-narrative";
import "./rpt-pipeline";

type Outcome = Awaited<ReturnType<typeof execute<PairTransfersScope, Proposal>>>;

function run(
  db: MemoryRunDb,
  mode: "preview" | "apply",
  scope: PairTransfersScope,
  extra: Parameters<typeof opts>[1] = {},
): Promise<Outcome> {
  return execute<PairTransfersScope, Proposal>(
    db,
    txnPairTransfers,
    scope,
    opts(mode, extra),
  );
}

async function previewThenApply(
  db: MemoryRunDb,
  scope: PairTransfersScope,
  extra: Parameters<typeof opts>[1] = {},
): Promise<{ preview: Outcome; applied: Outcome }> {
  const preview = await run(db, "preview", scope, extra);
  const applied = await run(db, "apply", scope, {
    ...extra,
    previewRunId: preview.executionId,
  });
  return { preview, applied };
}

/** A simple matched pair inside client A1, 250.00 out of operating into savings. */
function seedSimplePair(db: MemoryRunDb): void {
  db.seed("transactions", [
    txn("TX-OUT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000)),
    txn("TX-IN", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-11", BigInt(25000)),
  ]);
}

function lines(db: MemoryRunDb): JournalLineRow[] {
  return db.all("journal_lines");
}

function sumLines(rows: readonly JournalLineRow[]): bigint {
  let net = BigInt(0);
  for (const r of rows) net += r.amountCents;
  return net;
}

// Invariant 1. Entries balance. Every journal entry sums to exactly zero.
test("invariant 1, every posted entry balances to zero", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const { applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  assertEqual(applied.status, "completed", "status");
  const entries = db.all("journal_entries");
  assertEqual(entries.length, 2, "two entries, one per side");
  for (const e of entries) {
    const own = lines(db).filter((l) => l.entryId === e.id);
    assert(own.length >= 2, `entry ${e.id} has at least two lines`);
    assertEqual(sumLines(own), BigInt(0), `entry ${e.id} sums to zero`);
  }
});

// Invariant 2. Trial balance foots. The sum of every line is zero.
test("invariant 2, the whole set of lines foots to zero", async () => {
  const db = baseDb();
  seedSimplePair(db);
  await previewThenApply(db, scopeFor(CLIENT_A1));
  assertEqual(sumLines(lines(db)), BigInt(0), "all lines net zero");
});

// Invariant 3. Net zero posting. A pairing run nets zero on 1920.
test("invariant 3, a paired transfer nets zero on 1920", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const { applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  const clearing = lines(db).filter((l) => l.accountNumber === "1920");
  assertEqual(clearing.length, 2, "one clearing line per side");
  assertEqual(sumLines(clearing), BigInt(0), "1920 nets zero");
  assertEqual(
    netCentsOf(applied.result.proposals),
    BigInt(0),
    "reported net cents is zero",
  );
  assertEqual(applied.result.totals.netCents, BigInt(0), "totals net cents");
});

// Invariant 4. No orphan lines. Every line points at an entry that exists.
test("invariant 4, no orphan lines", async () => {
  const db = baseDb();
  seedSimplePair(db);
  await previewThenApply(db, scopeFor(CLIENT_A1));
  const ids = new Set(db.all("journal_entries").map((e) => e.id));
  for (const l of lines(db)) {
    assert(ids.has(l.entryId), `line ${l.id} points at a real entry`);
  }
});

// Invariant 5. Undo restores. Undo returns the books to the prior state.
test("invariant 5, undo reverses posted entries and reverts field writes", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const { applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  assertEqual(applied.status, "completed", "apply completed");

  const before = db.all("transactions") as TransactionRow[];
  assert(
    before.every((t) => t.pairedWithId !== null),
    "both sides were linked by the apply",
  );

  const undone = await executeUndo(db, txnPairTransfers, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");

  const after = db.all("transactions") as TransactionRow[];
  assert(
    after.every((t) => t.pairedWithId === null && t.categoryId === null),
    "the pair link and the category went back to their before values",
  );
  assertEqual(sumLines(lines(db)), BigInt(0), "the books still foot after undo");
  const reversals = db.all("journal_entries").filter((e) => e.reversalOf !== null);
  assertEqual(reversals.length, 2, "one mirror entry per original entry");
  const originals = db.all("journal_entries").filter((e) => e.reversalOf === null);
  assertEqual(originals.length, 2, "no original entry was deleted or edited");
  for (const account of ["1010", "1020", "1920"]) {
    const own = lines(db).filter((l) => l.accountNumber === account);
    assertEqual(sumLines(own), BigInt(0), `${account} is back to zero net`);
  }

  const events = db.all("run_log_events");
  assert(
    events.some(
      (e) => e.event === "undone_by" && e.runExecutionId === applied.executionId,
    ),
    "an undone_by event was appended to the original execution",
  );
});

test("invariant 5b, a second undo of the same run is refused", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const { applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  const undoOpts = {
    mode: "apply" as const,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" as const },
    now: NOW,
    source: "button" as const,
  };
  await executeUndo(db, txnPairTransfers, applied.executionId, undoOpts);
  const second = await executeUndo(
    db,
    txnPairTransfers,
    applied.executionId,
    undoOpts,
  );
  assertEqual(second.status, "refused", "the second undo is refused");
  assert(
    second.result.errors.some((e) => e.code === "UNDO_ALREADY_DONE"),
    `expected UNDO_ALREADY_DONE, got ${show(second.result.errors.map((e) => e.code))}`,
  );
});

test("invariant 5c, a reversal into a locked period is redated and routed to SUS-20", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const { applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  assertEqual(applied.status, "completed", "apply completed");

  // January closes after the fact. The reversal cannot land in January.
  db.seed("period_locks", [
    lock("LK-JAN", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const undone = await executeUndo(db, txnPairTransfers, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "the undo completed");
  const reversals = db.all("journal_entries").filter((e) => e.reversalOf !== null);
  assertEqual(reversals.length, 2, "two mirror entries");
  for (const r of reversals) {
    assertEqual(r.entryDate, "2026-02-01", "dated the first open day");
    assert(
      r.redatedFromLockedPeriod !== null,
      "and the original date is preserved on the row",
    );
  }
  const items = db.all("suspense_items") as SuspenseItemRow[];
  assertEqual(items.length, 2, "one routing per redated reversal");
  assert(
    items.every((i) => i.reasonCode === "SUS-20"),
    "every routing carries SUS-20",
  );
  assertEqual(sumLines(lines(db)), BigInt(0), "the books still foot");
});

test("invariant 5d, undo is refused when no open period exists", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const { applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  // Everything from January forward is locked, so there is nowhere to land.
  db.seed("period_locks", [
    lock("LK-ALL", FIRM_A, CLIENT_A1, "2026-01-01", "2099-12-31"),
  ]);
  const undone = await executeUndo(db, txnPairTransfers, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "refused", "the undo is refused, not forced");
  assert(
    undone.result.errors.some((e) => e.code === "UNDO_NO_OPEN_PERIOD"),
    `expected UNDO_NO_OPEN_PERIOD, got ${show(undone.result.errors.map((e) => e.code))}`,
  );
  const reversals = db.all("journal_entries").filter((e) => e.reversalOf !== null);
  assertEqual(reversals.length, 0, "nothing was posted");
});

// Invariant 6. Idempotent apply. Applying twice changes nothing the second time.
test("invariant 6, applying the same scope twice is a no op the second time", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const { preview, applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  const entriesAfterFirst = db.all("journal_entries").length;

  const secondPreview = await run(db, "preview", scopeFor(CLIENT_A1));
  const second = await run(db, "apply", scopeFor(CLIENT_A1), {
    previewRunId: secondPreview.executionId,
  });

  assertEqual(
    db.all("journal_entries").length,
    entriesAfterFirst,
    "no new entries were posted",
  );
  assert(
    second.status === "no_op" || second.status === "completed_with_skips",
    `second apply ended ${second.status}`,
  );
  assertEqual(second.result.proposals.length, 0, "nothing left to propose");
  assert(
    second.result.skips.every((s) => s.reason === "already_applied"),
    "everything that remains is already applied",
  );
  assert(preview.executionId !== applied.executionId, "distinct execution ids");
});

test("invariant 6b, a replayed apply never posts twice", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const preview = await run(db, "preview", scopeFor(CLIENT_A1));
  const first = await run(db, "apply", scopeFor(CLIENT_A1), {
    previewRunId: preview.executionId,
  });
  // Same run, same version, same tenant, same scope hash, same mode, so the
  // idempotency key matches and the second call returns the first execution.
  const replay = await execute<PairTransfersScope, Proposal>(
    db,
    txnPairTransfers,
    scopeFor(CLIENT_A1),
    opts("apply", { previewRunId: preview.executionId }),
  );
  // Two outcomes are acceptable and both are safe. If nothing moved, the
  // idempotency key matches and the first execution is returned. If the rows the
  // first apply wrote bumped their versions, the scope hash no longer matches the
  // preview and the replay is refused as stale, which is the stronger guard and
  // is what happens here because the pair link bumped both transaction versions.
  if (replay.deduplicatedFrom !== undefined) {
    assertEqual(replay.deduplicatedFrom, first.executionId, "dedup points back");
  } else {
    assertEqual(replay.status, "refused", "or the stale preview guard fires");
    assert(
      replay.result.errors.some((e) => e.code === "STALE_PREVIEW"),
      `expected STALE_PREVIEW, got ${show(replay.result.errors.map((e) => e.code))}`,
    );
  }
  assertEqual(db.all("journal_entries").length, 2, "still only two entries");
});

test("idempotency key covers type, version, tenant, scope hash, and mode", () => {
  const base = {
    runType: "TXN-PAIR-TRANSFERS",
    runVersion: 1,
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    scopeHash: "abc",
    mode: "apply" as const,
  };
  const key = idempotencyKeyFor(base);
  assertEqual(key, idempotencyKeyFor({ ...base }), "same inputs, same key");
  const variants = [
    { ...base, runType: "TXN-APPLY-RULES" },
    { ...base, runVersion: 2 },
    { ...base, firmId: FIRM_B },
    { ...base, clientId: CLIENT_A2 },
    { ...base, scopeHash: "def" },
    { ...base, mode: "preview" as const },
  ];
  for (const v of variants) {
    assert(idempotencyKeyFor(v) !== key, `changing one field changes the key: ${show(v)}`);
  }
});

// Invariant 7. Locked periods untouched.
test("invariant 7, a locked period is skipped and never written", async () => {
  const db = baseDb();
  seedSimplePair(db);
  db.seed("period_locks", [
    lock("LK-1", FIRM_A, CLIENT_A1, "2026-01-01", "2026-01-31"),
  ]);
  const { applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  assertEqual(db.all("journal_entries").length, 0, "no entry was posted");
  assertEqual(
    applied.result.skips.filter((s) => s.reason === "locked_period").length,
    2,
    "both sides were skipped as locked",
  );
  const after = db.all("transactions") as TransactionRow[];
  assert(
    after.every((t) => t.pairedWithId === null),
    "no field write reached a locked row",
  );
});

// Invariant 8. Overrides untouched.
test("invariant 8, a run may never write over a manual override row", async () => {
  const db = baseDb();
  db.seed("transactions", [
    txn("TX-OUT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000), {
      manualOverride: true,
      categoryId: "CAT-OWNER-DRAW",
    }),
    txn("TX-IN", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-11", BigInt(25000)),
  ]);
  const { applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  const overrideSkips = applied.result.skips.filter(
    (s) => s.reason === "manual_override",
  );
  assertEqual(overrideSkips.length, 1, "the overridden row is reported as a skip");
  assertEqual(applied.overriddenInScope, 1, "and counted on the outcome");
  const overridden = db
    .all("transactions")
    .find((t) => t.id === "TX-OUT") as TransactionRow;
  assertEqual(overridden.categoryId, "CAT-OWNER-DRAW", "its category is unchanged");
  assertEqual(overridden.pairedWithId, null, "and it was never paired");
  assertEqual(db.all("journal_entries").length, 0, "no entry was posted for it");
});

test("invariant 8b, the store itself refuses an override write", async () => {
  const db = baseDb();
  db.seed("transactions", [
    txn("TX-X", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-100), {
      manualOverride: true,
    }),
  ]);
  let code = "";
  try {
    await db.tx(
      {
        isolation: "serializable",
        readOnly: false,
        firmId: FIRM_A,
        clientId: CLIENT_A1,
        actorId: ACTOR,
        actorKind: "run",
      },
      async (tx) => {
        await tx.update("transactions", "TX-X", { categoryId: "CAT-TRANSFER" });
      },
    );
  } catch (err) {
    code = (err as { code?: string }).code ?? "";
  }
  assertEqual(code, "OVERRIDE_PROTECTED_ROW", "the guard fired");
});

// Invariant 9. Suspense terminates. Every ambiguity ends as a suspense item.
test("invariant 9, an ambiguous transfer set routes every member to SUS-04", async () => {
  const db = baseDb();
  db.seed("transactions", [
    txn("TX-A", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000)),
    txn("TX-B", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-11", BigInt(25000)),
    txn("TX-C", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-12", BigInt(25000)),
  ]);
  const { applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  assertEqual(db.all("journal_entries").length, 0, "an ambiguous set posts nothing");
  const items = db.all("suspense_items") as SuspenseItemRow[];
  assertEqual(items.length, 3, "three suspense items across the ambiguous set");
  assert(
    items.every((i) => i.reasonCode === "SUS-04"),
    "every item carries SUS-04",
  );
  assertEqual(
    applied.result.proposals.filter(isSuspenseRouting).length,
    3,
    "and they were proposals, not skips, so the partition holds",
  );
  const paired = db.all("transactions") as TransactionRow[];
  assert(
    paired.every((t) => t.pairedWithId === null),
    "no member of the ambiguous set was paired",
  );
});

// Invariant 10. Contra pairing. Not covered, see NOTES.md.

// Invariant 11. Total partition. candidates equals proposals plus skips plus errors.
test("invariant 11, every candidate lands in exactly one bucket", async () => {
  const db = baseDb();
  db.seed("transactions", [
    txn("TX-OUT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000)),
    txn("TX-IN", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-11", BigInt(25000)),
    txn("TX-LONE", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-15", BigInt(-99900)),
    txn("TX-OVR", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-16", BigInt(-5000), {
      manualOverride: true,
    }),
    txn("TX-DUP", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-17", BigInt(-1200), {
      duplicateFlag: true,
    }),
  ]);
  const preview = await run(db, "preview", scopeFor(CLIENT_A1));
  const touched = new Set<string>();
  for (const p of preview.result.proposals) {
    if (isJournalEntry(p)) touched.add(p.sourceRef.rowId);
    if (isFieldWrite(p)) touched.add(p.rowId);
    if (isSuspenseRouting(p)) touched.add(p.transactionId);
  }
  for (const s of preview.result.skips) if (s.rowId) touched.add(s.rowId);
  for (const e of preview.result.errors) if (e.rowId) touched.add(e.rowId);
  assertEqual(
    touched.size,
    preview.result.totals.candidates,
    "every candidate is accounted for exactly once",
  );
  assertEqual(preview.result.totals.candidates, 5, "five candidates in the window");
  const reasons = preview.result.skips.map((s) => s.reason).sort();
  assert(reasons.includes("manual_override"), `skips: ${show(reasons)}`);
  assert(reasons.includes("missing_prerequisite"), `skips: ${show(reasons)}`);
});

// Invariant 12. Cents only. Money never becomes a float.
test("invariant 12, money stays bigint cents everywhere", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const { applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  for (const l of lines(db)) {
    assertEqual(typeof l.amountCents, "bigint", `line ${l.id} amount is bigint`);
  }
  for (const p of applied.result.proposals) {
    if (!isJournalEntry(p)) continue;
    for (const line of p.lines) {
      assertEqual(typeof line.amountCents, "bigint", "proposal line is bigint");
    }
  }
  assertEqual(typeof applied.result.totals.netCents, "bigint", "totals are bigint");
  const encoded = canonicalJson(toJsonValue({ amountCents: BigInt(-25000) }));
  assert(encoded.includes("$cents"), `cents are tagged in json: ${encoded}`);
  const rejected = (): unknown => canonicalJson({ amount: 12.34 });
  let threw = false;
  try {
    rejected();
  } catch {
    threw = true;
  }
  assert(threw, "a non integer number is refused by the canonical encoder");
});

// The two tenant negative test.
test("two tenant negative, no pairing or log leaks across firms or clients", async () => {
  const db = baseDb();
  // Identical amounts, identical dates, identical normalized vendor strings.
  db.seed("transactions", [
    txn("TX-A1-OUT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000)),
    txn("TX-A2-IN", FIRM_A, CLIENT_A2, "BA-A2-SV", "2026-01-10", BigInt(25000)),
    txn("TX-B1-IN", FIRM_B, CLIENT_B1, "BA-B1-SV", "2026-01-10", BigInt(25000)),
  ]);
  const previewA1 = await run(db, "preview", scopeFor(CLIENT_A1));
  assertEqual(previewA1.result.totals.candidates, 1, "only its own row is in scope");
  assertEqual(
    previewA1.result.proposals.length,
    0,
    "no cross tenant counterparty was found",
  );
  assert(
    previewA1.result.skips.every((s) => s.reason === "missing_prerequisite"),
    "the lone row is simply unpaired",
  );

  const applied = await run(db, "apply", scopeFor(CLIENT_A1), {
    previewRunId: previewA1.executionId,
  });
  assertEqual(db.all("journal_entries").length, 0, "nothing posted anywhere");
  const others = db
    .all("transactions")
    .filter((t) => t.id !== "TX-A1-OUT") as TransactionRow[];
  assert(
    others.every((t) => t.pairedWithId === null && t.categoryId === null),
    "no other tenant row was touched",
  );

  // Firm B cannot see firm A's log rows through the port.
  const visible = await db.tx(
    {
      isolation: "repeatable read",
      readOnly: true,
      firmId: FIRM_B,
      clientId: CLIENT_B1,
      actorId: ACTOR,
      actorKind: "run",
    },
    (tx) =>
      tx.query("run_log_by_id", {
        firmId: FIRM_B,
        executionId: applied.executionId,
      }),
  );
  assertEqual(visible.length, 0, "firm B cannot read firm A's run log row");
});

// Preview and apply produce identical proposals.
test("preview and apply produce identical proposals", async () => {
  const db = baseDb();
  db.seed("transactions", [
    txn("TX-OUT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000)),
    txn("TX-IN", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-11", BigInt(25000)),
    txn("TX-AMB-A", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-20", BigInt(-8000)),
    txn("TX-AMB-B", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-20", BigInt(8000)),
    txn("TX-AMB-C", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-21", BigInt(8000)),
    txn("TX-DUP", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-22", BigInt(-1500), {
      duplicateFlag: true,
    }),
  ]);
  const { preview, applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  assertEqual(
    canonicalJson(toJsonValue(preview.result.proposals)),
    canonicalJson(toJsonValue(applied.result.proposals)),
    "the two modes produced the same proposal set",
  );
  assertEqual(
    canonicalJson(toJsonValue(preview.result.skips)),
    canonicalJson(toJsonValue(applied.result.skips)),
    "and the same skips",
  );
  assertEqual(preview.scopeHash, applied.scopeHash, "and the same scope hash");
});

test("preview writes no ledger rows", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const preview = await run(db, "preview", scopeFor(CLIENT_A1));
  assert(preview.result.proposals.length > 0, "the preview did propose work");
  assertEqual(db.all("journal_entries").length, 0, "no entries");
  assertEqual(db.all("journal_lines").length, 0, "no lines");
  assertEqual(db.all("suspense_items").length, 0, "no suspense items");
  const rows = db.all("transactions") as TransactionRow[];
  assert(
    rows.every((t) => t.pairedWithId === null),
    "no field writes survived the preview",
  );
  assertEqual(db.all("run_log").length, 1, "but the preview was logged");
});

test("apply is refused when any error exists", async () => {
  const db = baseDb();
  // No 1920 in the chart for client A2, which blocks the run.
  const noChart = baseDb();
  noChart.seed("transactions", [
    txn("TX-OUT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000)),
    txn("TX-IN", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-11", BigInt(25000)),
  ]);
  const stripped = new MemoryRunDb();
  stripped.seed(
    "chart_accounts",
    noChart.all("chart_accounts").filter((c) => c.accountNumber !== "1920"),
  );
  stripped.seed("bank_accounts", noChart.all("bank_accounts"));
  stripped.seed("transactions", noChart.all("transactions"));

  const preview = await run(stripped, "preview", scopeFor(CLIENT_A1));
  assertEqual(preview.status, "refused", "preview status is refused too");
  assert(
    preview.result.errors.some((e) => e.code === "MISSING_ACCOUNT"),
    `expected MISSING_ACCOUNT, got ${show(preview.result.errors.map((e) => e.code))}`,
  );
  const applied = await run(stripped, "apply", scopeFor(CLIENT_A1), {
    previewRunId: preview.executionId,
  });
  assertEqual(applied.status, "refused", "apply refuses to start");
  assertEqual(stripped.all("journal_entries").length, 0, "and wrote nothing");
  assertEqual(db.all("journal_entries").length, 0, "the clean db is untouched");
});

test("apply without a preview id is refused", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const applied = await run(db, "apply", scopeFor(CLIENT_A1));
  assertEqual(applied.status, "refused", "no preview, no apply");
  assertEqual(db.all("journal_entries").length, 0, "nothing was written");
});

test("there are exactly eight terminal statuses and none of them is partial", () => {
  assertEqual(TERMINAL_STATUSES.length, 8, "eight terminal statuses");
  assert(
    !TERMINAL_STATUSES.some((s) => String(s).includes("partial")),
    "no partially applied status exists",
  );
});

test("the run log is insert only", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const { applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  let code = "";
  try {
    await db.tx(
      {
        isolation: "serializable",
        readOnly: false,
        firmId: FIRM_A,
        clientId: CLIENT_A1,
        actorId: ACTOR,
        actorKind: "run",
      },
      async (tx) => {
        await tx.update("run_log", applied.executionId, { status: "failed" });
      },
    );
  } catch (err) {
    code = (err as { code?: string }).code ?? "";
  }
  assertEqual(code, "IMMUTABLE_LOG", "the log refuses an update");
  const events = db.all("run_log_events");
  assert(events.length >= 2, "the terminal statuses were appended as events");
});

test("the log records provenance with cascade level and rule version", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const { applied } = await previewThenApply(db, scopeFor(CLIENT_A1));
  const items = db
    .all("run_log_items")
    .filter((i) => i.runExecutionId === applied.executionId);
  assert(items.length > 0, "items were written");
  const withCascade = items.filter((i) => i.cascadeLevel !== null);
  assert(withCascade.length > 0, "at least one item carries a cascade level");
  assert(
    withCascade.every((i) => i.cascadeLevel === 3),
    "transfer pairing sits at cascade level 3",
  );
  const logRow = db.all("run_log").find((r) => r.id === applied.executionId);
  assert(logRow !== undefined, "the run log row exists");
  assertEqual(logRow?.runVersion, 1, "the run version is stamped");
});

test("a sequence logs each child run separately", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const outcome = await executeSequence(
    db,
    [step(txnPairTransfers, scopeFor(CLIENT_A1))],
    {
      name: "month end prep",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      actorId: ACTOR,
      now: NOW,
      mode: "apply",
    },
  );
  assertEqual(outcome.stoppedAtStep, null, "the sequence ran to the end");
  assert(outcome.childRunIds.length >= 2, "a preview child and an apply child");
  const logRows = db.all("run_log");
  for (const id of outcome.childRunIds) {
    assert(
      logRows.some((r) => r.id === id),
      `child ${id} has its own run log row`,
    );
  }
  const seq = db.all("run_sequence");
  assertEqual(seq.length, 1, "one sequence row");
  assertEqual(seq[0].childRunIds.length, outcome.childRunIds.length, "child ids");
  assert(
    logRows.every((r) => r.parentSequenceId === outcome.sequenceId),
    "every child names its parent sequence",
  );
});

test("the advisory lock is released when the transaction ends", async () => {
  const db = baseDb();
  seedSimplePair(db);
  await previewThenApply(db, scopeFor(CLIENT_A1));
  assertEqual(db.heldLocks().length, 0, "no lock is still held");
});

test("a concurrent run of the same type and key is rejected, not queued", async () => {
  const db = baseDb();
  seedSimplePair(db);
  let inner: Awaited<ReturnType<typeof run>> | null = null;
  await db.tx(
    {
      isolation: "serializable",
      readOnly: false,
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      actorId: "USR-OTHER",
      actorKind: "run",
    },
    async (tx) => {
      const got = await tx.tryAdvisoryXactLock(
        "TXN-PAIR-TRANSFERS",
        CLIENT_A1,
      );
      assert(got, "the holder took the lock");
      inner = await run(db, "preview", scopeFor(CLIENT_A1));
    },
  );
  const outcome = inner as Awaited<ReturnType<typeof run>> | null;
  assert(outcome !== null, "the second run returned");
  assertEqual(outcome?.status, "rejected_locked", "it was rejected, not queued");
});

test("a scope filtered to one account still searches every account for a counterparty", async () => {
  const db = baseDb();
  seedSimplePair(db);
  const preview = await run(
    db,
    "preview",
    scopeFor(CLIENT_A1, "2026-01-01", "2026-01-31", ["BA-A1-OP"]),
  );
  assertEqual(preview.result.totals.candidates, 1, "one candidate in the filter");
  const pairEntries = preview.result.proposals.filter(isJournalEntry);
  assertEqual(pairEntries.length, 2, "the pair was still found and posted whole");
});

test("the pairing window is 3 calendar days, inclusive", async () => {
  const inWindow = baseDb();
  inWindow.seed("transactions", [
    txn("TX-OUT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000)),
    txn("TX-IN", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-13", BigInt(25000)),
  ]);
  const near = await run(inWindow, "preview", scopeFor(CLIENT_A1));
  assertEqual(near.result.proposals.filter(isJournalEntry).length, 2, "3 days pairs");

  const outOfWindow = baseDb();
  outOfWindow.seed("transactions", [
    txn("TX-OUT", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000)),
    txn("TX-IN", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-14", BigInt(25000)),
  ]);
  const far = await run(outOfWindow, "preview", scopeFor(CLIENT_A1));
  assertEqual(far.result.proposals.length, 0, "4 days does not pair");
  assertEqual(far.result.skips.length, 2, "both sides are reported unpaired");
});

test("same sign or unequal amounts never pair", async () => {
  const db = baseDb();
  db.seed("transactions", [
    txn("TX-1", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000)),
    txn("TX-2", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-11", BigInt(-25000)),
    txn("TX-3", FIRM_A, CLIENT_A1, "BA-A1-SV", "2026-01-11", BigInt(24999)),
  ]);
  const preview = await run(db, "preview", scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "nothing pairs");
  assertEqual(preview.result.skips.length, 3, "all three are unpaired");
});

test("two transactions on the same account never pair", async () => {
  const db = baseDb();
  db.seed("transactions", [
    txn("TX-1", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-10", BigInt(-25000)),
    txn("TX-2", FIRM_A, CLIENT_A1, "BA-A1-OP", "2026-01-11", BigInt(25000)),
  ]);
  const preview = await run(db, "preview", scopeFor(CLIENT_A1));
  assertEqual(preview.result.proposals.length, 0, "same account, no pair");
});

test("the scope schema rejects a malformed scope", () => {
  const bad = pairTransfersScopeSchema.safeParse({
    clientId: CLIENT_A1,
    from: "01/01/2026",
    to: "2026-01-31",
    bankAccountIds: null,
  });
  assert(!bad.success, "a non ISO date is refused");
  const good = pairTransfersScopeSchema.safeParse(scopeFor(CLIENT_A1));
  assert(good.success, "a well formed scope passes");
});

test("the sweeper marks an orphaned started row abandoned", async () => {
  const db = baseDb();
  db.seed("run_log", [
    {
      id: "RUNX-ORPHAN",
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      runType: "TXN-PAIR-TRANSFERS",
      runVersion: 1,
      mode: "apply",
      status: "started",
      idempotencyKey: "orphan",
      scopeHash: "orphan",
      actorId: ACTOR,
      actorKind: "run",
      source: "button",
      parentSequenceId: null,
      previewRunId: null,
      originalRunId: null,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      candidateCount: 0,
      candidateIds: [],
      scopeInput: {},
      versions: [],
      startedAt: new Date(NOW.getTime() - 3600000).toISOString(),
      gitSha: "test",
      releaseId: "test",
    },
  ]);
  const marked = await sweepAbandoned(
    db,
    {
      isolation: "repeatable read",
      readOnly: false,
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      actorId: ACTOR,
      actorKind: "schedule",
    },
    NOW,
  );
  assertEqual(marked, ["RUNX-ORPHAN"], "the orphan was marked");
  const events = db.all("run_log_events");
  assert(
    events.some((e) => e.runExecutionId === "RUNX-ORPHAN" && e.event === "abandoned"),
    "an abandoned event was appended",
  );
});

void runAll("run framework invariants");
