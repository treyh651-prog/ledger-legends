import { useMemo, useState } from "react";
import { Check, FileText, Plus, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { DataGrid, EmptyState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { auditForClient } from "@/data/derive";
import { DOC_TYPES } from "@/data/labels";
import { fmtBytes, fmtPeriod, fmtTimestamp } from "@/lib/money";
import { TODAY } from "@/data/seed";
import type { DocRecord, OpenItem } from "@/data/types";

const STATUS_TONE: Record<string, "neutral" | "good" | "watch" | "risk" | "info"> = {
  not_started: "neutral",
  uploaded: "info",
  under_review: "watch",
  accepted: "good",
  rejected: "risk",
};

const STATUS_LABEL: Record<string, string> = {
  not_started: "Waiting on client",
  uploaded: "Uploaded",
  under_review: "Under review",
  accepted: "Accepted",
  rejected: "Sent back",
};

export default function OpenItems() {
  const { ds, activeClient, activeClientId, period, loading, loadError, reload, setOpenItemStatus, updateDocument, addMessage } = useApp();
  const { toast } = useToast();
  const [review, setReview] = useState<DocRecord | null>(null);
  const [reason, setReason] = useState("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: "", detail: "", docType: DOC_TYPES[0], dueDate: TODAY, requestedFrom: activeClient.contacts[0]?.name || "" });

  const items = ds.openItems.filter((o) => o.clientId === activeClientId);
  const docs = ds.documents.filter((d) => d.clientId === activeClientId);
  const pending = docs.filter((d) => d.status === "uploaded" || d.status === "duplicate");
  const audit = useMemo(() => auditForClient(ds, activeClientId), [ds, activeClientId]);
  const itemFor = (id?: string) => items.find((o) => o.id === id);

  const acceptDoc = (d: DocRecord) => {
    updateDocument(d.id, { status: "accepted" }, "accepted", "Reviewed against the ledger and filed to the period", "Trey Hernandez", "firm");
    if (d.openItemId) setOpenItemStatus(d.openItemId, "accepted");
    toast({ title: "Document accepted", description: `${d.name} is filed to ${fmtPeriod(d.period)}.` });
  };

  const rejectDoc = () => {
    if (!review) return;
    updateDocument(review.id, { status: "rejected", note: reason }, "rejected", reason || "Sent back to the client", "Trey Hernandez", "firm");
    if (review.openItemId) setOpenItemStatus(review.openItemId, "rejected", reason);
    addMessage(activeClientId, "Trey Hernandez", `We need a new copy of ${review.name}`, reason || "The file we received cannot be used. Please send a clearer copy.", "Outbound", review.openItemId);
    toast({ title: "Sent back", description: "The client sees the reason in the portal." });
    setReview(null);
    setReason("");
  };

  return (
    <>
      <PageHeader
        title="Requests and document review"
        subtitle={`Open requests with ${activeClient.dba}, the files that came back, and the trail showing who touched each one.`}
        actions={
          <Button size="sm" onClick={() => setCreating(true)} data-testid="button-new-request">
            <Plus className="mr-1 h-4 w-4" />
            New request
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Requests open" value={items.filter((o) => o.status !== "accepted").length} tone={items.some((o) => o.status !== "accepted") ? "watch" : "good"} testId="kpi-open" />
        <Kpi label="Past the due date" value={items.filter((o) => o.status !== "accepted" && o.dueDate < TODAY).length} tone="risk" testId="kpi-late" />
        <Kpi label="Files waiting on review" value={pending.length} tone={pending.length ? "watch" : "good"} testId="kpi-pending-docs" />
        <Kpi label="Audit events" value={audit.length} hint="Every upload, view, and decision" testId="kpi-audit" />
      </div>

      <Tabs defaultValue="requests">
        <TabsList data-testid="tabs-requests">
          <TabsTrigger value="requests" data-testid="tab-requests">Requests</TabsTrigger>
          <TabsTrigger value="review" data-testid="tab-review">Review queue</TabsTrigger>
          <TabsTrigger value="audit" data-testid="tab-audit">Audit trail</TabsTrigger>
        </TabsList>

        <TabsContent value="requests" className="mt-4">
          <SectionCard bodyClassName="p-0" testId="card-requests">
            <DataGrid
              rows={items}
              rowKey={(o) => o.id}
              loading={loading}
              error={loadError}
              onRetry={reload}
              empty={<EmptyState title="No open requests" body="Nothing is outstanding with this client right now." />}
              cols={[
                {
                  key: "title",
                  label: "Request",
                  mobile: "title",
                  render: (o: OpenItem) => (
                    <div className="min-w-0">
                      <p className="truncate font-medium">{o.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{o.detail}</p>
                      {o.rejectionReason ? <p className="mt-0.5 truncate text-xs text-destructive">Sent back: {o.rejectionReason}</p> : null}
                    </div>
                  ),
                },
                { key: "period", label: "Period", mobile: "sub", render: (o) => <span className="text-xs">{fmtPeriod(o.period)}</span> },
                { key: "type", label: "Document", mobile: "row", render: (o) => <Pill>{o.docType}</Pill> },
                { key: "from", label: "Requested from", mobile: "row", render: (o) => <span className="text-xs">{o.requestedFrom}</span> },
                {
                  key: "due",
                  label: "Due",
                  mobile: "row",
                  render: (o) => <span className={`tnum text-xs ${o.dueDate < TODAY && o.status !== "accepted" ? "text-destructive" : ""}`}>{o.dueDate}</span>,
                },
                { key: "amount", label: "Amount", align: "right", mobile: "value", render: (o) => (o.amountCents ? <Money cents={o.amountCents} /> : <span className="text-xs text-muted-foreground">Not set</span>) },
                { key: "files", label: "Files", align: "right", mobile: "row", render: (o) => <span className="tnum text-xs">{o.documentIds.length}</span> },
                { key: "status", label: "Status", align: "right", mobile: "row", render: (o) => <Pill tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Pill> },
              ]}
            />
          </SectionCard>
        </TabsContent>

        <TabsContent value="review" className="mt-4">
          <SectionCard
            title="Files the client sent"
            description="Accept a file to file it against the period, or send it back with a reason the client can act on."
            bodyClassName="p-0"
            testId="card-review"
          >
            <DataGrid
              rows={docs}
              rowKey={(d) => d.id}
              loading={loading}
              error={loadError}
              onRetry={reload}
              dense
              empty={<EmptyState title="No documents yet" body="Uploads from the client portal land here." />}
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
                          {fmtBytes(d.sizeBytes)}, {d.docType}
                          {itemFor(d.openItemId) ? `, answers ${itemFor(d.openItemId)!.title}` : ""}
                        </p>
                      </div>
                    </div>
                  ),
                },
                { key: "period", label: "Period", mobile: "sub", render: (d) => <span className="text-xs">{fmtPeriod(d.period)}</span> },
                { key: "by", label: "Uploaded by", mobile: "row", render: (d) => <span className="text-xs">{d.uploadedBy}</span> },
                { key: "at", label: "When", mobile: "row", render: (d) => <span className="tnum text-xs">{fmtTimestamp(d.uploadedAt)}</span> },
                {
                  key: "status",
                  label: "Status",
                  mobile: "row",
                  render: (d) => (
                    <Pill tone={d.status === "accepted" ? "good" : d.status === "rejected" ? "risk" : d.status === "duplicate" ? "watch" : "info"}>
                      {d.status === "duplicate" ? "Possible duplicate" : d.status}
                    </Pill>
                  ),
                },
                {
                  key: "actions",
                  label: "Decision",
                  align: "right",
                  width: "170px",
                  mobile: "value",
                  render: (d) =>
                    d.status === "accepted" || d.status === "rejected" ? (
                      <span className="text-xs text-muted-foreground">Closed out</span>
                    ) : (
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => acceptDoc(d)} data-testid={`button-accept-${d.id}`}>
                          <Check className="mr-1 h-3.5 w-3.5" />
                          Accept
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setReview(d)} data-testid={`button-reject-${d.id}`}>
                          <X className="mr-1 h-3.5 w-3.5" />
                          Send back
                        </Button>
                      </div>
                    ),
                },
              ]}
            />
          </SectionCard>
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <SectionCard
            title="Audit trail"
            description="Written when it happens and never edited afterward."
            actions={
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-positive" />
                Append only
              </span>
            }
            bodyClassName="p-0"
            testId="card-audit"
          >
            <DataGrid
              rows={audit}
              rowKey={(a) => a.id}
              loading={loading}
              error={loadError}
              onRetry={reload}
              dense
              maxHeight="520px"
              empty={<EmptyState title="Nothing recorded yet" body="Upload a document to see the trail fill in." />}
              cols={[
                { key: "at", label: "When", mobile: "sub", render: (a) => <span className="tnum text-xs">{fmtTimestamp(a.at)}</span> },
                { key: "action", label: "Action", mobile: "value", render: (a) => <Pill tone={a.action === "rejected" ? "risk" : a.action === "accepted" ? "good" : "neutral"}><span className="capitalize">{a.action}</span></Pill> },
                {
                  key: "doc",
                  label: "Document",
                  mobile: "title",
                  render: (a) => (
                    <div className="min-w-0">
                      <p className="truncate">{a.docName}</p>
                      <p className="truncate text-xs text-muted-foreground">{a.detail}</p>
                    </div>
                  ),
                },
                { key: "actor", label: "Who", mobile: "row", render: (a) => <span className="text-xs">{a.actor}</span> },
                { key: "plane", label: "Where", align: "right", mobile: "row", render: (a) => <Pill tone={a.plane === "Firm" ? "neutral" : "info"}>{a.plane}</Pill> },
              ]}
            />
          </SectionCard>
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(review)} onOpenChange={(o) => !o && setReview(null)}>
        <DialogContent data-testid="dialog-reject">
          <DialogHeader>
            <DialogTitle>Send this file back</DialogTitle>
            <DialogDescription>The reason goes to the client with the request reopened, so they know exactly what to send.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label className="text-xs">Reason</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              placeholder="The last page of the statement is missing, so the ending balance cannot be read."
              data-testid="input-reject-reason"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReview(null)} data-testid="button-cancel-reject">
              Cancel
            </Button>
            <Button disabled={reason.trim().length < 5} onClick={rejectDoc} data-testid="button-confirm-reject">
              Send it back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent data-testid="dialog-new-request">
          <DialogHeader>
            <DialogTitle>Request a document</DialogTitle>
            <DialogDescription>The request appears in the client portal with the due date attached.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">What do you need</Label>
              <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="August merchant statement" data-testid="input-request-title" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Why you need it</Label>
              <Textarea value={draft.detail} onChange={(e) => setDraft({ ...draft, detail: e.target.value })} rows={3} data-testid="input-request-detail" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Document type</Label>
                <Select value={draft.docType} onValueChange={(v) => setDraft({ ...draft, docType: v })}>
                  <SelectTrigger data-testid="select-request-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DOC_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Due date</Label>
                <Input value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} className="tnum" data-testid="input-request-due" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)} data-testid="button-cancel-request">
              Cancel
            </Button>
            <Button
              disabled={!draft.title.trim()}
              onClick={() => {
                addMessage(
                  activeClientId,
                  "Trey Hernandez",
                  `Request: ${draft.title}`,
                  `${draft.detail || "We need this to finish the close."} Please send it by ${draft.dueDate}.`,
                  "Outbound",
                );
                toast({ title: "Request sent", description: `${draft.title} is now in the portal for ${activeClient.shortName}.` });
                setCreating(false);
                setDraft({ ...draft, title: "", detail: "" });
              }}
              data-testid="button-send-request"
            >
              Send the request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
