import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, Meter, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useCloseChecklist, useRunCloseChecks, useTriggerRun, errorMessage, periodStartOf, screenKeys } from "@/api";
import { fmtPeriod, fmtShortDate, fmtTimestamp } from "@/lib/money";
import type { CloseGate, CloseTask, Tieout } from "@shared/api";

/**
 * The close checklist for one client and period, read from
 * GET /api/firm/clients/:id/close. Tasks come from practice.tasks, gates from
 * close.gate_results, tie outs from close.sub_tieouts. The screen counts and
 * shows; the close runs decide.
 */
export default function CloseChecklist() {
  const { period } = useApp();
  const { client, clientId } = useActiveClient();
  const q = useCloseChecklist(clientId, period);
  const d = q.data;

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const canLock = d !== undefined && d.periodStatus !== "locked" && d.gates.length > 0 && d.gates.every((g) => g.outcome === "pass" || g.outcome === "not_applicable" || g.manualOverride);

  const tasks = d?.tasks ?? [];
  const done = tasks.filter((t) => t.state === "complete").length;
  const pctDone = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const passing = (d?.gates ?? []).filter((g) => g.outcome === "pass").length;

  const taskTone = (t: CloseTask) => (t.state === "complete" ? "good" : t.state === "blocked" ? "risk" : "watch");
  const gateTone = (g: CloseGate) => (g.outcome === "pass" ? "good" : g.outcome === "fail" ? "risk" : "watch");
  const tieTone = (t: Tieout) => (t.state === "computed_tied" ? "good" : t.state === "variance_open" ? "risk" : "watch");

  return (
    <div className="space-y-4" data-testid="page-close-checklist">
      <PageHeader
        title="Close checklist"
        subtitle={
          d
            ? `${client?.name ?? ""}, ${fmtPeriod(period)}. Period ${d.periodStatus === "none" ? "not opened yet" : d.periodStatus}${
                d.lockedAt ? `, locked ${fmtTimestamp(d.lockedAt)}` : ""
              }.`
            : `${client?.name ?? ""}, ${fmtPeriod(period)}.`
        }
        actions={
          clientId ? (
            <div className="flex gap-2">
              {d && d.periodStatus !== "locked" ? <RunCloseChecksButton clientId={clientId} period={period} /> : null}
              {d && d.periodStatus === "locked" ? <PostYearEndDialog clientId={clientId} period={period} /> : null}
              {canLock ? <LockPeriodButton clientId={clientId} period={period} /> : null}
            </div>
          ) : null
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Tasks complete" value={d ? `${done} of ${tasks.length}` : "…"} hint={d ? <Meter pct={pctDone} /> : undefined} testId="kpi-tasks" />
        <Kpi label="Gates passing" value={d ? `${passing} of ${d.gates.length}` : "…"} tone={d && passing === d.gates.length && d.gates.length > 0 ? "good" : "neutral"} />
        <Kpi label="Open suspense" value={d ? d.openSuspense : "…"} tone={d && d.openSuspense > 0 ? "watch" : "neutral"} />
        <Kpi label="Open requests" value={d ? d.openRequests : "…"} hint={d ? `${d.openBatches} reconciliation ${d.openBatches === 1 ? "batch" : "batches"} not reconciled` : undefined} />
      </div>

      <SectionCard title="Tasks" description="From practice.tasks for this period, due date ascending.">
        <DataGrid<CloseTask>
          rows={tasks}
          loading={q.isPending}
          rowKey={(t) => t.id}
          testId="grid-close-tasks"
          empty={<EmptyState title="No tasks for this period" body="INTAKE-SEED-TASKS and PRC-GENERATE-WORK write the checklist when the period opens." />}
          cols={[
            {
              key: "state",
              label: "",
              mobile: "row",
              render: (t) => (t.state === "complete" ? <CheckCircle2 className="h-4 w-4 text-success" /> : <CircleDashed className="h-4 w-4 text-muted-foreground" />),
            },
            { key: "title", label: "Task", mobile: "title", render: (t) => <span className="font-medium">{t.title}</span> },
            { key: "role", label: "Role", mobile: "row", render: (t) => <span className="text-xs capitalize">{t.role}</span> },
            { key: "gate", label: "Gate", mobile: "row", render: (t) => <span className="text-xs">{t.gateCode ?? ""}</span> },
            { key: "due", label: "Due", mobile: "row", render: (t) => <span className="tnum text-xs">{fmtShortDate(t.dueDate)}</span> },
            {
              key: "status",
              label: "Status",
              mobile: "value",
              render: (t) => (
                <Pill tone={taskTone(t)}>
                  {t.state}
                  {t.blockedByCode ? ` by ${t.blockedByCode}` : ""}
                </Pill>
              ),
            },
          ]}
        />
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Gates" description="Latest evaluation of each close gate.">
          <DataGrid<CloseGate>
            rows={d?.gates ?? []}
            loading={q.isPending}
            rowKey={(g) => g.gateCode}
            testId="grid-close-gates"
            empty={<EmptyState title="No gates evaluated" body="CLS-EVALUATE-GATES writes a result per gate when it runs." />}
            cols={[
              { key: "code", label: "Gate", mobile: "title", render: (g) => <span className="font-medium">{g.gateTitle}</span> },
              { key: "blocking", label: "Blocking", align: "right", mobile: "row", render: (g) => <span className="tnum">{g.blockingCount}</span> },
              { key: "at", label: "Evaluated", mobile: "row", render: (g) => <span className="text-xs">{fmtTimestamp(g.evaluatedAt)}</span> },
              {
                key: "outcome",
                label: "Outcome",
                mobile: "value",
                render: (g) =>
                  g.manualOverride ? (
                    <Pill tone="watch">overridden</Pill>
                  ) : (
                    <Pill tone={gateTone(g)}>{g.outcome}</Pill>
                  ),
              },
              {
                key: "override",
                label: "",
                mobile: "row",
                render: (g) =>
                  g.outcome === "fail" && !g.manualOverride && clientId ? (
                    <OverrideGateDialog clientId={clientId} period={period} gate={g} />
                  ) : null,
              },
            ]}
          />
        </SectionCard>

        <SectionCard title="Sub ledger tie outs" description="Ledger balance against its supporting schedule.">
          <DataGrid<Tieout>
            rows={d?.tieouts ?? []}
            loading={q.isPending}
            rowKey={(t) => t.id}
            testId="grid-close-tieouts"
            empty={<EmptyState title="No tie outs for this period" body="CLS-TIE-SUBLEDGERS writes one row per supported account." />}
            cols={[
              { key: "acct", label: "Account", mobile: "title", render: (t) => <span className="font-medium">{t.accountNumber} {t.accountName}</span> },
              { key: "ledger", label: "Ledger", align: "right", mobile: "row", render: (t) => <Money cents={t.ledgerBalanceCents} dim /> },
              {
                key: "variance",
                label: "Variance",
                align: "right",
                mobile: "row",
                render: (t) => (t.varianceCents === null ? <span className="text-xs text-muted-foreground">Unsupported</span> : <Money cents={t.varianceCents} signed />),
              },
              { key: "state", label: "State", mobile: "value", render: (t) => <Pill tone={tieTone(t)}>{t.state.replace("_", " ")}</Pill> },
            ]}
          />
        </SectionCard>
      </div>
    </div>
  );
}

/**
 * Audit finding: CLOSE-CHECK-GATES had no button anywhere, was left out of
 * auto-scheduling on purpose, and the Lock button above cannot appear until
 * at least one gate result exists -- so without this, a real user could
 * never reach a lockable state at all. Runs aging, the subledger tie out,
 * and gate evaluation in order, as one sequence (server/runs/sequence.ts),
 * the same way IMPORT-COMMIT-BATCH's approval already chains the coding
 * cascade. Shown whenever the period isn't locked yet, since a later gate
 * can depend on an earlier one's output (G04/G05 compare aging against the
 * control balance) and running the whole sequence is always safe to repeat.
 */
function RunCloseChecksButton({ clientId, period }: { clientId: string; period: string }) {
  const run = useRunCloseChecks();
  const qc = useQueryClient();
  const [result, setResult] = useState<{ tone: "good" | "risk"; text: string } | null>(null);

  const submit = async () => {
    setResult(null);
    try {
      const out = await run.mutateAsync({ clientId, period });
      setResult(
        out.done
          ? { tone: "good", text: "Aging, tie out, and gate check all ran." }
          : { tone: "risk", text: `Stopped at ${out.stoppedBy ?? "an earlier step"}.` },
      );
      void qc.invalidateQueries({ queryKey: screenKeys.close(clientId, periodStartOf(period)) });
    } catch (e) {
      setResult({ tone: "risk", text: errorMessage(e) });
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={() => void submit()} disabled={run.isPending} data-testid="close-run-checks">
        Run close checks
      </Button>
      {result ? (
        <p className={`max-w-[16rem] break-words text-right text-xs ${result.tone === "good" ? "text-emerald-700" : "text-destructive"}`} data-testid="close-run-checks-result">
          {result.text}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Audit fix, 2026-11-05. CLOSE-LOCK-PERIOD has always existed; this is
 * just the button to trigger it, which this screen never had.
 */
function LockPeriodButton({ clientId, period }: { clientId: string; period: string }) {
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const scope = { clientId, period: periodStartOf(period) };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CLOSE-LOCK-PERIOD", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({ runCode: "CLOSE-LOCK-PERIOD", body: { mode: "apply", scope, previewRunId: preview.executionId } });
        if (applied.status !== "completed") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      void qc.invalidateQueries({ queryKey: screenKeys.close(clientId, periodStartOf(period)) });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" onClick={() => void submit()} disabled={trigger.isPending} data-testid="close-lock-period">
        Lock period
      </Button>
      {error ? <p className="max-w-[16rem] break-words text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * CLOSE-POST-YEAREND. Audit fix (problem 8): existed and worked, but
 * nothing in the client ever called it. Idempotent per fiscal year
 * (closing_entries' own claim row), so a click on a period that is not
 * actually the fiscal year end is safe -- the run itself computes the
 * real fiscal year boundary from the client's own policy, not a guess
 * this dialog makes. Shown only once the current period is locked, a
 * light safety rail against clicking it mid year by accident.
 */
function PostYearEndDialog({ clientId, period }: { clientId: string; period: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const submit = async () => {
    setError(null);
    const scope = { clientId, period: periodStartOf(period) };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CLOSE-POST-YEAREND", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({ runCode: "CLOSE-POST-YEAREND", body: { mode: "apply", scope, previewRunId: preview.executionId } });
        if (applied.status !== "completed") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      void qc.invalidateQueries({ queryKey: screenKeys.close(clientId, periodStartOf(period)) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setError(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="close-post-yearend">
          Post year end
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Post year end</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Empties revenue and expense into equity for the fiscal year that covers {fmtPeriod(period)}. Posting a year
            that is already closed is a safe no-op; posting before the year has actually ended is not what this is for.
          </p>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={() => void submit()} disabled={trigger.isPending} data-testid="close-post-yearend-confirm">
            Post year end
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Audit fix, 2026-11-05 (problem 4). CLOSE-OVERRIDE-GATE is the missing
 * writer for close.gate_results.manual_override -- this is the one and
 * only place a person accepts a known exception and writes down why.
 * The common case: a solo firm's every real close trips G18 (separation
 * of duties) because the same person previews and applies everything,
 * and before this there was no way to accept that and move on.
 */
function OverrideGateDialog({ clientId, period, gate }: { clientId: string; period: string; gate: CloseGate }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const save = async () => {
    setError(null);
    if (!reason.trim()) {
      setError("A written reason is required.");
      return;
    }
    const scope = { clientId, period: periodStartOf(period), gateCode: gate.gateCode, reason: reason.trim() };
    try {
      const preview = await trigger.mutateAsync({ runCode: "CLOSE-OVERRIDE-GATE", body: { mode: "preview", scope } });
      if (preview.status !== "completed") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({ runCode: "CLOSE-OVERRIDE-GATE", body: { mode: "apply", scope, previewRunId: preview.executionId } });
      if (applied.status !== "completed") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      void qc.invalidateQueries({ queryKey: screenKeys.close(clientId, periodStartOf(period)) });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setReason("");
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid={`gate-override-${gate.gateCode}`}>
          Override
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Override {gate.gateCode}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{gate.gateTitle}. Locking will carry this period as closed with exceptions.</p>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this exception is accepted" data-testid="gate-override-reason" />
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={trigger.isPending} data-testid="gate-override-save">
            Accept exception
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
