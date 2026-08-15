import { Fragment, useMemo } from "react";
import { CheckCircle2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { balanceSheet, cashFlow, profitAndLoss, trialBalance } from "@/data/derive";
import { PERIODS } from "@/data/seed";
import { fmtPeriod, pct, usd } from "@/lib/money";

function Row({
  label,
  value,
  compare,
  indent = 0,
  bold = false,
  top = false,
  hint,
}: {
  label: string;
  value: number;
  compare?: number | null;
  indent?: number;
  bold?: boolean;
  top?: boolean;
  hint?: string;
}) {
  const delta = compare === undefined || compare === null ? null : value - compare;
  return (
    <tr className={top ? "border-t border-border" : ""}>
      <td className={`px-3 py-1.5 ${bold ? "font-semibold" : ""}`} style={{ paddingLeft: 12 + indent * 16 }}>
        {label}
        {hint ? <span className="ml-2 text-xs text-muted-foreground">{hint}</span> : null}
      </td>
      <td className={`tnum whitespace-nowrap px-3 py-1.5 text-right ${bold ? "font-semibold" : ""}`}>{usd(value)}</td>
      {compare !== undefined ? (
        <>
          <td className="tnum hidden whitespace-nowrap px-3 py-1.5 text-right text-muted-foreground sm:table-cell">
            {compare === null ? "" : usd(compare)}
          </td>
          <td className={`tnum hidden whitespace-nowrap px-3 py-1.5 text-right sm:table-cell ${delta && delta < 0 ? "text-destructive" : ""}`}>
            {delta === null ? "" : usd(delta)}
          </td>
        </>
      ) : null}
    </tr>
  );
}

function StatementFrame({ children, compare }: { children: React.ReactNode; compare?: string | null }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground">Line</th>
            <th className="px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted-foreground">This period</th>
            {compare !== undefined ? (
              <>
                <th className="hidden px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted-foreground sm:table-cell">
                  {compare ? fmtPeriod(compare) : "Comparison"}
                </th>
                <th className="hidden px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted-foreground sm:table-cell">Change</th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export default function Statements() {
  const { ds, activeClient, activeClientId, period, comparePeriod, setComparePeriod } = useApp();

  const pl = useMemo(() => profitAndLoss(ds, activeClientId, period, comparePeriod), [ds, activeClientId, period, comparePeriod]);
  const bs = useMemo(() => balanceSheet(ds, activeClientId, period), [ds, activeClientId, period]);
  const cf = useMemo(() => cashFlow(ds, activeClientId, period), [ds, activeClientId, period]);
  const tb = useMemo(() => trialBalance(ds, activeClientId, period), [ds, activeClientId, period]);

  const margin = pl.revenue ? (pl.grossProfit / pl.revenue) * 100 : 0;

  return (
    <>
      <PageHeader
        title="Financial statements"
        subtitle={`${activeClient.dba} for ${fmtPeriod(period)}. Figures come straight from posted journal entries, so what you see here is what is on the ledger.`}
        actions={
          <Select value={comparePeriod || "none"} onValueChange={(v) => setComparePeriod(v === "none" ? null : v)}>
            <SelectTrigger className="h-8 w-[190px] text-xs" data-testid="select-compare">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No comparison</SelectItem>
              {PERIODS.filter((p) => p !== period).map((p) => (
                <SelectItem key={p} value={p}>
                  Compare to {fmtPeriod(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Revenue" value={usd(pl.revenue)} hint={comparePeriod ? `${usd(pl.revenue - pl.priorRevenue)} versus comparison` : undefined} testId="kpi-st-revenue" />
        <Kpi label="Gross margin" value={pct(margin)} hint={`Cost of sales ${usd(pl.costOfSales)}`} tone={margin >= 40 ? "good" : "watch"} testId="kpi-st-margin" />
        <Kpi label="Net income" value={usd(pl.netIncome)} tone={pl.netIncome >= 0 ? "good" : "risk"} testId="kpi-st-net" />
        <Kpi
          label="Balance sheet check"
          value={bs.balanced ? "In balance" : usd(bs.difference)}
          tone={bs.balanced ? "good" : "risk"}
          hint={`Assets ${usd(bs.totalAssets)}`}
          testId="kpi-st-balanced"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-positive/40 bg-positive-soft p-3 text-sm" data-testid="banner-ties">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-positive" />
        <span className="text-muted-foreground">
          Debits equal credits at {usd(tb.totalDebit)}. Assets equal liabilities plus equity. Cash flow ends at {usd(cf.endingCash)}, which matches
          the balance sheet.
        </span>
      </div>

      <Tabs defaultValue="pl">
        <TabsList data-testid="tabs-statements">
          <TabsTrigger value="pl" data-testid="tab-pl">Profit and loss</TabsTrigger>
          <TabsTrigger value="bs" data-testid="tab-bs">Balance sheet</TabsTrigger>
          <TabsTrigger value="cf" data-testid="tab-cf">Cash flow</TabsTrigger>
          <TabsTrigger value="tb" data-testid="tab-tb">Trial balance</TabsTrigger>
        </TabsList>

        <TabsContent value="pl" className="mt-4">
          <SectionCard title={`Profit and loss, ${fmtPeriod(period)}`} bodyClassName="p-0" testId="card-pl">
            <StatementFrame compare={comparePeriod}>
              {pl.sections.map((s) => (
                <Fragment key={s.key}>
                  <Row label={s.label} value={s.total} compare={comparePeriod ? s.priorTotal : undefined} bold top />
                  {s.rows.map((r) => (
                    <Row key={r.account.id} label={`${r.account.code} ${r.account.name}`} value={r.amount} compare={comparePeriod ? r.prior : undefined} indent={1} />
                  ))}
                  {s.key === "cos" ? (
                    <Row label="Gross profit" value={pl.grossProfit} compare={comparePeriod ? pl.priorGrossProfit : undefined} bold top />
                  ) : null}
                </Fragment>
              ))}
              <Row label="Net income" value={pl.netIncome} compare={comparePeriod ? pl.priorNetIncome : undefined} bold top />
            </StatementFrame>
          </SectionCard>
        </TabsContent>

        <TabsContent value="bs" className="mt-4">
          <SectionCard title={`Balance sheet as of the end of ${fmtPeriod(period)}`} bodyClassName="p-0" testId="card-bs">
            <StatementFrame>
              {bs.assetGroups.map((g) => (
                <Fragment key={g.key}>
                  <Row label={g.label} value={g.total} bold top />
                  {g.rows.map((r) => (
                    <Row key={r.account.id} label={`${r.account.code} ${r.account.name}`} value={r.amount} indent={1} />
                  ))}
                </Fragment>
              ))}
              <Row label="Total assets" value={bs.totalAssets} bold top />
              {bs.liabilityGroups.map((g) => (
                <Fragment key={g.key}>
                  <Row label={g.label} value={g.total} bold top />
                  {g.rows.map((r) => (
                    <Row key={r.account.id} label={`${r.account.code} ${r.account.name}`} value={r.amount} indent={1} />
                  ))}
                </Fragment>
              ))}
              <Row label="Total liabilities" value={bs.totalLiabilities} bold top />
              <Row label="Equity" value={bs.totalEquity} bold top />
              {bs.equity.rows.map((r) => (
                <Row key={r.account.id} label={`${r.account.code} ${r.account.name}`} value={r.amount} indent={1} />
              ))}
              <Row label="Net income year to date" value={bs.netIncomeYtd} indent={1} />
              <Row label="Total liabilities and equity" value={bs.totalLiabilities + bs.totalEquity} bold top />
            </StatementFrame>
            <div className="border-t border-border px-4 py-3">
              <Pill tone={bs.balanced ? "good" : "risk"}>
                {bs.balanced ? "Assets equal liabilities plus equity" : `Out of balance by ${usd(bs.difference)}`}
              </Pill>
            </div>
          </SectionCard>
        </TabsContent>

        <TabsContent value="cf" className="mt-4">
          <SectionCard title={`Statement of cash flows, ${fmtPeriod(period)}`} description="Direct method, built from the cash side of every posted entry." bodyClassName="p-0" testId="card-cf">
            <StatementFrame>
              <Row label="Cash at the start of the period" value={cf.beginningCash} bold />
              <Row label="Operating activities" value={cf.operatingTotal} bold top />
              {cf.operating.map((r) => (
                <Row key={r.label} label={r.label} value={r.amount} indent={1} />
              ))}
              <Row label="Investing activities" value={cf.investingTotal} bold top />
              {cf.investing.length ? (
                cf.investing.map((r) => <Row key={r.label} label={r.label} value={r.amount} indent={1} />)
              ) : (
                <Row label="No investing activity this period" value={0} indent={1} />
              )}
              <Row label="Financing activities" value={cf.financingTotal} bold top />
              {cf.financing.length ? (
                cf.financing.map((r) => <Row key={r.label} label={r.label} value={r.amount} indent={1} />)
              ) : (
                <Row label="No financing activity this period" value={0} indent={1} />
              )}
              <Row label="Net change in cash" value={cf.netChange} bold top />
              <Row label="Cash at the end of the period" value={cf.endingCash} bold />
            </StatementFrame>
            <div className="border-t border-border px-4 py-3">
              <Pill tone={cf.ties ? "good" : "risk"}>
                {cf.ties ? "Opening cash plus the net change equals closing cash" : "This statement does not tie, check the cash accounts"}
              </Pill>
            </div>
          </SectionCard>
        </TabsContent>

        <TabsContent value="tb" className="mt-4">
          <SectionCard title={`Trial balance through ${fmtPeriod(period)}`} bodyClassName="p-0" testId="card-tb">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-3 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground">Account</th>
                    <th className="px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted-foreground">Debit</th>
                    <th className="px-3 py-2 text-right text-[11px] uppercase tracking-wide text-muted-foreground">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {tb.rows.map((r) => (
                    <tr key={r.account.id} className="border-b border-border/60">
                      <td className="px-3 py-1.5">
                        <span className="tnum text-muted-foreground">{r.account.code}</span> {r.account.name}
                      </td>
                      <td className="tnum px-3 py-1.5 text-right">{r.debit ? usd(r.debit) : ""}</td>
                      <td className="tnum px-3 py-1.5 text-right">{r.credit ? usd(r.credit) : ""}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-muted/40">
                    <td className="px-3 py-2 font-semibold">Totals</td>
                    <td className="tnum px-3 py-2 text-right font-semibold">{usd(tb.totalDebit)}</td>
                    <td className="tnum px-3 py-2 text-right font-semibold">{usd(tb.totalCredit)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="border-t border-border px-4 py-3">
              <Pill tone={tb.totalDebit === tb.totalCredit ? "good" : "risk"}>
                {tb.totalDebit === tb.totalCredit ? "Debits equal credits" : `Out by ${usd(tb.totalDebit - tb.totalCredit)}`}
              </Pill>
            </div>
          </SectionCard>
        </TabsContent>
      </Tabs>
    </>
  );
}
