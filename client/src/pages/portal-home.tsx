import { useLocation } from "wouter";
import { ArrowRight, CalendarClock, FileText, MessageSquare, PenLine, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Kpi, LoadingRows, Pill, SectionCard } from "@/components/kit";
import { PortalHero } from "@/components/portal/portal-kit";
import { usePortalClient } from "@/lib/use-portal-client";
import { usePortalHome, errorMessage } from "@/api";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";
import { NO_CLIENTS_COPY } from "./firm-overview";
import type { TierId } from "@shared/tiers";

/**
 * The client's front door, read from GET /api/portal/:clientId/home. The
 * server says what the engagement includes; this screen only shows it.
 */
export default function PortalHome() {
  const sel = usePortalClient();
  const [, navigate] = useLocation();
  const q = usePortalHome(sel.clientId);
  const home = q.data;

  if (sel.loading || (sel.clientId && q.isPending)) return <LoadingRows rows={6} cols={3} />;
  if (sel.error) return <ErrorState message={errorMessage(sel.error)} onRetry={sel.retry} />;
  if (!sel.clientId) {
    return (
      <SectionCard title="Client portal" testId="card-portal-noclient">
        <EmptyState title={NO_CLIENTS_COPY} body="The portal shows one client's books. There is no client to show yet." />
      </SectionCard>
    );
  }
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (!home) return <LoadingRows rows={6} cols={3} />;

  const readPeriod = home.latestClosedPeriod ?? home.openPeriod;
  const requests = home.openRequests;
  const todayIso = new Date().toISOString().slice(0, 10);
  const overdue = requests.filter((r) => r.dueOn && r.dueOn < todayIso);
  const can = (f: string) => home.features.includes(f);

  return (
    <>
      <PortalHero
        title={`Welcome to the ${home.client.name} portal`}
        subtitle={
          home.latestClosedPeriod
            ? `${fmtPeriod(home.latestClosedPeriod.slice(0, 7))} is closed, so every number from that month is final.`
            : home.openPeriod
              ? `${fmtPeriod(home.openPeriod.slice(0, 7))} is in progress. Nothing is closed yet.`
              : "Nothing is closed yet, so there are no statements to read."
        }
        tier={home.tier as TierId}
        meta={
          <>
            <Pill tone={home.latestClosedPeriod ? "good" : "neutral"}>{home.latestClosedPeriod ? "Closed month available" : "No closed month"}</Pill>
            {home.engagementStatus && home.engagementStatus !== "active" ? (
              <Pill tone="watch">Engagement {home.engagementStatus}</Pill>
            ) : null}
          </>
        }
        actions={
          <Button size="sm" onClick={() => navigate("/portal/upload")} data-testid="button-portal-upload">
            <Upload className="mr-1 h-4 w-4" />
            Send documents
          </Button>
        }
        testId="hero-portal-home"
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

      {home.hasBooks && readPeriod ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Closed months" value={home.closedPeriods.length} testId="kpi-portal-closed" />
          <Kpi label="Latest closed" value={home.latestClosedPeriod ? fmtPeriod(home.latestClosedPeriod.slice(0, 7)) : "none"} testId="kpi-portal-latest" />
          <Kpi label="Last run" value={home.lastRunAt ? fmtTimestamp(home.lastRunAt) : "never"} testId="kpi-portal-lastrun" />
          <Kpi label="Open with us" value={requests.length} tone={requests.length ? "watch" : "good"} hint="Documents or answers" testId="kpi-portal-open" />
        </div>
      ) : (
        <SectionCard title="Your numbers" testId="card-portal-nofigures">
          <EmptyState
            title="No closed month yet"
            body="Cash, revenue and net income appear here as soon as your first month is closed. Sending your bank statements and receipts is what starts that."
            action={
              <Button size="sm" onClick={() => navigate("/portal/upload")} data-testid="button-portal-first-upload">
                <Upload className="mr-1 h-4 w-4" />
                Send your first documents
              </Button>
            }
          />
        </SectionCard>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          {home.hasBooks && home.latestClosedPeriod ? (
            <SectionCard
              title={`Your ${fmtPeriod(home.latestClosedPeriod.slice(0, 7))} statements are ready`}
              description="Profit and loss and balance sheet, from the closed books."
              testId="card-portal-statements-link"
            >
              <p className="text-sm leading-relaxed text-muted-foreground">
                Every figure comes from the same posted entries you can open yourself. Nothing is summarized behind your back.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => navigate("/portal/statements")} data-testid="button-portal-reports" disabled={!can("statements")}>
                  <FileText className="mr-1 h-4 w-4" />
                  Open my statements
                </Button>
                <Button size="sm" variant="ghost" onClick={() => navigate("/portal/transactions")} data-testid="button-portal-txns" disabled={!can("transactions")}>
                  See my transactions
                </Button>
              </div>
            </SectionCard>
          ) : null}

          <SectionCard title="What your level includes" description={`${home.tierName} engagement.`} testId="card-portal-features">
            {home.features.length ? (
              <div className="flex flex-wrap gap-1.5">
                {home.features.map((f) => (
                  <Pill key={f} tone="info">{f.replace(/_/g, " ")}</Pill>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing is switched on yet. Your engagement letter is {home.engagementStatus ?? "not on file"}; features open once it is signed and active.
              </p>
            )}
          </SectionCard>
        </div>

        <div className="min-w-0 space-y-4">
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

          <SectionCard title="Open requests" bodyClassName="p-0" testId="card-portal-requests">
            {requests.length === 0 ? (
              <div className="p-4">
                <p className="text-sm text-muted-foreground">Nothing is waiting on you.</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {requests.slice(0, 5).map((r) => (
                  <li key={r.id} className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-medium">{r.subject}</p>
                      <Pill tone={r.dueOn && r.dueOn < todayIso ? "risk" : "neutral"}>{r.kind}</Pill>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{r.detail}</p>
                    <p className="tnum mt-1 text-xs text-muted-foreground">Opened {r.openedOn}{r.dueOn ? `, due ${r.dueOn}` : ""}</p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>
    </>
  );
}
