/**
 * PAY-POST-REGISTER tests.
 *
 * The run posts an approved register to the ledger, one entry per pay run per
 * period per client. The interesting parts are the prerequisite, the five line
 * shape, where net lands when the pay date and the period disagree, and the
 * refusal to post from anything other than a vault linked approved row.
 */

import { assert, assertEqual, test } from "./harness";
import { isFieldWrite, isRowInsert } from "../contract";
import {
  CLIENT_A1,
  EMPLOYER_TAX,
  GROSS,
  LATE_PAY_DATE,
  NET,
  PAY_DATE,
  PERIOD,
  PERIOD_END,
  PROVIDER,
  WITHHOLDING,
  applyDlv,
  approveScope,
  lockJanuary,
  payRun,
  payRunsOf,
  payrollDb,
  payrollDbMissing,
  postScope,
  previewDlv,
  registerEntriesOf,
  shapeOf,
} from "./dlv-fixtures";
import { payApproveRun, payRunIdOf } from "../runs/pay-approve-run";
import {
  entryIdOf,
  fundingAccountFor,
  payPostRegister,
  registerEntryIdOf,
} from "../runs/pay-post-register";

/** The base story: approve, then post. */
async function approved() {
  const db = payrollDb();
  await applyDlv(db, payApproveRun, approveScope());
  return db;
}

function linesOf(db: ReturnType<typeof payrollDb>, entryId: string | null) {
  return db
    .all("journal_lines")
    .filter((l) => l.entryId === entryId)
    .sort((a, b) => (a.accountNumber < b.accountNumber ? -1 : 1));
}

test("preview and apply propose the same rows", async () => {
  const db = await approved();
  const { preview, applied } = await applyDlv(db, payPostRegister, postScope());
  assertEqual(
    shapeOf(preview.result?.proposals ?? []),
    shapeOf(applied.result?.proposals ?? []),
    "the posting is the same on both passes",
  );
  assertEqual(registerEntriesOf(db).length, 1, "one register entry landed");
  assertEqual(payRunsOf(db)[0].status, "posted", "and the pay run moved to posted");
});

test("ids are derived, so a rerun is a no operation", async () => {
  const db = await approved();
  await applyDlv(db, payPostRegister, postScope());
  const again = await previewDlv(db, payPostRegister, postScope());
  assertEqual((again.result?.proposals ?? []).length, 0, "nothing posted twice");
  assert(
    (again.result?.skips ?? []).some((s) => s.detail.includes("already posted")),
    "the run says the register is already in the ledger",
  );
  assertEqual(registerEntriesOf(db).length, 1, "and there is still one entry");
});

test("the entry id is derived from the client, the pay run, and the period", async () => {
  const db = await approved();
  await applyDlv(db, payPostRegister, postScope());
  const runId = payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER);
  assertEqual(
    registerEntriesOf(db)[0].id,
    registerEntryIdOf(CLIENT_A1, runId, PERIOD),
    "the register row sits at its derived id",
  );
  assertEqual(
    registerEntriesOf(db)[0].entryId,
    entryIdOf(CLIENT_A1, runId, PERIOD),
    "and points at the derived entry id",
  );
});

test("two periods do not collide because the period is in the scope hash", async () => {
  const db = await approved();
  const a = await previewDlv(db, payPostRegister, postScope());
  const b = await previewDlv(db, payPostRegister, postScope({ period: "2026-02-01" }));
  assert(a.scopeHash !== b.scopeHash, "January and February are different scopes");
  const runId = payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER);
  assert(
    entryIdOf(CLIENT_A1, runId, PERIOD) !== entryIdOf(CLIENT_A1, runId, "2026-02-01"),
    "and the two periods would write different entries",
  );
});

test("an overridden pay run is never posted", async () => {
  const db = payrollDb();
  db.seed("pay_runs", [
    payRun(payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER), { manualOverride: true }),
  ]);
  const out = await previewDlv(db, payPostRegister, postScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was posted");
  assert(
    (out.result?.skips ?? []).some((s) => s.reason === "manual_override"),
    "the run reports the override",
  );
});

test("a locked pay date posts nothing", async () => {
  const db = payrollDb();
  db.seed("pay_runs", [payRun(payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER))]);
  lockJanuary(db);
  const out = await previewDlv(db, payPostRegister, postScope());
  assertEqual(registerEntriesOf(db).length, 0, "no register entry landed");
  const reasons = [
    ...(out.result?.skips ?? []).map((s) => s.reason),
    ...(out.result?.errors ?? []).map((e) => e.code),
  ];
  assert(
    reasons.includes("locked_period") || reasons.includes("noOpenPeriod"),
    "the run refused on the closed period rather than posting into it",
  );
});

test("without an approved pay run there is nothing to post", async () => {
  const db = payrollDb();
  const out = await previewDlv(db, payPostRegister, postScope());
  assertEqual((out.result?.proposals ?? []).length, 0, "nothing was posted");
  const skips = out.result?.skips ?? [];
  assertEqual(skips[0].reason, "missing_prerequisite", "the prerequisite is named");
  assert(
    skips[0].detail.includes("no approved pay run"),
    "and the detail says which prerequisite is missing",
  );
});

test("a pay run with no vault register key is refused rather than posted", async () => {
  const db = payrollDb();
  db.seed("pay_runs", [
    payRun(payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER), { registerVaultObjectKey: "" }),
  ]);
  const out = await previewDlv(db, payPostRegister, postScope());
  const errors = out.result?.errors ?? [];
  assertEqual(errors[0].code, "missingAccount", "the run refuses");
  assert(
    errors[0].message.includes("D5"),
    "and names the decision that forbids posting a keyed total",
  );
});

test("the entry is five lines that sum to zero", async () => {
  const db = await approved();
  await applyDlv(db, payPostRegister, postScope());
  const entryId = registerEntriesOf(db)[0].entryId;
  const lines = linesOf(db, entryId);
  assertEqual(lines.length, 5, "five lines");
  assertEqual(
    lines.reduce((sum, l) => sum + l.amountCents, BigInt(0)),
    BigInt(0),
    "and they sum to exactly zero cents",
  );
  assertEqual(registerEntriesOf(db)[0].lineCount, 5, "which the register row records");
});

test("each line lands on the account doc 01 Part 4 names for it", async () => {
  const db = await approved();
  await applyDlv(db, payPostRegister, postScope());
  const byAccount = new Map(
    linesOf(db, registerEntriesOf(db)[0].entryId).map((l) => [l.accountNumber, l.amountCents]),
  );
  assertEqual(byAccount.get("6300"), GROSS, "gross wages debit 6300");
  assertEqual(byAccount.get("6310"), EMPLOYER_TAX, "employer taxes debit 6310");
  assertEqual(byAccount.get("2310"), -EMPLOYER_TAX, "and credit the liability at 2310");
  assertEqual(byAccount.get("2320"), -WITHHOLDING, "withholdings credit 2320");
  assertEqual(byAccount.get("1010"), -NET, "and net credits the operating account");
});

test("a pay date outside the period funds through payroll clearing", async () => {
  const db = payrollDb();
  db.seed("pay_runs", [
    payRun(payRunIdOf(CLIENT_A1, LATE_PAY_DATE, PROVIDER), { payDate: LATE_PAY_DATE }),
  ]);
  await applyDlv(db, payPostRegister, postScope({ payDate: LATE_PAY_DATE }));
  const entry = registerEntriesOf(db)[0];
  assertEqual(entry.fundingAccount, "1930", "net waits in clearing");
  const byAccount = new Map(
    linesOf(db, entry.entryId).map((l) => [l.accountNumber, l.amountCents]),
  );
  assertEqual(byAccount.get("1930"), -NET, "and the credit lands there rather than at 1010");
  assertEqual(byAccount.get("1010"), undefined, "the operating account is untouched");
  assertEqual(
    fundingAccountFor(PAY_DATE, PERIOD, PERIOD_END),
    "1010",
    "a pay date inside the period funds from the bank",
  );
});

test("a chart missing a payroll account refuses the posting", async () => {
  const db = payrollDbMissing("2320");
  db.seed("pay_runs", [payRun(payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER))]);
  const out = await previewDlv(db, payPostRegister, postScope());
  const errors = out.result?.errors ?? [];
  assertEqual(errors[0].code, "missingAccount", "the run refuses");
  assert(errors[0].message.includes("2320"), "and names the account it cannot find");
  assertEqual(errors[0].retryable, false, "a retry would not help");
});

test("net is the residual, so the entry balances by construction", async () => {
  const db = payrollDb();
  // A pay run whose stored net disagrees with gross less withholding. The
  // posting derives net from the two figures it trusts rather than reading it.
  db.seed("pay_runs", [
    payRun(payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER), { netCents: BigInt(1) }),
  ]);
  await applyDlv(db, payPostRegister, postScope());
  const lines = linesOf(db, registerEntriesOf(db)[0].entryId);
  assertEqual(
    lines.reduce((sum, l) => sum + l.amountCents, BigInt(0)),
    BigInt(0),
    "the entry still balances",
  );
  const funding = lines.find((l) => l.accountNumber === "1010");
  assertEqual(funding?.amountCents, -NET, "and net is the residual, not the stored figure");
});

test("the pay run and the ledger name each other", async () => {
  const db = await approved();
  const out = await previewDlv(db, payPostRegister, postScope());
  const moves = (out.result?.proposals ?? []).filter(isFieldWrite);
  assertEqual(moves.length, 1, "one field move, onto the pay run");
  assertEqual(moves[0].after.status, "posted", "moving it to posted");
  await applyDlv(db, payPostRegister, postScope());
  const run = payRunsOf(db)[0];
  assertEqual(
    run.postedEntryId,
    registerEntriesOf(db)[0].entryId,
    "the run points at the entry",
  );
  assert(run.postedAt !== null, "and records when it was posted");
  assert(run.postedRunId !== null, "and which execution did it");
});

test("the entry is sourced from the pay run row, not from the caller", async () => {
  const db = await approved();
  const out = await previewDlv(db, payPostRegister, postScope());
  const entries = (out.result?.proposals ?? []).filter((p) => p.kind === "journal_entry");
  assertEqual(entries.length, 1, "one entry is proposed");
  const entry = entries[0];
  assert(entry.kind === "journal_entry", "and it is a journal entry");
  assertEqual(entry.sourceRef.table, "pay_runs", "sourced from the approved row");
  assertEqual(
    entry.sourceRef.rowId,
    payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER),
    "naming which one",
  );
  assertEqual(entry.entryDate, PAY_DATE, "and dated to the pay date");
});

test("the register row carries the figures and says who calculated them", async () => {
  const db = await approved();
  const out = await previewDlv(db, payPostRegister, postScope());
  const inserted = (out.result?.proposals ?? [])
    .filter(isRowInsert)
    .filter((p) => p.table === "pay_register_entries");
  assertEqual(inserted.length, 1, "one register row");
  const row = inserted[0].row;
  assertEqual(row.grossCents, GROSS, "carrying the gross");
  assertEqual(row.netCents, NET, "and the net");
  assert(
    String(row.detail).includes("calculated no payroll tax"),
    "and stating that this firm calculated nothing",
  );
  assert(
    String(row.detail).includes("vault object"),
    "and naming the object the figures came from",
  );
});

test("one register entry per pay run per period per client", async () => {
  const db = await approved();
  await applyDlv(db, payPostRegister, postScope());
  await applyDlv(db, payPostRegister, postScope());
  assertEqual(registerEntriesOf(db).length, 1, "a second attempt adds nothing");
  const runId = payRunIdOf(CLIENT_A1, PAY_DATE, PROVIDER);
  assertEqual(
    registerEntryIdOf(CLIENT_A1, runId, PERIOD),
    registerEntriesOf(db)[0].id,
    "because the id is the client, the run, and the period and nothing else",
  );
});
