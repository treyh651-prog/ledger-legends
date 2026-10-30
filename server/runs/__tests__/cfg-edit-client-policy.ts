/**
 * CFG-EDIT-CLIENT-POLICY tests. Creating the first row for a client that has
 * none, editing an existing row, the no-op when nothing named actually
 * differs, the version-1 backfill on an existing row's first edit, entity
 * kind requiring its matching equity account, an unknown account refused,
 * and undo reverting a field write but doing nothing to a first-time insert.
 */

import { assert, assertEqual, test } from "./harness";
import { MemoryRunDb } from "../db-memory";
import { execute } from "../execute";
import { executeUndo } from "../undo";
import { ACTOR, baseDb, CLIENT_A1, FIRM_A, NOW, chartAccount, opts } from "./fixtures";
import { clientPolicy } from "./coding-fixtures";
import {
  BACKFILL_CHANGE_NOTE,
  ERR_CLIENT_POLICY_EQUITY_REQUIRED,
  ERR_CLIENT_POLICY_UNKNOWN_ACCOUNT,
  cfgEditClientPolicy,
  type EditClientPolicyScope,
} from "../runs/cfg-edit-client-policy";
import type { ClientPolicyRow, ClientPolicyVersionRow } from "../tables";

function dbWithEquityAccounts(): MemoryRunDb {
  const db = baseDb();
  db.seed("chart_accounts", [
    chartAccount("CH-A1-3200", FIRM_A, CLIENT_A1, "3200", "Retained earnings"),
    chartAccount("CH-A1-3100", FIRM_A, CLIENT_A1, "3100", "Net assets without donor restrictions"),
    chartAccount("CH-A1-3300", FIRM_A, CLIENT_A1, "3300", "Net assets with donor restrictions"),
  ]);
  return db;
}

function scopeFor(fields: EditClientPolicyScope["fields"], changeNote = "set at onboarding"): EditClientPolicyScope {
  return { clientId: CLIENT_A1, changeNote, fields };
}

async function editAndApply(db: MemoryRunDb, scope: EditClientPolicyScope) {
  const preview = await execute(db, cfgEditClientPolicy, scope, opts("preview"));
  const applied = await execute(db, cfgEditClientPolicy, scope, opts("apply", { previewRunId: preview.executionId }));
  return { preview, applied };
}

function policyOf(db: MemoryRunDb): ClientPolicyRow | undefined {
  return (db.all("client_policies") as unknown as ClientPolicyRow[]).find((p) => p.clientId === CLIENT_A1);
}

function versionsOf(db: MemoryRunDb): ClientPolicyVersionRow[] {
  return (db.all("client_policy_versions") as unknown as ClientPolicyVersionRow[])
    .filter((v) => v.clientId === CLIENT_A1)
    .sort((a, b) => a.version - b.version);
}

test("cfg-edit-client-policy: the first edit for a client with no row creates one, filling defaults for everything not named", async () => {
  const db = dbWithEquityAccounts();
  const { applied } = await editAndApply(db, scopeFor({ functionalCurrency: "EUR" }));
  assertEqual(applied.status, "completed", "apply completed");
  const row = policyOf(db);
  assertEqual(row?.functionalCurrency, "EUR", "the named field");
  assertEqual(row?.capitalizeOverCents, BigInt(250000), "the column default, matching policyOf()'s own default");
  assertEqual(row?.entityKind, "for_profit", "the column default");
  assertEqual(row?.fiscalYearEndMonth, 12, "the column default");
  assertEqual(row?.version, 1, "a fresh row starts at version 1");
  assertEqual(versionsOf(db).length, 1, "one history row for the creation itself");
});

test("cfg-edit-client-policy: a nonprofit client can be created when its net assets account is named", async () => {
  const db = dbWithEquityAccounts();
  const { applied } = await editAndApply(
    db,
    scopeFor({ entityKind: "nonprofit", netAssetsWithoutRestrictionsAccount: "3100" }),
  );
  assertEqual(applied.status, "completed", "apply completed");
  const row = policyOf(db);
  assertEqual(row?.entityKind, "nonprofit", "the named entity kind");
  assertEqual(row?.netAssetsWithoutRestrictionsAccount, "3100", "the named account");
  assertEqual(row?.retainedEarningsAccount, null, "never required for a nonprofit");
});

test("cfg-edit-client-policy: naming for-profit with no retained earnings account is refused", async () => {
  const db = dbWithEquityAccounts();
  const preview = await execute(db, cfgEditClientPolicy, scopeFor({ entityKind: "for_profit" }), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_CLIENT_POLICY_EQUITY_REQUIRED), "named error code");
  assertEqual(policyOf(db), undefined, "nothing was created");
});

test("cfg-edit-client-policy: creating a row that touches nothing about entity kind or equity leaves the degraded default state alone", async () => {
  const db = dbWithEquityAccounts();
  const { applied } = await editAndApply(db, scopeFor({ functionalCurrency: "EUR" }));
  assertEqual(applied.status, "completed", "apply completed, not refused for equity it never touched");
  assertEqual(policyOf(db)?.retainedEarningsAccount, null, "same degraded state as having no row at all");
});

test("cfg-edit-client-policy: an unknown account number is refused before anything is written", async () => {
  const db = dbWithEquityAccounts();
  const preview = await execute(
    db,
    cfgEditClientPolicy,
    scopeFor({ entityKind: "for_profit", retainedEarningsAccount: "9999" }),
    opts("preview"),
  );
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_CLIENT_POLICY_UNKNOWN_ACCOUNT), "named error code");
  assertEqual(policyOf(db), undefined, "nothing was created");
});

test("cfg-edit-client-policy: creating then editing writes two versions, no backfill needed since creation already wrote its own version 1", async () => {
  const db = dbWithEquityAccounts();
  await editAndApply(db, scopeFor({ entityKind: "for_profit", retainedEarningsAccount: "3200" }));
  await editAndApply(db, scopeFor({ cleanupEngagement: true }, "cleanup project confirmed"));

  const versions = versionsOf(db);
  assertEqual(versions.length, 2, "version 1 at creation, version 2 the real edit");
  assertEqual(versions[0].version, 1, "created at version 1");
  assertEqual(versions[1].version, 2, "the real edit is version 2");
  assertEqual(versions[1].changeNote, "cleanup project confirmed", "the real edit carries the caller's note");

  const row = policyOf(db);
  assertEqual(row?.cleanupEngagement, true, "the real edit's value landed");
  assertEqual(row?.version, 2, "the version bumped again");
  assertEqual(row?.updatedAt, NOW.toISOString(), "updated_at bumped on the edit");
});

test("cfg-edit-client-policy: editing a pre-existing row this run never created backfills a version 1 snapshot of it", async () => {
  const db = dbWithEquityAccounts();
  db.seed("client_policies", [clientPolicy({ retainedEarningsAccount: "3200", version: 1, updatedAt: NOW.toISOString() })]);

  await editAndApply(db, scopeFor({ cleanupEngagement: true }, "cleanup project confirmed"));

  const versions = versionsOf(db);
  assertEqual(versions.length, 2, "the backfill plus the real edit's version 2");
  assertEqual(versions[0].version, 1, "the backfill is version 1");
  assertEqual(versions[0].changeNote, BACKFILL_CHANGE_NOTE, "the backfill names itself as a backfill");
  assertEqual(versions[1].version, 2, "the real edit is version 2");
});

test("cfg-edit-client-policy: naming values a row already has is a no op", async () => {
  const db = dbWithEquityAccounts();
  await editAndApply(db, scopeFor({ entityKind: "for_profit", retainedEarningsAccount: "3200" }));
  const preview = await execute(
    db,
    cfgEditClientPolicy,
    scopeFor({ entityKind: "for_profit", retainedEarningsAccount: "3200" }),
    opts("preview"),
  );
  assertEqual(preview.status, "no_op", "no_op");
  assert(preview.result.skips.some((s) => s.reason === "already_applied"), "reported as already applied");
});

test("cfg-edit-client-policy: switching an existing for-profit client to nonprofit without a net assets account is refused", async () => {
  const db = dbWithEquityAccounts();
  await editAndApply(db, scopeFor({ entityKind: "for_profit", retainedEarningsAccount: "3200" }));
  const preview = await execute(db, cfgEditClientPolicy, scopeFor({ entityKind: "nonprofit" }), opts("preview"));
  assertEqual(preview.status, "refused", "refused");
  assert(preview.result.errors.some((e) => e.code === ERR_CLIENT_POLICY_EQUITY_REQUIRED), "named error code");
  assertEqual(policyOf(db)?.entityKind, "for_profit", "the existing row was never touched");
});

test("cfg-edit-client-policy: undo reverts a field write on an existing row", async () => {
  const db = dbWithEquityAccounts();
  await editAndApply(db, scopeFor({ entityKind: "for_profit", retainedEarningsAccount: "3200" }));
  const { applied } = await editAndApply(db, scopeFor({ functionalCurrency: "EUR" }, "switched to euros"));

  const undone = await executeUndo(db, cfgEditClientPolicy, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "completed", "undo completed");
  const row = policyOf(db);
  assertEqual(row?.functionalCurrency, "USD", "reverted to the value before the edit");
  assertEqual(row?.version, 1, "the version reverted back too");
});

test("cfg-edit-client-policy: undo does nothing to a first-time row insert", async () => {
  const db = dbWithEquityAccounts();
  const { applied } = await editAndApply(db, scopeFor({ entityKind: "for_profit", retainedEarningsAccount: "3200" }));

  const undone = await executeUndo(db, cfgEditClientPolicy, applied.executionId, {
    mode: "apply",
    firmId: FIRM_A,
    clientId: CLIENT_A1,
    actor: { userId: ACTOR, kind: "human" },
    now: NOW,
    source: "button",
  });
  assertEqual(undone.status, "no_op", "nothing to revert, since undoPlan filters out the row inserts");
  assert(policyOf(db) !== undefined, "the row created by the insert is still there, inserts never revert");
});
