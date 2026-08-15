import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataGrid, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { cashForecast } from "@/data/derive";
import { fmtShortDate, usd } from "@/lib/money";

export default function Forecast() {
  const { ds, activeClient, activeClientId, loading, loadError, reload } = useApp();
  const [stress, setStress] = useState<"base" | "slow" | "tight">("base");

  const weeks = useMemo(() => {
    const base = cashForecast(ds, activeClientId, 13);
    if (stress === "base") return base;
    const inMult = stress === "slow" ? 0.85 : 1;
    const outMult = stress === "tight" ? 1.12 : 1;
    let cash = base[0].endingCash - base[0].net;
    return base.map((w) => {
      const inflow = Math.round(w.inflow * inMult);
      const outflow = Math.round(w.outflow * outMult);
      cash = cash + inflow - outflow;
      return { ...w, inflow, outflow, net: inflow - outflow, endingCash: cash };
    });
  }, [ds, activeClientId, stress]);

  const chart = weeks.map((w) => ({
    name: w.label,
    Cash: Math.round(w.endingCash / 100),
    In: Math.round(w.inflow / 100),
    Out: Math.round(w.outflow / 100),
  }));
  const low = weeks.reduce((m, w) => (w.endingCash < m.endingCash ? w : m), weeks[0]);
  const negative = weeks.filter((w) => w.endingCash < 0);

  return (
    <>
      <PageHeader
        title="Thirteen week cash forecast"
        subtitle={`${activeClient.dba}, starting from the cash on the books today and adding the invoices and bills that are already scheduled.`}
        actions={
          <div className="flex rounded-sm border border-border bg-muted p-0.5">
            {([
              ["base", "As scheduled"],
              ["slow", "Collections slip"],
              ["tight", "Costs climb"],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setStress(k)}
                className={`rounded-sm px-2.5 py-1 text-xs transition-colors ${stress === k ? "bg-card font-medium" : "text-muted-foreground"}`}
                data-testid={`button-stress-${k}`}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Cash today" value={usd(weeks[0].endingCash - weeks[0].net)} testId="kpi-cash-today" />
        <Kpi label="Cash in thirteen weeks" value={usd(weeks[weeks.length - 1].endingCash)} tone={weeks[weeks.length - 1].endingCash > 0 ? "good" : "risk"} testId="kpi-cash-end" />
        <Kpi label="Lowest point" value={usd(low.endingCash)} hint={`Week of ${fmtShortDate(low.weekStart)}`} tone={low.endingCash < 0 ? "risk" : low.endingCash < 500000 ? "watch" : "good"} testId="kpi-low" />
        <Kpi label="Weeks below zero" value={negative.length} tone={negative.length ? "risk" : "good"} testId="kpi-negative" />
      </div>

      {negative.length ? (
        <div className="rounded-md border border-destructive/40 bg-danger-soft p-3 text-sm" data-testid="banner-cash-warning">
          <span className="font-medium text-destructive">Cash goes negative in week {negative[0].label.replace("Wk ", "")}.</span>{" "}
          <span className="text-muted-foreground">
            Pulling forward {usd(Math.abs(negative[0].endingCash))} of collections or pushing a payables run would clear it.
          </span>
        </div>
      ) : (
        <div className="rounded-md border border-positive/40 bg-positive-soft p-3 text-sm text-muted-foreground" data-testid="banner-cash-ok">
          Cash stays positive across all thirteen weeks under this scenario, with the tightest week landing at {usd(low.endingCash)}.
        </div>
      )}

      <SectionCard title="Projected cash balance" description="Bars are weekly movement, the line is the closing balance. Amounts in dollars." testId="card-forecast-chart">
        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chart} margin={{ top: 4, right: 8, left: -4, bottom: 0 }}>
              <defs>
                <linearGradient id="cashFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval={0} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={58} />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 4,
                  fontSize: 12,
                  color: "hsl(var(--popover-foreground))",
                }}
                formatter={(v: number, n) => [`${v.toLocaleString()} dollars`, n as string]}
              />
              <Area type="monotone" dataKey="Cash" stroke="hsl(var(--chart-1))" strokeWidth={2} fill="url(#cashFill)" />
              <Line type="monotone" dataKey="In" stroke="hsl(var(--chart-2))" strokeWidth={1.5} dot={false} />
              <Line type="monotone" dataKey="Out" stroke="hsl(var(--chart-4))" strokeWidth={1.5} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <SectionCard title="Week by week" bodyClassName="p-0" testId="card-forecast-table">
        <DataGrid
          rows={weeks}
          rowKey={(w) => w.weekStart}
          loading={loading}
          error={loadError}
          onRetry={reload}
          dense
          rowClassName={(w) => (w.endingCash < 0 ? "bg-danger-soft" : "")}
          cols={[
            {
              key: "week",
              label: "Week",
              mobile: "title",
              render: (w) => (
                <div className="min-w-0">
                  <p>
                    {w.label}, {fmtShortDate(w.weekStart)}
                  </p>
                  {w.scheduled.length ? <p className="truncate text-xs text-muted-foreground">{w.scheduled.slice(0, 2).join(", ")}</p> : null}
                </div>
              ),
            },
            { key: "in", label: "Money in", align: "right", mobile: "row", render: (w) => <Money cents={w.inflow} /> },
            { key: "out", label: "Money out", align: "right", mobile: "row", render: (w) => <Money cents={w.outflow} /> },
            { key: "net", label: "Net", align: "right", mobile: "row", render: (w) => <Money cents={w.net} signed /> },
            { key: "cash", label: "Ending cash", align: "right", mobile: "value", render: (w) => <Money cents={w.endingCash} /> },
            {
              key: "flag",
              label: "Read",
              align: "right",
              mobile: "row",
              render: (w) => <Pill tone={w.endingCash < 0 ? "risk" : w.endingCash < 500000 ? "watch" : "good"}>{w.endingCash < 0 ? "Short" : w.endingCash < 500000 ? "Tight" : "Fine"}</Pill>,
            },
          ]}
        />
      </SectionCard>
    </>
  );
}
