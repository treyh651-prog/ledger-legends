/**
 * What a client is entitled to, read from the active engagement.
 *
 * The tier vocabulary lives in shared/tiers.ts and the rows live in
 * tenancy.service_tiers and tenancy.tier_features (migration 0024). The view
 * tenancy.client_entitlements joins the two through the active engagement
 * and derives inclusion by rank, so this module never decides what a tier
 * includes. It reads the answer and shapes it for a caller.
 *
 * Two sources implement the same small port. The Postgres one reads the
 * view. The memory one derives the same rows from engagement records using
 * the same shared map, so a test can exercise every decision here without a
 * database. Both return the view's shape.
 *
 * Add ons (payroll, cleanup) are not here. They grant no feature, the view
 * does not read them, and the memory source accepts them only to prove that
 * they change nothing.
 */

import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import {
  FEATURE_BY_ID,
  TIER_ORDER,
  TIERS,
  featuresForTier,
  isTierId,
  tierRank,
  type AddonId,
  type FeatureKey,
  type TierId,
} from "../../shared/tiers";

/** One row of tenancy.client_entitlements. */
export interface EntitlementRow {
  clientId: string;
  tierId: TierId;
  rank: number;
  featureKey: string;
}

/** The shape a route or a screen asks about. */
export interface Entitlement {
  clientId: string;
  /** Null when the client has no active engagement. Nothing is granted then. */
  tier: TierId | null;
  rank: number;
  features: ReadonlySet<string>;
}

export interface EntitlementSource {
  rowsForClient(clientId: string): Promise<EntitlementRow[]>;
}

/* ---------------- Postgres ---------------- */

export const CLIENT_ENTITLEMENTS_SQL = `select client_id as "clientId", tier_id as "tierId", rank, feature_key as "featureKey"
  from tenancy.client_entitlements
 where client_id = $1::uuid
 order by feature_key asc`;

export class PostgresEntitlementSource implements EntitlementSource {
  constructor(private readonly pool: Pool) {}

  async rowsForClient(clientId: string): Promise<EntitlementRow[]> {
    const result = await this.pool.query<EntitlementRow>(CLIENT_ENTITLEMENTS_SQL, [clientId]);
    return result.rows.map((r) => ({ ...r, rank: Number(r.rank) }));
  }
}

/* ---------------- Memory ---------------- */

export interface MemoryEngagement {
  clientId: string;
  serviceLevel: string;
  status: "draft" | "sent" | "signed" | "active" | "terminated";
  /** ISO date. */
  startDate: string;
  endDate: string | null;
}

export interface MemoryAddon {
  clientId: string;
  addon: AddonId;
  startedAt: string;
  endedAt: string | null;
}

export class UnknownServiceLevelError extends Error {
  readonly code = "UNKNOWN_SERVICE_LEVEL";
  constructor(level: string) {
    super(
      `service_level ${level} is not one of ${TIER_ORDER.join(", ")}. The database refuses it with a foreign key violation; the memory source refuses it here.`,
    );
  }
}

/**
 * Derives the view's rows from engagement records. Mirrors the view's where
 * clause: status active and dates covering today. Refuses a level the
 * database would refuse, so the memory port cannot be more lenient than the
 * constraint it stands in for.
 */
export class MemoryEntitlementSource implements EntitlementSource {
  constructor(
    private readonly engagements: MemoryEngagement[],
    // Accepted and ignored, on purpose. See the file comment.
    private readonly addons: MemoryAddon[] = [],
    private readonly today: string = new Date().toISOString().slice(0, 10),
  ) {
    for (const e of engagements) {
      if (!isTierId(e.serviceLevel)) throw new UnknownServiceLevelError(e.serviceLevel);
    }
  }

  /** How many add ons are on file. Exists so a test can show they are counted and still grant nothing. */
  addonCount(clientId: string): number {
    return this.addons.filter((a) => a.clientId === clientId && a.endedAt === null).length;
  }

  async rowsForClient(clientId: string): Promise<EntitlementRow[]> {
    const active = this.engagements.filter(
      (e) =>
        e.clientId === clientId &&
        e.status === "active" &&
        e.startDate <= this.today &&
        (e.endDate === null || e.endDate >= this.today),
    );
    if (active.length > 1) {
      throw new Error(`client ${clientId} has ${String(active.length)} active engagements; the database allows one`);
    }
    const e = active[0];
    if (!e || !isTierId(e.serviceLevel)) return [];
    const tier: TierId = e.serviceLevel;
    return featuresForTier(tier)
      .map((f) => ({ clientId, tierId: tier, rank: tierRank(tier), featureKey: f.id }))
      .sort((a, b) => (a.featureKey < b.featureKey ? -1 : 1));
  }
}

/* ---------------- Loading and asking ---------------- */

export async function loadEntitlement(source: EntitlementSource, clientId: string): Promise<Entitlement> {
  const rows = await source.rowsForClient(clientId);
  if (rows.length === 0) {
    return { clientId, tier: null, rank: -1, features: new Set() };
  }
  const first = rows[0];
  return {
    clientId,
    tier: first.tierId,
    rank: first.rank,
    features: new Set(rows.map((r) => r.featureKey)),
  };
}

export function entitles(ent: Entitlement, key: FeatureKey): boolean {
  return ent.features.has(key);
}

export class FeatureNotInTierError extends Error {
  readonly code = "FEATURE_NOT_IN_TIER";
  readonly status = 403;
  constructor(
    readonly clientId: string,
    readonly key: FeatureKey,
    readonly tier: TierId | null,
  ) {
    super(
      tier === null
        ? `client ${clientId} has no active engagement, so ${key} is not available`
        : `${FEATURE_BY_ID[key].label} is part of ${TIERS[FEATURE_BY_ID[key].minTier].name} and this engagement is ${TIERS[tier].name}`,
    );
  }
}

/** Throws when the entitlement does not include the feature. */
export function assertFeature(ent: Entitlement, key: FeatureKey): void {
  if (!entitles(ent, key)) throw new FeatureNotInTierError(ent.clientId, key, ent.tier);
}

/**
 * Route middleware for the coming API layer.
 *
 * The caller says how to find the entitlement for a request, because that
 * depends on how the route names its client and on the auth brief's actor
 * shape, neither of which this module owns. The loaded entitlement is left
 * on res.locals.entitlement so the handler can read it without a second
 * query. A refusal is a 403 with a code and a plain sentence, never a
 * redirect to anything that sells.
 */
export function requireFeature(
  key: FeatureKey,
  resolve: (req: Request) => Promise<Entitlement>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    resolve(req)
      .then((ent) => {
        if (!entitles(ent, key)) {
          const err = new FeatureNotInTierError(ent.clientId, key, ent.tier);
          res.status(err.status).json({ code: err.code, message: err.message });
          return;
        }
        res.locals.entitlement = ent;
        next();
      })
      .catch(next);
  };
}
