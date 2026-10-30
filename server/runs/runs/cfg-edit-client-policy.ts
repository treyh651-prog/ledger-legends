/**
 * CFG-EDIT-CLIENT-POLICY, version 1.
 *
 * A person at the firm sets or changes a client's policy overrides --
 * functional currency, the capitalize-over threshold, whether a sale is
 * gross at sale time, whether this is a cleanup engagement, the entity kind
 * and which account it closes equity into, and the fiscal year end month.
 * Manual tier: these are judgments a person makes on purpose, the same
 * reasoning CFG-EDIT-CATEGORY gives for its own fields.
 *
 * Most clients never need a row here at all: policyOf() and the inline
 * reads in the close module already treat "no row" as "every default
 * applies," and those defaults are the same literals INTAKE-CREATE-CLIENT
 * stamps onto the client/engagement rows at intake. So this run both
 * creates a row (when none exists yet) and edits one (when it does) rather
 * than being split into a separate create run wired into the intake
 * sequence: the equity accounts this run sets are chosen by a person after
 * the chart already exists, never during intake itself, so there is no
 * ordering dependency forcing a split.
 *
 * ledger.client_policy_versions has carried the history shape since
 * migration 0054 and nothing has ever written to it; this run is the first
 * writer, and an edit of an existing row backfills a version 1 snapshot of
 * the row as it stood before this edit, same as CFG-EDIT-CATEGORY.
 *
 * Entity kind and its equity account are checked more strictly than the
 * live doc_lock_window-style DB constraint (client_policy_equity_present),
 * which only requires the matching account when entity_kind is set and
 * tolerates both equity fields staying null regardless. Leaving that gap
 * open here would silently reproduce the "close has nowhere to post"
 * state CLOSE-POST-YEAREND already tolerates for a policy-less client, so
 * this run refuses instead of allowing it once entity kind is actually
 * being named. The named account is also checked against this client's own
 * chart: a typo in an account number is a judgment a person makes once and
 * posts against for every year-end to come, a higher stake than a
 * category's posting account, which is why this run checks it and
 * CFG-EDIT-CATEGORY does not.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedRowInsert,
  type Run,
  type RunError,
  type RunResult,
} from "../contract";
import {
  ACTOR_PLACEHOLDER,
  NOW_PLACEHOLDER,
  applyProposals,
  requireTx,
} from "../apply-writer";
import { DEFAULT_CAPITALIZE_OVER_CENTS, FUNCTIONAL_CURRENCY } from "./coding-cascade";
import { canonicalJson, derivedId, scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";
import type { ClientPolicyRow } from "../tables";

export const editableClientPolicyFieldsSchema = z.object({
  functionalCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  capitalizeOverCents: z.bigint().nonnegative().nullable().optional(),
  grossAtSaleTime: z.boolean().optional(),
  cleanupEngagement: z.boolean().optional(),
  entityKind: z.enum(["for_profit", "nonprofit"]).optional(),
  retainedEarningsAccount: z.string().regex(/^[0-9]{4}$/).nullable().optional(),
  netAssetsWithoutRestrictionsAccount: z.string().regex(/^[0-9]{4}$/).nullable().optional(),
  netAssetsWithRestrictionsAccount: z.string().regex(/^[0-9]{4}$/).nullable().optional(),
  fiscalYearEndMonth: z.number().int().min(1).max(12).optional(),
});

export const editClientPolicyScopeSchema = z.object({
  clientId: z.string().min(1),
  changeNote: z.string().min(1),
  fields: editableClientPolicyFieldsSchema,
});

export type EditClientPolicyScope = z.infer<typeof editClientPolicyScopeSchema>;

export const ERR_CLIENT_POLICY_EQUITY_REQUIRED = "CFG-CLIENT-POLICY-EQUITY-REQUIRED";
export const ERR_CLIENT_POLICY_UNKNOWN_ACCOUNT = "CFG-CLIENT-POLICY-UNKNOWN-ACCOUNT";

/** Backfilled history carries this note, so it reads as what it is, not a real edit. */
export const BACKFILL_CHANGE_NOTE = "initial version, backfilled on first edit";

const DEFAULT_ENTITY_KIND = "for_profit" as const;
const DEFAULT_FISCAL_YEAR_END_MONTH = 12;

const EQUITY_ACCOUNT_FIELDS = [
  "retainedEarningsAccount",
  "netAssetsWithoutRestrictionsAccount",
  "netAssetsWithRestrictionsAccount",
] as const;

function changedFields(
  current: ClientPolicyRow,
  fields: z.infer<typeof editableClientPolicyFieldsSchema>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const key = k as keyof ClientPolicyRow;
    if (current[key] !== v) {
      before[key] = current[key];
      after[key] = v;
    }
  }
  return { before, after };
}

/** Named field wins; otherwise the existing row's value; otherwise null (no row at all yet). */
function mergedEntityKind(
  fields: EditClientPolicyScope["fields"],
  existing: ClientPolicyRow | undefined,
): "for_profit" | "nonprofit" {
  return fields.entityKind ?? existing?.entityKind ?? DEFAULT_ENTITY_KIND;
}

function mergedAccount(
  fields: EditClientPolicyScope["fields"],
  existing: ClientPolicyRow | undefined,
  key: (typeof EQUITY_ACCOUNT_FIELDS)[number],
): string | null {
  if (fields[key] !== undefined) return fields[key];
  return existing?.[key] ?? null;
}

export const cfgEditClientPolicy: Run<EditClientPolicyScope, Proposal> = {
  type: "CFG-EDIT-CLIENT-POLICY",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:client-policy`,
  scopeSchema: editClientPolicyScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<EditClientPolicyScope>> {
    const tx = requireTx(ctx);
    const rows = await tx.query("client_policy", { firmId: ctx.firmId, clientId: scope.clientId });
    const policy = rows[0] ?? null;
    const candidateIds = [scope.clientId];
    const versions = [{ id: "CFG-EDIT-CLIENT-POLICY", version: 1 }];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: today,
      periodEnd: today,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [policy ? String(policy.version) : "missing", canonicalJson(scope.fields)].join("/"),
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];

    const rows = await tx.query("client_policy", { firmId: ctx.firmId, clientId: scope.clientId });
    const existing: ClientPolicyRow | undefined = rows[0];

    const chart = await tx.query("chart_accounts_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const knownNumbers = new Set(chart.map((a) => a.accountNumber));
    for (const field of EQUITY_ACCOUNT_FIELDS) {
      const number = scope.fields[field];
      if (number && !knownNumbers.has(number)) {
        errors.push({
          rowId: scope.clientId,
          code: ERR_CLIENT_POLICY_UNKNOWN_ACCOUNT,
          message: `account ${number} is not on client ${scope.clientId}'s chart`,
          retryable: false,
        });
      }
    }

    const entityKind = mergedEntityKind(scope.fields, existing);
    const retainedEarningsAccount = mergedAccount(scope.fields, existing, "retainedEarningsAccount");
    const netAssetsWithoutRestrictionsAccount = mergedAccount(
      scope.fields,
      existing,
      "netAssetsWithoutRestrictionsAccount",
    );
    // A brand new row that never names entity kind or an equity account
    // defaults to for_profit with no retained earnings account on file --
    // exactly the same degraded state CLOSE-POST-YEAREND already tolerates
    // for a client with no policy row at all, so an edit that only touches
    // something else (currency, the capitalize threshold) is not blocked by
    // equity setup it never asked to change. The check applies once a row
    // already exists (entity kind is then a real, previously-set fact) or
    // once this edit actually names entity kind or an equity account.
    const entityOrEquityInPlay =
      existing !== undefined ||
      scope.fields.entityKind !== undefined ||
      scope.fields.retainedEarningsAccount !== undefined ||
      scope.fields.netAssetsWithoutRestrictionsAccount !== undefined;
    if (entityOrEquityInPlay && entityKind === "for_profit" && retainedEarningsAccount === null) {
      errors.push({
        rowId: scope.clientId,
        code: ERR_CLIENT_POLICY_EQUITY_REQUIRED,
        message: "a for-profit client needs a retained earnings account before this can be saved",
        retryable: false,
      });
    }
    if (entityOrEquityInPlay && entityKind === "nonprofit" && netAssetsWithoutRestrictionsAccount === null) {
      errors.push({
        rowId: scope.clientId,
        code: ERR_CLIENT_POLICY_EQUITY_REQUIRED,
        message: "a nonprofit client needs a net assets without donor restrictions account before this can be saved",
        retryable: false,
      });
    }
    if (errors.length > 0) return makeResult<Proposal>(1, [], [], errors, BigInt(0));

    const proposals: Proposal[] = [];

    if (!existing) {
      const row: ClientPolicyRow = {
        id: derivedId(scope.clientId, "cfg-edit-client-policy", 0),
        firmId: ctx.firmId,
        clientId: scope.clientId,
        functionalCurrency: scope.fields.functionalCurrency ?? FUNCTIONAL_CURRENCY,
        capitalizeOverCents:
          scope.fields.capitalizeOverCents !== undefined
            ? scope.fields.capitalizeOverCents
            : DEFAULT_CAPITALIZE_OVER_CENTS,
        grossAtSaleTime: scope.fields.grossAtSaleTime ?? false,
        cleanupEngagement: scope.fields.cleanupEngagement ?? false,
        entityKind,
        retainedEarningsAccount,
        netAssetsWithoutRestrictionsAccount,
        netAssetsWithRestrictionsAccount: mergedAccount(scope.fields, existing, "netAssetsWithRestrictionsAccount"),
        fiscalYearEndMonth: scope.fields.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END_MONTH,
        version: 1,
        updatedAt: NOW_PLACEHOLDER,
      };
      proposals.push({
        kind: "row_insert",
        table: "client_policies",
        rowId: row.id,
        row: row as unknown as Record<string, unknown>,
        provenance: { cascadeLevel: null },
      });
      proposals.push({
        kind: "row_insert",
        table: "client_policy_versions",
        rowId: `${scope.clientId}:1`,
        row: {
          clientId: scope.clientId,
          version: 1,
          firmId: ctx.firmId,
          snapshot: row,
          validFrom: NOW_PLACEHOLDER,
          validTo: null,
          changedBy: ACTOR_PLACEHOLDER,
          changeNote: scope.changeNote,
        },
        provenance: { cascadeLevel: null },
      });
      return makeResult<Proposal>(1, proposals, [], [], BigInt(0));
    }

    const { before, after } = changedFields(existing, scope.fields);
    if (Object.keys(after).length === 0) {
      return makeResult<Proposal>(
        1,
        [],
        [{ rowId: existing.id, reason: "already_applied", detail: "every named field already has this value" }],
        [],
        BigInt(0),
      );
    }

    const newVersion = existing.version + 1;

    const existingVersions = await tx.query("client_policy_versions_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    if (existingVersions.length === 0) {
      proposals.push({
        kind: "row_insert",
        table: "client_policy_versions",
        rowId: `${scope.clientId}:${existing.version}`,
        row: {
          clientId: scope.clientId,
          version: existing.version,
          firmId: ctx.firmId,
          snapshot: existing,
          validFrom: NOW_PLACEHOLDER,
          validTo: null,
          changedBy: ACTOR_PLACEHOLDER,
          changeNote: BACKFILL_CHANGE_NOTE,
        },
        provenance: { cascadeLevel: null },
      });
    }

    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "client_policies",
      rowId: existing.id,
      before: { ...before, version: existing.version, updatedAt: existing.updatedAt },
      after: { ...after, version: newVersion, updatedAt: NOW_PLACEHOLDER },
      provenance: { cascadeLevel: null },
    };
    proposals.push(write);

    proposals.push({
      kind: "row_insert",
      table: "client_policy_versions",
      rowId: `${scope.clientId}:${newVersion}`,
      row: {
        clientId: scope.clientId,
        version: newVersion,
        firmId: ctx.firmId,
        snapshot: { ...existing, ...after, version: newVersion },
        validFrom: NOW_PLACEHOLDER,
        validTo: null,
        changedBy: ACTOR_PLACEHOLDER,
        changeNote: scope.changeNote,
      },
      provenance: { cascadeLevel: null },
    });

    return makeResult<Proposal>(1, proposals, [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "CFG-EDIT-CLIENT-POLICY", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    // Same reasoning as CFG-EDIT-CATEGORY: a field write on the live row
    // reverts; a first-time row insert (there was no policy row before this
    // edit) has nothing to undo, since inserts never revert in this system.
    return proposals.filter((p) => p.kind === "field_write").map(revertFieldWrite);
  },
};
