import { useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useActiveClient } from "@/lib/active-client";
import { useApproveStagedBatch, useRejectStagedBatch, useStagedBatches, errorMessage } from "@/api";
import { fmtShortDate, fmtTimestamp } from "@/lib/money";
import type { StagedBatch } from "@shared/api";

/**
 * Staged statements, read from GET /api/firm/clients/:id/staged-batches. One
 * row per import batch still waiting on a decision (status parsed or
 * in_review), which is every statement IMPORT-PARSE-FEED has read, whether a
 * person uploaded it directly or it arrived through the automatic upload
 * path. Approve commits it and runs the coding cascade; reject throws it out.
 * Neither write happens from this screen directly, both go through
 * POST /staged-batches/:id/approve and /reject, run framework all the way.
 */
export default function StagedStatements() {
  const { client, clientId } = useActiveClient();
  const q = useStagedBatches(clientId);
  const approve = useApproveStagedBatch();
  const reject = useRejectStagedBatch();
  const [reasonByBatch, setReasonByBatch] = useState<Record<string, string>>({});
  const [noteByBatch, setNoteByBatch] = useState<Record<string, { tone: "good" | "risk"; text: string }>>({});

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const items = d?.items ?? [];

  const onApprove = async (batch: StagedBatch) => {
    setNoteByBatch((prev) => ({ ...prev, [batch.id]: { tone: "good", text: "Approving" } }));
    try {
      const r = await approve.mutateAsync({ clientId: clientId ?? "", batchId: batch.id });
      setNoteByBatch((prev) => ({
        ...prev,
        [batch.id]: r.done
          ? { tone: "good", text: "Committed and coded." }
          : { tone: "risk", text: "The commit did not go through. Nothing was posted." },
      }));
    } catch (e) {
      setNoteByBatch((prev) => ({ ...prev, [batch.id]: { tone: "risk", text: errorMessage(e) } }));
    }
  };

  const onReject = async (batch: StagedBatch) => {
    const reason = (reasonByBatch[batch.id] ?? "").trim();
    if (!reason) {
      setNoteByBatch((prev) => ({ ...prev, [batch.id]: { tone: "risk", text: "Say why before rejecting it." } }));
      return;
    }
    try {
      const r = await reject.mutateAsync({ clientId: clientId ?? "", batchId: batch.id, reason });
      setNoteByBatch((prev) => ({
        ...prev,
        [batch.id]: r.done ? { tone: "good", text: "Rejected." } : { tone: "risk", text: "The rejection did not go through." },
      }));
    } catch (e) {
      setNoteByBatch((prev) => ({ ...prev, [batch.id]: { tone: "risk", text: errorMessage(e) } }));
    }
  };

  return (
    <div className="space-y-4" data-testid="page-staged-statements">
      <PageHeader
        title="Staged statements"
        subtitle={`${client?.name ?? ""}. ${items.length} ${items.length === 1 ? "statement" : "statements"} waiting on a decision.`}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Kpi label="Waiting" value={items.length} tone={items.length ? "watch" : "good"} testId="kpi-staged-waiting" />
        <Kpi label="Needs mapping" value={items.filter((b) => b.mappingError !== null).length} tone="risk" testId="kpi-staged-mapping" />
        <Kpi label="Duplicates held" value={items.reduce((sum, b) => sum + b.duplicatesHeld, 0)} testId="kpi-staged-held" />
      </div>

      <SectionCard title="Imported, not yet on the books" description="Each row is one statement. Approve commits it and codes it; reject throws it out.">
        <DataGrid<StagedBatch>
          rows={items}
          loading={q.isPending}
          rowKey={(b) => b.id}
          testId="grid-staged-batches"
          empty={<EmptyState title="Nothing waiting" body="A statement uploaded with an account named lands here once it parses." />}
          cols={[
            { key: "acct", label: "Account", mobile: "title", render: (b) => <span className="font-medium">{b.bankAccountName}</span> },
            {
              key: "period",
              label: "Period",
              mobile: "row",
              render: (b) => (
                <span className="tnum text-xs">
                  {b.periodStart ? fmtShortDate(b.periodStart) : "?"} to {b.periodEnd ? fmtShortDate(b.periodEnd) : "?"}
                </span>
              ),
            },
            { key: "lines", label: "Lines", align: "right", mobile: "row", render: (b) => <span className="tnum text-xs">{b.lineCount}</span> },
            {
              key: "held",
              label: "Held / rejected",
              align: "right",
              mobile: "row",
              render: (b) => <span className="tnum text-xs">{b.duplicatesHeld} / {b.rejectedCount}</span>,
            },
            { key: "net", label: "Net", align: "right", mobile: "row", render: (b) => <Money cents={b.netCents} signed dim /> },
            { key: "uploaded", label: "Uploaded", mobile: "row", render: (b) => <span className="text-xs">{fmtTimestamp(b.createdAt)}</span> },
            {
              key: "status",
              label: "Status",
              mobile: "value",
              render: (b) =>
                b.mappingError ? (
                  <span title={b.mappingError}>
                    <Pill tone="risk">Needs mapping</Pill>
                  </span>
                ) : (
                  <Pill tone={b.status === "in_review" ? "watch" : "good"}>{b.status.replace(/_/g, " ")}</Pill>
                ),
            },
            {
              key: "actions",
              label: "",
              mobile: "row",
              render: (b) => (
                <div className="flex flex-col items-end gap-1.5" data-testid={`staged-batch-actions-${b.id}`}>
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      disabled={approve.isPending || !!b.mappingError}
                      title={b.mappingError ? "Map this account's statement layout before approving it" : undefined}
                      onClick={() => void onApprove(b)}
                      data-testid={`approve-${b.id}`}
                    >
                      <Check className="mr-1 h-3.5 w-3.5" /> Approve
                    </Button>
                    <Input
                      className="h-8 w-40 text-xs"
                      placeholder="Why reject"
                      value={reasonByBatch[b.id] ?? ""}
                      onChange={(e) => setReasonByBatch((prev) => ({ ...prev, [b.id]: e.target.value }))}
                      data-testid={`reject-reason-${b.id}`}
                    />
                    <Button size="sm" variant="outline" disabled={reject.isPending} onClick={() => void onReject(b)} data-testid={`reject-${b.id}`}>
                      <X className="mr-1 h-3.5 w-3.5" /> Reject
                    </Button>
                  </div>
                  {noteByBatch[b.id] ? (
                    <p className={`text-xs ${noteByBatch[b.id].tone === "good" ? "text-emerald-700" : "text-destructive"}`} data-testid={`note-${b.id}`}>
                      {noteByBatch[b.id].text}
                    </p>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      </SectionCard>
    </div>
  );
}
