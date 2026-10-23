import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Lock } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { useApp } from "@/store";
import { useFirmTasks, useFirmTeam, useUpdateTask, errorMessage } from "@/api";
import { fmtPeriod, fmtShortDate } from "@/lib/money";
import type { FirmTask } from "@shared/api";

/**
 * The firm's workload board for the period in the header, read from
 * GET /api/firm/tasks. Every row is a practice.tasks row across every client
 * the person can read. Complete, reopen, and reassign go through
 * PRAC-UPDATE-TASK on POST /api/firm/clients/:id/tasks/:taskId, so a move
 * on this screen is a run with an intent row and an undo plan like any other
 * write. Blocked rows are the generator's and have no button.
 */
export default function Board() {
  const { period } = useApp();
  const tasks = useFirmTasks(period);
  const team = useFirmTeam();
  const update = useUpdateTask();
  const [filter, setFilter] = useState<"all" | "open" | "blocked" | "complete" | "overdue">("all");
  const [reassigning, setReassigning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const items = tasks.data?.items ?? [];
  const members = team.data?.items ?? [];
  const nameOf = (id: string | null) => (id ? members.find((m) => m.userId === id)?.displayName ?? "Unknown member" : "Unassigned");

  const counts = useMemo(() => {
    const open = items.filter((t) => t.state === "open").length;
    const blocked = items.filter((t) => t.state === "blocked").length;
    const complete = items.filter((t) => t.state === "complete").length;
    const overdue = items.filter((t) => t.state !== "complete" && t.dueDate < today).length;
    return { open, blocked, complete, overdue };
  }, [items, today]);

  const rows = items.filter((t) => {
    if (filter === "all") return true;
    if (filter === "overdue") return t.state !== "complete" && t.dueDate < today;
    return t.state === filter;
  });

  const move = (t: FirmTask, body: { state?: "open" | "complete"; assigneeId?: string | null }) => {
    setNotice(null);
    update.mutate(
      { clientId: t.clientId, taskId: t.id, body },
      {
        onSuccess: (r) => {
          const outcome = r.applied ?? r.preview;
          if (!r.done) setNotice(outcome.errors[0]?.message ?? `The run ended ${outcome.status}.`);
          setReassigning(null);
        },
        onError: (e) => setNotice(errorMessage(e)),
      },
    );
  };

  if (tasks.isError) return <ErrorState message={errorMessage(tasks.error)} onRetry={() => void tasks.refetch()} />;

  const filters: Array<{ key: typeof filter; label: string; n: number }> = [
    { key: "all", label: "All", n: items.length },
    { key: "open", label: "Open", n: counts.open },
    { key: "blocked", label: "Blocked", n: counts.blocked },
    { key: "overdue", label: "Overdue", n: counts.overdue },
    { key: "complete", label: "Complete", n: counts.complete },
  ];

  return (
    <div className="space-y-4" data-testid="page-board">
      <PageHeader
        title="Workload board"
        subtitle={`Every practice task for ${fmtPeriod(period)}, across every client. Moves on this board are PRAC-UPDATE-TASK runs.`}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Open" value={tasks.data ? counts.open : "…"} testId="kpi-open" />
        <Kpi label="Blocked" value={tasks.data ? counts.blocked : "…"} tone={counts.blocked > 0 ? "watch" : "neutral"} />
        <Kpi label="Overdue" value={tasks.data ? counts.overdue : "…"} tone={counts.overdue > 0 ? "risk" : "neutral"} />
        <Kpi label="Complete" value={tasks.data ? counts.complete : "…"} tone={counts.complete > 0 ? "good" : "neutral"} />
      </div>

      {notice && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" data-testid="board-notice">
          <AlertTriangle className="mr-1 inline h-4 w-4" /> {notice}
        </div>
      )}

      <SectionCard
        title="Tasks"
        description="From practice.tasks, due date ascending."
        actions={
          <div className="flex flex-wrap gap-1">
            {filters.map((f) => (
              <Button key={f.key} size="sm" variant={filter === f.key ? "default" : "outline"} onClick={() => setFilter(f.key)} data-testid={`board-filter-${f.key}`}>
                {f.label} {f.n}
              </Button>
            ))}
          </div>
        }
      >
        <DataGrid<FirmTask>
          rows={rows}
          loading={tasks.isPending}
          rowKey={(t) => t.id}
          testId="grid-board"
          empty={
            <EmptyState
              title={items.length ? "Nothing matches that filter" : "No tasks this period"}
              body={items.length ? "Pick another filter." : "Tasks appear when a client is created and PRC-GENERATE-WORK runs for the period."}
            />
          }
          cols={[
            {
              key: "state",
              label: "",
              mobile: "row",
              render: (t) =>
                t.state === "complete" ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : t.state === "blocked" ? (
                  <Lock className="h-4 w-4 text-warning" />
                ) : (
                  <CircleDashed className="h-4 w-4 text-muted-foreground" />
                ),
            },
            { key: "title", label: "Task", mobile: "title", render: (t) => <span className="font-medium">{t.title}</span> },
            { key: "client", label: "Client", mobile: "row", render: (t) => <span className="text-xs">{t.clientName}</span> },
            { key: "role", label: "Role", mobile: "row", render: (t) => <span className="text-xs capitalize">{t.role}</span> },
            {
              key: "due",
              label: "Due",
              mobile: "row",
              render: (t) => (
                <span className={`tnum text-xs ${t.state !== "complete" && t.dueDate < today ? "text-destructive" : ""}`}>{fmtShortDate(t.dueDate)}</span>
              ),
            },
            {
              key: "assignee",
              label: "Assignee",
              mobile: "row",
              render: (t) =>
                reassigning === t.id ? (
                  <select
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                    defaultValue={t.assigneeId ?? ""}
                    data-testid={`board-assignee-${t.id}`}
                    onChange={(e) => move(t, { assigneeId: e.target.value || null })}
                  >
                    <option value="">Unassigned</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <button className="text-xs underline-offset-2 hover:underline" onClick={() => setReassigning(t.id)} disabled={members.length === 0}>
                    {nameOf(t.assigneeId)}
                  </button>
                ),
            },
            {
              key: "pill",
              label: "State",
              mobile: "row",
              render: (t) => (
                <Pill tone={t.state === "complete" ? "good" : t.state === "blocked" ? "watch" : "neutral"}>
                  {t.state === "blocked" && t.blockedByCode ? `blocked by ${t.blockedByCode}` : t.state}
                </Pill>
              ),
            },
            {
              key: "action",
              label: "",
              mobile: "row",
              render: (t) =>
                t.state === "blocked" ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={update.isPending}
                    data-testid={`board-move-${t.id}`}
                    onClick={() => move(t, { state: t.state === "complete" ? "open" : "complete" })}
                  >
                    {t.state === "complete" ? "Reopen" : "Complete"}
                  </Button>
                ),
            },
          ]}
        />
      </SectionCard>
    </div>
  );
}
