/**
 * Runs, as a screen triggers and reads them.
 *
 * A write from the interface is a run. The body names the mode and carries the
 * scope the run's own schema validates, so this contract does not repeat 49
 * scope shapes. The outcome is the engine's RunOutcome with BigInt cents made
 * JSON safe and the proposal list carried as the engine logged it.
 */

import { z } from "zod";
import { centsSchema, daySchema, idSchema, instantSchema, pageQuerySchema } from "./common";

export const RUN_MODES = ["preview", "apply"] as const;
export const runModeSchema = z.enum(RUN_MODES);
export type RunMode = z.infer<typeof runModeSchema>;

export const RUN_STATUSES = [
  "completed",
  "completed_with_skips",
  "no_op",
  "refused",
  "rejected_locked",
  "failed",
  "deduplicated",
  "started",
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const RUN_TIERS = ["unattended", "propose", "manual"] as const;
export const runTierSchema = z.enum(RUN_TIERS);

export const runSkipSchema = z.object({
  rowId: idSchema,
  reason: z.string(),
  detail: z.string(),
});

export const runErrorSchema = z.object({
  rowId: idSchema.nullable(),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

export const runOutcomeSchema = z.object({
  executionId: z.string(),
  runType: z.string(),
  runVersion: z.number().int(),
  mode: runModeSchema,
  status: runStatusSchema,
  idempotencyKey: z.string(),
  scopeHash: z.string(),
  candidateCount: z.number().int(),
  proposals: z.array(z.unknown()),
  skips: z.array(runSkipSchema),
  errors: z.array(runErrorSchema),
  netCents: centsSchema,
  overriddenInScope: z.number().int(),
  entriesCreated: z.number().int(),
  entriesReversed: z.number().int(),
  attempts: z.number().int(),
  deduplicatedFrom: z.string().optional(),
  lockHolder: z.string().optional(),
  startedAt: instantSchema,
  finishedAt: instantSchema,
});
export type RunOutcomeDto = z.infer<typeof runOutcomeSchema>;

export const runParamsSchema = z.object({
  clientId: idSchema,
  runCode: z.string().regex(/^[A-Z0-9]+(-[A-Z0-9]+)+$/, "a run code like TXN-APPLY-RULES"),
});

export const triggerRunBodySchema = z.object({
  mode: runModeSchema.default("preview"),
  /** Required for apply, unless the run policy does not call for one. */
  previewRunId: z.string().optional(),
  /** The run's own scope. firmId and clientId are set by the route. */
  scope: z.record(z.string(), z.unknown()).default({}),
});
export type TriggerRunBody = z.infer<typeof triggerRunBodySchema>;
export type TriggerRunInput = z.input<typeof triggerRunBodySchema>;

export const logParamsSchema = z.object({ logId: z.string().min(1) });

export const applyBodySchema = z.object({}).passthrough();

export const undoBodySchema = z.object({
  reason: z.string().trim().min(1).max(500).default("undone from the interface"),
});

export const runHistoryItemSchema = z.object({
  executionId: z.string(),
  runType: z.string(),
  runVersion: z.number().int(),
  mode: runModeSchema,
  status: runStatusSchema,
  actorId: z.string(),
  actorKind: z.string(),
  source: z.string(),
  previewRunId: z.string().nullable(),
  originalRunId: z.string().nullable(),
  periodStart: daySchema,
  periodEnd: daySchema,
  candidateCount: z.number().int(),
  proposalCount: z.number().int(),
  skipCount: z.number().int(),
  errorCount: z.number().int(),
  startedAt: instantSchema,
  finishedAt: instantSchema.nullable(),
  tier: runTierSchema.nullable(),
  canApply: z.boolean(),
  canUndo: z.boolean(),
});
export type RunHistoryItem = z.infer<typeof runHistoryItemSchema>;

export const runHistoryQuerySchema = pageQuerySchema.extend({
  runType: z.string().optional(),
});

export const runHistorySchema = z.object({
  items: z.array(runHistoryItemSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type RunHistory = z.infer<typeof runHistorySchema>;

/** What the catalog screen lists: every registered run with its tier. */
export const runCatalogItemSchema = z.object({
  runType: z.string(),
  version: z.number().int(),
  writesLedger: z.boolean(),
  requiresOpenPeriod: z.boolean(),
  tier: runTierSchema,
  reason: z.string(),
  /** True when a client scoped actor may trigger it. */
  clientSide: z.boolean(),
});
export const runCatalogSchema = z.object({ items: z.array(runCatalogItemSchema) });
export type RunCatalogItem = z.infer<typeof runCatalogItemSchema>;
