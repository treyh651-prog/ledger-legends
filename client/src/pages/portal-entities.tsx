import { useMemo } from "react";
import { DataGrid, EmptyState, Kpi, Money, Pill, SectionCard } from "@/components/kit";
import { LockedFeature, PortalHero, PortalNote } from "@/components/portal/portal-kit";
import { usePortal } from "@/lib/use-portal";
import { consolidatedView, consolidationFact, type EntityLine } from "@/data/portal-facts";
import { fmtPeriod, usd } from "@/lib/money";

/** Legend feature. Two or more entities combined for one period. */
export default function PortalEntities() {
  const p = usePortal();
  const readPeriod = p.period;

  const fact = useMemo(
    () => (readPeriod ? consolidationFact(p.ds, p.clientId, p.memberIds, readPeriod) : null),
    [p.ds, p.clientId, p.memberIds, readPeriod],
  );
  const view = useMemo(
    () => (readPeriod && p.memberIds.length > 1 ? consolidatedView(p.ds, p.memberIds, readPeriod) : null),
    [p.ds, p.memberIds, readPeriod],
  );

  if (!p.can("consolidation")) {
    return (
      <>
        <PortalHero
          title="Your group"
          subtitle="If you own more than one company, this combines them into one set of statements."
          tier={p.tier}
          testId="hero-portal-entities"
        />
        {fact ? <LockedFeature feature="consolidation" fact={fact} currentTier={p.tier} /> : null}
      </>
    );
  }

  const single = p.memberIds.length <= 1;

  return (
    <>
      <PortalHero
        title="Your group"
        subtitle={
          single
            ? `Your engagement lists one entity, ${p.client.dba}. A consolidation would just repeat the statements you already have.`
            : `${p.group ? p.group.name : "Your group"} combined for ${readPeriod ? fmtPeriod(readPeriod) : "the current period"}. Each entity total comes from its own posted books.`
        }
        tier={p.tier}
        meta={<Pill tone="info">{p.memberIds.length} entity on file{p.memberIds.length === 1 ? "" : "s"}</Pill>}
        testId="hero-portal-entities"
      />

      {single || !view || !readPeriod ? (
        <SectionCard title="Group reporting" testId="card-portal-entities-single">
          <EmptyState
            title="One entity, nothing to combine"
            body="Group reporting starts to matter at two entities or more. Tell us when a second company opens and we will set the group up, and this page fills in on its own."
          />
        </SectionCard>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Combined revenue" value={usd(view.combined.revenue)} hint={fmtPeriod(readPeriod)} testId="kpi-portal-cons-revenue" />
            <Kpi
              label="Combined net income"
              value={usd(view.combined.netIncome)}
              tone={view.combined.netIncome >= 0 ? "good" : "watch"}
              testId="kpi-portal-cons-net"
            />
            <Kpi label="Combined cash" value={usd(view.combined.cash)} testId="kpi-portal-cons-cash" />
            <Kpi label="Combined assets" value={usd(view.combined.totalAssets)} testId="kpi-portal-cons-assets" />
          </div>

          <SectionCard
            title={`By entity, ${fmtPeriod(readPeriod)}`}
            description="One row per company, then the combined total."
            testId="card-portal-entities"
          >
            <DataGrid<EntityLine>
              rows={view.entities}
              rowKey={(e) => e.clientId}
              cols={[
                {
                  key: "name",
                  label: "Entity",
                  mobile: "title",
                  render: (e) => (
                    <div className="min-w-0">
                      <p className="truncate font-medium">{e.name}</p>
                      <p className="text-xs text-muted-foreground">{e.closed ? "Month closed" : "Month still open"}</p>
                    </div>
                  ),
                },
                { key: "revenue", label: "Revenue", align: "right", mobile: "row", render: (e) => <Money cents={e.revenue} /> },
                { key: "net", label: "Net income", align: "right", mobile: "value", render: (e) => <Money cents={e.netIncome} signed /> },
                { key: "cash", label: "Cash", align: "right", mobile: "row", render: (e) => <Money cents={e.cash} /> },
                { key: "assets", label: "Assets", align: "right", mobile: "row", render: (e) => <Money cents={e.totalAssets} /> },
                { key: "liabilities", label: "Liabilities", align: "right", mobile: "row", render: (e) => <Money cents={e.totalLiabilities} /> },
              ]}
              footer={
                <tr>
                  <td className="px-3 py-2 text-sm font-semibold">Combined</td>
                  <td className="tnum hidden px-3 py-2 text-right text-sm font-semibold sm:table-cell">{usd(view.combined.revenue)}</td>
                  <td className="tnum px-3 py-2 text-right text-sm font-semibold">{usd(view.combined.netIncome)}</td>
                  <td className="tnum hidden px-3 py-2 text-right text-sm font-semibold sm:table-cell">{usd(view.combined.cash)}</td>
                  <td className="tnum hidden px-3 py-2 text-right text-sm font-semibold sm:table-cell">{usd(view.combined.totalAssets)}</td>
                  <td className="tnum hidden px-3 py-2 text-right text-sm font-semibold sm:table-cell">{usd(view.combined.totalLiabilities)}</td>
                </tr>
              }
              testId="grid-portal-entities"
            />
          </SectionCard>

          {view.relatedPartyNote ? (
            <PortalNote tone="watch" testId="note-portal-cons-related">
              {view.relatedPartyNote}
            </PortalNote>
          ) : (
            <PortalNote testId="note-portal-cons-basis">
              The combined column is the sum of each entity as posted. No intercompany eliminations are recorded on this engagement, and we
              say that plainly rather than implying a consolidation that was never done.
            </PortalNote>
          )}
        </>
      )}
    </>
  );
}
