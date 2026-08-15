import { useMemo, useState } from "react";
import { FileText, Link2, Paperclip, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { DataGrid, EmptyState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { substantiationViews } from "@/data/derive";
import type { SubstantiationView } from "@/data/derive";
import { fmtBytes, fmtPeriod, fmtTimestamp, usd } from "@/lib/money";

export default function Substantiation() {
  const { ds, activeClient, activeClientId, period, loading, loadError, reload, addMessage } = useApp();
  const { toast } = useToast();
  const [detail, setDetail] = useState<SubstantiationView | null>(null);

  const views = useMemo(() => substantiationViews(ds, activeClientId, period), [ds, activeClientId, period]);
  const tied = views.filter((v) => v.status === "tied").length;
  const variance = views.filter((v) => v.status === "variance");
  const unsupported = views.filter((v) => v.status === "unsupported");
  const openItems = ds.openItems.filter((o) => o.clientId === activeClientId && o.period === period);

  const docsFor = (ids: string[]) => ds.documents.filter((d) => ids.includes(d.id));

  return (
    <>
      <PageHeader
        title="Balance sheet substantiation"
        subtitle={`Each balance carries its own support. ${fmtPeriod(period)} for ${activeClient.dba}, with the general ledger figure compared to the document behind it.`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Accounts tied out" value={`${tied} of ${views.length}`} tone={tied === views.length ? "good" : "watch"} testId="kpi-tied" />
        <Kpi
          label="Unexplained variance"
          value={usd(variance.reduce((s, v) => s + v.varianceCents, 0))}
          tone={variance.length ? "risk" : "good"}
          hint={variance.length ? `${variance.length} account needs research` : "Nothing off"}
          testId="kpi-variance"
        />
        <Kpi label="No support attached" value={unsupported.length} tone={unsupported.length ? "watch" : "good"} hint="Request a document from the client" testId="kpi-unsupported" />
        <Kpi label="Requests open" value={openItems.filter((o) => o.status !== "accepted").length} hint={`${openItems.length} raised this period`} testId="kpi-requests" />
      </div>

      {variance.length || unsupported.length ? (
        <div className="rounded-md border border-warning/40 bg-warning-soft p-4" data-testid="banner-exceptions">
          <p className="text-sm font-semibold text-warning">This period cannot be signed off yet</p>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {variance.map((v) => (
              <li key={v.id}>
                {v.accountName} shows {usd(v.glCents)} in the ledger against {usd(v.supportedCents || 0)} of support, a difference of {usd(v.varianceCents)}.
              </li>
            ))}
            {unsupported.map((v) => (
              <li key={v.id}>{v.accountName} has a balance of {usd(v.glCents)} with nothing attached to prove it.</li>
            ))}
          </ul>
        </div>
      ) : null}

      <SectionCard
        title="Account by account"
        description="Select a row to see the support, who prepared it, and who reviewed it."
        bodyClassName="p-0"
        testId="card-substantiation"
      >
        <DataGrid
          rows={views}
          rowKey={(v) => v.id}
          loading={loading}
          error={loadError}
          onRetry={reload}
          onRowClick={(v) => setDetail(v)}
          empty={<EmptyState title="No substantiation records for this period" body="Pick another period from the header." />}
          cols={[
            {
              key: "account",
              label: "Account",
              mobile: "title",
              render: (v) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">{v.accountName}</p>
                  <p className="truncate text-xs text-muted-foreground">{v.supportType}</p>
                </div>
              ),
            },
            { key: "gl", label: "Ledger balance", align: "right", mobile: "value", render: (v) => <Money cents={v.glCents} /> },
            {
              key: "support",
              label: "Supported",
              align: "right",
              mobile: "row",
              render: (v) => (v.supportedCents === null ? <span className="text-xs text-muted-foreground">No support</span> : <Money cents={v.supportedCents} />),
            },
            {
              key: "var",
              label: "Variance",
              align: "right",
              mobile: "row",
              render: (v) => (v.varianceCents === 0 ? <span className="tnum text-muted-foreground">0.00</span> : <Money cents={v.varianceCents} signed />),
            },
            {
              key: "docs",
              label: "Attached",
              mobile: "row",
              render: (v) => (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Paperclip className="h-3.5 w-3.5" />
                  {v.documentIds.length}
                </span>
              ),
            },
            { key: "prep", label: "Prepared by", mobile: "row", render: (v) => <span className="text-xs">{v.preparedBy}</span> },
            { key: "review", label: "Reviewed by", mobile: "row", render: (v) => <span className="text-xs">{v.reviewedBy || "Not reviewed"}</span> },
            {
              key: "status",
              label: "Tie out",
              align: "right",
              mobile: "row",
              render: (v) => (
                <Pill tone={v.status === "tied" ? "good" : v.status === "variance" ? "risk" : "watch"}>
                  {v.status === "tied" ? "Tied" : v.status === "variance" ? "Variance" : "Unsupported"}
                </Pill>
              ),
            },
          ]}
        />
      </SectionCard>

      <SectionCard
        title="Open items with the client"
        description="Requests raised from these accounts show up in the client portal the moment they are created."
        bodyClassName="p-0"
        testId="card-openitems"
      >
        <DataGrid
          rows={openItems}
          rowKey={(o) => o.id}
          loading={loading}
          error={loadError}
          onRetry={reload}
          dense
          empty={<EmptyState title="No requests this period" body="Everything needed for the close is already on hand." />}
          cols={[
            {
              key: "title",
              label: "Request",
              mobile: "title",
              render: (o) => (
                <div className="min-w-0">
                  <p className="truncate font-medium">{o.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{o.detail}</p>
                </div>
              ),
            },
            { key: "type", label: "Document", mobile: "row", render: (o) => <Pill>{o.docType}</Pill> },
            { key: "from", label: "Requested from", mobile: "row", render: (o) => <span className="text-xs">{o.requestedFrom}</span> },
            { key: "due", label: "Due", mobile: "row", render: (o) => <span className="tnum text-xs">{o.dueDate}</span> },
            {
              key: "amount",
              label: "Amount",
              align: "right",
              mobile: "value",
              render: (o) => (o.amountCents ? <Money cents={o.amountCents} /> : <span className="text-xs text-muted-foreground">Not set</span>),
            },
            {
              key: "status",
              label: "Status",
              align: "right",
              mobile: "row",
              render: (o) => (
                <Pill
                  tone={
                    o.status === "accepted" ? "good" : o.status === "rejected" ? "risk" : o.status === "not_started" ? "neutral" : "watch"
                  }
                >
                  {o.status.replace("_", " ")}
                </Pill>
              ),
            },
          ]}
        />
      </SectionCard>

      <Dialog open={Boolean(detail)} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-xl" data-testid="dialog-substantiation">
          <DialogHeader>
            <DialogTitle>{detail?.accountName}</DialogTitle>
            <DialogDescription>
              {detail?.supportType} for {fmtPeriod(period)}. {detail?.note}
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-md border border-border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Ledger</p>
                  <p className="tnum mt-1 text-sm font-semibold">{usd(detail.glCents)}</p>
                </div>
                <div className="rounded-md border border-border p-3">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Support</p>
                  <p className="tnum mt-1 text-sm font-semibold">{detail.supportedCents === null ? "None" : usd(detail.supportedCents)}</p>
                </div>
                <div className={`rounded-md border p-3 ${detail.varianceCents ? "border-destructive/40 bg-danger-soft" : "border-positive/40 bg-positive-soft"}`}>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Variance</p>
                  <p className="tnum mt-1 text-sm font-semibold">{usd(detail.varianceCents)}</p>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Linked documents</p>
                {docsFor(detail.documentIds).length ? (
                  <ul className="mt-2 space-y-2">
                    {docsFor(detail.documentIds).map((d) => (
                      <li key={d.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{d.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {d.docType}, {fmtBytes(d.sizeBytes)}, uploaded {fmtTimestamp(d.uploadedAt)} by {d.uploadedBy}
                          </p>
                        </div>
                        <Link2 className="h-4 w-4 shrink-0 text-primary" />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">Nothing is linked to this account yet.</p>
                )}
              </div>

              <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                Prepared by {detail.preparedBy}. {detail.reviewedBy ? `Reviewed by ${detail.reviewedBy}.` : "Waiting on a reviewer."}
              </div>
            </div>
          ) : null}
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            {detail && detail.status !== "tied" ? (
              <Button
                variant="outline"
                onClick={() => {
                  addMessage(
                    activeClientId,
                    "Trey Hernandez",
                    `Support needed for ${detail.accountName}`,
                    `We need the ${detail.supportType.toLowerCase()} for ${fmtPeriod(period)} so we can tie out ${detail.accountName}.`,
                    "Outbound",
                    detail.id,
                  );
                  toast({ title: "Request sent", description: "The client sees it in the portal and in the message thread." });
                  setDetail(null);
                }}
                data-testid="button-request-support"
              >
                <Send className="mr-1 h-4 w-4" />
                Ask the client for support
              </Button>
            ) : null}
            <Button onClick={() => setDetail(null)} data-testid="button-sub-close">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
