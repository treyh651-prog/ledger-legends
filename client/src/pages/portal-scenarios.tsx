import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataGrid, EmptyState, Kpi, Money, SectionCard } from "@/components/kit";
import { LockedFeature, PortalHero, PortalNote } from "@/components/portal/portal-kit";
import { usePortal } from "@/lib/use-portal";
import { scenarioFact, scenarioResults, type ScenarioResult } from "@/data/portal-facts";
import { usd } from "@/lib/money";

const LINE_COLORS = ["hsl(var(--chart-1))", "hsl(var(--chart-4))", "hsl(var(--chart-2))"];

/** Legend feature. The same forecast with one stated assumption changed. */
export default function PortalScenarios() {
  const p = usePortal();

  const fact = useMemo(() => scenarioFact(p.ds, p.clientId), [p.ds, p.clientId]);
  const results = useMemo(() => (p.hasBooks ? scenarioResults(p.ds, p.clientId) : []), [p.ds, p.clientId, p.hasBooks]);

  if (!p.can("scenarios")) {
    return (
      <>
        <PortalHero
          title="Scenario comparison"
          subtitle="Your forecast under slower collections or heavier spend, side by side."
          tier={p.tier}
          testId="hero-portal-scenarios"
        />
        <LockedFeature feature="scenarios" fact={fact} currentTier={p.tier} />
      </>
    );
  }

  const weeks = results[0] ? results[0].weeks.length : 0;
  const chart = Array.from({ length: weeks }).map((_, i) => {
    const row: Record<string, string | number> = { name: results[0].weeks[i].label };
    for (const r of results) row[r.def.name] = Math.round(r.weeks[i].endingCash / 100);
    return row;
  });

  return (
    <>
      <PortalHero
        title="Scenario comparison"
        subtitle={`Each scenario starts from the same forecast for ${p.client.dba} and changes one thing. The assumption is written on every row, and no amount is invented.`}
        tier={p.tier}
        testId="hero-portal-scenarios"
      />

      {results.length === 0 ? (
        <SectionCard title="Scenarios" testId="card-portal-scenarios-empty">
          <EmptyState
            title="No base case yet"
            body="A scenario is your real forecast with one assumption changed. There is no cash activity to project from yet, so there is nothing to compare."
          />
        </SectionCard>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {results.map((r, i) => (
              <Kpi
                key={r.def.id}
                label={r.def.name}
                value={usd(r.endingCash)}
                hint={i === 0 ? "Ending cash in thirteen weeks" : `${usd(r.deltaFromBase)} against the base case`}
                tone={i === 0 ? "neutral" : r.deltaFromBase < 0 ? "watch" : "good"}
                testId={`kpi-portal-scn-${r.def.id}`}
              />
            ))}
          </div>

          <SectionCard
            title="Ending cash by week"
            description="Dollars at the end of each week under each assumption."
            actions={
              <div className="flex flex-wrap items-center gap-3">
                {results.map((r, i) => (
                  <span key={r.def.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="h-2 w-2 rounded-full" style={{ background: LINE_COLORS[i % LINE_COLORS.length] }} />
                    {r.def.name}
                  </span>
                ))}
              </div>
            }
            testId="card-portal-scn-chart"
          >
            <div className="h-56 p-2 sm:h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chart} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                  <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 11 }} width={68} stroke="hsl(var(--muted-foreground))" />
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
                  {results.map((r, i) => (
                    <Line
                      key={r.def.id}
                      type="monotone"
                      dataKey={r.def.name}
                      stroke={LINE_COLORS[i % LINE_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </SectionCard>

          <SectionCard title="Side by side" description="One row per scenario with the assumption stated in full." testId="card-portal-scn-table">
            <DataGrid<ScenarioResult>
              rows={results}
              rowKey={(r) => r.def.id}
              cols={[
                {
                  key: "name",
                  label: "Scenario",
                  mobile: "title",
                  render: (r) => (
                    <div className="min-w-0">
                      <p className="font-medium">{r.def.name}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{r.def.assumption}</p>
                    </div>
                  ),
                },
                { key: "ending", label: "Ending cash", align: "right", mobile: "value", render: (r) => <Money cents={r.endingCash} className="font-semibold" /> },
                { key: "low", label: "Tightest week", align: "right", mobile: "row", render: (r) => <Money cents={r.lowestCash} /> },
                { key: "lowWeek", label: "When", width: "96px", mobile: "row", render: (r) => <span className="text-xs">{r.lowestWeekLabel}</span> },
                {
                  key: "delta",
                  label: "Against base",
                  align: "right",
                  mobile: "row",
                  render: (r) => (r.def.id === "base" ? <span className="text-xs text-muted-foreground">Base case</span> : <Money cents={r.deltaFromBase} signed />),
                },
              ]}
              testId="grid-portal-scenarios"
            />
          </SectionCard>

          <PortalNote testId="note-portal-scn-basis">
            The base case is the forecast on your forecast page, unchanged. The other two take that same forecast and apply the assumption
            written next to them, in whole cents, with nothing else altered.
          </PortalNote>
        </>
      )}
    </>
  );
}
