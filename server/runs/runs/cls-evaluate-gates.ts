/**
 * CLOSE-CHECK-GATES. Evaluate the nineteen close gates for a period.
 *
 * Spec: docs/02-run-specifications.md Module 6 CLS-EVALUATE-GATES, with the gate
 * list taken from the task brief G01 through G19. Doc 00 Part 5 carries an older
 * nineteen row table whose numbering disagrees, and NOTES.md entry 83 records why
 * the brief wins: the brief is the contract for this build and it names each gate
 * by assertion rather than by number alone, so the assertions are what got
 * implemented.
 *
 * Every gate is a pure function of the loaded period. It returns pass, fail with
 * the rows that block it, or not applicable with the reason it is out of scope,
 * which is exactly the three outcomes doc 00 Part 5 allows. There is no fourth
 * answer and no gate may decline to answer, because a close that cannot say
 * whether a gate holds is a close nobody can defend.
 *
 * The run posts nothing and never writes the ledger, so it reads a locked period
 * happily. That matters: a locked period still has to be re examinable, since the
 * question of whether the close was sound is asked most often after the fact.
 *
 * Each result carries the ledger fingerprint of the period it was evaluated
 * against. CLOSE-LOCK-PERIOD recomputes that fingerprint and refuses to lock when
 * it moved, which is how a gate set proves it is newer than the last ledger write.
 */

import { z } from "zod";
import {
  isFieldWrite,
  makeResult,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
  type Ulid,
} from "../contract";
import {
  applyProposals,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
  requireTx,
} from "../apply-writer";
import { lockCovering } from "../dates";
import { canonicalJson, derivedId, scopeHashFor, sha256Hex } from "../ids";
import { revertFieldWrite } from "../undo";
import type {
  CloseGateResultRow,
  GateBlockingRow,
  GateOutcome,
  JournalLineRow,
} from "../tables";
import { periodWindow } from "./per-shared";
import {
  CLEARING_ACCOUNTS,
  ZERO,
  balanceOf,
  blockOf,
  blocker,
  fail,
  isIncomeStatement,
  loadCloseData,
  notApplicable,
  pass,
  sumCents,
  tieSourceFor,
  verdict,
  type CloseData,
  type GateDefinition,
  type GateVerdict,
} from "./close-shared";

export const evaluateGatesScopeSchema = z.object({
  clientId: z.string().min(1),
  period: z.string().min(10),
});

export type EvaluateGatesScope = z.infer<typeof evaluateGatesScopeSchema>;

/** The comparable content of one gate result row. */
interface GateContent {
  gateTitle: string;
  outcome: GateOutcome;
  blockingCount: number;
  payload: GateBlockingRow[];
  scopeReason: string | null;
  ledgerFingerprint: string;
}

// ---------------------------------------------------------------------------
// The nineteen gates.
// ---------------------------------------------------------------------------

const g01: GateDefinition = {
  code: "G01",
  title: "Clearing and suspense accounts are at zero",
  evaluate: (data) => {
    const present = data.chart.filter((a) =>
      CLEARING_ACCOUNTS.includes(a.accountNumber),
    );
    if (present.length === 0) {
      return notApplicable("no clearing or suspense account exists on the chart");
    }
    const blocking: GateBlockingRow[] = [];
    for (const account of present) {
      const balance = balanceOf(data.through, account.accountNumber);
      if (balance !== ZERO) {
        blocking.push(
          blocker(
            account.id,
            account.accountNumber,
            `${account.accountNumber} ${account.name} holds a balance at ${data.periodEnd}`,
            balance,
          ),
        );
      }
    }
    return verdict(blocking);
  },
};

const g02: GateDefinition = {
  code: "G02",
  title: "Bank register is cleared to the statement",
  evaluate: (data) => {
    if (data.recBatches.length === 0) {
      return notApplicable(`no reconciliation batch covers ${data.periodStart}`);
    }
    const blocking: GateBlockingRow[] = [];
    for (const batch of data.recBatches) {
      if (batch.state !== "reconciled") {
        blocking.push(
          blocker(
            batch.id,
            `batch ${batch.statementPeriod}`,
            `batch is in state ${batch.state} rather than reconciled`,
            batch.diffCents,
          ),
        );
        continue;
      }
      if (batch.clearedLedgerBalanceCents === null) {
        blocking.push(
          blocker(
            batch.id,
            `batch ${batch.statementPeriod}`,
            "batch carries no cleared ledger balance, so nothing was cleared to the statement",
            null,
          ),
        );
      }
    }
    return verdict(blocking);
  },
};

const g03: GateDefinition = {
  code: "G03",
  title: "Reconciliation difference is zero on every bank account",
  evaluate: (data) => {
    if (data.recBatches.length === 0) {
      return notApplicable(`no reconciliation batch covers ${data.periodStart}`);
    }
    const blocking: GateBlockingRow[] = [];
    for (const batch of data.recBatches) {
      if (batch.diffCents === null || batch.diffCents !== ZERO) {
        blocking.push(
          blocker(
            batch.id,
            `batch ${batch.statementPeriod}`,
            batch.diffCents === null
              ? "batch has no computed difference"
              : "batch difference is not zero",
            batch.diffCents,
          ),
        );
      }
    }
    return verdict(blocking);
  },
};

/** G04 and G05 are the same comparison on the two control accounts. */
function controlGate(
  data: CloseData,
  side: "receivable" | "payable",
): GateVerdict {
  const account =
    side === "receivable" ? data.arap.accounts.arControl : data.arap.accounts.apControl;
  const row = data.chart.find((a) => a.accountNumber === account);
  if (row === undefined) {
    return notApplicable(`${account} is not on the chart`);
  }
  const source = tieSourceFor(data, row);
  const ledger = balanceOf(data.through, account);
  if (source.supportedCents === null) {
    return fail([
      blocker(row.id, account, source.detail, ledger),
    ]);
  }
  const variance = ledger - source.supportedCents;
  if (variance === ZERO) return pass();
  return fail([
    blocker(
      row.id,
      account,
      `${side} subledger of ${source.supportedCents.toString()} does not equal the control balance`,
      variance,
    ),
  ]);
}

const g04: GateDefinition = {
  code: "G04",
  title: "AR subledger equals the AR control account",
  evaluate: (data) => controlGate(data, "receivable"),
};

const g05: GateDefinition = {
  code: "G05",
  title: "AP subledger equals the AP control account",
  evaluate: (data) => controlGate(data, "payable"),
};

/**
 * G06 through G10 all compare a block of accounts to its substantiation source,
 * so they share one body. The block decides the source, which is the whole point
 * of putting the source map in close-shared.
 */
function blockTieGate(
  data: CloseData,
  blocks: readonly string[],
  scopeReason: string,
): GateVerdict {
  const accounts = data.chart.filter((a) =>
    blocks.includes(blockOf(a.accountNumber)),
  );
  if (accounts.length === 0) return notApplicable(scopeReason);
  const blocking: GateBlockingRow[] = [];
  for (const account of accounts) {
    const ledger = balanceOf(data.through, account.accountNumber);
    const source = tieSourceFor(data, account);
    if (source.supportedCents === null) {
      blocking.push(
        blocker(account.id, account.accountNumber, source.detail, ledger),
      );
      continue;
    }
    const variance = ledger - source.supportedCents;
    if (variance !== ZERO) {
      blocking.push(
        blocker(
          account.id,
          account.accountNumber,
          `${source.sourceKind} of ${source.supportedCents.toString()} does not equal the ledger balance of ${ledger.toString()}`,
          variance,
        ),
      );
    }
  }
  return verdict(blocking);
}

const g06: GateDefinition = {
  code: "G06",
  title: "Inventory count equals the inventory general ledger",
  evaluate: (data) =>
    blockTieGate(data, ["inventory"], "no inventory account exists on the chart"),
};

const g07: GateDefinition = {
  code: "G07",
  title: "Fixed asset schedule equals the asset general ledger",
  evaluate: (data) => {
    if (data.assets.length === 0) {
      return notApplicable("no fixed asset is registered for this client");
    }
    return blockTieGate(
      data,
      ["fixed_asset", "accum_depreciation"],
      "no fixed asset account exists on the chart",
    );
  },
};

const g08: GateDefinition = {
  code: "G08",
  title: "Loan schedule equals the loan liability general ledger",
  evaluate: (data) => {
    if (data.loans.length === 0) {
      return notApplicable("no loan is registered for this client");
    }
    return blockTieGate(
      data,
      ["debt_current", "debt_long"],
      "no debt account exists on the chart",
    );
  },
};

const g09: GateDefinition = {
  code: "G09",
  title: "Prepaid schedule equals the prepaid asset general ledger",
  evaluate: (data) => {
    const prepaids = data.deferrals.filter((d) => d.kind === "prepaid");
    if (prepaids.length === 0) {
      return notApplicable("no prepaid schedule exists for this client");
    }
    return blockTieGate(data, ["prepaid"], "no prepaid account exists on the chart");
  },
};

const g10: GateDefinition = {
  code: "G10",
  title: "Payroll register equals the payroll liability general ledger",
  evaluate: (data) =>
    blockTieGate(data, ["payroll"], "no payroll liability account exists on the chart"),
};

const g11: GateDefinition = {
  code: "G11",
  title: "Accruals reversed in the period equal the prior reversal set",
  evaluate: (data) => {
    // The expected set is every entry that told the books it would reverse on a
    // day inside this period. PER-POST-ACCRUALS writes that day on the entry, so
    // the gate reads a commitment rather than guessing from a memo.
    const expected = data.entries.filter(
      (e) =>
        e.reversesOn !== null &&
        e.reversesOn >= data.periodStart &&
        e.reversesOn <= data.periodEnd,
    );
    if (expected.length === 0) {
      return notApplicable("no accrual was due to reverse in this period");
    }
    const reversedIds = new Set(
      data.entries
        .filter((e) => e.reversalOf !== null)
        .map((e) => e.reversalOf as string),
    );
    const blocking: GateBlockingRow[] = [];
    for (const entry of expected) {
      if (reversedIds.has(entry.id)) continue;
      blocking.push(
        blocker(
          entry.id,
          `accrual ${entry.id}`,
          `entry due to reverse on ${entry.reversesOn ?? "an unknown day"} has no reversal`,
          null,
        ),
      );
    }
    return verdict(blocking);
  },
};

const g12: GateDefinition = {
  code: "G12",
  title: "Depreciation is posted for every open asset",
  evaluate: (data) => {
    const open = data.assets.filter(
      (a) =>
        a.status === "active" &&
        a.method !== "none" &&
        a.placedInServiceOn <= data.periodEnd &&
        (a.disposedOn === null || a.disposedOn > data.periodEnd),
    );
    if (open.length === 0) {
      return notApplicable("no depreciable asset is open in this period");
    }
    const blocking: GateBlockingRow[] = [];
    for (const asset of open) {
      const posted = data.depreciation.some(
        (d) =>
          d.assetId === asset.id &&
          d.periodStart === data.periodStart &&
          d.status === "posted",
      );
      if (!posted) {
        blocking.push(
          blocker(
            asset.id,
            asset.tag ?? asset.description,
            `no posted depreciation row exists for ${data.periodStart}`,
            null,
          ),
        );
      }
    }
    return verdict(blocking);
  },
};

const g13: GateDefinition = {
  code: "G13",
  title: "Every rule assignment carries a rule version",
  evaluate: (data) => {
    const assigned = data.transactions.filter((t) => t.ruleId !== null);
    if (assigned.length === 0) {
      return notApplicable("no transaction in the period was coded by a rule");
    }
    const blocking: GateBlockingRow[] = [];
    for (const txn of assigned) {
      if (txn.ruleVersion === null) {
        blocking.push(
          blocker(
            txn.id,
            txn.description,
            `rule ${txn.ruleId ?? "unknown"} was applied without a version`,
            txn.amountCents,
          ),
        );
      }
    }
    return verdict(blocking);
  },
};

const g14: GateDefinition = {
  code: "G14",
  title: "No journal line is dated in a locked period",
  evaluate: (data) => {
    if (data.locks.length === 0) {
      return notApplicable("this client has no locked period");
    }
    const blocking: GateBlockingRow[] = [];
    for (const entry of data.entries) {
      const lock = lockCovering(data.locks, entry.entryDate);
      if (lock === undefined || lock === null) continue;
      // A redated entry is the correct handling of a correction, per doc 03 Part
      // 7, so it is evidence the rule was followed rather than broken.
      if (entry.redatedFromLockedPeriod !== null) continue;
      blocking.push(
        blocker(
          entry.id,
          `entry ${entry.id}`,
          `dated ${entry.entryDate} inside the lock covering ${lock.periodStart} to ${lock.periodEnd}`,
          null,
        ),
      );
    }
    return verdict(blocking);
  },
};

const g15: GateDefinition = {
  code: "G15",
  title: "Every posted line carries a cascade level and a rule or an override",
  evaluate: (data) => {
    const inPeriod = data.entries.filter(
      (e) => e.entryDate >= data.periodStart && e.entryDate <= data.periodEnd,
    );
    if (inPeriod.length === 0) {
      return notApplicable("no entry is dated in this period");
    }
    const txnById = new Map(data.transactions.map((t) => [t.id, t]));
    const blocking: GateBlockingRow[] = [];
    for (const entry of inPeriod) {
      // Only a coded transaction can carry a cascade level. A schedule driven
      // entry gets its provenance from the run type and the source row, which is
      // recorded on the entry itself and is not a coding decision at all.
      if (entry.sourceTable !== "transactions") continue;
      const txn = txnById.get(entry.sourceRowId);
      if (txn === undefined) continue;
      if (txn.manualOverride) continue;
      const hasAuthority =
        txn.ruleId !== null || txn.templateId !== null || txn.categoryId !== null;
      if (txn.cascadeLevel === null || !hasAuthority) {
        blocking.push(
          blocker(
            entry.id,
            `entry ${entry.id}`,
            `transaction ${txn.id} carries cascade level ${
              txn.cascadeLevel === null ? "none" : String(txn.cascadeLevel)
            } and no rule, template, or category`,
            null,
          ),
        );
      }
    }
    return verdict(blocking);
  },
};

const g16: GateDefinition = {
  code: "G16",
  title: "The trial balance foots to zero",
  evaluate: (data) => {
    const total = sumCents([...data.through.values()]);
    if (total === ZERO) return pass();
    return fail([
      blocker(null, "trial balance", `the trial balance does not foot at ${data.periodEnd}`, total),
    ]);
  },
};

const g17: GateDefinition = {
  code: "G17",
  title: "No orphan document request is older than thirty days",
  evaluate: (data) => {
    const open = data.requests.filter((r) => r.status === "open");
    if (open.length === 0) {
      return notApplicable("this client has no open document request");
    }
    const blocking: GateBlockingRow[] = [];
    for (const request of open) {
      if (request.agingDays < 30) continue;
      if (request.ownerChangedOn !== null) continue;
      blocking.push(
        blocker(
          request.id,
          request.subjectKey,
          `open ${request.agingDays} days with no owner change since ${request.openedOn}`,
          null,
        ),
      );
    }
    return verdict(blocking);
  },
};

const g18: GateDefinition = {
  code: "G18",
  title: "The preparer is not the approver for any run in the period",
  evaluate: (data) => {
    // The gate evaluation run itself is excluded. Its own apply row exists when
    // the gate reads the log during apply and does not exist during preview, so
    // including it would make this gate the one place where preview and apply
    // disagree, which the framework refuses outright. Evaluating gates changes
    // no books, so it is a measurement rather than a preparer approver event.
    // See NOTES.md entry 91.
    const applies = data.runLog.filter(
      (r) =>
        r.mode === "apply" &&
        r.previewRunId !== null &&
        r.runType !== "CLOSE-CHECK-GATES",
    );
    if (applies.length === 0) {
      return notApplicable("no run was applied in this period");
    }
    const byId = new Map(data.runLog.map((r) => [r.id, r]));
    const blocking: GateBlockingRow[] = [];
    for (const applied of applies) {
      const preview = byId.get(applied.previewRunId as string);
      if (preview === undefined) continue;
      if (preview.actorId !== applied.actorId) continue;
      blocking.push(
        blocker(
          applied.id,
          applied.runType,
          `${applied.actorId} both previewed and applied ${applied.runType}, which doc 05 D4 forbids`,
          null,
        ),
      );
    }
    return verdict(blocking);
  },
};

const g19: GateDefinition = {
  code: "G19",
  title: "Cash basis derived equals accrual less the AR and AP change",
  evaluate: (data) => {
    const derived = derivedCashNet(data);
    if (derived.expected === derived.actual) return pass();
    return fail([
      blocker(
        null,
        "cash basis derivation",
        `accrual less the receivable and payable change gives ${derived.expected.toString()} while the cash touching entries give ${derived.actual.toString()}`,
        derived.expected - derived.actual,
      ),
    ]);
  },
};

/**
 * Doc 05 D3. The books are accrual native and the cash basis is derived, never
 * kept in a second ledger, so the derivation has to be checkable.
 *
 * Expected is the accrual result adjusted for the two working capital accounts:
 * with debit positive signs, net income is the negated income statement movement,
 * an increase in receivable is a debit, and an increase in payable is a credit,
 * so the whole adjustment collapses to the negated sum of the income statement
 * movement plus the two control movements.
 *
 * Actual walks the other way. It takes only the entries that actually touched
 * cash and sums their income statement and control account lines, which is the
 * cash result stated by the ledger itself. The two agree when every income
 * statement line either moved cash or was routed through a control account, and
 * they disagree when revenue or expense was parked somewhere else, which is the
 * error the gate exists to catch.
 */
export function derivedCashNet(data: CloseData): {
  expected: Cents;
  actual: Cents;
} {
  const ar = data.arap.accounts.arControl;
  const ap = data.arap.accounts.apControl;
  let incomeStatement = ZERO;
  for (const [account, balance] of data.inPeriod) {
    if (isIncomeStatement(account)) incomeStatement += balance;
  }
  const expected = -(
    incomeStatement + balanceOf(data.inPeriod, ar) + balanceOf(data.inPeriod, ap)
  );

  const linesByEntry = new Map<string, JournalLineRow[]>();
  for (const line of data.lines) {
    if (line.entryDate < data.periodStart || line.entryDate > data.periodEnd) {
      continue;
    }
    const list = linesByEntry.get(line.entryId);
    if (list === undefined) linesByEntry.set(line.entryId, [line]);
    else list.push(line);
  }
  let cashSide = ZERO;
  for (const lines of linesByEntry.values()) {
    const touchesCash = lines.some((l) => blockOf(l.accountNumber) === "cash");
    if (!touchesCash) continue;
    for (const line of lines) {
      if (
        isIncomeStatement(line.accountNumber) ||
        line.accountNumber === ar ||
        line.accountNumber === ap
      ) {
        cashSide += line.amountCents;
      }
    }
  }
  return { expected, actual: -cashSide };
}

/** The nineteen, in order. The order is the write order and the report order. */
export const CLOSE_GATES: readonly GateDefinition[] = [
  g01,
  g02,
  g03,
  g04,
  g05,
  g06,
  g07,
  g08,
  g09,
  g10,
  g11,
  g12,
  g13,
  g14,
  g15,
  g16,
  g17,
  g18,
  g19,
];

/**
 * A hash of what all nineteen gates say about a book. Two executions that would
 * write the same nineteen rows share it, and any change in any answer moves it.
 */
function answerHash(data: CloseData): string {
  return sha256Hex(
    canonicalJson(
      CLOSE_GATES.map((gate) => {
        const answer = gate.evaluate(data);
        return {
          code: gate.code,
          outcome: answer.outcome,
          blocking: answer.blocking.map((b) => b.rowId),
          scopeReason: answer.scopeReason,
        };
      }),
    ),
  );
}

export const clsEvaluateGates: Run<EvaluateGatesScope, Proposal> = {
  type: "CLOSE-CHECK-GATES",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:gates:${scope.period.slice(0, 7)}`,
  scopeSchema: evaluateGatesScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<EvaluateGatesScope>> {
    const tx = requireTx(ctx);
    const window = periodWindow(scope.period);
    const existing = await tx.query("close_gate_results_for_period", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      periodStart: window.periodStart,
    });
    const data = await loadCloseData(tx, ctx.firmId, scope.clientId, scope.period);
    const candidateIds = CLOSE_GATES.map((g) =>
      gateResultId(window.periodStart, g.code),
    );
    const versions = [
      { id: "CLOSE-CHECK-GATES", version: 1 },
      ...CLOSE_GATES.map((g) => ({ id: g.code, version: 1 })),
    ];
    // The candidate set of this run is the same nineteen ids in every period and
    // the gate versions never move, so the discriminator carries the answers the
    // gates give on the books as they stand. Without it a second evaluation after
    // a posting or a fixed blocker would key to the first one and hand back stale
    // answers, which is exactly the state CLOSE-LOCK-PERIOD refuses to lock on.
    // Evaluating twice per execution is cheap and the gates are pure. See
    // NOTES.md entry 93.
    const discriminator = `${window.periodStart}:${answerHash(data)}`;
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      candidateIds,
      scopeHash: scopeHashFor({
        period: discriminator,
        candidateIds,
        versions,
      }),
      versions,
      overriddenIds: existing.filter((r) => r.manualOverride).map((r) => r.id),
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const data = await loadCloseData(
      tx,
      frozen.firmId,
      frozen.clientId,
      frozen.input.period,
    );
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const prior = new Map<string, CloseGateResultRow>(
      (
        await tx.query("close_gate_results_for_period", {
          firmId: frozen.firmId,
          clientId: frozen.clientId,
          periodStart: data.periodStart,
        })
      ).map((r) => [r.id, r]),
    );

    for (const gate of CLOSE_GATES) {
      const answer = gate.evaluate(data);
      const content: GateContent = {
        gateTitle: gate.title,
        outcome: answer.outcome,
        blockingCount: answer.blocking.length,
        payload: answer.blocking,
        scopeReason: answer.scopeReason,
        ledgerFingerprint: data.fingerprint,
      };
      const rowId = gateResultId(data.periodStart, gate.code);
      const existing = prior.get(rowId);
      if (existing === undefined) {
        proposals.push(insertGateResult(frozen, data, rowId, gate.code, content));
        continue;
      }
      // An overridden gate is a decision a named person made in writing, which
      // doc 00 Part 5 allows and this run may not undo.
      if (existing.manualOverride) {
        skips.push({
          rowId,
          reason: "manual_override",
          detail: `${gate.code} carries manual_override: ${existing.overrideReason ?? "no reason recorded"}`,
        });
        continue;
      }
      const changed = changedFields(existing, content);
      if (Object.keys(changed.after).length === 0) {
        skips.push({
          rowId,
          reason: "already_applied",
          detail: `gate_unchanged for ${gate.code} at ${data.periodEnd}`,
        });
        continue;
      }
      proposals.push({
        kind: "field_write",
        table: "close_gate_results",
        rowId,
        before: changed.before,
        after: changed.after,
        provenance: { cascadeLevel: null },
      });
    }

    return makeResult<Proposal>(
      frozen.candidateIds.length,
      proposals,
      skips,
      errors,
      ZERO,
    );
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "CLOSE-CHECK-GATES",
      runVersion: 1,
    });
  },

  /** The reading stands. Only a rewritten outcome reverts. */
  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isFieldWrite(p)) plan.push(revertFieldWrite(p));
    }
    return plan;
  },
};

export function gateResultId(periodStart: string, gateCode: string): Ulid {
  return derivedId(`${periodStart}:${gateCode}`, "cls-evaluate-gates", 0);
}

function insertGateResult(
  frozen: FrozenScope<EvaluateGatesScope>,
  data: CloseData,
  rowId: Ulid,
  gateCode: string,
  content: GateContent,
): ProposedRowInsert {
  return {
    kind: "row_insert",
    table: "close_gate_results",
    rowId,
    row: {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      version: 1,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      gateCode,
      ...content,
      evaluatedAt: NOW_PLACEHOLDER,
      evaluatedByRunId: RUN_ID_PLACEHOLDER,
      manualOverride: false,
      overrideReason: null,
    },
    provenance: { cascadeLevel: null },
  };
}

function changedFields(
  prior: CloseGateResultRow,
  next: GateContent,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const keys = Object.keys(next) as (keyof GateContent)[];
  for (const k of keys) {
    const priorValue = (prior as unknown as Record<string, unknown>)[k];
    // The payload is an array, so identity comparison would call every rerun a
    // change. Canonical json is the same comparison the scope hash uses.
    const differs =
      k === "payload"
        ? canonicalJson(priorValue ?? []) !== canonicalJson(next.payload)
        : priorValue !== next[k];
    if (differs) {
      before[k] = priorValue;
      after[k] = next[k];
    }
  }
  return { before, after };
}
