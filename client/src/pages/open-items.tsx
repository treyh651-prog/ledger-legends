import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useActiveClient } from "@/lib/active-client";
import { useFirmRequests, errorMessage } from "@/api";
import { fmtShortDate } from "@/lib/money";
import type { FirmRequest } from "@shared/api";

/**
 * Open items for one client, read from GET /api/firm/clients/:id/requests.
 * Transaction requests come from ledger.portal_requests, document requests
 * from close.document_requests. The client answers through the portal and
 * the runs satisfy or waive; there is no hand status switch here because
 * that would be a write outside the engine.
 */
export default function OpenItems() {
  const { client, clientId } = useActiveClient();
  const q = useFirmRequests(clientId);
  const [tab, setTab] = useState<"open" | "all">("open");
  const d = q.data;

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const items = (d?.items ?? []).filter((i) => (tab === "open" ? i.status === "open" : true));
  const today = new Date().toISOString().slice(0, 10);
  const tone = (r: FirmRequest) => (r.status === "satisfied" ? "good" : r.status === "waived" ? "neutral" : r.dueOn && r.dueOn < today ? "risk" : "watch");

  return (
    <div className="space-y-4" data-testid="page-open-items">
      <PageHeader title="Open items" subtitle={`${client?.name ?? ""}. Requests the runs opened for the client and the firm, with what each one is waiting on.`} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Open" value={d ? d.openCount : "…"} testId="kpi-open-requests" />
        <Kpi label="Overdue" value={d ? d.overdueCount : "…"} tone={d && d.overdueCount > 0 ? "risk" : "neutral"} />
        <Kpi label="Owned by client" value={d ? d.items.filter((i) => i.status === "open" && i.owner === "client").length : "…"} />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "open" | "all")}>
        <TabsList>
          <TabsTrigger value="open" data-testid="tab-open">Open</TabsTrigger>
          <TabsTrigger value="all" data-testid="tab-all">All</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="mt-4">
          <SectionCard title={tab === "open" ? "Open requests" : "Every request"} description="Opened on ascending.">
            <DataGrid<FirmRequest>
              rows={items}
              loading={q.isPending}
              rowKey={(r) => r.id}
              testId="grid-requests"
              empty={<EmptyState title="Nothing outstanding" body="TXN-SWEEP-SUSPENSE and INTAKE-OPEN-REQUESTS open requests when the books need something from a person." />}
              cols={[
                { key: "kind", label: "Kind", mobile: "row", render: (r) => <Pill tone="info">{r.kind}</Pill> },
                { key: "subject", label: "Subject", mobile: "title", render: (r) => <span className="font-medium">{r.subject}</span> },
                { key: "detail", label: "Detail", mobile: "row", render: (r) => <span className="text-xs text-muted-foreground">{r.detail}</span> },
                { key: "owner", label: "Owner", mobile: "row", render: (r) => <span className="text-xs capitalize">{r.owner}</span> },
                { key: "opened", label: "Opened", mobile: "row", render: (r) => <span className="tnum text-xs">{fmtShortDate(r.openedOn)}</span> },
                { key: "due", label: "Due", mobile: "row", render: (r) => <span className="tnum text-xs">{r.dueOn ? fmtShortDate(r.dueOn) : ""}</span> },
                { key: "status", label: "Status", mobile: "value", render: (r) => <Pill tone={tone(r)}>{r.status}</Pill> },
              ]}
            />
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
