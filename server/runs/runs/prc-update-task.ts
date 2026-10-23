/**
 * PRAC-UPDATE-TASK v1.
 *
 * A person at the firm moves one practice task by hand: marks it complete,
 * reopens it, or hands it to another member. Before this run the workload
 * board edited a fixture in browser memory and nothing read the edit. Now the
 * change is a run like every other write, with an intent row, a preview the
 * apply has to agree with, and an undo plan.
 *
 * One proposal: a field write on practice.tasks. The state enumeration from
 * doc 02 is unchanged. Only open and complete are reachable by hand; blocked
 * is set by the generator from the gate dependency and is not a thing a
 * person declares. The task keeps its manual_override flag so the generator
 * and the escalation ladder leave a hand touched row alone.
 *
 * Idempotency. The scope carries the task id and the requested values, so the
 * same change twice hashes the same and the engine deduplicates it. A change
 * that would leave every field as it is proposes nothing and skips, which is
 * what the board sees when it asks for the state a task already has.
 *
 * Undo. The field write records the before image, so the standard undo plan
 * restores the previous state and assignee.
 */

import { z } from "zod";
import {
  makeResult,
  type FrozenScope,
  type Proposal,
  type ProposedFieldWrite,
  type Run,
  type RunError,
  type RunResult,
  type Skip,
} from "../contract";
import { applyProposals, requireTx } from "../apply-writer";
import { scopeHashFor } from "../ids";
import { revertFieldWrite } from "../undo";

export const updateTaskScopeSchema = z
  .object({
    clientId: z.string().min(1),
    taskId: z.string().min(1),
    /** Leave out to keep the state as it is. */
    state: z.enum(["open", "complete"]).optional(),
    /** Leave out to keep the assignee. Null clears it. */
    assigneeId: z.string().min(1).nullable().optional(),
  })
  .refine((s) => s.state !== undefined || s.assigneeId !== undefined, {
    message: "a task update names a state, an assignee, or both",
  });

export type UpdateTaskScope = z.infer<typeof updateTaskScopeSchema>;

export const ERR_TASK_NOT_FOUND = "PRAC-TASK-NOT-FOUND";
export const ERR_TASK_BLOCKED = "PRAC-TASK-BLOCKED";

export const prcUpdateTask: Run<UpdateTaskScope, Proposal> = {
  type: "PRAC-UPDATE-TASK",
  version: 1,
  writesLedger: false,
  requiresOpenPeriod: false,
  concurrencyKey: (scope) => `${scope.clientId}:practice-task:${scope.taskId}`,
  scopeSchema: updateTaskScopeSchema,

  async resolveScope(scope, ctx): Promise<FrozenScope<UpdateTaskScope>> {
    const tx = requireTx(ctx);
    const rows = await tx.query("practice_tasks_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const row = rows.find((r) => r.id === scope.taskId);
    const candidateIds = [scope.taskId];
    const versions = [{ id: "PRAC-UPDATE-TASK", version: 1 }];
    const day = ctx.now.toISOString().slice(0, 10);
    return {
      input: { ...scope },
      clientId: scope.clientId,
      firmId: ctx.firmId,
      periodStart: row ? row.periodStart : day,
      periodEnd: row ? row.periodEnd : day,
      candidateIds,
      scopeHash: scopeHashFor({
        candidateIds,
        versions,
        period: [
          row ? `${row.state}:${row.assigneeId ?? ""}` : "missing",
          scope.state ?? "",
          scope.assigneeId === undefined ? "" : scope.assigneeId ?? "none",
        ].join("/"),
      }),
      versions,
      overriddenIds: [],
    };
  },

  async propose(frozen, ctx): Promise<RunResult<Proposal>> {
    const tx = requireTx(ctx);
    const scope = frozen.input;
    const errors: RunError[] = [];
    const rows = await tx.query("practice_tasks_for_client", { firmId: ctx.firmId, clientId: scope.clientId });
    const row = rows.find((r) => r.id === scope.taskId);
    if (!row) {
      errors.push({
        rowId: scope.taskId,
        code: ERR_TASK_NOT_FOUND,
        message: `task ${scope.taskId} is not one of this client's tasks`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }
    if (scope.state === "complete" && row.state === "blocked") {
      errors.push({
        rowId: row.id,
        code: ERR_TASK_BLOCKED,
        message: `task ${row.id} is blocked by ${row.blockedByCode ?? "another task"} and cannot be completed until that clears`,
        retryable: false,
      });
      return makeResult<Proposal>(1, [], [], errors, BigInt(0));
    }
    const nextState = scope.state ?? row.state;
    const nextAssignee = scope.assigneeId === undefined ? row.assigneeId : scope.assigneeId;
    const today = ctx.now.toISOString().slice(0, 10);
    const nextCompletedOn = nextState === "complete" ? (row.completedOn ?? today) : null;
    const nextReason =
      scope.assigneeId !== undefined && scope.assigneeId !== row.assigneeId
        ? "Reassigned by hand from the workload board."
        : row.assignmentReason;
    const unchanged =
      nextState === row.state &&
      nextAssignee === row.assigneeId &&
      nextCompletedOn === row.completedOn &&
      row.manualOverride;
    if (unchanged) {
      const skip: Skip = { rowId: row.id, reason: "already_applied", detail: "the task already has the requested state and assignee" };
      return makeResult<Proposal>(1, [], [skip], [], BigInt(0));
    }
    const write: ProposedFieldWrite = {
      kind: "field_write",
      table: "practice_tasks",
      rowId: row.id,
      before: {
        state: row.state,
        assigneeId: row.assigneeId,
        assignmentReason: row.assignmentReason,
        completedOn: row.completedOn,
        manualOverride: row.manualOverride,
      },
      after: {
        state: nextState,
        assigneeId: nextAssignee,
        assignmentReason: nextReason,
        completedOn: nextCompletedOn,
        manualOverride: true,
      },
      provenance: { cascadeLevel: null },
    };
    return makeResult<Proposal>(1, [write], [], [], BigInt(0));
  },

  async apply(proposals, ctx): Promise<void> {
    await applyProposals(proposals, ctx, { runType: "PRAC-UPDATE-TASK", runVersion: 1 });
  },

  async undoPlan(proposals): Promise<Proposal[]> {
    return proposals.filter((p) => p.kind === "field_write").map(revertFieldWrite);
  },
};
