/**
 * RPT-RELEASE-NARRATIVE, version 1.
 *
 * Audit fix, 2026-11-06 (problem 9, the narrative half). migration 0016's
 * own comment on narrative_state ("there is no sent state here, because
 * nothing in this module sends anything") predates the portal review gate
 * this whole finding is about -- portal-router.ts's narrativeFor() lists
 * every narrative RPT-COMPOSE-NARRATIVE writes with no filter at all, the
 * same unfiltered read reportsFor() had for packages. A narrative is
 * composed straight from the period's own statement triggers, so it can
 * say something a person has not reviewed yet, same risk as an unreviewed
 * package reaching the portal.
 *
 * This run is the missing gate: the only way a narrative's state ever
 * becomes "released", and portal-router.ts's narrativeFor() now reads only
 * released rows. RPT-COMPOSE-NARRATIVE's own content builder
 * unconditionally writes state: "draft", so recomposing an already
 * released narrative pulls it back out of the portal until released
 * again, the same correct behavior RPT-RELEASE-PACKAGE's own header
 * describes.
 *
 * Manual tier: deciding a narrative is ready for the client to see is a
 * judgment a person makes on purpose.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";

export const releaseNarrativeScopeSchema = z.object({
  clientId: z.string().min(1),
  narrativeId: z.string().min(1),
});

export type ReleaseNarrativeScope = z.infer<typeof releaseNarrativeScopeSchema>;

export const ERR_NARRATIVE_NOT_FOUND = "RPT_RELEASE_NARRATIVE_NOT_FOUND";

export const rptReleaseNarrative: Run<ReleaseNarrativeScope, Proposal> = {
  type: "RPT-RELEASE-NARRATIVE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:rpt-release-narrative:${scope.narrativeId}`,
  scopeSchema: releaseNarrativeScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ReleaseNarrativeScope>> {
    const tx = requireTx(ctx);
    const narratives = await tx.query("report_narratives_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const narrative = narratives.find((n) => n.id === scope.narrativeId);
    const candidateIds = [scope.narrativeId];
    const versions = [
      { id: "RPT-RELEASE-NARRATIVE", version: 1 },
      ...(narrative === undefined ? [] : [{ id: narrative.id, version: narrative.version }]),
    ];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: narrative?.periodStart ?? today,
      periodEnd: narrative?.periodEnd ?? today,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: narrative !== undefined && narrative.manualOverride ? [narrative.id] : [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const narratives = await tx.query("report_narratives_for_client", { firmId: frozen.firmId, clientId: frozen.clientId });
    const narrative = narratives.find((n) => n.id === scope.narrativeId);
    if (narrative === undefined) {
      errors.push({
        rowId: scope.narrativeId,
        code: ERR_NARRATIVE_NOT_FOUND,
        message: `no narrative ${scope.narrativeId} exists for client ${scope.clientId}`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    if (narrative.state === "released") {
      skips.push({
        rowId: narrative.id,
        reason: "already_applied",
        detail: `narrative ${narrative.id} is already released`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "report_narratives",
      rowId: narrative.id,
      before: { state: narrative.state },
      after: { state: "released" },
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [write], skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "RPT-RELEASE-NARRATIVE", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    return proposals.filter((p) => p.kind === "field_write").map(revertFieldWrite);
  },
};
