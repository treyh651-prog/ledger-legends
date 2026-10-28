/**
 * The compliance tier of every registered run, and the guard that enforces it.
 *
 * The scheduler now lives outside this process. Trigger.dev calls in, and the
 * caller cannot be trusted to have read doc 02, doc 03, or this file. So the
 * question "may a clock start this run with nobody watching" has to be
 * answered by something the caller cannot skip. It is answered twice: by a
 * named check constraint chain in migration 0022, and by the guard below,
 * which the executor calls before it freezes a scope.
 *
 * The three tiers, and the rule that decides between them:
 *
 *   unattended  Writes nothing to the general ledger and reaches no outside
 *               party. Every effect is derived from rows a person can already
 *               see, and rerunning it lands on the same answer. A clock may
 *               run these to completion.
 *
 *   propose     Prepares and must not commit. Either it posts to the general
 *               ledger, or its output is addressed to somebody outside the
 *               firm. The schedule runs it in preview mode, which leaves a
 *               proposal set and a log row for Jose Hernandez or Rosario
 *               Rosales to approve, and commits nothing.
 *
 *   manual      Never scheduled at all. A person starts it, because the act
 *               itself is the decision: locking a period, approving a payroll,
 *               closing a year, finishing a wizard, exporting a departing
 *               client.
 *
 * The ledger half of that rule is machine checkable. `registry.ts` already
 * carries `writesLedger` per run, and the test suite asserts that no run with
 * `writesLedger: true` is classified `unattended`. The outside party half is a
 * judgement and is written out run by run below, because a reason that only
 * exists in somebody's head is a reason that gets overruled at 2am.
 */

export type RunTier = "unattended" | "propose" | "manual";

export interface RunPolicy {
  readonly tier: RunTier;
  /** Why this tier and not a looser one. Seeded into sched.run_policies. */
  readonly reason: string;
}

/**
 * Every run type in `registry.ts`, with no default and no fallback.
 *
 * A run that is absent from this table is refused by `guardScheduledRun`
 * rather than assumed safe. A new run is not born unattended.
 */
export const RUN_POLICIES: Readonly<Record<string, RunPolicy>> = {
  // ---------------------------------------------------------------------
  // Module 1, intake and setup. All four run once, at the moment the firm
  // finishes the wizard, and there is no wizard for a clock to finish.
  // ---------------------------------------------------------------------
  "INTAKE-CREATE-CLIENT": {
    tier: "manual",
    reason:
      "the first intake step, run once when the firm starts a client from the interface, and a clock has no reason to create a client",
  },
  "INTAKE-ACTIVATE-ENGAGEMENT": {
    tier: "manual",
    reason:
      "turns a draft engagement active once the letter is signed, which is a decision the firm records on purpose and never one a clock infers",
  },
  "PORTAL-ANSWER-REQUEST": {
    tier: "manual",
    reason:
      "a person at the client answers an open request from the portal, and nothing else can answer for them",
  },
  "PORTAL-POST-MESSAGE": {
    tier: "manual",
    reason: "a person at the client or the firm writes a message, and a clock has nothing to say",
  },
  "DOC-RECORD-UPLOAD": {
    tier: "manual",
    reason: "a person sends one file from the portal or the firm plane, and the record is written only after the bytes are stored",
  },
  "ENG-SIGN-LETTER": {
    tier: "manual",
    reason: "the client signs the engagement letter from the portal, the signature record is theirs alone",
  },
  "INTAKE-BUILD-CHART": {
    tier: "manual",
    reason:
      "runs once when the firm finishes the intake wizard, and a second chart build for a client that already has a chart is a mistake rather than a refresh",
  },
  "INTAKE-SEED-TASKS": {
    tier: "manual",
    reason:
      "one time wizard step that seeds the whole task catalog, so a repeat on a clock would stack a second copy of the firm's workload",
  },
  "INTAKE-OPEN-REQUESTS": {
    tier: "manual",
    reason:
      "one time wizard step whose output is a list of asks addressed to the client, and the first thing a new client hears from the firm is not a thing a clock decides to send",
  },
  "SETUP-ADD-BANK-ACCOUNT": {
    tier: "manual",
    reason:
      "names a bank or card account and which chart account it feeds, once, and a clock has no account of its own to discover",
  },
  "SETUP-IMPORT-BALANCES": {
    tier: "manual",
    reason:
      "posts the opening balance entry to the general ledger once, and a wrong opening balance misstates every period built on top of it",
  },
  "IMPORT-PARSE-FEED": {
    tier: "unattended",
    reason:
      "parses a feed into staging, touches no ledger account, and a reparse of the same feed lands on the same staged rows",
  },
  "IMPORT-COMMIT-BATCH": {
    tier: "propose",
    reason:
      "commits a staged batch into the register and the ledger, and which batch commits is a decision a person makes after looking at the mapping",
  },

  // ---------------------------------------------------------------------
  // Module 2, the coding cascade. The six levels that only classify a row
  // are unattended. The four that post are not.
  // ---------------------------------------------------------------------
  "TXN-NORMALIZE-VENDORS": {
    tier: "unattended",
    reason:
      "rewrites a vendor key on the register, changes no amount and no account, and respects the manual override flag",
  },
  "TXN-DETECT-DUPLICATES": {
    tier: "unattended",
    reason: "sets a flag on a row so a person can look at it, and posts nothing",
  },
  "TXN-PAIR-TRANSFERS": {
    tier: "propose",
    reason:
      "posts the clearing entry that closes a transfer pair, which is a general ledger write",
  },
  "TXN-SPLIT-SETTLEMENTS": {
    tier: "propose",
    reason:
      "posts gross revenue and processor fees as separate ledger lines from a report that does not always add up",
  },
  "TXN-APPLY-RECURRING": {
    tier: "propose",
    reason:
      "posts an entry from a template, and a template that has drifted from reality posts a wrong number every period until somebody looks",
  },
  "TXN-APPLY-RULES": {
    tier: "unattended",
    reason:
      "assigns a category from a rule the firm wrote, writes no journal line, and refuses a row a person has claimed",
  },
  "TXN-APPLY-VENDORDEFAULTS": {
    tier: "unattended",
    reason:
      "assigns the vendor's default category, a classification the firm already recorded, and posts nothing",
  },
  "TXN-MAP-BANKCODES": {
    tier: "unattended",
    reason:
      "maps the bank's own category code through a table the firm maintains, and posts nothing",
  },
  "TXN-SWEEP-SUSPENSE": {
    tier: "propose",
    reason:
      "parks a transaction in a clearing account with a ledger entry and opens a portal request the client reads",
  },

  // ---------------------------------------------------------------------
  // Module 3, reconciliation. REC-IMPORT-STATEMENT puts the bank's own lines
  // on the books; none of the four posts anything.
  // ---------------------------------------------------------------------
  "REC-IMPORT-STATEMENT": {
    tier: "unattended",
    reason:
      "records exactly what the bank statement says, touches no ledger account, and a repeat on the same statement id changes nothing",
  },
  "REC-MATCH-TIERED": {
    tier: "unattended",
    reason:
      "proposes matches between statement lines and register rows, writes no ledger entry, and a wrong match is undone by rematching",
  },
  "REC-CLEAR-MATCHED": {
    tier: "unattended",
    reason:
      "flags matched lines cleared inside a reconciliation batch, which is derived from the match and reversible",
  },
  "REC-FLAG-STALE": {
    tier: "unattended",
    reason:
      "reports what clearing left outstanding, which is a measurement and not a change",
  },

  // ---------------------------------------------------------------------
  // Module 4, period end. Every one of the six posts to the general ledger,
  // so every one of the six prepares and waits.
  // ---------------------------------------------------------------------
  "PER-REVERSE-ACCRUALS": {
    tier: "propose",
    reason: "posts reversing entries into the general ledger",
  },
  "PER-POST-RECURRING": {
    tier: "propose",
    reason: "posts recurring entries into the general ledger",
  },
  "PER-AMORTIZE-PREPAID": {
    tier: "propose",
    reason: "posts the period's amortization into the general ledger",
  },
  "PER-SPLIT-LOANPAYMENT": {
    tier: "propose",
    reason:
      "posts principal, interest and escrow into the general ledger from a schedule that a refinance can silently invalidate",
  },
  "PER-POST-ACCRUALS": {
    tier: "propose",
    reason: "posts accrual entries into the general ledger",
  },
  "PER-POST-DEPRECIATION": {
    tier: "propose",
    reason: "posts depreciation into the general ledger",
  },

  // ---------------------------------------------------------------------
  // Module 5, AR and AP. AR-CREATE-CUSTOMER and AR-CREATE-INVOICE put the
  // first customer and the first bill on the books; AP-CREATE-VENDOR and
  // AP-CREATE-BILL do the identical thing for the payable side, and
  // AR-RECORD-PAYMENT puts the first received payment on the books. Four of
  // the documented six post, two reach a customer, one measures.
  // ---------------------------------------------------------------------
  "AR-CREATE-CUSTOMER": {
    tier: "manual",
    reason:
      "a person at the firm records a new customer by name, once, and a clock has no customer of its own to discover",
  },
  "AR-CREATE-INVOICE": {
    tier: "manual",
    reason:
      "posts the sale to the general ledger and bills a named customer, so the run prepares and a person decides, the same reasoning SETUP-IMPORT-BALANCES gives for the opening entry",
  },
  "AP-CREATE-VENDOR": {
    tier: "manual",
    reason:
      "a person at the firm records a new vendor by legal name, once, and a clock has no vendor of its own to discover",
  },
  "AP-CREATE-BILL": {
    tier: "manual",
    reason:
      "posts the payable to the general ledger from a named vendor's bill, so the run prepares and a person decides, the same reasoning AR-CREATE-INVOICE gives for billing a customer",
  },
  "AR-RECORD-PAYMENT": {
    tier: "manual",
    reason:
      "names which customer a deposit already on the register belongs to, once, and a clock cannot discover whose cash it is",
  },
  "AR-CREATE-CREDITMEMO": {
    tier: "manual",
    reason:
      "posts a reversal to the general ledger and credits a named customer's balance, so the run prepares and a person decides, the same reasoning AR-CREATE-INVOICE gives for billing one",
  },
  "AR-APPLY-PAYMENTS": {
    tier: "propose",
    reason:
      "posts cash against invoices, which changes what a customer owes and is a general ledger write",
  },
  "AP-APPLY-DISCOUNTS": {
    tier: "propose",
    reason:
      "settles a payable early and posts the discount, which is a general ledger write",
  },
  "AR-CHARGE-LATEFEES": {
    tier: "propose",
    reason:
      "a late fee has an outside party on the other end of it, and a fee charged in error is a phone call from a customer rather than a row somebody quietly fixes",
  },
  "AR-WRITEOFF-UNCOLLECTIBLE": {
    tier: "propose",
    reason:
      "writing off a receivable gives up on collecting from a named customer and posts the loss, so the run prepares the writeoff proposal and a person decides",
  },
  "ARAP-REFRESH-AGING": {
    tier: "unattended",
    reason:
      "recomputes the aging snapshot from invoices and payments that already exist, which is derived and posts nothing",
  },
  "AR-BUILD-STATEMENTS": {
    tier: "propose",
    reason:
      "a statement is a document a customer reads, so it is built and held rather than released by a clock",
  },

  // ---------------------------------------------------------------------
  // Module 6, substantiation and close.
  // ---------------------------------------------------------------------
  "SUB-TIEOUT-ACCOUNTS": {
    tier: "unattended",
    reason:
      "compares a subledger against its control account and records the difference, which is a measurement",
  },
  "SUB-RAISE-REQUESTS": {
    tier: "propose",
    reason:
      "raises document requests the client sees and has to answer, which is correspondence and not bookkeeping",
  },
  "CLOSE-CHECK-GATES": {
    tier: "unattended",
    reason:
      "evaluates the close gates and records pass or fail, which changes nothing and is the report a person reads before deciding",
  },
  "CLOSE-LOCK-PERIOD": {
    tier: "manual",
    reason:
      "a clock must not lock a period, because the lock is the firm's assertion that the period is finished and every later correction has to be redated around it",
  },
  "CLOSE-ROLL-FORWARD": {
    tier: "propose",
    reason:
      "carries balances into the next period and is only correct once the period behind it is closed, which is a manual act it cannot verify happened for the right reason",
  },
  "CLOSE-POST-YEAREND": {
    tier: "manual",
    reason:
      "posts the year end closing entries, which zero the income statement into equity, and a year that closes itself on a clock is a year nobody signed off",
  },

  // ---------------------------------------------------------------------
  // Module 8, reporting. All four are derived from figures already posted.
  // ---------------------------------------------------------------------
  "RPT-BUILD-PACKAGE": {
    tier: "unattended",
    reason:
      "renders a snapshot of figures that are already on the books, and posts nothing",
  },
  "RPT-FLAG-VARIANCES": {
    tier: "unattended",
    reason: "compares the package against budget and flags the gaps, which is derived",
  },
  "RPT-REBUILD-FORECAST": {
    tier: "unattended",
    reason:
      "recomputes the cash forecast from current balances, and a forecast is a projection nobody posts",
  },
  "RPT-COMPOSE-NARRATIVE": {
    tier: "unattended",
    reason:
      "writes a description of what the other three reporting runs found into the package, where releasing the package to a client is a separate act",
  },

  // ---------------------------------------------------------------------
  // Module 9, tax compilation.
  // ---------------------------------------------------------------------
  "TAX-BUILD-1099": {
    tier: "propose",
    reason:
      "compiles the data set behind a government filing with named payees on it, and the amounts are attested by a person before anybody files them",
  },
  "TAX-TRACK-W9": {
    tier: "unattended",
    reason:
      "refreshes the W-9 status of each payee from the documents already in the vault, and contacts nobody",
  },

  // ---------------------------------------------------------------------
  // Module 10, practice management. Two are internal, one is not.
  // ---------------------------------------------------------------------
  "PRAC-GENERATE-TASKS": {
    tier: "unattended",
    reason:
      "creates the firm's own workload for the period from its own catalog, and is idempotent per period",
  },
  "PRAC-ESCALATE-OVERDUE": {
    tier: "unattended",
    reason:
      "raises an internal notice about the firm's own overdue work, which nobody outside the firm sees",
  },
  "PRAC-NUDGE-REQUESTS": {
    tier: "propose",
    reason:
      "a nudge is a message to the client, and how often a client is chased is a relationship decision rather than a cadence",
  },
  "PRAC-UPDATE-TASK": {
    tier: "manual",
    reason: "a person at the firm completes, reopens, or reassigns one task from the board, and a clock has no opinion on that",
  },
  "ENG-SET-BILLING-STATUS": {
    tier: "manual",
    reason: "a person at the firm marks the engagement current or past due by hand, because this system has no payment event for a clock to read",
  },

  // ---------------------------------------------------------------------
  // D5 payroll and the two deliverables.
  // ---------------------------------------------------------------------
  "PAY-APPROVE-RUN": {
    tier: "manual",
    reason:
      "approval is the human act itself, and a clock that approves a payroll has removed the only review the posting step depends on",
  },
  "PAY-POST-REGISTER": {
    tier: "propose",
    reason:
      "posts the payroll register into the general ledger, which is a ledger write even though it disburses nothing",
  },
  "CPA-BUILD-HANDOFF": {
    tier: "propose",
    reason:
      "builds the archive an outside CPA works from, and which period is handed over is a decision the firm makes once",
  },
  "OFFBOARD-BUILD-EXPORT": {
    tier: "manual",
    reason:
      "a client is offboarded because a contract ended, which is a fact no table in this system holds, so nothing here should be able to start it",
  },
};

export const RUN_TIER_VALUES: readonly RunTier[] = [
  "unattended",
  "propose",
  "manual",
];

export function tierOf(runType: string): RunTier | null {
  const policy = RUN_POLICIES[runType];
  return policy ? policy.tier : null;
}

/** The reason a run carries its tier, or null when the run is unknown. */
export function tierReasonOf(runType: string): string | null {
  const policy = RUN_POLICIES[runType];
  return policy ? policy.reason : null;
}

/**
 * The execution mode a schedule is allowed to use for a run.
 *
 * There is one answer per tier and it is not configurable, which is the point.
 * A schedule row carries the mode so the operator can read it, and migration
 * 0022 constrains the pair so a row with the wrong mode cannot be stored.
 */
export function scheduledModeFor(tier: RunTier): "preview" | "apply" | null {
  if (tier === "unattended") return "apply";
  if (tier === "propose") return "preview";
  return null;
}

export class TierRefusal extends Error {
  readonly code = "TIER_REFUSED";
  constructor(
    readonly runType: string,
    readonly tier: RunTier | null,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The executor guard.
 *
 * Called only when a run is starting with nobody watching, which today means
 * a Trigger.dev task. Returns nothing and throws `TierRefusal` on refusal,
 * because the caller is a task wrapper and the useful thing to hand it is a
 * failure it cannot accidentally ignore.
 *
 * An unknown run type is refused. Failing closed costs a person one line in a
 * seed table, and failing open costs a client a posted entry nobody reviewed.
 */
export function guardScheduledRun(
  runType: string,
  mode: "preview" | "apply",
): void {
  const tier = tierOf(runType);
  if (tier === null) {
    throw new TierRefusal(
      runType,
      null,
      `${runType} has no compliance tier in RUN_POLICIES, so it may not run unattended. Classify it before scheduling it.`,
    );
  }
  if (tier === "manual") {
    throw new TierRefusal(
      runType,
      tier,
      `${runType} is tier manual and is never scheduled: ${RUN_POLICIES[runType].reason}`,
    );
  }
  if (tier === "propose" && mode === "apply") {
    throw new TierRefusal(
      runType,
      tier,
      `${runType} is tier propose and may only run unattended in preview mode: ${RUN_POLICIES[runType].reason}`,
    );
  }
}
