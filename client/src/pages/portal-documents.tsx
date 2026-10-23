import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { DataGrid, EmptyState, Kpi, Pill, SectionCard } from "@/components/kit";
import { PortalNote } from "@/components/portal/portal-kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalDocuments } from "@/api";
import { fmtBytes, fmtDate, fmtTimestamp } from "@/lib/money";
import type { PortalDocument } from "@shared/api";

const STATUS: Record<PortalDocument["status"], { label: string; tone: "good" | "watch" | "neutral" | "risk" }> = {
  pending: { label: "Expected", tone: "watch" },
  uploaded: { label: "Received", tone: "good" },
  verified: { label: "Verified", tone: "good" },
  quarantined: { label: "Held for review", tone: "risk" },
  failed: { label: "Upload failed", tone: "risk" },
};

/**
 * The client's file, GET /api/portal/:clientId/documents. Rows come from the
 * document vault. Upload and download wait on object storage, and the payload
 * says so with storageConfigured false, so no button here pretends otherwise.
 */
export default function PortalDocuments() {
  return (
    <PortalScreen
      title="Your documents"
      subtitle={(name) => `Everything on file for ${name}, with the status of each item. Your records are always open to you.`}
      testId="hero-portal-documents"
    >
      {({ clientId }) => <Body clientId={clientId} />}
    </PortalScreen>
  );
}

function Body({ clientId }: { clientId: string }) {
  const q = usePortalDocuments(clientId);
  const [, navigate] = useLocation();
  return (
    <QueryBody q={q} title="Documents" testId="card-portal-documents">
      {(data) => (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="On file" value={data.items.length} testId="kpi-docs-count" />
            <Kpi label="Received" value={data.items.filter((d) => d.status === "uploaded" || d.status === "verified").length} tone="good" testId="kpi-docs-received" />
            <Kpi label="Still expected" value={data.openRequests.length} tone={data.openRequests.length ? "watch" : "good"} testId="kpi-docs-expected" />
            <Kpi label="Upload" value={data.storageConfigured ? "Available" : "Not yet"} tone={data.storageConfigured ? "good" : "neutral"} testId="kpi-docs-upload" />
          </div>

          {!data.storageConfigured ? (
            <PortalNote tone="watch" testId="note-documents-storage">
              File upload and download are not set up in this product yet. The list below is the record of what is on file. Send new
              documents to your accountant the way you do today.
            </PortalNote>
          ) : null}

          {data.openRequests.length > 0 ? (
            <SectionCard title="Documents your accountant is waiting on" testId="card-portal-documents-expected">
              <ul className="divide-y divide-border">
                {data.openRequests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" data-testid={`doc-request-${r.id}`}>
                    <div className="min-w-0">
                      <p className="font-medium">{r.detail}</p>
                      <p className="text-xs text-muted-foreground">
                        Opened {fmtDate(r.openedOn)}, needed by {fmtDate(r.dueOn)}
                      </p>
                    </div>
                    <Pill tone="watch">Open</Pill>
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => navigate("/portal/requests")} data-testid="button-documents-requests">
                See every open request
              </Button>
            </SectionCard>
          ) : null}

          <SectionCard title="On file" bodyClassName="p-0" testId="card-portal-documents-list">
            <DataGrid<PortalDocument>
              rows={data.items}
              rowKey={(d) => d.id}
              testId="grid-portal-documents"
              empty={<EmptyState title="Nothing on file yet" body="Documents appear here as they are added to your file. There is no file history to show yet." />}
              cols={[
                { key: "title", label: "Document", render: (d) => <span className="font-medium">{d.title}</span> },
                { key: "type", label: "Type", render: (d) => d.docType.replace(/_/g, " ") },
                {
                  key: "period",
                  label: "Period",
                  render: (d) => (d.periodStart ? `${fmtDate(d.periodStart)}${d.periodEnd ? ` to ${fmtDate(d.periodEnd)}` : ""}` : "Not dated"),
                },
                { key: "size", label: "Size", align: "right", render: (d) => (d.byteSize !== null ? fmtBytes(d.byteSize) : "Not received") },
                { key: "when", label: "Received", render: (d) => (d.uploadedAt ? fmtTimestamp(d.uploadedAt) : "Not yet") },
                { key: "status", label: "Status", render: (d) => <Pill tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Pill> },
              ]}
            />
          </SectionCard>
        </>
      )}
    </QueryBody>
  );
}
