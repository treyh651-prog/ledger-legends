/**
 * A person reading or triggering from the interface.
 *
 * The run port's TxSession carries a human actor kind and no run id. In
 * Postgres that becomes app.user_id for RLS and an empty app.run_id so the
 * override guard stays disarmed, and the pool role is switched by
 * PostgresRunDb when APP_DB_ROLE is set, which is what withActor does for the
 * auth module's own reads. In memory it is the same session the tests use.
 */

import type { Actor } from "../db/with-actor";
import type { RunActor } from "../runs/contract";
import type { TxSession } from "../runs/db";

export function readSession(actor: Pick<Actor, "userId">, firmId: string, clientId: string): TxSession {
  return {
    isolation: "repeatable read",
    readOnly: true,
    firmId,
    clientId,
    actorId: actor.userId,
    actorKind: "human",
  };
}

/** The actor a run is told about. A person at a screen. */
export function runActor(actor: Pick<Actor, "userId">): RunActor {
  return { kind: "human", userId: actor.userId };
}
