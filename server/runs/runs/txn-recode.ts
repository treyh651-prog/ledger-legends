/**
 * TXN-RECODE. Fix a transaction's category -- reverse whatever it already
 * posted and repost it under the right one. Manual tier, same reasoning as
 * TXN-VOID: a correction a person decides on and names a reason for.
 *
 * General purpose, not tied to the rule review queue: this run refuses
 * nothing about *why* a transaction is being recoded. The review queue's
 * reject action is one caller -- rejecting a rule's coding is bundled with
 * fixing it, not a dead-end flag -- but any already-coded, not-yet-manually-
 * overridden transaction can be recoded through it.
 *
 * ledger.transactions.manual_override/manual_override_by/manual_override_at
 * have carried the shape since migration 0011 and nothing has ever written
 * them (transactions.tsx already renders " (manual)" next to a category for
 * a flag nothing sets). LEVEL.manualOverride = 0 (coding-cascade.ts) is
 * already the reserved, unused bottom of the ten level cascade -- migration
 * 0011's own txn_level_0_is_manual constraint requires manual_override
 * whenever cascade_level is 0, which this run's field write satisfies in
 * the same write. Once set, migration 0003's guard_manual_override trigger
 * freezes the row against every other run forever, so this run refuses up
 * front rather than letting the database reject it mid-apply.
 *
 * Reversal mechanics mirror TXN-VOID exactly (reversalOfPostedEntry, now
 * parameterized by target id so both runs can derive their own), because
 * fixing a miscoded transaction and voiding one both mean "reverse what was
 * actually posted, read back from its own stored lines."
 *
 * Posts the corrected entry itself, in the same apply, rather than nulling
 * journal_entry_id and waiting for TXN-POST-CODED's next run to pick it up
 * the way TXN-VOID-AND-REISSUE's reissued row does: migration 0011's own
 * comment says a manual_override row is "invisible to every run except as
 * a skip," and TXN-POST-CODED's own candidate query passes
 * includeOverridden: false, so a row this run marks manually overridden
 * would otherwise never get posted again by anything. Reuses postEntry
 * from txn-post-coded.ts -- the same two line shape, a different entry id
 * (recodePostedEntryIdFor, not postedEntryIdFor, since the original
 * posting's id is still in use by the entry this run just reversed).
 *
 * Bulk-capable like TXN-ACCEPT-CODING (one categoryId applied to several
 * transactionIds), because a rule being wrong in one specific way across
 * several transactions is a real case -- but each transaction's reversal is
 * dated independently (applyReversalDating runs per transaction, not once
 * over the whole plan), so one transaction with no open period to redate
 * into skips just that one rather than refusing the whole batch. Doc 03's
 * "apply is refused when any error exists" rule means `errors` is reserved
 * for a problem with the request itself (the target category does not
 * exist, or is inactive) -- never for one bad transaction in a bulk call,
 * which is always a skip instead.
 *
 * rejectedCount is tallied the same way TXN-ACCEPT-CODING tallies
 * acceptedCount, and demotes a promoted rule automatically the moment a
 * reject breaks its clean record -- the dead autoPostAllowed gate
 * (txn-apply-rules.ts) already re-checks rejectedCount === 0 on every call
 * regardless, so this is for the Rules screen to stay honest, not because
 * the gate needs it.
 */

import { z } from "zod";
import {
  makeResult,
  isJournalEntry,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
} from "../contract";
import { ACTOR_PLACEHOLDER, NOW_PLACEHOLDER, applyProposals, requireTx } from "../apply-writer";
import { applyReversalDating, reverseEntry, revertFieldWrite } from "../undo";
import { derivedId, scopeHashFor, canonicalJson } from "../ids";
import { reversalOfPostedEntry } from "./txn-void";
import { postEntry } from "./txn-post-coded";
import { LEVEL, categoryChecks, policyOf } from "./coding-cascade";
import type { BankAccountRow, RuleRow, TransactionRow } from "../tables";

export const recodeScopeSchema = z.object({
  clientId: z.string().min(1),
  transactionIds: z.array(z.string().min(1)).min(1),
  categoryId: z.string().min(1),
  reason: z.string().min(1),
});

export type RecodeScope = z.infer<typeof recodeScopeSchema>;

export function recodeReversalEntryIdFor(transactionId: string): string {
  return derivedId(transactionId, "txn-recode", 0);
}

export function recodePostedEntryIdFor(transactionId: string): string {
  return derivedId(transactionId, "txn-recode-post", 0);
}

interface RuleTally {
  rejectedCount: number;
  autoPostEnabled: boolean;
}

export const txnRecode: Run<RecodeScope, Proposal> = {
  type: "TXN-RECODE",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:txn-recode`,
  scopeSchema: recodeScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<RecodeScope>> {
    const tx = requireTx(ctx);
    const transactions = await tx.query("transactions_by_ids", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
      ids: scope.transactionIds,
    });
    const dates = transactions.map((t) => t.postedDate).sort();
    const today = ctx.now.toISOString().slice(0, 10);
    const candidateIds = [...scope.transactionIds];
    const versions = [
      { id: "TXN-RECODE", version: 1 },
      ...transactions.map((t) => ({ id: t.id, version: t.version })),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: dates[0] ?? today,
      periodEnd: dates[dates.length - 1] ?? today,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: canonicalJson({ categoryId: scope.categoryId, reason: scope.reason }),
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const proposals: Proposal[] = [];
    const skips: Skip[] = [];
    const errors: RunError[] = [];
    const refuse = (code: string, message: string): RunResult<Proposal> => {
      errors.push({ rowId: scope.categoryId, code, message, retryable: false });
      return makeResult<Proposal>(frozen.candidateIds.length, [], [], errors, BigInt(0));
    };

    const categoryRows = await tx.query("category_by_id", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      categoryId: scope.categoryId,
    });
    const category = categoryRows[0] ?? null;
    if (!category) {
      return refuse("TXN_RECODE_UNKNOWN_CATEGORY", `category ${scope.categoryId} does not belong to client ${frozen.clientId}`);
    }
    if (!category.isActive) {
      return refuse("TXN_RECODE_INACTIVE_CATEGORY", `category ${scope.categoryId} is not active`);
    }

    const policy = policyOf(
      await tx.query("client_policy", { firmId: frozen.firmId, clientId: frozen.clientId }),
    );
    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const transactions = await tx.query("transactions_by_ids", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      ids: scope.transactionIds,
    });
    const byId = new Map<string, TransactionRow>(transactions.map((t) => [t.id, t]));
    const bankAccounts = await tx.query("bank_accounts_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const accountById = new Map<string, BankAccountRow>(bankAccounts.map((a) => [a.id, a]));

    const entryIds = transactions.map((t) => t.journalEntryId).filter((id): id is string => id !== null);
    const entries =
      entryIds.length === 0
        ? []
        : await tx.query("journal_entries_for_client", { firmId: frozen.firmId, clientId: frozen.clientId });
    const entriesById = new Map(entries.map((e) => [e.id, e]));
    const lines =
      entryIds.length === 0
        ? []
        : await tx.query("journal_lines_for_entries", { firmId: frozen.firmId, clientId: frozen.clientId, entryIds });
    const linesByEntry = new Map<string, typeof lines>();
    for (const l of lines) {
      const list = linesByEntry.get(l.entryId) ?? [];
      list.push(l);
      linesByEntry.set(l.entryId, list);
    }

    const ruleIds = new Set<string>();
    for (const id of scope.transactionIds) {
      const t = byId.get(id);
      if (t && t.ruleId !== null) ruleIds.add(t.ruleId);
    }
    const rules = new Map<string, RuleRow>();
    for (const ruleId of ruleIds) {
      const rows = await tx.query("rule_by_id", { firmId: frozen.firmId, clientId: frozen.clientId, ruleId });
      if (rows[0]) rules.set(ruleId, rows[0]);
    }
    const tally = new Map<string, RuleTally>();
    const tallyFor = (ruleId: string): RuleTally => {
      const existing = tally.get(ruleId);
      if (existing) return existing;
      const rule = rules.get(ruleId);
      const fresh: RuleTally = {
        rejectedCount: rule?.rejectedCount ?? 0,
        autoPostEnabled: rule?.autoPostEnabled ?? false,
      };
      tally.set(ruleId, fresh);
      return fresh;
    };

    let net: Cents = BigInt(0);
    for (const id of scope.transactionIds) {
      const t = byId.get(id);
      if (!t) {
        skips.push({ rowId: id, reason: "missing_prerequisite", detail: "transaction not found" });
        continue;
      }
      if (t.voided) {
        skips.push({ rowId: id, reason: "missing_prerequisite", detail: "transaction is voided" });
        continue;
      }
      if (t.manualOverride) {
        skips.push({ rowId: id, reason: "manual_override", detail: "already manually overridden" });
        continue;
      }
      if (t.categoryId === category.id) {
        skips.push({ rowId: id, reason: "already_applied", detail: "already coded to this category" });
        continue;
      }
      const outcome = categoryChecks(t, category, { hasDocument: true, policyCapitalizeOverCents: policy.capitalizeOverCents });
      if (outcome.block) {
        skips.push({
          rowId: id,
          reason: "missing_prerequisite",
          detail: `${outcome.block.reasonCode}: ${outcome.block.detail}`,
        });
        continue;
      }

      const account = accountById.get(t.bankAccountId);
      if (!account) {
        skips.push({ rowId: id, reason: "missing_prerequisite", detail: `bank account ${t.bankAccountId} does not exist` });
        continue;
      }

      const miniPlan: Proposal[] = [];
      if (t.journalEntryId !== null) {
        const original = entriesById.get(t.journalEntryId);
        if (!original) {
          skips.push({ rowId: id, reason: "missing_prerequisite", detail: `journal entry ${t.journalEntryId} does not exist` });
          continue;
        }
        const originalLines = linesByEntry.get(original.id) ?? [];
        miniPlan.push(
          reversalOfPostedEntry(original, originalLines, t.postedDate, recodeReversalEntryIdFor(t.id), "recoded"),
        );
      }

      const newEntryId = recodePostedEntryIdFor(t.id);
      miniPlan.push(postEntry(t, account, category, newEntryId));

      const write: ProposedFieldWrite = {
        kind: "field_write",
        table: "transactions",
        rowId: t.id,
        before: {
          categoryId: t.categoryId,
          categoryVersion: t.categoryVersion,
          cascadeLevel: t.cascadeLevel,
          ruleId: t.ruleId,
          ruleVersion: t.ruleVersion,
          templateId: t.templateId,
          templateVersion: t.templateVersion,
          matchedConditions: t.matchedConditions ?? null,
          manualOverride: t.manualOverride,
          manualOverrideBy: t.manualOverrideBy,
          manualOverrideAt: t.manualOverrideAt,
          journalEntryId: t.journalEntryId,
          ruleReviewedAt: t.ruleReviewedAt,
          ruleReviewOutcome: t.ruleReviewOutcome,
        },
        after: {
          categoryId: category.id,
          categoryVersion: category.version,
          cascadeLevel: LEVEL.manualOverride,
          ruleId: null,
          ruleVersion: null,
          templateId: null,
          templateVersion: null,
          matchedConditions: null,
          manualOverride: true,
          manualOverrideBy: ACTOR_PLACEHOLDER,
          manualOverrideAt: NOW_PLACEHOLDER,
          journalEntryId: newEntryId,
          ruleReviewedAt: NOW_PLACEHOLDER,
          ruleReviewOutcome: "rejected",
        },
        provenance: { cascadeLevel: LEVEL.manualOverride },
      };
      miniPlan.push(write);

      const dated = applyReversalDating(miniPlan, locks);
      if (dated.errors.length > 0) {
        skips.push({
          rowId: id,
          reason: "missing_prerequisite",
          detail: dated.errors[0]?.message ?? "could not date the reversal",
        });
        continue;
      }

      for (const p of dated.plan) {
        proposals.push(p);
        if (isJournalEntry(p)) for (const line of p.lines) net += line.amountCents;
      }

      if (t.ruleId !== null) {
        const counted = tallyFor(t.ruleId);
        counted.rejectedCount += 1;
      }
    }

    for (const [ruleId, counted] of tally) {
      const rule = rules.get(ruleId);
      if (!rule) continue;
      const demotes = rule.autoPostEnabled && counted.rejectedCount > 0;
      proposals.push({
        kind: "field_write",
        table: "rules",
        rowId: ruleId,
        before: { rejectedCount: rule.rejectedCount, autoPostEnabled: rule.autoPostEnabled, autoPostEnabledBy: rule.autoPostEnabledBy },
        after: {
          rejectedCount: counted.rejectedCount,
          ...(demotes ? { autoPostEnabled: false, autoPostEnabledBy: null } : {}),
        },
        provenance: { cascadeLevel: null },
      });
    }

    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, errors, net);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "TXN-RECODE", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    // The transactions field write is not undone. categoryId, cascadeLevel,
    // and ruleId are all in OVERRIDE_WATCHED_FIELDS (tables.ts), and this
    // run's own field write just set manual_override true on the same row
    // -- migration 0011's guard_manual_override (mirrored by
    // MemoryRunDb.guardOverride) blocks every further run-mediated write to
    // a watched field on an overridden row, with no exception for the row's
    // own undo. The correction is terminal by the same invariant 8 that
    // protects it from everything else, the same way an insert is never
    // undone. The ledger side still reverses cleanly: both postings this
    // run made (the reversal, if any, and the new one) get reversed in
    // turn, so the net financial effect returns to exactly what it was
    // before this run. The rule's own field write (rejectedCount, and the
    // demotion if one happened) is a plain row on a different table with no
    // override guard, and reverts normally.
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isJournalEntry(p) && p.targetId !== null) {
        plan.push(reverseEntry(p, p.targetId));
      } else if (p.kind === "field_write" && p.table === "rules") {
        plan.push(revertFieldWrite(p));
      }
    }
    return plan;
  },
};
