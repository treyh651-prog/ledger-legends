import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { DataGrid, EmptyState, ErrorState, Kpi, LoadingRows, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useNarratives, useTriggerRun, errorMessage, periodStartOf } from "@/api";
import { fmtPeriod, fmtTimestamp } from "@/lib/money";

/**
 * RPT-COMPOSE-NARRATIVE. Audit fix (problem 8, found while browser
 * verifying problem 9's own release gate): this screen had no trigger for
 * the run it reads at all, the exact "no UI button" pattern problem 8
 * covers -- a narrative could only ever exist if something else composed
 * it through the API directly.
 */
function ComposeNarrativeDialog({ clientId, period, audience, onComposed }: { clientId: string; period: string; audience: "owner" | "lender"; onComposed: () => void }) {
  const trigger = useTriggerRun(clientId);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const scope = { clientId, period: periodStartOf(period), audience };
    try {
      const preview = await trigger.mutateAsync({ runCode: "RPT-COMPOSE-NARRATIVE", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "completed_with_skips" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({ runCode: "RPT-COMPOSE-NARRATIVE", body: { mode: "apply", scope, previewRunId: preview.executionId } });
        if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      onComposed();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={() => void submit()} disabled={trigger.isPending} data-testid="button-compose-narrative">
        Compose narrative
      </Button>
      {error ? <p className="max-w-[16rem] break-words text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * RPT-RELEASE-NARRATIVE. Audit fix (problem 9): before this run existed, a
 * composed narrative reached the client portal with no firm review gate
 * at all. Shown only for a draft narrative.
 */
function ReleaseNarrativeButton({ clientId, narrativeId, onReleased }: { clientId: string; narrativeId: string; onReleased: () => void }) {
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const scope = { clientId, narrativeId };
    try {
      const preview = await trigger.mutateAsync({ runCode: "RPT-RELEASE-NARRATIVE", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({ runCode: "RPT-RELEASE-NARRATIVE", body: { mode: "apply", scope, previewRunId: preview.executionId } });
        if (applied.status !== "completed") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      void qc.invalidateQueries({ queryKey: ["api", "firm", "clients", clientId, "narratives"] });
      onReleased();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" onClick={() => void submit()} disabled={trigger.isPending} data-testid="button-release-narrative">
        Release to client
      </Button>
      {error ? <p className="max-w-[16rem] break-words text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

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
      <PageHeader
        title="Narrative"
        subtitle={`${client?.name ?? ""}, ${fmtPeriod(period)}. ${n ? `Composed ${fmtTimestamp(n.composedAt)}${n.manualEdit ? ", edited by hand" : ""}.` : d ? "No narrative composed for this period." : ""}`}
        actions={
          clientId ? (
            <div className="flex flex-wrap gap-2">
              {n && n.state === "draft" ? <ReleaseNarrativeButton clientId={clientId} narrativeId={n.id} onReleased={() => void q.refetch()} /> : null}
              <ComposeNarrativeDialog clientId={clientId} period={period} audience={audience} onComposed={() => void q.refetch()} />
            </div>
          ) : null
        }
      />
      <div className="grid gap-3 sm:grid-cols-4">
        <Kpi label="State" value={n ? <Pill tone={n.state === "released" ? "good" : "info"}>{n.state}</Pill> : "None"} testId="kpi-narrative-state" />
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
