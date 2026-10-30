/**
 * PER-DISPOSE-ASSET. Take a fixed asset off the books.
 *
 * Not one of doc 02's documented runs. subledger.fixed_assets has carried
 * disposed_on, disposal_entry_id, disposal_proceeds_cents, and a status check
 * constraint requiring both of the first two whenever status is 'disposed'
 * since the asset table itself was built, and PER-POST-DEPRECIATION has
 * always read disposed_on to stop depreciating and to charge a half month in
 * the disposal month under the half month convention. Nothing ever wrote any
 * of the three. An asset sold, scrapped, or traded in had no way to leave the
 * books: NOTES.md on the asset table anticipated the day it would, and this
 * is that day.
 *
 * One journal entry, four or five lines depending on whether the disposal
 * month still owes depreciation:
 *   1. Depreciation expense for the disposal month, if the half month
 *      convention applies and the month has not already posted. Computed
 *      with the identical monthlyPlan this asset's own schedule already
 *      used, from depreciation-shared.ts, so the figure PER-POST-DEPRECIATION
 *      would have posted next and the figure this run posts now are the same
 *      number by construction.
 *   2. Accumulated depreciation, net. Charging the final month and then
 *      removing the whole accumulated balance cancels the final month out of
 *      this line algebraically; what is left is exactly what was accumulated
 *      before this run touched the asset, which is the only number this line
 *      needs to carry.
 *   3. The asset's cost account, removed in full.
 *   4. The account the proceeds landed in, when there were any.
 *   5. Gain or loss on disposal: proceeds minus the net book value the first
 *      four lines leave behind. Positive proceeds over book value is a gain,
 *      a credit; a loss debits the same account, per doc 01's single combined
 *      gain or loss account.
 *
 * Posting: Yes. writesLedger is true and an open period is required, the same
 * reasoning PER-POST-DEPRECIATION gives for posting depreciation itself.
 *
 * Manual tier: which asset left the books, on what day, and for how much is a
 * decision a person makes once, looking at a bill of sale or a disposal memo,
 * and a clock has no sale of its own to discover.
 */

import { z } from "zod";
import {
  makeResult,
  isFieldWrite,
  isJournalEntry,
  type Cents,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type ProposedJournalEntry,
  type ProposedLine,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
} from "../contract";
import {
  applyProposals,
  requireTx,
  NOW_PLACEHOLDER,
  RUN_ID_PLACEHOLDER,
} from "../apply-writer";
import { isLockedDay } from "../dates";
import { derivedId, scopeHashFor } from "../ids";
import { reverseEntry, revertFieldWrite } from "../undo";
import { accumulated, monthlyPlan } from "./depreciation-shared";
import { halve, monthKey } from "./per-shared";

export const DISPOSE_ASSET_ERROR_CODES = {
  unknownAsset: "PER_ASSET_UNKNOWN",
  beforeService: "PER_ASSET_DISPOSED_BEFORE_SERVICE",
  missingProceedsAccount: "PER_ASSET_PROCEEDS_ACCOUNT_MISSING",
  missingGainLossAccount: "PER_ASSET_GAIN_LOSS_ACCOUNT_MISSING",
  missingContraAccount: "PER_ASSET_CONTRA_ACCOUNT_MISSING",
} as const;

const centsString = z.string().regex(/^\d{1,18}$/);

export const disposeAssetScopeSchema = z.object({
  clientId: z.string().min(1),
  assetId: z.string().min(1),
  disposedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Never negative. A disposal that cost money to execute is not modeled here. */
  proceedsCents: centsString.default("0"),
  /** Where the proceeds landed, for example "1010". Required only when proceedsCents is nonzero. */
  proceedsAccount: z.string().nullable().default(null),
  /** Doc 01's combined gain or loss on disposal account, for example "8200". */
  gainLossAccount: z.string().min(1),
});

export type DisposeAssetScope = z.infer<typeof disposeAssetScopeSchema>;

export const perDisposeAsset: Run<DisposeAssetScope, Proposal> = {
  type: "PER-DISPOSE-ASSET",
  version: 1,
  writesLedger: true,
  requiresOpenPeriod: true,
  concurrencyKey: (scope) => `${scope.clientId}:${scope.assetId}`,
  scopeSchema: disposeAssetScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<DisposeAssetScope>> {
    const tx = requireTx(ctx);
    const assets = await tx.query("fixed_assets_for_client", {
      firmId: ctx.firmId,
      clientId: scope.clientId,
    });
    const asset = assets.find((a) => a.id === scope.assetId);
    const history = asset
      ? await tx.query("depreciation_schedule_for_assets", {
          firmId: ctx.firmId,
          clientId: scope.clientId,
          assetIds: [scope.assetId],
        })
      : [];
    const candidateIds = asset ? [asset.id] : [];
    const versions = [
      { id: "PER-DISPOSE-ASSET", version: 1 },
      ...(asset ? [{ id: asset.id, version: asset.version }] : []),
      ...history.map((h) => ({ id: h.id, version: h.version })),
    ];
    return {
      input: scope,
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: scope.disposedOn,
      periodEnd: scope.disposedOn,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: `${scope.proceedsCents}:${scope.proceedsAccount ?? ""}:${scope.gainLossAccount}`,
      }),
      versions,
      overriddenIds: asset?.manualOverride ? [asset.id] : [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const skips: Skip[] = [];

    const refuse = (code: string, message: string): RunResult<Proposal> => {
      errors.push({ rowId: scope.assetId, code, message, retryable: false });
      return makeResult<Proposal>(frozen.candidateIds.length, [], skips, errors, BigInt(0));
    };

    const assets = await tx.query("fixed_assets_for_client", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    const asset = assets.find((a) => a.id === scope.assetId);
    if (!asset) {
      return refuse(
        DISPOSE_ASSET_ERROR_CODES.unknownAsset,
        `fixed asset ${scope.assetId} does not exist for client ${frozen.clientId}`,
      );
    }

    if (asset.status === "disposed" || asset.status === "written_off") {
      skips.push({
        rowId: asset.id,
        reason: "already_applied",
        detail: `asset ${asset.id} is already ${asset.status}`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, [], skips, [], BigInt(0));
    }
    if (asset.manualOverride) {
      skips.push({
        rowId: asset.id,
        reason: "manual_override",
        detail: `asset ${asset.id} carries manual_override`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, [], skips, [], BigInt(0));
    }
    if (scope.disposedOn < asset.placedInServiceOn) {
      return refuse(
        DISPOSE_ASSET_ERROR_CODES.beforeService,
        `disposedOn ${scope.disposedOn} is before the asset was placed in service on ${asset.placedInServiceOn}`,
      );
    }

    const locks = await tx.query("open_period_locks", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
    });
    if (isLockedDay(locks, scope.disposedOn)) {
      skips.push({
        rowId: asset.id,
        reason: "locked_period",
        detail: `disposedOn ${scope.disposedOn} falls inside a locked period`,
      });
      return makeResult<Proposal>(frozen.candidateIds.length, [], skips, [], BigInt(0));
    }

    const proceedsCents = BigInt(scope.proceedsCents);
    if (proceedsCents > BigInt(0) && scope.proceedsAccount === null) {
      return refuse(
        DISPOSE_ASSET_ERROR_CODES.missingProceedsAccount,
        "proceedsCents is positive and no proceedsAccount was given",
      );
    }
    if (proceedsCents > BigInt(0)) {
      const proceeds = await tx.query("chart_account", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        accountNumber: scope.proceedsAccount as string,
      });
      if (proceeds.length === 0) {
        return refuse(
          DISPOSE_ASSET_ERROR_CODES.missingProceedsAccount,
          `proceeds account ${String(scope.proceedsAccount)} is not on the chart`,
        );
      }
    }

    const history = await tx.query("depreciation_schedule_for_assets", {
      firmId: frozen.firmId,
      clientId: frozen.clientId,
      assetIds: [asset.id],
    });
    const accumulatedBefore = accumulated(history);

    // The disposal month's own charge, the same number PER-POST-DEPRECIATION
    // would compute next, so a disposal and a monthly post never disagree
    // about what the month after the last posted one is worth.
    let finalChargeCents: Cents = BigInt(0);
    let finalPeriodNumber: number | null = null;
    const disposalMonth = monthKey(scope.disposedOn);
    const alreadyPostedThisMonth = history.some(
      (h) => h.status === "posted" && monthKey(h.periodEnd) === disposalMonth,
    );
    if (
      asset.method !== "none" &&
      !alreadyPostedThisMonth &&
      asset.depreciableBaseCents - accumulatedBefore > BigInt(0)
    ) {
      const plan = monthlyPlan(asset);
      if (!("code" in plan)) {
        const slot = plan.months.find((m) => m.period === disposalMonth);
        if (slot !== undefined) {
          let amount = slot.amountCents;
          if (asset.halfMonthConvention) amount = halve(amount);
          const remaining = asset.depreciableBaseCents - accumulatedBefore;
          if (amount > remaining) amount = remaining;
          if (amount > BigInt(0)) {
            finalChargeCents = amount;
            finalPeriodNumber = slot.periodNumber;
          }
        }
      }
      // A method this run cannot compute (units of production, sum of years)
      // simply contributes no final charge rather than refusing the disposal
      // over it; the asset still leaves the books at whatever was already
      // accumulated, which is the honest number available.
    }

    const totalAccumulated = accumulatedBefore + finalChargeCents;
    const netBookValue = asset.costCents - totalAccumulated;
    const gainOrLoss = netBookValue - proceedsCents;

    if (gainOrLoss !== BigInt(0)) {
      const gainLoss = await tx.query("chart_account", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        accountNumber: scope.gainLossAccount,
      });
      if (gainLoss.length === 0) {
        return refuse(
          DISPOSE_ASSET_ERROR_CODES.missingGainLossAccount,
          `gain or loss account ${scope.gainLossAccount} is not on the chart`,
        );
      }
    }
    if (finalChargeCents > BigInt(0) || accumulatedBefore > BigInt(0)) {
      const contra = await tx.query("chart_account", {
        firmId: frozen.firmId,
        clientId: frozen.clientId,
        accountNumber: asset.accumAccount,
      });
      if (contra.length === 0) {
        return refuse(
          DISPOSE_ASSET_ERROR_CODES.missingContraAccount,
          `contra account ${asset.accumAccount} is not on the chart`,
        );
      }
    }

    const entryId = derivedId(`${asset.id}:${scope.disposedOn}`, "per-dispose-asset", 0);
    const lines: ProposedLine[] = [];
    const memo = `Disposal, ${asset.description}`;
    if (finalChargeCents > BigInt(0)) {
      lines.push({
        accountNumber: asset.expenseAccount,
        categoryId: null,
        amountCents: finalChargeCents,
        memo: `${memo}, final month depreciation`,
        dimensions: {},
      });
    }
    // Charging the final month above and then removing all of accumulated
    // depreciation here cancels the final month out of this line: what is
    // left is exactly what was accumulated before this run touched the
    // asset, per the header comment's algebra.
    if (accumulatedBefore !== BigInt(0)) {
      lines.push({
        accountNumber: asset.accumAccount,
        categoryId: null,
        amountCents: accumulatedBefore,
        memo,
        dimensions: {},
      });
    }
    lines.push({
      accountNumber: asset.costAccount,
      categoryId: null,
      amountCents: -asset.costCents,
      memo,
      dimensions: {},
    });
    if (proceedsCents > BigInt(0)) {
      lines.push({
        accountNumber: scope.proceedsAccount as string,
        categoryId: null,
        amountCents: proceedsCents,
        memo,
        dimensions: {},
      });
    }
    if (gainOrLoss !== BigInt(0)) {
      // Net book value minus proceeds. Proceeds over book value makes this
      // negative, a credit, which is the gain; proceeds under book value
      // makes it positive, a debit, the loss. No negation: the four lines
      // above already balance against this exact signed number.
      lines.push({
        accountNumber: scope.gainLossAccount,
        categoryId: null,
        amountCents: gainOrLoss,
        memo: gainOrLoss < BigInt(0) ? `${memo}, gain` : `${memo}, loss`,
        dimensions: {},
      });
    }

    const entry: ProposedJournalEntry = {
      kind: "journal_entry",
      targetId: entryId,
      entryDate: scope.disposedOn,
      lines,
      sourceRef: { table: "fixed_assets", rowId: asset.id, version: asset.version },
    };

    const statusWrite: ProposedFieldWrite = {
      kind: "field_write",
      table: "fixed_assets",
      rowId: asset.id,
      before: {
        status: asset.status,
        disposedOn: asset.disposedOn,
        disposalEntryId: asset.disposalEntryId,
        disposalProceedsCents: asset.disposalProceedsCents,
      },
      after: {
        status: "disposed",
        disposedOn: scope.disposedOn,
        disposalEntryId: entryId,
        disposalProceedsCents: proceedsCents,
      },
      provenance: { cascadeLevel: null },
    };

    const proposals: Proposal[] = [entry, statusWrite];
    if (finalChargeCents > BigInt(0) && finalPeriodNumber !== null) {
      // Recorded so a later PER-POST-DEPRECIATION for this same month, run by
      // habit before anyone remembers a disposal already covered it, finds
      // the month already posted and skips it rather than posting a second
      // depreciation entry for it. The disposed status check below is the
      // first line of defense; this is the record that makes the history
      // correct even if that check were ever relaxed.
      const scheduleRowId = derivedId(
        `${asset.id}:${disposalMonth}`,
        "per-depreciation-line",
        0,
      );
      proposals.push({
        kind: "row_insert",
        table: "depreciation_schedule",
        rowId: scheduleRowId,
        row: {
          firmId: asset.firmId,
          clientId: asset.clientId,
          assetId: asset.id,
          periodStart: `${disposalMonth}-01`,
          periodEnd: scope.disposedOn,
          periodNumber: finalPeriodNumber,
          scheduleVersion: asset.version,
          amountCents: finalChargeCents,
          accumulatedAfterCents: totalAccumulated,
          nbvAfterCents: netBookValue,
          status: "posted",
          postedEntryId: entryId,
          postedRunId: RUN_ID_PLACEHOLDER,
          postedAt: NOW_PLACEHOLDER,
          manualOverride: false,
          version: 1,
        },
        provenance: { cascadeLevel: null },
      });
    }
    // Same debit-positive convention as the gain/loss line itself: positive
    // is a loss, negative is a gain.
    return makeResult<Proposal>(frozen.candidateIds.length, proposals, skips, [], gainOrLoss);
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "PER-DISPOSE-ASSET",
      runVersion: 1,
    });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    const plan: Proposal[] = [];
    for (const p of proposals) {
      if (isJournalEntry(p) && p.targetId !== null) {
        plan.push(reverseEntry(p, p.targetId));
      } else if (isFieldWrite(p)) {
        plan.push(revertFieldWrite(p));
      }
    }
    return plan;
  },
};
