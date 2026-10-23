import { useLocation } from "wouter";
import { FolderOpen, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Kpi, Pill, SectionCard } from "@/components/kit";
import { PortalNote } from "@/components/portal/portal-kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalDocuments } from "@/api";
import { fmtDate } from "@/lib/money";

/**
 * Send documents, at /portal/upload. Reads GET /api/portal/:clientId/documents
 * for what the firm is waiting on and whether storage exists. The upload
 * route answers 501 not_configured until object storage is set up, and this
 * screen says so instead of staging files that would go nowhere. There is no
 * drop zone, no progress bar, and no sample file, because none of those would
 * be true.
 */
export default function PortalUpload() {
  return (
    <PortalScreen
      title="Send documents"
      subtitle="What your accountant has asked for, and how to send it today."
      testId="hero-portal-upload"
    >
      {({ clientId }) => <Body clientId={clientId} />}
    </PortalScreen>
  );
}

function Body({ clientId }: { clientId: string }) {
  const q = usePortalDocuments(clientId);
  const [, navigate] = useLocation();
  return (
    <QueryBody q={q} title="Send documents" testId="card-portal-upload">
      {(data) => (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Kpi label="Still expected" value={data.openRequests.length} tone={data.openRequests.length ? "watch" : "good"} testId="kpi-upload-expected" />
            <Kpi label="On file" value={data.items.length} testId="kpi-upload-on-file" />
            <Kpi label="Upload here" value={data.storageConfigured ? "Available" : "Not yet"} tone={data.storageConfigured ? "good" : "neutral"} testId="kpi-upload-storage" />
          </div>

          {!data.storageConfigured ? (
            <PortalNote tone="watch" testId="note-upload-storage">
              Uploading through this page is not set up in this product yet. Send documents to your accountant the way you do today. When
              storage is configured this page will accept files and each one will appear on the Documents screen with a history.
            </PortalNote>
          ) : null}

          <SectionCard
            title="Documents your accountant is waiting on"
            description="From the firm's open document requests. Each one has a date."
            testId="card-upload-expected"
            actions={
              <Button size="sm" disabled={!data.storageConfigured} data-testid="button-upload" title={data.storageConfigured ? undefined : "Storage is not configured"}>
                <Upload className="mr-1.5 h-4 w-4" /> Upload a file
              </Button>
            }
          >
            {data.openRequests.length === 0 ? (
              <EmptyState icon={<FolderOpen className="h-5 w-5" />} title="Nothing is waiting on you" body="When your accountant needs a document it will be listed here with a due date." />
            ) : (
              <ul className="divide-y divide-border">
                {data.openRequests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm" data-testid={`upload-request-${r.id}`}>
                    <div className="min-w-0">
                      <p className="font-medium">{r.detail}</p>
                      <p className="text-xs text-muted-foreground">
                        Asked {fmtDate(r.openedOn)}, due {fmtDate(r.dueOn)}
                      </p>
                    </div>
                    <Pill tone="watch">{r.reasonCode}</Pill>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => navigate("/portal/documents")} data-testid="button-go-documents">
              See what is on file
            </Button>
          </div>
        </>
      )}
    </QueryBody>
  );
}
