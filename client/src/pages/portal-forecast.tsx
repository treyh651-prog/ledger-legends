import { DataGrid, EmptyState, Kpi, Money, Pill, SectionCard } from "@/components/kit";
import { PortalNote } from "@/components/portal/portal-kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalForecast } from "@/api";
import { fmtShortDate, fmtTimestamp } from "@/lib/money";
import type { PortalForecast as PortalForecastData } from "@shared/api";

type Week = PortalForecastData["weeks"][number];

export const SCENARIO_LABEL = { base: "Base case", slow_collections: "Slower collections", revenue_shortfall: "Revenue shortfall" } as const;

/**
 * Legend feature. The thirteen week cash forecast, read from
 * GET /api/portal/:clientId/forecast. The run shown is the newest base case
 * the engine built. No run is said plainly, with no sample weeks drawn.
 */
export default function PortalForecast() {
  return (
    <PortalScreen title="Thirteen week cash forecast" subtitle="Cash in and cash out by week, built from your open invoices, bills and recurring payments." testId="hero-portal-forecast">
      {({ clientId }) => <Body clientId={clientId} />}
    </PortalScreen>
  );
}

function Body({ clientId }: { clientId: string }) {
  const q = usePortalForecast(clientId);
  return (
    <QueryBody q={q} title="Cash forecast" testId="card-portal-forecast">
      {(data) => <ForecastTable data={data} />}
    </QueryBody>
  );
}

export function ForecastTable({ data }: { data: PortalForecastData }) {
  const run = data.run;
  if (!run) {
    return (
      <SectionCard title="Cash forecast" testId="card-portal-forecast-empty">
        <EmptyState
          title="No forecast has been built yet"
          body="The forecast is built from closed books and open invoices and bills. Once your accountant runs it, the weeks appear here."
        />
      </SectionCard>
    );
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Opening cash" value={<Money cents={run.openingCashCents} />} testId="kpi-forecast-open" />
        <Kpi label={`Closing, week ${run.horizonWeeks}`} value={<Money cents={run.closingCashCents} />} tone={run.closingCashCents < 0 ? "risk" : "good"} testId="kpi-forecast-close" />
        <Kpi label="First shortfall" value={run.firstShortfallWeek === null ? "None" : `Week ${run.firstShortfallWeek}`} tone={run.firstShortfallWeek === null ? "good" : "risk"} testId="kpi-forecast-shortfall" />
        <Kpi label="Scenario" value={SCENARIO_LABEL[run.scenario]} hint={`Built ${fmtTimestamp(run.builtAt)}`} testId="kpi-forecast-scenario" />
      </div>
      {run.firstShortfallWeek !== null ? (
        <PortalNote tone="watch" testId="note-forecast-shortfall">
          Cash goes below zero in week {run.firstShortfallWeek} on this run. Your accountant sees the same figure.
        </PortalNote>
      ) : null}
      <SectionCard title={`${fmtShortDate(run.startDate)} to ${fmtShortDate(run.endDate)}`} bodyClassName="p-0" testId="card-portal-forecast-weeks">
        <DataGrid<Week>
          rows={data.weeks}
          rowKey={(w) => String(w.weekNumber)}
          testId="grid-portal-forecast"
          dense
          cols={[
            { key: "wk", label: "Week", render: (w) => <span className="font-medium">{w.weekNumber}</span> },
            { key: "start", label: "Starting", render: (w) => fmtShortDate(w.weekStart) },
            { key: "open", label: "Opening", align: "right", render: (w) => <Money cents={w.openingCents} /> },
            { key: "in", label: "In", align: "right", render: (w) => <Money cents={w.inflowCents} /> },
            { key: "out", label: "Out", align: "right", render: (w) => <Money cents={w.outflowCents} /> },
            { key: "close", label: "Closing", align: "right", render: (w) => <Money cents={w.closingCents} /> },
            { key: "flag", label: "", render: (w) => (w.shortfall ? <Pill tone="risk">Short</Pill> : null) },
          ]}
        />
      </SectionCard>
    </>
  );
}
