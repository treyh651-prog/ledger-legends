import { useMemo } from "react";
import { DataGrid, EmptyState, Kpi, Money, Pill, SectionCard } from "@/components/kit";
import { ClosePill, LockedFeature, PortalHero, PortalNote } from "@/components/portal/portal-kit";
import { usePortal } from "@/lib/use-portal";
import { priorPeriod, profitAndLoss } from "@/data/derive";
import { compareFact } from "@/data/portal-facts";
import { fmtPeriod, pct, usd } from "@/lib/money";
import type { Account } from "@/data/types";

interface Row {
  account: Account;
  amount: number;
  prior: number;
  delta: number;
  section: string;
}

/** Ledger+ feature. Month over month, line by line. */
export default function PortalCompare() {
  const p = usePortal();
  const readPeriod = p.period;
  const prior = readPeriod ? priorPeriod(readPeriod) : null;
  const fact = useMemo(
    () => (readPeriod ? compareFact(p.ds, p.clientId, readPeriod) : null),
    [p.ds, p.clientId, readPeriod],
  );
  const pl = useMemo(
    () => (readPeriod ? profitAndLoss(p.ds, p.clientId, readPeriod, prior) : null),
    [p.ds, p.clientId, readPeriod, prior],
  );

  if (!p.can("compare")) {
    return (
      <>
        <PortalHero
          title="Month over month"
          subtitle="See this month against last month, line by line, so you know what actually changed."
          tier={p.tier}
          testId="hero-portal-compare"
        />
        {fact ? <LockedFeature feature="compare" fact={fact} currentTier={p.tier} /> : null}
      </>
    );
  }

  const rows: Row[] = pl
    ? pl.sections.flatMap((s) =>
        s.rows.map((r) => ({ account: r.account, amount: r.amount, prior: r.prior, delta: r.amount - r.prior, section: s.label })),
      )
    : [];
  const movers = rows.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5);

  return (
    <>
      <PortalHero
        title="Month over month"
        subtitle={
          readPeriod && prior
            ? `${fmtPeriod(readPeriod)} against ${fmtPeriod(prior)} for ${p.client.dba}. Both columns come from your posted books.`
            : `Comparison for ${p.client.dba}.`
        }
        tier={p.tier}
        meta={<ClosePill close={p.close} />}
        testId="hero-portal-compare"
      />

      {!pl || !prior || !readPeriod ? (
        <SectionCard title="Comparison" testId="card-portal-compare-empty">
          <EmptyState
            title="Not enough closed months yet"
            body="A comparison needs two months of closed books. It turns on by itself as soon as the second month closes."
          />
        </SectionCard>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              label="Revenue change"
              value={usd(pl.revenue - pl.priorRevenue)}
              hint={pl.priorRevenue !== 0 ? pct(pl.revenue - pl.priorRevenue, pl.priorRevenue) : "No prior revenue to compare"}
              tone={pl.revenue >= pl.priorRevenue ? "good" : "watch"}
              testId="kpi-portal-cmp-revenue"
            />
            <Kpi
              label="Gross profit change"
              value={usd(pl.grossProfit - pl.priorGrossProfit)}
              tone={pl.grossProfit >= pl.priorGrossProfit ? "good" : "watch"}
              testId="kpi-portal-cmp-gross"
            />
            <Kpi
              label="Operating spend change"
              value={usd(pl.operatingExpenses - pl.priorOperatingExpenses)}
              tone={pl.operatingExpenses <= pl.priorOperatingExpenses ? "good" : "watch"}
              testId="kpi-portal-cmp-opex"
            />
            <Kpi
              label="Net income change"
              value={usd(pl.netIncome - pl.priorNetIncome)}
              tone={pl.netIncome >= pl.priorNetIncome ? "good" : "watch"}
              testId="kpi-portal-cmp-net"
            />
          </div>

          {movers.length > 0 ? (
            <SectionCard title="What moved the most" description="The five accounts with the largest change in either direction." testId="card-portal-movers">
              <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
                {movers.map((r) => (
                  <div key={r.account.id} className="rounded-md border border-border p-3" data-testid={`mover-${r.account.id}`}>
                    <p className="truncate text-sm font-medium">{r.account.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{r.section}</p>
                    <p className="mt-2 text-lg font-semibold">
                      <Money cents={r.delta} signed />
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {usd(r.prior)} to {usd(r.amount)}
                    </p>
                  </div>
                ))}
              </div>
            </SectionCard>
          ) : null}

          <SectionCard title="Line by line" description="Every account with activity in either month." testId="card-portal-compare">
            <DataGrid<Row>
              rows={rows}
              rowKey={(r) => r.section + r.account.id}
              maxHeight="60vh"
              cols={[
                {
                  key: "account",
                  label: "Account",
                  mobile: "title",
                  render: (r) => (
                    <div className="min-w-0">
                      <p className="truncate font-medium">{r.account.name}</p>
                      <p className="text-xs text-muted-foreground">{r.section}</p>
                    </div>
                  ),
                },
                { key: "prior", label: fmtPeriod(prior), align: "right", mobile: "row", render: (r) => <Money cents={r.prior} dim /> },
                { key: "amount", label: fmtPeriod(readPeriod), align: "right", mobile: "row", render: (r) => <Money cents={r.amount} /> },
                {
                  key: "delta",
                  label: "Change",
                  align: "right",
                  mobile: "value",
                  render: (r) => <Money cents={r.delta} signed className="font-medium" />,
                },
                {
                  key: "pctChange",
                  label: "Percent",
                  align: "right",
                  width: "110px",
                  mobile: "row",
                  render: (r) =>
                    r.prior === 0 ? (
                      <Pill tone="neutral">New this month</Pill>
                    ) : (
                      <span className="tnum text-sm">{pct(r.delta, Math.abs(r.prior))}</span>
                    ),
                },
              ]}
              testId="grid-portal-compare"
            />
          </SectionCard>

          <PortalNote testId="note-portal-compare-basis">
            Percent change is left out when an account had no balance in the prior month, because dividing by zero would print a number
            that means nothing. Those lines read as new this month instead.
          </PortalNote>
        </>
      )}
    </>
  );
}
