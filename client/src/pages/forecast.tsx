import { useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useActiveClient } from "@/lib/active-client";
import { useForecast, errorMessage } from "@/api";
import { fmtCompactUsd, fmtShortDate, fmtTimestamp, usd } from "@/lib/money";
import type { ForecastWeek } from "@shared/api";

/**
 * Closing cash across the horizon. One series, so no legend box; the title
 * names it. Shortfall weeks get a filled dot in the risk color so the one
 * thing the KPI row already calls out is visible on the line itself.
 */
function ClosingCashChart({ weeks }: { weeks: ForecastWeek[] }) {
  const data = weeks.map((w) => ({
    label: `Wk ${w.weekNumber}`,
    date: fmtShortDate(w.weekStart),
    closing: w.closingCents / 100,
    shortfall: w.shortfall,
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="forecastFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.25} />
            <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={{ stroke: "hsl(var(--border))" }} tickLine={false} />
        <YAxis
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => fmtCompactUsd(v * 100)}
          width={56}
        />
        <ReferenceLine y={0} stroke="hsl(var(--destructive))" strokeDasharray="3 3" />
        <Tooltip
          formatter={(value: number) => [usd(Math.round(value * 100)), "Closing cash"]}
          labelFormatter={(label: string, items) => {
            const d = items?.[0]?.payload as { date?: string } | undefined;
            return d?.date ? `${label}, ${d.date}` : label;
          }}
          contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: "hsl(var(--foreground))" }}
        />
        <Area
          type="monotone"
          dataKey="closing"
          stroke="hsl(var(--chart-1))"
          strokeWidth={2}
          fill="url(#forecastFill)"
          dot={(props: { cx?: number; cy?: number; payload?: { shortfall?: boolean } }) =>
            props.payload?.shortfall ? (
              <circle key={`dot-${props.cx}-${props.cy}`} cx={props.cx} cy={props.cy} r={4} fill="hsl(var(--destructive))" stroke="none" />
            ) : (
              <circle key={`dot-${props.cx}-${props.cy}`} cx={props.cx} cy={props.cy} r={0} fill="transparent" />
            )
          }
          activeDot={{ r: 5, fill: "hsl(var(--chart-1))" }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

const SCENARIO: Record<string, string> = { base: "Base", slow_collections: "Slow collections", revenue_shortfall: "Revenue shortfall" };

/**
 * Thirteen week cash forecast, read from GET /api/firm/clients/:id/forecast.
 * Every figure is a row RPT-REBUILD-FORECAST wrote; the screen picks a run
 * and shows its weeks.
 */
export default function Forecast() {
  const { client, clientId } = useActiveClient();
  const [runId, setRunId] = useState<string | null>(null);
  const q = useForecast(clientId, runId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const run = d?.runs.find((r) => r.id === d.selectedRunId) ?? null;

  return (
    <div className="space-y-4" data-testid="page-forecast">
      <PageHeader
        title="Cash forecast"
        subtitle={`${client?.name ?? ""}. ${run ? `${SCENARIO[run.scenario] ?? run.scenario} scenario, ${run.horizonWeeks} weeks from ${fmtShortDate(run.startDate)}, built ${fmtTimestamp(run.builtAt)}.` : d ? "No forecast built yet." : ""}`}
        actions={
          d && d.runs.length > 1 ? (
            <Select value={d.selectedRunId ?? ""} onValueChange={setRunId}>
              <SelectTrigger className="w-72" data-testid="select-forecast-run">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {d.runs.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {SCENARIO[r.scenario] ?? r.scenario}, built {fmtTimestamp(r.builtAt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Opening cash" value={run ? <Money cents={run.openingCashCents} /> : "None"} />
        <Kpi label="Inflows" value={run ? <Money cents={run.totalInflowCents} /> : "None"} />
        <Kpi label="Outflows" value={run ? <Money cents={run.totalOutflowCents} /> : "None"} />
        <Kpi
          label="Closing cash"
          value={run ? <Money cents={run.closingCashCents} signed /> : "None"}
          tone={run ? (run.shortfallWeekCount > 0 ? "risk" : "good") : "neutral"}
          hint={run ? (run.firstShortfallWeek === null ? "No shortfall week" : `First shortfall in week ${run.firstShortfallWeek}`) : undefined}
          testId="kpi-closing-cash"
        />
      </div>
      {d && d.weeks.length > 0 ? (
        <SectionCard title="Closing cash by week" description="The line the KPIs above summarize. A red dot marks a shortfall week.">
          <ClosingCashChart weeks={d.weeks} />
        </SectionCard>
      ) : null}
      <SectionCard title="Weeks" description="Opening, inflows by source, outflows by source, closing.">
        <DataGrid<ForecastWeek>
          rows={d?.weeks ?? []}
          loading={q.isPending}
          rowKey={(w) => String(w.weekNumber)}
          testId="grid-forecast-weeks"
          rowClassName={(w) => (w.shortfall ? "bg-danger-soft/40" : "")}
          empty={<EmptyState title="No forecast" body="RPT-REBUILD-FORECAST writes the weeks when it runs for this client." />}
          cols={[
            { key: "wk", label: "Week", mobile: "title", render: (w) => <span className="font-medium">Week {w.weekNumber}, {fmtShortDate(w.weekStart)}</span> },
            { key: "open", label: "Opening", align: "right", mobile: "row", render: (w) => <Money cents={w.openingCents} dim /> },
            { key: "ar", label: "AR in", align: "right", mobile: "row", render: (w) => <Money cents={w.arInflowCents} dim /> },
            { key: "ap", label: "AP out", align: "right", mobile: "row", render: (w) => <Money cents={w.apOutflowCents} dim /> },
            { key: "pay", label: "Payroll", align: "right", mobile: "row", render: (w) => <Money cents={w.payrollOutflowCents} dim /> },
            { key: "other", label: "Other out", align: "right", mobile: "row", render: (w) => <Money cents={w.recurringOutflowCents + w.loanOutflowCents} dim /> },
            { key: "close", label: "Closing", align: "right", mobile: "value", render: (w) => <Money cents={w.closingCents} signed className="font-semibold" /> },
            { key: "flag", label: "", mobile: "row", render: (w) => (w.shortfall ? <Pill tone="risk">Shortfall</Pill> : null) },
          ]}
        />
      </SectionCard>
    </div>
  );
}
