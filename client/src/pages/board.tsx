import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { LoadingRows, ErrorState } from "@/components/kit";
import { useApp } from "@/store";
import { SCOPE_LABELS, TASK_STATUSES } from "@/data/labels";
import { fmtPeriod } from "@/lib/money";
import { TODAY } from "@/data/seed";
import type { Task, TaskStatus } from "@/data/types";

const COLUMN_TONE: Record<string, string> = {
  "Not started": "border-border",
  "In progress": "border-primary/50",
  Blocked: "border-destructive/50",
  Review: "border-warning/50",
  Done: "border-positive/50",
};

export default function Board() {
  const { ds, period, loading, loadError, reload, setTaskStatus, reassignTask, setActiveClient } = useApp();
  const [view, setView] = useState<"all" | "overdue">("all");
  const [who, setWho] = useState("all");

  const tasks = ds.tasks
    .filter((t) => t.period === period)
    .filter((t) => (who === "all" ? true : t.assignee === who))
    .filter((t) => (view === "overdue" ? t.dueDate < TODAY && t.status !== "Done" : true));

  const overdue = ds.tasks.filter((t) => t.period === period && t.dueDate < TODAY && t.status !== "Done");
  const clientName = (id: string) => ds.clients.find((c) => c.id === id)?.shortName || id;

  const card = (t: Task) => (
    <li key={t.id} className="rounded-md border border-card-border bg-card p-3" data-testid={`task-${t.id}`}>
      <p className="text-sm leading-snug">{t.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setActiveClient(t.clientId)}
          className="rounded-sm bg-accent px-1.5 py-0.5 text-[11px] font-medium hover:underline"
          data-testid={`button-task-client-${t.id}`}
        >
          {clientName(t.clientId)}
        </button>
        <Pill>{SCOPE_LABELS[t.scopeSource] || t.scopeSource}</Pill>
        {t.dueDate < TODAY && t.status !== "Done" ? <Pill tone="risk">Past due</Pill> : null}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Select value={t.assignee} onValueChange={(v) => reassignTask(t.id, v)}>
          <SelectTrigger className="h-7 text-xs" data-testid={`select-assignee-${t.id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ds.team.map((m) => (
              <SelectItem key={m.id} value={m.name}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={t.status} onValueChange={(v) => setTaskStatus(t.id, v as TaskStatus)}>
          <SelectTrigger className="h-7 text-xs" data-testid={`select-status-${t.id}`}>
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
      </div>
      <p className="tnum mt-2 text-[11px] text-muted-foreground">
        Due {t.dueDate}, {t.estHours} hours estimated
      </p>
    </li>
  );

  return (
    <>
      <PageHeader
        title="Workload board"
        subtitle={`Every client's work for ${fmtPeriod(period)} in one place. Drop a card into a new status with the selector, or reassign it to another person.`}
        actions={
          <>
            <div className="flex rounded-sm border border-border bg-muted p-0.5">
              {(["all", "overdue"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`rounded-sm px-2.5 py-1 text-xs transition-colors ${view === v ? "bg-card font-medium" : "text-muted-foreground"}`}
                  data-testid={`button-view-${v}`}
                >
                  {v === "all" ? "Everything" : "Past due only"}
                </button>
              ))}
            </div>
            <Select value={who} onValueChange={setWho}>
              <SelectTrigger className="h-8 w-[170px] text-xs" data-testid="select-who">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                {ds.team.map((m) => (
                  <SelectItem key={m.id} value={m.name}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Cards in view" value={tasks.length} testId="kpi-cards" />
        <Kpi label="Past due" value={overdue.length} tone={overdue.length ? "risk" : "good"} hint="Across every client" testId="kpi-overdue" />
        <Kpi label="Blocked" value={tasks.filter((t) => t.status === "Blocked").length} tone={tasks.some((t) => t.status === "Blocked") ? "watch" : "good"} testId="kpi-blocked" />
        <Kpi label="Hours outstanding" value={tasks.filter((t) => t.status !== "Done").reduce((s, t) => s + t.estHours, 0).toFixed(1)} testId="kpi-hours" />
      </div>

      {overdue.length ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-danger-soft p-3 text-sm" data-testid="banner-overdue">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="text-muted-foreground">
            <span className="font-medium text-destructive">{overdue.length} tasks are past their due date.</span> The oldest belongs to{" "}
            {clientName(overdue[0].clientId)} and was due {overdue[0].dueDate}.
          </p>
        </div>
      ) : null}

      {loading ? (
        <SectionCard bodyClassName="p-0">
          <LoadingRows rows={6} cols={4} />
        </SectionCard>
      ) : loadError ? (
        <SectionCard bodyClassName="p-0">
          <ErrorState message={loadError} onRetry={reload} />
        </SectionCard>
      ) : tasks.length === 0 ? (
        <SectionCard bodyClassName="p-0">
          <EmptyState
            title={view === "overdue" ? "Nothing is past due" : "No cards for this period"}
            body={view === "overdue" ? "Every task on the board is inside its due date." : "Pick another period from the header."}
          />
        </SectionCard>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {TASK_STATUSES.map((status) => {
            const col = tasks.filter((t) => t.status === status);
            return (
              <section key={status} className={`rounded-md border-t-2 bg-muted/30 p-2 ${COLUMN_TONE[status]}`} data-testid={`column-${status.replace(" ", "-")}`}>
                <header className="flex items-center justify-between px-1 pb-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wide">{status}</h2>
                  <span className="tnum text-xs text-muted-foreground">{col.length}</span>
                </header>
                {col.length ? (
                  <ul className="space-y-2">{col.map(card)}</ul>
                ) : (
                  <p className="px-1 py-6 text-center text-xs text-muted-foreground">Nothing here</p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
