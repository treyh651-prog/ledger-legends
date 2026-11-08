-- 0071_pay_run_g18_override.sql
--
-- Audit finding (rerun, 2026-11-06): PAY-APPROVE-RUN refuses outright when
-- the approver is the same person who prepared the register (G18
-- separation of duties), with no override path at all -- confirmed by
-- reading pay-approve-run.ts directly, the refusal is a hard error with
-- no manual_override check anywhere near it. A one or two person firm can
-- record a payroll register and never approve it.
--
-- Deliberately a new, standalone column rather than reusing
-- manual_override/manual_override_by/manual_override_at: those three are
-- the generic "this row is frozen" trigger (ledger.guard_manual_override,
-- migration 0003) that refuses *any* further run-mediated write once set,
-- with no column scoping at all -- "a row carrying the manual override
-- flag is invisible to every run except as a skip." Setting it here would
-- permanently block PAY-POST-REGISTER from ever posting this exact run
-- afterward, which is the opposite of what an approval override needs to
-- do. g18_override_reason is independent of that mechanism entirely: its
-- own non-null-ness is the only signal, the same way close.close_gate_results'
-- override_reason sits beside (not instead of) that table's own
-- manual_override triple, but here there is no companion boolean to pair
-- it with -- a solo approval is still a normal, postable pay run.

begin;

alter table subledger.pay_runs
  add column g18_override_reason text;

commit;
