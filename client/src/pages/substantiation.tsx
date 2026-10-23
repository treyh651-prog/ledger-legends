import { DataGrid, EmptyState, ErrorState, Kpi, Money, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useApp } from "@/store";
import { useActiveClient } from "@/lib/active-client";
import { useSubstantiation, errorMessage } from "@/api";
import { fmtPeriod, fmtShortDate, fmtTimestamp } from "@/lib/money";
import type { DocumentationException, SubstantiationRecord, Tieout } from "@shared/api";

/**
 * Substantiation for one period, read from
 * GET /api/firm/clients/:id/substantiation: the support records a person
 * prepared, the tie outs CLS-TIE-SUBLEDGERS computed against them, and the
 * documentation exceptions the coding runs raised.
 */
export default function Substantiation() {
  const { period } = useApp();
  const { client, clientId } = useActiveClient();
  const q = useSubstantiation(clientId, period);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const tieTone = (t: Tieout) => (t.state === "computed_tied" ? "good" : t.state === "variance_open" ? "risk" : "watch");

  return (
    <div className="space-y-4" data-testid="page-substantiation">
      <PageHeader title="Substantiation" subtitle={`${client?.name ?? ""}, ${fmtPeriod(period)}.`} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Support records" value={d ? d.records.length : "…"} testId="kpi-records" />
        <Kpi label="Tie outs" value={d ? `${d.tieouts.filter((t) => t.state === "computed_tied").length} of ${d.tieouts.length} tied` : "…"} />
        <Kpi label="Open documentation exceptions" value={d ? d.openExceptions : "…"} tone={d && d.openExceptions > 0 ? "watch" : "neutral"} />
      </div>
      <SectionCard title="Support records" description="Balances a person substantiated for this period, from close.substantiation_records.">
        <DataGrid<SubstantiationRecord>
          rows={d?.records ?? []}
          loading={q.isPending}
          rowKey={(r) => r.id}
          testId="grid-support"
          empty={<EmptyState title="No support recorded" body="Inventory counts and payroll registers are recorded here when a person prepares them." />}
          cols={[
            { key: "acct", label: "Account", mobile: "title", render: (r) => <span className="font-medium">{r.accountNumber} {r.accountName}</span> },
            { key: "kind", label: "Kind", mobile: "row", render: (r) => <Pill tone="info">{r.kind.replace(/_/g, " ")}</Pill> },
            { key: "bal", label: "Supported balance", align: "right", mobile: "value", render: (r) => <Money cents={r.supportedBalanceCents} /> },
            { key: "src", label: "Source", mobile: "row", render: (r) => <span className="text-xs text-muted-foreground">{r.sourceRef ?? ""}</span> },
            { key: "on", label: "Prepared", mobile: "row", render: (r) => <span className="tnum text-xs">{r.preparedOn ? fmtShortDate(r.preparedOn) : ""}</span> },
          ]}
        />
      </SectionCard>
      <SectionCard title="Tie outs" description="Ledger balance against its support.">
        <DataGrid<Tieout>
          rows={d?.tieouts ?? []}
          loading={q.isPending}
          rowKey={(t) => t.id}
          testId="grid-tieouts"
          empty={<EmptyState title="No tie outs" body="CLS-TIE-SUBLEDGERS writes one row per supported account when it runs." />}
          cols={[
            { key: "acct", label: "Account", mobile: "title", render: (t) => <span className="font-medium">{t.accountNumber} {t.accountName}</span> },
            { key: "src", label: "Source", mobile: "row", render: (t) => <span className="text-xs">{t.sourceKind.replace(/_/g, " ")}</span> },
            { key: "ledger", label: "Ledger", align: "right", mobile: "row", render: (t) => <Money cents={t.ledgerBalanceCents} dim /> },
            { key: "sup", label: "Supported", align: "right", mobile: "row", render: (t) => (t.supportedBalanceCents === null ? <span className="text-xs text-muted-foreground">None</span> : <Money cents={t.supportedBalanceCents} dim />) },
            { key: "var", label: "Variance", align: "right", mobile: "value", render: (t) => (t.varianceCents === null ? <span className="text-xs text-muted-foreground">Unsupported</span> : <Money cents={t.varianceCents} signed />) },
            { key: "state", label: "State", mobile: "row", render: (t) => <Pill tone={tieTone(t)}>{t.state.replace(/_/g, " ")}</Pill> },
          ]}
        />
      </SectionCard>
      <SectionCard title="Documentation exceptions" description="Codings that applied without the receipt or class the category requires.">
        <DataGrid<DocumentationException>
          rows={d?.exceptions ?? []}
          loading={q.isPending}
          rowKey={(e) => e.id}
          testId="grid-exceptions"
          empty={<EmptyState title="No exceptions" body="TXN-APPLY-RULES raises one when a coding lacks required support." />}
          cols={[
            { key: "kind", label: "Kind", mobile: "row", render: (e) => <Pill tone="watch">{e.kind.replace(/_/g, " ")}</Pill> },
            { key: "cat", label: "Category", mobile: "title", render: (e) => <span className="font-medium">{e.categoryName ?? e.categoryId}</span> },
            { key: "detail", label: "Detail", mobile: "row", render: (e) => <span className="text-xs text-muted-foreground">{e.detail}</span> },
            { key: "opened", label: "Opened", mobile: "row", render: (e) => <span className="text-xs">{fmtTimestamp(e.openedAt)}</span> },
            { key: "status", label: "Status", mobile: "value", render: (e) => <Pill tone={e.status === "resolved" ? "good" : "watch"}>{e.status}</Pill> },
          ]}
        />
      </SectionCard>
    </div>
  );
}
