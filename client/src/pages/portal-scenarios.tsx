import { useState } from "react";
import { DataGrid, EmptyState, Money, Pill, SectionCard } from "@/components/kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalForecast } from "@/api";
import { fmtShortDate, fmtTimestamp } from "@/lib/money";
import { ForecastTable, SCENARIO_LABEL } from "./portal-forecast";
import type { PortalForecast as PortalForecastData } from "@shared/api";

type RunRow = PortalForecastData["runs"][number];

/**
 * Legend feature. Every forecast run the engine has built, so the base case
 * can be set beside slower collections or a revenue shortfall. Read from
 * GET /api/portal/:clientId/forecast?run=. Nothing is simulated in the
 * browser, a scenario that was never run is not listed.
 */
export default function PortalScenarios() {
  const [runId, setRunId] = useState<string | null>(null);
  return (
    <PortalScreen title="Scenario comparison" subtitle="The same forecast under slower collections or a change in revenue, as your accountant ran it." testId="hero-portal-scenarios">
      {({ clientId }) => <Body clientId={clientId} runId={runId} setRunId={setRunId} />}
    </PortalScreen>
  );
}

function Body({ clientId, runId, setRunId }: { clientId: string; runId: string | null; setRunId: (id: string | null) => void }) {
  const q = usePortalForecast(clientId, runId);
  return (
    <QueryBody q={q} title="Scenario comparison" testId="card-portal-scenarios">
      {(data) =>
        data.runs.length === 0 ? (
          <SectionCard title="Scenarios" testId="card-portal-scenarios-empty">
            <EmptyState title="No scenarios have been run yet" body="Scenarios are forecast runs with different assumptions. Once your accountant builds them, they are listed here side by side." />
          </SectionCard>
        ) : (
          <>
            <SectionCard title="Runs on file" bodyClassName="p-0" testId="card-portal-scenarios-runs">
              <DataGrid<RunRow>
                rows={data.runs}
                rowKey={(r) => r.id}
                testId="grid-portal-scenarios"
                dense
                onRowClick={(r) => setRunId(r.id)}
                rowClassName={(r) => (data.run && r.id === data.run.id ? "bg-primary/5" : "")}
                cols={[
                  { key: "scenario", label: "Scenario", render: (r) => <span className="font-medium">{SCENARIO_LABEL[r.scenario]}</span> },
                  { key: "start", label: "From", render: (r) => fmtShortDate(r.startDate) },
                  { key: "close", label: "Closing cash", align: "right", render: (r) => <Money cents={r.closingCashCents} /> },
                  { key: "short", label: "First shortfall", render: (r) => (r.firstShortfallWeek === null ? <Pill tone="good">None</Pill> : <Pill tone="risk">Week {r.firstShortfallWeek}</Pill>) },
                  { key: "built", label: "Built", render: (r) => fmtTimestamp(r.builtAt) },
                ]}
              />
            </SectionCard>
            <ForecastTable data={data} />
          </>
        )
      }
    </QueryBody>
  );
}
