/**
 * Compliance tests.
 *
 * Ledger Legends is not a CPA firm. This run compiles data. It does not file,
 * issue, submit, or transmit any tax document. The compiled data set is
 * provided to the client's CPA for filing.
 *
 * The other test files check that each run does what it is supposed to do. This
 * one checks the four things no run is allowed to do, and it checks them by
 * reading the source off disk as well as by running the code, because a claim
 * about what a file does not contain cannot be proved by calling it.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assert, assertEqual, test } from "./harness";
import { isRowInsert } from "../contract";
import {
  ACTOR,
  CLIENT_A1,
  FIRM_A,
  PAY_DATE,
  PROVIDER,
  applyDlv,
  approveScope,
  archiveDb,
  handoffsOf,
  payRunsOf,
  payrollDb,
  previewDlv,
} from "./dlv-fixtures";
import { CheckViolation } from "../db";
import type { PayRunRow } from "../tables";
import { payApproveRun, payRunIdOf } from "../runs/pay-approve-run";
import { cpaBuildHandoff } from "../runs/cpa-build-handoff";
import { applyTax, dataSetsOf, linesOf, taxDb, taxScope } from "./tax-fixtures";
import { taxBuild1099 } from "../runs/tax-build-1099";
import { w9Track } from "../runs/w9-track";
import { COMPILATION_ONLY_BANNER } from "../runs/tax-shared";

/**
 * The repository root, found by walking up from the working directory.
 *
 * These tests read source off disk, and the suite is loaded as an ES module
 * where there is no __dirname. Walking up for a landmark works whether the
 * suite runs from the root or from a subdirectory.
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "server", "runs", "runs"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error("could not locate the repository root from " + process.cwd());
}

const ROOT = repoRoot();
const RUNS_DIR = join(ROOT, "server", "runs", "runs");

/** Every file this task added that carries a tax or CPA obligation. */
const TAX_FILES = [
  "tax-shared.ts",
  "tax-build-1099.ts",
  "w9-track.ts",
  "cpa-build-handoff.ts",
];

/**
 * Vocabulary a bookkeeping firm that is not a CPA firm may not put in front of
 * a client.
 *
 * Two groups. The first is advice, which the firm does not give. The second is
 * assurance, which the firm does not provide and which has a specific meaning
 * under professional standards. Any of these inside a prose string or a
 * template in a tax or CPA run is a compliance defect, not a wording problem.
 */
const BANNED_VOCABULARY = [
  "we recommend",
  "we advise",
  "we suggest",
  "you should",
  "tax advice",
  "advise you",
  "our opinion",
  "in our opinion",
  "we will file",
  "we filed",
  "we will submit",
  "on your behalf",
  "elect to",
  "safe harbor",
  "deductible",
  "audited financial",
  "we audited",
  "we reviewed",
  "assurance is provided",
  "reasonable assurance",
];

/** Words that would mean the run reached outside this system. */
const OUTBOUND_MARKERS = [
  "http://",
  "https://",
  "fetch(",
  "axios",
  "sendMail",
  "sendmail",
  "smtp",
  "twilio",
  "sendgrid",
  "postmark",
  "webhook",
];

/** Tables that would mean a run produced a document, a file, or a send. */
const FORBIDDEN_TABLES = [
  "document_links",
  "documentation_exceptions",
  "statement_documents",
  "statement_items",
  "portal_requests",
];

function sourceOf(name: string): string {
  return readFileSync(join(RUNS_DIR, name), "utf8");
}

/**
 * The source with comment furniture and line breaks flattened away.
 *
 * A banner that wraps across four comment lines is the same banner. Matching it
 * literally would only prove that somebody kept the line width, which is not
 * the guarantee anybody wants.
 */
function flatten(source: string): string {
  return source
    .replace(/\n\s*\*\s?/g, " ")
    .replace(/\n\s*\/\/\s?/g, " ")
    .replace(/"\s*\+\s*"/g, "")
    .replace(/\s+/g, " ");
}

/** Code with every comment removed, which is where a transport would hide. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Prose only. Code identifiers are not prose and are not the subject here. */
function proseOf(source: string): string {
  const flat = flatten(source);
  const strings = flat.match(/"[^"\n]*"|`[^`]*`/g) ?? [];
  const comments = source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? [];
  return [...strings, flatten(comments.join("\n"))].join(" ").toLowerCase();
}

/**
 * Whether a banned phrase is used, rather than merely disclaimed.
 *
 * "It is not tax advice" has to be allowed, because saying so is the whole
 * point of a scope statement. Only an occurrence that is not preceded by a
 * refusal counts against the file.
 */
const REFUSALS = [
  "not ",
  "no ",
  "never ",
  "none of ",
  "contains no ",
  "is not ",
  "does not ",
  "cannot ",
  "forbids ",
  "without ",
  "neither ",
  "nor ",
];

function usesPhrase(text: string, phrase: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(phrase, from);
    if (at < 0) return false;
    const before = text.slice(Math.max(0, at - 60), at);
    if (!REFUSALS.some((r) => before.includes(r))) return true;
    from = at + phrase.length;
  }
}

test("pay-approve-run refuses to set authorizes_disbursement true", async () => {
  const db = payrollDb();
  await applyDlv(db, payApproveRun, approveScope());
  const rowId = payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER);
  assertEqual(payRunsOf(db)[0].authorizesDisbursement, false, "the approval carries no authority");

  let caught: unknown = null;
  try {
    await db.tx(
      {
        firmId: FIRM_A,
        clientId: CLIENT_A1,
        actorId: ACTOR,
        actorKind: "human",
        isolation: "serializable",
        readOnly: false,
      },
      async (tx) => {
        await tx.update("pay_runs", rowId, {
          authorizesDisbursement: true,
        } as unknown as Partial<PayRunRow>);
      },
    );
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof CheckViolation, "the database refused the write");
  assertEqual(
    (caught as CheckViolation).constraintName,
    "pay_run_no_disbursement_authority",
    "and refused it by that constraint, named",
  );
  assertEqual(payRunsOf(db)[0].authorizesDisbursement, false, "the row is unchanged");
});

test("the constraint is in the migration under the same name", () => {
  const sql = readFileSync(
    join(ROOT, "db", "migrations", "0017_compliance_practice.sql"),
    "utf8",
  );
  assert(
    sql.includes("pay_run_no_disbursement_authority"),
    "the migration names the constraint",
  );
  assert(
    sql.includes("authorizes_disbursement = false"),
    "and pins the column to one value, so D5 lives in the schema and not in a comment",
  );
});

test("no payroll run proposes anything that moves money", async () => {
  const db = payrollDb();
  const out = await previewDlv(db, payApproveRun, approveScope());
  for (const proposal of out.result?.proposals ?? []) {
    assert(proposal.kind !== "journal_entry", "an approval posts nothing");
    if (isRowInsert(proposal)) {
      assertEqual(proposal.table, "pay_runs", "and writes only the pay run row");
      assertEqual(proposal.row.authorizesDisbursement, false, "with no authority on it");
    }
  }
  const source = sourceOf("pay-approve-run.ts");
  assert(
    !source.includes("authorizesDisbursement: true"),
    "and the source never sets the flag true anywhere",
  );
});

test("tax-build-1099 never writes to a file, document, or send table", async () => {
  const db = taxDb();
  const { preview, applied } = await applyTax(db, taxBuild1099, taxScope());
  const tables = new Set<string>();
  for (const proposal of [
    ...(preview.result?.proposals ?? []),
    ...(applied.result?.proposals ?? []),
  ]) {
    if ("table" in proposal && typeof proposal.table === "string") tables.add(proposal.table);
    assert(proposal.kind !== "journal_entry", "the compilation posts nothing to the ledger");
  }
  assertEqual(
    JSON.stringify([...tables].sort()),
    JSON.stringify(["tax_data_lines", "tax_data_sets"]),
    "only the two compilation tables are written",
  );
  for (const table of FORBIDDEN_TABLES) {
    assertEqual(db.all(table as never).length, 0, `nothing landed in ${table}`);
  }
  assert(dataSetsOf(db).length === 1, "one compiled data set exists");
  assert(linesOf(db).length > 0, "with lines under it");
});

test("tax-build-1099 emits no send row and calls no external URL", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  assertEqual(db.all("portal_requests").length, 0, "no portal request was raised");
  assertEqual(db.all("report_audit_events").length, 0, "and no delivery event was written");
  const code = codeOf(sourceOf("tax-build-1099.ts")).toLowerCase();
  for (const marker of OUTBOUND_MARKERS) {
    assert(!code.includes(marker.toLowerCase()), `the code contains no ${marker}`);
  }
  assert(!code.includes("node:http"), "and imports no transport module");
});

test("no tax or CPA run reaches outside this system", () => {
  for (const name of TAX_FILES) {
    const code = codeOf(sourceOf(name)).toLowerCase();
    for (const marker of OUTBOUND_MARKERS) {
      assert(!code.includes(marker.toLowerCase()), `${name} contains no ${marker}`);
    }
  }
});

test("the compiled data set states that it is a compilation and nothing more", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  const set = dataSetsOf(db)[0];
  assertEqual(set.compilationOnly, true, "the column says so, so the guarantee is data");
  assertEqual(set.state, "compiled", "the state is compiled and there is no other state");
  assertEqual(set.handoffStatement, COMPILATION_ONLY_BANNER, "and the row carries the banner");
  assert(
    set.handoffStatement.includes("does not file, issue, submit, or transmit"),
    "which says in words what the run does not do",
  );
});

test("w9-track raises a request and sends nothing", async () => {
  const db = taxDb();
  const { applied } = await applyTax(db, w9Track, taxScope());
  for (const proposal of applied.result?.proposals ?? []) {
    if (!("table" in proposal) || typeof proposal.table !== "string") continue;
    assert(
      !FORBIDDEN_TABLES.includes(proposal.table),
      `${proposal.table} is not a table a tracking run may write`,
    );
  }
  assertEqual(db.all("portal_requests").length, 0, "no portal request went out");
  const code = codeOf(sourceOf("w9-track.ts")).toLowerCase();
  for (const marker of OUTBOUND_MARKERS) {
    assert(!code.includes(marker.toLowerCase()), `w9-track.ts contains no ${marker}`);
  }
});

test("cpa-build-handoff issues nothing and files nothing", async () => {
  const db = archiveDb();
  const { preview, applied } = await applyDlv(db, cpaBuildHandoff, {
    clientId: CLIENT_A1,
    period: "2026-01-01",
    scopeKind: "period" as const,
  });
  for (const proposal of [
    ...(preview.result?.proposals ?? []),
    ...(applied.result?.proposals ?? []),
  ]) {
    assert(proposal.kind !== "journal_entry", "the archive posts nothing");
    if ("table" in proposal && typeof proposal.table === "string") {
      assertEqual(proposal.table, "cpa_handoffs", "and writes only the handoff row");
    }
  }
  for (const table of FORBIDDEN_TABLES) {
    assertEqual(db.all(table as never).length, 0, `nothing landed in ${table}`);
  }
  assertEqual(db.all("tax_data_sets").length, 0, "the handoff compiled no data set of its own");
});

test("the handoff is an archive attached to the vault and nothing else", async () => {
  const db = archiveDb();
  await applyDlv(db, cpaBuildHandoff, {
    clientId: CLIENT_A1,
    period: "2026-01-01",
    scopeKind: "period" as const,
  });
  const row = handoffsOf(db)[0];
  assert(row.vaultObjectKey.endsWith(".zip"), "the deliverable is a zip in the vault");
  assertEqual(row.vaultObjectLockMode, "GOVERNANCE", "under an object lock");
  assert(row.vaultObjectLockUntil > row.vaultRetentionStartsOn, "held for the retention window");
  assert(
    row.scopeStatement.includes("filed nothing, signed nothing"),
    "and the archive says in writing that the firm filed nothing",
  );
});

test("every tax and CPA file carries the compliance banner at the top", () => {
  const banner = flatten(COMPILATION_ONLY_BANNER);
  for (const name of TAX_FILES) {
    const flat = flatten(sourceOf(name));
    assert(flat.includes(banner), `${name} carries the banner text`);
    const head = flatten(sourceOf(name).slice(0, 1400));
    assert(head.includes(banner), `${name} carries it at the top of the file`);
  }
  assert(
    COMPILATION_ONLY_BANNER.startsWith("Ledger Legends is not a CPA firm."),
    "and the banner opens by saying what the firm is not",
  );
  assert(
    COMPILATION_ONLY_BANNER.includes("provided to the client's CPA for filing"),
    "and closes by saying who files",
  );
});

test("banned advice vocabulary is absent from tax and CPA prose", () => {
  for (const name of TAX_FILES) {
    const prose = proseOf(sourceOf(name));
    for (const phrase of BANNED_VOCABULARY) {
      assert(!usesPhrase(prose, phrase), `${name} prose does not use "${phrase}"`);
    }
  }
});

test("banned advice vocabulary is absent from the rows those runs write", async () => {
  const db = taxDb();
  await applyTax(db, taxBuild1099, taxScope());
  const archive = archiveDb();
  await applyDlv(archive, cpaBuildHandoff, {
    clientId: CLIENT_A1,
    period: "2026-01-01",
    scopeKind: "period" as const,
  });
  const text = JSON.stringify([
    dataSetsOf(db),
    linesOf(db),
    handoffsOf(archive),
  ], (_k, v) => (typeof v === "bigint" ? v.toString() : v)).toLowerCase();
  for (const phrase of BANNED_VOCABULARY) {
    assert(!usesPhrase(text, phrase), `no written row uses "${phrase}"`);
  }
  assert(text.includes("not a cpa firm"), "and the rows do carry the banner");
});

test("the word file appears only as a refusal in tax prose", () => {
  for (const name of TAX_FILES) {
    const prose = proseOf(sourceOf(name));
    assert(!usesPhrase(prose, "we file"), `${name} never says the firm files`);
    assert(!usesPhrase(prose, "filed for"), `${name} never says the firm filed for anyone`);
    assert(!usesPhrase(prose, "will transmit"), `${name} never promises a transmission`);
  }
});

test("no run in this task writes a ledger entry it was not asked to write", async () => {
  const db = taxDb();
  const before = db.all("journal_entries").length;
  await applyTax(db, taxBuild1099, taxScope());
  await applyTax(db, w9Track, taxScope());
  assertEqual(db.all("journal_entries").length, before, "the tax runs posted nothing");
  assertEqual(taxBuild1099.writesLedger, false, "and declare that they write no ledger");
  assertEqual(w9Track.writesLedger, false, "both of them");
  assertEqual(cpaBuildHandoff.writesLedger, false, "and so does the handoff");
  assertEqual(payApproveRun.writesLedger, false, "and so does the payroll approval");
});
