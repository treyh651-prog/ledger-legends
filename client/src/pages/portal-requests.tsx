import { useLocation } from "wouter";
import { CalendarClock, CheckCircle2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";
import { TODAY } from "@/data/seed";

const LABEL: Record<string, string> = {
  not_started: "We are waiting on this",
  uploaded: "You sent it, we are looking",
  under_review: "Under review",
  accepted: "Done",
  rejected: "Needs another copy",
};

export default function PortalRequests() {
  const { ds, activeClient, activeClientId } = useApp();
  const [, navigate] = useLocation();

  const items = ds.openItems.filter((o) => o.clientId === activeClientId);
  const open = items.filter((o) => o.status !== "accepted");
  const late = open.filter((o) => o.dueDate < TODAY);
  const docFor = (ids: string[]) => ds.documents.filter((d) => ids.includes(d.id));

  return (
    <>
      <PageHeader
        title="What we need from you"
        subtitle={`Each item below is something your accountant cannot finish without. Sending them is the fastest way to get the ${activeClient.dba} books closed on time.`}
        actions={
          <Button size="sm" onClick={() => navigate("/portal/upload")} data-testid="button-requests-upload">
            <Upload className="mr-1 h-4 w-4" />
            Send documents
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Still open" value={open.length} tone={open.length ? "watch" : "good"} testId="kpi-req-open" />
        <Kpi label="Past the date" value={late.length} tone={late.length ? "risk" : "good"} testId="kpi-req-late" />
        <Kpi label="Closed out" value={items.filter((o) => o.status === "accepted").length} tone="good" testId="kpi-req-done" />
        <Kpi label="Files attached" value={items.reduce((s, o) => s + o.documentIds.length, 0)} testId="kpi-req-files" />
      </div>

      {open.length === 0 ? (
        <SectionCard bodyClassName="p-0">
          <EmptyState
            title="Nothing is outstanding"
            body="Your accountant has everything needed for this close. We will let you know the moment something new comes up."
          />
        </SectionCard>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {items.map((o) => {
            const files = docFor(o.documentIds);
            const isLate = o.dueDate < TODAY && o.status !== "accepted";
            return (
              <SectionCard key={o.id} testId={`request-${o.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold leading-snug">{o.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{o.detail}</p>
                  </div>
                  <Pill tone={o.status === "accepted" ? "good" : o.status === "rejected" ? "risk" : isLate ? "risk" : "watch"}>{LABEL[o.status]}</Pill>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                  <div>
                    <dt className="text-muted-foreground">Type</dt>
                    <dd className="mt-0.5">{o.docType}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Month</dt>
                    <dd className="mt-0.5">{fmtPeriod(o.period)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Needed by</dt>
                    <dd className={`tnum mt-0.5 ${isLate ? "text-destructive" : ""}`}>{o.dueDate}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Amount</dt>
                    <dd className="mt-0.5">{o.amountCents ? <Money cents={o.amountCents} /> : "Not applicable"}</dd>
                  </div>
                </dl>

                {o.rejectionReason ? (
                  <p className="mt-3 rounded-sm border border-destructive/40 bg-danger-soft px-3 py-2 text-xs text-muted-foreground">
                    <span className="font-medium text-destructive">Why it came back:</span> {o.rejectionReason}
                  </p>
                ) : null}

                {files.length ? (
                  <ul className="mt-3 space-y-1.5">
                    {files.map((f) => (
                      <li key={f.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-positive" />
                        <span className="min-w-0 truncate">{f.name}</span>
                        <span className="tnum shrink-0">{fmtTimestamp(f.uploadedAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {o.status !== "accepted" ? (
                  <Button size="sm" variant="outline" className="mt-4" onClick={() => navigate("/portal/upload")} data-testid={`button-satisfy-${o.id}`}>
                    <CalendarClock className="mr-1 h-4 w-4" />
                    {o.status === "rejected" ? "Send a new copy" : "Send this one"}
                  </Button>
                ) : null}
              </SectionCard>
            );
          })}
        </div>
      )}
    </>
  );
}
