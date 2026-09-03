import { useMemo } from "react";
import { DataGrid, EmptyState, Kpi, Money, Pill, SectionCard } from "@/components/kit";
import { LockedFeature, PortalHero, PortalNote } from "@/components/portal/portal-kit";
import { usePortal } from "@/lib/use-portal";
import { profitAndLoss } from "@/data/derive";
import { openPeriodFact } from "@/data/portal-facts";
import { acctLabel } from "@/data/coa";
import { fmtPeriod, fmtShortDate, usd } from "@/lib/money";
import type { Txn } from "@/data/types";

/** Ledger+ feature. The month in progress, clearly marked as draft. */
export default function PortalOpenPeriod() {
  const p = usePortal();
  const open = p.openPeriod;

  const fact = useMemo(() => openPeriodFact(p.ds, p.clientId), [p.ds, p.clientId]);
  const pl = useMemo(() => (open ? profitAndLoss(p.ds, p.clientId, open) : null), [p.ds, p.clientId, open]);
  const rows = useMemo(
    () => (open ? p.ds.txns.filter((t) => t.clientId === p.clientId && t.period === open).slice().sort((a, b) => (a.date < b.date ? 1 : -1)) : []),
    [p.ds, p.clientId, open],
  );

  if (!p.can("open_period")) {
    return (
      <>
        <PortalHero
          title="The month in progress"
          subtitle="See where you stand before the month is closed, instead of waiting for the package."
          tier={p.tier}
          testId="hero-portal-open"
        />
        <LockedFeature feature="open_period" fact={fact} currentTier={p.tier} />
      </>
    );
  }

  const pending = rows.filter((t) => t.status === "needs_review");

  return (
    <>
      <PortalHero
        title="The month in progress"
        subtitle={
          open
            ? `${fmtPeriod(open)} for ${p.client.dba}. These numbers are real but not final, because the month has not been closed or reviewed yet.`
            : `Every month on your books is closed, so there is nothing in progress for ${p.client.dba}.`
        }
        tier={p.tier}
        meta={open ? <Pill tone="watch">Draft, not closed</Pill> : <Pill tone="good">All months closed</Pill>}
        testId="hero-portal-open"
      />

      {!open || !pl || rows.length === 0 ? (
        <SectionCard title="Month in progress" testId="card-portal-open-empty">
          <EmptyState
            title={open ? `Nothing has posted in ${fmtPeriod(open)} yet` : "No month is open"
            }
            body={
              open
                ? "The month is open but no activity has landed yet. Draft numbers appear as soon as transactions post."
                : "Every period on your books has been closed and locked. The next month opens when activity starts posting."
            }
          />
        </SectionCard>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Revenue so far" value={usd(pl.revenue)} hint="Draft" testId="kpi-portal-open-revenue" />
            <Kpi label="Spending so far" value={usd(pl.costOfSales + pl.operatingExpenses + pl.otherExpenses)} hint="Draft" testId="kpi-portal-open-spend" />
            <Kpi label="Net so far" value={usd(pl.netIncome)} tone={pl.netIncome >= 0 ? "good" : "watch"} hint="Draft" testId="kpi-portal-open-net" />
            <Kpi
              label="Still with us"
              value={String(pending.length)}
              hint="Waiting on a category or a receipt"
              tone={pending.length > 0 ? "watch" : "good"}
              testId="kpi-portal-open-pending"
            />
          </div>

          <PortalNote tone="watch" testId="note-portal-open-draft">
            Read this as a running total, not a closed month. Categories can still change, accruals are not booked until the close, and the
            reconciliation has not been done yet. The closed numbers arrive with the {fmtPeriod(open)} package.
          </PortalNote>

          <SectionCard title={`Draft profit and loss, ${fmtPeriod(open)}`} testId="card-portal-open-pl">
            <DataGrid
              rows={[
                { label: "Revenue", amount: pl.revenue },
                { label: "Cost of sales", amount: pl.costOfSales },
                { label: "Gross profit", amount: pl.grossProfit },
                { label: "Operating expenses", amount: pl.operatingExpenses },
                { label: "Net so far", amount: pl.netIncome },
              ]}
              rowKey={(r) => r.label}
              cols={[
                { key: "label", label: "Line", mobile: "title", render: (r) => <span>{r.label}</span> },
                { key: "amount", label: "Draft amount", align: "right", mobile: "value", render: (r) => <Money cents={r.amount} /> },
              ]}
              testId="grid-portal-open-pl"
            />
          </SectionCard>

          <SectionCard title={`Activity in ${fmtPeriod(open)}`} description={`${rows.length} transactions posted so far.`} testId="card-portal-open-txns">
            <DataGrid<Txn>
              rows={rows}
              rowKey={(t) => t.id}
              maxHeight="50vh"
              cols={[
                { key: "date", label: "Date", width: "96px", mobile: "sub", render: (t) => fmtShortDate(t.date) },
                {
                  key: "description",
                  label: "Description",
                  mobile: "title",
                  render: (t) => (
                    <div className="min-w-0">
                      <p className="truncate font-medium">{t.description}</p>
                      <p className="truncate text-xs text-muted-foreground">{acctLabel(t.categoryAccountId)}</p>
                    </div>
                  ),
                },
                {
                  key: "status",
                  label: "State",
                  width: "132px",
                  mobile: "row",
                  render: (t) => (t.status === "needs_review" ? <Pill tone="watch">With us for review</Pill> : <Pill tone="neutral">Coded</Pill>),
                },
                { key: "amount", label: "Amount", align: "right", width: "124px", mobile: "value", render: (t) => <Money cents={t.baseAmountCents} signed /> },
              ]}
              testId="grid-portal-open-txns"
            />
          </SectionCard>
        </>
      )}
    </>
  );
}
