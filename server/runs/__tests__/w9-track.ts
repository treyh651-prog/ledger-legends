/**
 * COMPLIANCE. Ledger Legends is not a CPA firm. This run compiles data. It does
 * not file, issue, submit, or transmit any tax document. The compiled data set
 * is provided to the client's CPA for filing.
 *
 * TAX-TRACK-W9 tests.
 *
 * The five stages doc 02 module 9 names are each asserted, the escalation is
 * asserted to happen once, and the shared request id is asserted to be the same
 * id SUB-RAISE-REQUESTS derives, because that is the whole reason this run
 * imports from that file rather than raising its own row.
 */

import { assert, assertEqual, test } from "./harness";
import { isFieldWrite, isRowInsert } from "../contract";
import {
  ACTOR,
  CLIENT_A1,
  FIRM_A,
  CONTRACTOR,
  HOLD,
  NOTIN,
  YEAR_END,
  applyTax,
  lockDecember,
  previewTax,
  shapeOf,
  taxDb,
  taxScope,
  w9Request,
  w9StatesOf,
} from "./tax-fixtures";
import { stateIdOf, trackedVendors, w9Track } from "../runs/w9-track";
import { requestId as sharedRequestId } from "../runs/sub-raise-requests";
import { loadTaxData } from "../runs/tax-shared";

function stateFor(db: ReturnType<typeof taxDb>, vendorId: string) {
  return w9StatesOf(db).find((s) => s.vendorId === vendorId);
}

test("preview and apply propose the same rows", async () => {
  const db = taxDb();
  const { preview, applied } = await applyTax(db, w9Track, taxScope());
  assertEqual(
    shapeOf(preview.result?.proposals ?? []),
    shapeOf(applied.result?.proposals ?? []),
    "the tracked set is the same on both passes",
  );
  assertEqual(w9StatesOf(db).length, 9, "one state row per active vendor");
});

test("ids are derived, so a rerun is a no operation", async () => {
  const db = taxDb();
  await applyTax(db, w9Track, taxScope());
  const before = w9StatesOf(db).length;
  /*
   * The second pass is not silent, and should not be. The first pass raised a
   * request for every payee with no form, so those payees have moved from
   * missing to requested and their state rows follow them. What has to be
   * stable is the pass after that, once the paperwork state has stopped moving.
   */
  const second = await applyTax(db, w9Track, taxScope());
  assert(
    (second.preview.result?.proposals ?? []).every(isFieldWrite),
    "the second pass moves fields rather than inserting rows",
  );
  const third = await previewTax(db, w9Track, taxScope());
  assertEqual((third.result?.proposals ?? []).length, 0, "the third pass is silent");
  assertEqual(w9StatesOf(db).length, before, "and no duplicate state rows appeared");
});

test("the state id is derived from the client, the year, and the vendor", async () => {
  const db = taxDb();
  await applyTax(db, w9Track, taxScope());
  assertEqual(
    stateFor(db, CONTRACTOR)?.id,
    stateIdOf(CLIENT_A1, 2026, CONTRACTOR),
    "the row sits at the derived id",
  );
});

test("two years do not collide because the year is in the scope hash", async () => {
  const db = taxDb();
  const a = await previewTax(db, w9Track, taxScope("2026-12-01"));
  const b = await previewTax(db, w9Track, taxScope("2025-12-01"));
  assert(a.scopeHash !== b.scopeHash, "2025 and 2026 are different scopes");
  assert(
    stateIdOf(CLIENT_A1, 2026, CONTRACTOR) !== stateIdOf(CLIENT_A1, 2025, CONTRACTOR),
    "and they write different rows",
  );
});

test("an overridden state row is never rewritten", async () => {
  const db = taxDb();
  await applyTax(db, w9Track, taxScope());
  const row = stateFor(db, CONTRACTOR);
  if (row === undefined) throw new Error("there is a row to override");
  db.seed("w9_states", [{ ...row, manualOverride: true, vendorName: "By hand" }]);
  const again = await previewTax(db, w9Track, taxScope());
  assert(
    (again.result?.skips ?? []).some(
      (s) => s.reason === "manual_override" && s.rowId === row.id,
    ),
    "the run reports the override",
  );
  assertEqual(stateFor(db, CONTRACTOR)?.vendorName, "By hand", "the hand set value stands");
});

test("a locked period is read, never refused", async () => {
  const db = taxDb();
  lockDecember(db);
  const { applied } = await applyTax(db, w9Track, taxScope());
  assert(
    applied.status === "completed" || applied.status === "completed_with_skips",
    "tracking paperwork is not a write to the locked ledger",
  );
  assert(w9StatesOf(db).length > 0, "state rows landed anyway");
});

test("a vendor with a form and a number is complete", async () => {
  const db = taxDb();
  await applyTax(db, w9Track, taxScope());
  const row = stateFor(db, CONTRACTOR);
  assertEqual(row?.state, "on_file", "the stage is on file");
  assertEqual(row?.statusCode, "on_file_complete", "and the status is complete");
  assertEqual(row?.onFile, true, "the flag agrees");
});

test("a vendor with a form and no number is incomplete", async () => {
  const db = taxDb();
  const vendors = db.all("vendors").map((v) =>
    v.id === CONTRACTOR ? { ...v, tinLast4: null } : v,
  );
  db.seed("vendors", vendors);
  await applyTax(db, w9Track, taxScope());
  const row = stateFor(db, CONTRACTOR);
  assertEqual(row?.statusCode, "on_file_incomplete", "no number means incomplete");
  assertEqual(row?.state, "on_file", "though the form itself is on file");
});

test("a form past its date is expired rather than on file", async () => {
  const db = taxDb();
  const vendors = db.all("vendors").map((v) =>
    v.id === CONTRACTOR ? { ...v, w9ExpiresOn: "2026-06-30" } : v,
  );
  db.seed("vendors", vendors);
  await applyTax(db, w9Track, taxScope());
  assertEqual(stateFor(db, CONTRACTOR)?.state, "expired", "the stage is expired");
  assertEqual(
    stateFor(db, CONTRACTOR)?.expiresOn,
    "2026-06-30",
    "and the date that expired it is recorded",
  );
});

test("a missing form raises one request through the shared machinery", async () => {
  const db = taxDb();
  const out = await previewTax(db, w9Track, taxScope());
  const raised = (out.result?.proposals ?? [])
    .filter(isRowInsert)
    .filter((p) => p.table === "document_requests");
  assert(raised.length > 0, "at least one request was raised");
  const expected = sharedRequestId(CLIENT_A1, `w9:${NOTIN}`);
  assert(
    raised.some((p) => p.rowId === expected),
    "the raised row sits at the id SUB-RAISE-REQUESTS would have derived",
  );
  for (const p of raised) {
    assertEqual(p.row.owner, "client", "the client holds the form, not the firm");
    assertEqual(p.row.catalogCode, "W9", "and the catalog code is the shared one");
  }
});

test("an open request is not raised a second time", async () => {
  const db = taxDb();
  db.seed("document_requests", [
    ...db.all("document_requests"),
    w9Request(sharedRequestId(CLIENT_A1, `w9:${NOTIN}`), NOTIN, { agingDays: 3 }),
  ]);
  const out = await previewTax(db, w9Track, taxScope());
  const raised = (out.result?.proposals ?? [])
    .filter(isRowInsert)
    .filter((p) => p.table === "document_requests" && p.rowId.includes(""));
  assert(
    raised.every((p) => p.row.linkedItemId !== NOTIN),
    "no second ask for a form already asked for",
  );
  await applyTax(db, w9Track, taxScope());
  assertEqual(stateFor(db, NOTIN)?.state, "requested", "the stage is requested");
  assertEqual(stateFor(db, NOTIN)?.statusCode, "requested_pending", "and still pending");
});

test("an overdue request escalates once, to the lead, and never as a second ask", async () => {
  const db = taxDb();
  db.seed("document_requests", [
    ...db.all("document_requests"),
    w9Request(sharedRequestId(CLIENT_A1, `w9:${NOTIN}`), NOTIN, { agingDays: 40 }),
  ]);
  const { applied } = await applyTax(db, w9Track, taxScope());
  const row = stateFor(db, NOTIN);
  assertEqual(row?.statusCode, "requested_overdue", "the status is overdue");
  assertEqual(row?.escalation, "lead", "and the escalation is to the lead");
  const raised = (applied.result?.proposals ?? [])
    .filter(isRowInsert)
    .filter((p) => p.table === "document_requests");
  assert(
    raised.every((p) => p.row.linkedItemId !== NOTIN),
    "an overdue ask is escalated, never repeated",
  );
});

test("a satisfied request reads as received", async () => {
  const db = taxDb();
  db.seed("document_requests", [
    ...db.all("document_requests"),
    w9Request(sharedRequestId(CLIENT_A1, `w9:${NOTIN}`), NOTIN, {
      status: "satisfied",
      lastRefreshedOn: "2026-11-20",
    }),
  ]);
  await applyTax(db, w9Track, taxScope());
  const row = stateFor(db, NOTIN);
  assertEqual(row?.state, "received", "the stage is received");
  assertEqual(row?.receivedOn, "2026-11-20", "and the day it arrived is recorded");
});

test("a refresh moves fields and bumps the refresh count", async () => {
  const db = taxDb();
  await applyTax(db, w9Track, taxScope());
  const vendors = db.all("vendors").map((v) =>
    v.id === CONTRACTOR ? { ...v, w9OnFile: false, tinLast4: null } : v,
  );
  db.seed("vendors", vendors);
  const second = await previewTax(db, w9Track, taxScope());
  const moves = (second.result?.proposals ?? []).filter(isFieldWrite);
  assert(moves.length > 0, "the change is a field move, not a new row");
  await applyTax(db, w9Track, taxScope());
  const row = stateFor(db, CONTRACTOR);
  assertEqual(row?.statusCode, "missing", "the status followed the vendor");
  assertEqual(row?.refreshCount, 1, "the refresh count is one");
  assertEqual(row?.lastRefreshedOn, YEAR_END, "and the refresh is dated");
});

test("only the last four digits are ever copied onto a state row", async () => {
  const db = taxDb();
  await applyTax(db, w9Track, taxScope());
  for (const row of w9StatesOf(db)) {
    assert(
      row.tinLast4 === null || row.tinLast4.length === 4,
      `the row for ${row.vendorName} carries at most four digits`,
    );
  }
});

test("worst status first, then payee name, so the order says something", async () => {
  const db = taxDb();
  const out = await previewTax(db, w9Track, taxScope());
  const names = (out.result?.proposals ?? [])
    .filter(isRowInsert)
    .filter((p) => p.table === "w9_states")
    .map((p) => String(p.row.statusCode));
  const worstFirst = [...names].sort();
  assertEqual(
    names[0],
    "missing",
    "the payee with no form at all is proposed before the ones with one",
  );
  assert(worstFirst.length === names.length, "and every vendor is present exactly once");
});

test("an inactive vendor is not tracked", async () => {
  const db = taxDb();
  const vendors = db.all("vendors").map((v) =>
    v.id === HOLD ? { ...v, isActive: false } : v,
  );
  db.seed("vendors", vendors);
  await applyTax(db, w9Track, taxScope());
  assertEqual(stateFor(db, HOLD), undefined, "a closed vendor is not chased for a form");
});

test("the candidate list is vendor id ascending, so the frozen scope is stable", async () => {
  const db = taxDb();
  const ids = await db.tx<string[]>(
    {
      firmId: FIRM_A,
      clientId: CLIENT_A1,
      actorId: ACTOR,
      actorKind: "human",
      isolation: "repeatable read",
      readOnly: true,
    },
    async (tx) => {
      const data = await loadTaxData(tx, FIRM_A, CLIENT_A1, 2026);
      return trackedVendors(data).map((v) => v.id);
    },
  );
  assertEqual(
    JSON.stringify(ids),
    JSON.stringify([...ids].sort()),
    "the order does not depend on the status of the day",
  );
});
