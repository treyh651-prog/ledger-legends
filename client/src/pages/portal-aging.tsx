import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid, EmptyState, Kpi, Money, SectionCard } from "@/components/kit";
import { PortalNote } from "@/components/portal/portal-kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalAging } from "@/api";
import { fmtDate, fmtShortDate } from "@/lib/money";
import type { PortalAging as PortalAgingData } from "@shared/api";

type Side = "receivable" | "payable";
type Row = PortalAgingData["items"][number];

/**
 * Ledger+ feature. Who owes the client and who the client owes, read from
 * GET /api/portal/:clientId/aging?side=. Rows are the newest aging snapshot
 * the engine produced. No snapshot is an empty table, not a table of zeros.
 */
export default function PortalAging() {
  const [side, setSide] = useState<Side>("receivable");
  return (
    <PortalScreen
      title="Receivables and payables"
      subtitle="Who owes you, who you owe, and how late each one is."
      testId="hero-portal-aging"
      actions={
        <Tabs value={side} onValueChange={(v) => setSide(v as Side)}>
          <TabsList>
            <TabsTrigger value="receivable" data-testid="tab-aging-ar">Owed to you</TabsTrigger>
            <TabsTrigger value="payable" data-testid="tab-aging-ap">You owe</TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      {({ clientId }) => <Body clientId={clientId} side={side} />}
    </PortalScreen>
  );
}

function Body({ clientId, side }: { clientId: string; side: Side }) {
  const q = usePortalAging(clientId, side);
  return (
    <QueryBody q={q} title="Receivables and payables" testId="card-portal-aging">
      {(data) => {
        const late = data.items.filter((r) => (r.ageDays ?? 0) > 0);
        return (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label={side === "receivable" ? "Open receivables" : "Open payables"} value={<Money cents={data.totalCents} />} testId="kpi-aging-total" />
              <Kpi label="Open items" value={data.items.length} testId="kpi-aging-count" />
              <Kpi label="Past due" value={late.length} tone={late.length ? "watch" : "good"} testId="kpi-aging-late" />
              <Kpi label="As of" value={data.asOfDate ? fmtShortDate(data.asOfDate) : "No snapshot"} testId="kpi-aging-asof" />
            </div>
            {data.subledgerOutOfTie ? (
              <PortalNote tone="watch" testId="note-aging-tie">
                The detail below does not tie to the control account for this date. Your accountant has been told. The rows are shown as they stand.
              </PortalNote>
            ) : null}
            <SectionCard title={side === "receivable" ? "Open invoices" : "Open bills"} bodyClassName="p-0" testId="card-portal-aging-rows">
              <DataGrid<Row>
                rows={data.items}
                rowKey={(r, i) => `${r.partyName}-${r.documentNumber ?? i}`}
                testId="grid-portal-aging"
                empty={
                  <EmptyState
                    title={data.asOfDate ? "Nothing open" : "No aging has been produced yet"}
                    body={
                      data.asOfDate
                        ? `Every ${side === "receivable" ? "invoice" : "bill"} on file as of ${fmtDate(data.asOfDate)} is settled.`
                        : "Aging is built when a month is closed. There is no closed month on your books yet, so there is nothing to age."
                    }
                  />
                }
                cols={[
                  { key: "party", label: side === "receivable" ? "Customer" : "Vendor", render: (r) => <span className="font-medium">{r.partyName}</span> },
                  { key: "doc", label: "Document", render: (r) => r.documentNumber ?? "Not numbered" },
                  { key: "date", label: "Date", render: (r) => (r.documentDate ? fmtShortDate(r.documentDate) : "Not dated") },
                  { key: "age", label: "Days", align: "right", render: (r) => (r.ageDays === null ? "Not due" : r.ageDays) },
                  { key: "bucket", label: "Bucket", render: (r) => r.bucket.replace(/_/g, " ") },
                  { key: "open", label: "Open", align: "right", render: (r) => <Money cents={r.openBalanceCents} /> },
                ]}
              />
            </SectionCard>
          </>
        );
      }}
    </QueryBody>
  );
}
