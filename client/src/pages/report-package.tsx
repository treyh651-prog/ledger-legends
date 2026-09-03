import { useMemo, useState } from "react";
import { CheckCircle2, FileDown, Package, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Kpi, PageHeader, Pill, SectionCard, ToneDot } from "@/components/kit";
import { useApp } from "@/store";
import { balanceSheet, cashFlow, monthlyNarrative, profitAndLoss, substantiationViews, trialBalance, agingByParty, openBills, openInvoices, totalBuckets } from "@/data/derive";
import { fmtPeriod, usd } from "@/lib/money";

const SECTIONS = [
  { id: "cover", label: "Cover page with the period and preparer", always: true },
  { id: "narrative", label: "Monthly narrative in plain language" },
  { id: "pl", label: "Profit and loss with the prior month beside it" },
  { id: "bs", label: "Balance sheet" },
  { id: "cf", label: "Statement of cash flows" },
  { id: "tb", label: "Trial balance" },
  { id: "aging", label: "Receivable and payable aging" },
  { id: "sub", label: "Balance sheet substantiation summary" },
  { id: "open", label: "Open items still with the client" },
];

export default function ReportPackage() {
  const { ds, activeClient, activeClientId, period, comparePeriod, addMessage, logAudit } = useApp();
  const { toast } = useToast();
  const [picked, setPicked] = useState<string[]>(SECTIONS.map((s) => s.id));
  const [sent, setSent] = useState(false);

  const pl = useMemo(() => profitAndLoss(ds, activeClientId, period, comparePeriod), [ds, activeClientId, period, comparePeriod]);
  const bs = useMemo(() => balanceSheet(ds, activeClientId, period), [ds, activeClientId, period]);
  const cf = useMemo(() => cashFlow(ds, activeClientId, period), [ds, activeClientId, period]);
  const tb = useMemo(() => trialBalance(ds, activeClientId, period), [ds, activeClientId, period]);
  const subs = useMemo(() => substantiationViews(ds, activeClientId, period), [ds, activeClientId, period]);
  const points = useMemo(() => monthlyNarrative(ds, activeClientId, period), [ds, activeClientId, period]);
  const ar = totalBuckets(agingByParty(openInvoices(ds, activeClientId).map((i) => ({ party: i.customer, dueDate: i.dueDate, open: i.amountCents - i.paidCents }))).map((r) => r.buckets));
  const ap = totalBuckets(agingByParty(openBills(ds, activeClientId).map((b) => ({ party: b.vendor, dueDate: b.dueDate, open: b.amountCents - b.paidCents }))).map((r) => r.buckets));
  const openItems = ds.openItems.filter((o) => o.clientId === activeClientId && o.status !== "accepted");
  const exceptions = subs.filter((s) => s.status !== "tied");

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <>
      <PageHeader
        title="Report package"
        subtitle={`Assemble what goes to ${activeClient.dba} for ${fmtPeriod(period)}. The preview below reads from the same closed ledger the statements use.`}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                logAudit(undefined, `${activeClient.shortName} ${period} package`, "downloaded", `Package with ${picked.length} sections`, "Jose Hernandez", "firm");
                toast({ title: "Package assembled", description: `${picked.length} sections ready for ${activeClient.shortName}.` });
              }}
              data-testid="button-assemble"
            >
              <FileDown className="mr-1 h-4 w-4" />
              Assemble
            </Button>
            <Button
              size="sm"
              onClick={() => {
                addMessage(
                  activeClientId,
                  "Jose Hernandez",
                  `${fmtPeriod(period)} report package`,
                  `The ${fmtPeriod(period)} package is in your portal with ${picked.length} sections, including the narrative and the full statements.`,
                  "Outbound",
                );
                logAudit(undefined, `${activeClient.shortName} ${period} package`, "shared", "Published to the client portal", "Jose Hernandez", "firm");
                setSent(true);
                toast({ title: "Sent to the portal", description: "The client can open it from the reports page." });
              }}
              data-testid="button-publish-package"
            >
              <Send className="mr-1 h-4 w-4" />
              Send to the client
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Sections selected" value={`${picked.length} of ${SECTIONS.length}`} testId="kpi-sections-picked" />
        <Kpi label="Net income" value={usd(pl.netIncome)} tone={pl.netIncome >= 0 ? "good" : "risk"} testId="kpi-pkg-net" />
        <Kpi label="Exceptions noted" value={exceptions.length + openItems.length} tone={exceptions.length + openItems.length ? "watch" : "good"} testId="kpi-pkg-exceptions" />
        <Kpi label="Delivery" value={sent ? "Sent" : "Not sent"} tone={sent ? "good" : "neutral"} testId="kpi-pkg-sent" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <SectionCard title="What to include" bodyClassName="p-0" testId="card-picker">
          <ul className="divide-y divide-border">
            {SECTIONS.map((s) => (
              <li key={s.id} className="flex items-start gap-2.5 px-4 py-2.5">
                <Checkbox
                  checked={picked.includes(s.id)}
                  disabled={s.always}
                  onCheckedChange={() => toggle(s.id)}
                  className="mt-0.5"
                  data-testid={`checkbox-${s.id}`}
                />
                <span className="text-sm leading-snug">{s.label}</span>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="Preview" description="This is what the client opens." testId="card-preview">
          <article className="space-y-6 rounded-md border border-border bg-background p-5">
            <header className="border-b border-border pb-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
                <Package className="h-3.5 w-3.5" />
                Monthly financial package
              </div>
              <h2 className="mt-2 text-xl font-semibold">{activeClient.legalName}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {fmtPeriod(period)}. Prepared by Ledger Legends, reviewed by {activeClient.lead}. Figures come from the closed ledger and were
                checked against supporting documents.
              </p>
            </header>

            {picked.includes("narrative") ? (
              <section>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Narrative</h3>
                <div className="mt-2 space-y-2">
                  {points.slice(0, 4).map((p) => (
                    <div key={p.heading} className="flex gap-2">
                      <ToneDot tone={p.tone} />
                      <p className="text-sm leading-relaxed">
                        <span className="font-medium">{p.heading}.</span> {p.body}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {picked.includes("pl") ? (
              <section>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Profit and loss</h3>
                <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                  {[
                    ["Revenue", pl.revenue],
                    ["Cost of sales", pl.costOfSales],
                    ["Gross profit", pl.grossProfit],
                    ["Operating expenses", pl.operatingExpenses],
                    ["Net income", pl.netIncome],
                  ].map(([label, value]) => (
                    <div key={label as string}>
                      <dt className="text-xs text-muted-foreground">{label as string}</dt>
                      <dd className="tnum font-medium">{usd(value as number)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}

            {picked.includes("bs") ? (
              <section>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Balance sheet</h3>
                <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">Total assets</dt>
                    <dd className="tnum font-medium">{usd(bs.totalAssets)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Total liabilities</dt>
                    <dd className="tnum font-medium">{usd(bs.totalLiabilities)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Total equity</dt>
                    <dd className="tnum font-medium">{usd(bs.totalEquity)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Check</dt>
                    <dd>
                      <Pill tone={bs.balanced ? "good" : "risk"}>{bs.balanced ? "In balance" : usd(bs.difference)}</Pill>
                    </dd>
                  </div>
                </dl>
              </section>
            ) : null}

            {picked.includes("cf") ? (
              <section>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Cash flow</h3>
                <p className="mt-2 text-sm leading-relaxed">
                  Cash opened at {usd(cf.beginningCash)} and closed at {usd(cf.endingCash)}. Operations{" "}
                  {cf.operatingTotal >= 0 ? "brought in" : "used"} {usd(cf.operatingTotal)}.
                </p>
              </section>
            ) : null}

            {picked.includes("tb") ? (
              <section>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Trial balance</h3>
                <p className="mt-2 inline-flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-positive" />
                  Debits and credits both total {usd(tb.totalDebit)} across {tb.rows.length} accounts.
                </p>
              </section>
            ) : null}

            {picked.includes("aging") ? (
              <section>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Aging</h3>
                <p className="mt-2 text-sm leading-relaxed">
                  Receivables of {usd(ar.total)} with {usd(ar.b31 + ar.b61 + ar.b90)} past thirty days. Payables of {usd(ap.total)}.
                </p>
              </section>
            ) : null}

            {picked.includes("sub") ? (
              <section>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Substantiation</h3>
                <p className="mt-2 text-sm leading-relaxed">
                  {subs.length - exceptions.length} of {subs.length} balance sheet accounts tie to their support.
                  {exceptions.length ? ` Still open: ${exceptions.map((e) => e.accountName).join(", ")}.` : " Nothing outstanding."}
                </p>
              </section>
            ) : null}

            {picked.includes("open") ? (
              <section>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Open items</h3>
                {openItems.length ? (
                  <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                    {openItems.map((o) => (
                      <li key={o.id}>
                        {o.title}, requested from {o.requestedFrom}, due {o.dueDate}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm">Nothing outstanding with the client.</p>
                )}
              </section>
            ) : null}
          </article>
        </SectionCard>
      </div>
    </>
  );
}
