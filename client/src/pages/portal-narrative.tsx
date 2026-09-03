import { useMemo } from "react";
import { EmptyState, Pill, SectionCard, ToneDot } from "@/components/kit";
import { ClosePill, LockedFeature, PortalHero, PortalNote } from "@/components/portal/portal-kit";
import { usePortal } from "@/lib/use-portal";
import { monthlyNarrative } from "@/data/derive";
import { narrativeFact } from "@/data/portal-facts";
import { fmtPeriod } from "@/lib/money";

/** Legend feature. The written read on a closed month. */
export default function PortalNarrative() {
  const p = usePortal();
  const readPeriod = p.period;

  const fact = useMemo(
    () => (readPeriod ? narrativeFact(p.ds, p.clientId, readPeriod) : null),
    [p.ds, p.clientId, readPeriod],
  );
  const points = useMemo(
    () => (readPeriod && p.hasBooks ? monthlyNarrative(p.ds, p.clientId, readPeriod) : []),
    [p.ds, p.clientId, readPeriod, p.hasBooks],
  );

  if (!p.can("narrative")) {
    return (
      <>
        <PortalHero
          title="The read on your month"
          subtitle="A short written note on what happened, from the person who closed your books."
          tier={p.tier}
          testId="hero-portal-narrative"
        />
        {fact ? <LockedFeature feature="narrative" fact={fact} currentTier={p.tier} /> : null}
      </>
    );
  }

  const flagged = points.filter((pt) => pt.tone === "watch" || pt.tone === "risk");

  return (
    <>
      <PortalHero
        title="The read on your month"
        subtitle={
          readPeriod
            ? `${fmtPeriod(readPeriod)} for ${p.client.dba}, written from the closed numbers. Every point names the figure behind it.`
            : `Written notes for ${p.client.dba}.`
        }
        tier={p.tier}
        meta={
          <>
            <ClosePill close={p.close} />
            {flagged.length > 0 ? <Pill tone="watch">{flagged.length} to watch</Pill> : null}
          </>
        }
        testId="hero-portal-narrative"
      />

      {points.length === 0 || !readPeriod ? (
        <SectionCard title="Narrative" testId="card-portal-narrative-empty">
          <EmptyState
            title="No month written up yet"
            body="The narrative is written after a close. Once a month is closed and reviewed, the write up shows here with the numbers behind each point."
          />
        </SectionCard>
      ) : (
        <>
          <SectionCard
            title={`What we saw in ${fmtPeriod(readPeriod)}`}
            description={`${points.length} notes, written by the person who closed the month.`}
            testId="card-portal-narrative"
          >
            <ol className="divide-y divide-border">
              {points.map((pt, i) => (
                <li key={pt.heading} className="flex gap-3 p-4" data-testid={`narrative-point-${i}`}>
                  <div className="mt-1.5 shrink-0">
                    <ToneDot tone={pt.tone} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{pt.heading}</p>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{pt.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </SectionCard>

          <PortalNote testId="note-portal-narrative-basis">
            These notes come from the closed {fmtPeriod(readPeriod)} statements. If a point does not match what you saw in the business,
            reply in messages and we will look at the entry behind it.
          </PortalNote>
        </>
      )}
    </>
  );
}
