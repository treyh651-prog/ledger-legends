import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataGrid, EmptyState, ErrorState, Kpi, LoadingRows, Money, Pill, SectionCard } from "@/components/kit";
import { PortalHero, PortalNote } from "@/components/portal/portal-kit";
import { usePortalClient } from "@/lib/use-portal-client";
import { usePortalHome, usePortalStatements, ApiRequestError, errorMessage } from "@/api";
import { fmtPeriod, usd } from "@/lib/money";
import { NO_CLIENTS_COPY } from "./firm-overview";
import type { TierId } from "@shared/tiers";
import type { StatementSection } from "@shared/api";

/**
 * A client's statements for one period, read from
 * GET /api/portal/:clientId/statements?period=. The server picks the latest
 * visible period when none is asked for, and answers 403 feature_not_included
 * when the engagement does not carry statements yet.
 */
export default function PortalStatements() {
  const sel = usePortalClient();
  const [period, setPeriod] = useState<string | null>(null);
  const home = usePortalHome(sel.clientId);
  const q = usePortalStatements(sel.clientId, period);
  const st = q.data;

  if (sel.loading) return <LoadingRows rows={6} cols={2} />;
  if (sel.error) return <ErrorState message={errorMessage(sel.error)} onRetry={sel.retry} />;
  if (!sel.clientId) {
    return (
      <SectionCard title="Your financial statements" testId="card-portal-noclient">
        <EmptyState title={NO_CLIENTS_COPY} body="There is no client whose statements could be shown." />
      </SectionCard>
    );
  }

  const tier = (home.data?.tier ?? "ledger") as TierId;
  const clientName = home.data?.client.name ?? "your business";

  return (
    <>
      <PortalHero
        title="Your financial statements"
        subtitle={`Profit and loss and balance sheet for ${clientName}, built from your posted books. Your records are always open to you.`}
        tier={tier}
        meta={
          st ? (
            <Pill tone={st.periodStatus === "locked" ? "good" : st.periodStatus === "open" ? "watch" : "neutral"} testId="pill-statements-close">
              {st.periodStatus === "locked" ? "Closed" : st.periodStatus === "open" ? "In progress" : "No period"}
            </Pill>
          ) : null
        }
        actions={
          st && st.visiblePeriods.length > 0 ? (
            <Select value={st.period} onValueChange={setPeriod}>
              <SelectTrigger className="h-8 w-[170px] text-xs" data-testid="select-portal-statement-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {st.visiblePeriods.map((v) => (
                  <SelectItem key={v} value={v}>
                    {fmtPeriod(v.slice(0, 7))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null
        }
        testId="hero-portal-statements"
      />

      {q.isPending ? <LoadingRows rows={6} cols={2} /> : null}

      {q.isError ? (
        q.error instanceof ApiRequestError && q.error.code === "feature_not_included" ? (
          <SectionCard title="Statements" testId="card-portal-statements-locked">
            <EmptyState title="Statements are not part of this engagement yet" body={q.error.message} />
          </SectionCard>
        ) : (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        )
      ) : null}

      {st && st.periodStatus === "open" ? (
        <PortalNote tone="watch" testId="note-statements-draft">
          {fmtPeriod(st.period.slice(0, 7))} is not closed yet, so treat every figure below as a draft. Entries can still change while we
          finish the month.
        </PortalNote>
      ) : null}

      {st && !st.foots ? (
        <PortalNote tone="watch" testId="note-statements-foots">
          The trial balance for this month does not foot. Your accountant has been told. The figures below are shown as they stand.
        </PortalNote>
      ) : null}

      {st && (st.periodStatus === "none" || st.entryCount === 0) ? (
        <SectionCard title="Statements" testId="card-portal-statements-empty">
          <EmptyState
            title="No closed month yet"
            body="Statements are released once a month is closed and reviewed. Nothing is being held back from you, there is simply no closed period on your books yet."
          />
        </SectionCard>
      ) : null}

      {st && st.periodStatus !== "none" && st.entryCount > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Revenue" value={usd(sectionTotal(st.incomeStatement, "revenue"))} hint={fmtPeriod(st.period.slice(0, 7))} tone="neutral" testId="kpi-portal-revenue" />
            <Kpi label="Net income" value={usd(st.netIncomeCents)} tone={st.netIncomeCents >= 0 ? "good" : "risk"} testId="kpi-portal-net" />
            <Kpi label="Total assets" value={usd(st.totalAssetsCents)} testId="kpi-portal-assets" />
            <Kpi
              label="Balance sheet"
              value={st.foots ? "In balance" : "Out of balance"}
              hint={st.foots ? "Assets equal liabilities plus equity" : `Difference of ${usd(st.totalAssetsCents - st.totalLiabilitiesAndEquityCents)}`}
              tone={st.foots ? "good" : "risk"}
              testId="kpi-portal-balanced"
            />
          </div>

          <SectionCard title={`Profit and loss, ${fmtPeriod(st.period.slice(0, 7))}`} description="Every line comes from your own posted entries." testId="card-portal-pl">
            <StatementGrid sections={st.incomeStatement} footer={{ label: "Net income", amount: st.netIncomeCents }} testId="grid-portal-pl" />
          </SectionCard>

          <SectionCard title={`Balance sheet, ${fmtPeriod(st.period.slice(0, 7))}`} testId="card-portal-bs">
            <StatementGrid sections={st.balanceSheet} footer={{ label: "Total liabilities and equity", amount: st.totalLiabilitiesAndEquityCents }} testId="grid-portal-bs" />
          </SectionCard>
        </>
      ) : null}
    </>
  );
}

function sectionTotal(sections: StatementSection[], code: string): number {
  return sections.find((s) => s.code === code)?.totalCents ?? 0;
}

export function StatementGrid({ sections, footer, testId }: { sections: StatementSection[]; footer: { label: string; amount: number }; testId: string }) {
  const rows: { key: string; label: string; amount: number; strong: boolean; indent: boolean }[] = [];
  for (const s of sections) {
    for (const l of s.lines) rows.push({ key: `${s.code}:${l.accountNumber}`, label: `${l.accountNumber} ${l.name}`, amount: l.presentedCents, strong: false, indent: true });
    rows.push({ key: `${s.code}:total`, label: s.title, amount: s.totalCents, strong: true, indent: false });
  }
  rows.push({ key: "footer", label: footer.label, amount: footer.amount, strong: true, indent: false });
  return (
    <DataGrid
      rows={rows}
      rowKey={(r) => r.key}
      cols={[
        {
          key: "label",
          label: "Line",
          mobile: "title",
          render: (r) => <span className={`${r.strong ? "font-semibold" : ""} ${r.indent ? "pl-4" : ""}`}>{r.label}</span>,
        },
        {
          key: "amount",
          label: "Amount",
          align: "right",
          mobile: "value",
          render: (r) => <Money cents={r.amount} className={r.strong ? "font-semibold" : ""} />,
        },
      ]}
      testId={testId}
    />
  );
}
