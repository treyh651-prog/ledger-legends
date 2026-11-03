/**
 * Shared loading and arithmetic for group consolidation.
 *
 * Deliberately not a widening of CloseData/ReportData (close-shared.ts,
 * rpt-shared.ts) to carry more than one client: GateDefinition.evaluate and
 * every one of the twenty close gates are hard typed to a single client's
 * CloseData, and touching that shape for one new feature would ripple
 * through code that has nothing to do with consolidation. Instead this file
 * loads one ReportData per member client, by calling loadReportData
 * (rpt-shared.ts) once per member and reusing it verbatim, and combines the
 * results with its own small set of cross-entity helpers.
 *
 * The elimination check (relatedPartyNetCents) is the group-level analogue
 * of a close gate -- docs/02-run-specifications.md and docs/00-conventions.md
 * both describe it as "G14," a gate number the actual gate code in
 * cls-evaluate-gates.ts has since reused for something unrelated (confirmed
 * by reading that file: the real G14 is a locked-period check). It is not
 * implemented as a CLOSE_GATES entry here, because a failing gate there
 * never blocks RPT-BUILD-PACKAGE itself -- data.gates only feeds a cosmetic
 * banner, and only CLS-LOCK-PERIOD treats a failure as a hard stop. Group
 * consolidation needs a hard stop at build time, not a banner, so the check
 * lives directly in RPT-BUILD-CONSOLIDATED-PACKAGE's own propose(). The
 * label G21 (cls-evaluate-gates.ts's own highest gate is G20) is kept only
 * for doc/audit continuity in that run's header comment.
 */

import type { Cents, Ulid } from "../contract";
import type { RunTx } from "../db";
import { canonicalJson, sha256Hex } from "../ids";
import type { ClientRow } from "../tables";
import { ZERO, balanceOf, cashBalancesBetween } from "./close-shared";
import { loadReportData, type ReportData } from "./rpt-shared";

/** The two accounts an intercompany balance can land on, every chart template. */
export const RELATED_PARTY_PAYABLE_ACCOUNT = "2900";
export const RELATED_PARTY_RECEIVABLE_ACCOUNT = "1420";

export interface ConsolidationData {
  groupId: Ulid;
  firmId: Ulid;
  periodStart: string;
  periodEnd: string;
  memberClients: ClientRow[];
  members: ReportData[];
}

/** Active (not removed), non-archived member clients, sorted by id. */
export async function loadGroupMembers(
  tx: RunTx,
  firmId: Ulid,
  groupId: Ulid,
): Promise<ClientRow[]> {
  const memberships = await tx.query("entity_group_members_for_group", { firmId, groupId });
  const clients: ClientRow[] = [];
  for (const m of memberships) {
    if (m.removedAt !== null) continue;
    const rows = await tx.query("client_by_id", { firmId, clientId: m.clientId });
    const client = rows[0];
    if (client !== undefined && client.archivedAt === null) clients.push(client);
  }
  return clients.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function loadConsolidationData(
  tx: RunTx,
  firmId: Ulid,
  groupId: Ulid,
  period: string,
): Promise<ConsolidationData> {
  const memberClients = await loadGroupMembers(tx, firmId, groupId);
  const members = await Promise.all(
    memberClients.map((c) => loadReportData(tx, firmId, c.id, period)),
  );
  const first = members[0];
  return {
    groupId,
    firmId,
    periodStart: first?.periodStart ?? period,
    periodEnd: first?.periodEnd ?? period,
    memberClients,
    members,
  };
}

/**
 * A member refuses construction when it is not ready to be combined: no
 * active members at all, or a member whose chart is empty (never onboarded
 * -- loadGroupMembers above already drops an archived client, so this is
 * the "exists but has no chart" case). A member with a real chart and zero
 * period activity is not missing, and is not checked here; it falls out of
 * the combined sections the same way a zero balance already does in every
 * single-entity section builder.
 */
export function checkMembersReady(
  memberClients: readonly ClientRow[],
  members: readonly ReportData[],
): string | null {
  if (memberClients.length === 0) {
    return "the group has no active member clients to combine";
  }
  const notOnboarded = members.filter((m) => m.close.chart.length === 0);
  if (notOnboarded.length > 0) {
    return `member client(s) ${notOnboarded.map((m) => m.clientId).join(", ")} have no chart of accounts yet`;
  }
  return null;
}

/**
 * A stated v1 simplification: members whose fiscal year end, inventory
 * method, or entity type differ refuse construction outright rather than
 * guess at a best-effort combination across incompatible books.
 */
export function checkMembersHomogeneous(memberClients: readonly ClientRow[]): string | null {
  if (memberClients.length <= 1) return null;
  const first = memberClients[0];
  const mismatched = memberClients.filter(
    (c) =>
      c.fiscalYearEndMonth !== first.fiscalYearEndMonth ||
      c.inventoryMethod !== first.inventoryMethod ||
      c.entityType !== first.entityType,
  );
  if (mismatched.length > 0) {
    return `member clients do not share the same fiscal year end, inventory method, and entity type (${first.id} differs from ${mismatched.map((c) => c.id).join(", ")})`;
  }
  return null;
}

/**
 * The entire elimination check's arithmetic. Every intercompany balance in
 * the group has a matching, opposite entry on another member's books only
 * when this sums to exactly zero: a payable-side 2900 balance (credit
 * normal) on one member's books and the matching receivable-side 1420
 * balance (debit normal) on another's cancel out in the debit-positive sign
 * convention this whole ledger uses.
 */
export function relatedPartyNetCents(members: readonly ReportData[]): Cents {
  let total = ZERO;
  for (const m of members) {
    total += balanceOf(m.close.through, RELATED_PARTY_PAYABLE_ACCOUNT);
    total += balanceOf(m.close.through, RELATED_PARTY_RECEIVABLE_ACCOUNT);
  }
  return total;
}

/** The union of every member's own chart account numbers, sorted. */
export function combinedAccountNumbers(members: readonly ReportData[]): string[] {
  const numbers = new Set<string>();
  for (const m of members) {
    for (const a of m.close.chart) numbers.add(a.accountNumber);
  }
  return [...numbers].sort();
}

export function combinedBalancesThrough(members: readonly ReportData[], accountNumber: string): Cents {
  let total = ZERO;
  for (const m of members) total += balanceOf(m.close.through, accountNumber);
  return total;
}

export function combinedPriorBalancesThrough(members: readonly ReportData[], accountNumber: string): Cents {
  let total = ZERO;
  for (const m of members) total += balanceOf(m.close.priorThrough, accountNumber);
  return total;
}

export function combinedInPeriod(members: readonly ReportData[], accountNumber: string): Cents {
  let total = ZERO;
  for (const m of members) total += balanceOf(m.close.inPeriod, accountNumber);
  return total;
}

export function combinedPriorInPeriod(members: readonly ReportData[], accountNumber: string): Cents {
  let total = ZERO;
  for (const m of members) total += balanceOf(m.priorInPeriod, accountNumber);
  return total;
}

/**
 * The combined ledger fingerprint of the whole group: every member's own
 * fingerprint (close-shared.ts's ledgerFingerprint), sorted by clientId so
 * the same member set always hashes the same way regardless of query
 * order. Folded into the scope hash the same way RPT-BUILD-PACKAGE folds
 * its own single fingerprint in -- a posting on any member makes a rebuild
 * a fresh scope rather than a stale dedupe hit.
 */
export function combinedFingerprintOf(members: readonly ReportData[]): string {
  const parts = members
    .map((m) => ({ clientId: m.clientId, fingerprint: m.fingerprint }))
    .sort((a, b) => (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0));
  return sha256Hex(canonicalJson(parts));
}

/**
 * Doc 05 Part 4 (D3), combined across the group. Each member's own
 * cash_effect-dated lines (close-shared.ts's cashBalancesBetween, which
 * already excludes accrual_only lines and re-attributes a payment-
 * application control line back to its own revenue/expense account) are
 * aggregated per member first, then summed across members for one account.
 */
export function combinedCashBetween(
  members: readonly ReportData[],
  from: string,
  to: string,
  accountNumber: string,
): Cents {
  let total = ZERO;
  for (const m of members) total += balanceOf(cashBalancesBetween(m.close.lines, from, to), accountNumber);
  return total;
}

/** The chart name of an account, from the first member whose own chart names it. */
export function accountNameAcross(members: readonly ReportData[], accountNumber: string): string {
  for (const m of members) {
    const row = m.close.chart.find((a) => a.accountNumber === accountNumber);
    if (row !== undefined) return row.name;
  }
  return accountNumber;
}
