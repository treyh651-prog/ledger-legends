import { useMemo, useState } from "react";
import { Link2, Link2Off } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { DataGrid, EmptyState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { reconSummary } from "@/data/derive";
import { fmtPeriod, fmtShortDate, usd } from "@/lib/money";

export default function Reconcile() {
  const { ds, activeClient, activeClientId, period, loading, loadError, reload, matchLine, unmatchLine } = useApp();
  const { toast } = useToast();
  const banks = ds.bankAccounts.filter((b) => b.clientId === activeClientId && b.needsReconciling);
  const [bankId, setBankId] = useState(banks[0]?.id || "");
  const active = banks.find((b) => b.id === bankId) || banks[0];
  const currentBankId = active?.id || "";

  const summary = useMemo(
    () => (currentBankId ? reconSummary(ds, activeClientId, currentBankId, period) : null),
    [ds, activeClientId, currentBankId, period],
  );

  const lines = ds.statementLines.filter((l) => l.bankAccountId === currentBankId && l.period === period).sort((a, b) => (a.date < b.date ? -1 : 1));
  const bookTxns = ds.txns.filter((t) => t.bankAccountId === currentBankId && t.period === period).sort((a, b) => (a.date < b.date ? -1 : 1));
  const matchedTxnIds = new Set(lines.map((l) => l.matchedTxnId).filter(Boolean) as string[]);
  const unmatchedBook = bookTxns.filter((t) => !matchedTxnIds.has(t.id));

  const suggestFor = (lineId: string) => {
    const line = lines.find((l) => l.id === lineId)!;
    return unmatchedBook.filter((t) => t.baseAmountCents === line.amountCents);
  };

  if (!banks.length || !summary) {
    return (
      <>
        <PageHeader title="Reconciliation" subtitle="No account on this client is marked for monthly reconciliation." />
        <SectionCard bodyClassName="p-0">
          <EmptyState title="Nothing to reconcile" body="Turn on monthly reconciliation for an account in the client file and it will appear here." />
        </SectionCard>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Reconciliation workspace"
        subtitle={`Statement on the left, books on the right. The difference has to reach zero before ${fmtPeriod(period)} can close for ${activeClient.dba}.`}
        actions={
          <Select value={currentBankId} onValueChange={setBankId}>
            <SelectTrigger className="h-8 w-[220px] text-xs" data-testid="select-recon-account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {banks.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.nickname}, ending {b.last4}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Statement total" value={usd(summary.statementTotal)} hint={`${lines.length} lines from ${active.institution}`} testId="kpi-statement" />
        <Kpi label="Book total" value={usd(summary.bookTotal)} hint={`${bookTxns.length} posted transactions`} testId="kpi-book" />
        <Kpi
          label="Difference"
          value={usd(summary.difference)}
          tone={summary.difference === 0 ? "good" : "risk"}
          hint={summary.difference === 0 ? "This account is reconciled" : "Still needs work"}
          testId="kpi-difference"
        />
        <Kpi
          label="Matched"
          value={`${summary.matchedCount} of ${lines.length}`}
          hint={`${summary.unmatchedStatement} statement lines and ${summary.unmatchedBook} book rows left`}
          tone={summary.unmatchedStatement || summary.unmatchedBook ? "watch" : "good"}
          testId="kpi-matched"
        />
      </div>

      <div
        className={`rounded-md border p-4 ${summary.difference === 0 ? "border-positive/40 bg-positive-soft" : "border-destructive/40 bg-danger-soft"}`}
        data-testid="banner-difference"
      >
        <p className={`text-sm font-semibold ${summary.difference === 0 ? "text-positive" : "text-destructive"}`}>
          {summary.difference === 0
            ? `${active.nickname} is reconciled for ${fmtPeriod(period)}`
            : `${active.nickname} is out by ${usd(summary.difference)}`}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {summary.difference === 0
            ? "Every statement line has a partner in the books and the totals agree."
            : "Match the remaining lines, or post an entry for anything the bank charged that never made it into the books."}
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard
          title="Bank statement"
          description={`${lines.length} lines imported from ${active.statementSource.toLowerCase()}`}
          bodyClassName="p-0"
          testId="card-statement"
        >
          <DataGrid
            rows={lines}
            rowKey={(l) => l.id}
            loading={loading}
            error={loadError}
            onRetry={reload}
            dense
            maxHeight="520px"
            rowClassName={(l) => (l.matchedTxnId ? "" : "bg-warning-soft/40")}
            cols={[
              { key: "date", label: "Date", mobile: "sub", render: (l) => <span className="tnum text-xs">{fmtShortDate(l.date)}</span> },
              {
                key: "desc",
                label: "Description",
                mobile: "title",
                cellClassName: "max-w-[180px] lg:max-w-[240px]",
                render: (l) => (
                  <div className="min-w-0">
                    <p className="truncate">{l.description}</p>
                    {l.matchedTxnId ? (
                      <p className="truncate text-xs text-positive">Matched to a posted transaction</p>
                    ) : (
                      <p className="truncate text-xs text-warning">No match found yet</p>
                    )}
                  </div>
                ),
              },
              { key: "amount", label: "Amount", align: "right", mobile: "value", render: (l) => <Money cents={l.amountCents} signed /> },
              {
                key: "action",
                label: "Match",
                align: "right",
                mobile: "row",
                render: (l) => {
                  if (l.matchedTxnId)
                    return (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        onClick={() => unmatchLine(l.id)}
                        data-testid={`button-unmatch-${l.id}`}
                      >
                        <Link2Off className="mr-1 h-3.5 w-3.5" />
                        Unmatch
                      </Button>
                    );
                  const candidates = suggestFor(l.id);
                  if (!candidates.length) return <span className="text-xs text-muted-foreground">No candidate</span>;
                  return (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      onClick={() => {
                        matchLine(l.id, candidates[0].id);
                        toast({ title: "Line matched", description: `${l.description} tied to ${candidates[0].description}.` });
                      }}
                      data-testid={`button-match-${l.id}`}
                    >
                      <Link2 className="mr-1 h-3.5 w-3.5" />
                      Match
                    </Button>
                  );
                },
              },
            ]}
          />
        </SectionCard>

        <SectionCard
          title="Posted in the books"
          description={`${unmatchedBook.length} rows have not been tied to the statement`}
          bodyClassName="p-0"
          testId="card-books"
        >
          <DataGrid
            rows={bookTxns}
            rowKey={(t) => t.id}
            loading={loading}
            error={loadError}
            onRetry={reload}
            dense
            maxHeight="520px"
            rowClassName={(t) => (matchedTxnIds.has(t.id) ? "" : "bg-warning-soft/40")}
            cols={[
              { key: "date", label: "Date", mobile: "sub", render: (t) => <span className="tnum text-xs">{fmtShortDate(t.date)}</span> },
              {
                key: "desc",
                label: "Description",
                mobile: "title",
                cellClassName: "max-w-[180px] lg:max-w-[240px]",
                render: (t) => (
                  <div className="min-w-0">
                    <p className="truncate">{t.description}</p>
                    <p className="truncate text-xs text-muted-foreground">{t.vendor}</p>
                  </div>
                ),
              },
              { key: "amount", label: "Amount", align: "right", mobile: "value", render: (t) => <Money cents={t.baseAmountCents} signed /> },
              {
                key: "state",
                label: "State",
                align: "right",
                mobile: "row",
                render: (t) => (matchedTxnIds.has(t.id) ? <Pill tone="good">Cleared</Pill> : <Pill tone="watch">Outstanding</Pill>),
              },
            ]}
          />
        </SectionCard>
      </div>

      <SectionCard title="What is left" description="The items making up the difference, so nothing gets closed on a guess.">
        {summary.difference === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing outstanding. This account is clean for the period.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {lines
              .filter((l) => !l.matchedTxnId)
              .map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2 last:border-0">
                  <span className="min-w-0 flex-1 truncate">
                    On the statement but not in the books, {l.description} dated {fmtShortDate(l.date)}
                  </span>
                  <Money cents={l.amountCents} signed className="shrink-0 text-sm" />
                </li>
              ))}
            {unmatchedBook.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2 last:border-0">
                <span className="min-w-0 flex-1 truncate">
                  In the books but not on the statement, {t.description} dated {fmtShortDate(t.date)}
                </span>
                <Money cents={t.baseAmountCents} signed className="shrink-0 text-sm" />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  );
}
