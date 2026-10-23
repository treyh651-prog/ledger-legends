import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, Kpi, LoadingRows, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useJournal, errorMessage } from "@/api";
import { fmtPeriod, fmtShortDate, usd } from "@/lib/money";

/**
 * The general journal for one period, read from
 * GET /api/firm/clients/:id/journal. Every entry here was written by a run
 * and names it. There is no hand entry form: a journal entry is a run's
 * output, and a correction is a reversing run.
 */
export default function Journal() {
  const { period } = useApp();
  const { client, clientId } = useActiveClient();
  const q = useJournal(clientId, period);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const needle = filter.trim().toLowerCase();
  const entries = (d?.entries ?? []).filter(
    (e) => !needle || e.memo.toLowerCase().includes(needle) || e.runType.toLowerCase().includes(needle) || e.lines.some((l) => l.accountNumber.startsWith(needle)),
  );
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-4" data-testid="page-journal">
      <PageHeader
        title="Journal"
        subtitle={`${client?.name ?? ""}, ${fmtPeriod(period)}. ${d ? `${d.postedCount} posted of ${d.entries.length} entries.` : ""}`}
        actions={<Input placeholder="Filter by memo, run, or account" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-72" data-testid="input-journal-filter" />}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Entries" value={d ? d.entries.length : "…"} testId="kpi-entries" />
        <Kpi label="Posted" value={d ? d.postedCount : "…"} />
        <Kpi label="Posted debits" value={d ? <Money cents={d.totalDebitCents} /> : "…"} />
      </div>
      <SectionCard title="Entries" description="Entry date ascending. Open an entry to see its lines.">
        {q.isPending ? (
          <LoadingRows rows={6} cols={4} />
        ) : entries.length === 0 ? (
          <EmptyState title={needle ? "No entry matches" : "No entries in this period"} body={needle ? "Clear the filter to see every entry." : "Entries appear here as the runs post them."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="grid-journal">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2" />
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Memo</th>
                  <th className="px-3 py-2">Run</th>
                  <th className="px-3 py-2 text-right">Debits</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <Fragment key={e.id}>
                    <tr className="cursor-pointer border-t border-border hover:bg-muted/40" onClick={() => toggle(e.id)} data-testid={`row-entry-${e.id}`}>
                      <td className="px-3 py-2">{open.has(e.id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                      <td className="tnum px-3 py-2 text-xs">{fmtShortDate(e.entryDate)}</td>
                      <td className="px-3 py-2">{e.memo}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{e.runType}</td>
                      <td className="tnum px-3 py-2 text-right">{usd(e.debitCents)}</td>
                      <td className="px-3 py-2">
                        <Pill tone={e.posted ? "good" : "watch"}>{e.posted ? "Posted" : "Unposted"}</Pill>
                        {e.reversedByEntryId ? <Pill tone="neutral" className="ml-1">Reversed</Pill> : null}
                        {e.reversalOf ? <Pill tone="info" className="ml-1">Reversal</Pill> : null}
                      </td>
                    </tr>
                    {open.has(e.id)
                      ? e.lines.map((l) => (
                          <tr key={l.id} className="bg-muted/20 text-xs">
                            <td />
                            <td />
                            <td className="px-3 py-1.5 pl-8">
                              {l.accountNumber} {l.accountName}
                              {l.memo && l.memo !== e.memo ? <span className="text-muted-foreground">, {l.memo}</span> : null}
                            </td>
                            <td />
                            <td className="tnum px-3 py-1.5 text-right">
                              {l.amountCents >= 0 ? usd(l.amountCents) : <span className="text-muted-foreground">({usd(-l.amountCents)})</span>}
                            </td>
                            <td />
                          </tr>
                        ))
                      : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
