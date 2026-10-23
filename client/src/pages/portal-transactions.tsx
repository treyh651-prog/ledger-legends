import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { DataGrid, EmptyState, ErrorState, Money, Pill, SectionCard } from "@/components/kit";
import { PortalHero, PortalNote } from "@/components/portal/portal-kit";
import { Input } from "@/components/ui/input";
import { usePortalClient } from "@/lib/use-portal-client";
import { usePortalHome, usePortalTransactions, errorMessage } from "@/api";
import { fmtShortDate } from "@/lib/money";
import type { Transaction } from "@shared/api";
import type { TierId } from "@shared/tiers";

/**
 * The client's transaction register, read from
 * GET /api/portal/:clientId/transactions. Rows are ledger.transactions as the
 * firm categorised them; the category name is joined on the server. The
 * client reads and searches here and never edits, a change of category is a
 * message to the firm.
 */
export default function PortalTransactions() {
  const sel = usePortalClient();
  const home = usePortalHome(sel.clientId);
  const [search, setSearch] = useState("");
  const q = usePortalTransactions(sel.clientId, { search: search.trim() || undefined });
  const tier = home.data ? (home.data.tier as TierId) : undefined;

  const rows = q.data?.items ?? [];
  const totals = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    for (const t of rows) {
      if (t.amountCents >= 0) inflow += t.amountCents;
      else outflow += t.amountCents;
    }
    return { inflow, outflow };
  }, [rows]);

  if (sel.error) return <ErrorState message={errorMessage(sel.error)} onRetry={sel.retry} />;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  return (
    <>
      <PortalHero
        title="Transactions"
        subtitle="Every bank and card line your books hold, as categorised by your firm. Search by description or vendor."
        tier={tier}
        meta={q.data ? <Pill tone="neutral">{q.data.total} rows</Pill> : null}
        testId="hero-portal-transactions"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <SectionCard title="Money in" description="Sum of the rows shown.">
          <Money cents={totals.inflow} className="text-lg font-semibold" />
        </SectionCard>
        <SectionCard title="Money out" description="Sum of the rows shown.">
          <Money cents={totals.outflow} className="text-lg font-semibold" />
        </SectionCard>
      </div>

      <SectionCard
        title="Register"
        description="Newest first. Uncategorised rows are still with your firm."
        actions={
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search description or vendor" className="h-8 w-64 pl-8" data-testid="input-portal-txn-search" />
          </div>
        }
      >
        <DataGrid<Transaction>
          rows={rows}
          loading={q.isPending || sel.loading}
          rowKey={(t) => t.id}
          testId="grid-portal-transactions"
          empty={
            <EmptyState
              title={search ? "Nothing matches" : "No transactions yet"}
              body={search ? "Try a shorter search." : "Rows appear here after your firm imports the first bank file."}
            />
          }
          cols={[
            { key: "date", label: "Date", mobile: "row", render: (t) => <span className="tnum text-xs">{fmtShortDate(t.postedDate)}</span> },
            { key: "desc", label: "Description", mobile: "title", render: (t) => <span className="font-medium">{t.normalizedVendor ?? t.description}</span> },
            { key: "acct", label: "Account", mobile: "row", render: (t) => <span className="tnum text-xs">{t.accountNumber}</span> },
            {
              key: "cat",
              label: "Category",
              mobile: "row",
              render: (t) => (t.categoryId ? <span className="text-xs">{t.categoryName ?? t.categoryId}</span> : <Pill tone="watch">With your firm</Pill>),
            },
            { key: "amt", label: "Amount", align: "right", mobile: "value", render: (t) => <Money cents={t.amountCents} signed /> },
          ]}
        />
      </SectionCard>

      <PortalNote>
        A category you disagree with is a message to your firm, not a button here. Nothing on this page is editable and nothing you do here changes the books.
      </PortalNote>
    </>
  );
}
