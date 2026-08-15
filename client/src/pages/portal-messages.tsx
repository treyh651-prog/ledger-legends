import { useState } from "react";
import { Mail, MessageSquare, Phone, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { fmtTimestamp } from "@/lib/money";

const ICON = { Email: Mail, "Portal message": MessageSquare, Call: Phone };

const STARTERS = [
  "Can you explain a charge on the card statement?",
  "I need a copy of last month's statements for the bank.",
  "We are hiring next month, what do you need from me?",
];

export default function PortalMessages() {
  const { ds, activeClient, activeClientId, addMessage } = useApp();
  const { toast } = useToast();
  const contact = activeClient.contacts[0];
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const thread = ds.comms.filter((c) => c.clientId === activeClientId).sort((a, b) => (a.at < b.at ? 1 : -1));

  const send = () => {
    addMessage(activeClientId, contact?.name || "Client contact", subject, body, "Inbound");
    toast({ title: "Message sent", description: `${activeClient.lead} gets it right away.` });
    setSubject("");
    setBody("");
  };

  return (
    <>
      <PageHeader
        title="Messages"
        subtitle={`Talk to ${activeClient.lead} here instead of email, so the history stays with your file and nothing gets lost in an inbox.`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Messages in the thread" value={thread.length} testId="kpi-pm-count" />
        <Kpi label="From your accountant" value={thread.filter((c) => c.direction === "Outbound").length} testId="kpi-pm-from-firm" />
        <Kpi label="From your team" value={thread.filter((c) => c.direction === "Inbound").length} testId="kpi-pm-from-client" />
        <Kpi label="Your accountant" value={activeClient.lead} hint="Replies inside one business day" testId="kpi-pm-lead" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <SectionCard title="Conversation" bodyClassName="p-0" testId="card-pm-thread">
          {thread.length ? (
            <ul className="divide-y divide-border">
              {thread.map((c) => {
                const Icon = ICON[c.channel];
                const mine = c.direction === "Inbound";
                return (
                  <li key={c.id} className={`px-4 py-3 ${mine ? "bg-muted/30" : ""}`} data-testid={`pm-${c.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-accent">
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <p className="min-w-0 flex-1 truncate text-sm font-medium">{c.subject}</p>
                      <Pill tone={mine ? "neutral" : "info"}>{mine ? "You" : "Ledger Legends"}</Pill>
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{c.body}</p>
                    <p className="tnum mt-1.5 text-xs text-muted-foreground">
                      {c.who}, {fmtTimestamp(c.at)}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title="No messages yet" body="Start the conversation with a question and your accountant will pick it up." />
          )}
        </SectionCard>

        <SectionCard title="Write a message" testId="card-pm-compose">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Subject</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Question about the card statement" data-testid="input-pm-subject" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Message</Label>
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} data-testid="input-pm-body" />
            </div>
            <Button className="w-full" disabled={!subject.trim() || !body.trim()} onClick={send} data-testid="button-pm-send">
              <Send className="mr-1 h-4 w-4" />
              Send it
            </Button>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Common questions</p>
              <ul className="mt-2 space-y-1.5">
                {STARTERS.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => {
                        setSubject(s.slice(0, 42));
                        setBody(s);
                      }}
                      className="w-full rounded-sm border border-border px-2.5 py-2 text-left text-xs hover-elevate"
                      data-testid={`button-starter-${s.slice(0, 10).replace(/\s+/g, "-")}`}
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </SectionCard>
      </div>
    </>
  );
}
