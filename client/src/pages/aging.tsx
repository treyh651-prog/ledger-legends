import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, SectionCard } from "@/components/kit";
import { useActiveClient } from "@/lib/active-client";
import { useAging, errorMessage } from "@/api";
import { fmtShortDate, usd } from "@/lib/money";
import type { AgingBuckets, AgingParty } from "@shared/api";

const BUCKETS: { key: keyof Omit<AgingBuckets, "totalCents">; label: string }[] = [
  { key: "currentCents", label: "Current" },
  { key: "b1To30Cents", label: "1 to 30" },
  { key: "b31To60Cents", label: "31 to 60" },
  { key: "b61To90Cents", label: "61 to 90" },
  { key: "over90Cents", label: "Over 90" },
];

/**
 * Receivable and payable aging, read from GET /api/firm/clients/:id/aging.
 * Open balances come from posted invoices and bills in the subledger tables,
 * bucketed by days past due as of today.
 */
export default function Aging() {
  const { client, clientId } = useActiveClient();
  const q = useAging(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const grid = (rows: AgingParty[], totals: AgingBuckets | undefined, testId: string, emptyBody: string) => (
    <DataGrid<AgingParty>
      rows={rows}
      loading={q.isPending}
      rowKey={(r) => r.partyId}
      testId={testId}
      empty={<EmptyState title="Nothing open" body={emptyBody} />}
      cols={[
        { key: "party", label: "Name", mobile: "title", render: (r) => <span className="font-medium">{r.partyName}</span> },
        { key: "docs", label: "Open", align: "right", mobile: "row", render: (r) => <span className="tnum text-xs">{r.documentCount}</span> },
        ...BUCKETS.map((b) => ({
          key: b.key,
          label: b.label,
          align: "right" as const,
          mobile: "row" as const,
          render: (r: AgingParty) => <Money cents={r.buckets[b.key]} dim />,
        })),
        { key: "total", label: "Total", align: "right", mobile: "value", render: (r) => <Money cents={r.buckets.totalCents} className="font-semibold" /> },
      ]}
      footer={
        totals ? (
          <tr>
            <td className="px-3 py-2 text-sm font-semibold">Total</td>
            <td />
            {BUCKETS.map((b) => (
              <td key={b.key} className="tnum px-3 py-2 text-right text-sm font-semibold">
                {usd(totals[b.key])}
              </td>
            ))}
            <td className="tnum px-3 py-2 text-right text-sm font-semibold">{usd(totals.totalCents)}</td>
          </tr>
        ) : null
      }
    />
  );

  return (
    <div className="space-y-4" data-testid="page-aging">
      <PageHeader
        title="Aging"
        subtitle={`${client?.name ?? ""}. As of ${d ? fmtShortDate(d.asOfDate) : "today"}${d?.lastSnapshotDate ? `, last AR-REFRESH-AGING snapshot ${fmtShortDate(d.lastSnapshotDate)}` : ", no aging snapshot yet"}.`}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Receivable open" value={d ? <Money cents={d.receivableTotals.totalCents} /> : "…"} testId="kpi-ar-open" />
        <Kpi label="Receivable over 90" value={d ? <Money cents={d.receivableTotals.over90Cents} /> : "…"} tone={d && d.receivableTotals.over90Cents > 0 ? "risk" : "neutral"} />
        <Kpi label="Payable open" value={d ? <Money cents={d.payableTotals.totalCents} /> : "…"} />
        <Kpi label="Payable over 90" value={d ? <Money cents={d.payableTotals.over90Cents} /> : "…"} tone={d && d.payableTotals.over90Cents > 0 ? "watch" : "neutral"} />
      </div>
      <Tabs defaultValue="ar">
        <TabsList>
          <TabsTrigger value="ar" data-testid="tab-ar">Receivable</TabsTrigger>
          <TabsTrigger value="ap" data-testid="tab-ap">Payable</TabsTrigger>
        </TabsList>
        <TabsContent value="ar" className="mt-4">
          <SectionCard title="Accounts receivable" description="Open posted invoices by customer.">
            {grid(d?.receivable ?? [], d?.receivableTotals, "grid-ar", "No posted invoice carries an open balance.")}
          </SectionCard>
        </TabsContent>
        <TabsContent value="ap" className="mt-4">
          <SectionCard title="Accounts payable" description="Open posted bills by vendor.">
            {grid(d?.payable ?? [], d?.payableTotals, "grid-ap", "No posted bill carries an open balance.")}
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
