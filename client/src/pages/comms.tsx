import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorState, Kpi, PageHeader, SectionCard } from "@/components/kit";
import { useActiveClient } from "@/lib/active-client";
import { useFirmMessages, useFirmPostMessage, errorMessage } from "@/api";
import { fmtTimestamp } from "@/lib/money";
import { actionFailureText, type PortalMessage } from "@shared/api";

/**
 * The firm's side of the client thread, read from
 * GET /api/firm/clients/:id/messages, which is ledger.portal_messages. A post
 * goes through PORTAL-POST-MESSAGE on the firm route, preview and apply in
 * one request. No email goes out and the payload says so.
 */
export default function Comms() {
  const { client, clientId } = useActiveClient();
  const q = useFirmMessages(clientId);
  const post = useFirmPostMessage(clientId);
  const [body, setBody] = useState("");
  const [refused, setRefused] = useState<string | null>(null);

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const items = q.data?.items ?? [];
  const last = items.length ? items[items.length - 1] : null;
  const fromClient = items.filter((m) => m.authorScope === "client").length;

  const send = () => {
    setRefused(null);
    post.mutate(
      { body: body.trim() },
      {
        onSuccess: (res) => {
          const text = actionFailureText(res);
          if (text) setRefused(text);
          else setBody("");
        },
      },
    );
  };

  return (
    <div className="space-y-4" data-testid="page-comms">
      <PageHeader title="Communication log" subtitle={`The message thread with ${client?.name ?? "the client"}. The same rows the client sees on the portal.`} />
      <div className="grid grid-cols-3 gap-3">
        <Kpi label="Messages" value={q.data ? items.length : "…"} testId="kpi-comms" />
        <Kpi label="From the client" value={q.data ? fromClient : "…"} testId="kpi-from-client" />
        <Kpi label="Last message" value={q.data ? (last ? fmtTimestamp(last.createdAt) : "None yet") : "…"} testId="kpi-last-contact" />
      </div>
      <div className="grid gap-3 lg:grid-cols-[1fr_360px]">
        <SectionCard title="Thread" description="Oldest first, as the API returns them." bodyClassName="p-0">
          {q.isPending ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">Loading the thread.</p>
          ) : items.length === 0 ? (
            <EmptyState title="No messages" body="Nothing has been written on this client's thread yet. Write the first one on the right." />
          ) : (
            <ul className="divide-y divide-border" data-testid="list-comms">
              {items.map((m) => (
                <MessageRow key={m.id} m={m} />
              ))}
            </ul>
          )}
        </SectionCard>
        <div className="space-y-3">
          <SectionCard title="Write to the client" testId="card-comms-compose">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={4000} placeholder="A question, an answer, or a note the client should see." data-testid="input-comms-body" />
            {refused ? <p className="mt-2 text-xs text-destructive">{refused}</p> : null}
            {post.isError ? <p className="mt-2 text-xs text-destructive">{errorMessage(post.error)}</p> : null}
            <Button className="mt-3" size="sm" onClick={send} disabled={!clientId || body.trim().length === 0 || post.isPending} data-testid="button-comms-send">
              <Send className="mr-1 h-4 w-4" />
              {post.isPending ? "Posting" : "Post to the thread"}
            </Button>
          </SectionCard>
          {q.data && !q.data.emailConfigured ? (
            <p className="text-xs text-muted-foreground" data-testid="note-comms-email">
              Messages stay inside the product. No email or text goes out when one is posted; the client sees it on the portal.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MessageRow({ m }: { m: PortalMessage }) {
  return (
    <li className={`px-4 py-3 ${m.authorScope === "firm" ? "bg-primary/5" : ""}`} data-testid={`comms-message-${m.id}`}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{m.mine ? "You" : m.authorScope === "firm" ? "The firm" : "The client"}</span>
        <span className="tnum">{fmtTimestamp(m.createdAt)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{m.body}</p>
    </li>
  );
}
