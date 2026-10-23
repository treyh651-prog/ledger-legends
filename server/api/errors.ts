/**
 * One error translator for the whole API.
 *
 * Every failure leaves as `{ error: { code, message, details? } }` with a
 * status the code implies, and never a stack trace. The engine's typed errors
 * map here once, so a route never has to know that a locked period is a 409
 * and a check violation is a 422.
 *
 * Doc 11 carries the same table in prose. Keep the two in step.
 */

import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import type { ApiErrorCode } from "../../shared/api/common";
import {
  CheckViolation,
  ImmutableLogError,
  LockedPeriodError,
  OverrideProtectedError,
  SerializationFailure,
  UniqueViolation,
} from "../runs/db";
import { FeatureNotInTierError } from "../entitlement";
import { RunDbConfigError } from "../db/run-db";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function notFound(what: string): ApiFailure {
  return new ApiFailure(404, "not_found", `No such ${what}.`);
}

export function notConfigured(message: string): ApiFailure {
  return new ApiFailure(501, "not_configured", message);
}

export interface Translated {
  status: number;
  code: ApiErrorCode | string;
  message: string;
  details?: unknown;
}

/**
 * The map. Order matters only where one class extends another, which none of
 * these do.
 */
export function translate(err: unknown): Translated {
  if (err instanceof ApiFailure) {
    return { status: err.status, code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      code: "validation_failed",
      message: "The request did not validate.",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  if (err instanceof FeatureNotInTierError) {
    return { status: 403, code: "feature_not_included", message: err.message };
  }
  if (err instanceof LockedPeriodError) {
    return { status: 409, code: "locked_period", message: err.message };
  }
  if (err instanceof OverrideProtectedError) {
    return { status: 409, code: "override_protected", message: err.message };
  }
  if (err instanceof UniqueViolation) {
    return { status: 409, code: "unique_violation", message: err.message };
  }
  if (err instanceof CheckViolation) {
    return { status: 422, code: "check_violation", message: err.message };
  }
  if (err instanceof ImmutableLogError) {
    return { status: 409, code: "check_violation", message: err.message };
  }
  if (err instanceof SerializationFailure) {
    // The engine already retried the run. A read that lost the race is told
    // to ask again, which the client hook does once.
    return { status: 503, code: "serialization_failure", message: "The database was busy. Try again." };
  }
  if (err instanceof RunDbConfigError) {
    return { status: 500, code: "internal", message: err.message };
  }
  const body = err as { status?: unknown; code?: unknown; type?: unknown };
  if (body && body.type === "entity.parse.failed") {
    return { status: 400, code: "validation_failed", message: "The request body is not valid JSON." };
  }
  if (body && body.type === "entity.too.large") {
    return { status: 413, code: "payload_too_large", message: "The request body is too large." };
  }
  return { status: 500, code: "internal", message: "Something went wrong on the server." };
}

export function sendError(res: Response, err: unknown): void {
  const t = translate(err);
  const payload: { error: { code: string; message: string; details?: unknown } } = {
    error: { code: t.code, message: t.message },
  };
  if (t.details !== undefined) payload.error.details = t.details;
  res.status(t.status).json(payload);
}

/** The Express error handler. Mount last. */
export function apiErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);
  const t = translate(err);
  if (t.status >= 500 && t.code === "internal") {
    // The one place a server side failure is logged, message only.
    console.error("[api]", err instanceof Error ? err.message : String(err));
  }
  sendError(res, err);
}

/**
 * Serializable reads lose a race once in a while. One retry, as the brief
 * says, and then the honest 503.
 */
export async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SerializationFailure) return fn();
    throw err;
  }
}
