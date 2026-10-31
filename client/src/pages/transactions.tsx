import { useState } from "react";
import { Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useReconcile, useTransactions, useTriggerRun, errorMessage } from "@/api";
import { fmtPeriod, fmtShortDate } from "@/lib/money";
import type { Transaction } from "@shared/api";

const PAGE = 50;

function lastDayOf(period: string): string {
  const [y, m] = period.slice(0, 7).split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

function invalidateTransactions(qc: ReturnType<typeof useQueryClient>, clientId: string) {
  // No q suffix: react-query matches every cached page for this client, not
  // just the one this screen happens to be showing right now.
  void qc.invalidateQueries({ queryKey: ["api", "firm", "clients", clientId, "transactions"] });
}

function ClearedWarning({ transaction }: { transaction: Transaction }) {
  if (!transaction.cleared) return null;
  return (
    <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
      This transaction is cleared. Voiding it will not update any reconciliation batch it was matched to.
    </p>
  );
}

function VoidDialog({ clientId, transaction }: { clientId: string; transaction: Transaction }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const submit = async () => {
    setError(null);
    const scope = { clientId, transactionId: transaction.id, reason: reason.trim() };
    try {
      const preview = await trigger.mutateAsync({ runCode: "TXN-VOID", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "completed_with_skips") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "TXN-VOID",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      invalidateTransactions(qc, clientId);
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) { setReason(""); setError(null); }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid={`txn-void-${transaction.id}`}>
          Void
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Void transaction</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {transaction.description}, <Money cents={transaction.amountCents} signed /> on {fmtShortDate(transaction.postedDate)}.
            Voiding reverses it; there is no replacement.
          </p>
          <ClearedWarning transaction={transaction} />
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Reason</label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Duplicate entry, keyed twice" data-testid="void-reason" />
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => void submit()}
            disabled={trigger.isPending || reason.trim().length === 0}
            data-testid="void-confirm"
          >
            Void
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReissueDialog({ clientId, transaction }: { clientId: string; transaction: Transaction }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [postedDate, setPostedDate] = useState(transaction.postedDate);
  const [amountDollars, setAmountDollars] = useState(String(Number(transaction.amountCents) / 100));
  const [description, setDescription] = useState(transaction.description);
  const [error, setError] = useState<string | null>(null);
  const trigger = useTriggerRun(clientId);
  const qc = useQueryClient();

  const reset = () => {
    setReason("");
    setPostedDate(transaction.postedDate);
    setAmountDollars(String(Number(transaction.amountCents) / 100));
    setDescription(transaction.description);
    setError(null);
  };

  const submit = async () => {
    setError(null);
    const corrections: Record<string, unknown> = {};
    if (postedDate !== transaction.postedDate) corrections.postedDate = postedDate;
    const parsedCents = Math.round(Number(amountDollars) * 100);
    if (Number.isFinite(parsedCents) && parsedCents !== transaction.amountCents) corrections.amountCents = parsedCents;
    if (description !== transaction.description) corrections.description = description;
    const scope = { clientId, transactionId: transaction.id, reason: reason.trim(), corrections };
    try {
      const preview = await trigger.mutateAsync({ runCode: "TXN-VOID-AND-REISSUE", body: { mode: "preview", scope } });
      if (preview.status !== "completed" && preview.status !== "completed_with_skips") {
        setError(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({
        runCode: "TXN-VOID-AND-REISSUE",
        body: { mode: "apply", scope, previewRunId: preview.executionId },
      });
      if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
        setError(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      invalidateTransactions(qc, clientId);
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid={`txn-reissue-${transaction.id}`}>
          Void &amp; reissue
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Void and reissue transaction</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Voids this transaction and inserts a corrected replacement. Its category carries forward, so the coding cascade posts it automatically on its next run.
          </p>
          <ClearedWarning transaction={transaction} />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <Input type="date" value={postedDate} onChange={(e) => setPostedDate(e.target.value)} data-testid="reissue-date" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Amount ($)</label>
              <Input type="number" step="0.01" value={amountDollars} onChange={(e) => setAmountDollars(e.target.value)} data-testid="reissue-amount" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} data-testid="reissue-description" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Reason</label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wrong amount keyed in" data-testid="reissue-reason" />
          </div>
          {error ? <p className="break-words text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={trigger.isPending || reason.trim().length === 0} data-testid="reissue-confirm">
            Void &amp; reissue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Transactions for one client, read from GET /api/firm/clients/:id/transactions.
 * Filters are the query parameters the API accepts; the page shows what the
 * server returned and nothing more. Recategorizing a transaction is a run,
 * not a browser edit, so this screen has no category pickers until that run
 * exists.
 */
export default function Transactions() {
  const { period } = useApp();
  const { client, clientId } = useActiveClient();
  const [scope, setScope] = useState<"period" | "all">("period");
  const [bank, setBank] = useState("all");
  const [uncategorized, setUncategorized] = useState(false);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  const q = useTransactions(clientId, {
    limit: PAGE,
    offset,
    from: scope === "period" ? `${period.slice(0, 7)}-01` : undefined,
    to: scope === "period" ? lastDayOf(period) : undefined,
    bankAccountId: bank === "all" ? undefined : bank,
    search: search.trim() ? search.trim() : undefined,
    uncategorized: uncategorized ? true : undefined,
  });
  const banksQ = useReconcile(clientId, period, null);
  const banks = banksQ.data?.bankAccounts ?? [];
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const bankName = (id: string) => banks.find((b) => b.id === id)?.nickname ?? id;
  const reset = () => setOffset(0);

  return (
    <div className="space-y-4" data-testid="page-transactions">
      <PageHeader title="Transactions" subtitle={`${client?.name ?? ""}, ${scope === "period" ? fmtPeriod(period) : "all periods"}. Categorization is applied by TXN-APPLY-RULES and reviewed from the rules screen.`} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Matching" value={d ? d.total : "…"} testId="kpi-total" hint="Rows the API counted for these filters" />
        <Kpi label="On this page" value={d ? d.items.length : "…"} testId="kpi-page" />
        <Kpi label="Bank accounts" value={banksQ.data ? banks.length : "…"} testId="kpi-banks" />
      </div>
      <SectionCard title="Filters" description="Each filter is a query parameter the API accepts.">
        <div className="grid gap-3 px-3 py-3 sm:grid-cols-4">
          <div className="relative sm:col-span-2">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => { setSearch(e.target.value); reset(); }} placeholder="Description or vendor" className="pl-8" data-testid="input-search" />
          </div>
          <Select value={bank} onValueChange={(v) => { setBank(v); reset(); }}>
            <SelectTrigger data-testid="select-bank"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Every account</SelectItem>
              {banks.map((b) => <SelectItem key={b.id} value={b.id}>{b.nickname}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Checkbox id="uncat" checked={uncategorized} onCheckedChange={(v) => { setUncategorized(v === true); reset(); }} data-testid="checkbox-uncategorized" />
              <Label htmlFor="uncat" className="text-xs">Uncategorized only</Label>
            </div>
            {(["period", "all"] as const).map((s) => (
              <Button key={s} size="sm" variant={scope === s ? "default" : "outline"} onClick={() => { setScope(s); reset(); }} data-testid={`button-scope-${s}`}>
                {s === "period" ? "This period" : "All"}
              </Button>
            ))}
          </div>
        </div>
      </SectionCard>
      <SectionCard title="Ledger" description="Posted bank and card transactions as the API returns them.">
        <DataGrid
          rows={d?.items ?? []}
          rowKey={(t: Transaction) => t.id}
          loading={q.isPending}
          testId="grid-transactions"
          empty={<EmptyState title="No transactions" body="Nothing matched these filters. Clear them or import a statement." />}
          cols={[
            { key: "date", label: "Date", mobile: "row", render: (t) => <span className="tnum text-xs">{fmtShortDate(t.postedDate)}</span> },
            { key: "desc", label: "Description", mobile: "title", render: (t) => <div><div>{t.description}</div>{t.normalizedVendor ? <div className="text-xs text-muted-foreground">{t.normalizedVendor}</div> : null}</div> },
            { key: "bank", label: "Account", mobile: "row", render: (t) => <span className="text-xs">{bankName(t.bankAccountId)}</span> },
            { key: "cat", label: "Category", mobile: "row", render: (t) => (t.categoryId ? <span className="text-xs">{t.categoryName ?? t.categoryId}{t.manualOverride ? " (manual)" : t.cascadeLevel !== null ? ` (level ${t.cascadeLevel})` : ""}</span> : <Pill tone="watch">Uncategorized</Pill>) },
            {
              key: "status",
              label: "Status",
              mobile: "row",
              render: (t) =>
                t.voided ? (
                  <div className="space-y-0.5">
                    <Pill tone="watch">voided</Pill>
                    {t.voidOfTransactionId ? (
                      <button
                        type="button"
                        className="block text-xs text-primary underline underline-offset-2"
                        // The API searches description/vendor text, not ids, so
                        // the fastest honest way back to the replacement is to
                        // search on this row's own description -- the
                        // replacement almost always carries it forward too.
                        onClick={() => { setSearch(t.description); reset(); }}
                        data-testid={`txn-reissued-link-${t.id}`}
                      >
                        reissued, find it by description
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <Pill>{t.status}</Pill>
                ),
            },
            { key: "amt", label: "Amount", align: "right", mobile: "value", render: (t) => <Money cents={t.amountCents} signed /> },
            {
              key: "actions",
              label: "",
              mobile: "row",
              render: (t) =>
                !t.voided && t.status === "active" && clientId ? (
                  <div className="flex gap-2">
                    <VoidDialog clientId={clientId} transaction={t} />
                    <ReissueDialog clientId={clientId} transaction={t} />
                  </div>
                ) : null,
            },
          ]}
        />
        {d && d.total > PAGE ? (
          <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
            <span>Showing {d.offset + 1} to {Math.min(d.offset + d.items.length, d.total)} of {d.total}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} data-testid="button-prev">Previous</Button>
              <Button size="sm" variant="outline" disabled={d.offset + d.items.length >= d.total} onClick={() => setOffset(offset + PAGE)} data-testid="button-next">Next</Button>
            </div>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
