/**
 * The firm home screen. One read, one shape, every number traced to a table.
 */

import { z } from "zod";
import { clientSummarySchema } from "./clients";
import { daySchema, idSchema, instantSchema } from "./common";
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
});
export type FirmOverview = z.infer<typeof firmOverviewSchema>;
