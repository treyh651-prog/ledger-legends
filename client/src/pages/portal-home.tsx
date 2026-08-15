import { useMemo } from "react";
import { useLocation } from "wouter";
import { ArrowRight, CalendarClock, FileText, MessageSquare, PenLine, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kpi, Meter, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { balanceSheet, clientRollup, monthlyNarrative, profitAndLoss } from "@/data/derive";
import { fmtPeriod, fmtTimestamp, usd } from "@/lib/money";
import { TODAY } from "@/data/seed";

export default function PortalHome() {
  const { ds, activeClient, activeClientId, period } = useApp();
  const [, navigate] = useLocation();

  const pl = useMemo(() => profitAndLoss(ds, activeClientId, period), [ds, activeClientId, period]);
  const bs = useMemo(() => balanceSheet(ds, activeClientId, period), [ds, activeClientId, period]);
  const roll = useMemo(() => clientRollup(ds, activeClientId, period), [ds, activeClientId, period]);
  const points = useMemo(() => monthlyNarrative(ds, activeClientId, period), [ds, activeClientId, period]);
  const cash = bs.assetGroups[0].rows.filter((r) => r.account.cashLike).reduce((s, r) => s + r.amount, 0);

  const requests = ds.openItems.filter((o) => o.clientId === activeClientId && o.status !== "accepted");
  const overdue = requests.filter((o) => o.dueDate < TODAY);
  const unsigned = ds.signatures.filter((s) => s.clientId === activeClientId);
  const messages = ds.comms.filter((c) => c.clientId === activeClientId).slice(-3).reverse();
  const contact = activeClient.contacts[0];

  return (
    <>
      <PageHeader
        title={`Welcome back, ${contact?.name.split(" ")[0] || "there"}`}
        subtitle={`This is the ${activeClient.dba} portal. Your ${fmtPeriod(period)} books are closed and the package is ready to read.`}
        actions={
          <Button size="sm" onClick={() => navigate("/portal/upload")} data-testid="button-portal-upload">
            <Upload className="mr-1 h-4 w-4" />
            Send documents
          </Button>
        }
      />

      {requests.length ? (
        <div className="rounded-md border border-warning/40 bg-warning-soft p-4" data-testid="banner-portal-requests">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-warning">
                {requests.length} item{requests.length > 1 ? "s" : ""} your accountant is waiting on
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {overdue.length ? `${overdue.length} of them are past the date we agreed on. ` : ""}
                Sending them keeps next month's close on schedule.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => navigate("/portal/requests")} data-testid="button-portal-see-requests">
              See what is needed
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Cash on hand" value={usd(cash)} hint={`As of the end of ${fmtPeriod(period)}`} testId="kpi-portal-cash" />
        <Kpi label="Revenue this month" value={usd(pl.revenue)} tone={pl.revenue >= pl.priorRevenue ? "good" : "watch"} testId="kpi-portal-revenue" />
        <Kpi label="Net income" value={usd(pl.netIncome)} tone={pl.netIncome >= 0 ? "good" : "risk"} testId="kpi-portal-net" />
        <Kpi label="Open with us" value={requests.length} tone={requests.length ? "watch" : "good"} hint="Documents or answers" testId="kpi-portal-open" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <SectionCard title={`What happened in ${fmtPeriod(period)}`} description="Written by your accountant from the closed books." testId="card-portal-narrative">
          <ul className="space-y-3">
            {points.slice(0, 4).map((p) => (
              <li key={p.heading}>
                <p className="text-sm font-semibold">{p.heading}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
              </li>
            ))}
          </ul>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => navigate("/portal/reports")} data-testid="button-portal-reports">
            <FileText className="mr-1 h-4 w-4" />
            Open the full package
          </Button>
        </SectionCard>

        <div className="space-y-4">
          <SectionCard title="Close progress" testId="card-portal-progress">
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{fmtPeriod(period)} close</span>
                <span className="tnum font-semibold">{roll.closeProgress}%</span>
              </div>
              <Meter pct={roll.closeProgress} />
              <p className="text-xs text-muted-foreground">
                Your accountant is {activeClient.lead === "Dana Whitfield" ? "Dana Whitfield" : activeClient.lead}, and the review happens before
                anything is sent to you.
              </p>
            </div>
          </SectionCard>

          <SectionCard title="Quick actions" bodyClassName="p-0" testId="card-portal-actions">
            <ul className="divide-y divide-border">
              {[
                { icon: Upload, label: "Upload a statement or receipt", href: "/portal/upload" },
                { icon: CalendarClock, label: "Check what is still needed", href: "/portal/requests" },
                { icon: PenLine, label: "Sign a document", href: "/portal/sign" },
                { icon: MessageSquare, label: "Message your accountant", href: "/portal/messages" },
              ].map((a) => (
                <li key={a.href}>
                  <button
                    type="button"
                    onClick={() => navigate(a.href)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover-elevate"
                    data-testid={`button-quick-${a.href.split("/").pop()}`}
                  >
                    <a.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">{a.label}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard title="Recent messages" bodyClassName="p-0" testId="card-portal-messages">
            <ul className="divide-y divide-border">
              {messages.map((m) => (
                <li key={m.id} className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">{m.subject}</p>
                    <Pill tone={m.direction === "Outbound" ? "info" : "neutral"}>{m.direction === "Outbound" ? "From us" : "From you"}</Pill>
                  </div>
                  <p className="tnum mt-1 text-xs text-muted-foreground">{fmtTimestamp(m.at)}</p>
                </li>
              ))}
            </ul>
          </SectionCard>

          {unsigned.length ? (
            <SectionCard title="Signed documents" bodyClassName="p-0" testId="card-portal-signed">
              <ul className="divide-y divide-border">
                {unsigned.slice(0, 3).map((s) => (
                  <li key={s.id} className="px-4 py-2.5">
                    <p className="truncate text-sm">{s.documentTitle}</p>
                    <p className="tnum text-xs text-muted-foreground">
                      {s.signerName}, {fmtTimestamp(s.signedAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </div>
      </div>
    </>
  );
}
