import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataGrid, Kpi, Meter, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { teamWorkload } from "@/data/derive";
import { fmtPeriod } from "@/lib/money";

export default function Team() {
  const { ds, period, loading, loadError, reload } = useApp();
  const rows = useMemo(() => teamWorkload(ds), [ds]);
  const chart = rows.map((r) => ({ name: r.member.initials, Assigned: r.hours, Capacity: r.member.capacityHours }));
  const totalCapacity = rows.reduce((s, r) => s + r.member.capacityHours, 0);
  const totalHours = rows.reduce((s, r) => s + r.hours, 0);

  return (
    <>
      <PageHeader
        title="Team capacity"
        subtitle={`Open work measured against the hours each person actually has. Figures include every client, with the ${fmtPeriod(period)} close counted in full.`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="People on the team" value={rows.length} testId="kpi-people" />
        <Kpi label="Hours assigned" value={totalHours.toFixed(1)} hint={`Against ${totalCapacity} hours of capacity`} testId="kpi-assigned" />
        <Kpi
          label="Firm utilization"
          value={`${Math.round((totalHours / Math.max(1, totalCapacity)) * 100)}%`}
          tone={totalHours / totalCapacity > 0.95 ? "risk" : totalHours / totalCapacity > 0.8 ? "watch" : "good"}
          testId="kpi-utilization"
        />
        <Kpi label="Past due items" value={rows.reduce((s, r) => s + r.overdue, 0)} tone={rows.some((r) => r.overdue) ? "risk" : "good"} testId="kpi-team-overdue" />
      </div>

      <SectionCard title="Assigned hours against capacity" testId="card-capacity-chart">
        <div className="h-[240px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={40} />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 4,
                  fontSize: 12,
                  color: "hsl(var(--popover-foreground))",
                }}
                formatter={(v: number, n) => [`${v} hours`, n as string]}
              />
              <Bar dataKey="Capacity" fill="hsl(var(--chart-2))" radius={[2, 2, 0, 0]} />
              <Bar dataKey="Assigned" fill="hsl(var(--chart-1))" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <SectionCard title="Who is carrying what" bodyClassName="p-0" testId="card-team">
        <DataGrid
          rows={rows}
          rowKey={(r) => r.member.id}
          loading={loading}
          error={loadError}
          onRetry={reload}
          cols={[
            {
              key: "name",
              label: "Person",
              mobile: "title",
              render: (r) => (
                <div className="flex items-center gap-2.5">
                  <span className="tnum flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-accent text-[11px] font-semibold">
                    {r.member.initials}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{r.member.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{r.member.role}</p>
                  </div>
                </div>
              ),
            },
            {
              key: "clients",
              label: "Clients",
              mobile: "row",
              render: (r) => (
                <div className="flex flex-wrap gap-1">
                  {r.member.clients.map((c) => (
                    <Pill key={c}>{ds.clients.find((x) => x.id === c)?.shortName || c}</Pill>
                  ))}
                </div>
              ),
            },
            { key: "tasks", label: "Open tasks", align: "right", mobile: "row", render: (r) => <span className="tnum">{r.openTasks}</span> },
            { key: "hours", label: "Hours", align: "right", mobile: "value", render: (r) => <span className="tnum">{r.hours.toFixed(1)}</span> },
            { key: "capacity", label: "Capacity", align: "right", mobile: "row", render: (r) => <span className="tnum">{r.member.capacityHours}</span> },
            {
              key: "util",
              label: "Utilization",
              align: "right",
              width: "150px",
              mobile: "row",
              render: (r) => (
                <div className="flex items-center justify-end gap-2">
                  <span className="tnum text-xs">{r.utilization}%</span>
                  <div className="w-16">
                    <Meter pct={r.utilization} tone={r.utilization > 95 ? "danger" : r.utilization > 80 ? "warning" : "primary"} />
                  </div>
                </div>
              ),
            },
            {
              key: "overdue",
              label: "Past due",
              align: "right",
              mobile: "row",
              render: (r) => (r.overdue ? <Pill tone="risk">{r.overdue}</Pill> : <Pill tone="good">None</Pill>),
            },
          ]}
        />
      </SectionCard>
    </>
  );
}
