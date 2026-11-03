/**
 * Fixtures for group consolidation. Two member clients in one firm, each
 * with a small chart that carries both elimination accounts (1420, 2900)
 * plus one cash, one equity, one revenue, and one expense account, so a
 * combined balance sheet and income statement both have something real to
 * show. No journal activity is seeded by default -- the intercompany story
 * is different per test, the same "left open on purpose" shape close-fixtures.ts
 * uses for its own base database.
 */

import { MemoryRunDb } from "../db-memory";
import type { ClientRow, EntityGroupMemberRow, EntityGroupRow } from "../tables";
import { CLIENT_A1, CLIENT_A2, FIRM_A, NOW, chartAccount } from "./fixtures";

export const CLIENT_A3 = "CLI-A3";

export const GROUP_ACCOUNTS: ReadonlyArray<readonly [string, string]> = [
  ["1010", "Operating"],
  ["1420", "Due from related parties"],
  ["2900", "Due to related parties"],
  ["3900", "Retained earnings"],
  ["4100", "Service revenue"],
  ["6100", "Office expense"],
];

export function clientRow(id: string, extra: Partial<ClientRow> = {}): ClientRow {
  return {
    id,
    firmId: FIRM_A,
    name: id,
    entityType: "for_profit",
    isNonprofit: false,
    fiscalYearEndMonth: 12,
    functionalCurrency: "USD",
    capitalizeOverCents: BigInt(250000),
    engagementScope: {},
    chartTemplateId: "TPL-SERVICE-STUDIO",
    inventoryMethod: "none",
    onboardedAt: NOW.toISOString(),
    archivedAt: null,
    ...extra,
  };
}

export function groupRow(id: string, extra: Partial<EntityGroupRow> = {}): EntityGroupRow {
  return {
    id,
    firmId: FIRM_A,
    name: "The Group",
    createdAt: NOW.toISOString(),
    archivedAt: null,
    ...extra,
  };
}

export function memberRow(
  id: string,
  groupId: string,
  clientId: string,
  extra: Partial<EntityGroupMemberRow> = {},
): EntityGroupMemberRow {
  return {
    id,
    groupId,
    firmId: FIRM_A,
    clientId,
    addedAt: NOW.toISOString(),
    removedAt: null,
    ...extra,
  };
}

/** Two member clients, each with the group chart, and no group yet. */
export function consolidationDb(clientIds: readonly string[] = [CLIENT_A1, CLIENT_A2]): MemoryRunDb {
  const db = new MemoryRunDb();
  db.seed("clients", clientIds.map((id) => clientRow(id)));
  const rows = [];
  for (const clientId of clientIds) {
    for (const [number, name] of GROUP_ACCOUNTS) {
      rows.push(chartAccount(`CH-${clientId}-${number}`, FIRM_A, clientId, number, name));
    }
  }
  db.seed("chart_accounts", rows);
  return db;
}

/** Seed a group over a set of member clients, all active. */
export function seedGroup(db: MemoryRunDb, groupId: string, clientIds: readonly string[]): void {
  db.seed("entity_groups", [groupRow(groupId)]);
  db.seed(
    "entity_group_members",
    clientIds.map((clientId) => memberRow(`${groupId}:${clientId}`, groupId, clientId)),
  );
}
