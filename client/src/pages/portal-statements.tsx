import { useMemo } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataGrid, EmptyState, Kpi, Money, SectionCard } from "@/components/kit";
import { ClosePill, LockedFeature, PortalHero, PortalNote } from "@/components/portal/portal-kit";
import { useApp } from "@/store";
import { usePortal } from "@/lib/use-portal";
import { balanceSheet, cashFlow, profitAndLoss } from "@/data/derive";
import { compareFact, openPeriodFact } from "@/data/portal-facts";
import { fmtPeriod, usd } from "@/lib/money";

/** A client's own statements for closed periods. This is base level and it is never gated. */
export default function PortalStatements() {
  const p = usePortal();
  const { period: headerPeriod, setPeriod } = useApp();
  const readPeriod = p.period;

  const pl = useMemo(() => (readPeriod ? profitAndLoss(p.ds, p.clientId, readPeriod) : null), [p.ds, p.clientId, readPeriod]);
  const bs = useMemo(() => (readPeriod ? balanceSheet(p.ds, p.clientId, readPeriod) : null), [p.ds, p.clientId, readPeriod]);
  const cf = useMemo(() => (readPeriod ? cashFlow(p.ds, p.clientId, readPeriod) : null), [p.ds, p.clientId, readPeriod]);
  const compare = useMemo(() => (readPeriod ? compareFact(p.ds, p.clientId, readPeriod) : null), [p.ds, p.clientId, readPeriod]);
  const openFact = useMemo(() => openPeriodFact(p.ds, p.clientId), [p.ds, p.clientId]);

  const plRows = pl
    ? [
        { label: "Revenue", amount: pl.revenue, strong: true },
        { label: "Cost of sales", amount: pl.costOfSales, strong: false },
        { label: "Gross profit", amount: pl.grossProfit, strong: true },
        { label: "Operating expenses", amount: pl.operatingExpenses, strong: false },
        { label: "Other expense", amount: pl.otherExpenses, strong: false },
        { label: "Net income", amount: pl.netIncome, strong: true },
      ]
    : [];

  return (
    <>
      <PortalHero
        title="Your financial statements"
        subtitle={`Profit and loss, balance sheet, and cash flow for ${p.client.dba}, built from your posted books. Your records are always open to you.`}
        tier={p.tier}
        meta={<ClosePill close={p.close} testId="pill-statements-close" />}
        actions={
          p.visiblePeriods.length > 0 ? (
            <Select value={readPeriod || headerPeriod} onValueChange={setPeriod}>
              <SelectTrigger className="h-8 w-[170px] text-xs" data-testid="select-portal-statement-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {p.visiblePeriods.map((v) => (
                  <SelectItem key={v} value={v}>
                    {fmtPeriod(v)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null
        }
        testId="hero-portal-statements"
      />

      {p.periodHeldBack && readPeriod ? (
        <PortalNote testId="note-statements-heldback">
          {fmtPeriod(p.requestedPeriod)} is still open, so this page is showing {fmtPeriod(readPeriod)}, the last month we closed and
          reviewed. Open period numbers are part of Ledger+.
        </PortalNote>
      ) : null}

      {p.close && p.close.state === "open" && readPeriod ? (
        <PortalNote tone="watch" testId="note-statements-draft">
          {fmtPeriod(readPeriod)} is not closed yet, so treat every figure below as a draft. Entries can still change while we finish the
          month, and the pill at the top will read closed once we are done.
        </PortalNote>
      ) : null}

      {!readPeriod || !pl || !bs || !cf ? (
        <SectionCard title="Statements" testId="card-portal-statements-empty">
          <EmptyState
            title="No closed month yet"
            body="Statements are released once a month is closed and reviewed. Nothing is being held back from you, there is simply no closed period on your books yet."
          />
        </SectionCard>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Revenue" value={usd(pl.revenue)} hint={fmtPeriod(readPeriod)} tone="neutral" testId="kpi-portal-revenue" />
            <Kpi label="Net income" value={usd(pl.netIncome)} tone={pl.netIncome >= 0 ? "good" : "risk"} testId="kpi-portal-net" />
            <Kpi label="Cash at month end" value={usd(cf.endingCash)} testId="kpi-portal-cash" />
            <Kpi
              label="Balance sheet"
              value={bs.balanced ? "In balance" : "Out of balance"}
              hint={bs.balanced ? "Assets equal liabilities plus equity" : `Difference of ${usd(bs.difference)}`}
              tone={bs.balanced ? "good" : "risk"}
              testId="kpi-portal-balanced"
            />
          </div>

          <SectionCard
            title={`Profit and loss, ${fmtPeriod(readPeriod)}`}
            description="Every line comes from your own posted entries."
            testId="card-portal-pl"
          >
            <DataGrid
              rows={plRows}
              rowKey={(r) => r.label}
              cols={[
                {
                  key: "label",
                  label: "Line",
                  mobile: "title",
                  render: (r) => <span className={r.strong ? "font-semibold" : ""}>{r.label}</span>,
                },
                {
                  key: "amount",
                  label: "Amount",
                  align: "right",
                  mobile: "value",
                  render: (r) => <Money cents={r.amount} className={r.strong ? "font-semibold" : ""} />,
                },
              ]}
              testId="grid-portal-pl"
            />
          </SectionCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title={`Balance sheet, ${fmtPeriod(readPeriod)}`} testId="card-portal-bs">
              <DataGrid
                rows={[
                  { label: "Total assets", amount: bs.totalAssets },
                  { label: "Total liabilities", amount: bs.totalLiabilities },
                  { label: "Total equity", amount: bs.totalEquity },
                  { label: "Net income year to date", amount: bs.netIncomeYtd },
                ]}
                rowKey={(r) => r.label}
                cols={[
                  { key: "label", label: "Line", mobile: "title", render: (r) => <span>{r.label}</span> },
                  { key: "amount", label: "Amount", align: "right", mobile: "value", render: (r) => <Money cents={r.amount} /> },
                ]}
                testId="grid-portal-bs"
              />
            </SectionCard>

            <SectionCard title={`Cash flow, ${fmtPeriod(readPeriod)}`} testId="card-portal-cf">
              <DataGrid
                rows={[
                  { label: "Operating", amount: cf.operatingTotal },
                  { label: "Investing", amount: cf.investingTotal },
                  { label: "Financing", amount: cf.financingTotal },
                  { label: "Cash at month end", amount: cf.endingCash },
                ]}
                rowKey={(r) => r.label}
                cols={[
                  { key: "label", label: "Section", mobile: "title", render: (r) => <span>{r.label}</span> },
                  { key: "amount", label: "Amount", align: "right", mobile: "value", render: (r) => <Money cents={r.amount} signed /> },
                ]}
                testId="grid-portal-cf"
              />
            </SectionCard>
          </div>
        </>
      )}

      {!p.can("compare") && compare ? (
        <LockedFeature feature="compare" fact={compare} currentTier={p.tier} testId="locked-portal-compare" />
      ) : null}
      {!p.can("open_period") ? (
        <LockedFeature feature="open_period" fact={openFact} currentTier={p.tier} testId="locked-portal-openperiod" />
      ) : null}
    </>
  );
}
