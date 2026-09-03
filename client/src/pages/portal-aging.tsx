import { useMemo } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid, EmptyState, Kpi, Money, SectionCard } from "@/components/kit";
import { LockedFeature, PortalHero, PortalNote } from "@/components/portal/portal-kit";
import { usePortal } from "@/lib/use-portal";
import { agingByParty, openBills, openInvoices, totalBuckets, type AgingBucketSet } from "@/data/derive";
import { agingFact } from "@/data/portal-facts";
import { TODAY } from "@/data/seed";
import { fmtShortDate, usd } from "@/lib/money";

const BUCKETS: { key: keyof Omit<AgingBucketSet, "total">; label: string }[] = [
  { key: "current", label: "Current" },
  { key: "b1", label: "1 to 30" },
  { key: "b31", label: "31 to 60" },
  { key: "b61", label: "61 to 90" },
  { key: "b90", label: "Over 90" },
];

interface PartyRow {
  party: string;
  buckets: AgingBucketSet;
}

/** Ledger+ feature. Collections and payables detail. */
export default function PortalAging() {
  const p = usePortal();

  const fact = useMemo(() => agingFact(p.ds, p.clientId), [p.ds, p.clientId]);
  const invoices = useMemo(() => openInvoices(p.ds, p.clientId), [p.ds, p.clientId]);
  const bills = useMemo(() => openBills(p.ds, p.clientId), [p.ds, p.clientId]);

  if (!p.can("aging")) {
    return (
      <>
        <PortalHero
          title="Receivables and payables"
          subtitle="Who owes you, who you owe, and how late each one is."
          tier={p.tier}
          testId="hero-portal-aging"
        />
        <LockedFeature feature="aging" fact={fact} currentTier={p.tier} />
      </>
    );
  }

  const ar: PartyRow[] = agingByParty(
    invoices.map((i) => ({ party: i.customer, dueDate: i.dueDate, open: i.amountCents - i.paidCents })),
  );
  const ap: PartyRow[] = agingByParty(bills.map((b) => ({ party: b.vendor, dueDate: b.dueDate, open: b.amountCents - b.paidCents })));
  const arTotal = totalBuckets(ar.map((r) => r.buckets));
  const apTotal = totalBuckets(ap.map((r) => r.buckets));
  const overdueAr = arTotal.total - arTotal.current;
  const overdueAp = apTotal.total - apTotal.current;

  const grid = (rows: PartyRow[], totals: AgingBucketSet, kind: string) => (
    <DataGrid<PartyRow>
      rows={rows}
      rowKey={(r) => r.party}
      cols={[
        { key: "party", label: kind, mobile: "title", render: (r) => <span className="font-medium">{r.party}</span> },
        ...BUCKETS.map((b) => ({
          key: b.key,
          label: b.label,
          align: "right" as const,
          mobile: "row" as const,
          render: (r: PartyRow) => <Money cents={r.buckets[b.key]} dim />,
        })),
        {
          key: "total",
          label: "Open",
          align: "right" as const,
          mobile: "value" as const,
          render: (r: PartyRow) => <Money cents={r.buckets.total} className="font-semibold" />,
        },
      ]}
      empty={<EmptyState title={`No open ${kind.toLowerCase()} balances`} body="Nothing is outstanding on this side right now." />}
      footer={
        rows.length > 0 ? (
          <tr>
            <td className="px-3 py-2 text-sm font-semibold">Total</td>
            {BUCKETS.map((b) => (
              <td key={b.key} className="tnum hidden px-3 py-2 text-right text-sm font-semibold sm:table-cell">
                {usd(totals[b.key])}
              </td>
            ))}
            <td className="tnum px-3 py-2 text-right text-sm font-semibold">{usd(totals.total)}</td>
          </tr>
        ) : undefined
      }
      testId={`grid-portal-aging-${kind.toLowerCase()}`}
    />
  );

  return (
    <>
      <PortalHero
        title="Receivables and payables"
        subtitle={`Open items for ${p.client.dba} as of ${fmtShortDate(TODAY)}. Buckets are counted from the due date on each document.`}
        tier={p.tier}
        testId="hero-portal-aging"
      />

      {invoices.length === 0 && bills.length === 0 ? (
        <SectionCard title="Aging" testId="card-portal-aging-empty">
          <EmptyState
            title="Nothing outstanding"
            body="You have no open invoices and no open bills, so there is no aging to read. This fills in as documents post."
          />
        </SectionCard>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Owed to you" value={usd(arTotal.total)} hint={`${invoices.length} open invoices`} testId="kpi-portal-ar" />
            <Kpi label="Past due to you" value={usd(overdueAr)} tone={overdueAr > 0 ? "risk" : "good"} testId="kpi-portal-ar-late" />
            <Kpi label="You owe" value={usd(apTotal.total)} hint={`${bills.length} open bills`} testId="kpi-portal-ap" />
            <Kpi label="Past due from you" value={usd(overdueAp)} tone={overdueAp > 0 ? "watch" : "good"} testId="kpi-portal-ap-late" />
          </div>

          <SectionCard title="Aging detail" testId="card-portal-aging">
            <Tabs defaultValue="ar">
              <div className="border-b border-border px-3 pt-3">
                <TabsList>
                  <TabsTrigger value="ar" data-testid="tab-portal-ar">
                    Money in
                  </TabsTrigger>
                  <TabsTrigger value="ap" data-testid="tab-portal-ap">
                    Money out
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="ar" className="m-0">
                {grid(ar, arTotal, "Customer")}
              </TabsContent>
              <TabsContent value="ap" className="m-0">
                {grid(ap, apTotal, "Vendor")}
              </TabsContent>
            </Tabs>
          </SectionCard>

          <PortalNote testId="note-portal-aging-basis">
            These totals tie to the receivable and payable balances on your balance sheet. If a customer says they paid and it is still
            listed here, send us the remittance and we will chase it.
          </PortalNote>
        </>
      )}
    </>
  );
}
