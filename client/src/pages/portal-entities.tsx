import { useQueries } from "@tanstack/react-query";
import { DataGrid, EmptyState, Kpi, Money, Pill, SectionCard } from "@/components/kit";
import { PortalNote } from "@/components/portal/portal-kit";
import { PortalScreen } from "@/components/portal/portal-screen";
import { useAuth } from "@/lib/auth";
import { api, portalKeys, usePortalHome, usePortalEntityGroup } from "@/api";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";
import type { PortalHome } from "@shared/api";

/**
 * Legend feature. The companies the signed in person can see, from the
 * memberships on GET /api/auth/me and each company's GET /api/portal/:id/home,
 * stay as the fallback list below -- that membership-derived set is not the
 * same thing as a firm-defined group (client/src/pages/entity-groups.tsx),
 * and a person can see several companies without any of them being grouped.
 * GET /api/portal/:id/entity-group answers whether this client's own
 * company is in a firm-defined group and, if so, its latest consolidated
 * package; row level security (migration 0061's member_can_read /
 * has_group_access policies), not this screen, is what stops that answer
 * from leaking a sibling entity's figures this person cannot otherwise see.
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
  const period = new Date().toISOString().slice(0, 7) + "-01";
  const group = usePortalEntityGroup(clientId, period);
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
  const pkg = group.data?.packages?.packages.find((p) => p.id === group.data?.packages?.selectedPackageId) ?? null;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Companies you can see" value={ids.length} testId="kpi-entities-count" />
        <Kpi
          label="Combined statements"
          value={pkg ? <Pill tone="good">Built</Pill> : group.data?.group ? "Not built yet" : "No group"}
          tone="neutral"
          testId="kpi-entities-combined"
        />
      </div>
      {group.data?.group === null || group.data?.group === undefined ? (
        <PortalNote tone="watch" testId="note-entities-consolidation">
          Your company is not part of a firm-defined group yet, so no combined figures are shown here. Each company's own statements are open on
          its own statements screen. Ask your firm to set up a group if you'd like a combined view.
        </PortalNote>
      ) : !pkg ? (
        <PortalNote tone="watch" testId="note-entities-no-package">
          Your group, {group.data.group.name}, has not had a consolidated package built for {fmtPeriod(period)} yet.
        </PortalNote>
      ) : (
        <>
          {pkg.exceptionBanner ? <div className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm">{pkg.exceptionBanner}</div> : null}
          <SectionCard
            title={`${group.data.group.name}, ${fmtPeriod(period)}`}
            description={`${pkg.memberCount} entities combined, built ${fmtTimestamp(pkg.builtAt)}.`}
            bodyClassName="p-0"
            testId="card-consolidated-package"
          >
            <DataGrid
              rows={group.data.packages?.sections.flatMap((s) => s.lines.map((l, i) => ({ ...l, sectionTitle: s.sectionTitle, key: `${s.id}:${i}` }))) ?? []}
              rowKey={(l) => l.key}
              testId="grid-consolidated-package"
              empty={<EmptyState title="No lines" body="This package rendered without lines." />}
              cols={[
                { key: "section", label: "Section", mobile: "title", render: (l) => <span className="text-xs text-muted-foreground">{l.sectionTitle}</span> },
                { key: "label", label: "Line", mobile: "row", render: (l) => <span className={l.accountNumber ? "pl-4" : "font-semibold"}>{l.accountNumber ? `${l.accountNumber} ` : ""}{l.label}</span> },
                { key: "amt", label: "Amount", align: "right", mobile: "value", render: (l) => <Money cents={l.amountCents} signed /> },
              ]}
            />
          </SectionCard>
        </>
      )}
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
