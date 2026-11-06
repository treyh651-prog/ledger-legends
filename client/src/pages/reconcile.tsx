import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useReconcile, useTriggerRun, errorMessage } from "@/api";
import { parseSampleRows } from "@/lib/sample-rows";
import { fmtPeriod, fmtShortDate, fmtTimestamp } from "@/lib/money";
import type { RecBatch, RecLine } from "@shared/api";

/** A pasted amount cell, "-42.50" or "42.50", to REC-IMPORT-STATEMENT's own signed cents-as-digits wire shape. */
function amountToCentsString(v: string): string {
  const n = Number(v.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100).toString() : "0";
}

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
          <div className="flex flex-wrap items-center gap-2">
            {d && d.batches.length > 0 ? (
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
            ) : null}
            {clientId && d && d.bankAccounts.length > 0 ? (
              <ImportStatementDialog clientId={clientId} bankAccounts={d.bankAccounts} />
            ) : null}
          </div>
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

const FIELD_LABELS = ["Date", "Amount", "Description", "Check number (optional)"] as const;

/**
 * REC-IMPORT-STATEMENT. Audit fix (problem 8, and one of the audit's own
 * separately listed "smaller issues"): existed and worked, but nothing in
 * the client ever called it, including the upload screen that implied it
 * did. REC-MATCH-TIERED's own header says the statement's lines are
 * already in ledger.statement_lines and reads them -- this run is the
 * only way they ever get there.
 *
 * No detection: matching a pasted column to a field is by the firm's own
 * selection from the parsed header, the same "trim, compare, done, never
 * guess" rule portal-mapping-profiles.tsx's own header comment states for
 * exactly this reason -- a silently shifted column is the worst failure
 * this pipeline can produce, because the books still balance while every
 * figure is wrong. Nothing here is uploaded; the paste never leaves the
 * browser until Import is clicked.
 */
function ImportStatementDialog({
  clientId,
  bankAccounts,
}: {
  clientId: string;
  bankAccounts: readonly { id: string; nickname: string; accountNumber: string; kind: "bank" | "card" }[];
}) {
  const [open, setOpen] = useState(false);
  const [bankAccountId, setBankAccountId] = useState("");
  const [statementId, setStatementId] = useState("");
  const [sample, setSample] = useState("");
  const [dateCol, setDateCol] = useState("");
  const [amountCol, setAmountCol] = useState("");
  const [descCol, setDescCol] = useState("");
  const [checkCol, setCheckCol] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const parsed = useMemo(() => parseSampleRows(sample), [sample]);

  const reset = () => {
    setBankAccountId(bankAccounts[0]?.id ?? "");
    setStatementId("");
    setSample("");
    setDateCol("");
    setAmountCol("");
    setDescCol("");
    setCheckCol("");
    setError(null);
  };

  const colIndex = (name: string): number => parsed.header.findIndex((h) => h === name);

  const submit = async () => {
    setError(null);
    if (!bankAccountId || !statementId.trim()) {
      setError("A bank account and a statement name are required.");
      return;
    }
    const dateIdx = colIndex(dateCol);
    const amountIdx = colIndex(amountCol);
    const descIdx = colIndex(descCol);
    if (dateIdx === -1 || amountIdx === -1 || descIdx === -1) {
      setError("Pick which pasted column is the date, the amount, and the description.");
      return;
    }
    const checkIdx = checkCol ? colIndex(checkCol) : -1;
    if (parsed.rows.length === 0) {
      setError("Paste the statement's rows first, with a header row on top.");
      return;
    }
    const lines = parsed.rows.map((r) => ({
      statementDate: r[dateIdx] ?? "",
      amountCents: amountToCentsString(r[amountIdx] ?? "0"),
      description: r[descIdx] ?? "",
      normalizedVendor: null,
      checkNumber: checkIdx >= 0 ? (r[checkIdx] || null) : null,
    }));
    const scope = { clientId, bankAccountId, statementId: statementId.trim(), sourceFormat: "csv" as const, lines };
    try {
      const preview = await trigger.mutateAsync({ runCode: "REC-IMPORT-STATEMENT", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "no_op") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      if (preview.status !== "no_op") {
        const applied = await trigger.mutateAsync({ runCode: "REC-IMPORT-STATEMENT", body: { mode: "apply", scope, previewRunId: preview.executionId } });
        if (applied.status !== "completed") {
          setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
          return;
        }
      }
      void qc.invalidateQueries({ queryKey: ["api", "firm", "clients", clientId, "reconcile"] });
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const colSelect = (value: string, onChange: (v: string) => void, testId: string, allowNone = false) => (
    <select
      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
    >
      <option value="">{allowNone ? "None" : "Choose a column"}</option>
      {parsed.header.map((h, i) => (
        <option key={`${h}-${i}`} value={h}>{h}</option>
      ))}
    </select>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid="reconcile-import-statement">
          Import statement
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import a bank statement</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Account</label>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
                data-testid="reconcile-import-account"
              >
                <option value="" disabled>Choose one</option>
                {bankAccounts.map((b) => (
                  <option key={b.id} value={b.id}>{b.nickname} {b.accountNumber}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Statement name</label>
              <Input value={statementId} onChange={(e) => setStatementId(e.target.value)} placeholder="chase-nov-2026" data-testid="reconcile-import-statement-id" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Paste the statement, header row first</label>
            <Textarea rows={5} value={sample} onChange={(e) => setSample(e.target.value)} placeholder={"Date,Amount,Description,Check\n2026-11-03,-42.50,Office Depot,"} data-testid="reconcile-import-sample" />
          </div>
          {parsed.header.length > 0 ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{FIELD_LABELS[0]} column</label>
                {colSelect(dateCol, setDateCol, "reconcile-import-col-date")}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{FIELD_LABELS[1]} column</label>
                {colSelect(amountCol, setAmountCol, "reconcile-import-col-amount")}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{FIELD_LABELS[2]} column</label>
                {colSelect(descCol, setDescCol, "reconcile-import-col-desc")}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{FIELD_LABELS[3]} column</label>
                {colSelect(checkCol, setCheckCol, "reconcile-import-col-check", true)}
              </div>
            </div>
          ) : null}
          {parsed.rows.length > 0 ? (
            <p className="text-xs text-muted-foreground">{parsed.rows.length} rows parsed, nothing sent until Import.</p>
          ) : null}
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={() => void submit()} disabled={trigger.isPending} data-testid="reconcile-import-confirm">Import</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
