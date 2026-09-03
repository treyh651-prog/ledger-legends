import { useMemo } from "react";
import { useLocation } from "wouter";
import { ArrowUpRight, CircleAlert, FileWarning, ListChecks } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { DataGrid, Kpi, Meter, Money, PageHeader, Pill, SectionCard, EmptyState } from "@/components/kit";
import { useApp } from "@/store";
import { clientRollup, monthlyTrend, substantiationViews } from "@/data/derive";
import { fmtPeriod, fmtPeriodShort, usd } from "@/lib/money";
import type { Client } from "@/data/types";

export default function FirmOverview() {
  const { ds, period, loading, loadError, reload, setActiveClient, activeClientId } = useApp();
  const [, navigate] = useLocation();

  const rollups = useMemo(
    () => ds.clients.map((c) => ({ client: c, roll: clientRollup(ds, c.id, period) })),
    [ds, period],
  );

  const totals = rollups.reduce(
    (s, r) => ({
      revenue: s.revenue + r.roll.revenue,
      needsReview: s.needsReview + r.roll.needsReview,
      openItems: s.openItems + r.roll.openItems,
      tieOut: s.tieOut + r.roll.tieOutIssues,
      unreconciled: s.unreconciled + r.roll.unreconciled,
      tasksOpen: s.tasksOpen + r.roll.tasksOpen,
      overdue: s.overdue + r.roll.tasksOverdue,
      progress: s.progress + r.roll.closeProgress,
    }),
    { revenue: 0, needsReview: 0, openItems: 0, tieOut: 0, unreconciled: 0, tasksOpen: 0, overdue: 0, progress: 0 },
  );
  const avgProgress = rollups.length ? Math.round(totals.progress / rollups.length) : 0;

  const trend = useMemo(() => monthlyTrend(ds, activeClientId), [ds, activeClientId]);
  const chartData = trend.map((t) => ({
    name: fmtPeriodShort(t.period),
    Revenue: t.revenue / 100,
    Expenses: t.expenses / 100,
    Net: t.netIncome / 100,
  }));

  const alerts = useMemo(() => {
    const out: { client: Client; text: string; tone: "watch" | "risk"; href: string }[] = [];
    for (const { client, roll } of rollups) {
      if (roll.needsReview)
        out.push({ client, text: `${roll.needsReview} transactions parked in 1990 suspense`, tone: "watch", href: "/transactions" });
      if (roll.unreconciled)
        out.push({ client, text: `${roll.unreconciled} bank account not reconciled for ${fmtPeriod(period)}`, tone: "risk", href: "/reconcile" });
      const subs = substantiationViews(ds, client.id, period).filter((s) => s.status !== "tied");
      for (const s of subs)
        out.push({
          client,
          text:
            s.status === "variance"
              ? `${s.accountName} is off by ${usd(s.varianceCents)} against its support`
              : `${s.accountName} has no support attached`,
          tone: s.status === "variance" ? "risk" : "watch",
          href: "/substantiation",
        });
      if (roll.tasksOverdue) out.push({ client, text: `${roll.tasksOverdue} close tasks are past due`, tone: "risk", href: "/board" });
    }
    return out.slice(0, 9);
  }, [rollups, ds, period]);

  return (
    <>
      <PageHeader
        title="Firm overview"
        subtitle={`Every client, one screen. Figures are for ${fmtPeriod(period)} and update the moment you post something.`}
        actions={
          <Button size="sm" onClick={() => navigate("/intake")} data-testid="button-start-intake">
            Start a client intake
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Clients on the books" value={ds.clients.length} hint={`${ds.clients.filter((c) => c.onboardingStage === "Live").length} live, rest in onboarding`} testId="kpi-clients" />
        <Kpi label="Billed revenue tracked" value={usd(totals.revenue)} hint="Combined client revenue this period" testId="kpi-revenue" />
        <Kpi
          label="Close progress"
          value={`${avgProgress}%`}
          hint={`${totals.tasksOpen} tasks open, ${totals.overdue} past due`}
          tone={avgProgress > 80 ? "good" : avgProgress > 50 ? "watch" : "risk"}
          testId="kpi-progress"
        />
        <Kpi label="Waiting in suspense" value={totals.needsReview} hint="Parked in 1990 with a reason code" tone={totals.needsReview ? "watch" : "good"} testId="kpi-review" />
        <Kpi label="Tie out exceptions" value={totals.tieOut} hint={`${totals.openItems} document requests open`} tone={totals.tieOut ? "risk" : "good"} testId="kpi-tieout" />
      </div>

      <SectionCard
        title="Client book"
        description="Select a row to make that client active across the whole workspace."
        bodyClassName="p-0"
        testId="card-client-book"
      >
        <DataGrid
          rows={rollups}
          rowKey={(r) => r.client.id}
          loading={loading}
          error={loadError}
          onRetry={reload}
          onRowClick={(r) => {
            setActiveClient(r.client.id);
            navigate("/clients");
          }}
          cols={[
            {
              key: "client",
              label: "Client",
              mobile: "title",
              render: (r) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.client.dba}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {r.client.entityType}, {r.client.industry}
                  </p>
                </div>
              ),
            },
            {
              key: "stage",
              label: "Stage",
              mobile: "sub",
              render: (r) => (
                <Pill tone={r.client.onboardingStage === "Live" ? "good" : r.client.onboardingStage === "Cleanup" ? "watch" : "info"}>
                  {r.client.onboardingStage}
                </Pill>
              ),
            },
            { key: "lead", label: "Lead", mobile: "row", render: (r) => <span className="text-sm">{r.client.lead}</span> },
            { key: "revenue", label: "Revenue", align: "right", mobile: "value", render: (r) => <Money cents={r.roll.revenue} /> },
            { key: "net", label: "Net income", align: "right", mobile: "row", render: (r) => <Money cents={r.roll.netIncome} signed /> },
            { key: "cash", label: "Cash", align: "right", mobile: "row", render: (r) => <Money cents={r.roll.cash} /> },
            {
              key: "close",
              label: "Close",
              align: "right",
              mobile: "row",
              width: "120px",
              render: (r) => (
                <div className="flex items-center justify-end gap-2">
                  <span className="tnum text-xs text-muted-foreground">{r.roll.closeProgress}%</span>
                  <div className="w-14">
                    <Meter pct={r.roll.closeProgress} tone={r.roll.closeProgress > 80 ? "primary" : r.roll.closeProgress > 40 ? "warning" : "danger"} />
                  </div>
                </div>
              ),
            },
            {
              key: "flags",
              label: "Exceptions",
              mobile: "row",
              render: (r) => (
                <div className="flex flex-wrap gap-1">
                  {r.roll.needsReview ? <Pill tone="watch">{r.roll.needsReview} in suspense</Pill> : null}
                  {r.roll.unreconciled ? <Pill tone="risk">{r.roll.unreconciled} rec open</Pill> : null}
                  {r.roll.tieOutIssues ? <Pill tone="risk">{r.roll.tieOutIssues} tie out</Pill> : null}
                  {r.roll.openItems ? <Pill tone="info">{r.roll.openItems} requests</Pill> : null}
                  {!r.roll.needsReview && !r.roll.unreconciled && !r.roll.tieOutIssues && !r.roll.openItems ? (
                    <Pill tone="good">Clean</Pill>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-3">
        <SectionCard
          className="xl:col-span-2"
          title={`Revenue and expense trend, ${ds.clients.find((c) => c.id === activeClientId)?.dba}`}
          description="Seven months of posted activity for the active client."
          testId="card-trend"
        >
          <div className="h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`}
                  width={44}
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 4,
                    fontSize: 12,
                    color: "hsl(var(--popover-foreground))",
                  }}
                  formatter={(v: number, n) => [`$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`, n as string]}
                />
                <Bar dataKey="Revenue" fill="hsl(var(--chart-1))" radius={[2, 2, 0, 0]} />
                <Bar dataKey="Expenses" fill="hsl(var(--chart-2))" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 h-[110px] w-full border-t border-border pt-3">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`}
                  width={44}
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 4,
                    fontSize: 12,
                    color: "hsl(var(--popover-foreground))",
                  }}
                  formatter={(v: number) => [`$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`, "Net income"]}
                />
                <Line type="monotone" dataKey="Net" stroke="hsl(var(--chart-4))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
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
                    <p className="mt-0.5 text-xs text-muted-foreground">{a.client.dba}</p>
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
              body="Every client is coded, reconciled, and supported for this period."
              icon={<ListChecks className="h-4 w-4" />}
            />
          )}
        </SectionCard>
      </div>
    </>
  );
}
