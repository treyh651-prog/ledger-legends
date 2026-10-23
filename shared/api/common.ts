/**
 * Shapes every resource area shares.
 *
 * Both sides import from here. The server validates a request with the same
 * schema the client used to build it, and the client parses a response with
 * the same schema the server used to shape it, so a screen cannot drift from
 * a route without a type error on one side or the other.
 *
 * Conventions, repeated in docs/11-api.md:
 *   money is integer cents carried as a JSON number,
 *   dates are ISO strings, calendar days as YYYY-MM-DD and instants in full,
 *   ids are the strings the tables hold, ULID or uuid, never parsed further.
 */

import { z } from "zod";

/** A ULID or a uuid. Both are opaque strings to the interface. */
export const idSchema = z.string().min(1).max(64);

/** A calendar day. */
export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** An instant, ISO 8601 with offset. */
export const instantSchema = z.string().min(20);

/** Integer cents. BigInt on the engine side, a safe integer on the wire. */
export const centsSchema = z.number().int().safe();

/** Every error the API returns has this one shape, and nothing else. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    /** Zod issues or an engine detail, when there is one worth showing. */
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** The error codes the translator emits. See server/api/errors.ts. */
export const API_ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "firm_required",
  "client_required",
  "feature_not_included",
  "not_found",
  "validation_failed",
  "locked_period",
  "override_protected",
  "check_violation",
  "unique_violation",
  "serialization_failure",
  "run_refused",
  "run_locked",
  "not_configured",
  "internal",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    limit: z.number().int().min(1),
    offset: z.number().int().min(0),
  });
}

export const clientParamsSchema = z.object({ clientId: idSchema });
export type ClientParams = z.infer<typeof clientParamsSchema>;

/** A period is named by its first day, as the close tables do. */
export const periodQuerySchema = z.object({
  period: daySchema.optional(),
});
