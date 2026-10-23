import { CheckCircle2, CircleDashed } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, Meter, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useCloseChecklist, errorMessage } from "@/api";
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
              { key: "outcome", label: "Outcome", mobile: "value", render: (g) => <Pill tone={gateTone(g)}>{g.outcome}</Pill> },
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
