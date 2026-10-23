import { EmptyState, Kpi, Money, SectionCard } from "@/components/kit";
import { PortalNote } from "@/components/portal/portal-kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalHome, usePortalPeriods, usePortalStatements } from "@/api";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";
import { StatementGrid } from "./portal-statements";

/**
 * Legend feature. The month in progress before it closes, read from
 * GET /api/portal/:clientId/periods for the open month and
 * GET /api/portal/:clientId/statements?period= for its draft figures.
 */
export default function PortalOpenPeriod() {
  return (
    <PortalScreen title="The month in progress" subtitle="Your books before the month closes. Every figure here is a draft until it does." testId="hero-portal-open-period">
      {({ clientId }) => <Body clientId={clientId} />}
    </PortalScreen>
  );
}

function Body({ clientId }: { clientId: string }) {
  const periods = usePortalPeriods(clientId);
  return (
    <QueryBody q={periods} title="Accrual tracking" testId="card-portal-open-period">
      {(data) => {
        const open = data.items.find((p) => p.status === "open") ?? null;
        if (!open) {
          return (
            <SectionCard title="Month in progress" testId="card-portal-open-period-empty">
              <EmptyState
                title={data.items.length === 0 ? "No month has been opened yet" : "No month is open right now"}
                body={
                  data.items.length === 0
                    ? "The first period is opened when your books start. Nothing is in progress yet."
                    : `The latest month, ${fmtPeriod(data.items[0]!.periodStart.slice(0, 7))}, is closed${data.items[0]!.lockedAt ? ` since ${fmtTimestamp(data.items[0]!.lockedAt)}` : ""}.`
                }
              />
            </SectionCard>
          );
        }
        return <Draft clientId={clientId} period={open.periodStart} />;
      }}
    </QueryBody>
  );
}

function Draft({ clientId, period }: { clientId: string; period: string }) {
  const q = usePortalStatements(clientId, period);
  const home = usePortalHome(clientId);
  return (
    <QueryBody q={q} title="Month in progress" testId="card-portal-open-period-draft">
      {(st) => (
        <>
          <PortalNote tone="watch" testId="note-open-period-draft">
            {fmtPeriod(period.slice(0, 7))} is open. Entries can still change until your accountant closes it
            {home.data?.lastRunAt ? `, last activity ${fmtTimestamp(home.data.lastRunAt)}` : ""}.
          </PortalNote>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Entries so far" value={st.entryCount} testId="kpi-open-entries" />
            <Kpi label="Net income, draft" value={<Money cents={st.netIncomeCents} />} tone={st.netIncomeCents >= 0 ? "good" : "risk"} testId="kpi-open-net" />
            <Kpi label="Total assets, draft" value={<Money cents={st.totalAssetsCents} />} testId="kpi-open-assets" />
            <Kpi label="Foots" value={st.foots ? "Yes" : "No"} tone={st.foots ? "good" : "risk"} testId="kpi-open-foots" />
          </div>
          {st.entryCount === 0 ? (
            <SectionCard title="Draft statements" testId="card-portal-open-period-none">
              <EmptyState title="Nothing posted yet this month" body="Draft statements appear as entries post. There are none in this month so far." />
            </SectionCard>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <StatementGrid sections={st.incomeStatement} footer={{ label: "Net income, draft", amount: st.netIncomeCents }} testId="grid-open-income" />
              <StatementGrid sections={st.balanceSheet} footer={{ label: "Total assets, draft", amount: st.totalAssetsCents }} testId="grid-open-balance" />
            </div>
          )}
        </>
      )}
    </QueryBody>
  );
}
