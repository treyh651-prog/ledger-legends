-- 0030_practice_update_task.sql
--
-- The workload board on the API, screens cleanup. One new manual run.
--
--   PRAC-UPDATE-TASK. A person at the firm completes, reopens, or reassigns
--   one practice task from the board. The run is a field write on
--   practice.tasks: state, assignee_id, assignment_reason, completed_on, and
--   manual_override set true so the generator and the escalation ladder leave
--   a hand touched row alone. No column changes. The state check from the
--   practice migration is unchanged, only open and complete are reachable by
--   hand and blocked stays the generator's to set.
--
-- The policy row is the only thing this migration writes. The run is
-- registered in server/runs/registry.ts and script/check-schema.ts compares
-- this table against RUN_POLICIES in server/runs/policy.ts.

begin;

insert into sched.run_policies (run_type, tier, reason, writes_ledger) values
  ('PRAC-UPDATE-TASK', 'manual', 'a person at the firm completes, reopens, or reassigns one task from the board, and a clock has no opinion on that', false)
on conflict (run_type) do nothing;

commit;
