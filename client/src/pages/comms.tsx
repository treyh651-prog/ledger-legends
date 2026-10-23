import { EmptyState, ErrorState, Kpi, PageHeader, SectionCard } from "@/components/kit";
import { useActiveClient } from "@/lib/active-client";
import { useFirmMessages, errorMessage, ApiRequestError } from "@/api";

/**
 * The communication log, read from GET /api/firm/clients/:id/messages. Mail is
 * not configured in this deployment, so the API answers 501 not_configured and
 * this screen shows that message. Nothing is logged from the browser; a sent
 * message would be a run once the mail integration exists.
 */
export default function Comms() {
  const { client, clientId } = useActiveClient();
  const q = useFirmMessages(clientId);
  const notConfigured = q.error instanceof ApiRequestError && q.error.code === "not_configured";

  if (q.isError && !notConfigured) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const count = q.data ? q.data.items.length : null;
  return (
    <div className="space-y-4" data-testid="page-comms">
      <PageHeader title="Communication log" subtitle={`Every email, portal message, and call with ${client?.name ?? "the client"} in one thread, once mail is connected.`} />
      <div className="grid grid-cols-2 gap-3">
        <Kpi label="Entries logged" value={count === null ? "Not configured" : count} testId="kpi-comms" />
        <Kpi label="Last contact" value="Not configured" testId="kpi-last-contact" />
      </div>
      <SectionCard title="Thread" description="Messages appear here as the API returns them.">
        {notConfigured ? (
          <EmptyState title="Messages are not set up yet" body={errorMessage(q.error)} />
        ) : count === 0 ? (
          <EmptyState title="No messages" body="Nothing has been sent or received for this client." />
        ) : (
          <p className="px-3 py-3 text-sm text-muted-foreground" data-testid="text-comms-count">{count ?? 0} entries on file.</p>
        )}
      </SectionCard>
    </div>
  );
}
