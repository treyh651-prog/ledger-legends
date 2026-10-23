/**
 * Portal screen contracts, docs/11-api.md and NOTES 240 onward. Everything the
 * client plane reads past home, statements and transactions. Read models only,
 * the server builds them in server/api/portal-router.ts from the query catalog
 * and the three portal runs in migration 0028.
 */
import { z } from "zod";
import { centsSchema, daySchema, idSchema } from "./common";

/* ---------------- Requests ---------------- */

export const portalRequestDetailSchema = z.object({
  id: idSchema,
  /** transaction rows come from ledger.portal_requests, document rows from close.document_requests. */
  kind: z.enum(["transaction", "document"]),
  reasonCode: z.string(),
  detail: z.string(),
  status: z.enum(["open", "satisfied", "waived"]),
  openedOn: daySchema,
  dueOn: daySchema,
  transactionId: idSchema.nullable(),
  /** The client's answer in words, portal rows only. */
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
  /** True when this row can be answered in words from the portal right now. */
  canAnswer: z.boolean(),
});
export type PortalRequestDetail = z.infer<typeof portalRequestDetailSchema>;

export const portalRequestsSchema = z.object({
  items: z.array(portalRequestDetailSchema),
  openCount: z.number().int(),
  /** False until object storage exists, so document rows cannot be satisfied here. */
  uploadsConfigured: z.boolean(),
});
export type PortalRequests = z.infer<typeof portalRequestsSchema>;

export const answerRequestBodySchema = z.object({
  requestId: idSchema,
  answer: z.string().trim().min(1).max(4000),
});
export type AnswerRequestBody = z.infer<typeof answerRequestBodySchema>;

/* ---------------- Messages ---------------- */

export const portalMessageSchema = z.object({
  id: idSchema,
  authorScope: z.enum(["client", "firm"]),
  authorUserId: z.string(),
  /** True when the signed in person wrote it. */
  mine: z.boolean(),
  body: z.string(),
  createdAt: z.string(),
});
export type PortalMessage = z.infer<typeof portalMessageSchema>;

export const portalMessagesSchema = z.object({
  items: z.array(portalMessageSchema),
  /** False, and stated, until outbound email exists. The thread lives in the product. */
  emailConfigured: z.boolean(),
});
export type PortalMessages = z.infer<typeof portalMessagesSchema>;

export const postMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(4000),
});
export type PostMessageBody = z.infer<typeof postMessageBodySchema>;

/* ---------------- Documents ---------------- */

export const portalDocumentSchema = z.object({
  id: idSchema,
  docType: z.string(),
  title: z.string(),
  periodStart: daySchema.nullable(),
  periodEnd: daySchema.nullable(),
  /** The doc_status check in migration 0008. */
  status: z.enum(["pending", "uploaded", "verified", "quarantined", "failed"]),
  byteSize: z.number().nullable(),
  contentType: z.string().nullable(),
  uploadedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PortalDocument = z.infer<typeof portalDocumentSchema>;

export const portalDocumentsSchema = z.object({
  items: z.array(portalDocumentSchema),
  /** Open document requests, so the screen can say what the firm is waiting on. */
  openRequests: z.array(portalRequestDetailSchema),
  /** False until object storage exists. Upload and download stay 501 until then. */
  storageConfigured: z.boolean(),
});
export type PortalDocuments = z.infer<typeof portalDocumentsSchema>;

/* ---------------- Engagement letter and signing ---------------- */

export const signatureRecordSchema = z.object({
  id: idSchema,
  signerName: z.string(),
  signerEmail: z.string(),
  signerTitle: z.string().nullable(),
  signedAt: z.string(),
  signatureMethod: z.enum(["click_to_sign", "typed_name", "drawn"]),
  status: z.enum(["signed", "voided"]),
  documentSha256Hex: z.string(),
});
export type SignatureRecord = z.infer<typeof signatureRecordSchema>;

export const portalSignSchema = z.object({
  engagement: z
    .object({
      id: idSchema,
      name: z.string(),
      status: z.enum(["draft", "sent", "signed", "active", "terminated"]),
      serviceLevel: z.string(),
      tierName: z.string(),
      reportingBasis: z.enum(["accrual", "cash", "both"]),
      startDate: daySchema,
      endDate: daySchema.nullable(),
      /** Keys from the engagement scope object, shown as the letter's scope list. */
      scopeItems: z.array(z.string()),
      signedAt: z.string().nullable(),
    })
    .nullable(),
  /** The letter document on file, or null when none has been issued. */
  letter: portalDocumentSchema.nullable(),
  /** Why the sign button is or is not available. */
  state: z.enum(["no_engagement", "no_letter", "ready", "signed", "terminated"]),
  consentText: z.string(),
  signatures: z.array(signatureRecordSchema),
  /** Prefilled from the signed in person. */
  signer: z.object({ name: z.string(), email: z.string() }),
});
export type PortalSign = z.infer<typeof portalSignSchema>;

export const signLetterBodySchema = z.object({
  signerName: z.string().trim().min(1).max(200),
  signerTitle: z.string().trim().max(120).optional(),
  /** Must match consentText from GET /sign, so the record holds the words agreed to. */
  consentText: z.string().min(1),
});
export type SignLetterBody = z.infer<typeof signLetterBodySchema>;

/* ---------------- Legend screens ---------------- */

export const portalAgingSchema = z.object({
  asOfDate: daySchema.nullable(),
  side: z.enum(["receivable", "payable"]),
  items: z.array(
    z.object({
      partyName: z.string(),
      documentNumber: z.string().nullable(),
      documentDate: daySchema.nullable(),
      ageDays: z.number().nullable(),
      bucket: z.string(),
      openBalanceCents: centsSchema,
    }),
  ),
  totalCents: centsSchema,
  subledgerOutOfTie: z.boolean(),
});
export type PortalAging = z.infer<typeof portalAgingSchema>;

export const portalBudgetSchema = z.object({
  periodStart: daySchema.nullable(),
  items: z.array(
    z.object({
      accountNumber: z.string(),
      accountName: z.string(),
      actualCents: centsSchema,
      budgetCents: centsSchema,
      varianceCents: centsSchema,
      direction: z.enum(["favorable", "unfavorable", "neutral"]),
      flagged: z.boolean(),
      detail: z.string(),
    }),
  ),
  budgetLineCount: z.number().int(),
});
export type PortalBudget = z.infer<typeof portalBudgetSchema>;

export const portalForecastSchema = z.object({
  run: z
    .object({
      id: idSchema,
      scenario: z.enum(["base", "slow_collections", "revenue_shortfall"]),
      startDate: daySchema,
      endDate: daySchema,
      horizonWeeks: z.number().int(),
      openingCashCents: centsSchema,
      closingCashCents: centsSchema,
      firstShortfallWeek: z.number().int().nullable(),
      builtAt: z.string(),
    })
    .nullable(),
  weeks: z.array(
    z.object({
      weekNumber: z.number().int(),
      weekStart: daySchema,
      weekEnd: daySchema,
      openingCents: centsSchema,
      inflowCents: centsSchema,
      outflowCents: centsSchema,
      closingCents: centsSchema,
      shortfall: z.boolean(),
    }),
  ),
  /** Every stored run, newest first, so the scenarios screen can list them. */
  runs: z.array(
    z.object({
      id: idSchema,
      scenario: z.enum(["base", "slow_collections", "revenue_shortfall"]),
      startDate: daySchema,
      closingCashCents: centsSchema,
      firstShortfallWeek: z.number().int().nullable(),
      builtAt: z.string(),
    }),
  ),
});
export type PortalForecast = z.infer<typeof portalForecastSchema>;

export const portalNarrativeSchema = z.object({
  items: z.array(
    z.object({
      id: idSchema,
      periodStart: daySchema,
      audience: z.enum(["owner", "lender"]),
      bodyText: z.string(),
      sentenceCount: z.number().int(),
      composedAt: z.string(),
    }),
  ),
});
export type PortalNarrative = z.infer<typeof portalNarrativeSchema>;

export const portalReportsSchema = z.object({
  items: z.array(
    z.object({
      id: idSchema,
      periodStart: daySchema,
      basis: z.enum(["accrual", "cash"]),
      state: z.enum(["draft", "superseded"]),
      sectionCount: z.number().int(),
      closedWithExceptions: z.boolean(),
      builtAt: z.string(),
    }),
  ),
  /** False until object storage exists, so a package cannot be downloaded yet. */
  storageConfigured: z.boolean(),
});
export type PortalReports = z.infer<typeof portalReportsSchema>;

export const portalPeriodsSchema = z.object({
  items: z.array(
    z.object({
      periodStart: daySchema,
      status: z.string(),
      lockedAt: z.string().nullable(),
    }),
  ),
});
export type PortalPeriods = z.infer<typeof portalPeriodsSchema>;

/* ---------------- Run actions from the portal ---------------- */

/**
 * What every portal action answers: the preview outcome, the apply outcome
 * when the preview held, and done. A refused run is done false with the
 * engine's own error codes on preview.errors.
 */
export interface PortalActionResult {
  preview: import("./runs").RunOutcomeDto;
  applied: import("./runs").RunOutcomeDto | null;
  done: boolean;
}

/** The sentence a screen shows for a refused action. */
export function actionFailureText(r: PortalActionResult): string | null {
  if (r.done) return null;
  const errs = [...(r.applied?.errors ?? []), ...r.preview.errors];
  return errs[0] ? errs[0].message : "The action did not complete.";
}
