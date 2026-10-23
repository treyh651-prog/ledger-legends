import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { EmptyState, ErrorState, LoadingRows, SectionCard } from "@/components/kit";
import { PortalHero } from "@/components/portal/portal-kit";
import { usePortalClient } from "@/lib/use-portal-client";
import { usePortalHome, ApiRequestError, errorMessage } from "@/api";
import { NO_CLIENTS_COPY } from "@/pages/firm-overview";
import type { TierId } from "@shared/tiers";

/**
 * The frame every portal screen past home shares. It resolves the client,
 * shows the hero with the tier the API reports, and hands the screen body a
 * client id. A 403 feature_not_included from the screen's own query is shown
 * as a plain sentence, not a sales page, per doc 08.
 */
export function PortalScreen({
  title,
  subtitle,
  testId,
  actions,
  meta,
  children,
}: {
  title: string;
  subtitle: string | ((clientName: string) => string);
  testId: string;
  actions?: ReactNode;
  meta?: ReactNode;
  children: (ctx: { clientId: string; tier: TierId; clientName: string }) => ReactNode;
}) {
  const sel = usePortalClient();
  const home = usePortalHome(sel.clientId);

  if (sel.loading) return <LoadingRows rows={6} cols={2} />;
  if (sel.error) return <ErrorState message={errorMessage(sel.error)} onRetry={sel.retry} />;
  if (!sel.clientId) {
    return (
      <SectionCard title={title} testId={`${testId}-noclient`}>
        <EmptyState title={NO_CLIENTS_COPY} body="There is no client whose records could be shown." />
      </SectionCard>
    );
  }
  const tier = (home.data?.tier ?? "ledger") as TierId;
  const clientName = home.data?.client.name ?? "your business";
  return (
    <>
      <PortalHero
        title={title}
        subtitle={typeof subtitle === "function" ? subtitle(clientName) : subtitle}
        tier={home.data ? tier : undefined}
        actions={actions}
        meta={meta}
        testId={testId}
      />
      {children({ clientId: sel.clientId, tier, clientName })}
    </>
  );
}

/** Loading, feature gate, error, then the body with data. */
export function QueryBody<T>({
  q,
  title,
  testId,
  children,
}: {
  q: UseQueryResult<T>;
  title: string;
  testId: string;
  children: (data: T) => ReactNode;
}) {
  if (q.isPending) return <LoadingRows rows={6} cols={2} />;
  if (q.isError) {
    if (q.error instanceof ApiRequestError && q.error.code === "feature_not_included") {
      return (
        <SectionCard title={title} testId={`${testId}-locked`}>
          <EmptyState title={`${title} is not part of this engagement yet`} body={q.error.message} />
        </SectionCard>
      );
    }
    return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  }
  return <>{children(q.data)}</>;
}
