import { useMemo } from "react";
import { useLocation } from "wouter";
import { ArrowUpRight, CircleAlert, FileWarning, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, EmptyState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { SchedulerCard } from "@/components/scheduler-card";
import { useApp } from "@/store";
import { useFirmOverview, errorMessage } from "@/api";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";
import type { ClientSummary } from "@shared/api";

export const NO_CLIENTS_COPY = "No clients yet. Add the first one.";

/**
 * The firm's first screen, read from GET /api/firm/overview. Every number is
 * a count the server took from the owning table. Nothing here is derived in
 * the browser from the mock dataset any more.
 */
export default function FirmOverview() {
  const { setActiveClient } = useApp();
  const [, navigate] = useLocation();
  const q = useFirmOverview();
  const ov = q.data;
  const clients = ov?.clients ?? [];

  const alerts = useMemo(() => {
    const out: { client: ClientSummary; text: string; tone: "watch" | "risk"; href: string }[] = [];
    for (const c of clients) {
      if (c.openSuspense) out.push({ client: c, text: `${c.openSuspense} transactions parked in 1990 suspense`, tone: "watch", href: "/transactions" });
      if (c.openRequests) out.push({ client: c, text: `${c.openRequests} document requests still open`, tone: "watch", href: "/requests" });
      if (c.openTasks) out.push({ client: c, text: `${c.openTasks} close tasks open`, tone: c.openTasks > 10 ? "risk" : "watch", href: "/board" });
      if (c.status === "onboarding") out.push({ client: c, text: "Intake is not finished, opening balances are missing", tone: "risk", href: "/clients" });
    }
    return out.slice(0, 9);
  }, [clients]);

  const errText = q.isError ? errorMessage(q.error) : null;
  const totals = ov?.totals;

  return (
    <>
      <PageHeader
        title="Firm overview"
        subtitle={ov ? `Every client, one screen. Counts as of ${ov.asOf}, read from the ledger tables.` : "Every client, one screen."}
        actions={
          <Button size="sm" onClick={() => navigate("/clients")} data-testid="button-start-intake">
            Add a client
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Clients on the books" value={totals ? totals.clients : "\u2026"} hint={totals ? `${totals.active} active, ${totals.onboarding} in onboarding` : "Loading"} testId="kpi-clients" />
        <Kpi label="Periods awaiting close" value={totals ? totals.periodsAwaitingClose : "\u2026"} hint="Open periods across every client" testId="kpi-periods" />
        <Kpi label="Open tasks" value={totals ? totals.openTasks : "\u2026"} hint="From the practice workload" tone={totals && totals.openTasks ? "watch" : "good"} testId="kpi-progress" />
        <Kpi label="Waiting in suspense" value={totals ? totals.openSuspense : "\u2026"} hint="Parked in 1990 with a reason code" tone={totals && totals.openSuspense ? "watch" : "good"} testId="kpi-review" />
        <Kpi label="Document requests open" value={totals ? totals.openRequests : "\u2026"} hint="Asked of clients, not yet satisfied" tone={totals && totals.openRequests ? "watch" : "good"} testId="kpi-tieout" />
      </div>

      <SectionCard
        title="Client book"
        description="Select a row to make that client active across the whole workspace."
        bodyClassName="p-0"
        testId="card-client-book"
      >
        <DataGrid
          rows={clients}
          rowKey={(c) => c.id}
          loading={q.isPending}
          error={errText}
          onRetry={() => void q.refetch()}
          empty={
            <EmptyState
              title={NO_CLIENTS_COPY}
              body="A client is four intake runs: the client row, its chart, its workload, and its opening document requests."
              action={
                <Button size="sm" onClick={() => navigate("/clients")} data-testid="button-empty-add-client">
                  Add a client
                </Button>
              }
            />
          }
          onRowClick={(c) => {
            setActiveClient(c.id);
            navigate("/clients");
          }}
          cols={[
            {
              key: "client",
              label: "Client",
              mobile: "title",
              render: (c) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">{c.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.entityType}, fiscal year ends month {c.fiscalYearEndMonth}
                  </p>
                </div>
              ),
            },
            {
              key: "stage",
              label: "Stage",
              mobile: "sub",
              render: (c) => (
                <Pill tone={c.status === "active" ? "good" : c.status === "archived" ? "neutral" : "info"}>
                  {c.status === "active" ? "Live" : c.status === "archived" ? "Archived" : "Onboarding"}
                </Pill>
              ),
            },
            {
              key: "engagement",
              label: "Engagement",
              mobile: "row",
              render: (c) => (
                <span className="text-sm">
                  {c.engagement ? `${c.engagement.serviceLevel}, ${c.engagement.status}` : "none"}
                </span>
              ),
            },
            { key: "chart", label: "Accounts", align: "right", mobile: "row", render: (c) => <span className="tnum text-sm">{c.chartAccounts}</span> },
            {
              key: "period",
              label: "Open period",
              mobile: "row",
              render: (c) => <span className="text-sm">{c.openPeriod ? fmtPeriod(c.openPeriod.slice(0, 7)) : "none"}</span>,
            },
            {
              key: "lastRun",
              label: "Last run",
              mobile: "row",
              render: (c) => <span className="text-xs text-muted-foreground">{c.lastRunAt ? fmtTimestamp(c.lastRunAt) : "never"}</span>,
            },
            {
              key: "flags",
              label: "Exceptions",
              mobile: "row",
              render: (c) => (
                <div className="flex flex-wrap gap-1">
                  {c.openSuspense ? <Pill tone="watch">{c.openSuspense} in suspense</Pill> : null}
                  {c.openTasks ? <Pill tone="info">{c.openTasks} tasks</Pill> : null}
                  {c.openRequests ? <Pill tone="info">{c.openRequests} {c.openRequests === 1 ? "request" : "requests"}</Pill> : null}
                  {!c.openSuspense && !c.openTasks && !c.openRequests ? <Pill tone="good">Clean</Pill> : null}
                </div>
              ),
            },
          ]}
        />
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-3">
        <SectionCard
          className="xl:col-span-2"
          title="Recent runs"
          description="The last runs across the firm, from the run log."
          bodyClassName="p-0"
          testId="card-recent-runs"
        >
          <DataGrid
            rows={ov?.recentRuns ?? []}
            rowKey={(r) => r.executionId}
            loading={q.isPending}
            error={errText}
            onRetry={() => void q.refetch()}
            empty={<EmptyState title="No runs yet" body="The first intake posts the first run." />}
            cols={[
              { key: "client", label: "Client", mobile: "title", render: (r) => <span className="text-sm font-medium">{r.clientName}</span> },
              { key: "run", label: "Run", mobile: "sub", render: (r) => <span className="font-mono text-xs">{r.runType}</span> },
              { key: "mode", label: "Mode", mobile: "row", render: (r) => <span className="text-sm">{r.mode}</span> },
              {
                key: "status",
                label: "Status",
                mobile: "row",
                render: (r) => (
                  <Pill tone={r.status === "failed" || r.status === "refused" ? "risk" : r.status.startsWith("completed") ? "good" : "neutral"}>{r.status}</Pill>
                ),
              },
              { key: "at", label: "Started", mobile: "row", render: (r) => <span className="text-xs text-muted-foreground">{fmtTimestamp(r.startedAt)}</span> },
            ]}
          />
        </SectionCard>

        <SectionCard title="Needs a person" description="Ranked by how much it blocks the close." bodyClassName="p-0" testId="card-alerts">
          {alerts.length ? (
            <ul className="divide-y divide-border">
              {alerts.map((a, i) => (
                <li key={i} className="flex items-start gap-3 px-4 py-3">
                  {a.tone === "risk" ? (
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  ) : (
                    <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-snug">{a.text}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{a.client.name}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2"
                    onClick={() => {
                      setActiveClient(a.client.id);
                      navigate(a.href);
                    }}
                    data-testid={`button-alert-${i}`}
                  >
                    Open
                    <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="Nothing is blocking the close"
              body={clients.length ? "Every client is coded, reconciled, and supported." : "Add a client and its work shows up here."}
              icon={<ListChecks className="h-4 w-4" />}
            />
          )}
        </SectionCard>
      </div>

      <div className="mt-4">
        <SchedulerCard />
      </div>
    </>
  );
}
