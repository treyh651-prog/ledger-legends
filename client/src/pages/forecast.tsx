import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useActiveClient } from "@/lib/active-client";
import { useForecast, errorMessage } from "@/api";
import { fmtShortDate, fmtTimestamp } from "@/lib/money";
import type { ForecastWeek } from "@shared/api";

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
