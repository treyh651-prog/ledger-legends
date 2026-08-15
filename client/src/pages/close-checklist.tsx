import { useMemo } from "react";
import { useLocation } from "wouter";
import { ArrowUpRight, CheckCircle2, CircleDashed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataGrid, EmptyState, Kpi, Meter, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { balanceSheet, clientRollup, reconSummary, substantiationViews, trialBalance } from "@/data/derive";
import { SCOPE_LABELS, TASK_STATUSES } from "@/data/labels";
import { fmtPeriod, usd } from "@/lib/money";
import { TODAY } from "@/data/seed";
import type { TaskStatus } from "@/data/types";

export default function CloseChecklist() {
  const { ds, activeClient, activeClientId, period, loading, loadError, reload, setTaskStatus } = useApp();
  const [, navigate] = useLocation();

  const tasks = ds.tasks.filter((t) => t.clientId === activeClientId && t.period === period);
  const roll = useMemo(() => clientRollup(ds, activeClientId, period), [ds, activeClientId, period]);
  const banks = ds.bankAccounts.filter((b) => b.clientId === activeClientId && b.needsReconciling);
  const tb = trialBalance(ds, activeClientId, period);
  const bs = balanceSheet(ds, activeClientId, period);
  const subs = substantiationViews(ds, activeClientId, period);
  const needsReview = ds.txns.filter((t) => t.clientId === activeClientId && t.status === "needs_review").length;
  const openRequests = ds.openItems.filter((o) => o.clientId === activeClientId && o.status !== "accepted").length;

  const gates = [
    { label: "Every transaction has a category", ok: needsReview === 0, detail: needsReview ? `${needsReview} rows still sitting in review` : "Nothing in the review queue", href: "/transactions" },
    {
      label: "Every account reconciles to zero",
      ok: banks.every((b) => reconSummary(ds, activeClientId, b.id, period).difference === 0),
      detail: banks
        .map((b) => {
          const d = reconSummary(ds, activeClientId, b.id, period).difference;
          return `${b.nickname} ${d === 0 ? "is clean" : `is out by ${usd(d)}`}`;
        })
        .join(", "),
      href: "/reconcile",
    },
    { label: "Debits equal credits", ok: tb.totalDebit === tb.totalCredit, detail: `Both sides at ${usd(tb.totalDebit)}`, href: "/statements" },
    { label: "Balance sheet balances", ok: bs.balanced, detail: bs.balanced ? "Assets match liabilities plus equity" : `Off by ${usd(bs.difference)}`, href: "/statements" },
    {
      label: "Balance sheet accounts are supported",
      ok: subs.every((s) => s.status === "tied"),
      detail: subs.every((s) => s.status === "tied") ? "Every account has support attached" : `${subs.filter((s) => s.status !== "tied").length} accounts need attention`,
      href: "/substantiation",
    },
    { label: "Client requests are closed out", ok: openRequests === 0, detail: openRequests ? `${openRequests} requests still open` : "Nothing pending with the client", href: "/requests" },
  ];

  const gatesPassed = gates.filter((g) => g.ok).length;

  return (
    <>
      <PageHeader
        title="Close checklist"
        subtitle={`${activeClient.dba} for ${fmtPeriod(period)}. The gates below have to clear before the period is signed off, and the task list comes from the engagement scope.`}
        actions={
          <Button
            size="sm"
            disabled={gatesPassed !== gates.length}
            onClick={() => navigate("/package")}
            data-testid="button-signoff"
          >
            {gatesPassed === gates.length ? "Build the report package" : `${gates.length - gatesPassed} gates left`}
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Tasks done" value={`${tasks.filter((t) => t.status === "Done").length} of ${tasks.length}`} tone={roll.closeProgress === 100 ? "good" : "watch"} testId="kpi-tasks-done" />
        <Kpi label="Progress" value={`${roll.closeProgress}%`} hint={`${roll.tasksOverdue} past due`} tone={roll.tasksOverdue ? "risk" : "good"} testId="kpi-close-progress" />
        <Kpi label="Gates cleared" value={`${gatesPassed} of ${gates.length}`} tone={gatesPassed === gates.length ? "good" : "watch"} testId="kpi-gates" />
        <Kpi label="Estimated hours left" value={tasks.filter((t) => t.status !== "Done").reduce((s, t) => s + t.estHours, 0).toFixed(1)} hint="Based on the task estimates" testId="kpi-hours-left" />
      </div>

      <SectionCard title="Close gates" description="Each one is checked against the live ledger, not a checkbox someone remembered to tick." bodyClassName="p-0" testId="card-gates">
        <ul className="divide-y divide-border">
          {gates.map((g) => (
            <li key={g.label} className="flex items-start gap-3 px-4 py-3">
              {g.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-positive" />
              ) : (
                <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{g.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{g.detail}</p>
              </div>
              {!g.ok ? (
                <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" onClick={() => navigate(g.href)} data-testid={`button-gate-${g.href.slice(1)}`}>
                  Fix
                  <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              ) : (
                <Pill tone="good">Clear</Pill>
              )}
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard
        title={`Task list for ${fmtPeriod(period)}`}
        description="Generated from the scope on the engagement letter. Change a status and the firm overview updates."
        actions={<Meter pct={roll.closeProgress} />}
        bodyClassName="p-0"
        testId="card-tasks"
      >
        <DataGrid
          rows={tasks}
          rowKey={(t) => t.id}
          loading={loading}
          error={loadError}
          onRetry={reload}
          dense
          empty={<EmptyState title="No tasks for this period" body="Pick a different period, or add a service to the engagement scope." />}
          cols={[
            {
              key: "title",
              label: "Task",
              mobile: "title",
              render: (t) => (
                <div className="min-w-0">
                  <p className="truncate">{t.title}</p>
                  <p className="truncate text-xs text-muted-foreground">From {SCOPE_LABELS[t.scopeSource] || t.scopeSource}</p>
                </div>
              ),
            },
            { key: "assignee", label: "Owner", mobile: "sub", render: (t) => <span className="text-sm">{t.assignee}</span> },
            {
              key: "due",
              label: "Due",
              mobile: "row",
              render: (t) => (
                <span className={`tnum text-xs ${t.dueDate < TODAY && t.status !== "Done" ? "text-destructive" : ""}`}>{t.dueDate}</span>
              ),
            },
            { key: "hours", label: "Hours", align: "right", mobile: "row", render: (t) => <span className="tnum text-xs">{t.estHours}</span> },
            {
              key: "status",
              label: "Status",
              align: "right",
              width: "160px",
              mobile: "value",
              render: (t) => (
                <Select value={t.status} onValueChange={(v) => setTaskStatus(t.id, v as TaskStatus)}>
                  <SelectTrigger className="h-7 text-xs" data-testid={`select-task-${t.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ),
            },
          ]}
        />
      </SectionCard>
    </>
  );
}
