import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataGrid, EmptyState, Kpi, Money, Pill, SectionCard } from "@/components/kit";
import { LockedFeature, PortalHero, PortalNote } from "@/components/portal/portal-kit";
import { usePortal } from "@/lib/use-portal";
import { cashForecast, netBalances, type ForecastWeek } from "@/data/derive";
import { forecastFact } from "@/data/portal-facts";
import { ACCOUNTS } from "@/data/coa";
import { fmtShortDate, usd } from "@/lib/money";

/** Legend feature. Thirteen weeks of projected cash with the schedule behind each week. */
export default function PortalForecast() {
  const p = usePortal();

  const fact = useMemo(() => forecastFact(p.ds, p.clientId), [p.ds, p.clientId]);
  const weeks = useMemo(() => (p.hasBooks ? cashForecast(p.ds, p.clientId, 13) : []), [p.ds, p.clientId, p.hasBooks]);
  const startCash = useMemo(() => {
    const through = p.openPeriod || p.closedPeriods[0];
    if (!through) return 0;
    const nets = netBalances(p.ds, p.clientId, { through });
    return ACCOUNTS.filter((a) => a.cashLike).reduce((s, a) => s + (nets[a.id] || 0), 0);
  }, [p.ds, p.clientId, p.openPeriod, p.closedPeriods]);

  if (!p.can("forecast")) {
    return (
      <>
        <PortalHero
          title="Thirteen week cash forecast"
          subtitle="Cash in and cash out by week, so a slow month is visible before it arrives."
          tier={p.tier}
          testId="hero-portal-forecast"
        />
        <LockedFeature feature="forecast" fact={fact} currentTier={p.tier} />
      </>
    );
  }

  const ending = weeks.length > 0 ? weeks[weeks.length - 1].endingCash : startCash;
  const low = weeks.slice().sort((a, b) => a.endingCash - b.endingCash)[0];
  const chart = weeks.map((w) => ({ name: w.label, Cash: Math.round(w.endingCash / 100) }));

  return (
    <>
      <PortalHero
        title="Thirteen week cash forecast"
        subtitle={`Built for ${p.client.dba} from your cash on hand, your open invoices and bills by due date, and the run rate from your last three months.`}
        tier={p.tier}
        meta={<Pill tone="info">Projection, not a closed number</Pill>}
        testId="hero-portal-forecast"
      />

      {weeks.length === 0 ? (
        <SectionCard title="Forecast" testId="card-portal-forecast-empty">
          <EmptyState
            title="No cash history to project from"
            body="A forecast reads your posted cash activity. There is none yet, so there is nothing honest to draw. This turns on once transactions land."
          />
        </SectionCard>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Cash today" value={usd(startCash)} testId="kpi-portal-fc-start" />
            <Kpi
              label="Projected in thirteen weeks"
              value={usd(ending)}
              tone={ending >= startCash ? "good" : "watch"}
              testId="kpi-portal-fc-end"
            />
            <Kpi
              label="Tightest week"
              value={low ? usd(low.endingCash) : usd(startCash)}
              hint={low ? `${low.label}, starting ${fmtShortDate(low.weekStart)}` : "No week to flag"}
              tone={low && low.endingCash < startCash ? "watch" : "good"}
              testId="kpi-portal-fc-low"
            />
            <Kpi
              label="Weeks that spend more than they collect"
              value={String(weeks.filter((w) => w.net < 0).length)}
              hint={`of ${weeks.length}`}
              testId="kpi-portal-fc-negative"
            />
          </div>

          <SectionCard title="Projected cash balance" description="Dollars at the end of each week." testId="card-portal-fc-chart">
            <div className="h-56 p-2 sm:h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chart} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                  <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 11 }} width={68} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 4,
                      fontSize: 12,
                    }}
                  />
                  <Area type="monotone" dataKey="Cash" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.18)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </SectionCard>

          <SectionCard title="Week by week" description="Every invoice and bill with a due date inside a week is named on that week." testId="card-portal-fc-table">
            <DataGrid<ForecastWeek>
              rows={weeks}
              rowKey={(w) => w.weekStart}
              maxHeight="60vh"
              cols={[
                {
                  key: "week",
                  label: "Week",
                  width: "132px",
                  mobile: "title",
                  render: (w) => (
                    <div>
                      <p className="font-medium">{w.label}</p>
                      <p className="text-xs text-muted-foreground">{fmtShortDate(w.weekStart)}</p>
                    </div>
                  ),
                },
                { key: "inflow", label: "In", align: "right", mobile: "row", render: (w) => <Money cents={w.inflow} /> },
                { key: "outflow", label: "Out", align: "right", mobile: "row", render: (w) => <Money cents={w.outflow} /> },
                { key: "net", label: "Net", align: "right", mobile: "row", render: (w) => <Money cents={w.net} signed /> },
                {
                  key: "endingCash",
                  label: "Ending cash",
                  align: "right",
                  mobile: "value",
                  render: (w) => <Money cents={w.endingCash} className="font-semibold" />,
                },
                {
                  key: "scheduled",
                  label: "Scheduled items",
                  mobile: "row",
                  render: (w) =>
                    w.scheduled.length === 0 ? (
                      <span className="text-xs text-muted-foreground">Run rate only</span>
                    ) : (
                      <span className="text-xs">{w.scheduled.join(", ")}</span>
                    ),
                },
              ]}
              testId="grid-portal-forecast"
            />
          </SectionCard>

          <PortalNote testId="note-portal-fc-basis">
            Weeks with no scheduled document use your recent run rate, which is why they are labeled run rate only. Nothing here is a
            promise, it is your own history and your own open documents projected forward.
          </PortalNote>
        </>
      )}
    </>
  );
}
