import { DataGrid, EmptyState, ErrorState, Kpi, PageHeader, Pill, SectionCard } from "@/components/kit";
import { useActiveClient } from "@/lib/active-client";
import { useRules, errorMessage } from "@/api";
import { usd } from "@/lib/money";
import type { Rule } from "@shared/api";

/**
 * Coding rules, read from GET /api/firm/clients/:id/rules. The order shown is
 * the tie break order the cascade applies: priority descending, condition
 * count descending, id ascending. Rules are written by the rule runs, so this
 * screen has no editor.
 */
export default function Rules() {
  const { client, clientId } = useActiveClient();
  const q = useRules(clientId);
  const d = q.data;
  if (q.isError) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  return (
    <div className="space-y-4" data-testid="page-rules">
      <PageHeader title="Rules" subtitle={`${client?.name ?? ""}. ${d ? `${d.items.length} active rules, ${d.autoPostCount} with auto post on.` : ""}`} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Active rules" value={d ? d.items.length : "…"} testId="kpi-rules" />
        <Kpi label="Auto post enabled" value={d ? d.autoPostCount : "…"} />
        <Kpi label="Accepted codings" value={d ? d.items.reduce((n, r) => n + r.acceptedCount, 0) : "…"} />
      </div>
      <SectionCard title="Rules in cascade order" description="The first rule whose conditions match wins.">
        <DataGrid<Rule>
          rows={d?.items ?? []}
          loading={q.isPending}
          rowKey={(r) => r.id}
          testId="grid-rules"
          empty={<EmptyState title="No rules yet" body="Rules come from the firm library and from accepted codings; none has been written for this client." />}
          cols={[
            { key: "pri", label: "Priority", align: "right", mobile: "row", render: (r) => <span className="tnum">{r.priority}</span> },
            { key: "name", label: "Rule", mobile: "title", render: (r) => <span className="font-medium">{r.name}</span> },
            { key: "cond", label: "Conditions", align: "right", mobile: "row", render: (r) => <span className="tnum">{r.conditionCount}</span> },
            { key: "target", label: "Codes to", mobile: "row", render: (r) => <span>{r.targetCategoryName ?? r.targetCategoryId}</span> },
            { key: "scope", label: "Scope", mobile: "row", render: (r) => <Pill tone={r.scopeKind === "firm_library" ? "info" : "neutral"}>{r.scopeKind === "firm_library" ? "Firm library" : "Client"}</Pill> },
            { key: "acc", label: "Accepted / rejected", align: "right", mobile: "row", render: (r) => <span className="tnum text-xs">{r.acceptedCount} / {r.rejectedCount}</span> },
            {
              key: "auto",
              label: "Auto post",
              mobile: "value",
              render: (r) => (r.autoPostEnabled ? <Pill tone="good">Up to {usd(r.autoPostCeilingCents)}</Pill> : <Pill tone="neutral">Off</Pill>),
            },
          ]}
        />
      </SectionCard>
    </div>
  );
}
