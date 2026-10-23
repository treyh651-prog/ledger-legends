/**
 * INTAKE-ACTIVATE-ENGAGEMENT, version 1.
 *
 * Moves a draft engagement to active. The portal grants features from the
 * client's active engagement (shared/tiers, tenancy.engagements, api-report
 * finding 2), so until this run has applied a new client's portal sees the
 * floor tier and nothing else.
 *
 * tenancy.engagements carries eng_signed_has_letter (migration 0001): a row in
 * status signed or active must hold a letter document id and a signed at
 * timestamp. This run honours that in two ways and refuses otherwise.
 *
 *   1. The letter was signed in the system. The engagement already carries a
 *      letter document id and a signed at time, written by the portal signing
 *      run. The scope names nothing but the engagement and the run flips the
 *      status to active.
 *
 *   2. The letter was signed outside the system, on paper or through another
 *      service. The scope says so and names who signed and when. The run
 *      writes one docvault.documents row of type engagement_letter in status
 *      pending, which is the vault's word for "no object stored yet", and
 *      points the engagement at it. The firm scans the letter in through the
 *      vault later; that upload fills the bucket and key alias, which until
 *      then hold the literal not_configured, because the columns are not
 *      null and the engine holds no storage settings.
 *
 * Without either, there is no letter and the run refuses with
 * INTAKE-LETTER-NOT-SIGNED rather than writing a row the constraint would
 * reject.
 *
 * Manual tier: an engagement becomes active because a person at the firm says
 * so, never because a clock ran. Insert and single field write only, no
 * ledger rows. Undo is empty on purpose: a wrongly activated engagement is
 * terminated through the offboarding path, which keeps its own record, rather
 * than silently set back to draft.
 */

import { createHash } from "node:crypto";
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
import { ACTOR_PLACEHOLDER, NOW_PLACEHOLDER, applyProposals, requireTx } from "../apply-writer";
import { scopeHashFor } from "../ids";
import type { EngagementRow, VaultDocumentRow } from "../tables";

export const activateEngagementScopeSchema = z.object({
  clientId: z.string().uuid(),
  engagementId: z.string().uuid(),
  /**
   * Present when the letter was signed outside the system. signedOn is the
   * calendar day on the paper; the run stores it as midnight UTC of that day.
   */
  signedOutside: z
    .object({
      signerName: z.string().trim().min(1).max(200),
      signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
});

export type ActivateEngagementScope = z.infer<typeof activateEngagementScopeSchema>;

export const ERR_ENGAGEMENT_NOT_FOUND = "INTAKE-ENGAGEMENT-NOT-FOUND";
export const ERR_ENGAGEMENT_NOT_DRAFT = "INTAKE-ENGAGEMENT-NOT-DRAFT";
export const ERR_LETTER_NOT_SIGNED = "INTAKE-LETTER-NOT-SIGNED";

export const NOT_CONFIGURED = "not_configured";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A stable 26 character Crockford base32 id derived from a seed, so preview
 * and apply propose the same document row and the digests agree. The vault
 * column is char(26) with no shape check beyond that.
 */
export function vaultIdFrom(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest();
  let out = "";
  for (let i = 0; i < 26; i += 1) out += CROCKFORD[bytes[i] % 32];
  return out;
}

export function letterDocumentIdOf(engagementId: string): string {
  return vaultIdFrom(`${engagementId}/engagement-letter/outside`);
}

export const intakeActivateEngagement: Run<ActivateEngagementScope, Proposal> = {
  type: "INTAKE-ACTIVATE-ENGAGEMENT",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:intake-activate`,
  scopeSchema: activateEngagementScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<ActivateEngagementScope>> {
    const tx = requireTx(ctx);
    const rows = await tx.query("engagements_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const engagement = rows.find((e) => e.id === scope.engagementId) ?? null;
    const candidateIds = [scope.engagementId];
    const versions = [{ id: "INTAKE-ACTIVATE-ENGAGEMENT", version: 1 }];
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
        period: [
          engagement ? `${engagement.status}/${engagement.letterDocumentId ?? ""}/${engagement.signedAt ?? ""}` : "missing",
          scope.signedOutside ? `${scope.signedOutside.signerName}/${scope.signedOutside.signedOn}` : "in-system",
        ].join("|"),
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];

    const rows = await tx.query("engagements_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const engagement: EngagementRow | undefined = rows.find((e) => e.id === scope.engagementId);
    if (!engagement) {
      errors.push({
        rowId: scope.engagementId,
        code: ERR_ENGAGEMENT_NOT_FOUND,
        message: `engagement ${scope.engagementId} does not belong to client ${scope.clientId}`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }
    if (engagement.status !== "draft" && engagement.status !== "sent" && engagement.status !== "signed") {
      errors.push({
        rowId: engagement.id,
        code: ERR_ENGAGEMENT_NOT_DRAFT,
        message: `engagement ${engagement.id} is ${engagement.status}, so there is nothing to activate`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }

    const proposals: Proposal[] = [];
    let letterDocumentId = engagement.letterDocumentId;
    let signedAt = engagement.signedAt;

    if (!letterDocumentId || !signedAt) {
      if (!scope.signedOutside) {
        errors.push({
          rowId: engagement.id,
          code: ERR_LETTER_NOT_SIGNED,
          message:
            "the engagement letter has not been signed in the system; sign it through the portal or record that it was signed outside the system",
          retryable: true,
        });
        return makeResult<Proposal>(1, [], [], errors, BigInt(0));
      }
      letterDocumentId = letterDocumentIdOf(engagement.id);
      signedAt = `${scope.signedOutside.signedOn}T00:00:00.000Z`;
      const document: VaultDocumentRow = {
        id: letterDocumentId,
        clientId: scope.clientId,
        firmId: ctx.firmId,
        docType: "engagement_letter",
        title: `Engagement letter, signed outside the system by ${scope.signedOutside.signerName} on ${scope.signedOutside.signedOn}`,
        bucket: NOT_CONFIGURED,
        objectKey: `firm/${ctx.firmId}/client/${scope.clientId}/${letterDocumentId}/engagement-letter.pdf`,
        kmsKeyAlias: NOT_CONFIGURED,
        objectLockMode: "GOVERNANCE",
        status: "pending",
        uploadedBy: ACTOR_PLACEHOLDER,
        createdAt: NOW_PLACEHOLDER,
      };
      const insert: ProposedRowInsert = {
        kind: "row_insert",
        table: "vault_documents",
        rowId: document.id,
        row: document as unknown as Record<string, unknown>,
        provenance: { cascadeLevel: null },
      };
      proposals.push(insert);
    }

    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "engagements",
      rowId: engagement.id,
      before: {
        status: engagement.status,
        letterDocumentId: engagement.letterDocumentId,
        signedAt: engagement.signedAt,
      },
      after: { status: "active", letterDocumentId, signedAt },
      provenance: { cascadeLevel: null },
    };
    proposals.push(write);
    return makeResult<Proposal>(1, proposals, [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "INTAKE-ACTIVATE-ENGAGEMENT",
      runVersion: 1,
    });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
