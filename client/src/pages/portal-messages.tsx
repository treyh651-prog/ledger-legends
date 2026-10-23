import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, SectionCard } from "@/components/kit";
import { PortalNote } from "@/components/portal/portal-kit";
import { PortalScreen, QueryBody } from "@/components/portal/portal-screen";
import { usePortalMessages, usePostMessage, errorMessage } from "@/api";
import { fmtTimestamp } from "@/lib/money";
import { actionFailureText, type PortalMessage } from "@shared/api";

/**
 * The thread between the client and the firm, GET and POST
 * /api/portal/:clientId/messages. Every message is a PORTAL-POST-MESSAGE run.
 * No email goes out, and the payload says so with emailConfigured false.
 */
export default function PortalMessages() {
  return (
    <PortalScreen
      title="Messages"
      subtitle="Talk to the people doing your books here, so the history stays with your file and nothing gets lost in an inbox."
      testId="hero-portal-messages"
    >
      {({ clientId }) => <Body clientId={clientId} />}
    </PortalScreen>
  );
}

function Body({ clientId }: { clientId: string }) {
  const q = usePortalMessages(clientId);
  const post = usePostMessage(clientId);
  const [body, setBody] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const send = () => {
    setRefused(null);
    post.mutate(
      { body },
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
    <QueryBody q={q} title="Messages" testId="card-portal-messages">
      {(data) => (
        <div className="grid gap-3 lg:grid-cols-[1fr_360px]">
          <SectionCard title="Your thread" testId="card-portal-thread" bodyClassName="p-0">
            {data.items.length === 0 ? (
              <EmptyState title="No messages yet" body="Write the first one on the right. Your accountant sees it the next time they open your file." />
            ) : (
              <ul className="divide-y divide-border">
                {data.items.map((m) => (
                  <MessageRow key={m.id} m={m} />
                ))}
              </ul>
            )}
          </SectionCard>
          <div className="space-y-3">
            <SectionCard title="Write a message" testId="card-portal-compose">
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                maxLength={4000}
                placeholder="Ask about a charge, a statement, or anything on your books."
                data-testid="input-message-body"
              />
              {refused ? <p className="mt-2 text-xs text-destructive">{refused}</p> : null}
              {post.isError ? <p className="mt-2 text-xs text-destructive">{errorMessage(post.error)}</p> : null}
              <Button className="mt-3" size="sm" onClick={send} disabled={body.trim().length === 0 || post.isPending} data-testid="button-message-send">
                <Send className="mr-1 h-4 w-4" />
                {post.isPending ? "Sending" : "Send"}
              </Button>
            </SectionCard>
            {!data.emailConfigured ? (
              <PortalNote testId="note-messages-email">
                Messages stay inside this product. No email or text goes out when you send one, so for anything urgent reach your
                accountant the way you usually do.
              </PortalNote>
            ) : null}
          </div>
        </div>
      )}
    </QueryBody>
  );
}

function MessageRow({ m }: { m: PortalMessage }) {
  return (
    <li className={`px-4 py-3 ${m.mine ? "bg-primary/5" : ""}`} data-testid={`message-${m.id}`}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{m.mine ? "You" : m.authorScope === "firm" ? "Your accountant" : "Your team"}</span>
        <span className="tnum">{fmtTimestamp(m.createdAt)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{m.body}</p>
    </li>
  );
}
