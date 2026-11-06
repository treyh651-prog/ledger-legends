import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, SectionCard } from "@/components/kit";
import { useActiveClient } from "@/lib/active-client";
import { useApp } from "@/store";
import { useAging, useTriggerRun, errorMessage, periodStartOf, screenKeys } from "@/api";
import { fmtCompactUsd, fmtShortDate, usd } from "@/lib/money";
import type { AgingBuckets, AgingParty } from "@shared/api";

/**
 * AR-APPLY-PAYMENTS / AP-APPLY-PAYMENTS. Audit fix (problem 8): both
 * existed and worked (the 4 tier allocation these run specs document), but
 * nothing in the client ever called either one -- a payment recorded via
 * transactions.tsx's own RecordCustomerPaymentDialog/RecordVendorPayment
 * Dialog sat unapplied forever with no way to actually resolve it onto an
 * open invoice or bill. Period scoped, same as the run's own scope, no per
 * payment selection needed since the allocation itself is automatic.
 */
function ApplyPaymentsButton({ clientId, period, runCode, label, testId }: { clientId: string; period: string; runCode: "AR-APPLY-PAYMENTS" | "AP-APPLY-PAYMENTS"; label: string; testId: string }) {
  const trigger = useTriggerRun(clientId);
  const [status, setStatus] = useState<string | null>(null);
  const qc = useQueryClient();

  const submit = async () => {
    setStatus(null);
    const scope = { clientId, period: periodStartOf(period) };
    try {
      const preview = await trigger.mutateAsync({ runCode, body: { mode: "preview", scope } });
      if (preview.status === "no_op") {
        setStatus("Nothing to apply this period.");
        return;
      }
      if (preview.status !== "completed" && preview.status !== "completed_with_skips") {
        setStatus(preview.errors[0]?.message ?? `The run ended ${preview.status}.`);
        return;
      }
      const applied = await trigger.mutateAsync({ runCode, body: { mode: "apply", scope, previewRunId: preview.executionId } });
      if (applied.status !== "completed" && applied.status !== "completed_with_skips") {
        setStatus(applied.errors[0]?.message ?? `The run ended ${applied.status}.`);
        return;
      }
      setStatus(`Applied. ${applied.proposals.length} proposal(s), ${applied.skips.length} skipped.`);
      void qc.invalidateQueries({ queryKey: screenKeys.aging(clientId) });
    } catch (e) {
      setStatus(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={() => void submit()} disabled={trigger.isPending} data-testid={testId}>
        {label}
      </Button>
      {status ? <p className="max-w-[16rem] break-words text-right text-xs text-muted-foreground">{status}</p> : null}
    </div>
  );
}

const BUCKETS: { key: keyof Omit<AgingBuckets, "totalCents">; label: string }[] = [
  { key: "currentCents", label: "Current" },
  { key: "b1To30Cents", label: "1 to 30" },
  { key: "b31To60Cents", label: "31 to 60" },
  { key: "b61To90Cents", label: "61 to 90" },
  { key: "over90Cents", label: "Over 90" },
];

/**
 * One series (the open balance), buckets on the x axis, so no legend. Bucket
 * order is itself a magnitude, how overdue, so the bars shade from the chart
 * hue toward the risk color the further past due the bucket is.
 */
function AgingBucketChart({ totals }: { totals: AgingBuckets }) {
  const data = BUCKETS.map((b) => ({ label: b.label, amount: totals[b.key] / 100 }));
  const barColor = (i: number) => {
    const t = i / (BUCKETS.length - 1);
    return t < 0.7 ? "hsl(var(--chart-1))" : "hsl(var(--destructive))";
  };
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={{ stroke: "hsl(var(--border))" }} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} tickFormatter={(v: number) => fmtCompactUsd(v * 100)} width={56} />
        <Tooltip
          formatter={(value: number) => [usd(Math.round(value * 100)), "Open balance"]}
          contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: "hsl(var(--foreground))" }}
        />
        <Bar dataKey="amount" radius={[3, 3, 0, 0]} maxBarSize={48}>
          {data.map((_, i) => (
            <Cell key={i} fill={barColor(i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Receivable and payable aging, read from GET /api/firm/clients/:id/aging.
 * Open balances come from posted invoices and bills in the subledger tables,
 * bucketed by days past due as of today.
 */
export default function Aging() {
  const { client, clientId } = useActiveClient();
  const { period } = useApp();
  const q = useAging(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const grid = (rows: AgingParty[], totals: AgingBuckets | undefined, testId: string, emptyBody: string) => (
    <DataGrid<AgingParty>
      rows={rows}
      loading={q.isPending}
      rowKey={(r) => r.partyId}
      testId={testId}
      empty={<EmptyState title="Nothing open" body={emptyBody} />}
      cols={[
        { key: "party", label: "Name", mobile: "title", render: (r) => <span className="font-medium">{r.partyName}</span> },
        { key: "docs", label: "Open", align: "right", mobile: "row", render: (r) => <span className="tnum text-xs">{r.documentCount}</span> },
        ...BUCKETS.map((b) => ({
          key: b.key,
          label: b.label,
          align: "right" as const,
          mobile: "row" as const,
          render: (r: AgingParty) => <Money cents={r.buckets[b.key]} dim />,
        })),
        { key: "total", label: "Total", align: "right", mobile: "value", render: (r) => <Money cents={r.buckets.totalCents} className="font-semibold" /> },
      ]}
      footer={
        totals ? (
          <tr>
            <td className="px-3 py-2 text-sm font-semibold">Total</td>
            <td />
            {BUCKETS.map((b) => (
              <td key={b.key} className="tnum px-3 py-2 text-right text-sm font-semibold">
                {usd(totals[b.key])}
              </td>
            ))}
            <td className="tnum px-3 py-2 text-right text-sm font-semibold">{usd(totals.totalCents)}</td>
          </tr>
        ) : null
      }
    />
  );

  return (
    <div className="space-y-4" data-testid="page-aging">
      <PageHeader
        title="Aging"
        subtitle={`${client?.name ?? ""}. As of ${d ? fmtShortDate(d.asOfDate) : "today"}${d?.lastSnapshotDate ? `, last AR-REFRESH-AGING snapshot ${fmtShortDate(d.lastSnapshotDate)}` : ", no aging snapshot yet"}.`}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Receivable open" value={d ? <Money cents={d.receivableTotals.totalCents} /> : "…"} testId="kpi-ar-open" />
        <Kpi label="Receivable over 90" value={d ? <Money cents={d.receivableTotals.over90Cents} /> : "…"} tone={d && d.receivableTotals.over90Cents > 0 ? "risk" : "neutral"} />
        <Kpi label="Payable open" value={d ? <Money cents={d.payableTotals.totalCents} /> : "…"} />
        <Kpi label="Payable over 90" value={d ? <Money cents={d.payableTotals.over90Cents} /> : "…"} tone={d && d.payableTotals.over90Cents > 0 ? "watch" : "neutral"} />
      </div>
      <Tabs defaultValue="ar">
        <TabsList>
          <TabsTrigger value="ar" data-testid="tab-ar">Receivable</TabsTrigger>
          <TabsTrigger value="ap" data-testid="tab-ap">Payable</TabsTrigger>
        </TabsList>
        <TabsContent value="ar" className="mt-4 space-y-4">
          {d && d.receivableTotals.totalCents > 0 ? (
            <SectionCard title="Receivable by age" description="Open invoice balance in each bucket.">
              <AgingBucketChart totals={d.receivableTotals} />
            </SectionCard>
          ) : null}
          <SectionCard
            title="Accounts receivable"
            description="Open posted invoices by customer."
            actions={clientId ? <ApplyPaymentsButton clientId={clientId} period={period} runCode="AR-APPLY-PAYMENTS" label="Apply customer payments" testId="button-apply-ar-payments" /> : null}
          >
            {grid(d?.receivable ?? [], d?.receivableTotals, "grid-ar", "No posted invoice carries an open balance.")}
          </SectionCard>
        </TabsContent>
        <TabsContent value="ap" className="mt-4 space-y-4">
          {d && d.payableTotals.totalCents > 0 ? (
            <SectionCard title="Payable by age" description="Open bill balance in each bucket.">
              <AgingBucketChart totals={d.payableTotals} />
            </SectionCard>
          ) : null}
          <SectionCard
            title="Accounts payable"
            description="Open posted bills by vendor."
            actions={clientId ? <ApplyPaymentsButton clientId={clientId} period={period} runCode="AP-APPLY-PAYMENTS" label="Apply vendor payments" testId="button-apply-ap-payments" /> : null}
          >
            {grid(d?.payable ?? [], d?.payableTotals, "grid-ap", "No posted bill carries an open balance.")}
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
