import { useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid, EmptyState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { agingByParty, bucketFor, openBills, openInvoices, totalBuckets } from "@/data/derive";
import type { AgingBucketSet } from "@/data/derive";
import { fmtShortDate, usd } from "@/lib/money";
import { TODAY } from "@/data/seed";

const BUCKET_LABELS: { key: keyof Omit<AgingBucketSet, "total">; label: string }[] = [
  { key: "current", label: "Current" },
  { key: "b1", label: "1 to 30" },
  { key: "b31", label: "31 to 60" },
  { key: "b61", label: "61 to 90" },
  { key: "b90", label: "Over 90" },
];

export default function Aging() {
  const { ds, activeClient, activeClientId, loading, loadError, reload } = useApp();

  const invoices = useMemo(() => openInvoices(ds, activeClientId), [ds, activeClientId]);
  const bills = useMemo(() => openBills(ds, activeClientId), [ds, activeClientId]);

  const ar = agingByParty(invoices.map((i) => ({ party: i.customer, dueDate: i.dueDate, open: i.amountCents - i.paidCents })));
  const ap = agingByParty(bills.map((b) => ({ party: b.vendor, dueDate: b.dueDate, open: b.amountCents - b.paidCents })));
  const arTotal = totalBuckets(ar.map((r) => r.buckets));
  const apTotal = totalBuckets(ap.map((r) => r.buckets));

  const bucketCols = (rows: { party: string; buckets: AgingBucketSet }[], totals: AgingBucketSet) => ({
    rows,
    cols: [
      { key: "party", label: "Name", mobile: "title" as const, render: (r: { party: string }) => <span className="font-medium">{r.party}</span> },
      ...BUCKET_LABELS.map((b) => ({
        key: b.key,
        label: b.label,
        align: "right" as const,
        mobile: "row" as const,
        render: (r: { buckets: AgingBucketSet }) => <Money cents={r.buckets[b.key]} dim />,
      })),
      {
        key: "total",
        label: "Total open",
        align: "right" as const,
        mobile: "value" as const,
        render: (r: { buckets: AgingBucketSet }) => <Money cents={r.buckets.total} className="font-semibold" />,
      },
    ],
    footer: (
      <tr>
        <td className="px-3 py-2 text-sm font-semibold">Total</td>
        {BUCKET_LABELS.map((b) => (
          <td key={b.key} className="tnum px-3 py-2 text-right text-sm font-semibold">
            {usd(totals[b.key])}
          </td>
        ))}
        <td className="tnum px-3 py-2 text-right text-sm font-semibold">{usd(totals.total)}</td>
      </tr>
    ),
  });

  const arGrid = bucketCols(ar, arTotal);
  const apGrid = bucketCols(ap, apTotal);

  return (
    <>
      <PageHeader
        title="Receivables and payables"
        subtitle={`Open items for ${activeClient.dba} as of ${fmtShortDate(TODAY)}. Buckets are measured from the due date, and the subledgers tie to the general ledger.`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Receivables open" value={usd(arTotal.total)} hint={`${invoices.length} invoices`} testId="kpi-ar" />
        <Kpi
          label="Receivables past 30 days"
          value={usd(arTotal.b31 + arTotal.b61 + arTotal.b90)}
          tone={arTotal.b61 + arTotal.b90 > 0 ? "risk" : arTotal.b31 > 0 ? "watch" : "good"}
          hint="Worth a phone call today"
          testId="kpi-ar-late"
        />
        <Kpi label="Payables open" value={usd(apTotal.total)} hint={`${bills.length} bills`} testId="kpi-ap" />
        <Kpi
          label="Payables past due"
          value={usd(apTotal.b1 + apTotal.b31 + apTotal.b61 + apTotal.b90)}
          tone={apTotal.b31 + apTotal.b61 + apTotal.b90 > 0 ? "watch" : "good"}
          hint="Schedule these in the next run"
          testId="kpi-ap-late"
        />
      </div>

      <Tabs defaultValue="ar">
        <TabsList data-testid="tabs-aging">
          <TabsTrigger value="ar" data-testid="tab-ar">Receivables</TabsTrigger>
          <TabsTrigger value="ap" data-testid="tab-ap">Payables</TabsTrigger>
          <TabsTrigger value="detail" data-testid="tab-detail">Item detail</TabsTrigger>
        </TabsList>

        <TabsContent value="ar" className="mt-4">
          <SectionCard title="Receivables aging by customer" bodyClassName="p-0" testId="card-ar">
            <DataGrid
              rows={arGrid.rows}
              cols={arGrid.cols}
              rowKey={(r) => r.party}
              loading={loading}
              error={loadError}
              onRetry={reload}
              footer={arGrid.footer}
              empty={<EmptyState title="Every invoice is collected" body="Nothing is open on the receivables side right now." />}
            />
          </SectionCard>
        </TabsContent>

        <TabsContent value="ap" className="mt-4">
          <SectionCard title="Payables aging by vendor" bodyClassName="p-0" testId="card-ap">
            <DataGrid
              rows={apGrid.rows}
              cols={apGrid.cols}
              rowKey={(r) => r.party}
              loading={loading}
              error={loadError}
              onRetry={reload}
              footer={apGrid.footer}
              empty={<EmptyState title="No open bills" body="Everything the client owes has been paid." />}
            />
          </SectionCard>
        </TabsContent>

        <TabsContent value="detail" className="mt-4 space-y-4">
          <SectionCard title="Open invoices" bodyClassName="p-0" testId="card-invoices">
            <DataGrid
              rows={invoices}
              rowKey={(i) => i.id}
              loading={loading}
              error={loadError}
              onRetry={reload}
              dense
              empty={<EmptyState title="No open invoices" />}
              cols={[
                { key: "number", label: "Invoice", mobile: "sub", render: (i) => <span className="tnum text-xs">{i.number}</span> },
                { key: "customer", label: "Customer", mobile: "title", render: (i) => <span className="font-medium">{i.customer}</span> },
                { key: "class", label: "Class", mobile: "row", render: (i) => <span className="text-xs">{i.klass}</span> },
                { key: "date", label: "Issued", mobile: "row", render: (i) => <span className="tnum text-xs">{fmtShortDate(i.date)}</span> },
                { key: "due", label: "Due", mobile: "row", render: (i) => <span className="tnum text-xs">{fmtShortDate(i.dueDate)}</span> },
                {
                  key: "bucket",
                  label: "Age",
                  mobile: "row",
                  render: (i) => {
                    const b = bucketFor(i.dueDate, TODAY);
                    const label = BUCKET_LABELS.find((x) => x.key === b)!.label;
                    return <Pill tone={b === "current" ? "good" : b === "b1" ? "watch" : "risk"}>{label}</Pill>;
                  },
                },
                { key: "amount", label: "Invoiced", align: "right", mobile: "row", render: (i) => <Money cents={i.amountCents} /> },
                { key: "open", label: "Open", align: "right", mobile: "value", render: (i) => <Money cents={i.amountCents - i.paidCents} className="font-semibold" /> },
              ]}
            />
          </SectionCard>

          <SectionCard title="Open bills" bodyClassName="p-0" testId="card-bills">
            <DataGrid
              rows={bills}
              rowKey={(b) => b.id}
              loading={loading}
              error={loadError}
              onRetry={reload}
              dense
              empty={<EmptyState title="No open bills" />}
              cols={[
                { key: "number", label: "Bill", mobile: "sub", render: (b) => <span className="tnum text-xs">{b.number}</span> },
                { key: "vendor", label: "Vendor", mobile: "title", render: (b) => <span className="font-medium">{b.vendor}</span> },
                { key: "date", label: "Received", mobile: "row", render: (b) => <span className="tnum text-xs">{fmtShortDate(b.date)}</span> },
                { key: "due", label: "Due", mobile: "row", render: (b) => <span className="tnum text-xs">{fmtShortDate(b.dueDate)}</span> },
                {
                  key: "bucket",
                  label: "Age",
                  mobile: "row",
                  render: (b) => {
                    const k = bucketFor(b.dueDate, TODAY);
                    const label = BUCKET_LABELS.find((x) => x.key === k)!.label;
                    return <Pill tone={k === "current" ? "good" : k === "b1" ? "watch" : "risk"}>{label}</Pill>;
                  },
                },
                { key: "amount", label: "Billed", align: "right", mobile: "row", render: (b) => <Money cents={b.amountCents} /> },
                { key: "open", label: "Open", align: "right", mobile: "value", render: (b) => <Money cents={b.amountCents - b.paidCents} className="font-semibold" /> },
              ]}
            />
          </SectionCard>
        </TabsContent>
      </Tabs>
    </>
  );
}
