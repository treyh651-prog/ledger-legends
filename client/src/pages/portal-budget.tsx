import { DataGrid, EmptyState, Kpi, Money, Pill, SectionCard } from "@/components/kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalBudget } from "@/api";
import { fmtPeriod } from "@/lib/money";
import type { PortalBudget as PortalBudgetData } from "@shared/api";

type Row = PortalBudgetData["items"][number];

/**
 * Legend feature. Budget versus actual by account for the latest period,
 * read from GET /api/portal/:clientId/budget. Rows are the variances the
 * engine computed when the period closed. No budget is said plainly.
 */
export default function PortalBudget() {
  return (
    <PortalScreen title="Budget versus actual" subtitle="Where spending landed against the plan, by account." testId="hero-portal-budget">
      {({ clientId }) => <Body clientId={clientId} />}
    </PortalScreen>
  );
}

function Body({ clientId }: { clientId: string }) {
  const q = usePortalBudget(clientId, null);
  return (
    <QueryBody q={q} title="Budget versus actual" testId="card-portal-budget">
      {(data) => {
        const flagged = data.items.filter((r) => r.flagged);
        const actual = data.items.reduce((s, r) => s + r.actualCents, 0);
        const budget = data.items.reduce((s, r) => s + r.budgetCents, 0);
        return (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Period" value={data.periodStart ? fmtPeriod(data.periodStart.slice(0, 7)) : "No period"} testId="kpi-budget-period" />
              <Kpi label="Actual" value={<Money cents={actual} />} testId="kpi-budget-actual" />
              <Kpi label="Budget" value={<Money cents={budget} />} testId="kpi-budget-budget" />
              <Kpi label="Flagged lines" value={flagged.length} tone={flagged.length ? "watch" : "good"} testId="kpi-budget-flagged" />
            </div>
            <SectionCard title="By account" bodyClassName="p-0" testId="card-portal-budget-rows">
              <DataGrid<Row>
                rows={data.items}
                rowKey={(r) => r.accountNumber}
                testId="grid-portal-budget"
                empty={
                  <EmptyState
                    title={data.periodStart ? (data.budgetLineCount > 0 ? "Variances have not been computed yet" : "No budget has been entered") : "No period on your books yet"}
                    body={
                      data.periodStart
                        ? data.budgetLineCount > 0
                          ? `A budget with ${data.budgetLineCount} lines is on file for ${fmtPeriod(data.periodStart.slice(0, 7))}. The comparison is computed when the month closes.`
                          : "Budget versus actual needs a budget. Once your accountant enters one, the comparison appears here after each close."
                        : "The first month has not been opened, so there is nothing to compare against a budget."
                    }
                  />
                }
                cols={[
                  { key: "acct", label: "Account", render: (r) => <span className="font-medium">{r.accountNumber} {r.accountName}</span> },
                  { key: "actual", label: "Actual", align: "right", render: (r) => <Money cents={r.actualCents} /> },
                  { key: "budget", label: "Budget", align: "right", render: (r) => <Money cents={r.budgetCents} /> },
                  { key: "var", label: "Variance", align: "right", render: (r) => <Money cents={r.varianceCents} /> },
                  {
                    key: "dir",
                    label: "Read",
                    render: (r) => (
                      <Pill tone={r.direction === "favorable" ? "good" : r.direction === "unfavorable" ? (r.flagged ? "risk" : "watch") : "neutral"}>
                        {r.direction === "favorable" ? "Favorable" : r.direction === "unfavorable" ? "Unfavorable" : "On plan"}
                      </Pill>
                    ),
                  },
                  { key: "detail", label: "Note", render: (r) => <span className="text-muted-foreground">{r.detail}</span> },
                ]}
              />
            </SectionCard>
          </>
        );
      }}
    </QueryBody>
  );
}
