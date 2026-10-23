/**
 * ENG-SIGN-LETTER v1.
 *
 * The client signs the engagement letter from the portal. Doc 08 describes a
 * signing screen that shows the letter and records a click to sign. Migration
 * 0008 gave that record a table, docvault.signature_evidence, with the signer's
 * address, user agent, consent text, and the hash and size of the exact file
 * signed. This run writes that row and moves the engagement to signed.
 *
 * Preconditions, each its own error code so the screen can say which one held:
 *
 *   1. The engagement belongs to the client and is draft or sent. A signed,
 *      active, or terminated engagement is not signed again.
 *   2. The engagement has a letter on file, letterDocumentId points at a
 *      docvault document for the same client whose status is uploaded or
 *      verified, with a sha256 and a byte size. Without a letter there is
 *      nothing to sign, and the screen says the letter has not been issued.
 *      Object storage is not set up today, so this is the state every client
 *      sees until it is. The firm's activation run records a signature made
 *      outside the product for that case.
 *
 * Two proposals: the signature_evidence insert and a field write on
 * tenancy.engagements, status to signed and signedAt to now. Activation, signed
 * to active, is the firm's run and not this one, because doc 08 puts the
 * decision to start billing with the firm.
 *
 * Idempotency. The signature id derives from the engagement, the letter hash,
 * and the signer, so preview and apply agree. signedAt, consentGivenAt and the
 * signer user id are placeholders the writer fills at apply, the same reasoning
 * as every other run that records who and when.
 *
 * Undo. A signature is not reverted by a run. undoPlan is empty, and voiding a
 * signature is a firm decision with its own status on the evidence row.
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
import { derivedId, scopeHashFor } from "../ids";
import type { DocumentRow, EngagementRow, SignatureEvidenceRow } from "../tables";

export const signLetterScopeSchema = z.object({
  clientId: z.string().min(1),
  engagementId: z.string().min(1),
  signerName: z.string().trim().min(1).max(200),
  signerEmail: z.string().trim().min(3).max(320),
  signerTitle: z.string().trim().max(120).nullable().default(null),
  consentText: z.string().trim().min(1).max(2000),
  /** Captured by the route from the request, never typed by the signer. */
  signerIp: z.string().min(1).max(64),
  userAgent: z.string().min(1).max(1000),
});

export type SignLetterScope = z.infer<typeof signLetterScopeSchema>;

export const ERR_ENGAGEMENT_NOT_FOUND = "ENG-NOT-FOUND";
export const ERR_ENGAGEMENT_NOT_SIGNABLE = "ENG-NOT-SIGNABLE";
export const ERR_NO_LETTER = "ENG-NO-LETTER";

/** The sentence the signer agrees to. The screen shows it and sends it back. */
export const SIGN_CONSENT_TEXT =
  "I agree to sign this engagement letter electronically, and I agree that my electronic signature is the legal equivalent of my handwritten signature.";

type Finding = { engagement: EngagementRow; letter: DocumentRow } | { errors: RunError[] };

async function find(scope: SignLetterScope, ctx: Parameters<typeof requireTx>[0]): Promise<Finding> {
  const tx = requireTx(ctx);
  const engagements = await tx.query("engagements_for_client", {
    firmId: ctx.firmId,
    clientId: scope.clientId,
  });
  const engagement = engagements.find((e) => e.id === scope.engagementId);
  if (!engagement) {
    return {
      errors: [
        {
          rowId: scope.engagementId,
          code: ERR_ENGAGEMENT_NOT_FOUND,
          message: `engagement ${scope.engagementId} is not one of this client's engagements`,
          retryable: false,
        },
      ],
    };
  }
  if (engagement.status !== "draft" && engagement.status !== "sent") {
    return {
      errors: [
        {
          rowId: engagement.id,
          code: ERR_ENGAGEMENT_NOT_SIGNABLE,
          message: `engagement ${engagement.id} is ${engagement.status} and is not signed again`,
          retryable: false,
        },
      ],
    };
  }
  const letters = engagement.letterDocumentId
    ? await tx.query("document_by_id", {
        firmId: ctx.firmId,
        clientId: scope.clientId,
        documentId: engagement.letterDocumentId,
      })
    : [];
  const letter = letters[0];
  const usable =
    letter !== undefined &&
    (letter.status === "uploaded" || letter.status === "verified") &&
    letter.sha256Hex !== null &&
    letter.byteSize !== null;
  if (!usable) {
    return {
      errors: [
        {
          rowId: engagement.id,
          code: ERR_NO_LETTER,
          message: `engagement ${engagement.id} has no engagement letter on file to sign`,
          retryable: false,
        },
      ],
    };
  }
  return { engagement, letter };
}

export function signatureIdOf(engagementId: string, sha256Hex: string, signerEmail: string): string {
  return derivedId(`${engagementId}/${sha256Hex}/${signerEmail.toLowerCase()}`, "signature", 0);
}

export const engSignLetter: Run<SignLetterScope, Proposal> = {
  type: "ENG-SIGN-LETTER",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:engagement:${scope.engagementId}`,
  scopeSchema: signLetterScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<SignLetterScope>> {
    const found = await find(scope, ctx);
    const letterHash = "letter" in found ? found.letter.sha256Hex ?? "" : "";
    const state = "engagement" in found ? found.engagement.status : "missing";
    const candidateIds = [scope.engagementId];
    const versions = [{ id: "ENG-SIGN-LETTER", version: 1 }];
    const day = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: day,
      periodEnd: day,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [state, letterHash, scope.signerEmail.toLowerCase()].join("/"),
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const scope = frozen.input;
    const found = await find(scope, ctx);
    if ("errors" in found) {
      return makeResult<Proposal>(1, [], [], found.errors, BigInt(0));
    }
    const { engagement, letter } = found;
    const sha = letter.sha256Hex ?? "";
    const evidence: SignatureEvidenceRow = {
      id: signatureIdOf(engagement.id, sha, scope.signerEmail),
      firmId: ctx.firmId,
      clientId: scope.clientId,
      documentId: letter.id,
      engagementId: engagement.id,
      documentSha256Hex: sha,
      documentByteSize: letter.byteSize ?? 0,
      signerName: scope.signerName,
      signerEmail: scope.signerEmail,
      signerUserId: ACTOR_PLACEHOLDER,
      signerTitle: scope.signerTitle,
      signedAt: NOW_PLACEHOLDER,
      signerIp: scope.signerIp,
      userAgent: scope.userAgent,
      consentGivenAt: NOW_PLACEHOLDER,
      consentText: scope.consentText,
      signatureMethod: "click_to_sign",
      status: "signed",
      createdAt: NOW_PLACEHOLDER,
    };
    const insert: ProposedRowInsert = {
      kind: "row_insert",
      table: "signature_evidence",
      rowId: evidence.id,
      row: evidence as unknown as Record<string, unknown>,
      provenance: { cascadeLevel: null },
    };
    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "engagements",
      rowId: engagement.id,
      before: { status: engagement.status, signedAt: engagement.signedAt },
      after: { status: "signed", signedAt: NOW_PLACEHOLDER },
      provenance: { cascadeLevel: null },
    };
    return makeResult<Proposal>(1, [insert, write], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, {
      runType: "ENG-SIGN-LETTER",
      runVersion: 1,
    });
  },

  async undoPlan(): Promise<Proposal[]> {
    return [];
  },
};
