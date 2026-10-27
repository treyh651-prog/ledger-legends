import type { Handler } from "@netlify/functions";
import { resolveRunDb } from "../../server/db/run-db";
import { continueClientOnboarding } from "../../server/api/runs";
import type { Actor } from "../../server/db/with-actor";
import type { CreateClientBody } from "../../shared/api/clients";

/**
 * The chart, the workload, and the first document requests, the three
 * intake steps dispatchOnboardingContinuation hands here instead of running
 * in the same request that created the client. Background functions carry a
 * fifteen minute budget rather than a synchronous function's roughly twenty
 * nine seconds (the proxy limit actually hit creating a client end to end
 * against real Postgres, confirmed directly, not Netlify's own longer
 * stated limit), which this cascade fits inside with room to spare.
 *
 * The filename suffix `-background` is what tells Netlify to run this as a
 * background function; nothing in this file's own code does that. Netlify's
 * own routing answers every caller with an empty 202 before this body has
 * even started, so there is no response a caller can read here, only the
 * database this writes to, which is the same one the client's own screens
 * poll (chartAccounts on the client stays zero until INTAKE-BUILD-CHART
 * applies, which is what the frontend's refetchInterval watches for).
 *
 * This is reachable at its own public URL in principle, so the shared
 * secret header is what keeps it a call only this application's own API
 * makes, not a check on who the original signed in user was; the actor it
 * runs as is exactly the one the first, properly authenticated request
 * already resolved and is passing through.
 */
export const handler: Handler = async (event) => {
  const secret = process.env.ONBOARDING_BACKGROUND_SECRET;
  if (!secret || event.headers["x-internal-secret"] !== secret) {
    console.error("[onboarding-background] refused: missing or wrong secret");
    return { statusCode: 401, body: "" };
  }

  let payload: {
    clientId: string;
    firmId: string;
    actor: { userId: string; email: string; displayName: string | null };
    body: CreateClientBody;
    now: string;
  };
  try {
    const raw = event.body ?? "";
    payload = JSON.parse(raw);
  } catch {
    console.error("[onboarding-background] refused: body did not parse as JSON");
    return { statusCode: 400, body: "" };
  }

  const actor: Actor = {
    userId: payload.actor.userId,
    authSubject: "",
    email: payload.actor.email,
    displayName: payload.actor.displayName,
    memberships: [],
  };

  try {
    const runDb = resolveRunDb();
    const result = await continueClientOnboarding(
      runDb.db,
      actor,
      payload.firmId,
      payload.clientId,
      payload.body,
      new Date(payload.now),
    );
    console.log(
      `[onboarding-background] client ${payload.clientId}: complete=${result.complete}, runs=${result.runs.map((r) => `${r.runType}:${r.mode}:${r.status}`).join(", ")}`,
    );
  } catch (err) {
    console.error(`[onboarding-background] client ${payload.clientId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { statusCode: 200, body: "" };
};
