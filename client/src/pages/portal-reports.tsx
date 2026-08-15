import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { DataGrid, Kpi, Money, PageHeader, PageHeader as _PH, SectionCard, ToneDot } from "@/components/kit";
import { useApp } from "@/store";
import { balanceSheet, cashFlow, monthlyNarrative, monthlyTrend, profitAndLoss } from "@/data/derive";
import { PERIODS } from "@/data/seed";
import { fmtPeriod, fmtPeriodShort, usd } from "@/lib/money";

export default function PortalReports() {
  const { ds, activeClient, activeClientId, period, setPeriod, logAudit } = useApp();
  const { toast } = useToast();

  const pl = useMemo(() => profitAndLoss(ds, activeClientId, period), [ds, activeClientId, period]);
  const bs = useMemo(() => balanceSheet(ds, activeClientId, period), [ds, activeClientId, period]);
  const cf = useMemo(() => cashFlow(ds, activeClientId, period), [ds, activeClientId, period]);
  const trend = useMemo(() => monthlyTrend(ds, activeClientId), [ds, activeClientId]);
  const points = useMemo(() => monthlyNarrative(ds, activeClientId, period), [ds, activeClientId, period]);

  const chart = trend.map((t) => ({
    name: fmtPeriodShort(t.period),
    Revenue: Math.round(t.revenue / 100),
    Expenses: Math.round(t.expenses / 100),
    Cash: Math.round(t.cash / 100),
  }));

  const lines = [
    { label: "Revenue", value: pl.revenue },
    { label: "Cost of sales", value: pl.costOfSales },
    { label: "Gross profit", value: pl.grossProfit },
    { label: "Operating expenses", value: pl.operatingExpenses },
    { label: "Net income", value: pl.netIncome },
  ];

  return (
    <>
      <PageHeader
        title="Your reports"
        subtitle={`Statements for ${activeClient.dba}, released once the close is reviewed. Pick a month to read the package that went with it.`}
        actions={
          <>
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="h-8 w-[170px] text-xs" data-testid="select-portal-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {fmtPeriod(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                logAudit(undefined, `${fmtPeriod(period)} package`, "downloaded", "Client downloaded the monthly package", activeClient.contacts[0]?.name || "Client contact", "portal");
                toast({ title: "Download recorded", description: "The history shows when you opened it." });
              }}
              data-testid="button-portal-download"
            >
              <Download className="mr-1 h-4 w-4" />
              Download the package
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Revenue" value={usd(pl.revenue)} tone={pl.revenue >= pl.priorRevenue ? "good" : "watch"} testId="kpi-pr-revenue" />
        <Kpi label="Net income" value={usd(pl.netIncome)} tone={pl.netIncome >= 0 ? "good" : "risk"} testId="kpi-pr-net" />
        <Kpi label="Total assets" value={usd(bs.totalAssets)} testId="kpi-pr-assets" />
        <Kpi label="Cash at month end" value={usd(cf.endingCash)} testId="kpi-pr-cash" />
      </div>

      <SectionCard title="Twelve month view" description="Revenue, spending, and cash in dollars, straight from the closed books." testId="card-portal-trend">
        <div className="h-[260px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 4, right: 8, left: -6, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={58} />
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
              <Line type="monotone" dataKey="Revenue" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Expenses" stroke="hsl(var(--chart-4))" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Cash" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title={`Profit and loss, ${fmtPeriod(period)}`} bodyClassName="p-0" testId="card-portal-pl">
          <DataGrid
            rows={lines}
            rowKey={(l) => l.label}
            dense
            cols={[
              { key: "label", label: "Line", mobile: "title", render: (l) => l.label },
              { key: "value", label: "Amount", align: "right", mobile: "value", render: (l) => <Money cents={l.value} /> },
            ]}
          />
        </SectionCard>

        <SectionCard title="What your accountant wrote" bodyClassName="p-0" testId="card-portal-notes">
          <ul className="divide-y divide-border">
            {points.map((p) => (
              <li key={p.heading} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <ToneDot tone={p.tone} />
                  <p className="text-sm font-semibold">{p.heading}</p>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
              </li>
            ))}
          </ul>
        </SectionCard>
      </div>

      <SectionCard title="Past packages" bodyClassName="p-0" testId="card-portal-past">
        <DataGrid
          rows={[...PERIODS].reverse()}
          rowKey={(p) => p}
          dense
          onRowClick={(p) => setPeriod(p)}
          cols={[
            {
              key: "period",
              label: "Month",
              mobile: "title",
              render: (p) => (
                <span className="inline-flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  {fmtPeriod(p)} package
                </span>
              ),
            },
            {
              key: "net",
              label: "Net income",
              align: "right",
              mobile: "value",
              render: (p) => <Money cents={profitAndLoss(ds, activeClientId, p).netIncome} />,
            },
            {
              key: "open",
              label: "",
              align: "right",
              mobile: "row",
              render: (p) => <span className="text-xs text-primary">{p === period ? "Open now" : "Read it"}</span>,
            },
          ]}
        />
      </SectionCard>
    </>
  );
}
