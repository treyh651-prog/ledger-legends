/**
 * The firm home screen. One read, one shape, every number traced to a table.
 */

import { z } from "zod";
import { clientSummarySchema } from "./clients";
import { centsSchema, daySchema, idSchema, instantSchema } from "./common";
import { runStatusSchema } from "./runs";

export const overviewRunSchema = z.object({
  executionId: z.string(),
  clientId: idSchema,
  clientName: z.string(),
  runType: z.string(),
  mode: z.enum(["preview", "apply"]),
  status: runStatusSchema,
  startedAt: instantSchema,
});

/** One month of net cash movement across every client's cash accounts. */
export const monthlyCashFlowSchema = z.object({
  month: daySchema,
  netCashCents: centsSchema,
});
export type MonthlyCashFlow = z.infer<typeof monthlyCashFlowSchema>;

export const firmOverviewSchema = z.object({
  asOf: daySchema,
  clients: z.array(clientSummarySchema),
  totals: z.object({
    clients: z.number().int(),
    onboarding: z.number().int(),
    active: z.number().int(),
    openRequests: z.number().int(),
    openSuspense: z.number().int(),
    openTasks: z.number().int(),
    periodsAwaitingClose: z.number().int(),
  }),
  recentRuns: z.array(overviewRunSchema),
  /** The trailing six months, oldest first, including the current one. */
  cashFlowTrend: z.array(monthlyCashFlowSchema),
});
export type FirmOverview = z.infer<typeof firmOverviewSchema>;
