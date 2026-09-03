import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataGrid, EmptyState, Kpi, Money, Pill, SectionCard } from "@/components/kit";
import { PortalHero, PortalNote } from "@/components/portal/portal-kit";
import { usePortal } from "@/lib/use-portal";
import { acctLabel } from "@/data/coa";
import { fmtPeriod, fmtShortDate, usd } from "@/lib/money";
import type { Txn } from "@/data/types";

/**
 * A client's own transactions. Base level, and every period is included, open months too.
 * Holding a client's own records back would be indefensible, so nothing here is gated.
 */
export default function PortalTransactions() {
  const p = usePortal();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");

  const all = useMemo(
    () => p.ds.txns.filter((t) => t.clientId === p.clientId).slice().sort((a, b) => (a.date < b.date ? 1 : -1)),
    [p.ds, p.clientId],
  );

  const periods = useMemo(() => Array.from(new Set(all.map((t) => t.period))).sort().reverse(), [all]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((t) => {
      if (scope !== "all" && t.period !== scope) return false;
      if (!q) return true;
      return (
        t.description.toLowerCase().includes(q) ||
        t.vendor.toLowerCase().includes(q) ||
        acctLabel(t.categoryAccountId).toLowerCase().includes(q)
      );
    });
  }, [all, query, scope]);

  const money = rows.reduce((s, t) => s + t.baseAmountCents, 0);
  const inflow = rows.filter((t) => t.baseAmountCents > 0).reduce((s, t) => s + t.baseAmountCents, 0);
  const outflow = rows.filter((t) => t.baseAmountCents < 0).reduce((s, t) => s + Math.abs(t.baseAmountCents), 0);
  const waiting = rows.filter((t) => t.status === "needs_review").length;

  return (
    <>
      <PortalHero
        title="Your transactions"
        subtitle={`Every transaction posted on ${p.client.dba} accounts, with the category we used. Search it, read it, and tell us if anything looks wrong.`}
        tier={p.tier}
        meta={<Pill tone="info">Open to every service level</Pill>}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search vendor or category"
              className="h-8 w-[210px] text-xs"
              data-testid="input-portal-txn-search"
            />
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="h-8 w-[150px] text-xs" data-testid="select-portal-txn-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All months</SelectItem>
                {periods.map((v) => (
                  <SelectItem key={v} value={v}>
                    {fmtPeriod(v)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
        testId="hero-portal-transactions"
      />

      {all.length === 0 ? (
        <SectionCard title="Transactions" testId="card-portal-txns-empty">
          <EmptyState
            title="No transactions posted yet"
            body="This list fills in as your bank and card activity posts to your books. Your own records are never held back from you."
          />
        </SectionCard>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Transactions shown" value={String(rows.length)} hint={`${all.length} on your books`} testId="kpi-portal-txn-count" />
            <Kpi label="Money in" value={usd(inflow)} tone="good" testId="kpi-portal-txn-in" />
            <Kpi label="Money out" value={usd(outflow)} tone="watch" testId="kpi-portal-txn-out" />
            <Kpi label="Net movement" value={usd(money)} tone={money >= 0 ? "good" : "watch"} testId="kpi-portal-txn-net" />
          </div>

          {waiting > 0 ? (
            <PortalNote tone="watch" testId="note-portal-txn-review">
              {waiting} of these are still with us for a category or a receipt. They are shown as posted so you can see everything, and the
              category may change before the month closes.
            </PortalNote>
          ) : null}

          <SectionCard title="Posted activity" description="Newest first. Amounts are in your reporting currency." testId="card-portal-txns">
            <DataGrid<Txn>
              rows={rows}
              rowKey={(t) => t.id}
              maxHeight="60vh"
              cols={[
                { key: "date", label: "Date", width: "104px", mobile: "sub", render: (t) => fmtShortDate(t.date) },
                {
                  key: "description",
                  label: "Description",
                  mobile: "title",
                  render: (t) => (
                    <div className="min-w-0">
                      <p className="truncate font-medium">{t.description}</p>
                      <p className="truncate text-xs text-muted-foreground">{t.vendor}</p>
                    </div>
                  ),
                },
                {
                  key: "category",
                  label: "Category",
                  mobile: "row",
                  render: (t) => <span className="text-xs">{acctLabel(t.categoryAccountId)}</span>,
                },
                {
                  key: "status",
                  label: "State",
                  width: "120px",
                  mobile: "row",
                  render: (t) =>
                    t.status === "needs_review" ? (
                      <Pill tone="watch">With us for review</Pill>
                    ) : t.cleared ? (
                      <Pill tone="good">Cleared the bank</Pill>
                    ) : (
                      <Pill tone="neutral">Posted</Pill>
                    ),
                },
                {
                  key: "amount",
                  label: "Amount",
                  align: "right",
                  width: "128px",
                  mobile: "value",
                  render: (t) => <Money cents={t.baseAmountCents} signed />,
                },
              ]}
              testId="grid-portal-txns"
            />
          </SectionCard>
        </>
      )}
    </>
  );
}
