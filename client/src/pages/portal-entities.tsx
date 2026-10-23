import { useQueries } from "@tanstack/react-query";
import { EmptyState, Kpi, Pill, SectionCard } from "@/components/kit";
import { PortalNote } from "@/components/portal/portal-kit";
import { PortalScreen } from "@/components/portal/portal-screen";
import { useAuth } from "@/lib/auth";
import { api, portalKeys, usePortalHome } from "@/api";
import { fmtPeriod } from "@/lib/money";
import type { PortalHome } from "@shared/api";

/**
 * Legend feature. The companies the signed in person can see, from the
 * memberships on GET /api/auth/me and each company's GET /api/portal/:id/home.
 * No consolidation run exists in the engine yet, so no combined figures are
 * shown. The screen lists the entities and says that plainly.
 */
export default function PortalEntities() {
  return (
    <PortalScreen title="Your group" subtitle="If you own more than one company, this is where they come together." testId="hero-portal-entities">
      {({ clientId }) => <Body clientId={clientId} />}
    </PortalScreen>
  );
}

function Body({ clientId }: { clientId: string }) {
  const auth = useAuth();
  const home = usePortalHome(clientId);
  const ids = Array.from(
    new Set([clientId, ...(auth.me?.memberships ?? []).filter((m) => m.scope === "client" && m.clientId).map((m) => m.clientId as string)]),
  );
  const homes = useQueries({
    queries: ids.map((id) => ({
      queryKey: portalKeys.home(id),
      queryFn: () => api<PortalHome>("GET", `/api/portal/${id}/home`),
    })),
  });
  const entitled = home.data?.features.includes("consolidation") ?? false;
  if (home.isPending) return null;
  if (!entitled) {
    return (
      <SectionCard title="Group consolidation" testId="card-portal-entities-locked">
        <EmptyState title="Group consolidation is not part of this engagement yet" body="Combining two or more companies into one set of statements is a Legend feature. Your service level is set on your engagement." />
      </SectionCard>
    );
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Companies you can see" value={ids.length} testId="kpi-entities-count" />
        <Kpi label="Combined statements" value="Not yet" tone="neutral" testId="kpi-entities-combined" />
      </div>
      <PortalNote tone="watch" testId="note-entities-consolidation">
        A consolidation run does not exist in the engine yet, so no combined figures are shown here. Each company's own statements are open on its
        statements screen. When the run exists, the combined view appears here with eliminations shown.
      </PortalNote>
      <SectionCard title="Companies" bodyClassName="p-0" testId="card-portal-entities-list">
        <ul className="divide-y divide-border">
          {homes.map((h, i) => (
            <li key={ids[i]} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm" data-testid={`entity-${ids[i]}`}>
              <div className="min-w-0">
                <p className="font-medium">{h.data?.client.name ?? (h.isError ? "Not readable by you" : "Loading")}</p>
                <p className="text-xs text-muted-foreground">
                  {h.data ? `${h.data.tierName}${h.data.latestClosedPeriod ? `, last closed ${fmtPeriod(h.data.latestClosedPeriod.slice(0, 7))}` : ", no closed month yet"}` : ""}
                </p>
              </div>
              {h.data ? <Pill tone={h.data.engagementStatus === "active" ? "good" : "watch"}>{h.data.engagementStatus ?? "no engagement"}</Pill> : null}
            </li>
          ))}
        </ul>
      </SectionCard>
    </>
  );
}
