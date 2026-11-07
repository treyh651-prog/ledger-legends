/**
 * RPT-RELEASE-PACKAGE, version 1.
 *
 * Audit fix, 2026-11-06 (problem 9). report.report_packages.state has only
 * ever held "draft" or "superseded" since the reporting module was built,
 * and portal-router.ts's own reportsFor() lists every row the query
 * returns with no filter at all -- confirmed by reading it directly. A
 * package flagged closed_with_exceptions reached the client portal the
 * instant RPT-BUILD-PACKAGE finished, with no firm review in between.
 * "superseded" turned out to be vestigial too: packageIdOf() derives one
 * id per (client, period, basis), so a rebuild always field-writes the
 * same row, and grepping the whole run registry found nothing that ever
 * wrote "superseded" either.
 *
 * This run is the missing gate: it is the only way a package's state ever
 * becomes "released", and portal-router.ts's reportsFor() now reads only
 * released rows. Rebuilding an already-released package (RPT-BUILD-PACKAGE
 * unconditionally writes state: "draft" in its own content) silently pulls
 * it back out of the portal until released again -- the correct behavior,
 * not a bug to work around, since new content deserves a fresh review.
 *
 * Manual tier: deciding a package is ready for the client to see is a
 * judgment a person makes on purpose, the same reasoning every other
 * gate-shaped run in this codebase gives.
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

export const releasePackageScopeSchema = z.object({
  clientId: z.string().min(1),
  packageId: z.string().min(1),
});

export type ReleasePackageScope = z.infer<typeof releasePackageScopeSchema>;

export const ERR_PACKAGE_NOT_FOUND = "RPT_RELEASE_PACKAGE_NOT_FOUND";

export const rptReleasePackage: Run<ReleasePackageScope, Proposal> = {
  type: "RPT-RELEASE-PACKAGE",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:rpt-release-package:${scope.packageId}`,
  scopeSchema: releasePackageScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ReleasePackageScope>> {
    const tx = requireTx(ctx);
    const packages = await tx.query("report_packages_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const pkg = packages.find((p) => p.id === scope.packageId);
    const candidateIds = [scope.packageId];
    const versions = [
      { id: "RPT-RELEASE-PACKAGE", version: 1 },
      ...(pkg === undefined ? [] : [{ id: pkg.id, version: pkg.version }]),
    ];
    const today = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: pkg?.periodStart ?? today,
      periodEnd: pkg?.periodEnd ?? today,
      candidateIds,
      scopeHash: scopeHashFor({ candidateIds, versions }),
      versions,
      overriddenIds: pkg !== undefined && pkg.manualOverride ? [pkg.id] : [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const skips: Skip[] = [];
    const errors: RunError[] = [];

    const packages = await tx.query("report_packages_for_client", { firmId: frozen.firmId, clientId: frozen.clientId });
    const pkg = packages.find((p) => p.id === scope.packageId);
    if (pkg === undefined) {
      errors.push({
        rowId: scope.packageId,
        code: ERR_PACKAGE_NOT_FOUND,
        message: `no report package ${scope.packageId} exists for client ${scope.clientId}`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    if (pkg.state === "released") {
      skips.push({
        rowId: pkg.id,
        reason: "already_applied",
        detail: `package ${pkg.id} is already released`,
      });
      return makeResult<Proposal>(1, [], skips, errors, BigInt(0));
    }

    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "report_packages",
      rowId: pkg.id,
      before: { state: pkg.state },
      after: { state: "released" },
      provenance: { cascadeLevel: null },
    };

    return makeResult<Proposal>(1, [write], skips, errors, BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "RPT-RELEASE-PACKAGE", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    return proposals.filter((p) => p.kind === "field_write").map(revertFieldWrite);
  },
};
