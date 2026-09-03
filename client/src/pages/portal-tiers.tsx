import { Check, Lock } from "lucide-react";
import { Pill, SectionCard } from "@/components/kit";
import { IncludedRow, PortalHero, PortalNote, TierBadge } from "@/components/portal/portal-kit";
import { usePortal } from "@/lib/use-portal";
import { FEATURES, TIER_ORDER, TIERS, featuresAtTier, hasFeature, tierRank } from "@/data/entitlement";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/money";

/**
 * Tier comparison. Reachable in every data mode because it describes the service, not
 * the client's numbers. There is no price, no picker, and nothing to buy. The service
 * level lives on the engagement, so changing it is a conversation.
 */
export default function PortalTiers() {
  const p = usePortal();
  const current = p.hasClients ? p.tier : null;

  return (
    <>
      <PortalHero
        title="What each service level includes"
        subtitle="Your portal depth comes bundled with the service level on your engagement. Nothing here is sold separately and there is nothing to check out."
        tier={current || undefined}
        meta={current ? <Pill tone="good">Your level today</Pill> : <Pill tone="neutral">No engagement loaded</Pill>}
        testId="hero-portal-tiers"
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {TIER_ORDER.map((id) => {
          const meta = TIERS[id];
          const isCurrent = current === id;
          const added = featuresAtTier(id);
          return (
            <SectionCard
              key={id}
              className={cn(isCurrent && "border-primary")}
              testId={`card-tier-${id}`}
            >
              <div className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-2">
                  <TierBadge tier={id} />
                  {isCurrent ? (
                    <Pill tone="good">
                      <Check className="h-3 w-3" />
                      Yours
                    </Pill>
                  ) : current && tierRank(id) < tierRank(current) ? (
                    <Pill tone="neutral">Included in yours</Pill>
                  ) : null}
                </div>
                <div>
                  <h2 className="text-lg font-semibold">{meta.name}</h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{meta.tagline}</p>
                </div>
                <div className="space-y-2 border-t border-border pt-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {tierRank(id) === 0 ? "Included" : "Adds"}
                  </p>
                  {added.map((f) => (
                    <div key={f.id} className="space-y-0.5">
                      <IncludedRow label={f.label} included={current ? hasFeature(current, f.id) : false} />
                      <p className="pl-5 text-xs leading-relaxed text-muted-foreground">{f.summary}</p>
                    </div>
                  ))}
                </div>
              </div>
            </SectionCard>
          );
        })}
      </div>

      <SectionCard
        title="Every screen, side by side"
        description="A check means the screen is open at that level. A lock means the true headline number is still shown, only the detail waits."
        testId="card-tier-matrix"
      >
        <ul className="divide-y divide-border sm:hidden">
          {FEATURES.map((f) => (
            <li key={f.id} className="space-y-1.5 p-4" data-testid={`row-tier-mobile-${f.id}`}>
              <p className="text-sm font-medium">{f.label}</p>
              {f.ownRecords ? <p className="text-xs text-muted-foreground">Your own records, never held back</p> : null}
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
                {TIER_ORDER.map((id) => (
                  <span key={id} className="flex items-center gap-1.5 text-xs">
                    {hasFeature(id, f.id) ? (
                      <Check className="h-3 w-3 shrink-0 text-positive" />
                    ) : (
                      <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className={hasFeature(id, f.id) ? "" : "text-muted-foreground"}>{TIERS[id].name}</span>
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>

        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Screen</th>
                {TIER_ORDER.map((id) => (
                  <th key={id} className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {TIERS[id].name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FEATURES.map((f) => (
                <tr key={f.id} className="border-b border-border last:border-0" data-testid={`row-tier-${f.id}`}>
                  <td className="px-3 py-2">
                    <p className="font-medium">{f.label}</p>
                    {f.ownRecords ? <p className="text-xs text-muted-foreground">Your own records, never held back</p> : null}
                  </td>
                  {TIER_ORDER.map((id) => (
                    <td key={id} className="px-3 py-2">
                      <IncludedRow label={hasFeature(id, f.id) ? "Open" : "Headline only"} included={hasFeature(id, f.id)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {p.hasClients ? (
        <SectionCard title="Your service level history" description="Kept with an effective date so a past month reads the way it read then." testId="card-tier-history">
          {p.history.length === 0 ? (
            <div className="p-4">
              <p className="text-sm text-muted-foreground">
                No grant is recorded for this engagement, so the base level applies until one is written.
              </p>
            </div>
          ) : (
            <ol className="divide-y divide-border">
              {p.history.map((g) => (
                <li key={g.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid={`history-${g.id}`}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <TierBadge tier={g.tierId} />
                      <span className="text-sm font-medium">
                        {fmtDate(g.effectiveFrom)}
                        {g.effectiveTo ? " to " + fmtDate(g.effectiveTo) : " to today"}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{g.reason}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">Set by {g.setBy}</span>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      ) : null}

      <PortalNote testId="note-tier-no-payment">
        There is no payment screen in this product and there never will be. Your service level is part of the engagement you signed, so if
        you want a different one, send us a message and we will change the engagement.
      </PortalNote>
    </>
  );
}
