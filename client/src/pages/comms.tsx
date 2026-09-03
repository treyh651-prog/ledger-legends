import { useState } from "react";
import { Mail, MessageSquare, Phone, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { fmtTimestamp } from "@/lib/money";

const ICON = { Email: Mail, "Portal message": MessageSquare, Call: Phone };

export default function Comms() {
  const { ds, activeClient, activeClientId, addMessage } = useApp();
  const { toast } = useToast();
  const [channel, setChannel] = useState("all");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const entries = ds.comms
    .filter((c) => c.clientId === activeClientId)
    .filter((c) => (channel === "all" ? true : c.channel === channel))
    .sort((a, b) => (a.at < b.at ? 1 : -1));

  const all = ds.comms.filter((c) => c.clientId === activeClientId);
  const openItemTitle = (id?: string) => {
    if (!id) return null;
    const item = ds.openItems.find((o) => o.id === id);
    if (item) return item.title;
    const sub = ds.substantiations.find((s) => s.id === id);
    return sub ? sub.supportType : null;
  };

  return (
    <>
      <PageHeader
        title="Communication log"
        subtitle={`Every email, portal message, and call with ${activeClient.dba} in one thread, so nobody has to dig through an inbox to find what was promised.`}
        actions={
          <Select value={channel} onValueChange={setChannel}>
            <SelectTrigger className="h-8 w-[170px] text-xs" data-testid="select-channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Every channel</SelectItem>
              <SelectItem value="Email">Email</SelectItem>
              <SelectItem value="Portal message">Portal message</SelectItem>
              <SelectItem value="Call">Call</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Entries logged" value={all.length} testId="kpi-comms" />
        <Kpi label="From the client" value={all.filter((c) => c.direction === "Inbound").length} testId="kpi-inbound" />
        <Kpi label="From the firm" value={all.filter((c) => c.direction === "Outbound").length} testId="kpi-outbound" />
        <Kpi label="Last contact" value={all.length ? fmtTimestamp(all.map((c) => c.at).sort().slice(-1)[0]) : "None"} testId="kpi-last-contact" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <SectionCard title="Thread" bodyClassName="p-0" testId="card-thread">
          {entries.length ? (
            <ul className="divide-y divide-border">
              {entries.map((c) => {
                const Icon = ICON[c.channel];
                const linked = openItemTitle(c.linkedItemId);
                return (
                  <li key={c.id} className="px-4 py-3" data-testid={`comm-${c.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-accent">
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <p className="min-w-0 flex-1 truncate text-sm font-medium">{c.subject}</p>
                      <Pill tone={c.direction === "Inbound" ? "info" : "neutral"}>{c.direction}</Pill>
                    </div>
                    <p className="mt-1.5 text-sm text-muted-foreground">{c.body}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{c.who}</span>
                      <span aria-hidden>·</span>
                      <span className="tnum">{fmtTimestamp(c.at)}</span>
                      <span aria-hidden>·</span>
                      <span>{c.channel}</span>
                      {linked ? (
                        <>
                          <span aria-hidden>·</span>
                          <Pill tone="watch">Linked to {linked}</Pill>
                        </>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title="Nothing on this channel" body="Switch the filter to see the rest of the thread." />
          )}
        </SectionCard>

        <SectionCard title="Send a message" description="It lands in the client portal inbox right away.">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Subject</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="July statements are ready" data-testid="input-subject" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Message</Label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                placeholder="Here is what we finished this month and the two items we still need from you."
                data-testid="input-body"
              />
            </div>
            <Button
              className="w-full"
              disabled={!subject.trim() || !body.trim()}
              onClick={() => {
                addMessage(activeClientId, "Jose Hernandez", subject, body, "Outbound");
                toast({ title: "Message sent", description: `${activeClient.shortName} sees it in the portal inbox.` });
                setSubject("");
                setBody("");
              }}
              data-testid="button-send-message"
            >
              <Send className="mr-1 h-4 w-4" />
              Send to the client
            </Button>
            <p className="text-xs text-muted-foreground">
              Messages stay attached to the client record, so a handoff to another accountant does not lose the history.
            </p>
          </div>
        </SectionCard>
      </div>
    </>
  );
}
