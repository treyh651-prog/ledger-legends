import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useBudget, errorMessage } from "@/api";
import { fmtPeriod, usd } from "@/lib/money";
import type { BudgetLine } from "@shared/api";

/**
 * Budget versus actual, read from GET /api/firm/clients/:id/budget. Budget
 * rows are what the firm entered; variance rows are what RPT-COMPUTE-VARIANCES
 * wrote for the period. Until that run has applied the screen says so rather
 * than compute a variance of its own.
 */
export default function Budget() {
  const { period } = useApp();
  const { client, clientId } = useActiveClient();
  const q = useBudget(clientId, period);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const tone = (l: BudgetLine) => (!l.flagged ? "good" : l.direction === "unfavorable" ? "risk" : "watch");

  return (
    <div className="space-y-4" data-testid="page-budget">
      <PageHeader title="Budget" subtitle={`${client?.name ?? ""}, ${fmtPeriod(period)}.`} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Accounts budgeted" value={d ? d.budgetedAccounts : "…"} testId="kpi-budgeted" />
        <Kpi label="Budget total" value={d ? <Money cents={d.budgetTotalCents} /> : "…"} />
        <Kpi label="Variance lines" value={d ? d.lines.length : "…"} hint={d && d.lines.length === 0 ? "RPT-COMPUTE-VARIANCES has not run for this period" : undefined} />
        <Kpi label="Flagged" value={d ? d.flaggedCount : "…"} tone={d && d.flaggedCount > 0 ? "watch" : "neutral"} />
      </div>
      <SectionCard title="Variances" description="One row per account the variance run compared, with the threshold it applied.">
        <DataGrid<BudgetLine>
          rows={d?.lines ?? []}
          loading={q.isPending}
          rowKey={(l) => l.accountNumber}
          testId="grid-variances"
          empty={
            <EmptyState
              title={d && d.budgetedAccounts === 0 ? "No budget for this period" : "No variances computed"}
              body={d && d.budgetedAccounts === 0 ? "Enter or roll forward a budget, then RPT-COMPUTE-VARIANCES compares it to actuals." : "RPT-COMPUTE-VARIANCES writes a row per account when it runs for this period."}
            />
          }
          cols={[
            { key: "acct", label: "Account", mobile: "title", render: (l) => <span className="font-medium">{l.accountNumber} {l.accountName}</span> },
            { key: "budget", label: "Budget", align: "right", mobile: "row", render: (l) => <Money cents={l.budgetCents} dim /> },
            { key: "actual", label: "Actual", align: "right", mobile: "row", render: (l) => <Money cents={l.actualCents} /> },
            { key: "var", label: "Variance", align: "right", mobile: "value", render: (l) => <Money cents={l.varianceCents} signed /> },
            { key: "bp", label: "Percent", align: "right", mobile: "row", render: (l) => <span className="tnum text-xs">{l.varianceBp === null ? "" : `${(l.varianceBp / 100).toFixed(1)}%`}</span> },
            { key: "flag", label: "Flag", mobile: "row", render: (l) => <Pill tone={tone(l)}>{l.flagCode.replace(/_/g, " ")}</Pill> },
          ]}
        />
      </SectionCard>
      <SectionCard title="Thresholds" description="Floors and percentages the variance run applies. A null account is the client default.">
        <DataGrid
          rows={d?.thresholds ?? []}
          loading={q.isPending}
          rowKey={(t, i) => `${t.accountNumber ?? "default"}:${i}`}
          testId="grid-thresholds"
          empty={<EmptyState title="No thresholds" body="The variance run uses its stated defaults until the firm enters thresholds." />}
          cols={[
            { key: "acct", label: "Account", mobile: "title", render: (t) => <span>{t.accountNumber ?? "Client default"}</span> },
            { key: "floor", label: "Floor", align: "right", mobile: "row", render: (t) => <span className="tnum">{usd(t.varianceFloorCents)}</span> },
            { key: "bp", label: "Percent", align: "right", mobile: "value", render: (t) => <span className="tnum">{(t.varianceThresholdBp / 100).toFixed(1)}%</span> },
            { key: "note", label: "Note", mobile: "row", render: (t) => <span className="text-xs text-muted-foreground">{t.note}</span> },
          ]}
        />
      </SectionCard>
    </div>
  );
}
