import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useReconcile, errorMessage } from "@/api";
import { fmtPeriod, fmtShortDate, fmtTimestamp } from "@/lib/money";
import type { RecBatch, RecLine } from "@shared/api";

/**
 * Bank reconciliation, read from GET /api/firm/clients/:id/reconcile. A batch
 * is a statement under reconciliation (ledger.rec_batches); its lines carry
 * the match the REC runs wrote. Matching is a run, so this screen offers no
 * hand matching button: that would be a write outside the engine.
 */
export default function Reconcile() {
  const { period } = useApp();
  const { client, clientId } = useActiveClient();
  const [batchId, setBatchId] = useState<string | null>(null);
  const q = useReconcile(clientId, period, batchId);
  const d = q.data;

  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const selected = d?.batches.find((b) => b.id === d.selectedBatchId) ?? null;
  const tone = (b: RecBatch) => (b.state === "reconciled" ? "good" : b.state === "out_of_balance" ? "risk" : "watch");

  return (
    <div className="space-y-4" data-testid="page-reconcile">
      <PageHeader
        title="Reconcile"
        subtitle={`${client?.name ?? ""}, ${fmtPeriod(period)}. ${d ? `${d.batches.length} ${d.batches.length === 1 ? "statement" : "statements"} in the period across ${d.bankAccounts.length} ${d.bankAccounts.length === 1 ? "account" : "accounts"}.` : ""}`}
        actions={
          d && d.batches.length > 0 ? (
            <Select value={d.selectedBatchId ?? ""} onValueChange={setBatchId}>
              <SelectTrigger className="w-64" data-testid="select-rec-batch">
                <SelectValue placeholder="Statement" />
              </SelectTrigger>
              <SelectContent>
                {d.batches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.bankAccountName}, {fmtShortDate(b.statementPeriod)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Statement balance" value={selected ? <Money cents={selected.statementBalanceCents} /> : "None"} />
        <Kpi
          label="Cleared ledger balance"
          value={selected ? selected.clearedLedgerBalanceCents === null ? "Not computed" : <Money cents={selected.clearedLedgerBalanceCents} /> : "None"}
        />
        <Kpi
          label="Difference"
          value={selected ? selected.diffCents === null ? "Not computed" : <Money cents={selected.diffCents} signed /> : "None"}
          tone={selected && selected.diffCents !== null ? (selected.diffCents === 0 ? "good" : "risk") : "neutral"}
          testId="kpi-rec-diff"
        />
        <Kpi label="Lines matched" value={selected ? `${selected.matchedCount} of ${selected.lineCount}` : "None"} />
      </div>

      <SectionCard title="Statements in the period" description="One batch per statement, from ledger.rec_batches.">
        <DataGrid<RecBatch>
          rows={d?.batches ?? []}
          loading={q.isPending}
          rowKey={(b) => b.id}
          testId="grid-rec-batches"
          onRowClick={(b) => setBatchId(b.id)}
          rowClassName={(b) => (b.id === d?.selectedBatchId ? "bg-muted/60" : "")}
          empty={<EmptyState title="No statements in this period" body="A statement import opens a batch through REC-MATCH-TIERED." />}
          cols={[
            { key: "acct", label: "Account", mobile: "title", render: (b) => <span className="font-medium">{b.bankAccountName}</span> },
            { key: "period", label: "Statement", mobile: "row", render: (b) => <span className="tnum text-xs">{fmtShortDate(b.statementPeriod)}</span> },
            { key: "bal", label: "Balance", align: "right", mobile: "row", render: (b) => <Money cents={b.statementBalanceCents} dim /> },
            { key: "diff", label: "Difference", align: "right", mobile: "row", render: (b) => (b.diffCents === null ? <span className="text-xs text-muted-foreground">Open</span> : <Money cents={b.diffCents} signed />) },
            { key: "opened", label: "Opened", mobile: "row", render: (b) => <span className="text-xs">{fmtTimestamp(b.openedAt)}</span> },
            { key: "state", label: "State", mobile: "value", render: (b) => <Pill tone={tone(b)}>{b.state.replace(/_/g, " ")}</Pill> },
          ]}
        />
      </SectionCard>

      <SectionCard title="Statement lines" description={selected ? `${selected.bankAccountName}, ${selected.lineCount} lines with the match each REC run wrote.` : "Pick a statement above."}>
        <DataGrid<RecLine>
          rows={d?.lines ?? []}
          loading={q.isPending}
          rowKey={(l) => l.id}
          testId="grid-rec-lines"
          rowClassName={(l) => (l.matchedTransactionId ? "" : "bg-warning-soft/40")}
          empty={<EmptyState title="No lines" body="The selected statement has no imported lines." />}
          cols={[
            { key: "date", label: "Date", mobile: "row", render: (l) => <span className="tnum text-xs">{fmtShortDate(l.statementDate)}</span> },
            { key: "desc", label: "Description", mobile: "title", render: (l) => <span>{l.description}{l.checkNumber ? ` (check ${l.checkNumber})` : ""}</span> },
            { key: "amt", label: "Amount", align: "right", mobile: "value", render: (l) => <Money cents={l.amountCents} signed /> },
            { key: "tier", label: "Tier", align: "right", mobile: "row", render: (l) => <span className="tnum text-xs">{l.matchTier ?? ""}</span> },
            {
              key: "match",
              label: "Match",
              mobile: "row",
              render: (l) =>
                l.matchedTransactionId ? (
                  <Pill tone={l.matchConfirmed ? "good" : "info"}>{l.matchConfirmed ? "Confirmed" : "Proposed"}{l.matchedTransactionCount > 1 ? `, ${l.matchedTransactionCount} entries` : ""}</Pill>
                ) : (
                  <Pill tone="watch">Unmatched</Pill>
                ),
            },
          ]}
        />
      </SectionCard>
    </div>
  );
}
