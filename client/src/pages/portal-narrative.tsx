import { EmptyState, Pill, SectionCard } from "@/components/kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalNarrative } from "@/api";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";

/**
 * Legend feature. The written read on each month, from
 * GET /api/portal/:clientId/narrative. The text is the engine's composed
 * narrative row, shown as stored. No month is written here in the browser.
 */
export default function PortalNarrative() {
  return (
    <PortalScreen title="Period narrative" subtitle="A written read on the month, composed from your closed books." testId="hero-portal-narrative">
      {({ clientId }) => <Body clientId={clientId} />}
    </PortalScreen>
  );
}

function Body({ clientId }: { clientId: string }) {
  const q = usePortalNarrative(clientId);
  return (
    <QueryBody q={q} title="Period narrative" testId="card-portal-narrative">
      {(data) =>
        data.items.length === 0 ? (
          <SectionCard title="Narrative" testId="card-portal-narrative-empty">
            <EmptyState title="No narrative has been composed yet" body="The narrative is written after a month closes. There is none on your books yet." />
          </SectionCard>
        ) : (
          <div className="space-y-3">
            {data.items.map((n) => (
              <SectionCard key={n.id} title={fmtPeriod(n.periodStart.slice(0, 7))} testId={`card-narrative-${n.id}`}>
                <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Pill tone="neutral">{n.audience === "lender" ? "For a lender" : "For the owner"}</Pill>
                  <span>
                    {n.sentenceCount} sentences, composed {fmtTimestamp(n.composedAt)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{n.bodyText}</p>
              </SectionCard>
            ))}
          </div>
        )
      }
    </QueryBody>
  );
}
