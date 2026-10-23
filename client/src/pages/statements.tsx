import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useFirmStatements, useTrialBalance, errorMessage } from "@/api";
import { fmtPeriod, usd } from "@/lib/money";
import { StatementGrid } from "./portal-statements";

/**
 * Financial statements for the firm, read from
 * GET /api/firm/clients/:id/statements and /trial-balance. Same read model
 * as the portal, without the tier gate, plus the trial balance the firm
 * works from. Every figure is a sum of posted journal lines.
 */
export default function Statements() {
  const { period } = useApp();
  const { client, clientId } = useActiveClient();
  const st = useFirmStatements(clientId, period);
  const tb = useTrialBalance(clientId, period);
  const d = st.data;

  if (st.isError) return <ErrorState message={errorMessage(st.error)} onRetry={() => void st.refetch()} />;

  const statusTone = d?.periodStatus === "locked" ? "good" : d?.periodStatus === "open" ? "watch" : "neutral";

  return (
    <div className="space-y-4" data-testid="page-statements">
      <PageHeader
        title="Statements"
        subtitle={`${client?.name ?? ""}, ${fmtPeriod(period)}. ${d ? `${d.entryCount} posted entries through period end.` : ""}`}
        actions={d ? <Pill tone={statusTone}>{d.periodStatus === "none" ? "Period not opened" : `Period ${d.periodStatus}`}</Pill> : null}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Net income" value={d ? <Money cents={d.netIncomeCents} signed /> : "…"} tone={d ? (d.netIncomeCents >= 0 ? "good" : "risk") : "neutral"} testId="kpi-net-income" />
        <Kpi label="Total assets" value={d ? <Money cents={d.totalAssetsCents} /> : "…"} />
        <Kpi label="Liabilities and equity" value={d ? <Money cents={d.totalLiabilitiesAndEquityCents} /> : "…"} />
        <Kpi
          label="Trial balance"
          value={tb.data ? (tb.data.foots ? "Foots" : "Does not foot") : "…"}
          tone={tb.data ? (tb.data.foots ? "good" : "risk") : "neutral"}
          hint={tb.data ? `${usd(tb.data.totalDebitCents)} debits, ${usd(tb.data.totalCreditCents)} credits` : undefined}
          testId="kpi-foots"
        />
      </div>

      {d && !d.foots ? (
        <div className="rounded-md border border-destructive/40 bg-danger-soft px-3 py-2 text-sm text-destructive" data-testid="banner-not-footing">
          The balance sheet does not foot for this period. The figures below are shown as the ledger holds them; CLS-EVALUATE-GATES will block the close.
        </div>
      ) : null}

      <Tabs defaultValue="pl">
        <TabsList>
          <TabsTrigger value="pl" data-testid="tab-pl">Profit and loss</TabsTrigger>
          <TabsTrigger value="bs" data-testid="tab-bs">Balance sheet</TabsTrigger>
          <TabsTrigger value="tb" data-testid="tab-tb">Trial balance</TabsTrigger>
        </TabsList>
        <TabsContent value="pl" className="mt-4">
          <SectionCard title="Profit and loss" description={`Activity in ${fmtPeriod(period)}.`}>
            {st.isPending ? (
              <DataGrid rows={[]} cols={[]} rowKey={() => ""} loading />
            ) : d && d.entryCount === 0 ? (
              <EmptyState title="No posted entries" body="Statements appear once journal entries post for this client." />
            ) : d ? (
              <StatementGrid sections={d.incomeStatement} footer={{ label: "Net income", amount: d.netIncomeCents }} testId="grid-pl" />
            ) : null}
          </SectionCard>
        </TabsContent>
        <TabsContent value="bs" className="mt-4">
          <SectionCard title="Balance sheet" description={`As of ${d?.periodEnd ?? ""}.`}>
            {st.isPending ? (
              <DataGrid rows={[]} cols={[]} rowKey={() => ""} loading />
            ) : d && d.entryCount === 0 ? (
              <EmptyState title="No posted entries" body="Statements appear once journal entries post for this client." />
            ) : d ? (
              <StatementGrid sections={d.balanceSheet} footer={{ label: "Total liabilities and equity", amount: d.totalLiabilitiesAndEquityCents }} testId="grid-bs" />
            ) : null}
          </SectionCard>
        </TabsContent>
        <TabsContent value="tb" className="mt-4">
          <SectionCard title="Trial balance" description="Every account with a balance through period end, debits positive.">
            <DataGrid
              rows={tb.data?.lines ?? []}
              loading={tb.isPending}
              error={tb.isError ? errorMessage(tb.error) : null}
              onRetry={() => void tb.refetch()}
              rowKey={(l) => l.accountNumber}
              testId="grid-tb"
              empty={<EmptyState title="No balances" body="Nothing has posted through this period." />}
              cols={[
                { key: "acct", label: "Account", mobile: "title", render: (l) => <span>{l.accountNumber} {l.name}</span> },
                { key: "dr", label: "Debit", align: "right", mobile: "row", render: (l) => (l.debitCents ? <Money cents={l.debitCents} /> : <span className="text-muted-foreground">0</span>) },
                { key: "cr", label: "Credit", align: "right", mobile: "value", render: (l) => (l.creditCents ? <Money cents={l.creditCents} /> : <span className="text-muted-foreground">0</span>) },
              ]}
              footer={
                tb.data ? (
                  <tr>
                    <td className="px-3 py-2 text-sm font-semibold">Total</td>
                    <td className="tnum px-3 py-2 text-right text-sm font-semibold">{usd(tb.data.totalDebitCents)}</td>
                    <td className="tnum px-3 py-2 text-right text-sm font-semibold">{usd(tb.data.totalCreditCents)}</td>
                  </tr>
                ) : null
              }
            />
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
