import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataGrid, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { budgetVsActual, classBreakdown, jobProfitability } from "@/data/derive";
import { fmtPeriod, pct, usd } from "@/lib/money";

export default function Budget() {
  const { ds, activeClient, activeClientId, period, loading, loadError, reload } = useApp();
  const bva = useMemo(() => budgetVsActual(ds, activeClientId, period), [ds, activeClientId, period]);
  const classes = useMemo(() => classBreakdown(ds, activeClientId, period), [ds, activeClientId, period]);
  const jobs = useMemo(() => jobProfitability(ds, activeClientId, period), [ds, activeClientId, period]);

  const worst = [...bva.rows].filter((r) => !r.favorable).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance)).slice(0, 6);
  const chart = worst.map((r) => ({ name: r.account.name.length > 16 ? `${r.account.name.slice(0, 15)}.` : r.account.name, Variance: Math.round(r.variance / 100) }));

  return (
    <>
      <PageHeader
        title="Budget against actual"
        subtitle={`${activeClient.dba} for ${fmtPeriod(period)}. Anything more than five percent off plan is called out so the conversation with the owner starts in the right place.`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Actual" value={usd(bva.totals.actual)} testId="kpi-bva-actual" />
        <Kpi label="Budget" value={usd(bva.totals.budget)} testId="kpi-bva-budget" />
        <Kpi
          label="Variance"
          value={usd(bva.totals.variance)}
          tone={bva.totals.variance >= 0 ? "good" : "risk"}
          hint={bva.totals.variance >= 0 ? "Ahead of plan" : "Behind plan"}
          testId="kpi-bva-variance"
        />
        <Kpi label="Lines off plan" value={bva.rows.filter((r) => !r.favorable && Math.abs(r.variancePct || 0) > 5).length} tone="watch" hint="More than five percent" testId="kpi-bva-off" />
      </div>

      {chart.length ? (
        <SectionCard title="Biggest gaps against plan" description="Amounts in dollars, unfavorable only." testId="card-bva-chart">
          <div className="h-[240px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval={0} />
                <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={54} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 4,
                    fontSize: 12,
                    color: "hsl(var(--popover-foreground))",
                  }}
                  formatter={(v: number) => [`${v.toLocaleString()} dollars`, "Variance"]}
                />
                <Bar dataKey="Variance" radius={[2, 2, 0, 0]}>
                  {chart.map((c) => (
                    <Cell key={c.name} fill="hsl(var(--chart-4))" />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Line by line" bodyClassName="p-0" testId="card-bva">
        <DataGrid
          rows={bva.rows}
          rowKey={(r) => r.account.id}
          loading={loading}
          error={loadError}
          onRetry={reload}
          dense
          rowClassName={(r) => (!r.favorable && Math.abs(r.variancePct || 0) > 5 ? "bg-danger-soft" : "")}
          cols={[
            {
              key: "acct",
              label: "Account",
              mobile: "title",
              render: (r) => (
                <span>
                  <span className="tnum text-muted-foreground">{r.account.code}</span> {r.account.name}
                </span>
              ),
            },
            { key: "actual", label: "Actual", align: "right", mobile: "value", render: (r) => <Money cents={r.actual} /> },
            { key: "budget", label: "Budget", align: "right", mobile: "row", render: (r) => <Money cents={r.budget} /> },
            { key: "var", label: "Variance", align: "right", mobile: "row", render: (r) => <Money cents={r.variance} signed /> },
            {
              key: "pct",
              label: "Percent",
              align: "right",
              mobile: "row",
              render: (r) => <span className="tnum text-xs">{r.variancePct === null ? "" : pct(r.variancePct)}</span>,
            },
            {
              key: "flag",
              label: "Read",
              align: "right",
              mobile: "row",
              render: (r) => <Pill tone={r.favorable ? "good" : Math.abs(r.variancePct || 0) > 5 ? "risk" : "watch"}>{r.favorable ? "Favorable" : "Unfavorable"}</Pill>,
            },
          ]}
          footer={
            <tr>
              <td className="px-3 py-2 font-semibold">Totals</td>
              <td className="tnum px-3 py-2 text-right font-semibold">{usd(bva.totals.actual)}</td>
              <td className="tnum px-3 py-2 text-right font-semibold">{usd(bva.totals.budget)}</td>
              <td className="tnum px-3 py-2 text-right font-semibold">{usd(bva.totals.variance)}</td>
              <td />
              <td />
            </tr>
          }
        />
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        {classes.length ? (
          <SectionCard title="Revenue by class" description="Tracking categories carried on every entry." bodyClassName="p-0" testId="card-classes">
            <DataGrid
              rows={classes}
              rowKey={(c) => c.name}
              dense
              cols={[
                { key: "name", label: "Class", mobile: "title", render: (c) => c.name },
                { key: "rev", label: "Revenue", align: "right", mobile: "value", render: (c) => <Money cents={c.revenue} /> },
                { key: "exp", label: "Direct cost", align: "right", mobile: "row", render: (c) => <Money cents={c.expense} /> },
                {
                  key: "margin",
                  label: "Margin",
                  align: "right",
                  mobile: "row",
                  render: (c) => <span className="tnum text-xs">{c.revenue ? pct(((c.revenue - c.expense) / c.revenue) * 100) : ""}</span>,
                },
              ]}
            />
          </SectionCard>
        ) : null}

        {jobs.length ? (
          <SectionCard title="Job profitability" description="Only clients that track jobs see this table." bodyClassName="p-0" testId="card-jobs">
            <DataGrid
              rows={jobs}
              rowKey={(j) => j.job}
              dense
              cols={[
                { key: "job", label: "Job", mobile: "title", render: (j) => j.job },
                { key: "rev", label: "Revenue", align: "right", mobile: "value", render: (j) => <Money cents={j.revenue} /> },
                { key: "cost", label: "Cost", align: "right", mobile: "row", render: (j) => <Money cents={j.cost} /> },
                {
                  key: "margin",
                  label: "Margin",
                  align: "right",
                  mobile: "row",
                  render: (j) => (
                    <Pill tone={j.margin >= 25 ? "good" : j.margin >= 10 ? "watch" : "risk"}>{pct(j.margin)}</Pill>
                  ),
                },
              ]}
            />
          </SectionCard>
        ) : null}
      </div>
    </>
  );
}
