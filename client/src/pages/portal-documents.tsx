import { useMemo, useState } from "react";
import { Download, Eye, FileText, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { DataGrid, EmptyState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { auditForClient } from "@/data/derive";
import { PERIODS } from "@/data/seed";
import { fmtBytes, fmtPeriod, fmtTimestamp } from "@/lib/money";

export default function PortalDocuments() {
  const { ds, activeClient, activeClientId, loading, loadError, reload, logAudit } = useApp();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [per, setPer] = useState("all");
  const contact = activeClient.contacts[0]?.name || "Client contact";

  const docs = ds.documents
    .filter((d) => d.clientId === activeClientId)
    .filter((d) => (per === "all" ? true : d.period === per))
    .filter((d) => (q ? d.name.toLowerCase().includes(q.toLowerCase()) || d.docType.toLowerCase().includes(q.toLowerCase()) : true));

  const audit = useMemo(() => auditForClient(ds, activeClientId), [ds, activeClientId]);
  const rejected = docs.filter((d) => d.status === "rejected");

  return (
    <>
      <PageHeader
        title="Documents"
        subtitle="Everything you have sent us, plus what we did with each file. The history is written as it happens and cannot be changed afterward."
        actions={
          <>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or type" className="h-8 w-full text-xs sm:w-[220px]" data-testid="input-doc-search" />
            <Select value={per} onValueChange={setPer}>
              <SelectTrigger className="h-8 w-[150px] text-xs" data-testid="select-doc-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Every month</SelectItem>
                {PERIODS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {fmtPeriod(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Files on file" value={ds.documents.filter((d) => d.clientId === activeClientId).length} testId="kpi-doc-count" />
        <Kpi label="Accepted" value={docs.filter((d) => d.status === "accepted").length} tone="good" testId="kpi-doc-accepted" />
        <Kpi label="Waiting on review" value={docs.filter((d) => d.status === "uploaded" || d.status === "under_review").length} tone="watch" testId="kpi-doc-waiting" />
        <Kpi label="Sent back to you" value={rejected.length} tone={rejected.length ? "risk" : "good"} testId="kpi-doc-rejected" />
      </div>

      {rejected.length ? (
        <div className="rounded-md border border-destructive/40 bg-danger-soft p-4" data-testid="banner-rejected">
          <p className="text-sm font-semibold text-destructive">{rejected.length} file{rejected.length > 1 ? "s" : ""} came back</p>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {rejected.map((d) => (
              <li key={d.id}>
                {d.name}. {d.note || "Your accountant asked for a new copy."}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Tabs defaultValue="files">
        <TabsList data-testid="tabs-portal-docs">
          <TabsTrigger value="files" data-testid="tab-files">Files</TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="files" className="mt-4">
          <SectionCard bodyClassName="p-0" testId="card-portal-files">
            <DataGrid
              rows={docs}
              rowKey={(d) => d.id}
              loading={loading}
              error={loadError}
              onRetry={reload}
              empty={<EmptyState title="No files match" body="Clear the search or pick another month." />}
              cols={[
                {
                  key: "name",
                  label: "File",
                  mobile: "title",
                  render: (d) => (
                    <div className="flex min-w-0 items-center gap-2">
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="truncate">{d.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {d.docType}, {fmtBytes(d.sizeBytes)}
                        </p>
                      </div>
                    </div>
                  ),
                },
                { key: "period", label: "Month", mobile: "sub", render: (d) => <span className="text-xs">{fmtPeriod(d.period)}</span> },
                { key: "by", label: "Sent by", mobile: "row", render: (d) => <span className="text-xs">{d.uploadedBy}</span> },
                { key: "at", label: "When", mobile: "row", render: (d) => <span className="tnum text-xs">{fmtTimestamp(d.uploadedAt)}</span> },
                {
                  key: "status",
                  label: "Status",
                  mobile: "value",
                  render: (d) => (
                    <Pill tone={d.status === "accepted" ? "good" : d.status === "rejected" ? "risk" : d.status === "duplicate" ? "watch" : "info"}>
                      {d.status === "duplicate" ? "Possible duplicate" : d.status === "under_review" ? "Under review" : d.status}
                    </Pill>
                  ),
                },
                {
                  key: "actions",
                  label: "",
                  align: "right",
                  width: "110px",
                  mobile: "row",
                  render: (d) => (
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label="View"
                        onClick={() => {
                          logAudit(d.id, d.name, "viewed", `${contact} opened the file from the portal`, contact, "portal");
                          toast({ title: "Opened", description: "The view is recorded in the history." });
                        }}
                        data-testid={`button-view-${d.id}`}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label="Download"
                        onClick={() => {
                          logAudit(d.id, d.name, "downloaded", `${contact} downloaded the file`, contact, "portal");
                          toast({ title: "Download recorded", description: `${d.name} was logged in the history.` });
                        }}
                        data-testid={`button-download-${d.id}`}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </SectionCard>
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <SectionCard
            title="Document history"
            description="Uploads, views, downloads, and decisions from both sides."
            actions={
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-positive" />
                Written once
              </span>
            }
            bodyClassName="p-0"
            testId="card-portal-history"
          >
            <DataGrid
              rows={audit}
              rowKey={(a) => a.id}
              loading={loading}
              error={loadError}
              onRetry={reload}
              dense
              maxHeight="520px"
              cols={[
                { key: "at", label: "When", mobile: "sub", render: (a) => <span className="tnum text-xs">{fmtTimestamp(a.at)}</span> },
                {
                  key: "action",
                  label: "What happened",
                  mobile: "value",
                  render: (a) => (
                    <Pill tone={a.action === "rejected" ? "risk" : a.action === "accepted" ? "good" : "neutral"}>
                      <span className="capitalize">{a.action}</span>
                    </Pill>
                  ),
                },
                {
                  key: "doc",
                  label: "File",
                  mobile: "title",
                  render: (a) => (
                    <div className="min-w-0">
                      <p className="truncate">{a.docName}</p>
                      <p className="truncate text-xs text-muted-foreground">{a.detail}</p>
                    </div>
                  ),
                },
                { key: "who", label: "Who", mobile: "row", render: (a) => <span className="text-xs">{a.actor}</span> },
                { key: "where", label: "Where", align: "right", mobile: "row", render: (a) => <Pill tone={a.plane === "Firm" ? "neutral" : "info"}>{a.plane}</Pill> },
              ]}
            />
          </SectionCard>
        </TabsContent>
      </Tabs>
    </>
  );
}
