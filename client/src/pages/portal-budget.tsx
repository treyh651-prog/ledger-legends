import { useMemo } from "react";
import { DataGrid, EmptyState, Kpi, Meter, Money, Pill, SectionCard } from "@/components/kit";
import { ClosePill, LockedFeature, PortalHero, PortalNote } from "@/components/portal/portal-kit";
import { usePortal } from "@/lib/use-portal";
import { budgetVsActual, type BvaRow } from "@/data/derive";
import { budgetFact } from "@/data/portal-facts";
import { fmtPeriod, pct, usd } from "@/lib/money";

/** Ledger+ feature. Plan against actual for the period being read. */
export default function PortalBudget() {
  const p = usePortal();
  const readPeriod = p.period;

  const fact = useMemo(() => (readPeriod ? budgetFact(p.ds, p.clientId, readPeriod) : null), [p.ds, p.clientId, readPeriod]);
  const bva = useMemo(
    () => (readPeriod && p.can("budget") ? budgetVsActual(p.ds, p.clientId, readPeriod) : null),
    [p.ds, p.clientId, readPeriod, p],
  );

  if (!p.can("budget")) {
    return (
      <>
        <PortalHero
          title="Budget versus actual"
          subtitle="Where your spending landed against the plan, account by account."
          tier={p.tier}
          testId="hero-portal-budget"
        />
        {fact ? <LockedFeature feature="budget" fact={fact} currentTier={p.tier} /> : null}
      </>
    );
  }

  const rows = bva ? bva.rows : [];
  const over = rows.filter((r) => !r.favorable && r.variance !== 0);
  const totals = bva ? bva.totals : { actual: 0, budget: 0, variance: 0 };

  return (
    <>
      <PortalHero
        title="Budget versus actual"
        subtitle={
          readPeriod
            ? `${fmtPeriod(readPeriod)} for ${p.client.dba}. Actuals are your posted amounts. Plan amounts are the budget on file with us.`
            : `Plan tracking for ${p.client.dba}.`
        }
        tier={p.tier}
        meta={<ClosePill close={p.close} />}
        testId="hero-portal-budget"
      />

      {rows.length === 0 ? (
        <SectionCard title="Budget" testId="card-portal-budget-empty">
          <EmptyState
            title="No plan loaded for this month"
            body="Send us a budget for this period and this screen starts tracking against it. Without a plan there is no variance to read, so nothing is shown rather than a row of zeros."
          />
        </SectionCard>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Actual" value={usd(totals.actual)} testId="kpi-portal-bva-actual" />
            <Kpi label="Plan" value={usd(totals.budget)} testId="kpi-portal-bva-plan" />
            <Kpi
              label="Variance"
              value={usd(totals.variance)}
              hint={totals.budget !== 0 ? pct(totals.variance, Math.abs(totals.budget)) + " of plan" : "No plan total to compare"}
              tone={totals.variance <= 0 ? "good" : "watch"}
              testId="kpi-portal-bva-variance"
            />
            <Kpi
              label="Accounts over plan"
              value={String(over.length)}
              hint={`of ${rows.length} tracked`}
              tone={over.length > 0 ? "watch" : "good"}
              testId="kpi-portal-bva-over"
            />
          </div>

          <SectionCard title="By account" description="Sorted by the size of the gap so the biggest item is first." testId="card-portal-bva">
            <DataGrid<BvaRow>
              rows={rows.slice().sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))}
              rowKey={(r) => r.account.id}
              maxHeight="60vh"
              cols={[
                {
                  key: "account",
                  label: "Account",
                  mobile: "title",
                  render: (r) => (
                    <div className="min-w-0">
                      <p className="truncate font-medium">{r.account.name}</p>
                      <p className="text-xs text-muted-foreground">{r.account.code}</p>
                    </div>
                  ),
                },
                { key: "actual", label: "Actual", align: "right", mobile: "row", render: (r) => <Money cents={r.actual} /> },
                { key: "budget", label: "Plan", align: "right", mobile: "row", render: (r) => <Money cents={r.budget} dim /> },
                {
                  key: "variance",
                  label: "Gap",
                  align: "right",
                  mobile: "value",
                  render: (r) => <Money cents={r.variance} signed className="font-medium" />,
                },
                {
                  key: "share",
                  label: "Against plan",
                  width: "150px",
                  mobile: "row",
                  render: (r) =>
                    r.budget === 0 ? (
                      <Pill tone="neutral">Not in the plan</Pill>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Meter
                          pct={Math.min(200, Math.round((Math.abs(r.actual) / Math.abs(r.budget)) * 100))}
                          tone={r.favorable ? "primary" : "warning"}
                        />
                        <span className="tnum w-12 shrink-0 text-right text-xs">{pct(Math.abs(r.actual), Math.abs(r.budget), 0)}</span>
                      </div>
                    ),
                },
              ]}
              testId="grid-portal-bva"
            />
          </SectionCard>

          <PortalNote testId="note-portal-bva-basis">
            Accounts with no plan amount show as not in the plan instead of a percentage, because a share of zero is not a number worth
            printing.
          </PortalNote>
        </>
      )}
    </>
  );
}
