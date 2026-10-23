import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useReconcile, useTransactions, errorMessage } from "@/api";
import { fmtPeriod, fmtShortDate } from "@/lib/money";
import type { Transaction } from "@shared/api";

const PAGE = 50;

function lastDayOf(period: string): string {
  const [y, m] = period.slice(0, 7).split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
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
            { key: "status", label: "Status", mobile: "row", render: (t) => <Pill>{t.status}</Pill> },
            { key: "amt", label: "Amount", align: "right", mobile: "value", render: (t) => <Money cents={t.amountCents} signed /> },
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
