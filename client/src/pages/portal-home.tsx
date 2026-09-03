import { useMemo } from "react";
import { useLocation } from "wouter";
import { ArrowRight, CalendarClock, FileText, MessageSquare, PenLine, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, Kpi, Meter, Pill, SectionCard } from "@/components/kit";
import { ClosePill, LockedFeature, PortalHero } from "@/components/portal/portal-kit";
import { usePortal } from "@/lib/use-portal";
import { useApp } from "@/store";
import { balanceSheet, clientRollup, monthlyNarrative, profitAndLoss } from "@/data/derive";
import { agingFact, budgetFact, compareFact, forecastFact, narrativeFact } from "@/data/portal-facts";
import { fmtPeriod, fmtTimestamp, usd } from "@/lib/money";
import { TODAY } from "@/data/seed";
import type { FeatureId } from "@/data/entitlement";
import type { TruthfulFact } from "@/data/portal-facts";

export default function PortalHome() {
  const p = usePortal();
  const { period: headerPeriod } = useApp();
  const [, navigate] = useLocation();
  const ds = p.ds;
  const clientId = p.clientId;
  const readPeriod = p.period;

  const figures = useMemo(() => {
    if (!readPeriod || !p.hasBooks) return null;
    const pl = profitAndLoss(ds, clientId, readPeriod);
    const bs = balanceSheet(ds, clientId, readPeriod);
    const cash = bs.assetGroups[0].rows.filter((r) => r.account.cashLike).reduce((s, r) => s + r.amount, 0);
    return { pl, cash, roll: clientRollup(ds, clientId, readPeriod) };
  }, [ds, clientId, readPeriod, p.hasBooks]);

  const points = useMemo(
    () => (readPeriod && p.hasBooks && p.can("narrative") ? monthlyNarrative(ds, clientId, readPeriod) : []),
    [ds, clientId, readPeriod, p.hasBooks, p],
  );

  /** One teaser, and only when it can name a real number from this client's books. */
  const teaser = useMemo((): { feature: FeatureId; fact: TruthfulFact } | null => {
    if (!readPeriod) return null;
    const order: { feature: FeatureId; fact: () => TruthfulFact }[] = [
      { feature: "aging", fact: () => agingFact(ds, clientId) },
      { feature: "forecast", fact: () => forecastFact(ds, clientId) },
      { feature: "compare", fact: () => compareFact(ds, clientId, readPeriod) },
      { feature: "budget", fact: () => budgetFact(ds, clientId, readPeriod) },
      { feature: "narrative", fact: () => narrativeFact(ds, clientId, readPeriod) },
    ];
    for (const o of order) {
      if (p.can(o.feature)) continue;
      const f = o.fact();
      if (f.hasData) return { feature: o.feature, fact: f };
    }
    return null;
  }, [ds, clientId, readPeriod, p]);

  const requests = ds.openItems.filter((o) => o.clientId === clientId && o.status !== "accepted");
  const overdue = requests.filter((o) => o.dueDate < TODAY);
  const signed = ds.signatures.filter((s) => s.clientId === clientId);
  const messages = ds.comms.filter((c) => c.clientId === clientId).slice(-3).reverse();
  const contact = p.client.contacts[0];

  return (
    <>
      <PortalHero
        title={`Welcome back, ${contact?.name.split(" ")[0] || "there"}`}
        subtitle={
          readPeriod
            ? p.close && p.close.state === "open"
              ? `This is the ${p.client.dba} portal. ${fmtPeriod(readPeriod)} is still in progress, and your level lets you watch it as it fills in.`
              : `This is the ${p.client.dba} portal. ${fmtPeriod(readPeriod)} is closed, so every number below is final.`
            : `This is the ${p.client.dba} portal. Nothing is closed yet, so there are no statements to read.`
        }
        tier={p.tier}
        meta={
          <>
            <ClosePill close={p.close} />
            {p.periodHeldBack ? <Pill tone="neutral">{fmtPeriod(headerPeriod)} is not closed yet</Pill> : null}
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

      {figures ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Cash on hand" value={usd(figures.cash)} hint={`As of the end of ${fmtPeriod(readPeriod!)}`} testId="kpi-portal-cash" />
          <Kpi
            label="Revenue this month"
            value={usd(figures.pl.revenue)}
            tone={figures.pl.revenue >= figures.pl.priorRevenue ? "good" : "watch"}
            testId="kpi-portal-revenue"
          />
          <Kpi label="Net income" value={usd(figures.pl.netIncome)} tone={figures.pl.netIncome >= 0 ? "good" : "risk"} testId="kpi-portal-net" />
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
          {points.length > 0 && readPeriod ? (
            <SectionCard
              title={`What happened in ${fmtPeriod(readPeriod)}`}
              description="Written by your accountant from the closed books."
              testId="card-portal-narrative"
            >
              <ul className="space-y-3">
                {points.slice(0, 4).map((pt) => (
                  <li key={pt.heading}>
                    <p className="text-sm font-semibold">{pt.heading}</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{pt.body}</p>
                  </li>
                ))}
              </ul>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => navigate("/portal/narrative")} data-testid="button-portal-reports">
                <FileText className="mr-1 h-4 w-4" />
                Read the whole write up
              </Button>
            </SectionCard>
          ) : figures ? (
            <SectionCard
              title={`Your ${fmtPeriod(readPeriod!)} statements are ready`}
              description="Profit and loss, balance sheet and cash flow, from the closed books."
              testId="card-portal-statements-link"
            >
              <div className="p-4 pt-0">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Every figure on this page comes from the same posted entries you can open yourself. Nothing is summarized behind your back.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => navigate("/portal/statements")} data-testid="button-portal-reports">
                    <FileText className="mr-1 h-4 w-4" />
                    Open my statements
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => navigate("/portal/transactions")} data-testid="button-portal-txns">
                    See my transactions
                  </Button>
                </div>
              </div>
            </SectionCard>
          ) : null}

          {teaser ? <LockedFeature feature={teaser.feature} fact={teaser.fact} currentTier={p.tier} testId="locked-home-teaser" /> : null}
        </div>

        <div className="min-w-0 space-y-4">
          {figures ? (
            <SectionCard title="Close progress" testId="card-portal-progress">
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{fmtPeriod(readPeriod!)} close</span>
                  <span className="tnum font-semibold">{figures.roll.closeProgress}%</span>
                </div>
                <Meter pct={figures.roll.closeProgress} />
                <p className="text-xs text-muted-foreground">
                  Your accountant is {p.client.lead}, and the review happens before anything is sent to you.
                </p>
              </div>
            </SectionCard>
          ) : null}

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
            {messages.length === 0 ? (
              <div className="p-4">
                <p className="text-sm text-muted-foreground">
                  Nothing has been sent either way yet. Messages you send here land with the person who closes your books.
                </p>
                <Button size="sm" variant="outline" className="mt-3" onClick={() => navigate("/portal/messages")} data-testid="button-portal-first-message">
                  Start a message
                </Button>
              </div>
            ) : (
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
            )}
          </SectionCard>

          {signed.length ? (
            <SectionCard title="Signed documents" bodyClassName="p-0" testId="card-portal-signed">
              <ul className="divide-y divide-border">
                {signed.slice(0, 3).map((s) => (
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
