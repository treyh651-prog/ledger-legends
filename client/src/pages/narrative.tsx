import { useMemo, useState } from "react";
import { Copy, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Kpi, PageHeader, Pill, SectionCard, ToneDot } from "@/components/kit";
import { useApp } from "@/store";
import { monthlyNarrative } from "@/data/derive";
import { fmtPeriod } from "@/lib/money";

export default function Narrative() {
  const { ds, activeClient, activeClientId, period, addMessage } = useApp();
  const { toast } = useToast();
  const points = useMemo(() => monthlyNarrative(ds, activeClientId, period), [ds, activeClientId, period]);
  const [tone, setTone] = useState<"plain" | "brief">("plain");

  const opener =
    tone === "plain"
      ? `Here is how ${fmtPeriod(period)} came together for ${activeClient.dba}.`
      : `${activeClient.dba}, ${fmtPeriod(period)} summary.`;

  const composed = useMemo(() => {
    const body = points
      .map((p) => (tone === "plain" ? `${p.heading}. ${p.body}` : `${p.heading}: ${p.body}`))
      .join("\n\n");
    return `${opener}\n\n${body}\n\nIf anything looks off, reply here and we will walk through it together.`;
  }, [points, tone, opener]);

  const [draft, setDraft] = useState(composed);
  const [dirty, setDirty] = useState(false);
  const text = dirty ? draft : composed;

  return (
    <>
      <PageHeader
        title="Monthly narrative"
        subtitle={`Plain language commentary built from the closed numbers for ${fmtPeriod(period)}. Every figure below is pulled from the ledger, not typed in by hand.`}
        actions={
          <>
            <div className="flex rounded-sm border border-border bg-muted p-0.5">
              {([
                ["plain", "Conversational"],
                ["brief", "Short form"],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setTone(k);
                    setDirty(false);
                  }}
                  className={`rounded-sm px-2.5 py-1 text-xs transition-colors ${tone === k ? "bg-card font-medium" : "text-muted-foreground"}`}
                  data-testid={`button-tone-${k}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDirty(false);
                setDraft(composed);
                toast({ title: "Rebuilt from the ledger", description: "Any manual edits were dropped." });
              }}
              data-testid="button-rebuild"
            >
              <RefreshCw className="mr-1 h-4 w-4" />
              Rebuild
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Sections" value={points.length} testId="kpi-sections" />
        <Kpi label="Items flagged" value={points.filter((p) => p.tone === "risk" || p.tone === "watch").length} tone="watch" testId="kpi-flagged" />
        <Kpi label="Period" value={fmtPeriod(period)} testId="kpi-narr-period" />
        <Kpi label="Words in the draft" value={text.trim().split(/\s+/).length} testId="kpi-words" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="What the numbers say" description="Each section is generated from the closed ledger for this client." bodyClassName="p-0" testId="card-points">
          <ul className="divide-y divide-border">
            {points.map((p) => (
              <li key={p.heading} className="px-4 py-3" data-testid={`point-${p.heading.replace(/\s+/g, "-").toLowerCase()}`}>
                <div className="flex items-center gap-2">
                  <ToneDot tone={p.tone} />
                  <p className="text-sm font-semibold">{p.heading}</p>
                  {p.tone === "risk" ? <Pill tone="risk">Needs attention</Pill> : p.tone === "watch" ? <Pill tone="watch">Keep an eye on it</Pill> : null}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard
          title="Draft to send"
          description="Edit anything you like. Nothing goes out until you send it."
          actions={
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => {
                if (navigator.clipboard) navigator.clipboard.writeText(text);
                toast({ title: "Copied", description: "The draft is on your clipboard." });
              }}
              data-testid="button-copy"
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
              Copy
            </Button>
          }
          testId="card-draft"
        >
          <Textarea
            value={text}
            rows={18}
            className="resize-none font-normal leading-relaxed"
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
            }}
            data-testid="input-narrative"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              onClick={() => {
                addMessage(activeClientId, "Trey Hernandez", `${fmtPeriod(period)} financial summary`, text, "Outbound");
                toast({ title: "Sent to the portal", description: `${activeClient.shortName} can read it alongside the statements.` });
              }}
              data-testid="button-send-narrative"
            >
              <Send className="mr-1 h-4 w-4" />
              Send with the statements
            </Button>
            {dirty ? <span className="text-xs text-muted-foreground">Edited by hand, rebuild to go back to the generated version.</span> : null}
          </div>
        </SectionCard>
      </div>
    </>
  );
}
