import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid, EmptyState, ErrorState, Kpi, LoadingRows, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useNarratives, errorMessage } from "@/api";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";

/**
 * The composed narrative for one period, read from
 * GET /api/firm/clients/:id/narratives. RPT-COMPOSE-NARRATIVE writes one per
 * audience from statement triggers; the sentences tab shows which trigger
 * produced each line.
 */
export default function Narrative() {
  const { period } = useApp();
  const { client, clientId } = useActiveClient();
  const q = useNarratives(clientId, period);
  const [audience, setAudience] = useState<"owner" | "lender">("owner");
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const n = d?.items.find((i) => i.audience === audience) ?? null;

  return (
    <div className="space-y-4" data-testid="page-narrative">
      <PageHeader title="Narrative" subtitle={`${client?.name ?? ""}, ${fmtPeriod(period)}. ${n ? `Composed ${fmtTimestamp(n.composedAt)}${n.manualEdit ? ", edited by hand" : ""}.` : d ? "No narrative composed for this period." : ""}`} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Sentences" value={n ? n.sentenceCount : "None"} testId="kpi-sentences" />
        <Kpi label="Dropped to fit" value={n ? n.droppedCount : "None"} />
        <Kpi label="Comparison basis" value={n ? n.comparisonBasis.replace(/_/g, " ") : "None"} />
      </div>
      <Tabs value={audience} onValueChange={(v) => setAudience(v as "owner" | "lender")}>
        <TabsList>
          <TabsTrigger value="owner" data-testid="tab-owner">Owner</TabsTrigger>
          <TabsTrigger value="lender" data-testid="tab-lender">Lender</TabsTrigger>
        </TabsList>
        <TabsContent value={audience} className="mt-4 space-y-4">
          <SectionCard title={`${audience === "owner" ? "Owner" : "Lender"} narrative`} description="The body text as composed.">
            {q.isPending ? (
              <LoadingRows rows={4} cols={1} />
            ) : n ? (
              <p className="whitespace-pre-wrap px-3 py-3 text-sm leading-relaxed" data-testid="text-narrative-body">{n.bodyText}</p>
            ) : (
              <EmptyState title="No narrative" body={`RPT-COMPOSE-NARRATIVE writes the ${audience} narrative once the package for the period exists.`} />
            )}
          </SectionCard>
          {n ? (
            <SectionCard title="Sentences and triggers" description="Each sentence names the statement trigger that produced it.">
              <DataGrid
                rows={n.sentences}
                rowKey={(s, i) => `${s.sectionCode}:${s.triggerCode}:${i}`}
                testId="grid-sentences"
                cols={[
                  { key: "sec", label: "Section", mobile: "row", render: (s) => <Pill tone="info">{s.sectionCode}</Pill> },
                  { key: "trig", label: "Trigger", mobile: "row", render: (s) => <span className="text-xs">{s.triggerCode}</span> },
                  { key: "pri", label: "Priority", align: "right", mobile: "row", render: (s) => <span className="tnum text-xs">{s.priority}</span> },
                  { key: "text", label: "Sentence", mobile: "title", render: (s) => <span>{s.text}</span> },
                ]}
              />
            </SectionCard>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
